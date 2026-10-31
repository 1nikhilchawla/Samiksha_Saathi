/**
 * Where a monthly review loop usually breaks, and what this cycle shows at each
 * point. Every status comes from the cycle, its tasks, the scorecard and the
 * executed hinge pivots.
 *
 * Point 6 is the failure J-PAL's evaluation of Madhya Pradesh's Shaala Gunvatta
 * programme (Muralidharan and Singh) found: school assessments completed on
 * paper in almost every school, with no gain in learning. Here a "done" with a
 * flat Round 4 is BOX_TICKING_SUSPECTED until the HP-5 pivot revokes it and
 * orders a BRC audit.
 */
import { CONFIG } from "./config";
import type { Cycle, Task } from "./model";
import type { Scorecard } from "./scorecard";
import type { HingeCode, HingeDecisionRecord, HingeTab } from "./hingePoints";

type Copy = { en: string; hi: string };
export type LoopStatus = "REPAIRED" | "GUARDRAIL_ACTIVE" | "BOX_TICKING_SUSPECTED" | "CAUGHT_IN_R4" | "WAITING" | "AT_RISK";

export type BreakPoint = {
  id: number;
  title: Copy;
  /** How this point fails in a typical district. */
  failure: Copy;
  status: LoopStatus;
  evidence: Copy;
  tab: HingeTab;
  /** The hinge point whose pivot repairs this break, when one exists. */
  repairBy: HingeCode | null;
};

const J = CONFIG.context_stats;
export const JPAL_LOOP_NOTE: Copy = {
  en: `J-PAL (Muralidharan and Singh), Shaala Gunvatta in MP: assessments done in ${J.jpal_assessment_completion_pct}% of ${J.jpal_mp_schools.toLocaleString("en-IN")} schools, with no learning gain. The loop broke after the paperwork.`,
  hi: `J-PAL (मुरलीधरन व सिंह), मप्र शाला गुणवत्ता: ${J.jpal_mp_schools.toLocaleString("en-IN")} विद्यालयों में से ${J.jpal_assessment_completion_pct}% में मूल्यांकन हुआ, सीखने में सुधार नहीं। कागज़ी काम के बाद लूप टूटा।`,
};

export const LOOP_STATUS_LABEL: Record<LoopStatus, Copy> = {
  REPAIRED: { en: "Repaired", hi: "ठीक" },
  GUARDRAIL_ACTIVE: { en: "Guardrail active", hi: "गार्डरेल सक्रिय" },
  BOX_TICKING_SUSPECTED: { en: "Box-ticking suspected · caught in R4", hi: "बॉक्स-टिक का संदेह · R4 में पकड़ा" },
  CAUGHT_IN_R4: { en: "Caught in R4", hi: "R4 में पकड़ा" },
  WAITING: { en: "Waiting", hi: "प्रतीक्षा" },
  AT_RISK: { en: "At risk", hi: "जोखिम" },
};

const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

export function evaluateLoopHealth(
  cycle: Pick<Cycle, "problems" | "fixes" | "peer">,
  tasks: Task[],
  score: Scorecard | null,
  decisions: HingeDecisionRecord[] = [],
): BreakPoint[] {
  const p = cycle.peer;
  const excuseTested = p.sufficient && p.matchedDeltas.length > 0;
  const drafts = tasks.filter((t) => t.status === "draft");
  const locked = drafts.filter((t) => t.missingFields.length);
  const vacancy = tasks.find((t) => t.actionId === "vacancy");
  const flat = score?.boxTicks ?? [];
  const streak = score && score.harangaon.from === 100 && score.harangaon.to < 100;
  const audit = decisions.find((d) => d.code === "HP-5");
  // Values an officer committed from the cleaning studio are logged with the fixes but are not the reader's.
  const auto = cycle.fixes.filter((f) => f.issueType !== "cleaning_rule_committed");
  const officer = cycle.fixes.length - auto.length;

  return [
    {
      id: 1, repairBy: null, tab: "upload",
      title: { en: "Siloed and corrupted data", hi: "बिखरा व बिगड़ा डेटा" },
      failure: { en: "Portals don't join; bad codes and impossible scores enter the average.", hi: "पोर्टल नहीं जुड़ते; गलत कोड और असंभव अंक औसत में जाते हैं।" },
      status: auto.length || cycle.problems.length ? "REPAIRED" : "WAITING",
      evidence: {
        en: `${auto.length} values auto-fixed${officer ? `, ${officer} changed by an officer rule` : ""}, ${cycle.problems.length} problems kept out of the averages and listed by file and row.`,
        hi: `${auto.length} मान स्वतः सुधरे${officer ? `, ${officer} अधिकारी नियम से बदले` : ""}, ${cycle.problems.length} समस्याएँ औसत से बाहर, फाइल-पंक्ति सहित।`,
      },
    },
    {
      id: 2, repairBy: "HP-2", tab: "brief",
      title: { en: "Untested excuses (BLO or election duty)", hi: "बिना जाँचे बहाने (BLO / चुनाव ड्यूटी)" },
      failure: { en: "A block-wide excuse is accepted without a comparison.", hi: "बिना तुलना के विकासखंड-व्यापी बहाना मान लिया जाता है।" },
      status: excuseTested ? "REPAIRED" : "AT_RISK",
      evidence: excuseTested
        ? { en: `This block ${sign(p.pilotDelta)} pts against ${p.matchedDeltas.map(sign).join(", ")} in matched blocks. ${p.conclusionEn}`, hi: `यह विकासखंड ${sign(p.pilotDelta)} अंक, समान विकासखंड ${p.matchedDeltas.map(sign).join(", ")}। ${p.conclusionHi}` }
        : { en: "Fewer than 2 matched peer blocks, so the excuse could not be tested.", hi: "2 से कम समान विकासखंड, इसलिए बहाना जाँचा नहीं जा सका।" },
    },
    {
      id: 3, repairBy: "HP-3", tab: "approve",
      title: { en: "Unowned meeting decisions", hi: "बिना जिम्मेदार के निर्णय" },
      failure: { en: "Decisions stay in the minutes with no owner or date.", hi: "निर्णय बिना जिम्मेदार या तिथि के नोट में रह जाते हैं।" },
      status: !tasks.length ? "WAITING" : locked.length ? "GUARDRAIL_ACTIVE" : "REPAIRED",
      evidence: !tasks.length
        ? { en: "No review note yet.", hi: "अभी कोई समीक्षा नोट नहीं।" }
        : locked.length
          ? { en: `${locked.map((t) => `#${t.id}`).join(", ")} locked until an owner and date are set.`, hi: `${locked.map((t) => `#${t.id}`).join(", ")} जिम्मेदार और तिथि भरने तक बंद।` }
          : { en: `All ${tasks.length} tasks have an owner, a date and a success measure.`, hi: `सभी ${tasks.length} कार्यों में जिम्मेदार, तिथि और सफलता मापदंड है।` },
    },
    {
      id: 4, repairBy: null, tab: "follow",
      title: { en: "Patchy networks and unclear replies", hi: "कमज़ोर नेटवर्क व अस्पष्ट उत्तर" },
      failure: { en: "Replies like \"ok sir\" or \"not done yet\" are read as done.", hi: "\"ठीक है\" या \"अभी नहीं हुआ\" को पूर्ण मान लिया जाता है।" },
      status: "GUARDRAIL_ACTIVE",
      evidence: {
        en: "09:00 reminders on the due date; \"not done yet\" can never close a task; unclear replies get a follow-up question.",
        hi: "अंतिम तिथि पर 09:00 याद; \"अभी नहीं हुआ\" कभी कार्य बंद नहीं करता; अस्पष्ट उत्तर पर प्रश्न।",
      },
    },
    {
      id: 5, repairBy: "HP-4", tab: "follow",
      title: { en: "Block-level authority deadlock", hi: "विकासखंड स्तर पर अधिकार की अड़चन" },
      failure: { en: "A vacancy only the DEO can fill waits at the block.", hi: "जो रिक्ति केवल DEO भर सकते हैं, वह विकासखंड पर अटकी रहती है।" },
      status: !vacancy ? "WAITING" : vacancy.ownerId === "deo" ? (vacancy.status === "escalated" ? "REPAIRED" : "GUARDRAIL_ACTIVE") : "AT_RISK",
      evidence: !vacancy
        ? { en: "No vacancy task in this cycle yet.", hi: "इस चक्र में अभी रिक्ति कार्य नहीं।" }
        : {
            en: `Task #${vacancy.id} is owned by the DEO and is ${vacancy.status}. Escalating tells the DEO on Telegram when their chat is linked.`,
            hi: `कार्य #${vacancy.id} DEO के पास है, स्थिति ${vacancy.status}। अग्रेषण पर DEO को टेलीग्राम सूचना (चैट जुड़ी हो तो)।`,
          },
    },
    {
      id: 6, repairBy: "HP-5", tab: "score",
      title: { en: "Paper box-ticking", hi: "कागज़ी बॉक्स-टिक" },
      failure: { en: "\"Done\" is reported with no learning gain.", hi: "बिना सीखने के सुधार के \"हो गया\" बताया जाता है।" },
      // A flat "done" in the current scorecard outranks any earlier audit: the HP-5 pivot
      // revokes the "done", so once it has run the rebuilt scorecard has no box-ticks left.
      status: !score ? "WAITING" : flat.length ? "BOX_TICKING_SUSPECTED" : audit ? "REPAIRED" : streak ? "CAUGHT_IN_R4" : "REPAIRED",
      evidence: !score
        ? { en: "Round 4 not loaded yet.", hi: "राउंड 4 अभी नहीं जुड़ा।" }
        : !flat.length && audit
          ? {
              en: `“Done” revoked and a BRC audit ordered by the ${audit.role} (${audit.changes.map((c) => `#${c.taskNo}`).join(", ")}).`,
              hi: `${audit.role} ने “पूर्ण” वापस लिया और BRC जाँच दी (${audit.changes.map((c) => `#${c.taskNo}`).join(", ")})।`,
            }
          : {
            en: [flat.length ? `${flat.map((b) => b.school).join(", ")}: done, outcome flat.` : "No flat \"done\" tasks.", streak ? `100% streak re-checked at ${score.harangaon.to}%.` : ""].filter(Boolean).join(" "),
            hi: [flat.length ? `${flat.map((b) => b.school).join(", ")}: पूर्ण, परिणाम सपाट।` : "कोई सपाट \"पूर्ण\" कार्य नहीं।", streak ? `100% की लकीर ${score.harangaon.to}% निकली।` : ""].filter(Boolean).join(" "),
          },
    },
  ];
}
