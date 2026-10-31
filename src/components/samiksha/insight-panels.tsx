import { useMemo, useState } from "react";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import {
  LOOP_STATUS_LABEL,
  computeHingePoints,
  computeTrustAndWorkload,
  evaluateLoopHealth,
  runSelfChecks,
  type LoopStatus,
} from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

/** Trust pillars (measured) and the code/AI/officer workload split (design estimate). */
export function TrustPanel({ compact = false }: { compact?: boolean }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { cycle, tasks } = useView();
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const result = useMemo(() => (cycle ? computeTrustAndWorkload(cycle, tasks, runSelfChecks(cycle)) : null), [cycle, tasks]);
  if (!result) return null;
  const m = result.measured;

  const verify = async () => {
    setRunning(true);
    try {
      // Re-run the pipeline and every self-check from scratch, on this device.
      runSelfChecks(cycle!);
      setVerifiedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel className="no-print">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "Officer trust and AI workload split" : "अधिकारी विश्वास व एआई कार्यभार विभाजन"}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {en
              ? "What the co-pilot does, what stays with the officer, and the live checks behind the numbers."
              : "सह-पायलट क्या करता है, अधिकारी के पास क्या रहता है, और आँकड़ों के पीछे की जीवित जाँच।"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={result.trustPct === 100 ? "seal" : "flag"}>{en ? `Trust checks ${result.trustPct}%` : `विश्वास जाँच ${result.trustPct}%`}</Chip>
          <Btn kind="ghost" disabled={running} onClick={() => void verify()}>
            {running ? (en ? "Verifying…" : "जाँच हो रही है…") : en ? "Verify now" : "अभी जाँचें"}
          </Btn>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex h-4 overflow-hidden rounded-full border border-rule" aria-hidden>
          <div className="bg-seal" style={{ width: `${result.automatedPct}%` }} />
          <div className="bg-rule-strong" style={{ width: `${result.officerPct}%` }} />
        </div>
        <p className="mt-1.5 text-sm">
          {en
            ? `${result.automatedPct} / ${result.officerPct} — about ${result.automatedPct}% of the month's routine work by code, AI and bot, ${result.officerPct}% with the officer, including every approval.`
            : `${result.automatedPct} / ${result.officerPct} — माह के नियमित काम का लगभग ${result.automatedPct}% कोड, एआई व बॉट से, ${result.officerPct}% अधिकारी के पास, हर अनुमोदन सहित।`}
          <span className="text-muted"> {en ? "Design estimate, not a measurement." : "डिज़ाइन अनुमान, मापा हुआ नहीं।"}</span>
        </p>
        {/* The Laya-assisted design target, beside the baseline split: both are targets, and the measured share follows. */}
        <div className="mt-3 flex h-4 overflow-hidden rounded-full border border-rule" aria-hidden>
          <div className="bg-seal" style={{ width: `${result.layaAssistedAutomatedPct}%` }} />
          <div className="bg-rule-strong" style={{ width: `${result.layaAssistedOfficerPct}%` }} />
        </div>
        <p className="mt-1.5 text-sm">
          {en
            ? `${result.layaAssistedAutomatedPct} / ${result.layaAssistedOfficerPct} with Laya auto-fill — ${result.automatedPct}% code and AI on the baseline (${result.officerPct}% officer) rises to ${result.layaAssistedAutomatedPct}% when Laya proposes the missing owners and dates; the officer keeps ${result.layaAssistedOfficerPct}%: approval, ownership and the physical spot check.`
            : `${result.layaAssistedAutomatedPct} / ${result.layaAssistedOfficerPct} लाया ऑटो-फिल के साथ — आधार पर ${result.automatedPct}% कोड व एआई (${result.officerPct}% अधिकारी), लाया द्वारा छूटे जिम्मेदार व तिथियाँ प्रस्तावित होने पर ${result.layaAssistedAutomatedPct}%; अधिकारी के पास ${result.layaAssistedOfficerPct}%: अनुमोदन, जिम्मेदारी और भौतिक औचक जाँच।`}
          <span className="text-muted"> {en ? "Also a design target, not a measurement." : "यह भी डिज़ाइन लक्ष्य है, मापा हुआ नहीं।"}</span>
        </p>
        {/* The measured share, next to the design estimate. Every input shows its own count. */}
        <div className="mt-3 rounded-lg border border-rule bg-paper/60 p-3">
          <p className="text-sm font-semibold">
            {en ? `Measured on this cycle: ${result.automation.pct}%` : `इस चक्र पर मापा गया: ${result.automation.pct}%`}
          </p>
          <p className="mt-1 text-xs text-muted">{en ? result.automation.note.en : result.automation.note.hi}</p>
          <ul className="mt-2 space-y-1">
            {result.automation.inputs.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 text-xs">
                <span>{en ? i.label.en : i.label.hi}</span>
                <span className="tabular font-semibold">
                  {i.pct}% · {i.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {verifiedAt ? (
          <p className="mt-1 text-xs text-seal">
            {en ? `Self-checks re-run on this device at ${verifiedAt}.` : `स्व-जाँच इसी डिवाइस पर ${verifiedAt} बजे फिर चलीं।`}
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Measured
          label={en ? "Real run time" : "वास्तविक निष्पादन समय"}
          value={`${m.actualComputeMs} ms`}
          note={en ? `instead of ${m.manualJoinBaseline.en}` : `${m.manualJoinBaseline.hi} के बजाय`}
        />
        <Measured
          label={en ? "Data cleaned automatically" : "स्वतः साफ़ किया गया डेटा"}
          value={`${m.dataCleaningAutomationPct}%`}
          note={en ? `${m.autoFixedRowsCount} values fixed · ${m.dataProblemsFlaggedForHuman} left for a person` : `${m.autoFixedRowsCount} मान सुधरे · ${m.dataProblemsFlaggedForHuman} व्यक्ति के लिए`}
        />
        <Measured
          label={en ? "Task fields complete" : "कार्य क्षेत्र पूर्ण"}
          value={`${m.taskFieldsCompletePct}%`}
          note={en ? `${m.taskFieldsFilled} of ${m.taskFieldsTotal} fields filled` : `${m.taskFieldsTotal} में से ${m.taskFieldsFilled} क्षेत्र भरे`}
        />
        <Measured
          label={en ? "Approved by an officer" : "अधिकारी द्वारा अनुमोदित"}
          value={`${m.approvalsByOfficer} / ${m.approvalsTotal}`}
          note={en ? "every approval carries a name and a time" : "हर अनुमोदन पर नाम व समय है"}
        />
      </div>

      {compact ? null : (
        <ul className="mt-4 space-y-3 text-sm">
          {result.stages.map((s) => (
            <li key={s.id}>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{s.label[lang]}</span>
                <span className="tabular text-muted">{`${s.automatedPct}% ${s.automatedBy[lang]} · ${100 - s.automatedPct}% ${en ? "officer" : "अधिकारी"}`}</span>
              </div>
              <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-sheet-2" aria-hidden>
                <div className="bg-seal" style={{ width: `${s.automatedPct}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">{`${s.before[lang]} → ${s.after[lang]} · ${en ? "officer" : "अधिकारी"}: ${s.officerShare[lang]}`}</p>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {result.pillars.map((p) => (
          <li key={p.id} className={`rounded-lg border p-3 text-sm ${p.pass ? "border-rule" : "border-flag bg-flag-soft"}`}>
            <p className="font-semibold">{p.pass ? "✓" : "✗"} {p.label[lang]}</p>
            {compact ? null : <p className="mt-1 text-xs text-muted">{p.evidence[lang]}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Measured({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper/60 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular font-display text-xl font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{note}</p>
    </div>
  );
}

const STATUS_TONE: Record<LoopStatus, "seal" | "flag" | "plain" | "ok"> = {
  REPAIRED: "ok",
  GUARDRAIL_ACTIVE: "seal",
  BOX_TICKING_SUSPECTED: "flag",
  CAUGHT_IN_R4: "flag",
  WAITING: "plain",
  AT_RISK: "flag",
};

/** The six places a review loop breaks, and this cycle's status at each. */
export function LoopHealthPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const setTab = useCycle((s) => s.setTab);
  const { cycle, tasks, scorecard, simToday, hingeDecisions } = useView();
  const { runPivot } = useActions();
  const [busy, setBusy] = useState<number | null>(null);
  const points = cycle ? evaluateLoopHealth(cycle, tasks, scorecard, hingeDecisions) : [];
  const hinges = useMemo(
    () => (cycle ? computeHingePoints(cycle, tasks, scorecard, simToday) : []),
    [cycle, tasks, scorecard, simToday],
  );

  if (!cycle) return null;

  const repair = async (breakId: number) => {
    const bp = points.find((p) => p.id === breakId);
    if (!bp?.repairBy) return;
    const hp = hinges.find((h) => h.code === bp.repairBy);
    if (!hp) return;
    if (hp.notifiesTelegram) {
      const ok = window.confirm(
        en
          ? `${hp.code} tells the DEO on Telegram. This is a real message to a real chat. Continue?`
          : `${hp.code} DEO को टेलीग्राम पर सूचना देता है। यह एक वास्तविक संदेश है। जारी रखें?`,
      );
      if (!ok) return;
    }
    setBusy(breakId);
    try {
      await runPivot(hp.pivotId, hp.notifiesTelegram);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Feedback loop resilience monitor" : "फीडबैक लूप सुरक्षा व टूटन निवारण"}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {en ? "Where a monthly review usually breaks in a district, and what this cycle shows at each point." : "जिले में मासिक समीक्षा आमतौर पर कहाँ टूटती है, और इस चक्र में हर बिंदु पर क्या दिखता है।"}
      </p>
      <ol className="mt-4 grid gap-3 md:grid-cols-2">
        {points.map((p) => (
          <li key={p.id} className="rounded-xl border border-rule p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{`${p.id} · ${p.title[lang]}`}</p>
              <Chip tone={STATUS_TONE[p.status]}>{LOOP_STATUS_LABEL[p.status][lang]}</Chip>
            </div>
            <p className="mt-1 text-xs text-muted">{en ? "Usually fails because: " : "आमतौर पर टूटता है: "}{p.failure[lang]}</p>
            <p className="mt-2 text-sm">{p.evidence[lang]}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn kind="ghost" onClick={() => setTab(p.tab)}>{en ? "Inspect →" : "देखें →"}</Btn>
              {p.repairBy ? (
                <Btn kind="soft" disabled={busy === p.id} onClick={() => void repair(p.id)}>
                  {busy === p.id
                    ? en ? "Repairing…" : "सुधार रहा है…"
                    : en ? `Repair with ${p.repairBy} →` : `${p.repairBy} से सुधारें →`}
                </Btn>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
