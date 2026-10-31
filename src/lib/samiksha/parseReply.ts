/**
 * Field-reply parsing, server-only. Decision makers, cheapest first:
 *   0. System 1: Laya (local decision model, LAYA_URL) decides only when it
 *      agrees with an unambiguous deterministic cue in the reply.
 *   1. Otherwise the bounded LLM call (JSON, temperature 0.1, max 400 tokens:
 *      220 cut off Claude's bilingual JSON, since Devanagari costs more tokens);
 *   2. one retry with "Rejected: <reason>" when call 1 fails the validator;
 *   3. engine.simulate on the proposed task state (minimum-balance check).
 * With no model available, a lone unambiguous cue decides; anything else asks
 * the officer for the task number and status.
 */
import {
  ACTION_LIBRARY,
  buildAllowedSet,
  devToAscii,
  parseFieldReply,
  scanPromptInjection,
  simulate,
  validateNumbers,
  type ActionId,
  type ReplyParse,
  type SimulateResult,
  type Task,
  type TaskStatus,
} from "./engine";
import { layaDecide, layaUrl } from "./laya.server";
import { complete, llmModel, parseJsonObject } from "./llm.server";

export const REPLY_PARSE_MONTHLY_LIMIT = 100;
const STATUSES = ["done", "partial", "blocked", "unknown"] as const;
type Status = (typeof STATUSES)[number];
const APPLY_CONFIDENCE = 0.7;

export type ReplyTaskContext = {
  task_id: number | null;
  action_id: ActionId | null;
  what_en: string;
  target_label: string;
  success_en: string;
  success_hi: string;
  units_total: number;
  units_done: number;
  open_tasks: number;
  /** The cycle clock; completion date for the simulate check. */
  today: string;
  /** Billable LLM reply-parses left this month for the block. */
  llm_budget_left: number;
  /** The cycle's tasks; with them, stage 3 (simulate) runs. */
  tasks?: Task[];
};

export type ParseStage = "rules" | "laya" | "llm" | "llm_retry" | "simulate";
export type ParseAttempt = {
  stage: ParseStage;
  model: string;
  ok: boolean;
  reason: string;
  tokensIn: number;
  tokensOut: number;
  billable: boolean;
};

export type ParseAudit = {
  parse: ReplyParse;
  source: ParseStage | "none";
  /** The proposed task state, when the parse is confident enough to apply. */
  proposed: { status: TaskStatus; unitsDone: number; completedAt: string | null } | null;
  attempts: ParseAttempt[];
  simulate: SimulateResult | null;
};

type Candidate = { parse: ReplyParse; unitsDone: number | null };

const STOP = new Set([
  "the", "and", "for", "with", "least", "one", "per", "next", "before", "within", "from", "into", "each", "every", "than", "this", "that", "run", "raise",
  "में", "का", "की", "के", "से", "और", "कम", "पर", "हर", "लें", "करें", "तक", "को", "दिनों", "अगले",
]);

export function successKeywords(ctx: Pick<ReplyTaskContext, "success_en" | "success_hi">): string[] {
  const words = `${ctx.success_en} ${ctx.success_hi}`.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

const NUMBER_WORDS: [RegExp, string][] = [
  [/\bek\b/g, "1"], [/\bdo\b/g, "2"], [/\bteen\b/g, "3"], [/\b(?:char|chaar)\b/g, "4"], [/\b(?:paanch|panch)\b/g, "5"],
  [/(?<=^|[\s,])एक(?=$|[\s,।])/g, "1"], [/(?<=^|[\s,])दो(?=$|[\s,।])/g, "2"], [/(?<=^|[\s,])तीन(?=$|[\s,।])/g, "3"],
  [/(?<=^|[\s,])चार(?=$|[\s,।])/g, "4"], [/(?<=^|[\s,])(?:पांच|पाँच)(?=$|[\s,।])/g, "5"],
];
const SCHOOL = String.raw`(?:schools?|स्कूलों|स्कूल|विद्यालयों|विद्यालय|vidyalay)`;
const LEFT = String.raw`(?:baaki|baki|बाकी|बाक़ी|शेष|remaining|left|pending)`;
const DONE_VERB = String.raw`(?:हुआ|हुई|हो\s*गया|हो\s*गई|ho\s*gaya|ho\s*gayi|hua|hui|done|completed?|पूरा|पूर्ण)`;

function normalise(text: string): string {
  let t = devToAscii(text).toLowerCase();
  for (const [re, d] of NUMBER_WORDS) t = t.replace(re, d);
  return t;
}

/** Schools finished after this reply, when the reply states a count. Deterministic. */
export function claimUnits(text: string, ctx: Pick<ReplyTaskContext, "units_total" | "units_done">): number | null {
  const t = normalise(text);
  let m = t.match(/(\d+)\s*(?:में\s*से|me\s*se|mein\s*se)\s*(\d+)/);
  if (m) return Number(m[2]);
  m = t.match(/(\d+)\s*(?:of|out of|\/)\s*(\d+)/);
  if (m) return Number(m[1]);
  m = t.match(new RegExp(String.raw`(\d+)\s*${SCHOOL}?\s*${LEFT}`)) ?? t.match(new RegExp(String.raw`${LEFT}\s*(\d+)`));
  if (m) return ctx.units_total - Number(m[1]);
  m = t.match(new RegExp(String.raw`(\d+)\s*${SCHOOL}?\s*(?:में|me|mein|in)?\s*(?:\S+\s+){0,2}?${DONE_VERB}`));
  if (m) return ctx.units_done + Number(m[1]);
  return null;
}

const DONE_CUE = /हो\s*गया|हो\s*गई|होगया|ho\s*gay[ai]|hogaya|\bdone\b|complete|पूरा|पूर्ण|kar\s*(?:liya|diya|di)\b|कर\s*(?:लिया|दिया|दी)/;
const PARTIAL_CUE = /आधा|\ba+dha\b|\bhalf\b|partly|partial|बाकी|बाक़ी|\bbaa?ki\b|remaining|\bleft\b|अधूरा|शेष/;
// Negated completion: suppresses the done cue, so "not done yet" can never close a task.
const NOT_DONE_CUE = /\bnot\s+(?:yet\s+)?(?:done|complete[d]?|finished|started)\b|\bnot\s+yet\b|\bpending\b|\bnahi[n]?\s+hu[ai]\b|\babhi\s+nahi[n]?\b|नहीं\s*हु(?:आ|ई)|अभी\s*नहीं|पूरा\s*नहीं/;
const BLOCKED_CUE = /नहीं\s*हो\s*(?:पाया|पाएगा|सका)|nahi\s*ho\s*pa(?:ya|yega)|शुरू\s*नहीं|shuru\s*nahi|blocked|duty|ड्यूटी|transfer|ट्रांसफर|तबादला|chh?utti|छुट्टी|\bleave\b|अवकाश|\bruka\b|रुका|रुकी/;

/** Statuses the reply's own words support, plus the numbers it states. */
export function replyCues(text: string, ctx: Pick<ReplyTaskContext, "units_total" | "units_done">) {
  const t = normalise(text);
  const units = claimUnits(text, ctx);
  const percent = t.match(/(\d{1,3})\s*%/);
  const workLeft = (percent !== null && Number(percent[1]) < 100) || (units !== null && units < ctx.units_total);
  const negated = NOT_DONE_CUE.test(t);
  const found = new Set<Status>();
  if (DONE_CUE.test(t) && !negated) found.add("done");
  if (PARTIAL_CUE.test(t) || workLeft) found.add("partial");
  if (BLOCKED_CUE.test(t) || (negated && !found.has("partial"))) found.add("blocked");
  const single: Status | null = found.size === 0 ? "unknown" : found.size === 1 ? [...found][0]! : null;
  return { found, single, units, workLeft, negated };
}

/** Validator for any candidate (model or code). Empty string = passes. */
export function validateReplyParse(ctx: ReplyTaskContext, text: string, c: Candidate): string {
  const p = c.parse;
  if (!STATUSES.includes(p.parsed_status)) return "parsed_status must be done, partial, blocked or unknown.";
  if (typeof p.confidence !== "number" || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) {
    return "confidence must be a number from 0 to 1.";
  }
  if (typeof p.reason_en !== "string" || typeof p.reason_hi !== "string") return "reason_en and reason_hi must be strings.";
  if (p.parsed_status !== "unknown") {
    const keywords = successKeywords(ctx);
    const said = `${p.reason_en} ${p.reason_hi}`.toLowerCase();
    if (keywords.length && !keywords.some((k) => said.includes(k))) {
      return `reason must name the success measure using one of: ${keywords.join(", ")}.`;
    }
  }
  const open = ctx.units_total - ctx.units_done;
  const cues = replyCues(text, ctx);
  if (p.parsed_status === "done" && cues.workLeft) return "The reply itself says work is left (a count or percent below the total), so it cannot be done.";
  if (p.parsed_status === "done" && cues.negated) return "The reply says the work is not done yet, so it cannot be done.";
  if (c.unitsDone !== null) {
    if (!Number.isInteger(c.unitsDone) || c.unitsDone < 0) return "units_done must be a whole number, 0 or more.";
    if (c.unitsDone - ctx.units_done > open) {
      return `units_done claims ${c.unitsDone - ctx.units_done} more schools, but only ${open} are open.`;
    }
    if (cues.units !== null && c.unitsDone !== cues.units) return `units_done ${c.unitsDone} disagrees with the count in the reply (${cues.units}).`;
    if (p.parsed_status === "partial" && c.unitsDone >= ctx.units_total) return "partial needs at least one school still open; use units_done below units_total or null.";
  }
  const allowed = buildAllowedSet({
    text,
    task: [ctx.task_id, ctx.units_total, ctx.units_done, open, ctx.success_en, ctx.success_hi, ctx.what_en, ctx.target_label],
    claim: c.unitsDone === null ? [] : [c.unitsDone, ctx.units_total - c.unitsDone],
  });
  const said = [p.reason_en, p.reason_hi, p.follow_up_question_en ?? "", p.follow_up_question_hi ?? ""].join("\n");
  const bad = validateNumbers(said, allowed);
  if (bad.length) return `Number check failed on: ${bad.join(", ")}`;
  return "";
}

function codeReason(status: Status, ctx: ReplyTaskContext, units: number | null): Pick<ReplyParse, "reason_en" | "reason_hi"> {
  const count = units === null ? "" : ` (${units} of ${ctx.units_total} schools)`;
  const countHi = units === null ? "" : ` (${ctx.units_total} में से ${units} स्कूल)`;
  if (status === "done") return { reason_en: `Reported done. Success measure: ${ctx.success_en}`, reason_hi: `पूर्ण बताया गया। सफलता मापदंड: ${ctx.success_hi}` };
  if (status === "partial") return { reason_en: `Reported partly done${count}. Success measure: ${ctx.success_en}`, reason_hi: `आंशिक बताया गया${countHi}। सफलता मापदंड: ${ctx.success_hi}` };
  if (status === "blocked") return { reason_en: `Reported blocked; the reply gives the reason. Success measure: ${ctx.success_en}`, reason_hi: `रुका बताया गया; कारण उत्तर में है। सफलता मापदंड: ${ctx.success_hi}` };
  return { reason_en: "Message is ambiguous.", reason_hi: "संदेश स्पष्ट नहीं है।" };
}

const UNKNOWN_QUESTION = {
  follow_up_question_hi: "कृपया कार्य संख्या और स्थिति लिखें: हो गया, आधा, या अभी नहीं।",
  follow_up_question_en: "Please write the task number and a status: done, partly done, or blocked.",
};

function codeCandidate(status: Status, confidence: number, ctx: ReplyTaskContext, units: number | null): Candidate {
  const unknown = status === "unknown";
  return {
    unitsDone: unknown ? null : units,
    parse: {
      parsed_status: status,
      confidence,
      ...codeReason(status, ctx, unknown ? null : units),
      needs_clarification: unknown,
      follow_up_question_hi: unknown ? UNKNOWN_QUESTION.follow_up_question_hi : null,
      follow_up_question_en: unknown ? UNKNOWN_QUESTION.follow_up_question_en : null,
    },
  };
}

const LAYA_QUESTIONS = {
  status: {
    type: "choice",
    instructions: "A school field officer replied about an assigned task. What does the reply say about the task?",
    criteria: {
      done: "the task is finished or completed (हो गया, पूरा हो गया, complete ho gaya, kar diya)",
      partial: "only part is done, or some schools or work are still remaining (आधा, कुछ बाकी, aadha, 75%)",
      blocked: "the work could not happen or is stuck because of a problem such as BLO or election duty, teacher transfer, leave or holiday (नहीं हो पाया, रुका)",
      unknown: "the reply does not say whether the work happened (greeting, okay, network problem, a question)",
    },
  },
};

const SYSTEM = [
  "You read one field officer's reply about one school task for a Block Education Officer in Madhya Pradesh. Replies mix Hindi, English and Hinglish.",
  'Reply with JSON only: {"parsed_status":"done|partial|blocked|unknown","confidence":0.0,"units_done":null,"reason_en":"","reason_hi":"","needs_clarification":false,"follow_up_question_en":null,"follow_up_question_hi":null}',
  "done: the whole task is finished. partial: some of it is done and some is left. blocked: it could not happen or is stuck (election or BLO duty, transfer, leave, holiday, no teacher). unknown: the reply does not say whether the work happened.",
  "Phone or network trouble, greetings and a bare 'ok' are unknown, not blocked: they say nothing about the work.",
  "confidence: how sure you are of parsed_status from the reply's words, 0 to 1. It is not whether the success measure is met yet; the next round checks that.",
  "units_done: how many of the task's target schools are finished after this reply, only if the reply says so; otherwise null. Never more than units_total.",
  "reason_en and reason_hi: one short sentence each. Name the task's success measure using at least one word from allowed_list.keywords.",
  "Use only numbers that appear in the reply or the task. Do not invent schools, people or numbers.",
  "needs_clarification is true only when parsed_status is unknown; then ask one short question in both languages. For done, partial or blocked it is false and both questions are null, even if the outcome (the success measure) is not yet known.",
].join("\n");

function llmCandidate(text: string): Candidate {
  const o = parseJsonObject<Record<string, unknown>>(text);
  const units = o.units_done;
  return {
    unitsDone: units === null || units === undefined ? null : Number(units),
    parse: {
      parsed_status: o.parsed_status as Status,
      confidence: typeof o.confidence === "number" ? o.confidence : Number.NaN,
      reason_en: o.reason_en as string,
      reason_hi: o.reason_hi as string,
      needs_clarification: Boolean(o.needs_clarification),
      follow_up_question_en: typeof o.follow_up_question_en === "string" ? o.follow_up_question_en : null,
      follow_up_question_hi: typeof o.follow_up_question_hi === "string" ? o.follow_up_question_hi : null,
    },
  };
}

type Cues = ReturnType<typeof replyCues>;
type Picked = { cand: Candidate; source: ParseAudit["source"] };

/** System 1: Laya decides only when it agrees with the reply's own unambiguous cue. */
async function layaStage(ctx: ReplyTaskContext, raw: string, cues: Cues, attempts: ParseAttempt[]): Promise<Picked | null> {
  try {
    const name = ctx.action_id ? ACTION_LIBRARY[ctx.action_id].name_en : "school task";
    const r = await layaDecide(`Reply from a CRCC or headteacher about the task "${name}": ${raw}`, LAYA_QUESTIONS);
    const a = r.answers.status;
    if (!a || !STATUSES.includes(a.choice as Status)) throw new Error("Laya gave no status.");
    // Two independent signals must agree: Laya's decision and the reply's own words.
    const agrees = cues.single === a.choice;
    const cand = codeCandidate(a.choice as Status, (a.confidence + 1) / 2, ctx, cues.units);
    const problem = agrees ? validateReplyParse(ctx, raw, cand) : `cues say ${cues.single ?? [...cues.found].join("+")}`;
    const ok = agrees && !problem && cand.parse.confidence >= APPLY_CONFIDENCE;
    attempts.push({ stage: "laya", model: `laya:${r.model}`, ok, reason: `${a.choice} @ ${a.confidence.toFixed(2)}; ${problem || "agrees with reply cues"}`, tokensIn: r.tokensIn, tokensOut: 0, billable: false });
    return ok ? { cand, source: "laya" } : null;
  } catch (err) {
    attempts.push({ stage: "laya", model: "laya", ok: false, reason: err instanceof Error ? err.message : "Laya failed.", tokensIn: 0, tokensOut: 0, billable: false });
    return null;
  }
}

function llmUserTurn(ctx: ReplyTaskContext, raw: string, photo: boolean): string {
  return JSON.stringify({
    task: {
      id: ctx.task_id,
      action: ctx.action_id ? ACTION_LIBRARY[ctx.action_id].name_en : null,
      what: ctx.what_en,
      target: ctx.target_label,
      success_en: ctx.success_en,
      success_hi: ctx.success_hi,
      units_total: ctx.units_total,
      units_done: ctx.units_done,
    },
    reply: raw,
    photo_attached: photo,
    allowed_list: { parsed_status: STATUSES, keywords: successKeywords(ctx), max_units_done: ctx.units_total, open_units: ctx.units_total - ctx.units_done },
  });
}

/** The bounded LLM call, plus one retry that quotes the validator's rejection. */
async function llmStage(ctx: ReplyTaskContext, raw: string, photo: boolean, cues: Cues, attempts: ParseAttempt[], model: string): Promise<Picked | null> {
  if (ctx.llm_budget_left <= 0) {
    attempts.push({ stage: "llm", model, ok: false, reason: `Monthly limit of ${REPLY_PARSE_MONTHLY_LIMIT} reply parses reached; LLM call refused.`, tokensIn: 0, tokensOut: 0, billable: false });
    return null;
  }
  // A field reply is untrusted: any instruction in it is cut out before the prompt.
  const user = scanPromptInjection(llmUserTurn(ctx, raw, photo)).sanitized;
  let first = "";
  for (const stage of ["llm", "llm_retry"] as const) {
    const turns =
      stage === "llm"
        ? [{ role: "user" as const, content: user }]
        : [
            { role: "user" as const, content: user },
            { role: "assistant" as const, content: first.slice(0, 1500) || "{}" },
            { role: "user" as const, content: `Rejected: ${attempts[attempts.length - 1]!.reason} Use only the given allowed_list.` },
          ];
    try {
      const res = await complete(SYSTEM, turns, { temperature: 0.1, maxTokens: 400 });
      if (stage === "llm") first = res.text;
      let problem: string;
      let cand: Candidate | null = null;
      try {
        cand = llmCandidate(res.text);
        if (cand.unitsDone === null && cand.parse.parsed_status !== "unknown") cand.unitsDone = cues.units;
        problem = validateReplyParse(ctx, raw, cand);
      } catch {
        problem = "Response was not usable JSON.";
      }
      attempts.push({ stage, model: res.model, ok: !problem, reason: problem || "passed", tokensIn: res.tokensIn, tokensOut: res.tokensOut, billable: res.billable });
      if (!problem && cand) return { cand, source: stage };
    } catch (err) {
      attempts.push({ stage, model, ok: false, reason: err instanceof Error ? err.message : "AI call failed.", tokensIn: 0, tokensOut: 0, billable: false });
      return null;
    }
  }
  return null;
}

/** No model decided: a lone, unambiguous cue may; anything mixed goes back to the officer. */
function ruleStage(ctx: ReplyTaskContext, raw: string, cues: Cues, attempts: ParseAttempt[]): Picked {
  const lone = cues.single && cues.single !== "unknown" ? codeCandidate(cues.single, 0.75, ctx, cues.units) : null;
  const ok = lone !== null && !validateReplyParse(ctx, raw, lone);
  attempts.push({ stage: "rules", model: "code-rules", ok, reason: `cues: ${[...cues.found].join("+") || "none"}`, tokensIn: 0, tokensOut: 0, billable: false });
  return lone && ok ? { cand: lone, source: "rules" } : { cand: codeCandidate("unknown", 0.35, ctx, null), source: "none" };
}

/** Re-runs the cycle with the proposed state; a failed minimum-balance check turns the reply into "blocked". */
function applyStage(ctx: ReplyTaskContext, chosen: Candidate, attempts: ParseAttempt[]): Pick<ParseAudit, "parse" | "proposed" | "simulate"> {
  let parse = chosen.parse;
  const apply = parse.parsed_status !== "unknown" && !parse.needs_clarification && parse.confidence >= APPLY_CONFIDENCE;
  if (!apply) return { parse, proposed: null, simulate: null };
  const status = parse.parsed_status as TaskStatus;
  const unitsDone = status === "done" ? (chosen.unitsDone ?? ctx.units_total) : (chosen.unitsDone ?? ctx.units_done);
  let proposed: NonNullable<ParseAudit["proposed"]> = { status, unitsDone, completedAt: status === "done" ? ctx.today : null };
  if (!ctx.tasks || ctx.task_id === null) return { parse, proposed, simulate: null };
  const sim = simulate(ctx.tasks, ctx.task_id, proposed);
  attempts.push({ stage: "simulate", model: "engine.simulate", ok: sim.ok, reason: sim.ok ? `balance ${sim.balance}, closure ${sim.closurePct.toFixed(0)}%` : sim.reasonEn, tokensIn: 0, tokensOut: 0, billable: false });
  if (!sim.ok) {
    parse = { ...parse, parsed_status: "blocked", reason_en: sim.reasonEn, reason_hi: sim.reasonHi, needs_clarification: false, follow_up_question_en: null, follow_up_question_hi: null };
    proposed = { status: "blocked", unitsDone: ctx.units_done, completedAt: null };
  }
  return { parse, proposed, simulate: sim };
}

export async function parseFieldReplyAudited(ctx: ReplyTaskContext, text: string, photo = false): Promise<ParseAudit> {
  const raw = text.trim();
  const attempts: ParseAttempt[] = [];
  const cues = replyCues(raw, ctx);
  const model = llmModel();
  // A bare photo has nothing to read; otherwise the decision makers run cheapest first.
  const bare: Picked | null = raw ? null : { cand: { parse: parseFieldReply(raw, { openTasks: ctx.open_tasks, hasPhoto: photo }), unitsDone: null }, source: "rules" };
  const picked: Picked =
    bare ??
    (layaUrl() ? await layaStage(ctx, raw, cues, attempts) : null) ??
    (model ? await llmStage(ctx, raw, photo, cues, attempts, model) : null) ??
    ruleStage(ctx, raw, cues, attempts);
  return { ...applyStage(ctx, picked.cand, attempts), source: picked.source, attempts };
}

export async function parseFieldReplyLLM(taskContext: ReplyTaskContext, text: string, photo?: boolean): Promise<ReplyParse> {
  return (await parseFieldReplyAudited(taskContext, text, photo)).parse;
}
