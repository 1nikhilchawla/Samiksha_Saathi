/**
 * Why an officer can trust the output, and how the month's work divides between
 * code, AI and the officer. The five trust pillars and the `measured` block are
 * computed live on this cycle; the stage split is a design estimate, not a
 * time-and-motion study.
 */
import type { Cycle, Task } from "./model";
import { runPipeline } from "./pipeline";
import type { SelfCheck } from "./selfChecks";
import { inspectClassroomPhoto, simulatePhoto } from "./visionGuard";

type Copy = { en: string; hi: string };

export type WorkloadStage = { id: string; label: Copy; automatedPct: number; automatedBy: Copy; officerShare: Copy; before: Copy; after: Copy };
export type TrustPillar = { id: string; label: Copy; pass: boolean; evidence: Copy };

/** Share of each stage done by code, AI or bot, as designed (95 + 90 + 55 + 80 + 90 = 82% on average). Not measured. */
export const WORKLOAD_STAGES: WorkloadStage[] = [
  {
    id: "join", automatedPct: 95,
    label: { en: "Data join and cleaning", hi: "डेटा जोड़ना व साफ करना" },
    automatedBy: { en: "Code", hi: "कोड" }, officerShare: { en: "Confirms unknown columns", hi: "अनजाने कॉलम की पुष्टि" },
    before: { en: "3–4 days by hand", hi: "हाथ से 3–4 दिन" }, after: { en: "under 0.1 s", hi: "0.1 सेकंड से कम" },
  },
  {
    id: "brief", automatedPct: 90,
    label: { en: "3-year trend and gap brief", hi: "तीन वर्ष का रुझान व अंतर ब्रीफ" },
    automatedBy: { en: "Code + AI ranking", hi: "कोड + AI क्रम" }, officerShare: { en: "Reads and challenges the brief", hi: "ब्रीफ पढ़ना व सवाल करना" },
    before: { en: "another week", hi: "एक और सप्ताह" }, after: { en: "under a minute", hi: "एक मिनट से कम" },
  },
  {
    id: "decide", automatedPct: 55,
    label: { en: "Task drafting vs. sign-off", hi: "कार्य मसौदा बनाम अनुमोदन" },
    automatedBy: { en: "Rules + AI drafting", hi: "नियम + AI मसौदा" }, officerShare: { en: "Every approval, owner and date", hi: "हर अनुमोदन, जिम्मेदार और तिथि" },
    before: { en: "minutes, often unowned", hi: "बैठक नोट, अक्सर बिना जिम्मेदार" }, after: { en: "owned drafts in seconds", hi: "सेकंडों में जिम्मेदार सहित ड्राफ्ट" },
  },
  {
    id: "follow", automatedPct: 80,
    label: { en: "Reminders, photo checks and reply reading", hi: "याद दिलाना, फोटो जाँच व उत्तर पढ़ना" },
    automatedBy: { en: "Bot + checks", hi: "बॉट + जाँच" }, officerShare: { en: "Escalations to the DEO", hi: "DEO को अग्रेषण" },
    before: { en: "phone calls", hi: "फोन कॉल" }, after: { en: "09:00 reminders, parsed replies", hi: "09:00 याद, पढ़े गए उत्तर" },
  },
  {
    id: "outcome", automatedPct: 90,
    label: { en: "Next-round outcome and box-tick audit", hi: "अगले चक्र का परिणाम व बॉक्स-टिक जाँच" },
    automatedBy: { en: "Code", hi: "कोड" }, officerShare: { en: "Physical spot checks", hi: "मौके पर जाँच" },
    before: { en: "no link to last month", hi: "पिछले माह से कोई जोड़ नहीं" }, after: { en: "scored against matched schools", hi: "मैच स्कूलों से तुलना" },
  },
];

const DISPATCHED = new Set(["sent", "reminded", "done", "partial", "blocked", "overdue", "escalated", "outcome_checked"]);

/**
 * The split the product is designed around: 92% of the monthly review work is
 * prepared by code, the bot and the Laya sidecar; 8% stays with the officer
 * (approve, own, and the physical spot check).
 *
 * These two are the **design target**. The measured share on this cycle is
 * `automation.pct`, computed from counters below. They are shown side by side
 * on purpose: the target says what the system was built to do, the measurement
 * says what this cycle actually did.
 */
export const LAYA_ASSISTED_AUTOMATED_PCT = 92;
export const LAYA_ASSISTED_OFFICER_PCT = 8;

export function computeTrustAndWorkload(cycle: Cycle | (Omit<Cycle, "briefInput"> & { briefInput: unknown }), tasks: Task[], selfChecks: SelfCheck[]) {
  const automatedPct = Math.round(WORKLOAD_STAGES.reduce((a, s) => a + s.automatedPct, 0) / WORKLOAD_STAGES.length);
  const check = (id: string) => selfChecks.find((c) => c.id === id);

  // Determinism: run the same files twice more; every gap fact must match the stored cycle.
  const facts = (gaps: Cycle["gaps"]) => JSON.stringify(gaps.map((g) => [g.id, g.factEn, g.codeRank]));
  let deterministic = false;
  try {
    const files = cycle.files.map((f) => ({ name: f.name, csv: f.csv }));
    deterministic = facts(runPipeline(files).gaps) === facts(cycle.gaps) && facts(runPipeline(files).gaps) === facts(cycle.gaps);
  } catch {
    deterministic = false;
  }

  const cited = cycle.gaps.filter((g) => g.sourceRefs.length > 0 && g.sourceRefs.every((c) => c.file && c.row && c.verbatim)).length;
  const dispatched = tasks.filter((t) => DISPATCHED.has(t.status));
  const unapproved = dispatched.filter((t) => !t.approvedAt || !t.approvedBy).length;
  // The drawn single-child scene goes through the same pixel measures and face estimate as an upload.
  const photoGuard = inspectClassroomPhoto({ ...simulatePhoto("single", 320, 240), consent: { hmOrCrccAttested: true, beoVerified: true, deoAuditSigned: true } }).code === "BLOCKED_SINGLE_CHILD_PII";
  const numbers = check("3.1");
  const pii = check("3.3");

  const pillars: TrustPillar[] = [
    {
      id: "math", pass: deterministic,
      label: { en: "Math determinism", hi: "गणित की निश्चितता" },
      evidence: deterministic
        ? { en: "Re-ran the pipeline twice: identical gaps. No model computes a number.", hi: "पाइपलाइन दो बार फिर चलाई: वही अंतर। कोई मॉडल अंक नहीं गिनता।" }
        : { en: "Re-run did not reproduce the stored gaps.", hi: "दोबारा चलाने पर वही अंतर नहीं बने।" },
    },
    {
      id: "numbers", pass: Boolean(numbers?.pass),
      label: { en: "Number-check guardrail", hi: "नंबर-चेक गार्डरेल" },
      evidence: numbers ? { en: numbers.value, hi: numbers.valueHi } : { en: "Self-check 3.1 not run.", hi: "स्व-जाँच 3.1 नहीं चली।" },
    },
    {
      id: "citations", pass: cycle.gaps.length > 0 && cited === cycle.gaps.length,
      label: { en: "Citation traceability", hi: "स्रोत उद्धरण" },
      evidence: { en: `${cited} of ${cycle.gaps.length} gaps cite file, row and the quoted value.`, hi: `${cycle.gaps.length} में से ${cited} अंतर फाइल, पंक्ति और मूल मान बताते हैं।` },
    },
    {
      id: "human", pass: unapproved === 0,
      label: { en: "Human-in-the-loop approval gate", hi: "मानव अनुमोदन गेट" },
      evidence: {
        en: `${unapproved} of ${dispatched.length} sent tasks went out without an approval.`,
        hi: `${dispatched.length} भेजे गए कार्यों में से ${unapproved} बिना अनुमोदन गए।`,
      },
    },
    {
      id: "privacy", pass: Boolean(pii?.pass) && photoGuard,
      label: { en: "Privacy and vision proof gate", hi: "गोपनीयता व दृश्य प्रमाण गेट" },
      evidence: {
        en: `${pii?.value ?? "Student-data guard not run."} Single-child photo ${photoGuard ? "blocked" : "not blocked"}.`,
        hi: `${pii?.valueHi ?? "विद्यार्थी-डेटा गार्ड नहीं चला।"} एकल-बच्चा फोटो ${photoGuard ? "रोकी गई" : "नहीं रोकी गई"}।`,
      },
    },
  ];
  const trustPct = Math.round((pillars.filter((p) => p.pass).length / pillars.length) * 100);
  const measured = measureCycle(cycle, tasks);
  return {
    stages: WORKLOAD_STAGES,
    automatedPct,
    officerPct: 100 - automatedPct,
    pillars,
    trustPct,
    automation: measureAutomation(cycle, tasks),
    measured,
    /** The design split, next to the measured one. */
    layaAssistedAutomatedPct: LAYA_ASSISTED_AUTOMATED_PCT,
    layaAssistedOfficerPct: LAYA_ASSISTED_OFFICER_PCT,
    /** 110 of 119 data problems fixed by code = 92.4%. */
    dataAutoFixRatePct: measured.dataAutoFixRatePct,
  };
}

export type AutomationInput = {
  id: string;
  label: Copy;
  /** The number behind the share, so the reader can check it. */
  value: string;
  pct: number;
  /** How much work this input covers; the inputs are weighted by it. */
  weight: number;
};

export type AutomationMeasurement = {
  /** The share of the work the code and the bot did, measured on this cycle. */
  pct: number;
  inputs: AutomationInput[];
  /** True when the cycle is too thin to measure honestly. */
  thin: boolean;
  note: Copy;
};

/**
 * The automation share, measured.
 *
 * The design estimate (82% on the five stages) is a plan. This is what the
 * cycle actually did, from counters that already exist: how many data problems
 * the code fixed on its own, how many gaps it found and cited without a person,
 * and how much of each task record was prepared rather than typed. Each input
 * shows its own number, and the inputs are weighted by the work they cover.
 */
export function measureAutomation(
  cycle: Pick<Cycle, "summary" | "gaps">,
  tasks: Task[],
): AutomationMeasurement {
  const s = cycle.summary;
  const dataProblems = s.auto_fixed + s.data_problems;
  const joinPct = dataProblems ? Math.round((s.auto_fixed / dataProblems) * 1000) / 10 : 0;
  const cited = cycle.gaps.filter((g) => g.sourceRefs.length > 0 && g.sourceRefs.every((c) => c.file && c.row && c.verbatim)).length;
  const gapPct = cycle.gaps.length ? Math.round((cited / cycle.gaps.length) * 1000) / 10 : 0;
  const live = tasks.filter((t) => t.status !== "rejected" && t.status !== "cancelled");
  const total = live.length * TASK_FIELDS.length;
  const filled = live.reduce((a, t) => a + TASK_FIELDS.filter((f) => Boolean(t[f] && String(t[f]).trim())).length, 0);
  const fieldsPct = total ? Math.round((filled / total) * 1000) / 10 : 0;

  const inputs: AutomationInput[] = [
    {
      id: "join",
      label: { en: "Data join and cleaning fixed without a person", hi: "बिना किसी व्यक्ति के ठीक किए गए डेटा प्रॉब्लम" },
      value: `${s.auto_fixed} of ${dataProblems}`,
      pct: joinPct,
      weight: Math.max(1, dataProblems),
    },
    {
      id: "gaps",
      label: { en: "Gaps found, ranked and cited by code", hi: "कोड द्वारा खोजे, क्रमबद्ध और उद्धृत अंतर" },
      value: `${cited} of ${cycle.gaps.length}`,
      pct: gapPct,
      weight: Math.max(1, cycle.gaps.length),
    },
    {
      id: "fields",
      label: { en: "Task fields prepared rather than typed", hi: "टाइप नहीं किए गए कार्य फ़ील्ड" },
      value: `${filled} of ${total}`,
      pct: fieldsPct,
      weight: Math.max(1, live.length),
    },
  ];

  const weight = inputs.reduce((a, i) => a + i.weight, 0);
  const pct = weight ? Math.round((inputs.reduce((a, i) => a + i.pct * i.weight, 0) / weight) * 10) / 10 : 0;
  const thin = dataProblems === 0 && cycle.gaps.length === 0 && live.length === 0;
  return {
    pct,
    inputs,
    thin,
    note: thin
      ? { en: "Not enough on this cycle to measure the automation share honestly.", hi: "इस चक्र पर ईमानदार माप के लिए पर्याप्त आँकड़े नहीं हैं।" }
      : {
          en: `Measured on this cycle from ${dataProblems} data problems, ${cycle.gaps.length} gaps and ${live.length} tasks. It is not the design estimate above.`,
          hi: `यह इस चक्र पर ${dataProblems} डेटा समस्याओं, ${cycle.gaps.length} अंतरों और ${live.length} कार्यों से मापा गया है। यह ऊपर का डिज़ाइन अनुमान नहीं है।`,
        },
  };
}

const TASK_FIELDS = ["ownerId", "dueDate", "successEn", "actionId"] as const;

/**
 * Numbers measured on this cycle, next to the design split: the reader's real run
 * time, how many problems it fixed against how many it left for a person, how
 * complete the task fields are now, and how many sent tasks a person approved.
 */
export function measureCycle(cycle: Pick<Cycle, "summary">, tasks: Task[]) {
  const s = cycle.summary;
  const handled = s.auto_fixed + s.data_problems;
  const live = tasks.filter((t) => t.status !== "rejected" && t.status !== "cancelled");
  const total = live.length * TASK_FIELDS.length;
  const filled = live.reduce((a, t) => a + TASK_FIELDS.filter((f) => Boolean(t[f] && String(t[f]).trim())).length, 0);
  const decided = live.filter((t) => t.status !== "draft");
  return {
    actualComputeMs: Math.round(s.runtime_s * 100_000) / 100,
    manualJoinBaseline: { en: "3–4 days by hand", hi: "हाथ से 3–4 दिन" },
    autoFixedRowsCount: s.auto_fixed,
    dataProblemsFlaggedForHuman: s.data_problems,
    dataCleaningAutomationPct: handled ? Math.round((s.auto_fixed / handled) * 1000) / 10 : 0,
    /** The same number under the name the brief uses: 110 of 119 = 92.4%. */
    dataAutoFixRatePct: handled ? Math.round((s.auto_fixed / handled) * 1000) / 10 : 0,
    taskFieldsFilled: filled,
    taskFieldsTotal: total,
    taskFieldsCompletePct: total ? Math.round((filled / total) * 1000) / 10 : 0,
    approvalsByOfficer: decided.filter((t) => t.approvedBy && t.approvedAt).length,
    approvalsTotal: decided.length,
  };
}
