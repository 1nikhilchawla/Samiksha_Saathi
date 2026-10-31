import { useState } from "react";
import { Btn, Chip } from "@/components/samiksha/ui";
import type { FailureDiagnosticEntry, FailureSurface } from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

/**
 * /why on screen: the latest failure for these surfaces, as stage 1 (what
 * caught it, how sure) and stage 2 (why, and how to fix it). The plain-words
 * button asks the model to reword it; that call is capped and second-checked,
 * and the exact explanation stays if the rewording fails the check.
 */
export function FailureWhy({ surfaces, entry: given }: { surfaces?: FailureSurface[]; entry?: FailureDiagnosticEntry | null }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { failures, services } = useView();
  const { explainFailure } = useActions();
  const [worded, setWorded] = useState<{ id: string; entry: FailureDiagnosticEntry; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = given ?? failures.find((f) => !surfaces || surfaces.includes(f.surface)) ?? null;
  if (!latest) return null;
  const shown = worded && worded.id === latest.id ? worded.entry : latest;
  const pct = Math.round(shown.gate.confidence * 100);

  return (
    <div className="rounded-xl border border-flag bg-flag-soft/40 p-4 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="flag">{shown.code}</Chip>
        <span className="font-semibold">{shown.gate.summary[lang]}</span>
        <span className="text-xs text-muted">
          {en
            ? `Caught by ${shown.gate.source === "laya" ? "Laya" : "a fixed rule"} · certainty ${pct}%`
            : `${shown.gate.source === "laya" ? "Laya" : "नियम"} ने पकड़ा · निश्चितता ${pct}%`}
        </span>
      </div>
      <p className="mt-2">{shown.explanation.whyFailed[lang]}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {shown.explanation.howToFix[lang].map((x) => <li key={x}>{x}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn
          kind="ghost"
          disabled={busy || !services.model || shown.explanation.source === "model"}
          title={services.model ? undefined : en ? "The plain-words rewording is not available right now; the exact reason is shown above" : "सरल शब्दों में पुनर्लेखन अभी उपलब्ध नहीं; सटीक कारण ऊपर है"}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await explainFailure();
              if (r.entry) setWorded({ id: latest.id, entry: r.entry, note: r.note });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (en ? "Asking…" : "पूछ रहे हैं…") : en ? "Ask why in plain words (/why)" : "सरल शब्दों में क्यों (/why)"}
        </Btn>
        <span className="text-xs text-muted">
          {shown.explanation.source === "model"
            ? en ? `Reworded in plain words by the AI co-pilot; ${worded?.note ?? ""}` : `AI सह-पायलट ने सरल शब्दों में लिखा; ${worded?.note ?? ""}`
            : en ? "Exact explanation from the facts. On Telegram, send /why." : "तथ्यों से सटीक कारण। टेलीग्राम पर /why भेजें।"}
        </span>
      </div>
    </div>
  );
}
