import { useState, type FocusEvent } from "react";
import { transcribeFn } from "@/lib/samiksha/api";
import { ACTION_LIBRARY, filterByRoleScope, layaAutoFillTaskGovernance, type ActionId, type Gap, type Person, type Task } from "@/lib/samiksha/engine";
import { copy, tx, useCan, useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";
import { STATUS_LABEL, fieldList, label } from "@/lib/samiksha/labels";
import { Btn, Chip, Panel, fieldClass } from "@/components/samiksha/ui";

export function ApproveTab() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { cycle, tasks, allRankedGaps: gaps } = useView();
  const role = useCycle((s) => s.role);
  const approveRight = useCan()("approve_task");

  if (!cycle) return <Panel>{en ? "Load the seeded files first." : "पहले सीडेड फाइलें लोड करें।"}</Panel>;
  const people = cycle.people.filter((p) => p.role !== "BEO");
  const visible = filterByRoleScope(role, cycle, tasks).tasks;

  return (
    <div className="rise space-y-8">
      <div>
        <h1 className="font-display text-3xl">{en ? "Decide and Approve" : "निर्णय व अनुमोदन"}</h1>
        <p className="mt-1 text-muted">
          {en
            ? "A voice note becomes drafts. Approve stays locked until owner and due date are filled."
            : "वॉइस नोट ड्राफ्ट बनता है। जिम्मेदार और अंतिम तिथि भरे बिना अनुमोदन बंद रहता है।"}
        </p>
      </div>

      {approveRight.allowed ? null : <p className="text-sm text-flag">{en ? approveRight.reasonEn : approveRight.reasonHi}</p>}
      <VoiceNotePanel en={en} />
      <GatePanel en={en} readyCount={tasks.filter((t) => t.status === "draft" && t.missingFields.length === 0).length} />

      {visible.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">
            {en
              ? "No drafts yet. Run the demo voice note. Task #18 is intentionally incomplete."
              : "अभी कोई ड्राफ्ट नहीं। डेमो नोट चलाएँ। कार्य #18 जानबूझकर अधूरा है।"}
          </p>
        </Panel>
      ) : (
        <div className="space-y-5">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} gap={gaps.find((g) => g.id === task.gapId)} people={people} en={en} />
          ))}
        </div>
      )}
    </div>
  );
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The browser's own speech recognition (Chrome, Edge, Safari), as far as this screen needs it. */
type BrowserRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
const browserRecognition = (): (new () => BrowserRecognition) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => BrowserRecognition; webkitSpeechRecognition?: new () => BrowserRecognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
const VOICE_INPUT_ID = "beo-voice-note-input";

/**
 * Records a voice note. With a speech service on the server, the audio goes there.
 * Without one, the browser's own speech recognition listens instead; where the
 * browser has none, the note box takes focus so the officer can type.
 */
function useVoiceRecorder(lang: "en" | "hi") {
  const { cycleId, blockId, services } = useView();
  const setTranscript = useCycle((s) => s.setTranscript);
  const [stop, setStop] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (en: string, hi: string) => useCycle.setState({ sttLabel: copy(en, hi) });
  const typeInstead = () => {
    label("Voice transcription service unavailable on this connection — please type or paste the review note below.", "इस कनेक्शन पर आवाज़ से लिखने की सेवा उपलब्ध नहीं है — कृपया समीक्षा नोट नीचे लिखें या चिपकाएँ।");
    document.getElementById(VOICE_INPUT_ID)?.focus();
  };
  const listenInBrowser = (Recognition: new () => BrowserRecognition) => {
    const rec = new Recognition();
    rec.lang = lang === "hi" ? "hi-IN" : "en-IN";
    rec.continuous = true;
    rec.interimResults = false;
    let heard = "";
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) if (e.results[i]?.isFinal) heard += `${e.results[i]![0].transcript} `;
    };
    rec.onerror = () => undefined;
    rec.onend = () => {
      setStop(null);
      if (!heard.trim()) return typeInstead();
      const before = useCycle.getState().transcript.trim();
      setTranscript(before ? `${before} ${heard.trim()}` : heard.trim());
      label("Browser speech recognition · check the text below before extracting tasks", "ब्राउज़र वाक् पहचान · कार्य निकालने से पहले नीचे का पाठ जाँचें");
    };
    rec.start();
    label("Listening… speak the review decisions, then tap Stop.", "सुन रहे हैं… समीक्षा के निर्णय बोलें, फिर रोकें दबाएँ।");
    setStop(() => () => rec.stop());
  };

  const send = async (blob: Blob, seconds: number) => {
    setBusy(true);
    try {
      const heard = await transcribeFn({ data: { blockId: blockId!, cycleId: cycleId!, audioBase64: await toBase64(blob), mimeType: blob.type, lang, durationSeconds: seconds } });
      if (heard.transcript) {
        setTranscript(heard.transcript);
        label(`${heard.provider} · ${Math.round(seconds)} s voice note`, `${heard.provider} · ${Math.round(seconds)} सेकंड का वॉइस नोट`);
      } else {
        typeInstead();
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : "Speech-to-text failed.";
      label(m, m);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (stop) return stop();
    if (!services.stt) {
      const Recognition = browserRecognition();
      return Recognition ? listenInBrowser(Recognition) : typeInstead();
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const started = Date.now();
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setStop(null);
        void send(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), (Date.now() - started) / 1000);
      };
      recorder.start();
      setStop(() => () => recorder.stop());
    } catch {
      label("Microphone permission was blocked.", "माइक की अनुमति नहीं मिली।");
    }
  };

  return { recording: Boolean(stop), busy, toggle };
}

function VoiceNotePanel({ en }: { en: boolean }) {
  const { runVoiceDemo: runVoice, extract } = useActions();
  const transcript = useCycle((s) => s.transcript);
  const stt = useCycle((s) => s.sttLabel);
  const setTranscript = useCycle((s) => s.setTranscript);
  const recorder = useVoiceRecorder(en ? "en" : "hi");
  const noteOk = useCan()("record_note").allowed;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "BEO Voice Note" : "BEO वॉइस नोट"}</h2>
          <p className="mt-1 text-sm text-muted">{stt ? tx(stt, en ? "en" : "hi") : (en ? "Record a Hindi/English voice note or type meeting decisions below." : "हिन्दी/अंग्रेज़ी वॉइस नोट रिकॉर्ड करें या बैठक के निर्णय नीचे लिखें।")}</p>
        </div>
        <Btn kind="primary" onClick={runVoice} disabled={!noteOk}>
          {en ? "Load Sample Voice Note (Hindi/English)" : "नमूना वॉइस नोट लोड करें (हिन्दी/अंग्रेज़ी)"}
        </Btn>
      </div>
      <textarea
        id={VOICE_INPUT_ID}
        className="mt-4 min-h-32 w-full rounded-md border border-rule bg-sheet p-3 text-sm"
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder={en ? "Speak or type review decisions in English, Hindi, or Hinglish..." : "हिन्दी या हिंग्लिश में कार्य बोलें या लिखें..."}
        aria-label={en ? "Voice transcript" : "वॉइस ट्रांसक्रिप्ट"}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn kind="soft" onClick={extract} disabled={!transcript.trim() || !noteOk}>
          {en ? "Extract Draft Tasks" : "ड्राफ्ट कार्य निकालें"}
        </Btn>
        <Btn kind="ghost" onClick={recorder.toggle} disabled={recorder.busy || !noteOk}>
          {recorder.recording
            ? (en ? "Stop and Transcribe" : "रिकॉर्डिंग रोकें व लिखें")
            : recorder.busy
              ? (en ? "Transcribing…" : "लिख रहा है…")
              : (en ? "Record Voice Note" : "वॉइस नोट रिकॉर्ड करें")}
        </Btn>
      </div>
    </Panel>
  );
}

function GatePanel({ en, readyCount }: { en: boolean; readyCount: number }) {
  const { dispatchApproved: dispatch, tryIllegal: illegal, approveAllReady } = useActions();
  const gate = useCycle((s) => s.gateMessage);
  const can = useCan();
  return (
    <Panel className="bg-seal-soft">
      <p className="text-sm font-medium">{en ? "Hard Approval & Dispatch Gate" : "अनुमोदन एवं प्रेषण गेट"}</p>
      <p className="mt-1 text-sm">
        {en
          ? "Only approved tasks with a named owner, a due date after 30 Nov 2025 and a success measure can be sent to the field. Draft and rejected tasks are blocked."
          : "बॉट कतार केवल अनुमोदित कार्यों (जिनमें जिम्मेदार व्यक्ति, 30 नवम्बर 2025 के बाद की तिथि और सफलता मापदंड हो) को पढ़ती है। ड्राफ्ट व अस्वीकृत कार्य ब्लॉक रहते हैं।"}
      </p>
      {gate ? <p className="mt-2 text-sm">{tx(gate, en ? "en" : "hi")}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn kind="soft" onClick={approveAllReady} disabled={!readyCount || !can("approve_task").allowed}>
          {en ? `Approve All Complete Drafts (${readyCount})` : `सभी पूर्ण ड्राफ्ट अनुमोदित करें (${readyCount})`}
        </Btn>
        <Btn kind="primary" onClick={dispatch} disabled={!can("dispatch_tasks").allowed}>
          {en ? "Send Approved Tasks to Bot" : "अनुमोदित कार्य भेजें"}
        </Btn>
        <Btn kind="danger" onClick={illegal}>
          {en ? "Test Gate: Try Sending Unapproved Drafts" : "गेट जाँचें: ड्राफ्ट भेजकर देखें"}
        </Btn>
      </div>
    </Panel>
  );
}

/** A free-text edit in one language; the other language is filled too when it was empty. */
function bilingualPatch(task: Task, en: boolean, field: "success" | "what", v: string): Partial<Task> {
  if (field === "success") {
    return en
      ? { successEn: v, successHi: task.successHi.trim() ? task.successHi : v }
      : { successHi: v, successEn: task.successEn.trim() ? task.successEn : v };
  }
  return en
    ? { whatEn: v, whatHi: task.whatHi.trim() ? task.whatHi : v }
    : { whatHi: v, whatEn: task.whatEn.trim() ? task.whatEn : v };
}

function TaskCard({ task, gap, people, en }: { task: Task; gap: Gap | undefined; people: Person[]; en: boolean }) {
  const lang = en ? "en" : "hi";
  const { updateTask: update, approve, reject, restore, layaFill } = useActions();
  const { cycle, simToday, services } = useView();
  const can = useCan();
  const canEdit = can("edit_task").allowed;
  const canApprove = can("approve_task").allowed;
  const locked = task.missingFields.length > 0 || task.status === "rejected";
  const needsFill = task.status === "draft" && task.missingFields.some((f) => f === "owner_id" || f.startsWith("due_date"));
  // This task's own governance confidence: how sure the rules are of its owner and its date. Not the brief's reorder score.
  const governance = cycle ? layaAutoFillTaskGovernance(task, cycle, simToday) : null;
  const fill = needsFill ? governance : null;
  const text = (field: "success" | "what") => (field === "success" ? (en ? task.successEn : task.successHi) : (en ? task.whatEn : task.whatHi));
  const onBlur = (field: "success" | "what") => (e: FocusEvent<HTMLInputElement>) => {
    if (e.target.value !== text(field)) void update(task.id, bilingualPatch(task, en, field, e.target.value));
  };
  return (
    <Panel className={task.missingFields.length ? "border-flag bg-flag-soft" : ""}>
      <div className="-mx-5 -mt-5 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-rule bg-paper px-5 py-3.5 sm:-mx-6 sm:-mt-6 sm:px-6">
        <h2 className="font-display text-xl">{en ? `Task #${task.id}` : `कार्य #${task.id}`}</h2>
        <span className="flex flex-wrap items-center gap-2">
          <Chip tone={task.status === "approved" || task.status === "sent" || task.status === "done" ? "seal" : task.status === "rejected" ? "flag" : "plain"}>
            {label(STATUS_LABEL, task.status, lang)}
          </Chip>
          {governance ? (
            <Chip tone={governance.confidence >= 0.9 ? "seal" : governance.confidence >= 0.6 ? "plain" : "flag"}>
              {governance.confidence === 1
                ? en ? "Owner and date set · 100%" : "जिम्मेदार व तिथि तय · 100%"
                : en
                  ? `Laya fill ${Math.round(governance.confidence * 100)}% · owner ${Math.round(governance.ownerConfidence * 100)}% · due ${Math.round(governance.dueConfidence * 100)}%`
                  : `लाया भराव ${Math.round(governance.confidence * 100)}% · जिम्मेदार ${Math.round(governance.ownerConfidence * 100)}% · तिथि ${Math.round(governance.dueConfidence * 100)}%`}
            </Chip>
          ) : null}
        </span>
      </div>
      <p className="text-sm text-muted">{en ? task.targetLabel : task.targetLabelHi || task.targetLabel}</p>
      {(en ? task.note : task.noteHi) ? <p className="mt-2 text-sm">{en ? task.note : task.noteHi}</p> : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-muted">{en ? "Action" : "कार्य"}</span>
          <select className={fieldClass} disabled={!canEdit} value={task.actionId} onChange={(e) => update(task.id, { actionId: e.target.value as ActionId })}>
            {(Object.keys(ACTION_LIBRARY) as ActionId[]).map((id) => (
              <option key={id} value={id}>
                {en ? ACTION_LIBRARY[id].name_en : ACTION_LIBRARY[id].name_hi}
                {gap && !gap.allowedActions.includes(id) ? (en ? " · not for this gap" : " · इस अंतर के लिए नहीं") : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">{en ? "Owner" : "जिम्मेदार"}</span>
          <select className={fieldClass} disabled={!canEdit} value={task.ownerId ?? ""} onChange={(e) => update(task.id, { ownerId: e.target.value || null })}>
            <option value="">{en ? "Select owner..." : "चुनें..."}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {en ? `${p.nameEn} · ${p.role} · ${p.scope}` : `${p.nameHi} · ${p.role} · ${p.scope}`}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">{en ? "Due Date" : "अंतिम तिथि"}</span>
          <input
            type="date"
            className={fieldClass}
            disabled={!canEdit}
            min="2025-12-01"
            value={task.dueDate ?? ""}
            onChange={(e) => update(task.id, { dueDate: e.target.value || null })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">{en ? "Success Measure" : "सफलता मापदंड"}</span>
          <input key={`${task.id}-${lang}-${text("success")}`} className={fieldClass} disabled={!canEdit} defaultValue={text("success")} onBlur={onBlur("success")} />
        </label>
      </div>
      <label className="mt-4 block text-sm">
        <span className="mb-1 block text-muted">{en ? "Task Description (What to do)" : "कार्य विवरण (क्या करना है)"}</span>
        <input key={`${task.id}-${lang}-${text("what")}`} className={fieldClass} disabled={!canEdit} defaultValue={text("what")} onBlur={onBlur("what")} />
      </label>
      {task.missingFields.length ? (
        <p className="mt-3 text-sm text-flag">
          {en
            ? `Approval locked — missing required fields: ${task.missingFields.join(", ")}`
            : `अनुमोदन रुका है — आवश्यक जानकारी अधूरी: ${fieldList(task.missingFields, "hi")}`}
        </p>
      ) : null}
      {fill ? (
        <div className="mt-3 rounded-lg border border-seal bg-seal-soft p-3 text-sm">
          <p>
            <span className="font-semibold">{en ? "Laya proposal: " : "Laya प्रस्ताव: "}</span>
            {fill.why[lang]}
          </p>
          {/* The owner and due date the model filled in, with the confidence it had on each. */}
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip tone={fill.ownerConfidence >= 0.9 ? "seal" : fill.ownerConfidence >= 0.6 ? "plain" : "flag"}>
              {en ? `Owner confidence ${Math.round(fill.ownerConfidence * 100)}%` : `जिम्मेदार विश्वसनीयता ${Math.round(fill.ownerConfidence * 100)}%`}
            </Chip>
            <Chip tone={fill.dueConfidence >= 0.9 ? "seal" : fill.dueConfidence >= 0.6 ? "plain" : "flag"}>
              {en ? `Due-date confidence ${Math.round(fill.dueConfidence * 100)}%` : `तिथि विश्वसनीयता ${Math.round(fill.dueConfidence * 100)}%`}
            </Chip>
          </div>
          <p className="mt-1 text-xs text-muted">
            {en
              ? `Owner ${Math.round(fill.ownerConfidence * 100)}%, date ${Math.round(fill.dueConfidence * 100)}%: rule scores from the roster and the action library${services.laya ? "; Laya must agree before the owner is filled" : ""}. You confirm before anything is approved.`
              : `जिम्मेदार ${Math.round(fill.ownerConfidence * 100)}%, तिथि ${Math.round(fill.dueConfidence * 100)}%: रोस्टर व कार्य सूची के नियम स्कोर${services.laya ? "; जिम्मेदार भरने से पहले Laya की सहमति ली जाती है" : ""}। अनुमोदन से पहले आप पुष्टि करते हैं।`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Btn kind="ghost" disabled={!canEdit} onClick={() => layaFill(task.id, false)}>{en ? "Fill with Laya" : "Laya से भरें"}</Btn>
            <Btn kind="primary" disabled={!canEdit || !canApprove || !fill.ready} onClick={() => layaFill(task.id, true)}>
              {en ? "Fill and approve" : "भरें और अनुमोदित करें"}
            </Btn>
          </div>
        </div>
      ) : null}
      {/* The classroom playbook: what the owner does in the room when this task is carried out. */}
      <div className="mt-3 rounded-lg border border-seal/40 bg-seal-soft/50 p-3 text-sm">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {en ? "Classroom playbook — what to do in the room" : "कक्षा प्लेबुक — कक्षा में क्या करें"}
        </p>
        <p className="mt-2">
          {en ? ACTION_LIBRARY[task.actionId].classroomPlaybookEn : ACTION_LIBRARY[task.actionId].classroomPlaybookHi}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Btn kind="primary" disabled={locked || task.status === "approved" || !canApprove} onClick={() => approve(task.id)}>
          {en ? "Approve Task" : "अनुमोदित करें"}
        </Btn>
        <Btn kind="ghost" disabled={!canApprove} onClick={() => reject(task.id)}>
          {en ? "Reject" : "अस्वीकार करें"}
        </Btn>
        {task.status === "rejected" ? (
          <Btn kind="soft" disabled={!canApprove} onClick={() => restore(task.id)}>
            {en ? "Restore to Draft" : "ड्राफ्ट पर लौटाएँ"}
          </Btn>
        ) : null}
      </div>
    </Panel>
  );
}
