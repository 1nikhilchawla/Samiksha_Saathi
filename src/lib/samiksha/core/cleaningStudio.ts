/**
 * Data-cleaning studio: every change the reader made (before -> after, with file
 * and row), plus officer-written rules in English, Hindi or Hinglish. A rule is
 * compiled into a small CleaningAst, cheapest reader first: fixed patterns, then
 * shorthand ("att < 65", "teacher nahi", "100 wale"), then, only when the
 * officer asks, a bounded model that must answer in the same AST. The AST is the
 * only thing applied, so no reader ever writes a number into the table. Rules
 * change a preview or a working copy and its CSV export; the brief and the
 * Slide 3 numbers always stay on the canonical data.
 */
import { devToAscii } from "./config";
import type { Cycle, SchoolRow } from "./model";

type Copy = { en: string; hi: string };

export type BeforeAfterRow = { file: string; row: number | null; before: string; after: string; rule: Copy };

const PROBLEM_AFTER: Record<string, Copy> = {
  duplicate: { en: "Deduplicated (first row kept)", hi: "दोहरी पंक्ति हटाई (पहली रखी)" },
  unknown_code: { en: "Row dropped (code not in UDISE+)", hi: "पंक्ति हटाई (कोड UDISE+ में नहीं)" },
  missing_value: { en: "Flagged, not filled with zero", hi: "चिह्नित, शून्य से नहीं भरा" },
  impossible_value: { en: "Rejected: impossible, kept out of the mean", hi: "अस्वीकृत: असंभव, औसत से बाहर" },
  suspicious_100: { en: "Flagged for a BRC spot check", hi: "BRC औचक जाँच हेतु चिह्नित" },
};

/** The reader's changes on this cycle, in file order: header renames, fixed values, then flagged problems. */
export function buildCleaningPreview(cycle: Pick<Cycle, "fixes" | "problems" | "headerMaps">): BeforeAfterRow[] {
  const headers = cycle.headerMaps.map((m) => ({
    file: m.file, row: 1, before: m.from, after: m.to, rule: { en: "Column name mapped", hi: "कॉलम नाम मैप" },
  }));
  const fixes = cycle.fixes.map((f) => ({
    file: f.sourceFile, row: f.sourceRow, before: f.rawValue, after: f.fixedValue,
    rule: f.issueType === "state_scale_normalized"
      ? { en: "State score scale converted", hi: "राज्य अंक पैमाना बदला" }
      : f.issueType === "cleaning_rule_committed"
        ? { en: "Officer cleaning rule, committed", hi: "अधिकारी का सफाई नियम, कमिट" }
        : { en: "School code normalised", hi: "विद्यालय कोड सुधारा" },
  }));
  const problems = cycle.problems.map((p) => ({
    file: p.sourceFile, row: p.sourceRow,
    before: p.issueType === "impossible_value" ? `${p.rawValue}%` : p.rawValue || "(blank)",
    after: (PROBLEM_AFTER[p.issueType] ?? { en: p.descriptionEn, hi: p.descriptionHi }).en,
    rule: { en: p.descriptionEn, hi: p.descriptionHi },
  }));
  return [...headers, ...fixes, ...problems];
}

export type CleaningRule = { id: string; label: Copy; instruction: string };

export const SUGGESTED_CLEANING_RULES: CleaningRule[] = [
  {
    id: "attendance",
    label: { en: "Flag low attendance, preview cluster-mean fill (Hinglish)", hi: "कम उपस्थिति चिह्नित, क्लस्टर औसत से भरना (हिंग्लिश)" },
    instruction: "jin schools me attendance 65% se kam hai unko flag karo aur missing attendance ko cluster mean se fill karo",
  },
  {
    id: "cap",
    label: { en: "Cap scores above 100, trim names (English)", hi: "100 से ऊपर अंक सीमित, नाम साफ (अंग्रेज़ी)" },
    instruction: "cap any score above 100 at 100 and trim extra spaces in school names",
  },
  {
    id: "vacancy",
    label: { en: "Vacant maths post and low R3 (Hindi)", hi: "रिक्त गणित पद व कम R3 (हिन्दी)" },
    instruction: "जिन स्कूलों में गणित शिक्षक रिक्त है और R3 < 40% है उन्हें उच्च प्राथमिकता में चिह्नित करें",
  },
  {
    id: "drop",
    label: { en: "R2 to R3 drop of more than 6 points (English)", hi: "R2 से R3 में 6 अंक से अधिक गिरावट (अंग्रेज़ी)" },
    instruction: "flag schools where R2 to R3 drop is more than 6 points",
  },
  {
    id: "shorthand",
    label: { en: "Shorthand: att < 60, highlight (Hinglish)", hi: "संक्षेप: att < 60, highlight (हिंग्लिश)" },
    instruction: "att < 60 wale highlight karo",
  },
];

/** Every rule compiles to this. Filters are ANDed into one flag; transforms change only the returned copy. */
export type CleaningAst = {
  attendanceBelow?: number;
  dropOver?: number;
  vacantMaths?: boolean;
  r3Below?: number;
  scoreAt100?: boolean;
  fillMissingAttendanceWithClusterMean?: boolean;
  capAt100?: boolean;
  trimNames?: boolean;
  highPriority?: boolean;
};

export type CleaningSource = "rules" | "shorthand" | "model" | "none";

export type CleaningDiff = { code: string; school: string; field: string; before: string; after: string; action: Copy };

export type CleaningResult = {
  understood: boolean;
  source: CleaningSource;
  ast: CleaningAst;
  ruleSummaryEn: string;
  ruleSummaryHi: string;
  matchedSchoolsCount: number;
  flaggedCodes: string[];
  previewDiffs: CleaningDiff[];
  updatedSchools: SchoolRow[];
  /** Wall time to read and apply the rule on this device. */
  runtimeMs: number;
};

const LOWER = /(kam|below|less|under|<|neeche|नीचे|से कम|कम)/;
/** The first threshold in a clause, skipping round and cluster names (R3, C6) so "R3 < 40" reads 40. */
const firstNumber = (s: string) => {
  const m = s.replace(/\b[rc]-?\d+\b/g, " ").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 10) / 10}%`);
const SCORE_FIELDS = ["y1", "y2", "r1", "r2", "r3", "r4"] as const;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Tier 1: fixed patterns over English, Hindi and Hinglish clauses. The verb does
 * not matter (flag, highlight, mark, filter and चिह्नित all flag): the subject and
 * the threshold decide the filter.
 */
export function parseCleaningRule(instruction: string): CleaningAst {
  const text = devToAscii(instruction).toLowerCase();
  const ast: CleaningAst = {};
  for (const c of text.split(/\s+(?:and|aur|और|tatha|तथा)\s+|[;,]/).map((x) => x.trim()).filter(Boolean)) {
    const n = firstNumber(c);
    const fill = /(fill|impute|bhar|भर)/.test(c) && /(mean|average|avg|औसत|cluster|क्लस्टर)/.test(c);
    if (fill) ast.fillMissingAttendanceWithClusterMean = true;
    if (/(cap|limit|100 se (?:zyada|upar|adhik)|above 100|100 से (?:अधिक|ऊपर))/.test(c)) ast.capAt100 = true;
    if (/(trim|extra space|spaces|स्पेस)/.test(c)) ast.trimNames = true;
    if (!fill && /(attendance|उपस्थिति|hajri|हाजिरी)/.test(c) && n !== null && LOWER.test(c)) ast.attendanceBelow = n;
    if (/(drop|गिरावट|gir|fall|decline)/.test(c) && n !== null) ast.dropOver = n;
    if (/(vacan|रिक्त|khali|खाली)/.test(c)) ast.vacantMaths = true;
    if (/\br3\b/.test(c) && !/(drop|गिरावट)/.test(c) && n !== null && LOWER.test(c)) ast.r3Below = n;
  }
  if (/(priority|प्राथमिकता|high|उच्च)/.test(text)) ast.highPriority = true;
  return ast;
}

const SHORTHAND: [RegExp, string][] = [
  [/\b(?:att|attnd|attend|haziri)\b/g, "attendance"],
  [/\b(?:avg|av)\b/g, "average"],
  [/\b(?:teacher|shikshak|post)\s+(?:nahi|nahin|missing|none)\b/g, "vacant"],
  [/\bgirawat\b|\bgira\b/g, "drop"],
];

/** Tier 2: shorthand and loose phrasing rewritten into tier-1 words, plus "100 wale" (a round reported at 100%). */
export function parseShorthandRule(instruction: string): CleaningAst {
  const low = devToAscii(instruction).toLowerCase();
  let text = low;
  for (const [re, to] of SHORTHAND) text = text.replace(re, to);
  const ast = parseCleaningRule(text);
  if (/\b100\s*%?\s*(?:wale|vale|waale)\b|\bscored?\s*100\b|100 वाले/.test(low)) {
    ast.scoreAt100 = true;
    delete ast.capAt100;
  }
  return ast;
}

const hasRule = (a: CleaningAst) =>
  a.attendanceBelow !== undefined || a.dropOver !== undefined || a.r3Below !== undefined ||
  Boolean(a.vacantMaths || a.scoreAt100 || a.fillMissingAttendanceWithClusterMean || a.capAt100 || a.trimNames);

/** Keep only fields of the AST shape with sane values; anything else (from a model) is dropped. */
export function sanitizeCleaningAst(raw: unknown): CleaningAst {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined);
  const flag = (v: unknown) => (v === true ? true : undefined);
  const ast: CleaningAst = {
    attendanceBelow: num(r.attendanceBelow),
    dropOver: num(r.dropOver),
    vacantMaths: flag(r.vacantMaths),
    r3Below: num(r.r3Below),
    scoreAt100: flag(r.scoreAt100),
    fillMissingAttendanceWithClusterMean: flag(r.fillMissingAttendanceWithClusterMean),
    capAt100: flag(r.capAt100),
    trimNames: flag(r.trimNames),
    highPriority: flag(r.highPriority),
  };
  return Object.fromEntries(Object.entries(ast).filter(([, v]) => v !== undefined)) as CleaningAst;
}

/** Apply a compiled rule to a copy of the schools. */
export function applyCleaningAst(ast: CleaningAst, schools: SchoolRow[], source: CleaningSource, startedAt = now()): CleaningResult {
  const a = ast;
  const filters: { en: string; hi: string; test: (s: SchoolRow) => boolean }[] = [];
  if (a.attendanceBelow !== undefined) {
    const n = a.attendanceBelow;
    filters.push({ en: `Oct–Nov attendance below ${n}%`, hi: `अक्टूबर–नवम्बर उपस्थिति ${n}% से कम`, test: (s) => s.octNov !== null && s.octNov < n });
  }
  if (a.dropOver !== undefined) {
    const n = a.dropOver;
    filters.push({ en: `R2→R3 drop of more than ${n} pts`, hi: `R2→R3 में ${n} अंक से अधिक गिरावट`, test: (s) => s.r2 !== null && s.r3 !== null && s.r2 - s.r3 > n });
  }
  if (a.vacantMaths) filters.push({ en: "maths post vacant", hi: "गणित पद रिक्त", test: (s) => s.mathsPost === "Vacant" });
  if (a.r3Below !== undefined) {
    const n = a.r3Below;
    filters.push({ en: `R3 below ${n}%`, hi: `R3 ${n}% से कम`, test: (s) => s.r3 !== null && s.r3 < n });
  }
  if (a.scoreAt100) filters.push({ en: "a round reported at 100%", hi: "किसी चक्र में 100% बताया", test: (s) => [s.r1, s.r2, s.r3].some((v) => v === 100) });

  const diffs: CleaningDiff[] = [];
  const updated = schools.map((s) => ({ ...s }));
  const flagged = filters.length ? updated.filter((s) => filters.every((f) => f.test(s))) : [];
  for (const s of flagged) {
    diffs.push({
      code: s.code, school: s.nameEn, field: "flag", before: "", after: a.highPriority ? "high priority" : "flagged",
      action: { en: filters.map((f) => f.en).join(" + "), hi: filters.map((f) => f.hi).join(" + ") },
    });
  }
  if (a.fillMissingAttendanceWithClusterMean) {
    const means = new Map<string, number>();
    for (const cluster of new Set(updated.map((s) => s.cluster))) {
      const vals = updated.filter((s) => s.cluster === cluster && s.octNov !== null).map((s) => s.octNov!);
      if (vals.length) means.set(cluster, vals.reduce((x, v) => x + v, 0) / vals.length);
    }
    for (const s of updated) {
      if (s.octNov !== null || !means.has(s.cluster)) continue;
      const m = Math.round(means.get(s.cluster)! * 10) / 10;
      diffs.push({ code: s.code, school: s.nameEn, field: "octNov", before: "blank", after: pct(m), action: { en: `Cluster ${s.cluster} mean (preview only)`, hi: `क्लस्टर ${s.cluster} औसत (केवल पूर्वावलोकन)` } });
      s.octNov = m;
    }
  }
  if (a.capAt100) {
    for (const s of updated) {
      for (const f of SCORE_FIELDS) {
        const v = s[f];
        if (v === null || v <= 100) continue;
        diffs.push({ code: s.code, school: s.nameEn, field: f, before: pct(v), after: "100%", action: { en: "Capped at 100", hi: "100 पर सीमित" } });
        s[f] = 100;
      }
    }
  }
  if (a.trimNames) {
    for (const s of updated) {
      const clean = s.nameEn.replace(/\s+/g, " ").trim();
      if (clean === s.nameEn) continue;
      diffs.push({ code: s.code, school: clean, field: "nameEn", before: JSON.stringify(s.nameEn), after: JSON.stringify(clean), action: { en: "Spaces trimmed", hi: "स्पेस हटाए" } });
      s.nameEn = clean;
    }
  }

  const understood = hasRule(a);
  const parts: Copy[] = [];
  if (filters.length) parts.push({ en: `flag schools with ${filters.map((f) => f.en).join(" and ")}`, hi: `${filters.map((f) => f.hi).join(" और ")} वाले विद्यालय चिह्नित` });
  if (a.fillMissingAttendanceWithClusterMean) parts.push({ en: "fill missing Oct–Nov attendance with the cluster mean (preview)", hi: "खाली अक्टूबर–नवम्बर उपस्थिति को क्लस्टर औसत से भरना (पूर्वावलोकन)" });
  if (a.capAt100) parts.push({ en: "cap scores above 100 at 100", hi: "100 से ऊपर के अंक 100 पर सीमित" });
  if (a.trimNames) parts.push({ en: "trim extra spaces in school names", hi: "विद्यालय नामों से अतिरिक्त स्पेस हटाना" });
  const matched = new Set(diffs.map((d) => d.code)).size;
  const by: Record<CleaningSource, Copy> = {
    rules: { en: "fixed patterns", hi: "तय पैटर्न" },
    shorthand: { en: "the shorthand reader", hi: "संक्षेप रीडर" },
    model: { en: "the bounded model, checked against the rule shape", hi: "सीमित मॉडल, नियम ढाँचे से जाँचा" },
    none: { en: "nothing", hi: "कुछ नहीं" },
  };
  return {
    understood,
    source: understood ? source : "none",
    ast: a,
    ruleSummaryEn: understood
      ? `Rule read by ${by[source].en} as: ${parts.map((p) => p.en).join("; ")}. ${matched} school${matched === 1 ? "" : "s"} affected.`
      : "Rule not understood. Try a threshold on attendance, an R2→R3 drop, R3, a vacant post, a reported 100%, a cluster-mean fill, a cap at 100 or trimming names.",
    ruleSummaryHi: understood
      ? `नियम ${by[source].hi} से समझा गया: ${parts.map((p) => p.hi).join("; ")}। ${matched} विद्यालय प्रभावित।`
      : "नियम समझ नहीं आया। उपस्थिति, R2→R3 गिरावट, R3, रिक्त पद, 100% रिपोर्ट, क्लस्टर औसत, 100 पर सीमा या नाम साफ करने का नियम लिखें।",
    matchedSchoolsCount: matched,
    flaggedCodes: flagged.map((s) => s.code),
    previewDiffs: diffs,
    updatedSchools: updated,
    runtimeMs: Math.round((now() - startedAt) * 1000) / 1000,
  };
}

/** Tiers 1 and 2, synchronous and on this device: fixed patterns, then shorthand. */
export function parseAndApplyCustomCleaningRule(instruction: string, schools: SchoolRow[]): CleaningResult {
  const t0 = now();
  const rules = parseCleaningRule(instruction);
  if (hasRule(rules)) return applyCleaningAst(rules, schools, "rules", t0);
  return applyCleaningAst(parseShorthandRule(instruction), schools, "shorthand", t0);
}

/**
 * All three tiers. `askModel` is the bounded model call (a server function that
 * returns an AST or null); it runs only when the local tiers fail, and whatever it
 * returns is sanitised to the AST shape before it touches the table.
 */
export async function compileRuleWithLlmFallback(
  instruction: string,
  schools: SchoolRow[],
  askModel?: (instruction: string) => Promise<unknown>,
): Promise<CleaningResult> {
  const local = parseAndApplyCustomCleaningRule(instruction, schools);
  if (local.understood || !askModel) return local;
  const answer = await askModel(instruction).catch(() => null);
  return applyCleaningAst(sanitizeCleaningAst(answer), schools, "model");
}

/** Joined school table as CSV, with an optional flag column, for the cleaned export. */
export function schoolsToCsv(schools: SchoolRow[], flagged: string[] = []): string {
  const flags = new Set(flagged);
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["school_code", "school_name_en", "cluster", "maths_teacher_post", "y1_2023_24", "y2_2024_25", "r1", "r2", "r3", "oct_nov_attendance_pct", "flag"];
  const rows = schools.map((s) => [s.code, s.nameEn, s.cluster, s.mathsPost, s.y1, s.y2, s.r1, s.r2, s.r3, s.octNov, flags.has(s.code) ? "flagged" : ""].map(cell).join(","));
  return `${head.join(",")}\n${rows.join("\n")}\n`;
}
