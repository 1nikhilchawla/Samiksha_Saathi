import { BENCHMARK_LINE } from "@/components/samiksha/architecture-panel";
import { Chip, Panel } from "@/components/samiksha/ui";
import { CONFIG, STATE_CODES, projectMonthCost } from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";
import { useView } from "@/lib/samiksha/view";
import { WHATSAPP_GRAPH_VERSION, WHATSAPP_TEMPLATES } from "@/lib/samiksha/whatsapp";

type Copy = { en: string; hi: string };
type Status = "live" | "built" | "reference" | "plan";

const STATUS: Record<Status, { tone: "seal" | "ok" | "plain" | "flag"; label: Copy }> = {
  live: { tone: "ok", label: { en: "Live in the pilot", hi: "पायलट में चालू" } },
  built: { tone: "seal", label: { en: "Built, not yet live", hi: "बना, अभी चालू नहीं" } },
  reference: { tone: "plain", label: { en: "Reference figure", hi: "संदर्भ आँकड़ा" } },
  plan: { tone: "plain", label: { en: "Plan", hi: "योजना" } },
};

/** The government systems the app reads or talks to, and the rollout plan. Each row says plainly what is running and what is not. */
export function RoadmapPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { bot } = useView();
  const cost = projectMonthCost();
  const STATE_BLOCKS = 313;

  const systems: { name: string; status: Status; what: Copy }[] = [
    {
      name: "UDISE+ (2024-25 / 2025-26)",
      status: "built",
      what: {
        en: "Reads the UDISE+ export shape: 11-digit school codes normalised, the teacher and maths-vacancy columns as the school spine, the Grade 3 roll as the denominator. The demo runs on synthetic files in that shape, not on a live UDISE+ connection.",
        hi: "UDISE+ निर्यात का ढाँचा पढ़ता है: 11 अंकों के कोड सुधार, शिक्षक व गणित रिक्ति स्तंभ, कक्षा 3 संख्या। डेमो उसी ढाँचे की सिंथेटिक फाइलों पर है, UDISE+ से सीधा जुड़ाव नहीं।",
      },
    },
    {
      name: "PARAKH Rashtriya Sarvekshan (C-8.4)",
      status: "reference",
      what: {
        en: `The brief quotes the national Grade 3 average on ${CONFIG.context_stats.competency}: ${CONFIG.context_stats.parakh_g3_c84_avg_pct}%. It is a fixed reference, not a data feed.`,
        hi: `एजेंडा ${CONFIG.context_stats.competency} पर कक्षा 3 का राष्ट्रीय औसत ${CONFIG.context_stats.parakh_g3_c84_avg_pct}% बताता है। यह स्थिर संदर्भ है, डेटा स्रोत नहीं।`,
      },
    },
    {
      name: `State VSK exports (${STATE_CODES.join(", ")})`,
      status: "built",
      what: {
        en: `${BENCHMARK_LINE.en} Each file's state is detected from its headers; Haryana's level scale loses one gap to its banding; another state needs its own adapter.`,
        hi: `${BENCHMARK_LINE.hi} हर फाइल का राज्य उसके शीर्षकों से पहचाना जाता है; हरियाणा के स्तर पैमाने में एक अंतर छूटता है; अन्य राज्य को अपना प्रारूप चाहिए।`,
      },
    },
    {
      name: `Telegram Bot API (@${bot.username})`,
      status: bot.live ? "live" : "built",
      what: {
        en: "Task cards, replies, /seed, /tasks, /approve, /send, /weekly, /why, /link, /whoami, through a fact-checked queue of at most 25 messages a second. The webhook route is /api/telegram/webhook; the production webhook is not registered yet.",
        hi: "कार्य कार्ड, उत्तर, /seed, /tasks, /approve, /send, /weekly, /why, /link, /whoami, तथ्य-जाँच वाली कतार से, अधिकतम 25 संदेश प्रति सेकंड। वेबहुक मार्ग /api/telegram/webhook; उत्पादन वेबहुक अभी पंजीकृत नहीं।",
      },
    },
    {
      name: `Meta WhatsApp Business Cloud API (${WHATSAPP_GRAPH_VERSION})`,
      status: "built",
      what: {
        en: `Utility templates ${WHATSAPP_TEMPLATES.en} / ${WHATSAPP_TEMPLATES.hi}, the sender, and /api/whatsapp/webhook (signed replies recorded like Telegram ones). Live once Meta approves the templates and the keys are set.`,
        hi: `यूटिलिटी टेम्पलेट ${WHATSAPP_TEMPLATES.en} / ${WHATSAPP_TEMPLATES.hi}, प्रेषक, और /api/whatsapp/webhook (हस्ताक्षरित उत्तर टेलीग्राम जैसे दर्ज)। Meta टेम्पलेट स्वीकृति व कुंजियों के बाद चालू।`,
      },
    },
  ];

  const phases: { name: Copy; scope: Copy; what: Copy }[] = [
    {
      name: { en: "Phase 1 · months 1–2", hi: "चरण 1 · माह 1–2" },
      scope: { en: "One block: Kesli, 110 schools", hi: "एक ब्लॉक: केसली, 110 विद्यालय" },
      what: {
        en: `The block's monthly exports in, the BEO's monthly review run from the brief, the Telegram loop with field staff. Target: at least ${CONFIG.pilot_targets.action_closure_rate_pct}% of actions closed on time.`,
        hi: `ब्लॉक के मासिक निर्यात, एजेंडा से BEO की मासिक समीक्षा, मैदानी कर्मियों के साथ टेलीग्राम चक्र। लक्ष्य: कम से कम ${CONFIG.pilot_targets.action_closure_rate_pct}% कार्य समय पर बंद।`,
      },
    },
    {
      name: { en: "Phase 2 · months 3–6", hi: "चरण 2 · माह 3–6" },
      scope: { en: "Sagar district, block by block", hi: "सागर जिला, ब्लॉक दर ब्लॉक" },
      what: {
        en: "The DEO's district view on measured blocks instead of the declared baseline, Bhashini speech-to-text for Bundeli and Hindi voice notes, and academic support routed to the DIET.",
        hi: "घोषित आधार के बजाय मापे गए ब्लॉकों पर DEO का जिला दृश्य, बुंदेली व हिन्दी वॉइस नोट के लिए भाषिणी वाणी-से-पाठ, और DIET को शैक्षणिक सहायता।",
      },
    },
    {
      name: { en: "Phase 3 · months 6–12", hi: "चरण 3 · माह 6–12" },
      scope: { en: `State VSK, ${STATE_BLOCKS} blocks`, hi: `राज्य VSK, ${STATE_BLOCKS} ब्लॉक` },
      what: {
        en: `Exports pulled from the state VSK through NDEAR-style APIs instead of uploads. Model cost at today's prices: about ₹${cost.inr.toFixed(2)} a block a month, about ₹${Math.round(cost.inr * STATE_BLOCKS).toLocaleString("en-IN")} a month for ${STATE_BLOCKS} blocks, before the 2x buffer and speech-to-text.`,
        hi: `अपलोड के बजाय NDEAR जैसे API से राज्य VSK निर्यात। आज के दाम पर मॉडल लागत: प्रति ब्लॉक माह लगभग ₹${cost.inr.toFixed(2)}, ${STATE_BLOCKS} ब्लॉक के लिए लगभग ₹${Math.round(cost.inr * STATE_BLOCKS).toLocaleString("en-IN")} माह, 2 गुना बफर व वाणी-से-पाठ से पहले।`,
      },
    },
  ];

  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Existing systems and the rollout plan" : "मौजूदा प्रणालियाँ व विस्तार योजना"}</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        {en ? "What the app reads or talks to today, marked by what is actually running, then the three phases ahead." : "ऐप आज क्या पढ़ता या जोड़ता है, वास्तव में क्या चल रहा है उसके साथ, फिर आगे के तीन चरण।"}
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="py-2 pr-3 font-semibold">{en ? "System" : "प्रणाली"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Status" : "स्थिति"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "What it does here" : "यहाँ क्या करता है"}</th>
            </tr>
          </thead>
          <tbody>
            {systems.map((s) => (
              <tr key={s.name} className="border-b border-rule/60 align-top">
                <td className="py-2 pr-3 font-medium">{s.name}</td>
                <td className="py-2 pr-3"><Chip tone={STATUS[s.status].tone}>{STATUS[s.status].label[lang]}</Chip></td>
                <td className="py-2 pr-3">{s.what[lang]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="py-2 pr-3 font-semibold">{en ? "Phase" : "चरण"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Scope" : "दायरा"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "What happens" : "क्या होगा"}</th>
            </tr>
          </thead>
          <tbody>
            {phases.map((p) => (
              <tr key={p.name.en} className="border-b border-rule/60 align-top">
                <td className="py-2 pr-3 font-medium">
                  {p.name[lang]} <Chip tone={STATUS.plan.tone}>{STATUS.plan.label[lang]}</Chip>
                </td>
                <td className="py-2 pr-3">{p.scope[lang]}</td>
                <td className="py-2 pr-3">{p.what[lang]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
