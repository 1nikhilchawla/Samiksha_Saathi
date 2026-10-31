/**
 * Samiksha Saathi Telegram bot (pilot channel; WhatsApp needs Meta templates).
 *
 * - Webhook (Vercel): POST /api/telegram/webhook -> handleUpdate.
 * - Long polling (dev / a pilot box): startLongPolling(), started by the Vite
 *   dev plugin when TELEGRAM_BOT_TOKEN is set and TELEGRAM_MODE != "webhook".
 * - BEO commands are honoured only from TELEGRAM_BEO_CHAT_ID; nothing is ever
 *   broadcast. Field staff are known only after the BEO runs /link.
 * - Every proactive message (task card, reminder, DEO escalation, weekly
 *   digest, appreciation) is fact-checked and goes through the queue
 *   (queue.ts). Replies to a command are sent straight back to that chat.
 * - Cards + reminders are also capped at 30 per block per IST day.
 * Lives in server/ (not scanned by Nitro for routes); imported by src/routes.
 */
import { getSql } from "@/lib/db";
import {
  ACTION_LIBRARY,
  KARMA,
  WHY_TRIGGER,
  assertOfficerPermission,
  officerOf,
  buildWeeklyHingeDigest,
  computeHingePoints,
  computeWorkerRewards,
  diagnoseFailure,
  dispatchBlockReason,
  coachingHolds,
  formatAppreciationCard,
  formatCoachingCard,
  formatNudge,
  formatTaskCard,
  formatWhyReply,
  type OfficerRole,
  type ActingOfficer,
} from "@/lib/samiksha/engine";
import { sttProvider, transcribeAudio } from "@/lib/samiksha/stt.server";
import { copy, type ActionResult, type Copy, type Lang } from "@/lib/samiksha/types";
import { applyFieldReply, approveTask, ensureCycle, extractDrafts } from "@/server/samiksha/actions.server";
import { explainFailureWithModel, latestFailure, logFailure } from "@/server/samiksha/diagnostics.server";
import {
  clockToday,
  cycleById,
  defaultBlockId,
  insertLlmCall,
  insertMessage,
  istToday,
  latestCycle,
  loadTasks,
  stableUuid,
  toTask,
} from "@/server/samiksha/repo.server";
import { runCycle } from "@/server/samiksha/runPipeline.server";
import { drainQueue, enqueueOutbound, factContext } from "./queue";
import { apiBase, botLive, botToken, tg } from "./tgApi";
/** Who is acting: a signed session, or a bare role in the legacy test path. */
type Who = OfficerRole | ActingOfficer;


export { botLive, tg };

export const DAILY_NUDGE_LIMIT = 30;

const say = (chatId: string, text: string) => tg("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
const beoChat = () => process.env.TELEGRAM_BEO_CHAT_ID?.trim() || null;

/** Cards + nudges still allowed today (IST) for the block. */
export async function nudgesLeftToday(blockId: string): Promise<number> {
  const sql = await getSql();
  const [r] = await sql<{ n: number }>`
    select count(*)::int as n from messages
    where block_id = ${blockId} and direction = 'out' and kind in ('card', 'nudge') and channel = 'telegram'
      and created_at >= ${`${istToday()}T00:00:00+05:30`}::timestamptz`;
  return DAILY_NUDGE_LIMIT - Number(r?.n ?? 0);
}

async function chatFor(blockId: string, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const sql = await getSql();
  const [r] = await sql`select telegram_chat_id from contacts where block_id = ${blockId} and person_id = ${personId}`;
  return (r?.telegram_chat_id as string | undefined) ?? null;
}

const countDelivered = async (ids: number[]) => {
  if (!ids.length) return 0;
  const sql = await getSql();
  const [r] = await sql<{ n: number }>`select count(*)::int as n from message_queue where id = any(${ids}::bigint[]) and status = 'delivered'`;
  return Number(r?.n ?? 0);
};

/**
 * Guardrail (c): read only outbound_queue, re-check each row, fact-check and
 * queue its card, then deliver through the queue. A card that cannot go is
 * held, and the reason is logged for /why.
 */
export async function dispatchApproved(blockId: string, cycleId: number, lang: Lang, requestId: string, role: Who): Promise<ActionResult & { sent: number }> {
  assertOfficerPermission(role, "dispatch_tasks");
  const sql = await getSql();
  const c = await cycleById(blockId, cycleId, sql);
  const queue = (await sql`select * from outbound_queue where block_id = ${blockId} and cycle_id = ${cycleId} order by task_no`).map(toTask);
  const live = botLive();
  let left = live ? await nudgesLeftToday(blockId) : Number.POSITIVE_INFINITY;
  const ctx = await factContext(blockId, cycleId, sql);
  const held: Copy[] = [];
  const hold = async (t: { id: number; dbId: number; ownerId: string | null }, en: string, hi: string) => {
    held.push({ en: `#${t.id}: ${en}`, hi: `#${t.id}: ${hi}` });
    await logFailure(sql, blockId, cycleId, diagnoseFailure("task_dispatch", "DISPATCH_BLOCKED", { taskNo: t.id, reason: en, reasonHi: hi }, { personId: t.ownerId }), stableUuid(requestId, "held", t.dbId));
  };
  const queued: number[] = [];
  for (const t of queue) {
    const reason = dispatchBlockReason(t, "en");
    if (reason) {
      await hold(t, reason, dispatchBlockReason(t, "hi") ?? reason);
      continue;
    }
    const chatId = live ? await chatFor(blockId, t.ownerId) : null;
    if (live && !chatId) {
      await hold(t, `${t.ownerId} has no linked Telegram chat (/link)`, `${t.ownerId} का टेलीग्राम जुड़ा नहीं (/link)`);
      continue;
    }
    if (left <= 0) {
      await hold(t, `daily limit of ${DAILY_NUDGE_LIMIT} messages reached`, `आज की ${DAILY_NUDGE_LIMIT} संदेश सीमा पूरी`);
      continue;
    }
    const q = await enqueueOutbound(sql, {
      blockId, cycleId, requestId: stableUuid(requestId, "card", t.dbId), kind: "task_card", taskDbId: t.dbId, taskNo: t.id,
      personId: t.ownerId, chatId, text: formatTaskCard(t, c.people.find((p) => p.id === t.ownerId), lang),
    }, ctx);
    if (q.status === "blocked_fact_check") {
      held.push({ en: `#${t.id}: fact-check: ${q.factCheck.problems.map((p) => p.en).join("; ")}`, hi: `#${t.id}: तथ्य-जाँच: ${q.factCheck.problems.map((p) => p.hi).join("; ")}` });
      continue;
    }
    if (q.id !== null) queued.push(q.id);
    left -= 1;
  }
  if (queued.length) await drainQueue({ blockId, budgetMs: 10_000 });
  const sent = await countDelivered(queued);
  const waiting = queued.length - sent;
  const heldEn = held.length ? ` Held: ${held.map((h) => h.en).join(" · ")}` : "";
  const heldHi = held.length ? ` रोके गए: ${held.map((h) => h.hi).join(" · ")}` : "";
  const waitEn = waiting ? ` ${waiting} still in the queue (retrying within Telegram's limits).` : "";
  const waitHi = waiting ? ` ${waiting} अभी कतार में (टेलीग्राम सीमा में फिर कोशिश)।` : "";
  return {
    ok: sent > 0,
    sent,
    gate: queued.length
      ? live
        ? copy(`Dispatched via Telegram Bot & Recorded in Action Register: ${sent} fact-checked task card${sent === 1 ? "" : "s"}. Drafts were not read.${waitEn}${heldEn}`, `टेलीग्राम बॉट से भेजा गया व कार्य रजिस्टर में दर्ज: ${sent} तथ्य-जाँचे कार्य कार्ड। ड्राफ्ट नहीं पढ़े गए।${waitHi}${heldHi}`)
        : copy(`Recorded in Block Action Register · Ready for In-App Field Reply: ${sent} fact-checked task card${sent === 1 ? "" : "s"}. Drafts were not read.${waitEn}${heldEn}`, `ब्लॉक कार्य रजिस्टर में दर्ज · इन-ऐप फ़ील्ड उत्तर के लिए तैयार: ${sent} तथ्य-जाँचे कार्य कार्ड। ड्राफ्ट नहीं पढ़े गए।${waitHi}${heldHi}`)
      : copy(held[0]?.en ?? "Nothing approved is waiting.", held[0]?.hi ?? "अनुमोदन के लिए कुछ प्रतीक्षा में नहीं है।"),
  };
}

/** Tell the DEO on Telegram that a task was escalated: needs the bot and a linked DEO chat; queued once per request. */
export async function notifyEscalation(blockId: string, cycleId: number, taskNo: number, requestId: string): Promise<{ sent: boolean; reason: Copy }> {
  const no = (en: string, hi: string) => ({ sent: false, reason: copy(en, hi) });
  if (!botLive()) return no("Telegram delivery is off for this block", "इस विकासखंड के लिए टेलीग्राम भेजना बंद है");
  const sql = await getSql();
  const c = await cycleById(blockId, cycleId, sql);
  const deo = c.people.find((p) => p.role === "DEO");
  const chatId = await chatFor(blockId, deo?.id ?? null);
  if (!deo || !chatId) return no("the DEO chat is not linked (/link deo <chat id>)", "DEO की चैट जुड़ी नहीं है (/link deo <chat id>)");
  const task = (await loadTasks(cycleId, sql)).find((x) => x.id === taskNo);
  if (!task) return no(`Task #${taskNo} is not in this cycle`, `कार्य #${taskNo} इस चक्र में नहीं है`);
  const action = ACTION_LIBRARY[task.actionId];
  const owner = c.people.find((p) => p.id === task.ownerId);
  const en = `Escalated to you · Task #${task.id}: ${action.name_en}, ${task.targetLabel}. Owner ${owner?.nameEn ?? "—"}, due ${task.dueDate ?? "—"}. A block officer cannot close this alone.`;
  const hi = `आपको अग्रेषित · कार्य #${task.id}: ${action.name_hi}, ${task.targetLabelHi || task.targetLabel}। जिम्मेदार ${owner?.nameHi ?? "—"}, अंतिम तिथि ${task.dueDate ?? "—"}। ब्लॉक अधिकारी इसे अकेले बंद नहीं कर सकते।`;
  const q = await enqueueOutbound(sql, {
    blockId, cycleId, requestId: stableUuid(requestId, "escalation", task.dbId), kind: "deo_escalation", taskDbId: task.dbId, taskNo: task.id,
    personId: deo.id, chatId, text: `${hi}\n\n${en}`, textCopy: { en: `DEO told on Telegram. ${en}`, hi: `DEO को टेलीग्राम पर सूचना। ${hi}` },
  }, await factContext(blockId, cycleId, sql));
  if (q.duplicate) return no("the DEO was already told for this escalation", "इस अग्रेषण की सूचना DEO को पहले जा चुकी है");
  if (q.status === "blocked_fact_check") return no(`the fact-check stopped it (${q.factCheck.problems.map((p) => p.en).join("; ")})`, `तथ्य-जाँच ने रोका (${q.factCheck.problems.map((p) => p.hi).join("; ")})`);
  await drainQueue({ blockId, budgetMs: 8000 });
  const [row] = await sql`select status, last_error from message_queue where id = ${q.id}`;
  if (row?.status !== "delivered") return no(`Telegram has not taken it yet (${(row?.last_error as string | null) ?? "queued"})`, `टेलीग्राम ने अभी नहीं लिया (${(row?.last_error as string | null) ?? "कतार में"})`);
  return { sent: true, reason: copy("", "") };
}

/** 09:00 IST: remind owners of tasks due today (by each cycle's clock). Once per task per day, through the queue. */
export async function sendDueNudges(): Promise<{ block: string; sent: number; held: number }[]> {
  if (!botLive()) return [];
  const sql = await getSql();
  const blocks = await sql<{ block_id: string }>`select distinct block_id from cycles`;
  const out: { block: string; sent: number; held: number }[] = [];
  for (const { block_id: blockId } of blocks) {
    const c = await latestCycle(blockId, sql);
    if (!c) continue;
    const today = clockToday(c);
    const due = (await loadTasks(c.id, sql)).filter((t) => t.dueDate === today && ["sent", "reminded", "partial"].includes(t.status));
    let left = await nudgesLeftToday(blockId);
    let held = 0;
    const queued: number[] = [];
    const ctx = await factContext(blockId, c.id, sql);
    for (const t of due) {
      const chatId = await chatFor(blockId, t.ownerId);
      if (!chatId || left <= 0) {
        held += 1;
        continue;
      }
      const q = await enqueueOutbound(sql, {
        blockId, cycleId: c.id, requestId: stableUuid("nudge", blockId, istToday(), t.dbId), kind: "nudge", taskDbId: t.dbId, taskNo: t.id,
        personId: t.ownerId, chatId, text: `${formatNudge(t, "hi")}\n\n${formatNudge(t, "en")}`,
      }, ctx);
      if (q.status === "blocked_fact_check") held += 1;
      if (q.duplicate || q.status !== "queued" || q.id === null) continue;
      queued.push(q.id);
      left -= 1;
    }
    if (queued.length) await drainQueue({ blockId, budgetMs: 15_000 });
    out.push({ block: blockId, sent: await countDelivered(queued), held });
  }
  return out;
}

/**
 * Monday 09:00 IST (and the studio button): the block digest to the BEO, and
 * each linked owner's own pending list, all through the fact-checked queue.
 */
export async function sendWeeklyDigest(blockId: string, role: Who, requestId: string): Promise<ActionResult & { queued: number; delivered: number }> {
  assertOfficerPermission(role, "send_weekly_digest");
  const sql = await getSql();
  const c = await latestCycle(blockId, sql);
  if (!c) return { ok: false, gate: copy("There is no cycle yet.", "अभी कोई चक्र नहीं है।"), queued: 0, delivered: 0 };
  const ctx = await factContext(blockId, c.id, sql);
  const points = computeHingePoints(ctx.cycle, ctx.tasks, ctx.score ?? null, ctx.simToday);
  const both = (personId?: string) =>
    `${buildWeeklyHingeDigest(ctx.cycle, ctx.tasks, points, ctx.simToday, "hi", personId ? { personId } : {})}\n\n${buildWeeklyHingeDigest(ctx.cycle, ctx.tasks, points, ctx.simToday, "en", personId ? { personId } : {})}`;
  const ids: number[] = [];
  let blocked = 0;
  const add = async (personId: string | null, chatId: string | null, text: string) => {
    const q = await enqueueOutbound(sql, { blockId, cycleId: c.id, requestId: stableUuid(requestId, "digest", personId ?? "beo"), kind: "weekly_digest", personId, chatId, text }, ctx);
    if (q.status === "blocked_fact_check") blocked += 1;
    else if (q.id !== null && !q.duplicate) ids.push(q.id);
  };
  await add("beo", botLive() ? beoChat() : null, both());
  const contacts = await sql`select person_id, telegram_chat_id from contacts where block_id = ${blockId}`;
  for (const k of contacts) {
    const pid = k.person_id as string;
    if (!ctx.tasks.some((t) => t.ownerId === pid && ["approved", "sent", "reminded", "partial", "overdue", "blocked"].includes(t.status))) continue;
    await add(pid, botLive() ? (k.telegram_chat_id as string) : null, both(pid));
  }
  if (ids.length) await drainQueue({ blockId, budgetMs: 15_000 });
  const delivered = await countDelivered(ids);
  return {
    ok: ids.length > 0,
    queued: ids.length,
    delivered,
    gate: copy(
      `Weekly digest: ${ids.length} queued, ${delivered} delivered${blocked ? `, ${blocked} stopped by the fact-check` : ""}.`,
      `साप्ताहिक सारांश: ${ids.length} कतार में, ${delivered} पहुँचे${blocked ? `, ${blocked} तथ्य-जाँच ने रोके` : ""}।`,
    ),
  };
}

/** A fact-checked appreciation card to one field worker, recorded in the rewards ledger. */
export async function sendAppreciation(blockId: string, cycleId: number, personId: string, role: Who, requestId: string): Promise<ActionResult> {
  assertOfficerPermission(role, "award_appreciation");
  const sql = await getSql();
  const ctx = await factContext(blockId, cycleId, sql);
  const w = computeWorkerRewards(ctx.cycle, ctx.tasks, ctx.score ?? null).find((x) => x.person.id === personId);
  // No points but a "done" that Round 4 did not bear out: the coaching note goes instead.
  const coaching = Boolean(w && w.points <= 0 && coachingHolds(w).length);
  if (!w || (w.points <= 0 && !coaching)) return { ok: false, gate: copy("Nothing verified to appreciate yet for this person.", "इस व्यक्ति के लिए अभी सत्यापित प्रशंसा योग्य कुछ नहीं।") };
  const sender = ctx.cycle.people.find((p) => p.role === officerOf(role).role) ?? ctx.cycle.people.find((p) => p.role === "BEO");
  const senderRole = officerOf(role).role;
  const card = coaching ? formatCoachingCard : formatAppreciationCard;
  const text = `${card(w, { role: senderRole, name: sender?.nameHi ?? senderRole }, "hi")}\n\n${card(w, { role: senderRole, name: sender?.nameEn ?? senderRole }, "en")}`;
  const chatId = botLive() ? await chatFor(blockId, personId) : null;
  if (botLive() && !chatId) return { ok: false, gate: copy(`${w.person.nameEn} has no linked Telegram chat (/link).`, `${w.person.nameHi} का टेलीग्राम जुड़ा नहीं (/link)।`) };
  const extra = [...Object.values(KARMA), w.points, ...w.entries.map((e) => e.points)];
  const q = await enqueueOutbound(sql, { blockId, cycleId, requestId: stableUuid(requestId, "appreciation", personId), kind: "appreciation", personId, chatId, text, extraAllowed: extra }, ctx);
  if (q.status === "blocked_fact_check") return { ok: false, gate: copy(`Stopped by the fact-check: ${q.factCheck.problems.map((p) => p.en).join("; ")}`, `तथ्य-जाँच ने रोका: ${q.factCheck.problems.map((p) => p.hi).join("; ")}`) };
  await sql`
    insert into worker_rewards_ledger (block_id, client_request_id, cycle_id, person_id, points, badges, reasons, awarded_by_role, queue_id)
    values (${blockId}, ${stableUuid(requestId, "reward", personId)}, ${cycleId}, ${personId}, ${coaching ? 0 : w.points}, ${JSON.stringify(coaching ? [] : w.badges)}::jsonb,
            ${JSON.stringify(coaching ? coachingHolds(w).map((h) => h.reason) : w.entries.map((e) => e.reason))}::jsonb, ${senderRole}, ${q.id})
    on conflict (block_id, client_request_id) do nothing`;
  await drainQueue({ blockId, budgetMs: 8000 });
  const [row] = await sql`select status from message_queue where id = ${q.id}`;
  if (coaching) {
    return {
      ok: true,
      gate: row?.status === "delivered"
        ? copy(`Coaching note sent to ${w.person.nameEn}; the reward stays held until the outcome is verified.`, `${w.person.nameHi} को मार्गदर्शन नोट भेजा; परिणाम सत्यापित होने तक पुरस्कार रुका रहेगा।`)
        : copy(`Coaching note for ${w.person.nameEn} is in the queue.`, `${w.person.nameHi} का मार्गदर्शन नोट कतार में है।`),
    };
  }
  return {
    ok: true,
    gate: row?.status === "delivered"
      ? copy(`Appreciation sent to ${w.person.nameEn} (${w.points} points).`, `${w.person.nameHi} को प्रशंसा पत्र भेजा (${w.points} अंक)।`)
      : copy(`Appreciation for ${w.person.nameEn} is in the queue.`, `${w.person.nameHi} का प्रशंसा पत्र कतार में है।`),
  };
}

type TgVoice = { file_id: string; duration?: number; mime_type?: string };
type TgMessage = {
  message_id: number;
  chat: { id: number | string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  voice?: TgVoice;
  audio?: TgVoice;
};
export type TgUpdate = { update_id: number; message?: TgMessage; edited_message?: TgMessage };

const BEO_HELP = [
  "Samiksha Saathi · BEO commands",
  "/seed — build this month's cycle from the pilot files (nothing is sent)",
  "Plain text or a voice note — your review note; it becomes draft tasks",
  "/tasks — list tasks · /approve 14 — approve a draft · /send — send approved cards",
  "/weekly — this week's digest · /why — why the last thing failed",
  "/link crcc-4 <chat id> — link a CRCC, HM or the DEO to their Telegram chat",
  "A shared phone can hold several people: /whoami lists them, /switch <person id> chooses one, /task 14 done records work on one task",
].join("\n");

const VOICE_UNREAD = [
  "Voice note received, but voice transcription is not available right now. Please type it: done, partly done, or what is blocking the work.",
  "वॉइस नोट मिला, पर अभी आवाज़ से लिखने की सेवा उपलब्ध नहीं है। कृपया लिखकर भेजें: हो गया, आधा, या रुकावट का कारण।",
].join("\n");

/** A voice note's words via speech-to-text (logged in the cost ledger), or null when STT is off or hears nothing. */
async function hearVoice(blockId: string, requestId: string, voice: TgVoice): Promise<string | null> {
  if (sttProvider() === "offline") return null;
  const file = await tg<{ file_path?: string }>("getFile", { file_id: voice.file_id });
  if (!file.file_path) return null;
  const res = await fetch(`${apiBase()}/file/bot${botToken()}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const heard = await transcribeAudio({
    audioBase64: Buffer.from(await res.arrayBuffer()).toString("base64"),
    mimeType: voice.mime_type ?? "audio/ogg",
    lang: "hi",
    durationSeconds: voice.duration,
  });
  const sql = await getSql();
  await insertLlmCall(sql, {
    blockId, requestId: stableUuid(requestId, "stt"), cycleId: (await latestCycle(blockId, sql))?.id ?? null, purpose: "speech_to_text",
    model: heard.provider, tokensIn: 0, tokensOut: 0, inr: heard.costInr, passed: Boolean(heard.transcript), simulated: false,
    billable: heard.costInr > 0, note: `${heard.durationSeconds} s voice note`,
  });
  return heard.transcript || null;
}

/** Field replies -> parse -> messages row -> task status -> ack. */
export async function replyRouter(blockId: string, personId: string, chatId: string, text: string, photo: boolean, requestId: string) {
  const out = await applyFieldReply({ blockId, personId, chatId, text, photo, requestId });
  if (out.ack) await say(chatId, out.ack);
  return out;
}

async function logCommand(blockId: string, requestId: string, chatId: string, text: string, personId = "beo") {
  const sql = await getSql();
  // The command gets its own id. The same request id is used by the reply that
  // follows a command, and a duplicate id would make that reply look like a
  // redelivery of something already seen — so it would never be recorded.
  await insertMessage(sql, { blockId, requestId: stableUuid(requestId, "cmd"), cycleId: null, direction: "in", kind: "command", channel: "telegram", personId, chatId, text });
}

type Inbound = { chatId: string; text: string; requestId: string; blockId: string; isBeo: boolean; lang: Lang; personId: string | null };

async function linkChat(m: Inbound, cycleId: number, args: string[]) {
  const [personId, target] = args;
  const c = await cycleById(m.blockId, cycleId);
  const person = c.people.find((p) => p.id === personId && p.role !== "BEO");
  if (!person || !target || !/^-?\d{3,20}$/.test(target)) {
    await say(m.chatId, `Usage: /link <person id> <chat id>. People: ${c.people.filter((p) => p.role !== "BEO").map((p) => p.id).join(", ")}`);
    return;
  }
  const sql = await getSql();
  // A shared phone holds more than one person: the chat id is unique per block,
  // not across the whole table, so the second officer on a shared number links
  // too. The first link on a chat is the active one until somebody /switch.
  await sql`
    insert into contacts (block_id, client_request_id, person_id, telegram_chat_id, is_primary)
    values (${m.blockId}, ${m.requestId}, ${person.id}, ${target},
      not exists (select 1 from contacts where block_id = ${m.blockId} and telegram_chat_id = ${target} and is_primary))
    on conflict (block_id, person_id) do update set telegram_chat_id = excluded.telegram_chat_id`;
  const linked = await contactsFor(target);
  await say(
    m.chatId,
    `Linked ${person.nameEn} (${person.role}, ${person.scope}) to chat ${target}. This chat now holds ${linked.length} ${linked.length === 1 ? "person" : "people"}; use /whoami to see them and /switch <person id> to choose one.`,
  );
}

/** /whoami: who this chat is linked to, and what each of them still has open. */
async function answerWhoAmI(m: Inbound) {
  const linked = await contactsFor(m.chatId);
  if (!linked.length) {
    await say(m.chatId, `This chat is not linked yet. Ask your BEO to link chat id ${m.chatId}.\nयह चैट अभी जुड़ी नहीं है। BEO से चैट आईडी ${m.chatId} जुड़वाएँ।`);
    return;
  }
  const c = await cycleById(m.blockId, await ensureCycle(m.blockId));
  const open = (await loadTasks(c.id)).filter((t) => t.status !== "done" && t.status !== "rejected");
  const lines: string[] = [];
  for (const l of linked) {
    const person = c.people.find((p) => p.id === l.personId);
    const mine = open.filter((t) => t.ownerId === l.personId);
    lines.push(`${l.isPrimary ? "▶ " : "  "}${l.personId} · ${person?.nameEn ?? ""}${person ? ` · ${person.role}` : ""}${l.isPrimary ? " · active" : ""}`);
    // The open tasks of this person, so the officer can answer "14 done" without hunting for the number.
    lines.push(
      mine.length
        ? mine.map((t) => `    #${t.id} ${t.status} · ${t.dueDate ?? "—"} · ${t.targetLabel}`).join("\n")
        : `    (${t_none(m.lang)})`,
    );
  }
  await say(
    m.chatId,
    `Linked to this chat:\n${lines.join("\n")}\nUse /switch <person id> to change who you are, and /task <no> <status> to record work.\n` +
      `इस चैट से जुड़े अधिकारी:\n${lines.join("\n")}\n/स्विच <व्यक्ति आईडी> से बदलें, और कार्य दर्ज करने के लिए /task <नंबर> <स्थिति> भेजें।`,
  );
}

const t_none = (lang: "en" | "hi") => (lang === "en" ? "no open tasks" : "कोई खुला कार्य नहीं");

/** /switch <person id>: choose which person this shared chat is acting as. */
async function switchPerson(m: Inbound, personId: string) {
  const linked = await contactsFor(m.chatId);
  if (!linked.length) {
    await say(m.chatId, `This chat is not linked yet. Ask your BEO to link chat id ${m.chatId}.`);
    return;
  }
  if (!linked.some((l) => l.personId === personId)) {
    await say(m.chatId, `${personId} is not linked to this chat. Linked: ${linked.map((l) => l.personId).join(", ")}`);
    return;
  }
  const sql = await getSql();
  await sql`update contacts set is_primary = (person_id = ${personId}) where block_id = ${m.blockId} and telegram_chat_id = ${m.chatId}`;
  await say(m.chatId, `This chat now acts as ${personId}.`);
}

/** /why: the latest failure for the block (BEO) or for this person, worded plainly when a model is allowed to. */
async function answerWhy(m: Inbound) {
  const entry = await latestFailure(m.blockId, m.isBeo ? null : m.personId);
  if (!entry) {
    await say(m.chatId, formatWhyReply(null, m.lang));
    return;
  }
  const c = await latestCycle(m.blockId);
  const { entry: worded } = await explainFailureWithModel(m.blockId, c?.id ?? null, entry, m.requestId);
  await say(m.chatId, `${formatWhyReply(worded, "hi")}\n\n${formatWhyReply(worded, "en")}`);
}

/** /pending and /weekly: the block digest for the BEO, the person's own list for field staff. */
async function answerPending(m: Inbound) {
  const c = await latestCycle(m.blockId);
  if (!c) {
    await say(m.chatId, m.lang === "hi" ? "अभी कोई चक्र नहीं है।" : "There is no cycle yet.");
    return;
  }
  const ctx = await factContext(m.blockId, c.id);
  const points = computeHingePoints(ctx.cycle, ctx.tasks, ctx.score ?? null, ctx.simToday);
  await say(m.chatId, buildWeeklyHingeDigest(ctx.cycle, ctx.tasks, points, ctx.simToday, m.lang, m.isBeo || !m.personId ? {} : { personId: m.personId }));
}

async function handleCommand(m: Inbound) {
  const [head = "", ...args] = m.text.split(/\s+/);
  const cmd = head.replace(/@.*$/, "").toLowerCase();
  if (cmd === "/start") {
    // The officer reads this line to fill TELEGRAM_BEO_CHAT_ID or run /link.
    if (!m.isBeo) console.log(`[bot] /start from chat ${m.chatId}`);
    await say(m.chatId, m.isBeo ? BEO_HELP : `Namaste. Your chat id is ${m.chatId}. Ask your BEO to link it; task cards will then arrive here.\nनमस्ते। आपकी चैट आईडी ${m.chatId} है। BEO से जुड़वाएँ, फिर कार्य कार्ड यहीं आएँगे।`);
    return;
  }
  // Linked field staff may ask for their own list and the reason something failed.
  if (!m.isBeo && m.personId && (cmd === "/pending" || cmd === "/weekly" || WHY_TRIGGER.test(cmd))) {
    await logCommand(m.blockId, m.requestId, m.chatId, m.text, m.personId);
    return WHY_TRIGGER.test(cmd) ? answerWhy(m) : answerPending(m);
  }
  // A shared phone: who am I, and act as somebody else.
  if (!m.isBeo && (cmd === "/whoami" || cmd === "/switch")) {
    await logCommand(m.blockId, m.requestId, m.chatId, m.text, m.personId ?? "unknown");
    if (cmd === "/whoami") return answerWhoAmI(m);
    return switchPerson(m, args[0] ?? "");
  }
  // A shared phone: address one task of the active person.
  if (!m.isBeo && cmd === "/task" && m.personId && args[0]) {
    await logCommand(m.blockId, m.requestId, m.chatId, m.text, m.personId);
    await replyRouter(m.blockId, m.personId, m.chatId, `${args[0]} ${args.slice(1).join(" ")}`.trim(), false, m.requestId);
    return;
  }
  if (!m.isBeo) {
    await say(m.chatId, "Only the block officer can use this command. / यह आदेश केवल विकासखंड अधिकारी के लिए है।");
    return;
  }
  await logCommand(m.blockId, m.requestId, m.chatId, m.text);
  if (cmd === "/seed") {
    const r = await runCycle({ blockId: m.blockId, clientRequestId: m.requestId });
    await say(m.chatId, `Cycle #${r.cycleId} ready: ${r.summary.schools} schools, ${r.summary.flags} flags, ${r.summary.data_problems} data problems. Prep ${r.prepSeconds.toFixed(2)} s. Nothing was sent.`);
    return;
  }
  if (WHY_TRIGGER.test(cmd)) return answerWhy(m);
  if (cmd === "/weekly" || cmd === "/pending") return answerPending(m);
  const cycleId = await ensureCycle(m.blockId);
  if (cmd === "/tasks") {
    const tasks = await loadTasks(cycleId);
    await say(m.chatId, tasks.length ? tasks.map((x) => `#${x.id} ${x.status} · ${x.ownerId ?? "—"} · ${x.dueDate ?? "—"} · ${x.targetLabel}`).join("\n") : "No tasks yet. Send your review note.");
  } else if (cmd === "/approve") {
    const r = await approveTask(m.blockId, cycleId, Number(args[0]), "BEO");
    await say(m.chatId, r.gate?.[m.lang] ?? "Done.");
  } else if (cmd === "/send") {
    const r = await dispatchApproved(m.blockId, cycleId, m.lang, m.requestId, "BEO");
    await say(m.chatId, r.gate?.[m.lang] ?? "Done.");
  } else if (cmd === "/link") {
    await linkChat(m, cycleId, args);
  } else {
    await say(m.chatId, BEO_HELP);
  }
}

async function handleBeoNote(m: Inbound) {
  if (!m.text) return;
  const cycleId = await ensureCycle(m.blockId);
  const r = await extractDrafts(m.blockId, cycleId, m.text, m.requestId, "BEO");
  const drafts = (await loadTasks(cycleId)).filter((x) => x.status === "draft");
  await say(m.chatId, [
    r.count ? `${r.count} draft task${r.count === 1 ? "" : "s"} from your note:` : "No task found in that note.",
    ...drafts.map((x) => `#${x.id} · ${x.targetLabel} · ${x.ownerId ?? "no owner"} · ${x.dueDate ?? "no date"}${x.missingFields.length ? ` · missing: ${x.missingFields.join(", ")}` : ""}`),
    drafts.length ? "Approve with /approve <no>, then /send." : "",
  ].filter(Boolean).join("\n"));
}

async function contactFor(chatId: string) {
  const sql = await getSql();
  const [row] = await sql`select block_id, person_id from contacts where telegram_chat_id = ${chatId} and is_primary`;
  return row ? { blockId: row.block_id as string, personId: row.person_id as string } : null;
}

/**
 * Every person linked to this chat.
 *
 * A shared phone means one chat, several people. The primary link is the one
 * this chat is acting as; /switch moves it.
 */
async function contactsFor(chatId: string): Promise<{ blockId: string; personId: string; isPrimary: boolean }[]> {
  const sql = await getSql();
  const rows = await sql`select block_id, person_id, is_primary from contacts where telegram_chat_id = ${chatId} order by is_primary desc, id`;
  return rows.map((r) => ({ blockId: r.block_id as string, personId: r.person_id as string, isPrimary: Boolean(r.is_primary) }));
}

/** The person this chat acts as: the primary link. */
function activeContact(list: { blockId: string; personId: string; isPrimary: boolean }[]) {
  return list.find((c) => c.isPrimary) ?? list[0] ?? null;
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const requestId = stableUuid("tg", update.update_id, chatId, msg.message_id);
  const blockId = defaultBlockId();
  // An update Telegram redelivers is handled once. The log table is new, so a
  // database without it must not stop the bot.
  try {
    const sql = await getSql();
    const seen = await sql`
      insert into inbound_webhook_dedup (update_id, block_id, chat_id, outcome)
      values (${update.update_id}, ${blockId}, ${chatId}, 'received')
      on conflict (update_id) do nothing
      returning id`;
    if (!seen.length) return;
  } catch {
    /* the dedup table is not there yet; the bot still works */
  }
  const isBeo = Boolean(beoChat()) && chatId === beoChat();
  const contacts = isBeo ? [] : await contactsFor(chatId);
  const contact = activeContact(contacts);
  let text = (msg.text ?? msg.caption ?? "").trim();
  const voice = msg.voice ?? msg.audio;
  // Only the BEO and linked staff get speech-to-text, so a stranger's audio never costs anything.
  if (!text && voice && (isBeo || contact)) {
    const heard = await hearVoice(blockId, requestId, voice);
    if (!heard) {
      await say(chatId, VOICE_UNREAD);
      return;
    }
    text = heard;
  }
  const photo = Boolean(msg.photo?.length || msg.document);
  const inbound: Inbound = { chatId, text, requestId, blockId: contact?.blockId ?? blockId, isBeo, lang: /[ऀ-ॿ]/.test(text) ? "hi" : "en", personId: contact?.personId ?? null };
  if (text.startsWith("/")) return handleCommand(inbound);
  // "why", "kyu", "क्यों फेल हुआ" on their own ask for the last failure.
  if ((isBeo || contact) && WHY_TRIGGER.test(text)) return answerWhy(inbound);
  if (isBeo) return handleBeoNote(inbound);
  if (!contact) {
    await say(chatId, `This chat is not linked yet. Ask your BEO to link chat id ${chatId}.\nयह चैट अभी जुड़ी नहीं है। BEO से चैट आईडी ${chatId} जुड़वाएँ।`);
    return;
  }
  // A shared phone with more than one officer on it: a bare "done" could be
  // about any of their tasks. The bot asks which task, instead of guessing and
  // recording the work against the wrong person.
  if (contacts.length > 1 && !photo && !/^\s*\d+\b/.test(text)) {
    const c = await cycleById(contact.blockId, await ensureCycle(contact.blockId));
    const names = contacts.map((l) => c.people.find((p) => p.id === l.personId)?.nameEn ?? l.personId).join(", ");
    await say(
      chatId,
      `Multiple officers/tasks are linked to this phone (${names}). Please reply with the task number, e.g., '14 done' or '18 partial'.\n` +
        `इस फोन से कई अधिकारी/कार्य जुड़े हैं (${names})। कृपया कार्य संख्या के साथ उत्तर दें, जैसे '14 done' या '18 partial'।`,
    );
    return;
  }
  await replyRouter(contact.blockId, contact.personId, chatId, text, photo, requestId);
}

const pollRef = globalThis as typeof globalThis & { __samikshaPoll__?: { stop: () => void } };

/** Milliseconds until the next 09:00 IST, on `weekday` (0 = Sunday) or any day when null. */
function msUntilIst9(weekday: number | null): number {
  const IST = 5.5 * 3_600_000;
  const now = Date.now();
  const ist = new Date(now + IST);
  let t = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 0, 0) - IST;
  if (t <= now) t += 86_400_000;
  if (weekday !== null) while (new Date(t + IST).getUTCDay() !== weekday) t += 86_400_000;
  return Math.max(1000, t - now);
}

/** getUpdates loop for dev / a long-running pilot box. Idempotent across HMR reloads. */
export function startLongPolling(log: (m: string) => void = console.log): { stop: () => void } {
  if (pollRef.__samikshaPoll__) return pollRef.__samikshaPoll__;
  const ctl = new AbortController();
  let offset = 0;
  const loop = async () => {
    while (!ctl.signal.aborted) {
      try {
        const started = Date.now();
        const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "edited_message"] }, AbortSignal.any([ctl.signal, AbortSignal.timeout(35_000)]));
        // Telegram holds an empty poll for `timeout` seconds; an endpoint that does not must not spin us.
        if (!updates.length && Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000));
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((err) => log(`[bot] update ${u.update_id} failed: ${err instanceof Error ? err.message : err}`));
        }
      } catch (err) {
        if (ctl.signal.aborted) break;
        if ((err as { code?: number }).code === 409) {
          log("[bot] a webhook is set for this token; long polling stays off.");
          break;
        }
        log(`[bot] poll error: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  // While this process runs: daily 09:00 IST reminders, the Monday 09:00 IST digest,
  // and a queue sweep every 15 s for retries (Vercel Cron covers deploys).
  const timers: ReturnType<typeof setTimeout>[] = [];
  const daily = () => {
    timers.push(setTimeout(() => {
      sendDueNudges().then((r) => log(`[bot] nudges ${JSON.stringify(r)}`)).catch((e) => log(`[bot] nudge error: ${e}`)).finally(daily);
    }, msUntilIst9(null)));
  };
  const weekly = () => {
    timers.push(setTimeout(() => {
      sendWeeklyDigest(defaultBlockId(), "BEO", stableUuid("weekly", istToday()))
        .then((r) => log(`[bot] weekly digest: ${r.gate?.en ?? ""}`)).catch((e) => log(`[bot] digest error: ${e}`)).finally(weekly);
    }, msUntilIst9(1)));
  };
  const sweep = setInterval(() => {
    drainQueue({ budgetMs: 5000 }).catch((e) => log(`[bot] queue error: ${e}`));
  }, 15_000);
  daily();
  weekly();
  void loop();
  log("[bot] long polling started");
  pollRef.__samikshaPoll__ = {
    stop: () => {
      ctl.abort();
      for (const t of timers) clearTimeout(t);
      clearInterval(sweep);
      pollRef.__samikshaPoll__ = undefined;
    },
  };
  return pollRef.__samikshaPoll__;
}
