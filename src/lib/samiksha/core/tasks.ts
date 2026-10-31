import { ACTION_LIBRARY, REVIEW_DATE, type ActionId } from "./config";
import type { Cycle, Gap, Person, ReplyParse, Task } from "./model";

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DEMO_TRANSCRIPT =
  "पीएस खेड़ी में कक्षा तीन गणित का स्तर 34 प्रतिशत रह गया है, वहां सीआरसीसी सी-4 और हेडमास्टर मिलकर 20 दिसंबर तक तीन हफ्ते का TaRL गणित कैंप चलाएं ताकि अगले राउंड में कम से कम 8 अंक सुधार हो। साथ ही खेड़ी में जुलाई से खाली गणित पद के लिए डीईओ साहब को रिक्ति प्रस्ताव भेजें। क्लस्टर सी-6 के सभी 14 स्कूलों में सीआरसीसी 22 दिसंबर तक कक्षा अवलोकन पूरा करें। हरनगांव के 100 प्रतिशत स्कोर की बीआरसी द्वारा 15 दिसंबर तक औचक जांच कराएं, और एकल शिक्षक स्कूलों में उपस्थिति अभियान चलाया जाए।";

export const DEMO_TRANSCRIPT_EN =
  "At PS Khedi, Grade 3 numeracy has dropped to 34 percent; have CRCC C4 and the headteacher run a three-week TaRL maths camp by 20 December so the next round improves by at least 8 points. Also send the maths teacher vacancy redeployment request for PS Khedi to the DEO. In Cluster C6, have the CRCC complete classroom observations in all 14 schools by 22 December. Have the BRC run a spot check on PS Harangaon's 100 percent score by 15 December, and run an attendance drive in the single-teacher schools.";

const DEC_WORD = String.raw`(?:दिसंबर|dec(?:ember)?)`;

function spokenDate(fragment: string): string | null {
  const m = fragment.match(new RegExp(`(\\d{1,2})\\s*${DEC_WORD}`, "i"));
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  const iso = `2025-12-${String(day).padStart(2, "0")}`;
  return iso > REVIEW_DATE ? iso : null;
}

function hasDecDay(text: string, day: number): boolean {
  return new RegExp(`${day}\\s*${DEC_WORD}`, "i").test(text);
}

type Draft = Omit<Task, "id" | "status" | "approvedBy" | "approvedAt" | "completedAt" | "unitsDone" | "note" | "noteHi"> & {
  note?: string;
  noteHi?: string;
};

/** A draft for one gap; whatever the note did not name stays in missingFields and locks approval. */
function libraryDraft(g: Gap, actionId: ActionId, ownerId: string | null, dueDate: string | null, what: [string, string]): Draft {
  return {
    gapId: g.id,
    actionId,
    whatEn: what[0],
    whatHi: what[1],
    ownerId,
    targetLabel: g.targetLabel,
    targetLabelHi: g.targetLabelHi,
    targetCodes: g.targetCodes,
    dueDate,
    successEn: ACTION_LIBRARY[actionId].success_en,
    successHi: ACTION_LIBRARY[actionId].success_hi,
    missingFields: [...(dueDate ? [] : ["due_date"]), ...(ownerId ? [] : ["owner_id"])],
  };
}

function campDraft(text: string, g: Gap, ownerId: string | null): Draft {
  const khediAt = text.search(/खेड़ी|khedi/i);
  const due = spokenDate(khediAt >= 0 ? text.slice(khediAt) : text) ?? spokenDate(text);
  const dueDate = hasDecDay(text, 20) ? "2025-12-20" : due;
  return {
    ...libraryDraft(g, "tarl", ownerId, dueDate, [
      "Run a three-week TaRL maths camp at PS Khedi with CRCC C4 and the headteacher.",
      "पीएस खेड़ी में CRCC C4 और प्रधानाध्यापक तीन हफ्ते का TaRL गणित शिविर चलाएँ।",
    ]),
    successEn: "At least 8 points higher in the next round.",
    successHi: "अगले चक्र में कम से कम 8 अंक का सुधार।",
  };
}

export function extractTasks(transcript: string, cycle: Pick<Cycle, "gaps" | "people" | "schools">): Task[] {
  const text = transcript.trim();
  const said = (re: RegExp) => re.test(text);
  const gap = (id: string) => cycle.gaps.find((g) => g.id === id);
  const owner = (id: string) => cycle.people.find((p) => p.id === id)?.id ?? null;
  const camp = gap("khedi-numeracy");
  const vacancy = gap("khedi-vacancy");
  const c6 = gap("c6-visit");
  const spot = gap("harangaon-score");
  const singles = gap("singles-attendance");
  const drafts: Draft[] = [];

  if (camp && said(/खेड़ी|khedi/i) && said(/tarl|कैंप|camp|शिविर/i)) drafts.push(campDraft(text, camp, owner("crcc-4")));
  if (vacancy && said(/डीईओ|deo|रिक्त|vacan/i)) {
    drafts.push({
      ...libraryDraft(vacancy, "vacancy", owner("deo"), addDays(REVIEW_DATE, ACTION_LIBRARY.vacancy.default_duration_days), [
        "Send the maths-post redeployment request for PS Khedi to the DEO. The post has been vacant since July.",
        "पीएस खेड़ी का गणित पद जुलाई से खाली है। पुनर्नियोजन प्रस्ताव DEO को भेजें।",
      ]),
      note: "Due date taken from the action library (21 days) because the note did not name one.",
      noteHi: "नोट में तिथि नहीं थी, इसलिए कार्य सूची के 21 दिन लगाए गए।",
    });
  }
  if (c6 && said(/सी-6|सी६|c-?6|cluster\s*c\s*6/i)) {
    drafts.push(libraryDraft(c6, "no_visit", owner("crcc-6"), hasDecDay(text, 22) ? "2025-12-22" : null, [
      "Finish classroom observation in all 14 schools of Cluster C6.",
      "क्लस्टर C6 के सभी 14 स्कूलों में कक्षा अवलोकन पूरा करें।",
    ]));
  }
  if (spot && said(/हरनगांव|हरनगाँव|harangaon|spot\s*check|100/i)) {
    drafts.push(libraryDraft(spot, "data_check", owner("crcc-8"), hasDecDay(text, 15) ? "2025-12-15" : null, [
      "BRC spot-check of the 100% score at PS Harangaon, owned in the roster by CRCC C8.",
      "पीएस हरनगाँव के 100% अंक की BRC औचक जांच। रोस्टर में जिम्मेदार CRCC C8।",
    ]));
  }
  if (singles && said(/उपस्थिति|एकल शिक्षक|attendance|single[-\s]?teacher/i)) {
    drafts.push({
      ...libraryDraft(singles, "attendance", null, null, ["Run an attendance drive in the single-teacher schools.", "एकल शिक्षक स्कूलों में उपस्थिति अभियान चलाया जाए।"]),
      note: "The voice note names neither a date nor a person. Approve stays locked.",
      noteHi: "वॉइस नोट में न तिथि है न व्यक्ति। अनुमोदन बंद रहता है।",
    });
  }

  return drafts.map((d, i): Task => ({
    ...d,
    id: 14 + i,
    status: "draft",
    missingFields: [...d.missingFields],
    approvedBy: null,
    approvedAt: null,
    completedAt: null,
    unitsDone: 0,
    note: d.note ?? "",
    noteHi: d.noteHi ?? "",
  }));
}

function fmtDue(iso: string | null): string {
  return iso
    ? new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : "—";
}

/** The 09:00 IST reminder for a task due today. */
export function formatNudge(task: Task, lang: "en" | "hi" = "en"): string {
  const action = ACTION_LIBRARY[task.actionId];
  if (lang === "hi") {
    return [
      `याद दिलाना · कार्य #${task.id} की अंतिम तिथि आज (${fmtDue(task.dueDate)}) है।`,
      `कार्य: ${action.name_hi}`,
      `विद्यालय: ${task.targetLabelHi || task.targetLabel}`,
      "'हो गया', 'आधा', या रुकावट का कारण लिखकर उत्तर दें।",
    ].join("\n");
  }
  return [
    `Reminder · Task #${task.id} is due today (${fmtDue(task.dueDate)}).`,
    `Action: ${action.name_en}`,
    `Target: ${task.targetLabel}`,
    "Reply 'done' (or 'हो गया'), 'partly done', or what is blocking it.",
  ].join("\n");
}

export function formatTaskCard(task: Task, owner: Person | undefined, lang: "en" | "hi" = "en"): string {
  const action = ACTION_LIBRARY[task.actionId];
  const due = fmtDue(task.dueDate);
  const ownerEn = owner ? `${owner.nameEn} · ${owner.role} (${owner.scope})` : "—";
  const ownerHi = owner ? `${owner.nameHi} · ${owner.role} (${owner.scope})` : "—";
  if (lang === "hi") {
    return [
      `कार्य #${task.id} (Task #${task.id})`,
      `कार्य: ${action.name_hi}`,
      `विद्यालय: ${task.targetLabelHi || task.targetLabel}`,
      `जिम्मेदार: ${ownerHi}`,
      `अंतिम तिथि: ${due}`,
      `सफलता मापदंड: ${task.successHi || task.successEn}`,
      "पूरा होने पर 'हो गया' या 'done' लिखकर फोटो या वॉयस नोट के साथ उत्तर दें।",
    ].join("\n");
  }
  return [
    `Task #${task.id} (कार्य #${task.id})`,
    `Action: ${action.name_en}`,
    `Target: ${task.targetLabel}`,
    `Owner: ${ownerEn}`,
    `Due Date: ${due}`,
    `Success Measure: ${task.successEn}`,
    "Reply 'done' (or 'हो गया') with a photo or voice note once completed.",
  ].join("\n");
}

function reply(status: ReplyParse["parsed_status"], confidence: number, en: string, hi: string, ask?: { en: string; hi: string }): ReplyParse {
  return {
    parsed_status: status,
    confidence,
    reason_hi: hi,
    reason_en: en,
    needs_clarification: Boolean(ask),
    follow_up_question_hi: ask?.hi ?? null,
    follow_up_question_en: ask?.en ?? null,
  };
}

/** The offline rule baseline for a field reply; the server pipeline in parseReply.ts decides first. */
export function parseFieldReply(text: string, opts: { openTasks: number; hasPhoto: boolean }): ReplyParse {
  const raw = text.trim();
  const t = raw.toLowerCase();
  if (opts.hasPhoto && !raw && opts.openTasks > 1) {
    return reply("unknown", 0.42, "Photo with no caption, and more than one task is open.", "फोटो है, पर यह किस कार्य की है यह स्पष्ट नहीं।", {
      en: "Which task is this photo for? Write the task number, for example Task #14.",
      hi: "यह फोटो किस कार्य की है? कार्य संख्या लिखें, जैसे कार्य #14।",
    });
  }
  // "not done yet", "abhi nahi hua", "अभी नहीं हुआ": never done; the work has not happened yet.
  const notDone = /\bnot\s+(?:yet\s+)?(?:done|complete[d]?|finished|started)\b|\bnot\s+yet\b|\bpending\b|\bnahi[n]?\s+hu[ai]\b|\babhi\s+nahi[n]?\b|नहीं\s*हु(?:आ|ई)/;
  if (notDone.test(t) || /नहीं हो पाया|शुरू नहीं|blocked|अभी नहीं|ड्यूटी के कारण|duty/.test(t) || /ड्यूटी/.test(raw)) {
    return reply("blocked", 0.9, "Work is blocked. The reason is in the message.", "कार्य रुका है। कारण संदेश में है।");
  }
  if (/आधा|बाकी|partly|partial|अधूरा|कुछ स्कूल|remaining/.test(t) || /बाकी/.test(raw)) {
    return reply("partial", 0.88, "Reported as partly done.", "काम अधूरा बताया गया है।");
  }
  if (/हो गया|होगया|done|पूर्ण|completed|ho gaya/.test(t) || /हो गया/.test(raw)) {
    return reply("done", 0.94, "Reported done.", "पूर्ण बताया गया।");
  }
  return reply("unknown", 0.35, "Message is ambiguous.", "संदेश स्पष्ट नहीं है।", {
    en: "Please write the task number and a status: done, partly done, or blocked.",
    hi: "कृपया कार्य संख्या और स्थिति लिखें: हो गया, आधा, या अभी नहीं।",
  });
}
