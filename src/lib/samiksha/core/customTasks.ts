/**
 * Draft tasks from a BEO note that is not the seeded demo note. Rules only:
 * a sentence becomes a draft when it names a school or cluster on the roster and
 * a library action. Owners and dates are taken only when the note says them.
 */
import { ACTION_LIBRARY, REVIEW_DATE, devToAscii, type ActionId } from "./config";
import { isWatchlistGap } from "./gaps";
import type { Cycle, Gap, Person, SchoolRow, Task } from "./model";

type CycleIn = Pick<Cycle, "gaps" | "people" | "schools">;

const MONTHS: [string, number][] = [
  ["january|jan|जनवरी", 1], ["february|feb|फ़रवरी|फरवरी", 2], ["march|mar|मार्च", 3], ["april|apr|अप्रैल", 4],
  ["may|मई", 5], ["june|jun|जून", 6], ["july|jul|जुलाई", 7], ["august|aug|अगस्त", 8],
  ["september|sept|sep|सितंबर|सितम्बर", 9], ["october|oct|अक्टूबर|अक्तूबर", 10], ["november|nov|नवंबर|नवम्बर", 11], ["december|dec|दिसंबर|दिसम्बर", 12],
];
const SPOKEN = new RegExp(
  String.raw`(\d{1,2})?\s*(?:st|nd|rd|th)?\s*(?:of\s+)?(?<![a-z])(${MONTHS.map(([m]) => m).join("|")})(?![a-z])\.?\s*(\d{1,2}(?!\d))?(?:,?\s*(20\d{2}))?`,
  "i",
);

function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * A due date the text states: 2026-01-10, 10/01/2026 (day first), or a spoken date in
 * English or Hindi ("10 January 2026", "January 10", "10 जनवरी"). A date without a
 * year is the next one after `after`. Dates on or before `after` are not due dates.
 */
export function parseDueDate(text: string, after = REVIEW_DATE): string | null {
  const t = devToAscii(text);
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const dmy = t.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/);
  const spoken = t.match(SPOKEN);
  let date: string | null = null;
  if (iso) date = isoDate(+iso[1]!, +iso[2]!, +iso[3]!);
  else if (dmy) date = isoDate(+dmy[3]!, +dmy[2]!, +dmy[1]!);
  else if (spoken && (spoken[1] || spoken[3])) {
    const month = MONTHS.find(([alts]) => new RegExp(`^(?:${alts})$`, "i").test(spoken[2]!))![1];
    const day = Number(spoken[1] ?? spoken[3]);
    const year = spoken[4] ? Number(spoken[4]) : Number(after.slice(0, 4));
    date = isoDate(year, month, day);
    if (date && !spoken[4] && date <= after) date = isoDate(year + 1, month, day);
  }
  return date && date > after ? date : null;
}

const ACTION_CUES: [ActionId, RegExp][] = [
  ["vacancy", /vacan|redeploy|teacher post|रिक्त|पुनर्नियोजन/i],
  ["data_check", /spot[\s-]?check|re-?verif|re-?test|औचक|पुनः सत्यापन/i],
  ["tarl", /\btarl\b|camp|remedial|कैंप|शिविर/i],
  ["attendance", /attendance|\bsmc\b|parent|उपस्थिति|अभिभावक/i],
  ["no_visit", /observ|visit|अवलोकन|भ्रमण/i],
];

export type Target = { codes: string[]; label: string; labelHi: string; school: SchoolRow | null };

const bare = (name: string) => name.replace(/^(?:PS|प्रा\.शा\.)\s*/i, "").trim().toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const mentions = (text: string, name: string) => name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{M}])${escapeRe(name)}(?![\\p{L}\\p{M}])`, "u").test(text);

/** The school or cluster a sentence (or a model's target string) names, if it is on the roster. */
export function resolveTarget(text: string, schools: SchoolRow[]): Target | null {
  const t = text.toLowerCase();
  const named = schools
    .filter((s) => mentions(t, bare(s.nameEn)) || mentions(t, bare(s.nameHi)))
    .sort((a, b) => bare(b.nameEn).length - bare(a.nameEn).length)[0];
  if (named) return { codes: [named.code], label: `${named.nameEn} (Cluster ${named.cluster})`, labelHi: `${named.nameHi} (क्लस्टर ${named.cluster})`, school: named };
  const cluster = devToAscii(t).match(/(?:cluster|क्लस्टर)\s*(?:c|सी)?\s*-?\s*(\d{1,2})/i)?.[1];
  const members = cluster ? schools.filter((s) => s.cluster === `C${cluster}`) : [];
  if (!members.length) return null;
  return { codes: members.map((s) => s.code), label: `Cluster C${cluster} (${members.length} schools)`, labelHi: `क्लस्टर C${cluster} (${members.length} विद्यालय)`, school: null };
}

/** The owner a sentence names: a CRCC by cluster, the DEO, or the target school's HM. */
function namedOwner(sentence: string, people: Person[], target: Target): string | null {
  const t = devToAscii(sentence);
  const crcc = t.match(/(?:crcc|सीआरसीसी)\s*(?:c|सी)?\s*-?\s*(\d{1,2})/i)?.[1];
  if (crcc) return people.find((p) => p.id === `crcc-${crcc}`)?.id ?? null;
  if (/\bdeo\b|डीईओ/i.test(t)) return people.find((p) => p.role === "DEO")?.id ?? null;
  if (/\bhm\b|head\s*(?:teacher|master)|प्रधानाध्यापक|हेडमास्टर/i.test(t) && target.school) {
    return people.find((p) => p.id === `hm-${target.school!.code}`)?.id ?? null;
  }
  return null;
}

/** A draft for one target and action. Missing owner or date stays missing and locks approval. */
export function customDraft(input: {
  id: number;
  gaps: Gap[];
  target: Target;
  actionId: ActionId;
  ownerId: string | null;
  dueDate: string | null;
  what: [string, string];
  note?: [string, string];
}): Task {
  const { target, actionId, ownerId, dueDate } = input;
  const gap = input.gaps.find((g) => g.targetCodes.some((c) => target.codes.includes(c)) && g.allowedActions.includes(actionId));
  const action = ACTION_LIBRARY[actionId];
  return {
    id: input.id,
    gapId: gap?.id ?? "custom",
    actionId,
    whatEn: input.what[0],
    whatHi: input.what[1],
    ownerId,
    targetLabel: target.label,
    targetLabelHi: target.labelHi,
    targetCodes: target.codes,
    dueDate,
    successEn: action.success_en,
    successHi: action.success_hi,
    status: "draft",
    missingFields: [...(dueDate ? [] : ["due_date"]), ...(ownerId ? [] : ["owner_id"])],
    approvedBy: null,
    approvedAt: null,
    completedAt: null,
    unitsDone: 0,
    note: input.note?.[0] ?? "",
    noteHi: input.note?.[1] ?? "",
  };
}

/** Watchlist drafts are numbered from #101, so the review note's numbering (#14 on) never shifts. */
export const WATCHLIST_TASK_NO_FROM = 101;

export type WatchlistDraftCheck = { ok: true } | { ok: false; existing: number | null; reason: { en: string; hi: string } };

/**
 * Whether the brief may draft a task for this watchlist gap. Core gaps are drafted
 * from the review note; a comparison school waits for Round 4, or the camp would
 * blur the scorecard's comparison.
 */
export function checkWatchlistDraft(gap: Gap, tasks: Task[], r4Loaded: boolean): WatchlistDraftCheck {
  const live = tasks.find((t) => t.gapId === gap.id && t.status !== "rejected" && t.status !== "cancelled");
  if (live) return { ok: false, existing: live.id, reason: { en: `Task #${live.id} already covers this gap.`, hi: `कार्य #${live.id} पहले से इस अंतर पर है।` } };
  if (!isWatchlistGap(gap)) {
    return { ok: false, existing: null, reason: { en: "Core gaps are drafted from the review note.", hi: "मुख्य अंतर समीक्षा नोट से ड्राफ्ट होते हैं।" } };
  }
  if (gap.gapKind === "watchlist_control" && !r4Loaded) {
    return {
      ok: false,
      existing: null,
      reason: {
        en: "Comparison school for the Round 4 scorecard. Draft a task after Round 4 is joined.",
        hi: "राउंड 4 स्कोरकार्ड का तुलना विद्यालय। राउंड 4 जुड़ने के बाद कार्य बनाएँ।",
      },
    };
  }
  return { ok: true };
}

/** A draft for one watchlist gap. Owner and due date start empty, so approval stays locked until they are set. */
export function watchlistDraft(gap: Gap, id: number): Task {
  const action = ACTION_LIBRARY[gap.actionId];
  return customDraft({
    id,
    gaps: [gap],
    target: { codes: gap.targetCodes, label: gap.targetLabel, labelHi: gap.targetLabelHi, school: null },
    actionId: gap.actionId,
    ownerId: null,
    dueDate: null,
    what: [`${action.name_en} at ${gap.targetLabel}.`, `${gap.targetLabelHi}: ${action.name_hi}।`],
    note: [
      `Drafted from watchlist rank ${gap.codeRank}. Set the owner and due date before approval.`,
      `निगरानी क्रम ${gap.codeRank} से ड्राफ्ट। अनुमोदन से पहले जिम्मेदार और अंतिम तिथि भरें।`,
    ],
  });
}

/** One draft per sentence that names a roster school or cluster and a library action. */
export function extractCustomTasks(transcript: string, cycle: CycleIn, firstId = 14): Task[] {
  const tasks: Task[] = [];
  for (const sentence of transcript.split(/(?<=[.।;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    const target = resolveTarget(sentence, cycle.schools);
    const actionId = ACTION_CUES.find(([, re]) => re.test(sentence))?.[0];
    if (!target || !actionId) continue;
    const named = namedOwner(sentence, cycle.people, target);
    // Vacancies belong to the DEO by the action library, so that one owner is a rule, not a guess.
    const libraryOwner = !named && actionId === "vacancy" ? (cycle.people.find((p) => p.role === "DEO")?.id ?? null) : null;
    tasks.push(customDraft({
      id: firstId + tasks.length,
      gaps: cycle.gaps,
      target,
      actionId,
      ownerId: named ?? libraryOwner,
      dueDate: parseDueDate(sentence),
      what: [sentence.slice(0, 240), sentence.slice(0, 240)],
      note: libraryOwner
        ? ["Owner set by the action library: the DEO owns vacancy requests.", "जिम्मेदार कार्य सूची से: रिक्ति प्रस्ताव DEO के पास जाते हैं।"]
        : undefined,
    }));
  }
  return tasks;
}
