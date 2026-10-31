import { useState } from "react";
import { Btn, Chip } from "@/components/samiksha/ui";
import { QUEUE_LIMITS, STATE_CODES, ACTION_LIBRARY, projectMonthCost, type Cycle, type Scorecard, type Task } from "@/lib/samiksha/engine";
import { MAX_BRIEF_RERANKS_PER_MONTH } from "@/lib/samiksha/narrate";
import { useCycle, type TabId } from "@/lib/samiksha/store";
import { useView } from "@/lib/samiksha/view";

type Copy = { en: string; hi: string };
type Lang = "en" | "hi";

/** The one benchmark sentence, worded the same here, on the roadmap and in the architecture report. */
export const BENCHMARK_LINE: Copy = {
  en: "4 state VSK format adapters (MP, UP, PB, HR), checked on a 33-block multi-format test and on a 313-block scale run of this block's files (median under 10 ms a block), all on demo data.",
  hi: "4 राज्य VSK प्रारूप (MP, UP, PB, HR), 33-ब्लॉक बहु-प्रारूप जाँच और सीडेड ब्लॉक के 313-ब्लॉक पैमाना परीक्षण (मध्य 10 ms प्रति ब्लॉक से कम) पर जाँचे गए, सब सिंथेटिक डेटा पर।",
};

/**
 * One line under each stage: what runs underneath it. The counts come from the
 * cycle on screen, so an upload with other numbers gets other lines.
 */
export function stageNote(tab: TabId, cycle: Cycle | null): Copy {
  const s = cycle?.summary;
  const p = cycle?.peer;
  switch (tab) {
    case "upload":
      return {
        en: `Reads ${STATE_CODES.length} state VSK formats (${STATE_CODES.join(", ")}), refuses student-level data, and marks a Grade 3 roll under 5 as small-sample noise.`,
        hi: `${STATE_CODES.length} राज्य VSK प्रारूप (${STATE_CODES.join(", ")}) पढ़ता है, विद्यार्थी-स्तर डेटा रोकता है, और 5 से कम कक्षा 3 संख्या को छोटा नमूना मानता है।`,
      };
    case "brief":
      return {
        en: `Code finds ${cycle?.gaps.length ?? 5} gaps and ${s?.flags ?? 4} flags and ranks ${cycle?.allRankedGaps?.length ?? 15}; the excuse check sets ${p ? p.pilotDelta.toFixed(1) : "-9.0"} against ${p ? p.matchedDeltas.map((d) => d.toFixed(1)).join(", ") : "its peers"}; Claude only reorders, behind five Laya checks.`,
        hi: `कोड ${cycle?.gaps.length ?? 5} अंतर व ${s?.flags ?? 4} ध्वज पाता है और ${cycle?.allRankedGaps?.length ?? 15} का क्रम बनाता है; बहाना जाँच ${p ? p.pilotDelta.toFixed(1) : "-9.0"} की तुलना ${p ? p.matchedDeltas.map((d) => d.toFixed(1)).join(", ") : "साथियों"} से; Claude केवल क्रम बदलता है, चार लाया जाँचों के पीछे।`,
      };
    case "approve":
      return {
        en: "Hinge studio for compound crises; a voice note becomes drafts from #14; Laya proposes a missing owner and date; approval needs level 3 (BEO).",
        hi: "जटिल संकटों के लिए निर्णायक स्टूडियो; वॉइस नोट #14 से ड्राफ्ट बनता है; लाया छूटे जिम्मेदार व तिथि सुझाता है; अनुमोदन के लिए स्तर 3 (BEO)।",
      };
    case "follow":
      return {
        en: `Every message is fact-checked before the queue; the queue sends at most ${QUEUE_LIMITS.globalPerSecond} a second; a proof photo is blurred on the phone, checked again on the server and stored encrypted.`,
        hi: `हर संदेश कतार से पहले तथ्य-जाँच से गुजरता है; कतार एक सेकंड में अधिकतम ${QUEUE_LIMITS.globalPerSecond} भेजती है; प्रमाण फोटो फोन पर धुंधली, सर्वर पर फिर जाँची और एन्क्रिप्ट होकर रखी जाती है।`,
      };
    case "score":
      return {
        en: "Round 4 tests the learning change against matched schools and catches a \"done\" with no change behind it.",
        hi: "राउंड 4 मिलान वाले विद्यालयों से सीखने का बदलाव जाँचता है और बिना बदलाव वाले \"पूर्ण\" को पकड़ता है।",
      };
  }
}

const LAYERS: { name: Copy; what: Copy }[] = [
  { name: { en: "1 · Ingest and privacy", hi: "1 · डेटा व गोपनीयता" }, what: { en: "State format adapters, header mapping, the student-data guard, 5 MiB and 10,000-row limits per file.", hi: "राज्य प्रारूप, शीर्षक मिलान, विद्यार्थी-डेटा गार्ड, प्रति फाइल 5 MiB व 10,000 पंक्ति सीमा।" } },
  { name: { en: "2 · Deterministic engine", hi: "2 · निश्चित इंजन" }, what: { en: "Join, auto-fix school codes, gaps and flags on SPD-editable thresholds, the small-sample guard and the peer excuse check. Same files, same answer.", hi: "जोड़, कोड सुधार, SPD द्वारा बदलने योग्य सीमाओं पर अंतर व ध्वज, छोटा-नमूना गार्ड, बहाना जाँच। वही फाइलें, वही उत्तर।" } },
  { name: { en: "3 · Language model", hi: "3 · भाषा मॉडल" }, what: { en: `Claude reorders the Top 5, 10 or 15 and writes the reasons, and reads messy field replies. At most ${MAX_BRIEF_RERANKS_PER_MONTH} reorders a month; a repeat comes from the stored order.`, hi: `Claude शीर्ष 5, 10 या 15 का क्रम व कारण लिखता है और उत्तर पढ़ता है। माह में अधिकतम ${MAX_BRIEF_RERANKS_PER_MONTH} क्रम; दोहराने पर सहेजा क्रम।` } },
  { name: { en: "4 · Laya second check", hi: "4 · लाया दूसरी जाँच" }, what: { en: "Numbers from the facts, actions from the library, citations present, every gap once; a negated reply is never read as done.", hi: "अंक तथ्यों से, कार्य सूची से, स्रोत मौजूद, हर अंतर एक बार; नकारात्मक उत्तर कभी पूर्ण नहीं।" } },
  { name: { en: "5 · Officer gate", hi: "5 · अधिकारी द्वार" }, what: { en: "Five cumulative levels (HM 1 to SPD 5) on a signed session; nothing goes out before a level-3 approval; a database trigger checks the role on task writes.", hi: "पाँच स्तर (HM 1 से SPD 5) हस्ताक्षरित सत्र पर; स्तर-3 अनुमोदन के बिना कुछ नहीं जाता; कार्य बदलने पर डेटाबेस भूमिका जाँचता है।" } },
  { name: { en: "6 · Delivery", hi: "6 · वितरण" }, what: { en: "Fact-check before the queue, a durable queue paced for Telegram, the bot for replies; a WhatsApp route built for the same loop.", hi: "कतार से पहले तथ्य-जाँच, टेलीग्राम हेतु गति-नियंत्रित कतार, उत्तरों के लिए बॉट; उसी चक्र हेतु WhatsApp मार्ग।" } },
  { name: { en: "7 · Evidence vault", hi: "7 · प्रमाण तिजोरी" }, what: { en: "Faces blurred on the phone, the stored JPEG checked again on the server, AES-256-GCM at rest, three consent tiers each signed a level higher.", hi: "चेहरे फोन पर धुंधले, सर्वर पर दोबारा जाँच, AES-256-GCM एन्क्रिप्शन, तीन सहमति स्तर।" } },
  { name: { en: "8 · Outcome loop", hi: "8 · परिणाम चक्र" }, what: { en: "Round 4 scorecard, the box-tick catch, hinge points, rewards held for a flat \"done\", and a cost ledger of every model call.", hi: "राउंड 4 स्कोरकार्ड, कागज़ी पूर्ण की पकड़, निर्णायक मोड़, सपाट पूर्ण पर रुका पुरस्कार, हर मॉडल कॉल का लागत खाता।" } },
];

type TraceStep = { label: Copy; value: Copy };

/** One school (or cluster) from data to outcome, from the records on screen. */
function trace(target: string, cycle: Cycle, tasks: Task[], score: Scorecard | null): TraceStep[] {
  const isCluster = target.startsWith("Cluster ");
  const schools = isCluster ? cycle.schools.filter((s) => s.cluster === target.slice("Cluster ".length)) : cycle.schools.filter((s) => s.nameEn === target);
  const codes = new Set(schools.map((s) => s.code));
  const gaps = (cycle.allRankedGaps ?? cycle.gaps).filter((g) => g.targetCodes.some((c) => codes.has(c)) && (!isCluster || g.targetType === "cluster"));
  const own = tasks.filter((t) => t.targetCodes.some((c) => codes.has(c)) && (!isCluster || t.targetCodes.length > 1));
  const school = schools[0];
  const steps: TraceStep[] = [];
  steps.push({
    label: { en: "Data", hi: "डेटा" },
    value: school
      ? isCluster
        ? { en: `${schools.length} schools in ${target}.`, hi: `${target} में ${schools.length} विद्यालय।` }
        : { en: `Grade 3 R2 ${school.r2 ?? "—"}% → R3 ${school.r3 ?? "—"}%; maths post ${school.mathsPost}; ${school.workingTeachers} working teacher(s).`, hi: `कक्षा 3 R2 ${school.r2 ?? "—"}% → R3 ${school.r3 ?? "—"}%; गणित पद ${school.mathsPost}; ${school.workingTeachers} कार्यरत शिक्षक।` }
      : { en: "Not in this cycle's files.", hi: "इस चक्र की फाइलों में नहीं।" },
  });
  steps.push({
    label: { en: "Gap", hi: "अंतर" },
    value: gaps.length
      ? { en: gaps.map((g) => `#${g.codeRank} ${g.factEn}`).join(" "), hi: gaps.map((g) => `#${g.codeRank} ${g.factHi}`).join(" ") }
      : { en: "No gap ranked for it in this cycle.", hi: "इस चक्र में इसका कोई अंतर नहीं।" },
  });
  steps.push({
    label: { en: "Task", hi: "कार्य" },
    value: own.length
      ? { en: own.map((t) => `#${t.id} ${ACTION_LIBRARY[t.actionId].name_en} (${t.status})`).join("; "), hi: own.map((t) => `#${t.id} ${ACTION_LIBRARY[t.actionId].name_hi} (${t.status})`).join("; ") }
      : { en: "No task yet: draft one from the voice note in Stage 3.", hi: "अभी कार्य नहीं: चरण 3 में वॉइस नोट से ड्राफ्ट बनाएँ।" },
  });
  const tick = score?.boxTicks.find((b) => b.school === target);
  const single = score?.singles.find((s) => s.name === target);
  steps.push({
    label: { en: "Round 4", hi: "राउंड 4" },
    value: !score
      ? { en: "Waits for Round 4 (Stage 5).", hi: "राउंड 4 की प्रतीक्षा (चरण 5)।" }
      : tick
        ? { en: `Flat after a "done": ${tick.detailEn} The reward is held and a coaching note is ready.`, hi: `"पूर्ण" के बाद सपाट: ${tick.detailHi} पुरस्कार रुका, मार्गदर्शन नोट तैयार।` }
        : target === "PS Khedi"
          ? { en: `R3 ${score.khedi.r3}% → R4 ${score.khedi.r4}% (${score.khedi.delta >= 0 ? "+" : ""}${score.khedi.delta} pts) against matched schools at ${score.matchedMean >= 0 ? "+" : ""}${score.matchedMean}.`, hi: `R3 ${score.khedi.r3}% → R4 ${score.khedi.r4}% (${score.khedi.delta} अंक), मिलान विद्यालय ${score.matchedMean}।` }
          : isCluster
            ? { en: `Observations on time in ${score.c6.observedOnTime} of ${score.c6.schools} schools; cluster change ${score.c6.delta >= 0 ? "+" : ""}${score.c6.delta} pts.`, hi: `${score.c6.schools} में से ${score.c6.observedOnTime} में अवलोकन समय पर; बदलाव ${score.c6.delta} अंक।` }
            : single
              ? { en: `R3 ${single.r3}% → R4 ${single.r4}%.`, hi: `R3 ${single.r3}% → R4 ${single.r4}%।` }
              : { en: "No Round 4 reading for it.", hi: "इसका राउंड 4 मान नहीं।" },
  });
  return steps;
}

const TRACES = ["PS Khedi", "PS Sitapur", "Cluster C6"] as const;

function qa(cost: ReturnType<typeof projectMonthCost>): { q: Copy; a: Copy }[] {
  return [
    {
      q: { en: "Can the AI invent a number?", hi: "क्या एआई कोई अंक गढ़ सकता है?" },
      a: { en: "No figure comes from the model. Code computes every number; the model only orders the list and words the reason, and any digit not in the facts is refused. The \"Inject 42%\" button in Stage 2 shows the refusal.", hi: "कोई अंक मॉडल से नहीं आता। हर अंक कोड गिनता है; मॉडल केवल क्रम व कारण लिखता है, और तथ्यों में न मिला अंक रोका जाता है। चरण 2 का \"42% डालें\" बटन यह दिखाता है।" },
    },
    {
      q: { en: "Can someone pose as a senior officer?", hi: "क्या कोई वरिष्ठ अधिकारी बनकर काम कर सकता है?" },
      a: { en: "The server reads the role from a signed session token, not from the browser. There is no sign-in yet: this preview issues a session for whichever role is picked. Sign-in is the next step.", hi: "सर्वर भूमिका हस्ताक्षरित सत्र टोकन से पढ़ता है, ब्राउज़र से नहीं। अभी लॉगिन नहीं है: यह पूर्वावलोकन चुनी गई भूमिका का सत्र देता है। लॉगिन अगला कदम है।" },
    },
    {
      q: { en: "How are children protected?", hi: "बच्चों की सुरक्षा कैसे है?" },
      a: { en: "Only school-level data is read; a file with student names or Aadhaar-like numbers is refused. A proof photo is blurred on the phone, checked again on the server (a close-up of one child is refused), encrypted, and opened only after consent at two levels.", hi: "केवल विद्यालय-स्तर डेटा; विद्यार्थी नाम या आधार जैसे अंक वाली फाइल रोकी जाती है। प्रमाण फोटो फोन पर धुंधली, सर्वर पर दोबारा जाँची (एक बच्चे का क्लोज़-अप रोका), एन्क्रिप्ट, और दो स्तरों की सहमति के बाद ही खुलती है।" },
    },
    {
      q: { en: "Does it scale beyond one block?", hi: "क्या यह एक ब्लॉक से आगे चलेगा?" },
      a: { en: `${BENCHMARK_LINE.en} The 313-block run finishes in under 2.5 s.`, hi: `${BENCHMARK_LINE.hi} 313-ब्लॉक परीक्षण 2.5 सेकंड से कम में पूरा।` },
    },
    {
      q: { en: "What does it cost?", hi: "लागत क्या है?" },
      a: { en: `About ₹${cost.inr.toFixed(2)} of model tokens per block a month (₹${cost.bufferedInr.toFixed(0)} with a 2x buffer), plus ₹${cost.sttLow}–${cost.sttHigh} of speech-to-text. ${313} blocks: about ₹${Math.round(cost.inr * 313).toLocaleString("en-IN")} a month before the buffer.`, hi: `प्रति ब्लॉक माह लगभग ₹${cost.inr.toFixed(2)} मॉडल टोकन (2 गुना बफर सहित ₹${cost.bufferedInr.toFixed(0)}), साथ में ₹${cost.sttLow}–${cost.sttHigh} वाणी-से-पाठ। 313 ब्लॉक: बफर से पहले लगभग ₹${Math.round(cost.inr * 313).toLocaleString("en-IN")} माह।` },
    },
    {
      q: { en: "What if a field worker just replies \"done\"?", hi: "अगर कोई केवल \"हो गया\" लिख दे?" },
      a: { en: "Round 4 checks the outcome. A \"done\" with no change behind it is flagged as a box-tick, the reward is held, and a coaching note goes instead.", hi: "राउंड 4 परिणाम जाँचता है। बिना बदलाव वाला \"पूर्ण\" कागज़ी माना जाता है, पुरस्कार रुकता है, मार्गदर्शन नोट जाता है।" },
    },
    {
      q: { en: "Is the data real?", hi: "क्या डेटा वास्तविक है?" },
      a: { en: "No. It is a synthetic pilot block of 110 schools built to the shape of real exports; no student data is used.", hi: "नहीं। यह 110 विद्यालयों का सिंथेटिक पायलट ब्लॉक है, वास्तविक निर्यात के ढाँचे पर; कोई विद्यार्थी डेटा नहीं।" },
    },
  ];
}

/** How the parts fit, one school traced end to end, and the questions a jury asks. */
export function ArchitecturePanel() {
  const lang = useCycle((s) => s.lang) as Lang;
  const en = lang === "en";
  const setTab = useCycle((s) => s.setTab);
  const { cycle, tasks, scorecard } = useView();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<(typeof TRACES)[number]>("PS Khedi");
  if (!cycle) return null;
  const cost = projectMonthCost();
  return (
    <div className="no-print rounded-xl border border-rule bg-sheet">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="font-semibold">{en ? "🔗 How it works: 8 layers, one school traced, and common questions" :"🔗 यह कैसे काम करता है: 8 परतें, एक विद्यालय का सफर, और सामान्य प्रश्न"}</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-6 border-t border-rule px-4 py-4">
          <ol className="grid gap-3 md:grid-cols-2">
            {LAYERS.map((l) => (
              <li key={l.name.en} className="rounded-lg border border-rule bg-paper/60 p-3">
                <p className="text-sm font-semibold">{l.name[lang]}</p>
                <p className="mt-1 text-xs text-muted">{l.what[lang]}</p>
              </li>
            ))}
          </ol>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{en ? "End-to-end trace" : "शुरू से अंत तक"}</p>
              {TRACES.map((t) => (
                <Btn key={t} kind={t === target ? "primary" : "ghost"} onClick={() => setTarget(t)}>
                  {t}
                </Btn>
              ))}
            </div>
            <ol className="mt-3 space-y-2">
              {trace(target, cycle, tasks, scorecard).map((s) => (
                <li key={s.label.en} className="flex gap-3 text-sm">
                  <Chip tone="seal">{s.label[lang]}</Chip>
                  <span className="min-w-0">{s.value[lang]}</span>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <p className="text-sm font-semibold">{en ? "Common questions" : "सामान्य प्रश्न"}</p>
            <dl className="mt-2 space-y-3">
              {qa(cost).map((x) => (
                <div key={x.q.en}>
                  <dt className="text-sm font-semibold">{x.q[lang]}</dt>
                  <dd className="mt-0.5 text-sm text-muted">{x.a[lang]}</dd>
                </div>
              ))}
            </dl>
          </div>

          <Btn kind="soft" onClick={() => setTab("score")}>
            {en ? "Integrations and roadmap (Stage 5) →" : "एकीकरण व रोडमैप (चरण 5) →"}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
