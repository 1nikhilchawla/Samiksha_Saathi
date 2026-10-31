import { ACTION_LIBRARY, DEFAULT_TOP_GAPS_LIMIT, REVIEW_DATE, devToAscii } from "./config";
import type { Gap, Task } from "./model";

/** Prefix for numbers the input states as a percentage; "80%" in text must match one of these. */
const PCT = "pct:";

/**
 * Every number in the text, flagged when a % sign follows it. Devanagari digits
 * count. A minus is a sign only where it starts a number; right after a letter
 * or a digit it is a hyphen (2025-26, R2-R3), and the number is read unsigned.
 */
function numberTokens(text: string): { tok: string; pct: boolean; negative: boolean }[] {
  const norm = devToAscii(text).replace(/[−–—]/g, "-");
  return [...norm.matchAll(/(-?)(\d+(?:\.\d+)?)(\s*%)?/g)].map((m) => {
    const negative = m[1] === "-" && !/[\p{L}\p{N}]/u.test(norm[m.index - 1] ?? "");
    return { tok: negative ? `-${m[2]}` : m[2]!, pct: Boolean(m[3]), negative };
  });
}

export function extractNumbers(text: string): string[] {
  return numberTokens(text).map((t) => t.tok);
}

function numForms(token: string): string[] {
  const forms = new Set<string>([token]);
  const n = Number(token);
  if (!Number.isFinite(n)) return [...forms];
  forms.add(String(n));
  forms.add(n.toFixed(1));
  forms.add(String(Math.abs(n)));
  forms.add(Math.abs(n).toFixed(1));
  if (Number.isInteger(n)) forms.add(String(n));
  forms.add(token.replace(/^(-?)0+(?=\d)/, "$1"));
  return [...forms];
}

/**
 * The numbers a model may write about this input. A number is a percentage
 * fact when the input writes it with "%" or stores it under a *pct* key.
 */
export function buildAllowedSet(input: unknown): Set<string> {
  const allowed = new Set<string>();
  const add = (tok: string, pct: boolean) => {
    for (const f of numForms(tok)) {
      allowed.add(f);
      if (pct) allowed.add(PCT + f);
    }
  };
  const walk = (v: unknown, key: string) => {
    const pctKey = /pct|percent/i.test(key);
    if (typeof v === "number" && Number.isFinite(v)) add(String(v), pctKey);
    else if (typeof v === "string") numberTokens(v).forEach((t) => add(t.tok, t.pct || pctKey));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(input, "");
  for (const n of [1, 2, 3, 4, 5, 8.4, 2023, 2024, 2025, 2026]) add(String(n), false);
  return allowed;
}

/**
 * Numbers in the text that the input does not support; a "%" figure must be a
 * percentage fact. A negative figure must be negative in the input too: "-34%"
 * is refused when the input only has "34%", because the sign is the claim.
 */
export function validateNumbers(text: string, allowed: Set<string>): string[] {
  const bad: string[] = [];
  for (const { tok, pct, negative } of numberTokens(text)) {
    const forms = numForms(tok).filter((f) => !negative || f.startsWith("-"));
    if (!forms.some((f) => allowed.has(pct ? PCT + f : f))) bad.push(pct ? `${tok}%` : tok);
  }
  return [...new Set(bad)];
}

export function validateActions(gaps: Pick<Gap, "id" | "actionId" | "allowedActions">[]): string[] {
  const bad: string[] = [];
  for (const g of gaps) {
    if (!ACTION_LIBRARY[g.actionId]) bad.push(g.actionId);
    if (!g.allowedActions.includes(g.actionId)) bad.push(`${g.id}:${g.actionId}`);
  }
  return bad;
}

export function validateCitations(gaps: Pick<Gap, "id" | "sourceRefs">[]): string[] {
  return gaps.filter((g) => !g.sourceRefs.length || g.sourceRefs.some((c) => !c.file || !c.verbatim)).map((g) => g.id);
}

export type GapOrderRow = { gap_id: string; claude_rank: number; justification_en: string; justification_hi: string };

/**
 * What the model sees when it orders a Top N list: each gap's code rank, whether
 * it is a flag, a watchlist school or a Round 4 comparison school, and the code's
 * facts. Its numbers are the only numbers the justifications may use.
 */
export function gapOrderInput(gaps: (Pick<Gap, "id" | "codeRank" | "factEn" | "factHi" | "actionId"> & Partial<Pick<Gap, "gapKind">>)[], peerLine: string) {
  return {
    gaps: gaps.map((g) => ({
      id: g.id,
      code_rank: g.codeRank,
      kind: g.gapKind === "watchlist_control" ? "comparison_school" : g.codeRank <= DEFAULT_TOP_GAPS_LIMIT ? "flag" : "watchlist",
      fact_en: g.factEn,
      fact_hi: g.factHi,
      action_id: g.actionId,
    })),
    peer_line: peerLine,
  };
}

const NAMES_COMPARISON = { en: /comparison|round 4|\bR4\b/i, hi: /तुलना|राउंड 4|R4/ };

/**
 * The shape of a model's order: every given gap once, ranks 1..N with no ties, and
 * a reason for each Round 4 comparison school that says it is one, in both
 * languages, so no reason reads as a call for a camp there. "" when it holds.
 */
export function checkGapOrder(order: GapOrderRow[], ids: string[], comparisonIds: string[] = []): string {
  if (order.length !== ids.length) return "Gap count changed.";
  const got = new Set(order.map((o) => o.gap_id));
  if (got.size !== ids.length || ids.some((id) => !got.has(id))) return "Gap list changed.";
  const ranks = order.map((o) => o.claude_rank).sort((a, b) => a - b);
  if (ranks.some((n, i) => n !== i + 1)) return `Ranks must be 1 to ${ids.length} with no ties.`;
  if (order.some((o) => !o.justification_en?.trim() || !o.justification_hi?.trim())) return "A justification is empty.";
  const unnamed = order.filter((o) => comparisonIds.includes(o.gap_id) && !(NAMES_COMPARISON.en.test(o.justification_en) && NAMES_COMPARISON.hi.test(o.justification_hi)));
  if (unnamed.length) return `The reason for ${unnamed.map((o) => o.gap_id).join(", ")} must say it is a Round 4 comparison school, in English and Hindi.`;
  return "";
}

export function approveBlockers(task: Task): string[] {
  const missing: string[] = [];
  if (!task.ownerId) missing.push("owner_id");
  if (!task.dueDate) missing.push("due_date");
  else if (task.dueDate <= REVIEW_DATE) missing.push("due_date_after_review");
  if (!task.whatEn.trim() || !task.whatHi.trim()) missing.push("what");
  if (!task.successEn.trim()) missing.push("success_metric");
  if (!ACTION_LIBRARY[task.actionId]) missing.push("action_id");
  // A task that threatens or shames someone cannot be approved, whoever wrote it.
  if (!validateAppropriateContent(taskText(task)).ok) missing.push("tone");
  return [...new Set(missing)];
}

const taskText = (t: Task) => [t.whatEn, t.whatHi, t.successEn, t.successHi, t.note, t.noteHi].filter(Boolean).join("\n");

export type GuardResult = { ok: boolean; reason: "INAPPROPRIATE_OR_PUNITIVE_TONE" | null; violations: string[] };

/**
 * Words a supportive review never uses about a teacher or a child. NIPUN
 * Bharat and Samagra Shiksha ask for supportive supervision: a gap is met with
 * a camp, a visit or a spot check, never with a threat, a slur or a label.
 * Each entry is a pattern and the name the officer sees when it is refused.
 */
const INAPPROPRIATE: [RegExp, string][] = [
  // Administrative threats.
  [/\bsuspen(d|ded|ding|sion)\b|\bsasp[ae]nd\b|\bnilambit\b|निलंबित|निलम्बित/i, "suspension"],
  [/\bterminat(e|ed|ion)\b|\bbarkhast\b|बर्खास्त/i, "termination"],
  [/\bfire\s+(the\s+|this\s+|that\s+)?(teacher|hm|headmaster|head\s*teacher|crcc|staff|him|her|them)\b|\bnaukri\s+se\s+nikal|नौकरी\s+से\s+निकाल/i, "dismissal"],
  [/\b(salary|pay)\s+cut\b|\bcut\s+(his\s+|her\s+|their\s+|the\s+)?(salary|pay)\b|\bdock\s+(his\s+|her\s+|their\s+|the\s+)?pay\b|\bwithhold\s+(his\s+|her\s+|their\s+|the\s+)?salary\b|\bvetan\s+(roko|kato|kaat\w*|band)\b|वेतन\s+(काट|रोक)/i, "salary cut"],
  [/\bshow[\s-]*cause\b|कारण\s+बताओ\s+नोटिस/i, "show-cause notice"],
  [/\bpunish\w*|\bsaza\s+do\b|सज़ा\s+दो|सजा\s+दो|दंडित/i, "punishment"],
  [/\bpublic(ly)?\s+sham\w*|\bname\s+and\s+shame\b/i, "public shaming"],
  // Labels for children and staff.
  [/\b(dumb|stupid|idiot\w*|hopeless|useless|worthless)\b/i, "derogatory label"],
  [/\b(nalayak|bewakoof|bevkoof|gadh[ae]|kaamchor|nikamm[ae])\b|नालायक|बेवकूफ़?|गधे|गधा|कामचोर|निकम्म/i, "derogatory label (Hindi)"],
  // Discrimination and abuse.
  [/\buntouchable\b|\bachhoot\b|अछूत|\blow[\s-]*caste\b|\bneech\s+jaa?ti\b|नीच\s+जाति/i, "caste slur"],
  [/\bgirls?\s+(can'?t|cannot|don'?t|do\s+not)\s+(do|learn)\s+maths?\b/i, "gender bias"],
  [/\b(bastard|chutiya|harami|kamina)\b/i, "profanity"],
];

/**
 * Refuses punitive, shaming, discriminatory or profane text. Used on every
 * model output (the Laya second check), on every outbound message (the
 * fact-check) and on every task before it can be approved.
 */
export function validateAppropriateContent(text: string): GuardResult {
  const violations = INAPPROPRIATE.filter(([re]) => re.test(text)).map(([, name]) => name);
  return violations.length ? { ok: false, reason: "INAPPROPRIATE_OR_PUNITIVE_TONE", violations } : { ok: true, reason: null, violations: [] };
}

/**
 * Instructions hidden in data. A visit note, a school name, a voice note or a
 * field reply is untrusted text, and some of it ends up in a model prompt. Each
 * pattern found is cut out and named, before the text goes anywhere near a
 * prompt.
 */
const INJECTION: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system|original)\s+(instructions?|rules?|prompts?|directions?|messages?)/gi, "ignore previous instructions"],
  [/\b(reveal|show|print|output|repeat|display|leak)\s+(me\s+)?(the\s+|your\s+)?(system|hidden|developer|original)\s+(prompt|instructions?|message)/gi, "reveal the system prompt"],
  [/\byou\s+are\s+now\b|\bfrom\s+now\s+on\s+you\b|\bact\s+as\s+(an?\s+)?(admin|system|developer)\b/gi, "role override"],
  [/\b(jailbreak|DAN\s+mode|developer\s+mode)\b/gi, "jailbreak"],
  [/\b(mark|set|make|report)\s+(all|every)\s+(schools?|tasks?)\s+(as\s+)?(100\s*%|done|pass(ed)?|complete)/gi, "bulk outcome instruction"],
  [/\b(pichl[ae]|purane|upar\s+wale)\s+(sabhi\s+|saare\s+)?(nirdesh|instructions?|niyam)\s+(ko\s+)?(ignore|bhool|chhod|nazarandaz)\w*/gi, "ignore previous instructions (Hinglish)"],
  [/(पिछले|पुराने|ऊपर\s+के)\s+(सभी\s+|सारे\s+)?(निर्देश|निर्देशों|नियम|नियमों)\s+(को\s+)?(अनदेखा|भूल|छोड़|नज़रअंदाज़|नजरअंदाज)/g, "ignore previous instructions (Hindi)"],
  [/<\s*\/?\s*(script|iframe|object|embed)\b[^>]*>?/gi, "script tag"],
  [/javascript\s*:/gi, "javascript: link"],
  [/\bon(error|load|click|mouseover)\s*=/gi, "HTML event handler"],
  [/\b(drop|truncate)\s+table\b|\bunion\s+select\b|;\s*--/gi, "SQL injection"],
];

/** Cuts every injection pattern out of untrusted text; `safe` is false when anything was found. */
export function scanPromptInjection(text: string): { safe: boolean; sanitized: string; detections: string[] } {
  let sanitized = text;
  const detections: string[] = [];
  for (const [re, name] of INJECTION) {
    re.lastIndex = 0;
    if (!re.test(sanitized)) continue;
    re.lastIndex = 0;
    sanitized = sanitized.replace(re, "[removed]");
    detections.push(name);
  }
  return { safe: detections.length === 0, sanitized, detections };
}

export function dispatchBlockReason(task: Task, lang: "en" | "hi" = "en"): string | null {
  const hi = lang === "hi";
  if (task.status !== "approved") return hi ? `स्थिति ${task.status} है, अनुमोदित नहीं` : `status is ${task.status}, not approved`;
  if (!task.approvedBy || !task.approvedAt) return hi ? "अनुमोदक खाली है" : "approver is empty";
  if (!task.whatEn.trim() || !task.whatHi.trim()) return hi ? "कार्य विवरण खाली है" : "action text is empty";
  if (!task.ownerId) return hi ? "जिम्मेदार खाली है" : "owner is empty";
  if (!task.dueDate) return hi ? "अंतिम तिथि खाली है" : "due date is empty";
  if (task.dueDate <= REVIEW_DATE) return hi ? "अंतिम तिथि समीक्षा तिथि के बाद नहीं है" : "due date is not after the review date";
  if (!task.successEn.trim()) return hi ? "सफलता मापदंड खाली है" : "success measure is empty";
  return null;
}
