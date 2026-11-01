import { useEffect, useState } from "react";
import { UploadTab } from "@/components/samiksha/upload-tab";
import { BriefTab } from "@/components/samiksha/brief-tab";
import { ApproveTab } from "@/components/samiksha/approve-tab";
import { FollowTab } from "@/components/samiksha/follow-tab";
import { ScoreTab } from "@/components/samiksha/score-tab";
import { HingeStudio } from "@/components/samiksha/hinge-studio";
import { Btn, Chip, Seal } from "@/components/samiksha/ui";
import { HingeBar, HingeButton, RoleBar } from "@/components/samiksha/command-bar";
import { DistrictCommandPanel } from "@/components/samiksha/district-command";
import { RoleMissionStrip } from "@/components/samiksha/role-mission-strip";
import { ArchitecturePanel, stageNote } from "@/components/samiksha/architecture-panel";
import { EvaluatorGuide } from "@/components/samiksha/evaluator-guide";
import { useCycle, type TabId } from "@/lib/samiksha/store";
import { useActions, useView, sendOfflineAction } from "@/lib/samiksha/view";
import {
  draftNote,
  flushOfflineOutbox,
  isOffline,
  isSimulatedOffline,
  setSimulatedOffline,
  loadOfflineDraftState,
  outboxCount,
  saveOfflineDraftState,
} from "@/lib/samiksha/offlineSync";

const STEPS: { id: TabId; hi: string; en: string; n: string; stageEn: string; stageHi: string }[] = [
  { id: "upload", n: "01", hi: "डेटा जाँच", en: "Join and validate", stageEn: "Stage 1 · Join", stageHi: "चरण 1 · जोड़ें" },
  { id: "brief", n: "02", hi: "समीक्षा एजेंडा", en: "One-page brief", stageEn: "Stage 2 · Brief", stageHi: "चरण 2 · एजेंडा" },
  { id: "approve", n: "03", hi: "निर्णय व अनुमोदन", en: "Decide and approve", stageEn: "Stage 3 · Decide", stageHi: "चरण 3 · निर्णय" },
  { id: "follow", n: "04", hi: "मैदानी फॉलो-अप", en: "Bot and escalation", stageEn: "Stage 4 · Follow Up", stageHi: "चरण 4 · फॉलो-अप" },
  { id: "score", n: "05", hi: "स्कोरकार्ड व लागत", en: "Next round and cost", stageEn: "Stage 5 · Scorecard", stageHi: "चरण 5 · स्कोरकार्ड" },
];

export function Workspace() {
  const tab = useCycle((s) => s.tab);
  const setTab = useCycle((s) => s.setTab);
  const { cycle, cycleId, liveCycleId, tasks, messages, r4Loaded, onDevice } = useView();
  const [signalTest, setSignalTest] = useState(false);
  // The one-click signal test: the same events the browser fires when the signal changes, so the outbox, the badge and React Query all follow it.
  const toggleSignal = () => {
    const next = !isSimulatedOffline();
    setSimulatedOffline(next);
    setSignalTest(next);
    window.dispatchEvent(new Event(next ? "offline" : "online"));
  };
  const { refresh } = useActions();
  const briefSeen = useCycle((s) => s.briefSeen);
  const hingeStudio = useCycle((s) => s.hingeStudio);
  const closeHingeStudio = useCycle((s) => s.closeHingeStudio);
  const lang = useCycle((s) => s.lang);
  const setLang = useCycle((s) => s.setLang);
  const en = lang === "en";
  const transcript = useCycle((s) => s.transcript);
  const stateCodeManual = useCycle((s) => s.stateCodeManual);
  const setStateCode = useCycle((s) => s.setStateCode);
  const stateCode = useCycle((s) => s.stateCode);
  const role = useCycle((s) => s.role);
  const topGapsLimit = useCycle((s) => s.topGapsLimit);
  const activeCluster = useCycle((s) => s.activeCluster);
  const sessionCluster = useCycle((s) => s.sessionCluster);
  const offline = useCycle((s) => s.offline);
  const pendingOutbox = useCycle((s) => s.pendingOutbox);
  const setConnectivity = useCycle((s) => s.setConnectivity);
  const meetingMode = useCycle((s) => s.meetingMode);
  const setMeetingMode = useCycle((s) => s.setMeetingMode);
  const [draftNoteText, setDraftNoteText] = useState<string | null>(null);

  // A cycle built elsewhere (curl, the bot's /seed, another machine) shows up here.
  useEffect(() => {
    if (cycleId !== null && liveCycleId !== null && liveCycleId !== cycleId) void refresh();
  }, [cycleId, liveCycleId, refresh]);

  // The state profile follows the file. A Bihar export is detected as Bihar, so
  // the officer titles and the scale on screen are the ones of that state — not
  // the default. A manual choice by the officer still wins.
  useEffect(() => {
    const detected = cycle?.detectedStateCode;
    if (!detected || stateCodeManual) return;
    if (useCycle.getState().stateCode !== detected) setStateCode(detected, false);
  }, [cycle?.detectedStateCode, stateCodeManual, setStateCode]);

  // The working state is written to the device as it is typed, so a dropped
  // connection or a reload does not lose a dictated review, the chosen role,
  // the cluster or the stage the officer was on.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = window.setTimeout(() => {
      void saveOfflineDraftState({
        transcript,
        role,
        clusterId: sessionCluster ?? activeCluster,
        stateCode,
        topGapsLimitUserPicked: topGapsLimit,
        step: tab,
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [transcript, role, sessionCluster, activeCluster, stateCode, topGapsLimit, tab]);

  // On load, bring back the state that was left on the device.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    void (async () => {
      const saved = await loadOfflineDraftState();
      if (cancelled || !saved) return;
      const now = useCycle.getState();
      if (!now.transcript.trim() && saved.transcript.trim()) now.setTranscript(saved.transcript);
      if (now.topGapsLimit !== saved.topGapsLimitUserPicked && saved.topGapsLimitUserPicked) {
        now.setTopGapsLimit(saved.topGapsLimitUserPicked as typeof now.topGapsLimit);
      }
      if (saved.stateCode && saved.stateCode !== now.stateCode) now.setStateCode(saved.stateCode as typeof now.stateCode, true);
      const note = draftNote(saved, now.lang);
      if (note) setDraftNoteText(note.en);
    })();
    return () => {
      cancelled = true;
    };
  }, [setDraftNoteText]);

  // The connection badge: offline, and how much is waiting to be sent. When the
  // signal comes back, the queued actions go out one by one.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      const off = isOffline();
      setConnectivity(off);
      if (!off) {
        void outboxCount().then((n) => setConnectivity(false, n));
        void flushOfflineOutbox(async (item) => {
          const ok = await sendOfflineAction(item.action, item.payload);
          return ok;
        }).then((r) => {
          if (r.sent) void outboxCount().then((n) => setConnectivity(false, n));
        });      }
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [setConnectivity]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang === "hi" ? "hi" : "en";
  }, [lang]);

  const done = (id: TabId) => {
    if (id === "upload") return Boolean(cycle);
    if (id === "brief") return briefSeen;
    if (id === "approve") return tasks.length > 0;
    if (id === "follow") return messages.length > 0;
    return r4Loaded;
  };

  const index = STEPS.findIndex((step) => step.id === tab);
  const prev = index > 0 ? STEPS[index - 1] : null;
  const next = index < STEPS.length - 1 ? STEPS[index + 1] : null;
  const current = STEPS[index] ?? STEPS[0]!;
  const verified = STEPS.filter((step) => done(step.id)).length;

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="no-print border-b border-rule bg-sheet">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-4 lg:px-8">
          <Seal />
          <div className="min-w-0 flex-1">
            <p className="font-display text-2xl leading-tight font-bold text-ink">{en ? "Samiksha Saathi" : "समीक्षा साथी"}</p>
            <p className="mt-1 text-sm text-muted">
              {en ? "AI co-pilot for the monthly block education review" : "मासिक विकासखंड शिक्षा समीक्षा हेतु एआई सह-पायलट"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <fieldset className="inline-flex h-11 items-center rounded-lg border border-rule bg-paper p-1">
              <legend className="sr-only">{en ? "Language" : "भाषा"}</legend>
              <button
                type="button"
                aria-pressed={en}
                onClick={() => setLang("en")}
                className={`h-9 rounded-md px-3 text-sm font-semibold ${en ? "bg-seal text-seal-fg" : "text-muted"}`}
              >
                English
              </button>
              <button
                type="button"
                aria-pressed={!en}
                onClick={() => setLang("hi")}
                className={`h-9 rounded-md px-3 text-sm font-semibold ${!en ? "bg-seal text-seal-fg" : "text-muted"}`}
              >
                हिन्दी
              </button>
            </fieldset>
            <HingeButton />
            <button
              type="button"
              aria-pressed={meetingMode}
              onClick={() => setMeetingMode(!meetingMode)}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${meetingMode ? "border-seal bg-seal text-seal-fg" : "border-rule bg-sheet"}`}
            >
              {meetingMode ? (en ? "⚡ Meeting mode on" : "⚡ मीटिंग मोड चालू") : en ? "🛠️ Full diagnostics" : "🛠️ पूरी डायग्नोस्टिक"}
            </button>
            <Chip tone="seal">{en ? "Block: Kesli (MP) · 110 Schools · 2023-24 to 2025-26" : "विकासखंड: केसली (म.प्र.) · 110 विद्यालय · 2023-24 से 2025-26"}</Chip>
            {/* The figures are seeded, not a real block's: a quiet label keeps that clear without a banner. */}
            <Chip>{en ? "Review 30 Nov 2025 · Demo data" : "समीक्षा 30 नवम्बर 2025 · डेमो डेटा"}</Chip>
            <button
              type="button"
              aria-pressed={signalTest}
              onClick={toggleSignal}
              title={offline ? (en ? "Tap to go back online" : "फिर से ऑनलाइन होने के लिए दबाएँ") : en ? "Switch to low-data / offline mode" : "कम-डेटा / ऑफ़लाइन मोड चालू करें"}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${offline ? "border-flag bg-flag-soft text-flag" : "border-rule bg-sheet"}`}
            >
              {offline ? (en ? "📶 Network: Low-Data / Offline Mode" : "📶 नेटवर्क: कम-डेटा / ऑफ़लाइन मोड") : en ? "📶 Network: Online" : "📶 नेटवर्क: ऑनलाइन"}
            </button>
            {offline ? (
              <Chip tone="flag">
                {en
                  ? `📡 Offline Mode — Drafts & Replies Cached Locally${pendingOutbox ? ` · ${pendingOutbox} waiting to send` : ""}`
                  : `📡 ऑफ़लाइन मोड — ड्राफ्ट व उत्तर स्थानीय रूप से सहेजे गए${pendingOutbox ? ` · ${pendingOutbox} भेजने की प्रतीक्षा में` : ""}`}
              </Chip>
            ) : (
              <Chip tone="ok">💾 {en ? "Saved on this device" : "इस डिवाइस पर सहेजा गया"}</Chip>
            )}
            {pendingOutbox && !offline ? (
              <Chip tone="flag">{en ? `${pendingOutbox} waiting to send` : `${pendingOutbox} भेजने की प्रतीक्षा में`}</Chip>
            ) : null}
          </div>
        </div>
      </header>
      {offline ? (
        <div role="status" className="no-print border-b border-flag/40 bg-flag-soft">
          <p className="mx-auto max-w-7xl px-4 py-2.5 text-sm font-semibold text-flag lg:px-8">
            {en
              ? `Offline / low-data mode: this device keeps working with no connection. The ${onDevice ? "block cycle, rebuilt on this device," : "loaded cycle"}, the brief, Top 5/10/15, the cleaning preview, the photo checks and your drafts all run here. ${pendingOutbox} action(s) wait in the outbox and are sent when the signal returns. Claude's reorder and Telegram sending need the connection.`
              : `ऑफ़लाइन / कम-डेटा मोड: बिना कनेक्शन के यह डिवाइस काम करता रहता है। ${onDevice ? "विकासखंड चक्र (इसी डिवाइस पर बना)" : "लोड किया गया चक्र"}, एजेंडा, शीर्ष 5/10/15, सफाई पूर्वावलोकन, फोटो जाँच और ड्राफ्ट यहीं चलते हैं। ${pendingOutbox} कार्य आउटबॉक्स में हैं, संकेत लौटने पर भेजे जाएँगे। Claude का क्रम और टेलीग्राम भेजना कनेक्शन माँगते हैं।`}
          </p>
        </div>
      ) : null}
      {draftNoteText ? (
        <div className="no-print border-b border-rule bg-flag-soft/60">
          <p className="mx-auto max-w-7xl px-4 py-2.5 text-sm text-flag lg:px-8">{draftNoteText}</p>
        </div>
      ) : null}
      <RoleBar />
      <RoleMissionStrip />
      <HingeBar />

      {/* On a phone the stage list is a horizontal scroller far down the page. This bar keeps the stage, and the way forward, in reach. */}
      <div className="no-print sticky top-0 z-30 border-b border-rule bg-sheet/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && setTab(prev.id)}
            aria-label={en ? "Previous stage" : "पिछला चरण"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rule bg-sheet text-lg disabled:opacity-30"
          >
            ‹
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">
              {en ? `Step ${current.n} of 5 · ${verified}/5 verified` : `चरण ${current.n} / 5 · ${verified}/5 जाँचे गए`}
            </p>
            <p className="truncate text-sm font-semibold">{en ? current.en : current.hi}</p>
          </div>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && setTab(next.id)}
            aria-label={en ? "Next stage" : "अगला चरण"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rule bg-sheet text-lg disabled:opacity-30"
          >
            ›
          </button>
        </div>
        <div className="flex gap-1 px-4 pb-2" aria-hidden>
          {STEPS.map((s) => (
            <span key={s.id} className={`h-1.5 flex-1 rounded-full ${s.id === tab ? "bg-seal" : done(s.id) ? "bg-ok-soft" : "bg-rule"}`} />
          ))}
        </div>
      </div>

      {/* The district command view belongs to the DEO and the SPD. The CRCC's cluster desk lives on the Follow tab. */}
      <div className="mx-auto max-w-7xl space-y-6 px-4 pt-6 lg:px-8">
        <EvaluatorGuide />
        <ArchitecturePanel />
        <DistrictCommandPanel />
      </div>

      <div className="no-print border-b border-rule bg-sheet-2">
        <p className="mx-auto max-w-7xl px-4 py-3 text-sm text-muted lg:px-8">
          {en
            ? "Zero student PII · Code does the maths · Nothing is sent before the officer approves."
            : "विद्यार्थी-स्तरीय कोई पहचान नहीं · गणित कोड करता है · अनुमोदन से पहले कुछ नहीं भेजा जाता।"}
        </p>
      </div>

      <div className="mx-auto grid w-full min-w-0 max-w-7xl px-4 py-6 md:grid-cols-[18.5rem_minmax(0,1fr)] md:gap-8 lg:px-8 lg:py-8">
        <nav className="no-print min-w-0">
          <p className="mb-3 px-1 text-xs font-semibold tracking-wider text-muted uppercase">
            {en ? "Monthly review loop (5 stages)" : "मासिक समीक्षा चक्र (5 चरण)"}
          </p>
          <div className="flex w-full min-w-0 gap-3 overflow-x-auto pb-2 md:flex-col md:gap-3.5 md:overflow-visible">
            {STEPS.map((step) => {
              const active = tab === step.id;
              return (
                <button
                  key={step.id}
                  onClick={() => setTab(step.id)}
                  className={`flex min-w-64 items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all md:min-w-0 ${active ? "border-seal bg-seal text-seal-fg shadow-sm" : "border-rule bg-sheet text-ink hover:border-rule-strong hover:bg-sheet-2/60"}`}
                >
                  <span className={`tabular inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${active ? "bg-seal-fg/15 text-seal-fg" : "bg-seal-soft text-seal"}`}>
                    {step.n}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[11px] font-semibold tracking-wider uppercase ${active ? "text-seal-fg/75" : "text-muted"}`}>
                      {en ? step.stageEn : step.stageHi}
                    </span>
                    <span className="mt-0.5 block text-sm leading-snug font-semibold">{en ? step.en : step.hi}</span>
                    {/* What runs underneath this stage, from the cycle on screen. */}
                    <span className={`mt-1 line-clamp-3 block text-[11px] leading-snug md:line-clamp-none ${active ? "text-seal-fg/80" : "text-muted"}`}>
                      {stageNote(step.id, cycle)[lang]}
                    </span>
                  </span>
                  {done(step.id) ? (
                    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${active ? "bg-seal-fg/15 text-seal-fg" : "bg-ok-soft text-ok"}`} aria-label={en ? "Done" : "पूर्ण"}>
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mt-6 hidden rounded-xl border border-rule bg-sheet p-4 md:block">
            <p className="text-sm font-semibold">{en ? `${verified} / 5 stages verified` : `${verified} / 5 चरण जाँचे गए`}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {en
                ? "Code does the maths · Claude does the language · Officer approves."
                : "गणित कोड करता है · भाषा Claude करता है · अधिकारी अनुमोदन करता है।"}
            </p>
          </div>
        </nav>
        <main className="min-w-0">
          {hingeStudio ? (
            <>
              <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
                <Btn kind="ghost" onClick={closeHingeStudio}>
                  {en ? "← Back to the review loop" : "← समीक्षा चक्र पर वापस"}
                </Btn>
              </div>
              <HingeStudio />
            </>
          ) : (
            <>
              {tab === "upload" ? <UploadTab /> : null}
              {tab === "brief" ? <BriefTab /> : null}
              {tab === "approve" ? <ApproveTab /> : null}
              {tab === "follow" ? <FollowTab /> : null}
              {tab === "score" ? <ScoreTab /> : null}
            </>
          )}
          <div className="no-print mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
            {prev ? (
              <Btn kind="ghost" onClick={() => setTab(prev.id)}>
                {en ? "← Previous Stage" : "← पिछला चरण"}
              </Btn>
            ) : (
              <span />
            )}
            {next ? (
              <Btn kind="primary" onClick={() => setTab(next.id)}>
                {en ? `Continue to Step ${next.n} →` : `चरण ${next.n} पर जाएँ →`}
              </Btn>
            ) : null}
          </div>
        </main>
      </div>
      {/* One line of provenance: what the data is, and that no child-level record is in it. */}
      <footer className="border-t border-rule bg-sheet-2">
        <p className="mx-auto max-w-7xl px-4 py-4 text-xs text-muted lg:px-8">
          {en
            ? "Samiksha Saathi · Demo pilot dataset: Kesli block (110 schools, 2023-24 to 2025-26) · School-level aggregates only, no child-level data (DPDP Act 2023 §9)"
            : "समीक्षा साथी · डेमो पायलट डेटा: केसली विकासखंड (110 विद्यालय, 2023-24 से 2025-26) · केवल विद्यालय-स्तरीय योग, कोई बाल-स्तरीय डेटा नहीं (DPDP अधिनियम 2023 §9)"}
        </p>
      </footer>
    </div>
  );
}
