/**
 * The last gate before Telegram: every outbound message is checked against the
 * cycle before it may enter the queue. Numbers must come from the cycle, its
 * tasks or the scorecard; a "PS ..." school name must be on the roster; dates
 * must be a task's due date or today; a task card must be for an approved,
 * complete task whose action is in the library and whose gap still cites its
 * source rows. Every check is a fixed rule, so `confidence` is simply the
 * share of checks that passed.
 */
import { ACTION_LIBRARY } from "./config";
import { buildAllowedSet, dispatchBlockReason, validateActions, validateAppropriateContent, validateCitations, validateNumbers } from "./guards";

/** Telegram's own limit for one message. */
export const TELEGRAM_MAX_CHARS = 4096;
import type { Cycle, Task } from "./model";
import type { Scorecard } from "./scorecard";

type Copy = { en: string; hi: string };

export type OutboundKind = "task_card" | "nudge" | "weekly_digest" | "deo_escalation" | "appreciation" | "why_diagnostic" | "system_reply";

export type FactCheckResult = {
  passed: boolean;
  checks: { id: string; pass: boolean; detail: string }[];
  problems: Copy[];
  confidence: number;
  checkedAt: string;
};

export type FactCheckContext = {
  cycle: Pick<Cycle, "schools" | "people" | "gaps" | "summary" | "peer"> & Partial<Pick<Cycle, "allRankedGaps">>;
  tasks: Task[];
  score?: Scorecard | null;
  simToday: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The ways a message writes a date: 2025-12-20 and 20 Dec 2025. */
const dateForms = (iso: string) => [iso, `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`];
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
/** Template numbers: 09:00 reminders and the daily message cap. */
const CONSTANTS = [0, 9, 30];

/**
 * `extraAllowed` is for a template's own fixed values (an appreciation card's
 * points), never for figures about schools.
 */
export function factCheckOutboundMessage(
  input: { text: string; kind: OutboundKind; taskId?: number | null; extraAllowed?: number[] },
  ctx: FactCheckContext,
): FactCheckResult {
  const checks: FactCheckResult["checks"] = [];
  const problems: Copy[] = [];
  const fail = (id: string, detail: string, copy: Copy) => {
    checks.push({ id, pass: false, detail });
    problems.push(copy);
  };
  const pass = (id: string, detail: string) => checks.push({ id, pass: true, detail });

  // 1. Numbers: every figure must come from the cycle, the tasks or the scorecard.
  const s = ctx.cycle.schools;
  const allowed = buildAllowedSet({
    tasks: ctx.tasks,
    actions: Object.values(ACTION_LIBRARY),
    people: ctx.cycle.people,
    gaps: (ctx.cycle.allRankedGaps ?? ctx.cycle.gaps).map((g) => ({ fact: g.factEn, factHi: g.factHi, label: g.targetLabel })),
    summary: ctx.cycle.summary,
    peer: ctx.cycle.peer,
    score: ctx.score ?? null,
    scores_pct: s.map((x) => ({ y1_pct: x.y1, y2_pct: x.y2, r1_pct: x.r1, r2_pct: x.r2, r3_pct: x.r3, r4_pct: x.r4, oct_nov_pct: x.octNov, dec_att_pct: x.decAtt })),
    deltas: s.map((x) => [x.r2 !== null && x.r3 !== null ? x.r3 - x.r2 : null, x.r3 !== null && x.r4 !== null ? x.r4 - x.r3 : null]),
    clusters: s.map((x) => x.cluster),
    days_left: ctx.tasks.map((t) => (t.dueDate ? daysBetween(ctx.simToday, t.dueDate) : null)),
    today: ctx.simToday,
    // Counts of tasks, hinge points or schools in a list never exceed the cycle's own totals.
    counts: Array.from({ length: Math.max(ctx.tasks.length, 5) + 1 }, (_, i) => i),
    constants: [...CONSTANTS, ...(input.extraAllowed ?? [])],
  });
  const bad = validateNumbers(input.text, allowed);
  if (bad.length) fail("numbers", bad.join(", "), { en: `numbers not in the cycle: ${bad.join(", ")}`, hi: `चक्र में न मिलने वाले अंक: ${bad.join(", ")}` });
  else pass("numbers", "every number traced to the cycle");

  // 2. School names: any "PS ..." must be on the roster.
  const roster = new Set(s.map((x) => x.nameEn.toLowerCase()));
  const named = [...input.text.matchAll(/\bPS\s+[A-Z][A-Za-z]*/g)].map((m) => m[0]);
  const unknown = named.filter((n) => !roster.has(n.toLowerCase()));
  if (unknown.length) fail("schools", unknown.join(", "), { en: `schools not on the roster: ${unknown.join(", ")}`, hi: `रोस्टर में न मिलने वाले विद्यालय: ${unknown.join(", ")}` });
  else pass("schools", named.length ? `${named.length} school name(s) on the roster` : "no school named");

  // 3. Dates: only due dates of this cycle's tasks, or today.
  const task = input.taskId !== null && input.taskId !== undefined ? ctx.tasks.find((t) => t.id === input.taskId) : undefined;
  const scopeTasks = task ? [task] : ctx.tasks;
  const okDates = new Set([ctx.simToday, ...scopeTasks.map((t) => t.dueDate).filter((d): d is string => Boolean(d))].flatMap(dateForms));
  const dates = [...input.text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/g)].map((m) => m[0]);
  const wrongDates = dates.filter((d) => !okDates.has(d));
  if (wrongDates.length) fail("dates", wrongDates.join(", "), { en: `dates that are not a due date: ${wrongDates.join(", ")}`, hi: `ऐसी तिथियाँ जो अंतिम तिथि नहीं: ${wrongDates.join(", ")}` });
  else pass("dates", dates.length ? `${dates.length} date(s) match` : "no date");

  // 4. The task itself: it exists and is in a state this kind of message may speak for.
  if (input.taskId !== null && input.taskId !== undefined) {
    if (!task) {
      fail("task", `#${input.taskId} missing`, { en: `Task #${input.taskId} is not in this cycle`, hi: `कार्य #${input.taskId} इस चक्र में नहीं है` });
    } else {
      const reason = input.kind === "task_card"
        ? dispatchBlockReason(task)
        : input.kind === "nudge" && !["sent", "reminded", "partial"].includes(task.status)
          ? `status is ${task.status}, not waiting for a reply`
          : input.kind === "deo_escalation" && task.status !== "escalated"
            ? `status is ${task.status}, not escalated`
            : null;
      if (reason) fail("task", reason, { en: `Task #${task.id}: ${reason}`, hi: `कार्य #${task.id}: ${dispatchBlockReason(task, "hi") ?? reason}` });
      else pass("task", `Task #${task.id} is ${task.status}`);
      const owner = ctx.cycle.people.find((p) => p.id === task.ownerId);
      if (input.kind === "task_card" && owner && !input.text.includes(owner.nameEn) && !input.text.includes(owner.nameHi)) {
        fail("owner", owner.id, { en: `the owner ${owner.nameEn} is not named`, hi: `जिम्मेदार ${owner.nameHi} का नाम नहीं है` });
      } else if (input.kind === "task_card") pass("owner", owner ? owner.id : "no owner on the roster");

      // 5. The action and its evidence: a library action, and a data gap that still cites its source rows.
      // A task from the officer's own note has no data gap behind it; the note is its source.
      const gap = (ctx.cycle.allRankedGaps ?? ctx.cycle.gaps).find((g) => g.id === task.gapId);
      const badAction = validateActions([{ id: task.gapId, actionId: task.actionId, allowedActions: [task.actionId] }]);
      const badCitation = gap ? validateCitations([gap]) : [];
      if (badAction.length) {
        fail("action", `unknown action ${task.actionId}`, { en: `action "${task.actionId}" is not in the action library`, hi: `कार्य "${task.actionId}" कार्य सूची में नहीं है` });
      } else if (badCitation.length) {
        fail("action", `gap ${task.gapId} has no source citation`, { en: `the gap behind Task #${task.id} cites no source row`, hi: `कार्य #${task.id} के अंतर का कोई स्रोत नहीं` });
      } else {
        pass("action", gap ? `${task.actionId} in the library; gap cites ${gap.sourceRefs.length} source row(s)` : `${task.actionId} in the library; from the officer's note`);
      }
    }
  }

  // 6. Tone: no threat, slur or label reaches a teacher's phone.
  const tone = validateAppropriateContent(input.text);
  if (!tone.ok) {
    fail("tone", `INAPPROPRIATE_OR_PUNITIVE_TONE: ${tone.violations.join(", ")}`, { en: `INAPPROPRIATE_OR_PUNITIVE_TONE: ${tone.violations.join(", ")}`, hi: `अनुचित या दंडात्मक भाषा: ${tone.violations.join(", ")}` });
  } else pass("tone", "supportive, non-punitive wording");

  // 7. Size: Telegram refuses a message longer than 4,096 characters.
  if (input.text.length > TELEGRAM_MAX_CHARS) {
    fail("length", `${input.text.length} characters`, { en: `the message is ${input.text.length} characters; Telegram's limit is ${TELEGRAM_MAX_CHARS}`, hi: `संदेश ${input.text.length} अक्षर का है; टेलीग्राम की सीमा ${TELEGRAM_MAX_CHARS} है` });
  } else pass("length", `${input.text.length} characters`);

  const passed = problems.length === 0;
  return { passed, checks, problems, confidence: checks.length ? checks.filter((c) => c.pass).length / checks.length : 1, checkedAt: new Date().toISOString() };
}
