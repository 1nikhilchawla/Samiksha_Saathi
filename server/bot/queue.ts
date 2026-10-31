/**
 * The outbound queue worker. Nothing proactive goes straight to Telegram:
 * enqueueOutbound fact-checks the text against the cycle and stores it under
 * its idempotency key (a repeat is a no-op); drainQueue then delivers within
 * the limits in core/messageQueue.ts, read from the database so they hold
 * across processes. A delivered row writes the thread message and moves the
 * task (a card to "sent", a reminder to "reminded"); a 429 waits Telegram's
 * retry_after; other errors back off; after 5 attempts the row is
 * dead-lettered.
 */
import { getSql, withTransaction, type Sql } from "@/lib/db";
import {
  KIND_PRIORITY,
  QUEUE_LIMITS,
  backoffMs,
  diagnoseFailure,
  factCheckOutboundMessage,
  newRateState,
  noteSent,
  planBatch,
  type FactCheckContext,
  type FactCheckResult,
  type OutboundKind,
  type QueueItem,
  type QueueStatus,
  type QueueSummary,
  type Scorecard,
} from "@/lib/samiksha/engine";
import { logFailure } from "@/server/samiksha/diagnostics.server";
import { clockToday, cycleById, insertMessage, loadCycleData, loadTasks, stableUuid } from "@/server/samiksha/repo.server";
import { botLive, tg, type TgError } from "./tgApi";

type Copy = { en: string; hi: string };

/** What the fact-check compares a message with. */
export async function factContext(blockId: string, cycleId: number, sql?: Sql): Promise<FactCheckContext> {
  const db = sql ?? (await getSql());
  const data = await loadCycleData(blockId, cycleId);
  const c = await cycleById(blockId, cycleId, db);
  const [snap] = await db`select data from scorecard_snapshots where cycle_id = ${cycleId} order by id desc limit 1`;
  return {
    cycle: data.cycle,
    tasks: (await loadTasks(cycleId, db)).map(({ dbId: _d, ...t }) => t),
    score: c.r4Loaded && snap ? (snap.data as Scorecard) : null,
    simToday: clockToday(c),
  };
}

export type Outbound = {
  blockId: string;
  cycleId: number | null;
  /** The idempotency key: the same request enqueues once. */
  requestId: string;
  kind: OutboundKind;
  taskDbId?: number | null;
  taskNo?: number | null;
  personId?: string | null;
  chatId: string | null;
  text: string;
  textCopy?: Copy;
  extraAllowed?: number[];
};

export type Enqueued = { id: number | null; status: QueueStatus; factCheck: FactCheckResult; duplicate: boolean };

export async function enqueueOutbound(sql: Sql, m: Outbound, ctx: FactCheckContext): Promise<Enqueued> {
  const fc = factCheckOutboundMessage({ text: m.text, kind: m.kind, taskId: m.taskNo ?? null, extraAllowed: m.extraAllowed }, ctx);
  const status: QueueStatus = fc.passed ? "queued" : "blocked_fact_check";
  const rows = await sql`
    insert into message_queue (block_id, client_request_id, cycle_id, task_id, task_no, kind, priority, person_id, chat_id, text, text_copy, fact_check, status, channel)
    values (${m.blockId}, ${m.requestId}, ${m.cycleId}, ${m.taskDbId ?? null}, ${m.taskNo ?? null}, ${m.kind}, ${KIND_PRIORITY[m.kind]},
            ${m.personId ?? null}, ${m.chatId}, ${m.text}, ${m.textCopy ? JSON.stringify(m.textCopy) : null}::jsonb, ${JSON.stringify(fc)}::jsonb,
            ${status}, ${botLive() && m.chatId ? "telegram" : "web"})
    on conflict (block_id, client_request_id) do nothing
    returning id`;
  if (!rows.length) {
    const [old] = await sql`select id, status from message_queue where block_id = ${m.blockId} and client_request_id = ${m.requestId}`;
    return { id: old ? Number(old.id) : null, status: (old?.status as QueueStatus) ?? status, factCheck: fc, duplicate: true };
  }
  if (!fc.passed) {
    const entry = diagnoseFailure("telegram_fact_check", "FACT_CHECK_BLOCKED", {
      kind: m.kind, taskNo: m.taskNo ?? null, problems: fc.problems.map((p) => p.en).join("; "), problemsHi: fc.problems.map((p) => p.hi).join("; "),
    }, { personId: m.personId ?? null });
    await logFailure(sql, m.blockId, m.cycleId, entry, stableUuid(m.requestId, "fact-check"));
  }
  return { id: Number(rows[0]!.id), status, factCheck: fc, duplicate: false };
}

export type DrainReport = { delivered: number; retried: number; deadLettered: number; waiting: number; deliveredIds: number[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rateState(sql: Sql) {
  const state = newRateState();
  const rows = await sql<{ chat_id: string | null; t: number }>`
    select chat_id, (extract(epoch from delivered_at) * 1000)::float8 as t from message_queue
    where delivered_at > now() - interval '1 second' order by delivered_at`;
  for (const r of rows) noteSent(state, r.chat_id ?? "web", Number(r.t));
  return state;
}

async function onDelivered(row: Record<string, unknown>, channel: "telegram" | "web") {
  await withTransaction(async (tx) => {
    await tx`update message_queue set status = 'delivered', delivered_at = now(), channel = ${channel}, attempts = attempts + 1, last_error = null where id = ${row.id}`;
    const kind = row.kind as OutboundKind;
    await insertMessage(tx, {
      blockId: row.block_id as string, requestId: row.client_request_id as string, cycleId: (row.cycle_id as number | null) ?? null,
      taskDbId: (row.task_id as number | null) ?? null, direction: kind === "deo_escalation" ? "sys" : "out",
      kind: kind === "task_card" ? "card" : kind === "nudge" ? "nudge" : "system", channel,
      personId: (row.person_id as string | null) ?? null, chatId: (row.chat_id as string | null) ?? null, text: row.text as string,
      ...(row.text_copy ? { textCopy: row.text_copy as Copy } : {}),
    });
    if (kind === "task_card" && row.task_id) await tx`update tasks set status = 'sent', updated_at = now() where id = ${row.task_id} and status = 'approved'`;
    if (kind === "nudge" && row.task_id) await tx`update tasks set status = 'reminded', updated_at = now() where id = ${row.task_id} and status = 'sent'`;
  });
}

/**
 * Deliver what is due, within the limits, for up to `budgetMs`. Waits (inside
 * the budget) for a chat's one-second gap or a retry that is about to fall due.
 */
/**
 * Take one message and one slot of this second's global budget, in one
 * statement.
 *
 * The claim is atomic: the row is taken only if it is still waiting (or is a
 * stale 'processing' row), so two workers that picked the same row cannot both
 * deliver it. The budget is a shared counter — the `on conflict do update`
 * takes the row lock, so the second worker is told the second is full instead
 * of sending past Telegram's limit. A chat that already had a message in this
 * second is left alone, so the one-per-chat rule holds too.
 */
async function claimOne(sql: Sql, id: number): Promise<Record<string, unknown> | null> {
  const rows = await sql`
    with budget as (
      insert into queue_rate_window (window_second, sent)
      values (floor(extract(epoch from now()))::bigint, 1)
      on conflict (window_second) do update
        set sent = queue_rate_window.sent + 1
        where queue_rate_window.sent < ${QUEUE_LIMITS.globalPerSecond}
      returning window_second
    )
    update message_queue q set status = 'processing', next_attempt_at = now()
    where q.id = ${id}
      and (q.status in ('queued', 'retry_scheduled')
           or (q.status = 'processing' and q.next_attempt_at < now() - interval '2 minutes'))
      and exists (select 1 from budget)
      and not exists (
        select 1 from message_queue m
        where m.chat_id is not null and m.chat_id = q.chat_id
          and m.status = 'delivered' and m.delivered_at > now() - interval '1 second'
      )
    returning q.*`;
  return rows.length ? rows[0] : null;
}

/** True when this second's global budget is used up. */
async function budgetSpent(sql: Sql): Promise<boolean> {
  const [w] = await sql`select sent from queue_rate_window where window_second = floor(extract(epoch from now()))::bigint`;
  return Number(w?.sent ?? 0) >= QUEUE_LIMITS.globalPerSecond;
}

export async function drainQueue(opts: { blockId?: string; budgetMs?: number } = {}): Promise<DrainReport> {
  const budget = opts.budgetMs ?? 8000;
  const started = Date.now();
  const sql = await getSql();
  const report: DrainReport = { delivered: 0, retried: 0, deadLettered: 0, waiting: 0, deliveredIds: [] };
  const live = botLive();
  while (Date.now() - started < budget) {
    const rows = opts.blockId
      ? await sql`select * from message_queue where block_id = ${opts.blockId} and (status in ('queued', 'retry_scheduled') or (status = 'processing' and next_attempt_at < now() - interval '2 minutes')) order by priority, id limit 200`
      : await sql`select * from message_queue where status in ('queued', 'retry_scheduled') or (status = 'processing' and next_attempt_at < now() - interval '2 minutes') order by priority, id limit 200`;
    if (!rows.length) break;
    const state = await rateState(sql);
    const items: QueueItem[] = rows.map((r) => ({
      key: String(r.id), chatId: (r.chat_id as string | null) ?? `web-${r.id}`, priority: Number(r.priority) as QueueItem["priority"],
      dueAtMs: new Date(String(r.next_attempt_at)).getTime(), attempts: Number(r.attempts),
      status: r.status === "processing" ? "retry_scheduled" : (r.status as QueueStatus),
    }));
    const { send, nextAtMs } = planBatch(items, Date.now(), state);
    if (!send.length) {
      const left = budget - (Date.now() - started);
      if (nextAtMs === null || nextAtMs - Date.now() > left) break;
      await sleep(Math.max(50, nextAtMs - Date.now()));
      continue;
    }
    // This second's global budget is spent: wait for the next one instead of
    // spinning on rows nobody can take yet.
    if (await budgetSpent(sql)) {
      const left = budget - (Date.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(1000, left));
      continue;
    }
    for (const item of send) {
      // The claim is atomic: the row is taken only if it is still waiting (or is
      // a stale 'processing' row). Two workers that picked the same row cannot
      // both take it, so no message is ever delivered twice.
      const row = await claimOne(sql, Number(item.key));
      if (!row) continue;
      const chatId = (row.chat_id as string | null) ?? null;
      try {
        if (live && chatId) await tg("sendMessage", { chat_id: chatId, text: String(row.text).slice(0, 4000) });
        await onDelivered(row, live && chatId ? "telegram" : "web");
        noteSent(state, chatId ?? `web-${row.id}`, Date.now());
        report.delivered += 1;
        report.deliveredIds.push(Number(row.id));
      } catch (err) {
        const e = err as TgError;
        const attempts = Number(row.attempts) + 1;
        if (attempts >= QUEUE_LIMITS.maxAttempts) {
          await sql`update message_queue set status = 'dead_letter', attempts = ${attempts}, last_error = ${e.message.slice(0, 300)} where id = ${row.id}`;
          report.deadLettered += 1;
        } else {
          const wait = backoffMs(attempts, e.retryAfter ?? null);
          await sql`update message_queue set status = 'retry_scheduled', attempts = ${attempts}, last_error = ${e.message.slice(0, 300)},
                    next_attempt_at = now() + (${wait} * interval '1 millisecond') where id = ${row.id}`;
          report.retried += 1;
        }
      }
    }
  }
  const [w] = opts.blockId
    ? await sql<{ n: number }>`select count(*)::int as n from message_queue where block_id = ${opts.blockId} and status in ('queued', 'retry_scheduled', 'processing')`
    : await sql<{ n: number }>`select count(*)::int as n from message_queue where status in ('queued', 'retry_scheduled', 'processing')`;
  report.waiting = Number(w?.n ?? 0);
  return report;
}

export async function queueSummary(blockId: string, cycleId: number): Promise<QueueSummary> {
  const sql = await getSql();
  const counts = { queued: 0, processing: 0, delivered: 0, retry_scheduled: 0, blocked_fact_check: 0, dead_letter: 0 } as Record<QueueStatus, number>;
  for (const r of await sql`select status, count(*)::int as n from message_queue where block_id = ${blockId} and cycle_id = ${cycleId} group by status`) {
    counts[r.status as QueueStatus] = Number(r.n);
  }
  const recent = await sql`select id, kind, status, task_no, person_id, attempts, fact_check, created_at, last_error from message_queue where block_id = ${blockId} and cycle_id = ${cycleId} order by id desc limit 12`;
  return {
    counts,
    recent: recent.map((r) => ({
      id: Number(r.id), kind: r.kind as OutboundKind, status: r.status as QueueStatus, taskNo: r.task_no === null ? null : Number(r.task_no),
      personId: (r.person_id as string | null) ?? null, attempts: Number(r.attempts), factCheckPassed: Boolean((r.fact_check as { passed?: boolean })?.passed),
      factCheckConfidence: Number((r.fact_check as { confidence?: number })?.confidence ?? 0),
      at: new Date(String(r.created_at)).toISOString(), error: (r.last_error as string | null) ?? null,
    })),
  };
}
