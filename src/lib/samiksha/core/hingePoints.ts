/**
 * Hinge points: the few forks in a cycle where the usual next step fails. Each
 * needs two signals at once (signal A × signal B), says what the usual step misses
 * (path A) and what the pivot does instead (path B), and appears at most once per
 * code, five in all. executeHingePivot is the pivot itself: a pure change to the
 * task list plus the decision record the server stores in the audit trail.
 */
import { ACTION_LIBRARY, CONFIG, REVIEW_DATE, type ActionId } from "./config";
import { customDraft, type Target } from "./customTasks";
import { approveBlockers } from "./guards";
import type { Cycle, SchoolRow, Task, TaskStatus } from "./model";
import { canPerform, type OfficerRole, type RbacAction } from "./rbac";
import type { Scorecard } from "./scorecard";
import { addDays } from "./tasks";

type Copy = { en: string; hi: string };
export type HingeTab = "upload" | "brief" | "approve" | "follow" | "score";
export type HingeCode = "HP-1" | "HP-2" | "HP-3" | "HP-4" | "HP-5";
export type HingePivotId =
  | "PIVOT_DUAL_TARL_AND_DEO_VACANCY"
  | "PIVOT_OVERRIDE_EXCUSE_AND_MANDATE_OBSERVATION"
  | "PIVOT_COMPLETE_TASK_GOVERNANCE_FIELDS"
  | "PIVOT_ESCALATE_SLA_BREACH_TO_DEO"
  | "PIVOT_INVALIDATE_BOX_TICK_AND_SPAWN_AUDIT";

export const HINGE_PIVOT_IDS: HingePivotId[] = [
  "PIVOT_DUAL_TARL_AND_DEO_VACANCY",
  "PIVOT_OVERRIDE_EXCUSE_AND_MANDATE_OBSERVATION",
  "PIVOT_COMPLETE_TASK_GOVERNANCE_FIELDS",
  "PIVOT_ESCALATE_SLA_BREACH_TO_DEO",
  "PIVOT_INVALIDATE_BOX_TICK_AND_SPAWN_AUDIT",
];

export type HingePoint = {
  id: string;
  code: HingeCode;
  severity: "CRITICAL" | "HIGH";
  /** The officer who executes the pivot, and the permission it needs. */
  ownerRole: OfficerRole;
  pivotRight: RbacAction;
  tab: HingeTab;
  taskNos: number[];
  schoolCodes: string[];
  compoundTrigger: { signalA: Copy; signalB: Copy; intersectionRule: string };
  title: Copy;
  cause: Copy;
  diagnosticQuestion: Copy;
  pathAFails: Copy;
  pathBPivot: Copy;
  /** True only where the code itself refuses the next step until this is resolved. */
  blocksStageClosure: boolean;
  gateLock: Copy;
  pivotId: HingePivotId;
  pivotButton: Copy;
  expectedImpact: Copy;
  /** The pivot messages the DEO on Telegram, so the screen asks before running it. */
  notifiesTelegram: boolean;
  /** Ranking within a severity: points at stake, days late, schools touched. */
  impact: number;
};

export type HingeChange = { taskNo: number; from: TaskStatus | null; to: TaskStatus; what: Copy };

/** One executed pivot, as stored in hinge_decisions and shown in the studio's audit trail. */
export type HingeDecisionRecord = {
  code: HingeCode;
  pivotId: HingePivotId;
  role: OfficerRole;
  at: string;
  summary: Copy;
  changes: HingeChange[];
};

export const MAX_HINGE_POINTS = 5;
/** A cluster this long without a CRCC visit is a supervisory blind spot. */
export const HINGE_NO_VISIT_DAYS = 60;

type HingeCycle = Pick<Cycle, "schools" | "peer" | "gaps"> & Partial<Pick<Cycle, "allRankedGaps" | "thresholds">>;

const ACTED = new Set<TaskStatus>(["approved", "sent", "reminded", "done", "partial", "blocked", "overdue", "escalated", "outcome_checked"]);
const OPEN = new Set<TaskStatus>(["approved", "sent", "reminded", "partial"]);
const CLOSED = new Set<TaskStatus>(["done", "outcome_checked"]);
const OUTCOME_ACTIONS: ActionId[] = ["tarl", "no_visit", "attendance"];
const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const taskList = (nos: number[]) => nos.map((n) => `#${n}`).join(", ");

const acted = (tasks: Task[], codes: string[], action: ActionId) =>
  tasks.some((t) => t.actionId === action && ACTED.has(t.status) && t.targetCodes.some((c) => codes.includes(c)));
const touching = (tasks: Task[], codes: string[], action: ActionId) =>
  tasks.filter((t) => t.actionId === action && t.status !== "cancelled" && t.targetCodes.some((c) => codes.includes(c)));

/** HP-1: a steep drop (A) and an empty maths post (B) in the same school. */
function vacancyDrop(cycle: HingeCycle, tasks: Task[]): HingePoint | null {
  // The drop limit the cycle was built with, so HP-1 and the brief agree after an SPD change.
  const max = (cycle.thresholds ?? CONFIG.thresholds).drop_flag_delta_max;
  const hits = cycle.schools
    .filter((s) => s.mathsPost === "Vacant" && s.r2 !== null && s.r3 !== null && s.r3 - s.r2 <= max)
    .filter((s) => !(acted(tasks, [s.code], "tarl") && acted(tasks, [s.code], "vacancy")))
    .sort((a, b) => a.r3! - a.r2! - (b.r3! - b.r2!));
  const s = hits[0];
  if (!s) return null;
  const delta = s.r3! - s.r2!;
  const codes = hits.map((h) => h.code);
  const more = hits.length - 1;
  const names = { en: hits.map((h) => h.nameEn).join(", "), hi: hits.map((h) => h.nameHi).join(", ") };
  return {
    id: "hp-1", code: "HP-1", severity: "CRITICAL", ownerRole: "BEO", pivotRight: "approve_task", tab: "approve",
    taskNos: [...touching(tasks, codes, "tarl"), ...touching(tasks, codes, "vacancy")].map((t) => t.id),
    schoolCodes: codes,
    compoundTrigger: {
      signalA: {
        en: `Grade 3 numeracy at ${s.nameEn} is ${s.r3}% (${sign(delta)} pts since R2)${more ? `, and ${more} more school${more === 1 ? "" : "s"}` : ""}.`,
        hi: `${s.nameHi} में कक्षा 3 संख्या ज्ञान ${s.r3}% (R2 से ${sign(delta)} अंक)${more ? `, और ${more} विद्यालय` : ""}।`,
      },
      signalB: { en: `Maths teacher post vacant since ${s.vacantSince} (UDISE+ file).`, hi: `गणित शिक्षक पद ${s.vacantSince} से रिक्त (UDISE+ फाइल)।` },
      intersectionRule: `r3 - r2 <= ${max} AND maths_post = 'Vacant'`,
    },
    title: { en: `Compound crisis at ${names.en}`, hi: `${names.hi} में दोहरा संकट` },
    cause: {
      en: "The drop and the empty post are in the same school, so either answer alone will not hold.",
      hi: "गिरावट और रिक्त पद एक ही विद्यालय में हैं, इसलिए कोई एक उपाय अकेले नहीं टिकेगा।",
    },
    diagnosticQuestion: { en: "Is this a teaching-method gap or a missing teacher?", hi: "यह पढ़ाने के तरीके की कमी है या शिक्षक की कमी?" },
    pathAFails: {
      en: "A nudge to the HM to “improve maths” has no maths teacher to act on it; a vacancy request alone leaves the children behind until a teacher arrives.",
      hi: "प्रधानाध्यापक को “गणित सुधारें” कहने पर कोई गणित शिक्षक नहीं जो करे; केवल रिक्ति प्रस्ताव से शिक्षक आने तक बच्चे पीछे रहते हैं।",
    },
    pathBPivot: {
      en: "Approve the CRCC's TaRL camp and the DEO vacancy request together, as one decision. A missing owner or date is filled from the roster and the action library.",
      hi: "CRCC का TaRL शिविर और DEO को रिक्ति प्रस्ताव एक साथ, एक निर्णय में अनुमोदित करें। अधूरा जिम्मेदार या तिथि रोस्टर और कार्य सूची से भरी जाती है।",
    },
    blocksStageClosure: false,
    gateLock: { en: "Advisory: the code does not lock a stage, but the top gap has no complete answer until both are approved.", hi: "सलाह: कोड कोई चरण बंद नहीं करता, पर दोनों अनुमोदन तक सबसे बड़े अंतर का पूरा उत्तर नहीं।" },
    pivotId: "PIVOT_DUAL_TARL_AND_DEO_VACANCY",
    pivotButton: { en: "Approve camp + vacancy request together", hi: "शिविर + रिक्ति प्रस्ताव साथ अनुमोदित करें" },
    expectedImpact: {
      en: "The camp targets +8 pts in R4 (action library); the DEO gets the posting request in the same cycle. Nothing is sent until the BEO sends it.",
      hi: "शिविर का लक्ष्य R4 में +8 अंक (कार्य सूची); DEO को इसी चक्र में पद प्रस्ताव। BEO के भेजने तक कुछ नहीं जाता।",
    },
    notifiesTelegram: false,
    impact: hits.reduce((a, h) => a + Math.abs(h.r3! - h.r2!), 0),
  };
}

/** HP-2: a cluster unvisited for 60+ days (A) while the peer check rules out the block-wide excuse (B). */
function blindCluster(cycle: HingeCycle, tasks: Task[]): HingePoint | null {
  const p = cycle.peer;
  if (!(p.sufficient && p.matchedDeltas.length > 0 && p.pilotDelta < Math.min(...p.matchedDeltas))) return null;
  const clusters = new Map<string, { days: number; schools: SchoolRow[] }>();
  for (const s of cycle.schools) {
    const c = clusters.get(s.cluster) ?? { days: Number.POSITIVE_INFINITY, schools: [] };
    c.days = Math.min(c.days, s.daysSinceVisit ?? Number.POSITIVE_INFINITY);
    c.schools.push(s);
    clusters.set(s.cluster, c);
  }
  const blind = [...clusters]
    .filter(([, c]) => Number.isFinite(c.days) && c.days >= HINGE_NO_VISIT_DAYS && !acted(tasks, c.schools.map((s) => s.code), "no_visit"))
    .sort((a, b) => b[1].days * b[1].schools.length - a[1].days * a[1].schools.length);
  const top = blind[0];
  if (!top) return null;
  const [name, c] = top;
  const scored = c.schools.filter((s) => s.r2 !== null && s.r3 !== null);
  const mean = scored.length ? scored.reduce((a, s) => a + (s.r3! - s.r2!), 0) / scored.length : 0;
  const codes = blind.flatMap(([, x]) => x.schools.map((s) => s.code));
  const lo = Math.min(...p.matchedDeltas);
  const hi = Math.max(...p.matchedDeltas);
  const names = blind.map(([n]) => n).join(", ");
  return {
    id: "hp-2", code: "HP-2", severity: "HIGH", ownerRole: "BEO", pivotRight: "approve_task", tab: "brief",
    taskNos: touching(tasks, codes, "no_visit").map((t) => t.id),
    schoolCodes: codes,
    compoundTrigger: {
      signalA: {
        en: `Cluster ${name}: no CRCC visit in ${c.days} days across ${c.schools.length} schools; numeracy ${sign(mean)} pts from R2 to R3.`,
        hi: `क्लस्टर ${name}: ${c.schools.length} विद्यालयों में ${c.days} दिनों से CRCC भ्रमण नहीं; R2 से R3 संख्या ज्ञान ${sign(mean)} अंक।`,
      },
      signalB: {
        en: `Peer check: this block ${sign(p.pilotDelta)} pts against ${sign(lo)} to ${sign(hi)} in ${p.matchedDeltas.length} blocks with the same election duty.`,
        hi: `तुलना: यह विकासखंड ${sign(p.pilotDelta)} अंक, समान चुनाव ड्यूटी वाले ${p.matchedDeltas.length} विकासखंड ${sign(lo)} से ${sign(hi)}।`,
      },
      intersectionRule: `days_since_visit >= ${HINGE_NO_VISIT_DAYS} AND pilot_delta < min(matched_peer_deltas)`,
    },
    title: { en: `Supervisory blind spot in Cluster ${names}`, hi: `क्लस्टर ${names} में निगरानी की कमी` },
    cause: {
      en: "The usual excuse is BLO or election duty, but blocks with the same duty did not fall. The missing visits are specific to this block.",
      hi: "आम बहाना BLO या चुनाव ड्यूटी है, पर उसी ड्यूटी वाले विकासखंड नहीं गिरे। भ्रमण की कमी इसी विकासखंड की है।",
    },
    diagnosticQuestion: { en: "Is the drop the election duty everyone had, or the supervision only this block lost?", hi: "गिरावट सबकी चुनाव ड्यूटी से है, या इसी विकासखंड की छूटी निगरानी से?" },
    pathAFails: {
      en: "Accepting the excuse defers visits by another month; the schools stay unobserved through the next round.",
      hi: "बहाना मानने से भ्रमण एक और माह टलता है; अगले चक्र तक विद्यालय बिना अवलोकन रहते हैं।",
    },
    pathBPivot: {
      en: "Reject the excuse on the peer evidence and approve a 3-week CRCC classroom observation across every school in the cluster.",
      hi: "तुलनात्मक प्रमाण पर बहाना अस्वीकार करें और क्लस्टर के हर विद्यालय में 3 सप्ताह का CRCC कक्षा अवलोकन अनुमोदित करें।",
    },
    blocksStageClosure: false,
    gateLock: { en: "Advisory: the code does not lock a stage; the cluster stays a blind spot until observation is approved.", hi: "सलाह: कोड कोई चरण बंद नहीं करता; अवलोकन अनुमोदन तक क्लस्टर निगरानी से बाहर रहता है।" },
    pivotId: "PIVOT_OVERRIDE_EXCUSE_AND_MANDATE_OBSERVATION",
    pivotButton: { en: "Reject excuse, approve observation", hi: "बहाना अस्वीकार, अवलोकन अनुमोदित" },
    expectedImpact: {
      en: `At least 1 structured observation in each of ${codes.length} schools within 21 days (action library).`,
      hi: `21 दिनों में ${codes.length} विद्यालयों में से हर एक में कम से कम 1 संरचित अवलोकन (कार्य सूची)।`,
    },
    notifiesTelegram: false,
    impact: (c.days * codes.length) / 100,
  };
}

/** HP-3: a decision backed by a gap (A) that has no owner or due date (B). */
function unownedDecision(cycle: HingeCycle, tasks: Task[]): HingePoint | null {
  const locked = tasks.filter((t) => t.status === "draft" && t.missingFields.some((f) => f === "owner_id" || f.startsWith("due_date")));
  const t = locked[0];
  if (!t) return null;
  const gap = (cycle.allRankedGaps ?? cycle.gaps).find((g) => g.id === t.gapId);
  const missing = t.missingFields.filter((f) => f === "owner_id" || f.startsWith("due_date"));
  return {
    id: "hp-3", code: "HP-3", severity: "HIGH", ownerRole: "BEO", pivotRight: "edit_task", tab: "approve",
    taskNos: locked.map((x) => x.id),
    schoolCodes: [...new Set(locked.flatMap((x) => x.targetCodes))],
    compoundTrigger: {
      signalA: gap
        ? { en: gap.factEn, hi: gap.factHi }
        : { en: `Decision in the review note for ${t.targetLabel}.`, hi: `${t.targetLabelHi || t.targetLabel} के लिए समीक्षा नोट का निर्णय।` },
      signalB: {
        en: `Task #${t.id} has no ${missing.map((f) => (f === "owner_id" ? "owner" : "due date")).join(" and ")}${locked.length > 1 ? ` (${locked.length} tasks in all: ${taskList(locked.map((x) => x.id))})` : ""}.`,
        hi: `कार्य #${t.id} में ${missing.map((f) => (f === "owner_id" ? "जिम्मेदार" : "अंतिम तिथि")).join(" और ")} नहीं${locked.length > 1 ? ` (कुल ${locked.length} कार्य: ${taskList(locked.map((x) => x.id))})` : ""}।`,
      },
      intersectionRule: "gap evidence exists AND (owner_id IS NULL OR due_date IS NULL)",
    },
    title: { en: `Task ${taskList(locked.map((x) => x.id))} is locked at the approval gate`, hi: `कार्य ${taskList(locked.map((x) => x.id))} अनुमोदन गेट पर रुका` },
    cause: {
      en: `${t.targetLabel}: the evidence is there, but nobody is named and no date is set.`,
      hi: `${t.targetLabelHi || t.targetLabel}: प्रमाण है, पर न कोई जिम्मेदार नामित है न तिथि तय।`,
    },
    diagnosticQuestion: { en: "Will this decision leave the room with someone responsible for it?", hi: "क्या यह निर्णय किसी जिम्मेदार के साथ बैठक से बाहर जाएगा?" },
    pathAFails: {
      en: "Written as an unowned line in the minutes, nobody is asked about it next month: the classic review-meeting failure.",
      hi: "बिना जिम्मेदार के नोट की एक पंक्ति बनकर, अगले माह कोई इसके बारे में नहीं पूछता: समीक्षा बैठक की पुरानी विफलता।",
    },
    pathBPivot: {
      en: "Fill the owner from the roster (the school's HM or the cluster CRCC) and the due date from the action library. The BEO then checks and approves it.",
      hi: "जिम्मेदार रोस्टर से (विद्यालय के प्रधानाध्यापक या क्लस्टर CRCC) और तिथि कार्य सूची से भरें। फिर BEO जाँचकर अनुमोदित करें।",
    },
    blocksStageClosure: true,
    gateLock: {
      en: "Locked by code: Approve stays off until an owner and a due date are set (guardrail c, also a database rule).",
      hi: "कोड से बंद: जिम्मेदार और अंतिम तिथि भरने तक अनुमोदन बंद (गार्डरेल c, डेटाबेस नियम भी)।",
    },
    pivotId: "PIVOT_COMPLETE_TASK_GOVERNANCE_FIELDS",
    pivotButton: { en: "Fill owner and due date", hi: "जिम्मेदार और तिथि भरें" },
    expectedImpact: { en: "Approve unlocks; the approval itself stays with the BEO.", hi: "अनुमोदन खुलता है; अनुमोदन BEO ही करते हैं।" },
    notifiesTelegram: false,
    impact: locked.length * 5,
  };
}

/** HP-4: past its date (A) and beyond what a reminder can move (B): blocked, cluster-wide or a posting. */
function slaBreach(tasks: Task[], simToday: string): HingePoint | null {
  const late = (t: Task) => (OPEN.has(t.status) && t.dueDate !== null && t.dueDate < simToday) || t.status === "overdue" || t.status === "blocked";
  const why = (t: Task): Copy | null => {
    if (t.actionId === "vacancy" || t.ownerId === "deo") return { en: `Task #${t.id} is a teacher posting: only the DEO can redeploy.`, hi: `कार्य #${t.id} शिक्षक पदस्थापना है: पुनर्नियोजन केवल DEO कर सकते हैं।` };
    if (t.status === "blocked") return { en: `Task #${t.id} was reported blocked${t.note ? `: ${t.note}` : ""}.`, hi: `कार्य #${t.id} रुका बताया गया${t.noteHi ? `: ${t.noteHi}` : ""}।` };
    if (t.targetCodes.length > 1) return { en: `Task #${t.id} covers ${t.targetCodes.length} schools, beyond one CRCC's reminder.`, hi: `कार्य #${t.id} ${t.targetCodes.length} विद्यालयों का है, एक CRCC की याद से आगे।` };
    return null;
  };
  const hits = tasks.filter((t) => t.status !== "escalated" && late(t) && why(t));
  const t = hits[0];
  if (!t) return null;
  const days = (d: string | null) => (d ? Math.max(0, Math.round((Date.parse(simToday) - Date.parse(d)) / 86_400_000)) : 0);
  return {
    id: "hp-4", code: "HP-4", severity: "CRITICAL", ownerRole: "BEO", pivotRight: "escalate_to_deo", tab: "follow",
    taskNos: hits.map((x) => x.id),
    schoolCodes: [...new Set(hits.flatMap((x) => x.targetCodes))],
    compoundTrigger: {
      signalA: {
        en: hits.slice(0, 3).map((x) => `Task #${x.id} due ${x.dueDate ?? "—"}, still ${x.status} on ${simToday}`).join("; ") + ".",
        hi: hits.slice(0, 3).map((x) => `कार्य #${x.id} की तिथि ${x.dueDate ?? "—"}, ${simToday} को भी ${x.status}`).join("; ") + "।",
      },
      signalB: why(t)!,
      intersectionRule: "(due_date < sim_today OR status IN ('overdue','blocked')) AND (action_id = 'vacancy' OR status = 'blocked' OR schools > 1)",
    },
    title: { en: `Task ${taskList(hits.map((x) => x.id))} breached its deadline`, hi: `कार्य ${taskList(hits.map((x) => x.id))} की समय-सीमा टूटी` },
    cause: {
      en: "The date has passed and the work needs authority above the cluster.",
      hi: "तिथि निकल गई और काम के लिए क्लस्टर से ऊपर का अधिकार चाहिए।",
    },
    diagnosticQuestion: { en: "Will another reminder fix it, or does it need authority above the block?", hi: "क्या एक और याद से होगा, या विकासखंड से ऊपर का अधिकार चाहिए?" },
    pathAFails: {
      en: "Another bot reminder to the same owner does not move a blocked, cluster-wide or posting task.",
      hi: "उसी जिम्मेदार को एक और बॉट याद रुके, क्लस्टर-व्यापी या पदस्थापना कार्य को नहीं हिलाती।",
    },
    pathBPivot: {
      en: "Escalate to the DEO now: the status becomes escalated, the task joins the DEO queue, and the DEO is told on Telegram when their chat is linked.",
      hi: "अभी DEO को अग्रेषित करें: स्थिति अग्रेषित, कार्य DEO कतार में, और चैट जुड़ी हो तो DEO को टेलीग्राम सूचना।",
    },
    blocksStageClosure: false,
    gateLock: { en: "Advisory: reminders continue, but the task cannot close at the block.", hi: "सलाह: याद जारी रहती है, पर कार्य विकासखंड स्तर पर बंद नहीं हो सकता।" },
    pivotId: "PIVOT_ESCALATE_SLA_BREACH_TO_DEO",
    pivotButton: { en: "Escalate to DEO", hi: "DEO को अग्रेषित करें" },
    expectedImpact: { en: "The DEO owns the next step; the scorecard shows the task as escalated, not quietly late.", hi: "अगला कदम DEO का; स्कोरकार्ड में कार्य अग्रेषित दिखता है, चुपचाप लंबित नहीं।" },
    notifiesTelegram: true,
    impact: hits.reduce((a, x) => a + days(x.dueDate) + x.targetCodes.length, 0),
  };
}

/** HP-5: "done" reported (A) while Round 4 shows nothing moved (B). */
function boxTick(cycle: HingeCycle, tasks: Task[], score: Scorecard | null): HingePoint | null {
  if (!score?.boxTicks.length) return null;
  const flagged = score.boxTicks
    .map((b) => ({ b, s: cycle.schools.find((x) => x.nameEn === b.school) }))
    .filter((x): x is { b: Scorecard["boxTicks"][number]; s: SchoolRow } => Boolean(x.s));
  const first = flagged[0];
  if (!first) return null;
  const codes = flagged.map((x) => x.s.code);
  const claims = tasks.filter((t) => CLOSED.has(t.status) && OUTCOME_ACTIONS.includes(t.actionId) && t.targetCodes.some((c) => codes.includes(c)));
  const streak = score.harangaon.from === 100 && score.harangaon.to < 100;
  return {
    id: "hp-5", code: "HP-5", severity: "CRITICAL", ownerRole: "BEO", pivotRight: "edit_task", tab: "score",
    taskNos: claims.map((t) => t.id),
    schoolCodes: codes,
    compoundTrigger: {
      signalA: {
        en: `${flagged.map((x) => x.s.nameEn).join(", ")}: “done” reported on ${claims.length ? `Task ${taskList(claims.map((t) => t.id))}` : "the task"}.`,
        hi: `${flagged.map((x) => x.s.nameHi).join(", ")}: ${claims.length ? `कार्य ${taskList(claims.map((t) => t.id))}` : "कार्य"} पर “पूर्ण” बताया गया।`,
      },
      signalB: { en: `Round 4: ${first.b.detailEn}`, hi: `राउंड 4: ${first.b.detailHi}` },
      intersectionRule: "status = 'done' AND |R4 - R3| <= 1 on the task's own metric",
    },
    title: { en: "Box-ticking caught in Round 4", hi: "राउंड 4 में बॉक्स-टिक पकड़ा" },
    cause: {
      en: `The report and the outcome disagree.${streak ? ` Separately, PS Harangaon's 100% streak was re-checked at ${score.harangaon.to}% by the spot check.` : ""}`,
      hi: `रिपोर्ट और परिणाम मेल नहीं खाते।${streak ? ` अलग से, पीएस हरनगाँव की 100% लकीर औचक जाँच में ${score.harangaon.to}% निकली।` : ""}`,
    },
    diagnosticQuestion: { en: "Did the work happen, or only the report?", hi: "काम हुआ, या केवल रिपोर्ट?" },
    pathAFails: { en: "Accepting the paper “done” counts the task as closed and rewards box-ticking.", hi: "कागज़ी “पूर्ण” मानने से कार्य बंद गिना जाता है और बॉक्स-टिक को इनाम मिलता है।" },
    pathBPivot: {
      en: "Revoke the “done” (the task goes back to open or partly done) and open an approved BRC re-verification task for the school.",
      hi: "“पूर्ण” वापस लें (कार्य फिर खुला या आंशिक) और विद्यालय के लिए अनुमोदित BRC पुनः सत्यापन कार्य खोलें।",
    },
    blocksStageClosure: false,
    gateLock: { en: "Advisory: until revoked, the closure rate counts this task as a success.", hi: "सलाह: वापस लेने तक समापन दर इस कार्य को सफल गिनती है।" },
    pivotId: "PIVOT_INVALIDATE_BOX_TICK_AND_SPAWN_AUDIT",
    pivotButton: { en: "Revoke “done”, order BRC audit", hi: "“पूर्ण” वापस लें, BRC जाँच दें" },
    expectedImpact: {
      en: "The closure rate drops to the honest figure; the audit task carries the school into the next cycle.",
      hi: "समापन दर सही आँकड़े पर आती है; जाँच कार्य विद्यालय को अगले चक्र में ले जाता है।",
    },
    notifiesTelegram: false,
    impact: 20 * flagged.length,
  };
}

export function computeHingePoints(cycle: HingeCycle, tasks: Task[], score: Scorecard | null, simToday: string): HingePoint[] {
  const all = [vacancyDrop(cycle, tasks), blindCluster(cycle, tasks), unownedDecision(cycle, tasks), slaBreach(tasks, simToday), boxTick(cycle, tasks, score)];
  const rank = { CRITICAL: 0, HIGH: 1 };
  return all
    .filter((p): p is HingePoint => p !== null)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.impact - a.impact || a.code.localeCompare(b.code))
    .slice(0, MAX_HINGE_POINTS);
}

export type HingePivotState = {
  cycle: HingeCycle & Pick<Cycle, "people">;
  tasks: Task[];
  score: Scorecard | null;
  simToday: string;
  role: OfficerRole;
  at?: string;
};

export type HingePivotResult =
  | { ok: false; reason: Copy }
  | { ok: true; tasks: Task[]; changed: Task[]; created: Task[]; escalated: number[]; record: HingeDecisionRecord };

/** The roster owner for an action: the DEO, the school's HM, or the CRCC of the first target's cluster. */
export function defaultOwner(actionId: ActionId, codes: string[], cycle: Pick<Cycle, "schools" | "people">): string | null {
  const role = ACTION_LIBRARY[actionId].default_owner_role;
  if (role === "DEO") return cycle.people.find((p) => p.role === "DEO")?.id ?? null;
  const schools = codes.map((c) => cycle.schools.find((s) => s.code === c)).filter((s): s is SchoolRow => Boolean(s));
  if (role === "HM") {
    const hm = schools.map((s) => cycle.people.find((p) => p.id === `hm-${s.code}`)).find(Boolean);
    if (hm) return hm.id;
  }
  return cycle.people.find((p) => p.role === "CRCC" && p.cluster === schools[0]?.cluster)?.id ?? null;
}

/**
 * Run one pivot on the current tasks. Pure: returns the next task list, the
 * changed and created tasks, the tasks to escalate (the server also writes the
 * DEO message and tells the DEO on Telegram), and the decision record.
 */
export function executeHingePivot(pivotId: HingePivotId, state: HingePivotState): HingePivotResult {
  const { cycle, role } = state;
  const point = computeHingePoints(cycle, state.tasks, state.score, state.simToday).find((p) => p.pivotId === pivotId);
  if (!point) return { ok: false, reason: { en: "This hinge point is no longer open.", hi: "यह निर्णायक मोड़ अब खुला नहीं है।" } };
  const right = canPerform(role, point.pivotRight);
  if (!right.allowed) return { ok: false, reason: { en: right.reasonEn, hi: right.reasonHi } };

  const at = state.at ?? new Date().toISOString();
  const base = state.simToday > REVIEW_DATE ? state.simToday : REVIEW_DATE;
  const tasks = state.tasks.map((t) => ({ ...t, targetCodes: [...t.targetCodes], missingFields: [...t.missingFields] }));
  const touched = new Set<number>();
  const created: Task[] = [];
  const escalated: number[] = [];
  const before = new Map(state.tasks.map((t) => [t.id, t.status]));
  let nextId = Math.max(13, ...tasks.map((t) => t.id)) + 1;
  const addNote = (t: Task, en: string, hi: string) => {
    t.note = t.note ? `${t.note} ${en}` : en;
    t.noteHi = t.noteHi ? `${t.noteHi} ${hi}` : hi;
  };
  const fill = (t: Task) => {
    const filled: string[] = [];
    if (!t.ownerId) {
      t.ownerId = defaultOwner(t.actionId, t.targetCodes, cycle);
      if (t.ownerId) filled.push("owner");
    }
    if (!t.dueDate || t.dueDate <= REVIEW_DATE) {
      t.dueDate = addDays(base, ACTION_LIBRARY[t.actionId].default_duration_days);
      filled.push("due date");
    }
    t.missingFields = approveBlockers(t);
    return filled;
  };
  const approve = (t: Task) => {
    if (approveBlockers(t).length) return;
    Object.assign(t, { status: "approved" as const, approvedBy: role.toLowerCase(), approvedAt: at, missingFields: [] });
  };
  const create = (target: Target, actionId: ActionId, what: [string, string]) => {
    const gap = cycle.gaps.find((g) => g.targetCodes.some((c) => target.codes.includes(c)) && g.actionId === actionId);
    const t = customDraft({
      id: nextId++, gaps: cycle.gaps, target, actionId, what,
      ownerId: defaultOwner(actionId, target.codes, cycle),
      dueDate: addDays(base, ACTION_LIBRARY[actionId].default_duration_days),
    });
    if (gap) t.gapId = gap.id;
    t.missingFields = approveBlockers(t);
    tasks.push(t);
    created.push(t);
    return t;
  };
  const schoolTarget = (s: SchoolRow): Target => ({ codes: [s.code], label: `${s.nameEn} (Cluster ${s.cluster})`, labelHi: `${s.nameHi} (क्लस्टर ${s.cluster})`, school: s });
  const school = (code: string) => cycle.schools.find((s) => s.code === code)!;

  if (pivotId === "PIVOT_DUAL_TARL_AND_DEO_VACANCY") {
    for (const code of point.schoolCodes) {
      const s = school(code);
      for (const actionId of ["tarl", "vacancy"] as const) {
        if (acted(tasks, [code], actionId)) continue;
        const a = ACTION_LIBRARY[actionId];
        const t = touching(tasks, [code], actionId)[0] ?? create(schoolTarget(s), actionId, [`${a.name_en}: ${s.nameEn}.`, `${a.name_hi}: ${s.nameHi}।`]);
        if (t.status === "rejected") t.status = "draft";
        const filled = fill(t);
        if (filled.length) addNote(t, `HP-1 pivot filled the ${filled.join(" and ")} from the roster and action library.`, "HP-1 निर्णय ने रोस्टर व कार्य सूची से जानकारी भरी।");
        approve(t);
        touched.add(t.id);
      }
    }
  } else if (pivotId === "PIVOT_OVERRIDE_EXCUSE_AND_MANDATE_OBSERVATION") {
    for (const cluster of new Set(point.schoolCodes.map((c) => school(c).cluster))) {
      const codes = cycle.schools.filter((s) => s.cluster === cluster).map((s) => s.code);
      const label = { en: `Cluster ${cluster} (${codes.length} schools)`, hi: `क्लस्टर ${cluster} (${codes.length} विद्यालय)` };
      const t = touching(tasks, codes, "no_visit")[0]
        ?? create({ codes, label: label.en, labelHi: label.hi, school: null }, "no_visit", [`${ACTION_LIBRARY.no_visit.name_en}: ${label.en}.`, `${ACTION_LIBRARY.no_visit.name_hi}: ${label.hi}।`]);
      if (t.status === "rejected") t.status = "draft";
      fill(t);
      addNote(t, "BEO ruled out the election-duty excuse on the peer check (HP-2).", "BEO ने तुलना के आधार पर चुनाव ड्यूटी का बहाना अस्वीकार किया (HP-2)।");
      approve(t);
      touched.add(t.id);
    }
  } else if (pivotId === "PIVOT_COMPLETE_TASK_GOVERNANCE_FIELDS") {
    for (const no of point.taskNos) {
      const t = tasks.find((x) => x.id === no)!;
      const filled = fill(t);
      addNote(t, `HP-3 pivot filled the ${filled.join(" and ") || "fields"} from the roster and action library. Check before approving.`, "HP-3 निर्णय ने रोस्टर व कार्य सूची से जानकारी भरी। अनुमोदन से पहले जाँचें।");
      touched.add(t.id);
    }
  } else if (pivotId === "PIVOT_ESCALATE_SLA_BREACH_TO_DEO") {
    for (const no of point.taskNos) {
      tasks.find((x) => x.id === no)!.status = "escalated";
      escalated.push(no);
      touched.add(no);
    }
  } else {
    const flagged = new Set(point.schoolCodes);
    for (const no of point.taskNos) {
      const t = tasks.find((x) => x.id === no)!;
      const hit = t.targetCodes.filter((c) => flagged.has(c));
      t.unitsDone = Math.max(0, t.targetCodes.length - hit.length);
      t.status = t.unitsDone > 0 ? "partial" : "sent";
      t.completedAt = null;
      addNote(
        t,
        `“Done” revoked by the HP-5 pivot: Round 4 shows no change at ${hit.map((c) => school(c).nameEn).join(", ")}.`,
        `HP-5 निर्णय से “पूर्ण” वापस: राउंड 4 में ${hit.map((c) => school(c).nameHi).join(", ")} में बदलाव नहीं।`,
      );
      touched.add(no);
    }
    for (const code of point.schoolCodes) {
      const s = school(code);
      approve(create(schoolTarget(s), "data_check", [
        `BRC re-verification at ${s.nameEn}: “done” was reported but Round 4 shows no change.`,
        `${s.nameHi} में BRC पुनः सत्यापन: “पूर्ण” बताया गया पर राउंड 4 में बदलाव नहीं।`,
      ]));
    }
  }

  const changed = tasks.filter((t) => touched.has(t.id) && !created.includes(t));
  const changes: HingeChange[] = [...changed, ...created].map((t) => ({
    taskNo: t.id,
    from: before.get(t.id) ?? null,
    to: t.status,
    what: before.has(t.id)
      ? { en: `Task #${t.id}: ${before.get(t.id)} → ${t.status}`, hi: `कार्य #${t.id}: ${before.get(t.id)} → ${t.status}` }
      : { en: `Task #${t.id} created (${t.status}): ${t.whatEn}`, hi: `कार्य #${t.id} बना (${t.status}): ${t.whatHi}` },
  }));
  if (!changes.length) return { ok: false, reason: { en: "The pivot found nothing to change.", hi: "निर्णय को बदलने लायक कुछ नहीं मिला।" } };
  return { ok: true, tasks, changed, created, escalated, record: { code: point.code, pivotId, role, at, summary: point.pivotButton, changes } };
}

const PENDING = new Set<TaskStatus>(["approved", "sent", "reminded", "partial"]);
const daysTo = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * The Monday 09:00 IST digest (also /weekly, /pending and the studio button).
 * For the BEO: open hinge points, tasks due this week, and overdue or blocked
 * tasks with the DEO tagged. For a field owner (`personId`): only their own
 * tasks. Built only from the cycle, so it passes the Telegram fact-check.
 */
export function buildWeeklyHingeDigest(
  cycle: Pick<Cycle, "people">,
  tasks: Task[],
  points: HingePoint[],
  simToday: string,
  lang: "en" | "hi",
  opts: { personId?: string } = {},
): string {
  const hi = lang === "hi";
  const mine = opts.personId ? tasks.filter((t) => t.ownerId === opts.personId) : tasks;
  const owner = (id: string | null) => {
    const p = cycle.people.find((x) => x.id === id);
    return p ? (hi ? p.nameHi : p.nameEn) : hi ? "कोई नहीं" : "no owner";
  };
  const label = (t: Task) => (hi ? t.targetLabelHi || t.targetLabel : t.targetLabel);
  const late = mine.filter((t) => t.status === "blocked" || t.status === "overdue" || (PENDING.has(t.status) && t.dueDate !== null && t.dueDate < simToday));
  const pending = mine.filter((t) => PENDING.has(t.status) && !late.includes(t));
  const deo = cycle.people.find((p) => p.role === "DEO");
  const lines: string[] = [hi ? `साप्ताहिक समीक्षा एवं लंबित कार्य सारांश · ${simToday}` : `Weekly review and pending-task digest · ${simToday}`];

  if (!opts.personId) {
    lines.push("", hi ? `1. खुले निर्णायक मोड़ (${points.length})` : `1. Open hinge points (${points.length})`);
    if (!points.length) lines.push(hi ? "   कोई नहीं।" : "   None.");
    for (const p of points) lines.push(`   ${p.code} · ${p.title[lang]}`);
  }
  lines.push("", hi ? `${opts.personId ? 1 : 2}. लंबित कार्य (${pending.length})` : `${opts.personId ? 1 : 2}. Pending tasks (${pending.length})`);
  if (!pending.length) lines.push(hi ? "   कोई नहीं।" : "   None.");
  for (const t of pending) {
    const d = t.dueDate ? daysTo(simToday, t.dueDate) : null;
    lines.push(
      hi
        ? `   कार्य #${t.id} · ${label(t)} · ${owner(t.ownerId)} · अंतिम तिथि ${t.dueDate ?? "—"}${d !== null ? ` (${d} दिन शेष)` : ""}`
        : `   Task #${t.id} · ${label(t)} · ${owner(t.ownerId)} · due ${t.dueDate ?? "—"}${d !== null ? ` (${d} days left)` : ""}`,
    );
  }
  lines.push("", hi ? `${opts.personId ? 2 : 3}. विलंबित या रुके कार्य (${late.length})` : `${opts.personId ? 2 : 3}. Overdue or blocked (${late.length})`);
  if (!late.length) lines.push(hi ? "   कोई नहीं।" : "   None.");
  for (const t of late) {
    lines.push(
      hi
        ? `   कार्य #${t.id} · ${label(t)} · ${t.status} · अंतिम तिथि ${t.dueDate ?? "—"}${deo && !opts.personId ? ` · DEO ${deo.nameHi} को सूचना योग्य` : ""}`
        : `   Task #${t.id} · ${label(t)} · ${t.status} · due ${t.dueDate ?? "—"}${deo && !opts.personId ? ` · for DEO ${deo.nameEn}` : ""}`,
    );
  }
  const example = (pending[0] ?? late[0] ?? mine[0])?.id;
  lines.push(
    "",
    hi ? `${opts.personId ? 3 : 4}. बॉट आदेश` : `${opts.personId ? 3 : 4}. Bot commands`,
    hi
      ? `   ${example ? `"${example} done" या "${example} partial" लिखें · ` : ""}/pending इस सूची के लिए · /why किसी विफलता का कारण जानने के लिए`
      : `   ${example ? `Reply "${example} done" or "${example} partial" · ` : ""}/pending for this list · /why for the reason something failed`,
  );
  return lines.join("\n");
}
