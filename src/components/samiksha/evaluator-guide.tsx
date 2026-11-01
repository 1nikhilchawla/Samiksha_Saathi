import { useEffect, useState } from "react";
import { Btn } from "@/components/samiksha/ui";
import { useCycle, type Copy, type TabId } from "@/lib/samiksha/store";

const CLOSED_KEY = "samiksha.evaluatorGuide.closed";
const REPO = "https://github.com/1nikhilchawla/Samiksha_Saathi";

/** A five-minute path through the app, each step with what should happen. */
const STEPS: { tab: TabId | null; title: Copy; body: Copy }[] = [
  {
    tab: null,
    title: { en: "Pick a role", hi: "भूमिका चुनें" },
    body: {
      en: "Officer view, at the top. Start as BEO (level 3, the default). HM and CRCC hold field powers only and get a Switch to BEO button; DEO adds the district view; SPD can change the thresholds.",
      hi: "ऊपर अधिकारी स्तर चुनें। BEO (स्तर 3, डिफ़ॉल्ट) से शुरू करें। HM व CRCC के पास केवल मैदानी अधिकार हैं और उन्हें BEO पर जाने का बटन मिलता है; DEO को जिला दृश्य मिलता है; SPD सीमाएँ बदल सकता है।",
    },
  },
  {
    tab: "upload",
    title: { en: "Step 1 · Join", hi: "चरण 1 · जोड़" },
    body: {
      en: "The block's 7 messy exports are already loaded: 548 assessment rows, 9 data problems, 110 school codes fixed, 4 flags, in under 0.1 s. Press Test Student PII Blocker: the student file is refused.",
      hi: "विकासखंड की 7 अव्यवस्थित फाइलें पहले से लोड हैं: 548 आकलन पंक्तियाँ, 9 डेटा समस्याएँ, 110 कोड सुधरे, 4 ध्वज, 0.1 सेकंड से कम में। विद्यार्थी फाइल रोकें दबाएँ: विद्यार्थी फाइल अस्वीकार होती है।",
    },
  },
  {
    tab: "brief",
    title: { en: "Step 2 · Brief", hi: "चरण 2 · ब्रीफ" },
    body: {
      en: "The Top 5 gaps, every number cited to a file and a row. The excuse check sets this block's −9.0 pts against 4 election-year peers (−1.5 to +1.4).",
      hi: "शीर्ष 5 अंतर, हर अंक फाइल और पंक्ति से जुड़ा। बहाना जाँच इस विकासखंड के −9.0 अंक को 4 समान चुनाव-वर्ष विकासखंडों (−1.5 से +1.4) से मिलाती है।",
    },
  },
  {
    tab: "approve",
    title: { en: "Step 3 · Decide", hi: "चरण 3 · निर्णय" },
    body: {
      en: "Load Sample Voice Note → Extract Draft Tasks → Approve All Complete Drafts → Send Approved Tasks to Bot. Then try the Punitive note and Injected instruction samples, and Test Gate: Try Sending Unapproved Drafts.",
      hi: "नमूना वॉइस नोट लोड करें → ड्राफ्ट कार्य निकालें → सभी पूर्ण ड्राफ्ट अनुमोदित करें → अनुमोदित कार्य भेजें। फिर दंडात्मक नोट, छिपा निर्देश और गेट जाँच आज़माएँ।",
    },
  },
  {
    tab: "follow",
    title: { en: "Step 4 · Follow up", hi: "चरण 4 · फॉलो-अप" },
    body: {
      en: "Try the field-reply reader: done, not done, injected. Open Visual proof and consent gate and use the Simulate buttons: the group photo passes, the close-up is refused.",
      hi: "मैदानी उत्तर पाठक आज़माएँ: हो गया, नहीं हुआ, छिपा निर्देश। दृश्य प्रमाण गेट खोलें और नमूना बटन दबाएँ: समूह फोटो पास, क्लोज़-अप अस्वीकार।",
    },
  },
  {
    tab: "score",
    title: { en: "Step 5 · Scorecard", hi: "चरण 5 · स्कोरकार्ड" },
    body: {
      en: "Load Round 4 (R4) & Close Loop: the Action Closure Rate, and each school's learning change against matched schools.",
      hi: "चक्र 4 लोड करें: कार्य पूर्णता दर, और हर विद्यालय का अधिगम बदलाव मिलते-जुलते विद्यालयों की तुलना में।",
    },
  },
  {
    tab: null,
    title: { en: "Offline", hi: "ऑफ़लाइन" },
    body: {
      en: "Press 📶 Network: Online in the header. The whole review keeps working with no network; only Claude's reorder and sending wait for the signal.",
      hi: "हेडर में 📶 नेटवर्क दबाएँ। पूरी समीक्षा बिना नेटवर्क चलती रहती है; केवल Claude का क्रम और भेजना सिग्नल का इंतज़ार करते हैं।",
    },
  },
];

/** Open on first visit so an evaluator knows where to start; folds away once closed. */
export function EvaluatorGuide() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const setTab = useCycle((s) => s.setTab);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(CLOSED_KEY) === "1") setOpen(false);
    } catch {
      // Storage blocked: keep the guide open.
    }
  }, []);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      if (next) localStorage.removeItem(CLOSED_KEY);
      else localStorage.setItem(CLOSED_KEY, "1");
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  };
  return (
    <div className="no-print rounded-xl border border-seal bg-seal-soft">
      <button type="button" aria-expanded={open} onClick={toggle} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="font-semibold">{en ? "🧭 Evaluator guide: the whole loop in 5 minutes, no login" : "🧭 मूल्यांकन मार्गदर्शिका: पूरा चक्र 5 मिनट में, बिना लॉगिन"}</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="border-t border-seal px-4 py-4">
          <ol className="grid gap-3 md:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.title.en} className="rounded-lg border border-rule bg-sheet p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{`${i + 1}. ${s.title[lang]}`}</p>
                  {s.tab ? (
                    <Btn kind="ghost" onClick={() => setTab(s.tab!)}>
                      {en ? "Go" : "जाएँ"}
                    </Btn>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted">{s.body[lang]}</p>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm">
            {en ? "Files to upload yourself (exports, guardrail files, photos): " : "स्वयं अपलोड करने हेतु फाइलें (निर्यात, गार्डरेल फाइलें, फोटो): "}
            <a className="font-semibold text-seal underline" href={`${REPO}/tree/main/public/samples`} target="_blank" rel="noreferrer">
              public/samples
            </a>
            {en ? " · Written guide with expected results: " : " · अपेक्षित परिणामों सहित लिखित मार्गदर्शिका: "}
            <a className="font-semibold text-seal underline" href={`${REPO}/blob/main/EVALUATOR_GUIDE.md`} target="_blank" rel="noreferrer">
              EVALUATOR_GUIDE.md
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
