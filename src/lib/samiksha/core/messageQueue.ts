/**
 * Outbound message queue rules, shared by the server worker and the burst
 * simulator. Every proactive message (task card, nudge, DEO escalation, weekly
 * digest, appreciation) is fact-checked, queued under an idempotency key, then
 * delivered within Telegram's limits: at most 25 messages a second overall
 * (under Telegram's 30), one a second per chat, 25 per batch, highest priority
 * first. A 429 waits the time Telegram asks for; other errors back off
 * exponentially; after 5 attempts a message is dead-lettered, never dropped
 * silently.
 */
import type { OutboundKind } from "./telegramFactCheck";

export type QueuePriority = 1 | 2 | 3 | 4;
export type QueueStatus = "queued" | "processing" | "delivered" | "retry_scheduled" | "blocked_fact_check" | "dead_letter";

export const QUEUE_LIMITS = { globalPerSecond: 25, perChatIntervalMs: 1000, batchSize: 25, maxAttempts: 5, baseBackoffMs: 2000, maxBackoffMs: 60_000 } as const;

/** 1 = critical escalation, 2 = task card or reminder, 3 = digest or diagnostic, 4 = appreciation. */
export const KIND_PRIORITY: Record<OutboundKind, QueuePriority> = {
  deo_escalation: 1,
  task_card: 2,
  nudge: 2,
  weekly_digest: 3,
  why_diagnostic: 3,
  system_reply: 3,
  appreciation: 4,
};

export type QueueItem = { key: string; chatId: string; priority: QueuePriority; dueAtMs: number; attempts: number; status: QueueStatus };

/** The queue as the Follow tab shows it: counts by status and the latest rows. */
export type QueueSummary = {
  counts: Record<QueueStatus, number>;
  recent: {
    id: number;
    kind: OutboundKind;
    status: QueueStatus;
    taskNo: number | null;
    personId: string | null;
    attempts: number;
    factCheckPassed: boolean;
    /** How many of the message's fact checks passed. 0 to 1. */
    factCheckConfidence: number;
    at: string;
    error: string | null;
  }[];
};

/** Recent deliveries, for the limits: times of sends in the last second, and the last send per chat. */
export type RateState = { recentSends: number[]; lastByChat: Map<string, number> };

export const newRateState = (): RateState => ({ recentSends: [], lastByChat: new Map() });

/**
 * Which waiting items may go now. Sorted by priority then due time; an item
 * waits if its chat had a message in the last second or the global budget for
 * this second is used up.
 */
export function planBatch(items: QueueItem[], nowMs: number, state: RateState): { send: QueueItem[]; nextAtMs: number | null } {
  const L = QUEUE_LIMITS;
  const windowSends = state.recentSends.filter((t) => nowMs - t < 1000);
  let budget = Math.min(L.batchSize, L.globalPerSecond - windowSends.length);
  const ready = items
    .filter((i) => i.status === "queued" || i.status === "retry_scheduled")
    .sort((a, b) => a.priority - b.priority || a.dueAtMs - b.dueAtMs || a.key.localeCompare(b.key));
  const send: QueueItem[] = [];
  const chatsThisBatch = new Set<string>();
  let nextAtMs: number | null = null;
  const later = (t: number) => {
    nextAtMs = nextAtMs === null ? t : Math.min(nextAtMs, t);
  };
  for (const i of ready) {
    if (i.dueAtMs > nowMs) {
      later(i.dueAtMs);
      continue;
    }
    const last = state.lastByChat.get(i.chatId);
    if (chatsThisBatch.has(i.chatId) || (last !== undefined && nowMs - last < L.perChatIntervalMs)) {
      later((last ?? nowMs) + L.perChatIntervalMs);
      continue;
    }
    if (budget <= 0) {
      later((windowSends[0] ?? nowMs) + 1000);
      continue;
    }
    send.push(i);
    chatsThisBatch.add(i.chatId);
    budget -= 1;
  }
  return { send, nextAtMs };
}

/** Record a delivery in the rate state. */
export function noteSent(state: RateState, chatId: string, atMs: number) {
  state.recentSends = [...state.recentSends.filter((t) => atMs - t < 1000), atMs];
  state.lastByChat.set(chatId, atMs);
}

/** Wait before the next attempt: Telegram's retry_after on a 429, else 2 s doubling, capped at 60 s. */
export function backoffMs(attempts: number, retryAfterSec?: number | null): number {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(QUEUE_LIMITS.maxBackoffMs, QUEUE_LIMITS.baseBackoffMs * 2 ** Math.max(0, attempts - 1));
}

export type BurstReport = {
  submitted: number;
  accepted: number;
  duplicatesBlocked: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  dropped: number;
  virtualSeconds: number;
  maxPerSecond: number;
  maxPerChatPerSecond: number;
};

/**
 * Simulate a burst on a virtual clock: `count` messages over `chats` chats,
 * every `duplicateEvery`-th one a re-submission of an earlier key (a double
 * click or a webhook retry), and every `rateLimitEvery`-th first attempt
 * answered 429 with retry_after 1 s. Nothing is sent anywhere.
 */
export function simulateBurstLoad(count = 150, opts: { chats?: number; duplicateEvery?: number; rateLimitEvery?: number } = {}): BurstReport {
  const chats = opts.chats ?? 40;
  const dupEvery = opts.duplicateEvery ?? 10;
  const rlEvery = opts.rateLimitEvery ?? 25;
  const items = new Map<string, QueueItem>();
  let duplicates = 0;
  for (let n = 0; n < count; n++) {
    const key = dupEvery > 0 && n > 0 && n % dupEvery === 0 ? `msg-${n - 1}` : `msg-${n}`;
    if (items.has(key)) {
      duplicates += 1;
      continue;
    }
    const priority = ([1, 2, 2, 3, 4] as const)[n % 5]!;
    items.set(key, { key, chatId: `chat-${n % chats}`, priority, dueAtMs: 0, attempts: 0, status: "queued" });
  }
  const state = newRateState();
  const sendTimes: number[] = [];
  const perChatSecond = new Map<string, number>();
  let retried = 0;
  let now = 0;
  let order = 0;
  while ([...items.values()].some((i) => i.status === "queued" || i.status === "retry_scheduled") && now < 600_000) {
    const { send, nextAtMs } = planBatch([...items.values()], now, state);
    for (const i of send) {
      order += 1;
      i.attempts += 1;
      if (rlEvery > 0 && i.attempts === 1 && order % rlEvery === 0) {
        i.status = "retry_scheduled";
        i.dueAtMs = now + backoffMs(i.attempts, 1);
        retried += 1;
        continue;
      }
      i.status = "delivered";
      noteSent(state, i.chatId, now);
      sendTimes.push(now);
      const k = `${i.chatId}@${Math.floor(now / 1000)}`;
      perChatSecond.set(k, (perChatSecond.get(k) ?? 0) + 1);
    }
    now = send.length ? now + 50 : Math.max(now + 50, nextAtMs ?? now + 50);
  }
  const perSecond = new Map<number, number>();
  for (const t of sendTimes) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1);
  const all = [...items.values()];
  return {
    submitted: count,
    accepted: items.size,
    duplicatesBlocked: duplicates,
    delivered: all.filter((i) => i.status === "delivered").length,
    retried,
    deadLettered: all.filter((i) => i.status === "dead_letter").length,
    dropped: all.filter((i) => i.status !== "delivered" && i.status !== "dead_letter").length,
    virtualSeconds: Math.ceil(now / 1000),
    maxPerSecond: Math.max(0, ...perSecond.values()),
    maxPerChatPerSecond: Math.max(0, ...perChatSecond.values()),
  };
}
