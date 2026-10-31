/**
 * The decision layer: typed decisions with a confidence, kept apart from any
 * text generation. Laya (laya.server.ts, a local decision model) answers where
 * its sidecar runs (LAYA_URL); these functions are the rule decisions that run
 * everywhere and that Laya's answers are checked against. Their confidence is a
 * rule score (how far the inputs sit from each threshold), not a calibrated
 * probability, and the screen labels it that way.
 *
 * layaSecondCheckOnClaude runs after every model call: numbers must come from
 * the input, actions from the library, targets from the roster, and a negated
 * reply can never come back as "done".
 */
import { ACTION_LIBRARY, REVIEW_DATE } from "./config";
import { approveBlockers, buildAllowedSet, extractNumbers, scanPromptInjection, validateAppropriateContent, validateNumbers } from "./guards";
import { defaultOwner } from "./hingePoints";
import type { Cycle, Task } from "./model";
import { addDays, parseFieldReply } from "./tasks";
import { MAX_IMAGE_RAW_SIZE_BYTES } from "./uploadLimits";
import { PHOTO_RULES } from "./visionGuard";

type Copy = { en: string; hi: string };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
/** 0.5 at the threshold, rising to 1 one full threshold-width away. */
const margin = (value: number, threshold: number, width: number) => 0.5 + 0.5 * clamp(Math.abs(value - threshold) / Math.max(1e-9, width));
const round2 = (n: number) => Math.round(n * 100) / 100;

export type ImageDecisionCode = "RELEVANT_CLASSROOM_GROUP" | "IRRELEVANT_NON_CLASSROOM" | "SINGLE_CHILD_PII_VIOLATION" | "BLURRY_OR_DARK" | "OVERSIZED_FILE";

export type ImageDecision = {
  ok: boolean;
  code: ImageDecisionCode;
  confidence: number;
  subScores: { quality: number; privacy: number; relevance: number };
  source: "rules";
};

/** Decide what a photo is from its pixel measures. Order: size, quality, relevance, privacy. */
export function layaClassifyImage(
  m: { sharpnessScore: number; brightnessScore: number; detectedPersonCount: number; maxFaceAreaRatio: number; sceneComplexityScore: number },
  file: { sizeBytes?: number } = {},
): ImageDecision {
  const r = PHOTO_RULES;
  const sharpOk = m.sharpnessScore >= r.minSharpness;
  const lightOk = m.brightnessScore >= r.minBrightness && m.brightnessScore <= r.maxBrightness;
  const quality = Math.min(
    margin(m.sharpnessScore, r.minSharpness, r.minSharpness),
    margin(m.brightnessScore, m.brightnessScore < 128 ? r.minBrightness : r.maxBrightness, 40),
  );
  const groupOk = m.detectedPersonCount >= r.minGroup && m.maxFaceAreaRatio <= r.maxFaceShare;
  const privacy = Math.min(margin(m.detectedPersonCount, r.minGroup - 0.5, 3), margin(m.maxFaceAreaRatio, r.maxFaceShare, r.maxFaceShare));
  const relevant = m.detectedPersonCount > 0 || m.sceneComplexityScore >= 45;
  const relevance = margin(m.sceneComplexityScore, 45, 25);
  const sub = { quality: round2(quality), privacy: round2(privacy), relevance: round2(relevance) };
  if (file.sizeBytes !== undefined && file.sizeBytes > MAX_IMAGE_RAW_SIZE_BYTES) return { ok: false, code: "OVERSIZED_FILE", confidence: 1, subScores: sub, source: "rules" };
  if (!sharpOk || !lightOk) return { ok: false, code: "BLURRY_OR_DARK", confidence: sub.quality, subScores: sub, source: "rules" };
  if (!relevant) return { ok: false, code: "IRRELEVANT_NON_CLASSROOM", confidence: sub.relevance, subScores: sub, source: "rules" };
  if (!groupOk) return { ok: false, code: "SINGLE_CHILD_PII_VIOLATION", confidence: sub.privacy, subScores: sub, source: "rules" };
  return { ok: true, code: "RELEVANT_CLASSROOM_GROUP", confidence: round2(Math.min(sub.quality, sub.privacy, sub.relevance)), subScores: sub, source: "rules" };
}

export type AutoFill = {
  taskNo: number;
  ownerId: string | null;
  ownerConfidence: number;
  dueDate: string | null;
  dueConfidence: number;
  confidence: number;
  /** The task as it would be after the fill; approval is still the officer's click. */
  filled: Task;
  ready: boolean;
  why: Copy;
};

/**
 * Propose the missing owner and due date of a draft from the roster and the
 * action library (the same rule as the HP-3 pivot). Scores: the DEO for a
 * posting 0.95, the target school's own HM 0.9, the cluster CRCC 0.8; a library
 * default date 0.7, because the note did not state one.
 */
export function layaAutoFillTaskGovernance(task: Task, cycle: Pick<Cycle, "schools" | "people">, simToday: string): AutoFill {
  const base = simToday > REVIEW_DATE ? simToday : REVIEW_DATE;
  let ownerId = task.ownerId;
  let ownerConfidence = 1;
  if (!ownerId) {
    ownerId = defaultOwner(task.actionId, task.targetCodes, cycle);
    const p = cycle.people.find((x) => x.id === ownerId);
    ownerConfidence = !p ? 0 : p.role === "DEO" ? 0.95 : p.role === "HM" ? 0.9 : 0.8;
  }
  let dueDate = task.dueDate;
  let dueConfidence = 1;
  if (!dueDate || dueDate <= REVIEW_DATE) {
    dueDate = addDays(base, ACTION_LIBRARY[task.actionId].default_duration_days);
    dueConfidence = 0.7;
  }
  const filled: Task = { ...task, ownerId, dueDate };
  filled.missingFields = approveBlockers(filled);
  const owner = cycle.people.find((x) => x.id === ownerId);
  const days = ACTION_LIBRARY[task.actionId].default_duration_days;
  return {
    taskNo: task.id,
    ownerId,
    ownerConfidence,
    dueDate,
    dueConfidence,
    confidence: Math.min(ownerConfidence, dueConfidence),
    filled,
    ready: filled.missingFields.length === 0,
    why: {
      en: `${owner ? `${owner.nameEn} (${owner.role}, ${owner.scope})` : "no owner on the roster"} · due ${dueDate} (${days} days, action library).`,
      hi: `${owner ? `${owner.nameHi} (${owner.role}, ${owner.scope})` : "रोस्टर में कोई जिम्मेदार नहीं"} · अंतिम तिथि ${dueDate} (${days} दिन, कार्य सूची)।`,
    },
  };
}

const NEGATION = /(nahi|nahin|nhi|\bnot\b|na hua|abhi tak|नहीं|ना हुआ|बाकी)/i;

/** The rule reading of a field reply, with its confidence; Laya (when running) is checked against this. */
export function layaClassifyFieldReply(text: string, hasPhoto: boolean, openTasks: number) {
  const p = parseFieldReply(text, { openTasks, hasPhoto });
  return { status: p.parsed_status, confidence: p.confidence, negated: NEGATION.test(text), source: "rules" as const };
}

export type SecondCheckDomain = "voice_task_extraction" | "reply_parsing" | "cleaning_rule_ast" | "failure_explanation" | "brief_ranking";

export type SecondCheck = {
  verified: boolean;
  agreement: "FULL_AGREEMENT" | "CORRECTED" | "BLOCKED";
  confidence: number;
  checks: { id: string; pass: boolean; detail: string }[];
  corrections: string[];
  badge: Copy;
};

/**
 * The second check after a model call. Pass only what applies: `text` with
 * `allowedFrom` (numbers must come from there), `actionIds`, `targets` with
 * `knownTargets`, `status` with `sourceText` (a negated reply cannot be done),
 * and `numbers` that must each appear in `sourceText` (a cleaning threshold
 * the officer did not write). `corrections` lists fields the caller dropped.
 */
export function layaSecondCheckOnClaude(
  domain: SecondCheckDomain,
  output: { text?: string; actionIds?: string[]; targets?: string[]; status?: string; numbers?: number[]; citations?: { id: string; count: number }[] },
  ctx: { allowedFrom?: unknown; sourceText?: string; knownTargets?: string[]; exactTargets?: boolean; corrections?: string[] } = {},
): SecondCheck {
  const checks: SecondCheck["checks"] = [];
  // The brief ranking names its checks; the other domains keep their short ids.
  const ranking = domain === "brief_ranking";
  if (output.text !== undefined && ctx.allowedFrom !== undefined) {
    const bad = validateNumbers(output.text, buildAllowedSet(ctx.allowedFrom));
    checks.push({ id: ranking ? "number_fidelity" : "numbers", pass: !bad.length, detail: bad.length ? `invented: ${bad.join(", ")}` : "all numbers from the input" });
  }
  if (output.actionIds) {
    const bad = output.actionIds.filter((a) => !(a in ACTION_LIBRARY));
    checks.push({ id: ranking ? "action_library_validity" : "actions", pass: !bad.length, detail: bad.length ? `not in the library: ${bad.join(", ")}` : "all actions in the library" });
  }
  if (output.citations) {
    const bad = output.citations.filter((c) => c.count < 1).map((c) => c.id);
    checks.push({ id: ranking ? "citation_completeness" : "citations", pass: !bad.length, detail: bad.length ? `no source citation: ${bad.join(", ")}` : "every item cites its source rows" });
  }
  if (output.targets && ctx.knownTargets) {
    const known = new Set(ctx.knownTargets.map((t) => t.toLowerCase()));
    const bad = output.targets.filter((t) => !known.has(t.toLowerCase()));
    if (ctx.exactTargets) {
      // Every known target exactly once: nothing added, nothing dropped, nothing doubled.
      const given = output.targets.map((t) => t.toLowerCase());
      bad.push(...ctx.knownTargets.filter((t) => !given.includes(t.toLowerCase())).map((t) => `${t} (dropped)`));
      bad.push(...[...new Set(given.filter((t, i) => given.indexOf(t) !== i))].map((t) => `${t} (twice)`));
    }
    checks.push({ id: ranking ? "target_preservation" : "targets", pass: !bad.length, detail: bad.length ? `not on the roster: ${bad.join(", ")}` : "all targets on the roster" });
  }
  if (output.status !== undefined && ctx.sourceText !== undefined) {
    const inverted = output.status === "done" && NEGATION.test(ctx.sourceText);
    checks.push({ id: "negation", pass: !inverted, detail: inverted ? "a negated reply was read as done" : "no negation inverted" });
  }
  if (output.numbers && ctx.sourceText !== undefined) {
    const said = new Set(extractNumbers(ctx.sourceText).map((n) => String(Number(n))));
    const bad = output.numbers.filter((n) => !said.has(String(n)));
    checks.push({ id: "thresholds", pass: !bad.length, detail: bad.length ? `not in the officer's words: ${bad.join(", ")}` : "every threshold was written by the officer" });
  }
  // Tone and safety, on any text a model wrote: no threat, slur or label, and no instruction smuggled in from the data.
  if (output.text !== undefined) {
    const tone = validateAppropriateContent(output.text);
    const injected = scanPromptInjection(output.text);
    const bad = [...tone.violations, ...injected.detections];
    checks.push({ id: "tone_and_safety", pass: !bad.length, detail: bad.length ? `INAPPROPRIATE_OR_PUNITIVE_TONE: ${bad.join(", ")}` : "supportive, non-punitive wording" });
  }
  const passed = checks.filter((c) => c.pass).length;
  const verified = passed === checks.length;
  const corrections = ctx.corrections ?? [];
  const agreement = !verified ? "BLOCKED" : corrections.length ? "CORRECTED" : "FULL_AGREEMENT";
  const label = domain.replace(/_/g, " ");
  return {
    verified,
    agreement,
    confidence: checks.length ? round2(passed / checks.length) : 1,
    checks,
    corrections,
    badge: verified
      ? { en: `Second check: pass · ${passed}/${checks.length} rules (${label})`, hi: `दूसरी जाँच: सही · ${checks.length} में से ${passed} नियम` }
      : { en: `Second check: blocked · ${checks.filter((c) => !c.pass).map((c) => c.detail).join("; ")}`, hi: `दूसरी जाँच: रोका · ${checks.filter((c) => !c.pass).map((c) => c.detail).join("; ")}` },
  };
}

/**
 * The five checks on a reordered brief list: (1) number fidelity, every digit
 * in the reasons comes from the facts; (2) action library validity, every
 * reordered gap still points at a library action; (3) citation completeness,
 * every reordered gap still cites its source rows; (4) target preservation,
 * every gap of the list exactly once; (5) tone and safety, no punitive or
 * abusive word and no smuggled instruction. Confidence is passed / 5, so it
 * reads 1.0, 0.8, 0.6, 0.4, 0.2 or 0. An order is applied only at 5 of 5;
 * checks 2 and 3 repeat, on the answer, what the server checked before the call.
 */
export function briefRankingSecondCheck(
  order: { gap_id: string; justification_en: string; justification_hi: string }[],
  gaps: { id: string; actionId: string; sourceRefs: unknown[] }[],
  facts: unknown,
): SecondCheck {
  const byId = new Map(gaps.map((g) => [g.id, g]));
  return layaSecondCheckOnClaude(
    "brief_ranking",
    {
      text: order.map((o) => `${o.justification_en}\n${o.justification_hi}`).join("\n"),
      actionIds: order.map((o) => byId.get(o.gap_id)?.actionId ?? `unknown gap ${o.gap_id}`),
      citations: order.map((o) => ({ id: o.gap_id, count: byId.get(o.gap_id)?.sourceRefs.length ?? 0 })),
      targets: order.map((o) => o.gap_id),
    },
    { allowedFrom: facts, knownTargets: gaps.map((g) => g.id), exactTargets: true },
  );
}
