/**
 * A weekly to-do list for each officer level, and recognition for field staff
 * that rewards real outcomes, never paper ones. Points come only from this
 * cycle's tasks and the Round 4 scorecard, and only roster people appear:
 *   +50  a task closed on time (for camps, observations and drives, only once
 *        Round 4 shows the outcome moved);
 *   +100 Shiksha Setu Star: the camp school met the action library's target
 *        of +8 points in Round 4 (to the camp's owner and the school's HM);
 *   +60  Satya Data Guardian: a spot check closed on time that corrected an
 *        inflated score.
 * A "done" with a flat Round 4 earns nothing and gets a coaching note instead.
 */
import { ACTION_LIBRARY } from "./config";
import type { HingePoint } from "./hingePoints";
import type { Cycle, Person, Task } from "./model";
import { filterByRoleScope, type OfficerRole } from "./rbac";
import { isClosedOnTime, type Scorecard } from "./scorecard";

type Copy = { en: string; hi: string };

export const KARMA = { onTimeClosure: 50, learningGain: 100, dataGuardian: 60 } as const;
/** The action library's camp target: "raise the Grade 3 average by at least 8 points in R4". */
export const LEARNING_GAIN_TARGET = 8;
const OUTCOME_ACTIONS = new Set(["tarl", "no_visit", "attendance"]);

export type BadgeCode = "SHIKSHA_SETU_STAR" | "SATYA_DATA_GUARDIAN";
export const BADGES: Record<BadgeCode, Copy> = {
  SHIKSHA_SETU_STAR: { en: "Shiksha Setu Star", hi: "शिक्षा सेतु स्टार" },
  SATYA_DATA_GUARDIAN: { en: "Satya Data Guardian", hi: "सत्य डेटा रक्षक" },
};

export type RewardEntry = { taskNo: number; points: number; reason: Copy };

export type WorkerReward = {
  person: Person;
  points: number;
  badges: BadgeCode[];
  entries: RewardEntry[];
  /**
   * Rewards held back. `flat_done` is a "done" that Round 4 does not bear out:
   * a coaching note goes instead of points. `awaiting_r4` only waits for the
   * outcome, so nothing is sent.
   */
  held: { taskNo: number; reason: Copy; kind: "flat_done" | "awaiting_r4"; schools: string[] }[];
  /** On-time closures in a row, by due date. */
  streak: number;
};

export function computeWorkerRewards(cycle: Pick<Cycle, "people" | "schools">, tasks: Task[], score: Scorecard | null): WorkerReward[] {
  const byId = new Map<string, WorkerReward>();
  const get = (id: string | null) => {
    const p = cycle.people.find((x) => x.id === id);
    if (!p || p.role === "BEO" || p.role === "DEO") return null;
    if (!byId.has(p.id)) byId.set(p.id, { person: p, points: 0, badges: [], entries: [], held: [], streak: 0 });
    return byId.get(p.id)!;
  };
  const boxTicked = new Set((score?.boxTicks ?? []).map((b) => b.school));
  const schoolName = (code: string) => cycle.schools.find((s) => s.code === code)?.nameEn ?? code;

  for (const t of tasks) {
    const w = get(t.ownerId);
    if (!w || !isClosedOnTime(t)) continue;
    const flat = t.targetCodes.map(schoolName).filter((n) => boxTicked.has(n));
    if (flat.length) {
      w.held.push({
        taskNo: t.id,
        kind: "flat_done",
        schools: flat,
        reason: {
          en: `Task #${t.id} was marked done, but Round 4 shows no change at ${flat.join(", ")}. The reward is held until the outcome is verified.`,
          hi: `कार्य #${t.id} पूर्ण बताया गया, पर राउंड 4 में ${flat.join(", ")} में बदलाव नहीं। परिणाम सत्यापित होने तक पुरस्कार रोका गया।`,
        },
      });
      continue;
    }
    if (OUTCOME_ACTIONS.has(t.actionId) && !score) {
      w.held.push({ taskNo: t.id, kind: "awaiting_r4", schools: [], reason: { en: `Task #${t.id} closed on time; points wait for Round 4 to show the outcome.`, hi: `कार्य #${t.id} समय पर बंद; अंक राउंड 4 के परिणाम के बाद।` } });
      continue;
    }
    w.points += KARMA.onTimeClosure;
    w.entries.push({ taskNo: t.id, points: KARMA.onTimeClosure, reason: { en: `Task #${t.id} closed on time: ${ACTION_LIBRARY[t.actionId].name_en}.`, hi: `कार्य #${t.id} समय पर पूरा: ${ACTION_LIBRARY[t.actionId].name_hi}।` } });
  }

  if (score) {
    const khedi = cycle.schools.find((s) => s.kind === "khedi");
    const camp = tasks.find((t) => t.actionId === "tarl" && khedi && t.targetCodes.includes(khedi.code) && isClosedOnTime(t));
    if (khedi && camp && score.khedi.delta >= LEARNING_GAIN_TARGET) {
      const reason = {
        en: `${khedi.nameEn} rose ${score.khedi.delta.toFixed(1)} pts in Round 4 (${score.khedi.r3}% to ${score.khedi.r4}%), ${score.association.toFixed(1)} pts above matched schools.`,
        hi: `${khedi.nameHi} राउंड 4 में ${score.khedi.delta.toFixed(1)} अंक बढ़ा (${score.khedi.r3}% से ${score.khedi.r4}%), मिलान वाले विद्यालयों से ${score.association.toFixed(1)} अंक अधिक।`,
      };
      for (const id of new Set([camp.ownerId, `hm-${khedi.code}`])) {
        const w = get(id);
        if (!w) continue;
        w.points += KARMA.learningGain;
        w.badges.push("SHIKSHA_SETU_STAR");
        w.entries.push({ taskNo: camp.id, points: KARMA.learningGain, reason });
      }
    }
    const check = tasks.find((t) => t.actionId === "data_check" && isClosedOnTime(t));
    if (check && score.harangaon.from === 100 && score.harangaon.to < 100) {
      const w = get(check.ownerId);
      if (w) {
        w.points += KARMA.dataGuardian;
        w.badges.push("SATYA_DATA_GUARDIAN");
        w.entries.push({
          taskNo: check.id,
          points: KARMA.dataGuardian,
          reason: { en: `The spot check corrected a 100% score to ${score.harangaon.to}%.`, hi: `औचक जाँच ने 100% अंक को ${score.harangaon.to}% पर सुधारा।` },
        });
      }
    }
  }

  // A streak counts only closures that earned points; a held "done" breaks it.
  for (const w of byId.values()) {
    const earned = new Set(w.entries.map((e) => e.taskNo));
    const own = tasks.filter((t) => t.ownerId === w.person.id && t.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
    let run = 0;
    for (const t of own) run = earned.has(t.id) ? run + 1 : 0;
    w.streak = run;
  }
  return [...byId.values()].sort((a, b) => b.points - a.points || a.person.id.localeCompare(b.person.id));
}

/** The appreciation card, as it goes to the worker on Telegram (after the fact-check). */
export function formatAppreciationCard(w: WorkerReward, sender: { role: OfficerRole; name: string }, lang: "en" | "hi"): string {
  const hi = lang === "hi";
  const badges = w.badges.map((b) => BADGES[b][lang]).join(", ");
  return [
    hi ? `प्रशंसा पत्र · ${w.person.nameHi} (${w.person.role}, ${w.person.scope})` : `Appreciation · ${w.person.nameEn} (${w.person.role}, ${w.person.scope})`,
    ...w.entries.map((e) => `- ${e.reason[lang]} (+${e.points})`),
    badges ? (hi ? `सम्मान: ${badges}` : `Recognition: ${badges}`) : "",
    hi ? `कुल ${w.points} अंक · ${sender.name} (${sender.role}) की ओर से` : `${w.points} points in all · from ${sender.name} (${sender.role})`,
  ].filter(Boolean).join("\n");
}

/** The held "done" claims that call for a coaching note instead of points. */
export const coachingHolds = (w: WorkerReward) => w.held.filter((h) => h.kind === "flat_done");

/**
 * The coaching and re-verification note for a "done" that Round 4 did not bear
 * out. It names the task and the school, asks for the proof that would release
 * the reward, and blames no one: the point is the next visit, not the miss.
 */
export function formatCoachingCard(w: WorkerReward, sender: { role: OfficerRole; name: string }, lang: "en" | "hi"): string {
  const hi = lang === "hi";
  const holds = coachingHolds(w);
  return [
    hi ? `मार्गदर्शन नोट · ${w.person.nameHi} (${w.person.role}, ${w.person.scope})` : `Coaching note · ${w.person.nameEn} (${w.person.role}, ${w.person.scope})`,
    ...holds.map((h) => `- ${h.reason[lang]}`),
    hi
      ? "अगला कदम: कक्षा में गतिविधि दोबारा देखें, समूह फोटो के साथ उत्तर दें, और अगली जाँच में परिणाम दिखने पर अंक जुड़ेंगे।"
      : "Next step: look at the classroom activity again, reply with a group-activity photo, and the points follow once the next check shows the outcome.",
    hi ? `${sender.name} (${sender.role}) की ओर से` : `from ${sender.name} (${sender.role})`,
  ].join("\n");
}

export type TodoItem ={ id: string; text: Copy; done: boolean; source: "task" | "hinge" | "routine"; taskNo?: number };

/** This week's list for one officer level, from the tasks and hinge points it can see. */
export function buildOfficerTodoList(
  role: OfficerRole,
  cycle: Pick<Cycle, "schools" | "people">,
  tasks: Task[],
  points: HingePoint[],
  r4Loaded: boolean,
  simToday: string,
): TodoItem[] {
  const items: TodoItem[] = [];
  const scoped = filterByRoleScope(role, cycle, tasks).tasks;
  const open = (t: Task) => ["sent", "reminded", "partial", "overdue", "blocked"].includes(t.status);
  if (role === "CRCC" || role === "HM") {
    for (const t of scoped.filter((x) => x.status !== "draft" && x.status !== "rejected" && x.status !== "cancelled")) {
      items.push({
        id: `task-${t.id}`, source: "task", taskNo: t.id, done: t.status === "done" || t.status === "outcome_checked",
        text: { en: `Task #${t.id}: ${ACTION_LIBRARY[t.actionId].name_en}, by ${t.dueDate ?? "—"}; reply "done" with a group photo.`, hi: `कार्य #${t.id}: ${ACTION_LIBRARY[t.actionId].name_hi}, ${t.dueDate ?? "—"} तक; समूह फोटो के साथ "हो गया" लिखें।` },
      });
    }
    items.push({ id: "routine-reply", source: "routine", done: !scoped.some(open), text: { en: "Answer every open task card this week.", hi: "इस सप्ताह हर खुले कार्य कार्ड का उत्तर दें।" } });
    return items;
  }
  if (role === "BEO" || role === "SPD") {
    for (const p of points) items.push({ id: `hinge-${p.code}`, source: "hinge", done: false, text: { en: `Resolve ${p.code}: ${p.title.en}.`, hi: `${p.code} सुलझाएँ: ${p.title.hi}।` } });
    const drafts = tasks.filter((t) => t.status === "draft");
    items.push({ id: "approve-drafts", source: "task", done: drafts.length === 0 && tasks.length > 0, text: { en: drafts.length ? `Approve or reject ${drafts.length} draft task${drafts.length === 1 ? "" : "s"}.` : "Approve or reject the drafts from the review note.", hi: drafts.length ? `${drafts.length} ड्राफ्ट कार्य अनुमोदित या अस्वीकार करें।` : "समीक्षा नोट के ड्राफ्ट अनुमोदित या अस्वीकार करें।" } });
    const unsent = tasks.filter((t) => t.status === "approved");
    items.push({ id: "send-cards", source: "task", done: unsent.length === 0 && tasks.some((t) => t.status !== "draft"), text: { en: "Send the approved task cards.", hi: "अनुमोदित कार्य कार्ड भेजें।" } });
    items.push({ id: "weekly-digest", source: "routine", done: false, text: { en: "Send Monday's pending-task digest.", hi: "सोमवार का लंबित कार्य सारांश भेजें।" } });
    items.push({ id: "round-4", source: "routine", done: r4Loaded, text: { en: "Join the Round 4 results and check the scorecard.", hi: "राउंड 4 परिणाम जोड़ें और स्कोरकार्ड देखें।" } });
  }
  if (role === "DEO" || role === "SPD") {
    for (const t of tasks.filter((x) => x.status === "escalated" || (x.actionId === "vacancy" && x.approvedAt && x.status !== "done" && x.status !== "rejected"))) {
      items.push({
        id: `deo-${t.id}`, source: "task", taskNo: t.id, done: false,
        text: t.actionId === "vacancy"
          ? { en: `Close vacancy task #${t.id} (${t.targetLabel}) once a teacher or cover is posted.`, hi: `शिक्षक या व्यवस्था होने पर रिक्ति कार्य #${t.id} (${t.targetLabelHi || t.targetLabel}) बंद करें।` }
          : { en: `Act on escalated task #${t.id} (${t.targetLabel}).`, hi: `अग्रेषित कार्य #${t.id} (${t.targetLabelHi || t.targetLabel}) पर कार्रवाई करें।` },
      });
    }
    const late = tasks.filter((t) => t.dueDate && t.dueDate < simToday && open(t));
    items.push({ id: "deo-late", source: "routine", done: late.length === 0, text: { en: `Review ${late.length} late task${late.length === 1 ? "" : "s"} in the block.`, hi: `विकासखंड के ${late.length} विलंबित कार्य देखें।` } });
  }
  return items;
}
