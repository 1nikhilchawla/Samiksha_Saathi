import { useMemo, useState } from "react";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import { computeHingePoints, canPerform, type HingePoint } from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

/**
 * The hinge studio: the five points where the monthly review stalls, each with
 * the two signals that fire it, what the usual step misses (path A) and what the
 * pivot does instead (path B). Below them, the audit trail of the pivots that
 * were actually executed.
 */
export function HingeStudio() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const setTab = useCycle((s) => s.setTab);
  const selectTask = useCycle((s) => s.selectTask);
  const { cycle, tasks, scorecard, simToday, hingeDecisions } = useView();
  const { runPivot, sendDigest } = useActions();
  const [busy, setBusy] = useState<string | null>(null);
  const digestRight = canPerform(role, "send_weekly_digest");

  const points = useMemo(() => (cycle ? computeHingePoints(cycle, tasks, scorecard, simToday) : []), [cycle, tasks, scorecard, simToday]);
  const critical = points.filter((p) => p.severity === "CRITICAL").length;

  if (!cycle) return null;

  const execute = async (p: HingePoint) => {
    // HP-4 messages a real DEO chat on Telegram, so the officer confirms first.
    if (p.notifiesTelegram) {
      const ok = window.confirm(
        en
          ? `${p.code} tells the DEO on Telegram. This is a real message to a real chat. Continue?`
          : `${p.code} DEO को टेलीग्राम पर सूचना देता है। यह एक वास्तविक संदेश है। जारी रखें?`,
      );
      if (!ok) return;
    }
    setBusy(p.code);
    try {
      await runPivot(p.pivotId, p.notifiesTelegram);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl">{en ? "Hinge studio" : "निर्णायक मोड़ स्टूडियो"}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              {en
                ? "Five points where a block review usually stalls. Each needs two signals together, at most one per code and five in all. Path A is what the usual step misses; path B is what the pivot does instead. Only the HP-3 lock is enforced in code; the other four are advisory."
                : "पाँच बिंदु जहाँ विकासखंड समीक्षा सामान्यतः अटकती है। हर बिंदु के लिए दो संकेत साथ चाहिए, हर कोड से अधिकतम एक और कुल पाँच। पथ A वह है जो सामान्य चरण छोड़ता है; पथ B वह है जो निर्णय करता है। केवल HP-3 का लॉक कोड में लागू है; शेष चार सलाहकार हैं।"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={critical ? "flag" : "plain"}>{en ? `${points.length} hinge points · ${critical} critical` : `${points.length} निर्णायक मोड़ · ${critical} गंभीर`}</Chip>
            <Chip>{en ? `5 max per cycle` : `प्रति चक्र अधिकतम 5`}</Chip>
            <Btn
              kind="soft"
              disabled={!digestRight.allowed}
              title={digestRight.allowed ? undefined : en ? digestRight.reasonEn : digestRight.reasonHi}
              onClick={() => {
                const ok = window.confirm(
                  en
                    ? "This queues the weekly digest (these hinge points and every pending task) for the BEO and the linked owners, and sends it on Telegram. Continue?"
                    : "यह साप्ताहिक सारांश (ये निर्णायक मोड़ और हर लंबित कार्य) BEO व जुड़े जिम्मेदारों के लिए कतार में रखकर टेलीग्राम पर भेजता है। जारी रखें?",
                );
                if (ok) void sendDigest();
              }}
            >
              {en ? "Send weekly digest" : "साप्ताहिक सारांश भेजें"}
            </Btn>
          </div>
        </div>
      </Panel>

      {points.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted">{en ? "No hinge point is firing on this cycle." : "इस चक्र में कोई निर्णायक मोड़ सक्रिय नहीं है।"}</p>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {points.map((p) => {
          const right = canPerform(role, p.pivotRight);
          return (
            <Panel key={p.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={p.severity === "CRITICAL" ? "flag" : "plain"}>{`${p.code} · ${p.severity}`}</Chip>
                  <span className="text-xs text-muted">{en ? `Owner: ${p.ownerRole}` : `ज़िम्मेदार: ${p.ownerRole}`}</span>
                </div>
                {p.blocksStageClosure ? <Chip tone="seal">{en ? "Locks the next step" : "अगला कदम रोकता है"}</Chip> : <Chip>{en ? "Advisory" : "सलाहकार"}</Chip>}
              </div>

              <h2 className="mt-3 font-display text-lg font-semibold">{p.title[lang]}</h2>
              <p className="mt-1 text-sm">{p.cause[lang]}</p>

              <div className="mt-3 rounded-lg border border-rule bg-paper/60 p-3 text-sm">
                <p className="font-semibold">{en ? "Fires on two signals together" : "दो संकेत साथ आने पर सक्रिय"}</p>
                <ul className="mt-1 space-y-1">
                  <li>· {p.compoundTrigger.signalA[lang]}</li>
                  <li>· {p.compoundTrigger.signalB[lang]}</li>
                </ul>
                <p className="mt-1 text-xs text-muted">{`Rule: ${p.compoundTrigger.intersectionRule}`}</p>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-flag/40 bg-flag-soft/50 p-3 text-sm">
                  <p className="font-semibold text-flag">{en ? "Path A · the usual step" : "पथ A · सामान्य चरण"}</p>
                  <p className="mt-1">{p.pathAFails[lang]}</p>
                </div>
                <div className="rounded-lg border border-seal bg-seal-soft p-3 text-sm">
                  <p className="font-semibold text-seal">{en ? "Path B · the pivot" : "पथ B · निर्णय"}</p>
                  <p className="mt-1">{p.pathBPivot[lang]}</p>
                </div>
              </div>

              <p className="mt-3 text-sm">
                <span className="font-semibold">{en ? "Ask: " : "पूछें: "}</span>
                {p.diagnosticQuestion[lang]}
              </p>
              {p.blocksStageClosure ? (
                <p className="mt-2 rounded-lg border border-rule bg-sheet-2 p-2 text-xs">
                  <span className="font-semibold">{en ? "Enforced lock: " : "लागू लॉक: "}</span>
                  {p.gateLock[lang]}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                <span className="font-semibold">{en ? "Expected impact: " : "अपेक्षित प्रभाव: "}</span>
                {p.expectedImpact[lang]}
              </p>
              {p.taskNos.length ? (
                <p className="mt-1 text-xs text-muted">
                  {en ? "Tasks: " : "कार्य: "}
                  {p.taskNos.map((n) => `#${n}`).join(", ")}
                  {p.schoolCodes.length ? ` · ${en ? "Schools" : "विद्यालय"}: ${p.schoolCodes.length}` : ""}
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <Btn
                  kind="primary"
                  disabled={!right.allowed || busy === p.code}
                  title={right.allowed ? undefined : en ? right.reasonEn : right.reasonHi}
                  onClick={() => void execute(p)}
                >
                  {busy === p.code ? (en ? "Running…" : "चल रहा है…") : p.pivotButton[lang]}
                </Btn>
                <Btn
                  kind="ghost"
                  onClick={() => {
                    setTab(p.tab);
                    if (p.taskNos.length) selectTask(p.taskNos[0]!);
                  }}
                >
                  {en ? "Go to the stage →" : "चरण पर जाएँ →"}
                </Btn>
              </div>
              {right.allowed ? null : <p className="mt-1 text-xs text-muted">{en ? right.reasonEn : right.reasonHi}</p>}
              {p.notifiesTelegram ? (
                <p className="mt-1 text-xs text-flag">
                  {en ? "This pivot messages the DEO on Telegram. You will be asked to confirm." : "यह निर्णय DEO को टेलीग्राम पर सूचना देता है। पुष्टि पूछी जाएगी।"}
                </p>
              ) : null}
            </Panel>
          );
        })}
      </div>

      <Panel>
        <h2 className="font-display text-xl">{en ? "Executed pivots" : "लागू किए गए निर्णय"}</h2>
        <p className="mt-1 text-sm text-muted">
          {en ? "Every pivot that ran, who ran it, and what it changed. This is the audit trail." : "हर निर्णय, किसने चलाया और क्या बदला। यही ऑडिट ट्रेल है।"}
        </p>
        {hingeDecisions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{en ? "No pivot has been executed on this cycle." : "इस चक्र में कोई निर्णय लागू नहीं हुआ।"}</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {hingeDecisions.map((d) => (
              <li key={d.id} className="rounded-lg border border-rule bg-paper/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="seal">{d.code}</Chip>
                  <span className="text-xs text-muted">{`${d.role} · ${d.at}`}</span>
                </div>
                <p className="mt-1">{d.summary[lang]}</p>
                {d.changes.length ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted">
                    {d.changes.map((c, i) => (
                      <li key={`${c.taskNo}-${i}`}>
                        {`#${c.taskNo}: ${c.from ?? "—"} → ${c.to} · ${c.what[lang]}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
