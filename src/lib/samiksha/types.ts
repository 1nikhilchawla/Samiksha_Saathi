import type { Cycle, FailureDiagnosticEntry, HingeChange, HingeCode, HingePivotId, OfficerRole, ProofMeta, QueueSummary, ReplyParse, Scorecard, Task } from "./engine";

export type Lang = "en" | "hi";
export type Copy = { en: string; hi: string };

export function copy(en: string, hi: string): Copy {
  return { en, hi };
}

export type ChatMsg = {
  id: string;
  taskId: number | null;
  direction: "in" | "out" | "sys";
  text: string;
  /** Both languages, for system lines that follow the language toggle. */
  textCopy?: Copy;
  parsed?: ReplyParse;
};

export type LlmCall = {
  id: string;
  purpose: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  inr: number;
  passed: boolean;
  simulated: boolean;
  note: string;
};

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** The persisted cycle, as the UI reads it. Changes only on a new run, a narration or R4. */
export type CycleData = {
  cycleId: number;
  blockId: string;
  isSeed: boolean;
  /** Files-to-brief time measured on the server when the cycle was built. */
  prepSeconds: number;
  cycle: Omit<Cycle, "briefInput"> & { briefInput: { [k: string]: Json } };
};

/** One executed hinge pivot, as stored in hinge_decisions and shown in the studio's audit trail. */
export type HingeDecision = {
  id: string;
  code: HingeCode;
  pivotId: HingePivotId;
  role: OfficerRole;
  at: string;
  summary: Copy;
  changes: HingeChange[];
};

/** What moves during the month: tasks, the bot thread, the scorecard, the ledger. */
export type LiveData = {
  cycleId: number;
  simToday: string;
  r4Loaded: boolean;
  tasks: Task[];
  messages: ChatMsg[];
  scorecard: Scorecard | null;
  llmCalls: LlmCall[];
  /** The pivots that were executed, newest last. */
  hingeDecisions: HingeDecision[];
  bot: { live: boolean; username: string };
} & LiveExtras;

/** Queue, failures, stored proofs, appreciations and switched-on services (live.server.ts). */
export type LiveExtras = {
  queue: QueueSummary;
  failures: FailureDiagnosticEntry[];
  proofs: ProofMeta[];
  appreciations: { personId: string; points: number; badges: string[]; role: string; at: string }[];
  /** Optional services this server has switched on; each screen falls back calmly when one is off. */
  services: { mediaKey: boolean; laya: boolean; model: boolean; stt: boolean; whatsapp: boolean };
  /** AI reorders of the brief this month: asks spent (a retry or a cached answer is not one) and the monthly cap. */
  reorders: { used: number; cap: number };
};

/** Every mutation answers with the officer-facing line the tab shows. */
export type ActionResult = { ok: boolean; gate: Copy | null };
