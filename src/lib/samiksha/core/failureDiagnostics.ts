/**
 * Two-stage failure diagnosis, shared by the web app and the bot's /why.
 *
 * Stage 1 is the gate that refused something (a size limit, the student-data
 * guard, the photo checks, the approval gate, the Telegram fact-check). It
 * records a code, the facts behind it and how sure it is: a fixed rule is
 * certain (1.0); the photo heuristic reports its own rule score.
 * Stage 2 explains why it failed and how to fix it. The explanation here is
 * built from the same facts, so it is exact and free; the server may ask the
 * model to reword it in plainer language when someone asks /why, and that
 * rewording must pass the number check before it is shown.
 */
type Copy = { en: string; hi: string };

export type FailureSurface = "upload_file" | "classroom_image" | "task_approval" | "task_dispatch" | "telegram_fact_check" | "cleaning_rule" | "role" | "model_input";

export type FailureCode =
  | "FILE_SIZE_LIMIT_EXCEEDED"
  | "STUDENT_PII_DETECTED"
  | "FILE_TYPE_NOT_READ"
  | "PHOTO_BLURRY_OR_DARK"
  | "PHOTO_SINGLE_CHILD"
  | "PHOTO_NOT_CLASSROOM"
  | "PHOTO_CONSENT_PENDING"
  | "TASK_FIELDS_MISSING"
  | "DISPATCH_BLOCKED"
  | "FACT_CHECK_BLOCKED"
  | "CLEANING_RULE_NOT_UNDERSTOOD"
  | "ROLE_FORBIDDEN"
  | "PROMPT_INJECTION_BLOCKED";

export const FAILURE_CODES: FailureCode[] = [
  "FILE_SIZE_LIMIT_EXCEEDED", "STUDENT_PII_DETECTED", "FILE_TYPE_NOT_READ", "PHOTO_BLURRY_OR_DARK", "PHOTO_SINGLE_CHILD",
  "PHOTO_NOT_CLASSROOM", "PHOTO_CONSENT_PENDING", "TASK_FIELDS_MISSING", "DISPATCH_BLOCKED", "FACT_CHECK_BLOCKED",
  "CLEANING_RULE_NOT_UNDERSTOOD", "ROLE_FORBIDDEN", "PROMPT_INJECTION_BLOCKED",
];

export type FailureFacts = Record<string, string | number | boolean | null>;

export type FailureDiagnosticEntry = {
  id: string;
  at: string;
  surface: FailureSurface;
  code: FailureCode;
  /** Stage 1: the gate's decision. */
  gate: { ok: false; code: FailureCode; confidence: number; source: "rules" | "laya"; summary: Copy };
  /** Stage 2: why it failed and how to fix it. */
  explanation: { whyFailed: Copy; howToFix: { en: string[]; hi: string[] }; source: "rules" | "model" };
  facts: FailureFacts;
  personId?: string | null;
};

const s = (v: FailureFacts[string] | undefined) => (v === null || v === undefined ? "—" : String(v));

type Template = { summary: Copy; why: (f: FailureFacts) => Copy; fix: (f: FailureFacts) => { en: string[]; hi: string[] } };

const KIND: Record<string, Copy> = {
  spreadsheet: { en: "a CSV or Excel file", hi: "CSV या एक्सेल फाइल" },
  image: { en: "a photo", hi: "फोटो" },
  audio: { en: "a voice note", hi: "वॉइस नोट" },
};
const kindOf = (f: FailureFacts) => KIND[s(f.kind)] ?? KIND.spreadsheet!;

const TEMPLATES: Record<FailureCode, Template> = {
  FILE_SIZE_LIMIT_EXCEEDED: {
    summary: { en: "File too large", hi: "फाइल बहुत बड़ी" },
    why: (f) => ({
      en: `${s(f.name)} is ${s(f.sizeMb)} MB. The limit for ${kindOf(f).en} is ${s(f.limitMb)} MB, so it was not read.`,
      hi: `${s(f.name)} ${s(f.sizeMb)} MB की है। ${kindOf(f).hi} की सीमा ${s(f.limitMb)} MB है, इसलिए पढ़ी नहीं गई।`,
    }),
    fix: (f) =>
      f.kind === "image"
        ? { en: ["Take the photo at a lower camera resolution, or send it once through Telegram (which shrinks it).", "Crop it to the group activity."], hi: ["कैमरे का रिज़ॉल्यूशन कम करके फोटो लें, या एक बार टेलीग्राम से भेजें (वह छोटा कर देता है)।", "फोटो को समूह गतिविधि तक काटें।"] }
        : f.kind === "audio"
          ? { en: ["Record a shorter note, about 3 minutes or less.", "Or send it in two parts."], hi: ["छोटा नोट रिकॉर्ड करें, लगभग 3 मिनट या कम।", "या दो भागों में भेजें।"] }
          : { en: ["Save only the sheet you need as CSV.", "Remove columns the review does not use, or split the file by cluster."], hi: ["केवल ज़रूरी शीट को CSV में सहेजें।", "अनुपयोगी कॉलम हटाएँ, या फाइल को क्लस्टर के हिसाब से बाँटें।"] },
  },
  STUDENT_PII_DETECTED: {
    summary: { en: "Student-level data refused", hi: "विद्यार्थी-स्तरीय डेटा रोका गया" },
    why: (f) => ({
      en: `${s(f.name)} has “${s(f.match)}”, which looks like data about individual children. The review reads school-level data only, so the file was refused and nothing was stored.`,
      hi: `${s(f.name)} में “${s(f.match)}” है, जो अलग-अलग बच्चों का डेटा लगता है। समीक्षा केवल विद्यालय-स्तरीय डेटा पढ़ती है, इसलिए फाइल रोकी गई और कुछ संग्रहीत नहीं हुआ।`,
    }),
    fix: () => ({
      en: ["Delete the student name, Aadhaar, APAAR, PEN or Samagra ID columns.", "Keep one row per school (or per school and round), then upload again."],
      hi: ["विद्यार्थी नाम, आधार, APAAR, PEN या समग्र आईडी वाले कॉलम हटाएँ।", "हर विद्यालय (या विद्यालय व चक्र) की एक पंक्ति रखें, फिर अपलोड करें।"],
    }),
  },
  FILE_TYPE_NOT_READ: {
    summary: { en: "File type not read", hi: "फाइल प्रकार नहीं पढ़ा गया" },
    why: (f) => ({ en: `${s(f.name)} is not a CSV or .xlsx file.`, hi: `${s(f.name)} CSV या .xlsx फाइल नहीं है।` }),
    fix: () => ({ en: ["Save it as CSV or .xlsx (old .xls is not read)."], hi: ["इसे CSV या .xlsx में सहेजें (पुरानी .xls नहीं पढ़ी जाती)।"] }),
  },
  PHOTO_BLURRY_OR_DARK: {
    summary: { en: "Photo too blurry or dark", hi: "फोटो धुंधली या अंधेरी" },
    why: (f) => ({
      en: `Sharpness is ${s(f.sharpness)} (needs ${s(f.minSharpness)}) and brightness ${s(f.brightness)} (needs ${s(f.minBrightness)} to ${s(f.maxBrightness)}).`,
      hi: `स्पष्टता ${s(f.sharpness)} है (चाहिए ${s(f.minSharpness)}) और चमक ${s(f.brightness)} (चाहिए ${s(f.minBrightness)} से ${s(f.maxBrightness)})।`,
    }),
    fix: () => ({ en: ["Hold the phone still and take it in daylight or near a window.", "Use the camera photo, not a forwarded copy."], hi: ["फोन स्थिर रखें और दिन की रोशनी या खिड़की के पास फोटो लें।", "फॉरवर्ड की गई नहीं, कैमरे की मूल फोटो भेजें।"] }),
  },
  PHOTO_SINGLE_CHILD: {
    summary: { en: "Single child or close-up face", hi: "एकल बच्चा या चेहरे का क्लोज़-अप" },
    why: (f) => ({
      en: `About ${s(f.persons)} face${f.persons === 1 ? "" : "s"} found, the largest ${s(f.faceSharePct)}% of the frame. Proof must show a group of at least ${s(f.minGroup)} children with no face above ${s(f.maxFacePct)}% of the frame.`,
      hi: `लगभग ${s(f.persons)} चेहरे मिले, सबसे बड़ा फ्रेम का ${s(f.faceSharePct)}%। प्रमाण में कम से कम ${s(f.minGroup)} बच्चों का समूह हो और कोई चेहरा फ्रेम के ${s(f.maxFacePct)}% से बड़ा न हो।`,
    }),
    fix: () => ({ en: ["Step back and photograph the whole group at the activity.", "Do not photograph one child alone."], hi: ["पीछे हटकर पूरे समूह की गतिविधि करते हुए फोटो लें।", "किसी एक बच्चे की अकेले फोटो न लें।"] }),
  },
  PHOTO_NOT_CLASSROOM: {
    summary: { en: "Does not look like a classroom activity", hi: "कक्षा गतिविधि जैसी नहीं लगती" },
    why: (f) => ({
      en: `The scene has little detail (score ${s(f.scene)} of 100) and no group was found, so it looks like a wall, floor or pocket shot.`,
      hi: `दृश्य में कम विवरण है (स्कोर 100 में ${s(f.scene)}) और कोई समूह नहीं मिला, इसलिए यह दीवार, फर्श या जेब की फोटो लगती है।`,
    }),
    fix: () => ({ en: ["Photograph the children at the activity, with the mat or board in view."], hi: ["गतिविधि करते बच्चों की फोटो लें, चटाई या बोर्ड दिखे।"] }),
  },
  PHOTO_CONSENT_PENDING: {
    summary: { en: "Consent chain incomplete", hi: "सहमति शृंखला अधूरी" },
    why: (f) => ({ en: `The photo has ${s(f.tiers)} of the ${s(f.needed)} signatures it needs.`, hi: `फोटो पर ज़रूरी ${s(f.needed)} हस्ताक्षरों में से ${s(f.tiers)} हैं।` }),
    fix: () => ({
      en: ["Tier 1: the HM or CRCC confirms a real group activity and the SMC/parent consent entry.", "Tier 2: the BEO counter-signs. Each tier must be signed by a higher level than the one below."],
      hi: ["स्तर 1: प्रधानाध्यापक या CRCC वास्तविक गतिविधि और SMC/अभिभावक सहमति की पुष्टि करें।", "स्तर 2: BEO प्रति-हस्ताक्षर करें। हर स्तर नीचे वाले से ऊँचे स्तर का अधिकारी हस्ताक्षर करे।"],
    }),
  },
  TASK_FIELDS_MISSING: {
    summary: { en: "Task cannot be approved yet", hi: "कार्य अभी अनुमोदित नहीं हो सकता" },
    why: (f) => ({ en: `Task #${s(f.taskNo)} is missing: ${s(f.missing)}.`, hi: `कार्य #${s(f.taskNo)} में अधूरा: ${s(f.missing)}।` }),
    fix: () => ({ en: ["Set an owner and a due date after the review date, or use the Laya fill on the Approve tab, then approve."], hi: ["जिम्मेदार और समीक्षा के बाद की अंतिम तिथि भरें, या अनुमोदन टैब पर Laya से भरें, फिर अनुमोदित करें।"] }),
  },
  DISPATCH_BLOCKED: {
    summary: { en: "Task card held", hi: "कार्य कार्ड रोका गया" },
    why: (f) => ({ en: `Task #${s(f.taskNo)} was not sent: ${s(f.reason)}.`, hi: `कार्य #${s(f.taskNo)} नहीं भेजा गया: ${s(f.reasonHi ?? f.reason)}।` }),
    fix: (f) =>
      /link/i.test(s(f.reason))
        ? { en: ["Ask the owner to send /start to the bot, then link the chat with /link <person id> <chat id>."], hi: ["जिम्मेदार से बॉट को /start भेजने को कहें, फिर /link <person id> <chat id> से चैट जोड़ें।"] }
        : /limit/i.test(s(f.reason))
          ? { en: ["The daily message limit is reached; send again tomorrow."], hi: ["आज की संदेश सीमा पूरी है; कल फिर भेजें।"] }
          : { en: ["Approve the task with an owner, a due date and a success measure, then send again."], hi: ["जिम्मेदार, तिथि और सफलता मापदंड सहित कार्य अनुमोदित करें, फिर भेजें।"] },
  },
  FACT_CHECK_BLOCKED: {
    summary: { en: "Message stopped by the fact-check", hi: "तथ्य-जाँच ने संदेश रोका" },
    why: (f) => ({
      en: `The ${s(f.kind)} message did not match the cycle's data: ${s(f.problems)}. It never reached Telegram.`,
      hi: `${s(f.kind)} संदेश चक्र के डेटा से मेल नहीं खाया: ${s(f.problemsHi ?? f.problems)}। यह टेलीग्राम तक नहीं पहुँचा।`,
    }),
    fix: () => ({ en: ["Send the message from the app's own card or digest; do not edit numbers, names or dates by hand."], hi: ["संदेश ऐप के अपने कार्ड या सारांश से भेजें; अंक, नाम या तिथि हाथ से न बदलें।"] }),
  },
  CLEANING_RULE_NOT_UNDERSTOOD: {
    summary: { en: "Cleaning rule not understood", hi: "सफाई नियम समझ नहीं आया" },
    why: (f) => ({ en: `“${s(f.rule)}” did not match any rule the studio can apply.`, hi: `“${s(f.rule)}” किसी ऐसे नियम से मेल नहीं खाया जो स्टूडियो लागू कर सके।` }),
    fix: () => ({ en: ["Name a column and a number, e.g. “attendance below 65”, “drop more than 8”, “R3 below 40”, or “trim names”."], hi: ["कॉलम और अंक लिखें, जैसे “attendance below 65”, “drop more than 8”, “R3 below 40” या “trim names”।"] }),
  },
  PROMPT_INJECTION_BLOCKED: {
    summary: { en: "Instruction removed from the data", hi: "डेटा से निर्देश हटाया गया" },
    why: (f) => ({
      en: `Text on its way to the model (${s(f.where)}) contained an instruction (${s(f.patterns)}). It was cut out, and the rest was read as data only.`,
      hi: `मॉडल को जा रहे पाठ (${s(f.where)}) में निर्देश था (${s(f.patterns)})। उसे हटा दिया गया, बाकी केवल डेटा के रूप में पढ़ा गया।`,
    }),
    fix: () => ({ en: ["Nothing to do: the step ran without the instruction. Check where the text came from if it repeats."], hi: ["कुछ करने की ज़रूरत नहीं: चरण निर्देश के बिना चला। बार-बार हो तो पाठ का स्रोत जाँचें।"] }),
  },
  ROLE_FORBIDDEN: {
    summary: { en: "Not allowed at this level", hi: "इस स्तर पर अनुमति नहीं" },
    why: (f) => ({ en: s(f.reason), hi: s(f.reasonHi ?? f.reason) }),
    fix: () => ({ en: ["Switch to an officer level that holds this power, or ask that officer to do it."], hi: ["ऐसे अधिकारी स्तर पर जाएँ जिसके पास यह अधिकार है, या उन्हीं से करवाएँ।"] }),
  },
};

let counter = 0;

/** Build the two-stage entry for one failure. */
export function diagnoseFailure(
  surface: FailureSurface,
  code: FailureCode,
  facts: FailureFacts,
  opts: { confidence?: number; source?: "rules" | "laya"; at?: string; id?: string; personId?: string | null } = {},
): FailureDiagnosticEntry {
  const t = TEMPLATES[code];
  const at = opts.at ?? new Date().toISOString();
  counter += 1;
  return {
    id: opts.id ?? `FAIL-${String(Date.parse(at) % 100_000).padStart(5, "0")}-${counter}`,
    at,
    surface,
    code,
    gate: { ok: false, code, confidence: opts.confidence ?? 1, source: opts.source ?? "rules", summary: t.summary },
    explanation: { whyFailed: t.why(facts), howToFix: t.fix(facts), source: "rules" },
    facts,
    personId: opts.personId ?? null,
  };
}

/** Plain text exactly as /why sends it, in one language. */
export function formatWhyReply(entry: FailureDiagnosticEntry | null, lang: "en" | "hi"): string {
  if (!entry) return lang === "hi" ? "हाल में आपके लिए कोई विफलता दर्ज नहीं है।" : "No recent failure is recorded for you.";
  const hi = lang === "hi";
  const pct = Math.round(entry.gate.confidence * 100);
  const by = entry.gate.source === "laya" ? "Laya" : hi ? "नियम" : "a fixed rule";
  return [
    hi ? `क्यों विफल हुआ · ${entry.gate.summary.hi} (${entry.code})` : `Why it failed · ${entry.gate.summary.en} (${entry.code})`,
    hi ? `1. पहचान: ${by}, निश्चितता ${pct}%` : `1. Caught by ${by}, certainty ${pct}%`,
    `2. ${entry.explanation.whyFailed[lang]}`,
    hi ? "3. कैसे ठीक करें:" : "3. How to fix it:",
    ...entry.explanation.howToFix[lang].map((x) => `   - ${x}`),
  ].join("\n");
}

/** A whole message that asks for the last failure: /why, /reason, why, kyu, क्यों, क्यों फेल हुआ. */
export const WHY_TRIGGER = /^(?:\/why|\/reason|why\??|kyu\??|kyon\??|क्यों(?:\s*फेल\s*हुआ)?\??)$/i;
