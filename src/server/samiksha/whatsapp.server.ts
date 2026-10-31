/**
 * WhatsApp on the server: Meta's webhook (the subscribe handshake and inbound
 * replies) and the task card sender. A reply is read by the same applyFieldReply
 * as a Telegram one, so the same rules move the same task. A number moves
 * nothing until the BEO has sent a card to it, which links it to the task's
 * owner; an unknown number is counted and ignored.
 *
 * Needs, server-only: WHATSAPP_VERIFY_TOKEN (the handshake), WHATSAPP_APP_SECRET
 * (the X-Hub-Signature-256 check on every POST), WHATSAPP_TOKEN and
 * WHATSAPP_PHONE_NUMBER_ID (sending). Without the app secret no POST is read.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { assertOfficerPermission, factCheckOutboundMessage, formatTaskCard, officerOf, type ActingOfficer, type OfficerRole } from "@/lib/samiksha/engine";
import { copy, type ActionResult } from "@/lib/samiksha/types";
import { parseWhatsAppWebhook, sendWhatsAppTaskCard } from "@/lib/samiksha/whatsapp";
import { factContext } from "../../../server/bot/queue";
import { applyFieldReply } from "./actions.server";
import { defaultBlockId, insertMessage, secretMatches, stableUuid } from "./repo.server";

type Who = OfficerRole | ActingOfficer;

/** Meta's GET handshake: echo the challenge only for "subscribe" with our verify token. */
export function verifyWhatsAppChallenge(params: URLSearchParams): { status: number; body: string } {
  const ok = params.get("hub.mode") === "subscribe" && secretMatches(params.get("hub.verify_token"), process.env.WHATSAPP_VERIFY_TOKEN);
  return ok ? { status: 200, body: params.get("hub.challenge") ?? "" } : { status: 403, body: "Forbidden" };
}

/** X-Hub-Signature-256: an HMAC-SHA256 of the raw body under the app secret. An unset secret never matches. */
export function whatsAppSignatureValid(rawBody: string, header: string | null, secret = process.env.WHATSAPP_APP_SECRET): boolean {
  if (!secret?.trim() || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret.trim()).update(rawBody, "utf8").digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const phoneOf = (raw: string) => raw.replace(/[^\d]/g, "");

/** Each reply in a webhook payload, recorded against the person its number is linked to. */
export async function handleWhatsAppWebhook(payload: unknown, blockId = defaultBlockId()): Promise<{ recorded: number; unknownSender: number; taskNos: number[] }> {
  const sql = await getSql();
  let recorded = 0;
  let unknownSender = 0;
  const taskNos: number[] = [];
  for (const r of parseWhatsAppWebhook(payload)) {
    if (!r.id || !r.from) continue;
    const [contact] = await sql`select person_id from whatsapp_contacts where block_id = ${blockId} and phone = ${phoneOf(r.from)}`;
    if (!contact) {
      unknownSender += 1;
      continue;
    }
    // Meta redelivers on any non-200; the message id makes a redelivery a no-op.
    const out = await applyFieldReply({
      blockId, personId: contact.person_id as string, chatId: null, text: r.text, photo: r.type === "image", requestId: stableUuid("whatsapp", r.id), channel: "whatsapp",
    });
    recorded += 1;
    if (out.taskNo !== null) taskNos.push(out.taskNo);
  }
  return { recorded, unknownSender, taskNos };
}

/**
 * Send one approved or sent task as the WhatsApp utility template, and link the
 * number to the task's owner so their replies come back to this task. The card
 * passes the same fact-check as a Telegram card first.
 */
export async function sendWhatsAppCard(input: {
  blockId: string;
  cycleId: number;
  taskNo: number;
  phone: string;
  lang: "en" | "hi";
  role: Who;
  requestId: string;
}): Promise<ActionResult> {
  const { officer } = assertOfficerPermission(input.role, "dispatch_tasks");
  const phone = phoneOf(input.phone);
  if (!/^\d{10,15}$/.test(phone)) return { ok: false, gate: copy("Enter the number with its country code, for example 919800000000.", "देश कोड सहित नंबर लिखें, जैसे 919800000000।") };
  const sql = await getSql();
  const ctx = await factContext(input.blockId, input.cycleId, sql);
  const task = ctx.tasks.find((t) => t.id === input.taskNo);
  if (!task) return { ok: false, gate: copy(`Task #${input.taskNo} is not in this cycle.`, `कार्य #${input.taskNo} इस चक्र में नहीं है।`) };
  if (!["approved", "sent", "reminded", "partial"].includes(task.status)) {
    return { ok: false, gate: copy(`Task #${task.id} is ${task.status}; only an approved or sent task goes to WhatsApp.`, `कार्य #${task.id} ${task.status} है; केवल अनुमोदित या भेजा गया कार्य WhatsApp पर जाता है।`) };
  }
  const owner = ctx.cycle.people.find((p) => p.id === task.ownerId);
  if (!owner) return { ok: false, gate: copy(`Task #${task.id} has no owner on the roster.`, `कार्य #${task.id} का रोस्टर में कोई जिम्मेदार नहीं।`) };
  const text = formatTaskCard(task, owner, input.lang);
  const fc = factCheckOutboundMessage({ text, kind: task.status === "approved" ? "task_card" : "nudge", taskId: task.id }, ctx);
  if (!fc.passed) return { ok: false, gate: copy(`Stopped by the fact-check: ${fc.problems.map((p) => p.en).join("; ")}`, `तथ्य-जाँच ने रोका: ${fc.problems.map((p) => p.hi).join("; ")}`) };

  // The link is the BEO's: the number now belongs to this owner until it is linked to someone else.
  await sql`
    insert into whatsapp_contacts (block_id, person_id, phone, linked_by_role) values (${input.blockId}, ${owner.id}, ${phone}, ${officer.role})
    on conflict (block_id, person_id) do update set phone = ${phone}, linked_by_role = ${officer.role}`;
  const sent = await sendWhatsAppTaskCard(task, owner, input.lang, phone);
  if (!sent.sent) {
    return { ok: false, gate: copy(`Number linked to ${owner.nameEn}, but the card was not sent: ${sent.reason}`, `नंबर ${owner.nameHi} से जुड़ा, पर कार्ड नहीं गया: ${sent.reason}`) };
  }
  await insertMessage(sql, {
    blockId: input.blockId, requestId: stableUuid(input.requestId, "whatsapp-card", task.id), cycleId: input.cycleId, direction: "out", kind: "card", channel: "whatsapp",
    personId: owner.id, chatId: phone, text,
  });
  return { ok: true, gate: copy(`Task #${task.id} sent to ${owner.nameEn} on WhatsApp (${officerOf(input.role).role}).`, `कार्य #${task.id} ${owner.nameHi} को WhatsApp पर भेजा।`) };
}
