import { CONFIG, REVIEW_DATE, asciiToDev, modelPrice } from "./config";
import { approveBlockers, buildAllowedSet, dispatchBlockReason, validateActions, validateCitations, validateNumbers } from "./guards";
import { cleanSchoolCode, mapHeader, scanPii } from "./ingest";
import type { Cycle, ReplyParse, Task } from "./model";
import { buildScorecard, canonicalFieldTasks, mergeR4, projectMonthCost } from "./scorecard";
import { parseFieldReply } from "./tasks";

export type SelfCheck = { id: string; en: string; hi: string; pass: boolean; value: string; valueHi: string };

type CycleIn = Pick<Cycle, "summary" | "contractErrors" | "peers" | "gaps" | "schools" | "people" | "r4Files" | "briefEn" | "briefHi"> & { briefInput: unknown };

const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

function dataChecks(cycle: CycleIn): SelfCheck[] {
  const s = cycle.summary;
  const pairs: [string, string][] = [
    ["2311-0100-043", "23110100043"], [" 23110 100043 ", "23110100043"], ["2311000003", "02311000003"],
    [asciiToDev("23110100043"), "23110100043"], ["23110100043.0", "23110100043"], [Number("23110100043").toExponential(10), "23110100043"],
  ];
  const fixed = pairs.filter(([raw, want]) => cleanSchoolCode(raw).code === want).length;
  const hindi = ["विद्यालय कोड", "चक्र", "कक्षा 3 गणित (%)"].filter((h) => mapHeader(h) !== null).length;
  const english = ["UDISE Code", "School Name", "Cluster Name"].filter((h) => mapHeader(h) !== null).length;
  const ruleOk = cycle.peers.every((p) => p.matched === (p.election === CONFIG.peer_rule.election_duty_2024 && p.rural >= CONFIG.peer_rule.rural_share_pct_min));
  const matched = cycle.peers.filter((p) => p.matched).length;
  const excluded = cycle.peers.length - matched;
  return [
    { id: "1.1", en: "Baseline numbers reproduce from the raw files", hi: "आधार आँकड़े कच्ची फाइलों से दोबारा बनते हैं", pass: cycle.contractErrors.length === 0,
      value: `${s.files_read} files · ${s.schools} schools · ${s.assessment_rows} rows · ${s.data_problems} problems · ${s.flags} flags`,
      valueHi: `${s.files_read} फाइलें · ${s.schools} विद्यालय · ${s.assessment_rows} पंक्तियाँ · ${s.data_problems} समस्याएँ · ${s.flags} ध्वज` },
    { id: "1.2", en: "Messy school codes and Hindi/English headers normalise", hi: "बिगड़े विद्यालय कोड और हिन्दी/अंग्रेज़ी शीर्षक सही होते हैं", pass: fixed === pairs.length && hindi === 3 && english === 3,
      value: `${fixed}/${pairs.length} code formats · ${hindi}/3 Hindi headers · ${english}/3 English headers`,
      valueHi: `${fixed}/${pairs.length} कोड रूप · ${hindi}/3 हिन्दी शीर्षक · ${english}/3 अंग्रेज़ी शीर्षक` },
    { id: "1.3", en: "Peer excuse check applies its rule to every block", hi: "समकक्ष बहाना-जाँच हर विकासखंड पर नियम लगाती है", pass: ruleOk && matched >= CONFIG.peer_rule.min_peer_blocks,
      value: `${matched} matched · ${excluded} excluded`, valueHi: `${matched} मेल खाए · ${excluded} बाहर` },
  ];
}

function loopChecks(cycle: CycleIn): SelfCheck[] {
  const badActions = validateActions(cycle.gaps);
  const okGaps = cycle.gaps.length - new Set(badActions.map((b) => b.split(":")[0])).size;
  // Replays the seeded field cycle through the real scorecard code.
  const r4 = mergeR4(cycle.schools, cycle.r4Files);
  const seeded = buildScorecard(r4, canonicalFieldTasks({ gaps: cycle.gaps, people: cycle.people, schools: r4 }), cycle.people, 0, cycle.gaps);
  const hiName = (en: string) => cycle.schools.find((x) => x.nameEn === en)?.nameHi ?? en;
  return [
    { id: "2.1", en: "Every gap maps to an action in the curated library", hi: "हर अंतर सूची के किसी कार्य से जुड़ा है", pass: badActions.length === 0 && cycle.gaps.length > 0,
      value: `${okGaps}/${cycle.gaps.length} gaps`, valueHi: `${okGaps}/${cycle.gaps.length} अंतर` },
    { id: "2.2", en: "Learning change is compared with matched schools", hi: "सीखने का बदलाव मैच किए स्कूलों से तुलना होता है",
      pass: seeded.controls.length > 0 && Math.abs(seeded.khedi.delta - seeded.matchedMean - seeded.association) < 1e-9,
      value: `Khedi ${sign(seeded.khedi.delta)} vs ${seeded.controls.length} controls ${sign(seeded.matchedMean)} (this cycle)`,
      valueHi: `खेड़ी ${sign(seeded.khedi.delta)} बनाम ${seeded.controls.length} नियंत्रण ${sign(seeded.matchedMean)} (सीडेड चक्र)` },
    { id: "2.3", en: "“Done” with a flat outcome is flagged as box-ticking", hi: "परिणाम सपाट हो तो ‘हो गया’ बॉक्स-टिक चिह्नित होता है", pass: seeded.boxTicks.length > 0,
      value: seeded.boxTicks.map((b) => b.school).join(", ") || "none", valueHi: seeded.boxTicks.map((b) => hiName(b.school)).join(", ") || "कोई नहीं" },
  ];
}

function guardChecks(cycle: CycleIn): SelfCheck[] {
  const allowed = buildAllowedSet(cycle.briefInput);
  const numbersOk = validateNumbers(cycle.briefEn, allowed).length === 0 && validateNumbers(cycle.briefHi, allowed).length === 0;
  const invented = ["average is 42%", "औसत ४२% है", "Closure is 80% in this block", "Khedi scored 40%"];
  const rejected = invented.filter((t) => validateNumbers(t, allowed).length > 0).length;
  const probe: Task = { id: 0, gapId: "", actionId: "attendance", whatEn: "x", whatHi: "x", ownerId: null, targetLabel: "", targetLabelHi: "", targetCodes: [], dueDate: null, successEn: "x", successHi: "x", status: "draft", missingFields: [], approvedBy: null, approvedAt: null, completedAt: null, unitsDone: 0, note: "", noteHi: "" };
  const locks = approveBlockers(probe);
  const gateOk = locks.includes("owner_id") && locks.includes("due_date")
    && approveBlockers({ ...probe, ownerId: "x", dueDate: REVIEW_DATE }).includes("due_date_after_review")
    && dispatchBlockReason(probe) !== null && dispatchBlockReason({ ...probe, status: "rejected" }) !== null;
  const piiHeaders = ["student_name", "aadhaar", "apaar", "pen_number", "father_name"].filter((h) => scanPii([h], []).hit).length;
  const piiCells = [scanPii(["school_code"], [["1234 5678 9012"]]), scanPii(["school_code"], [["123412341234"]]), scanPii(["student_ref"], [["20231234567"]])].filter((r) => r.hit).length;
  const uncited = validateCitations(cycle.gaps);
  const cited = cycle.gaps.length - uncited.length;
  return [
    { id: "3.1", en: "Number check passes the brief and rejects invented figures", hi: "नंबर-चेक ब्रीफ पास करता है और गढ़े आँकड़े रोकता है", pass: numbersOk && rejected === invented.length,
      value: `${numbersOk ? "brief clean" : "brief failed"} · ${rejected}/${invented.length} invented figures rejected (42%, ४२%, 80%, 40%)`,
      valueHi: `${numbersOk ? "ब्रीफ साफ" : "ब्रीफ फेल"} · ${invented.length} में से ${rejected} गढ़े आँकड़े अस्वीकृत (42%, ४२%, 80%, 40%)` },
    { id: "3.2", en: "Approval and dispatch gate blocks incomplete tasks", hi: "अनुमोदन व प्रेषण गेट अधूरे कार्य रोकता है", pass: gateOk,
      value: gateOk ? "no owner / no date / not after review → locked · draft, rejected → not sent" : "failed",
      valueHi: gateOk ? "बिना जिम्मेदार / बिना तिथि / समीक्षा से पहले की तिथि → बंद · ड्राफ्ट, अस्वीकृत → नहीं भेजे जाते" : "फेल" },
    { id: "3.3", en: "Student PII is refused; every gap cites a file row", hi: "विद्यार्थी PII रुकता है; हर अंतर फाइल पंक्ति बताता है", pass: piiHeaders === 5 && piiCells === 3 && uncited.length === 0,
      value: `${piiHeaders}/5 PII headers · ${piiCells}/3 ID cells (spaced Aadhaar, Aadhaar, PEN) refused · ${cited}/${cycle.gaps.length} cited`,
      valueHi: `${piiHeaders}/5 PII शीर्षक · ${piiCells}/3 पहचान संख्या (रिक्ति वाला आधार, आधार, PEN) रोकी · ${cited}/${cycle.gaps.length} उद्धृत` },
  ];
}

function runtimeChecks(cycle: CycleIn): SelfCheck[] {
  const s = cycle.summary;
  const cost = projectMonthCost();
  const price = modelPrice(CONFIG.pricing.model);
  const expected = ((cost.tokensIn / 1e6) * (price.input_usd_per_mtok ?? 0) + (cost.tokensOut / 1e6) * (price.output_usd_per_mtok ?? 0)) * CONFIG.pricing.usd_to_inr;
  const costOk = Math.abs(expected - cost.inr) < 0.01 && Math.abs(cost.bufferedInr - 2 * cost.inr) < 1e-9 && cost.sttLow < cost.sttHigh;
  const fixtures: [string, ReplyParse["parsed_status"], boolean, number][] = [
    ["हो गया सर", "done", false, 1], ["done, photo attached", "done", false, 1], ["आधा हुआ है, 5 स्कूल बाकी हैं", "partial", false, 1],
    ["Partly done, 5 schools remaining", "partial", false, 1], ["BLO ड्यूटी के कारण अभी शुरू नहीं हो पाया", "blocked", false, 1],
    ["Blocked due to BLO election duty", "blocked", false, 1], ["", "unknown", true, 2], ["ठीक है शायद", "unknown", false, 1],
    ["not done yet", "blocked", false, 1], ["अभी नहीं हुआ", "blocked", false, 1],
  ];
  const hits = fixtures.filter(([text, want, photo, open]) => parseFieldReply(text, { openTasks: open, hasPhoto: photo }).parsed_status === want).length;
  return [
    { id: "4.1", en: "Pipeline compute stays under 0.1 s for the block", hi: "विकासखंड की गणना 0.1 सेकंड से कम रहती है", pass: s.runtime_s < 0.1,
      value: `${s.runtime_s.toFixed(3)} s for ${s.schools} schools (server)`, valueHi: `${s.schools} विद्यालयों के लिए ${s.runtime_s.toFixed(3)} सेकंड (सर्वर)` },
    { id: "4.2", en: "Monthly model cost follows from the model registry", hi: "मासिक मॉडल लागत मॉडल रजिस्टर से निकलती है", pass: costOk,
      value: `${cost.tokensIn.toLocaleString("en-IN")} in + ${cost.tokensOut.toLocaleString("en-IN")} out ≈ ₹${cost.inr.toFixed(2)} (₹${cost.bufferedInr.toFixed(2)} with 2× buffer) + ₹${cost.sttLow}–${cost.sttHigh} speech per block-month`,
      valueHi: `${cost.tokensIn.toLocaleString("en-IN")} इनपुट + ${cost.tokensOut.toLocaleString("en-IN")} आउटपुट ≈ ₹${cost.inr.toFixed(2)} (2× बफ़र सहित ₹${cost.bufferedInr.toFixed(2)}) + ₹${cost.sttLow}–${cost.sttHigh} वाक्, प्रति विकासखंड-माह` },
    { id: "4.3", en: "Offline reply baseline reads short Hindi/English replies, negations included", hi: "ऑफलाइन उत्तर आधार छोटे हिन्दी/अंग्रेज़ी उत्तर पढ़ता है, नकार सहित", pass: hits === fixtures.length,
      value: `${hits}/${fixtures.length} fixtures, 2 negations · Laya + Claude handle the rest on the server`,
      valueHi: `${fixtures.length} में से ${hits} उत्तर, 2 नकार सहित · बाकी सर्वर पर Laya + Claude` },
  ];
}

/**
 * Twelve checks re-run in the browser against this cycle and the engine's own
 * functions. They show the guardrails work on this data; they are not a score.
 */
export function runSelfChecks(cycle: CycleIn): SelfCheck[] {
  return [...dataChecks(cycle), ...loopChecks(cycle), ...guardChecks(cycle), ...runtimeChecks(cycle)];
}
