import { useMemo, useState } from "react";
import { Btn, Chip, Pager, Panel, TableHead, fieldClass } from "@/components/samiksha/ui";
import {
  SUGGESTED_CLEANING_RULES,
  applyCleaningAst,
  buildCleaningPreview,
  compileRuleWithLlmFallback,
  parseAndApplyCustomCleaningRule,
  schoolsToCsv,
  type CleaningResult,
  type Cycle,
  type SchoolRow,
} from "@/lib/samiksha/engine";
import { useCan, useCycle } from "@/lib/samiksha/store";
import { useActions } from "@/lib/samiksha/view";

const PAGE = 8;

function saveCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Before → after for every change the reader made, and officer rules in English, Hindi or Hinglish. */
export function CleaningStudio({ cycle }: { cycle: Pick<Cycle, "fixes" | "problems" | "headerMaps" | "schools"> }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const [view, setView] = useState<"preview" | "rules">("preview");
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "Data cleaning preview and rules studio" : "डेटा सफाई पूर्वावलोकन व सुझाव स्टूडियो"}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {en
              ? "See exactly what the reader changed, file by file and row by row, and try your own cleaning rule in English, Hindi or Hinglish."
              : "देखें कि रीडर ने फाइल और पंक्ति के हिसाब से क्या बदला, और अंग्रेज़ी, हिन्दी या हिंग्लिश में अपना सफाई नियम आज़माएँ।"}
          </p>
        </div>
        <div className="flex gap-2">
          <Btn kind={view === "preview" ? "primary" : "ghost"} onClick={() => setView("preview")}>{en ? "A · Before / after" : "A · पहले / बाद"}</Btn>
          <Btn kind={view === "rules" ? "primary" : "ghost"} onClick={() => setView("rules")}>{en ? "B · Rule builder" : "B · नियम बनाएँ"}</Btn>
        </div>
      </div>
      {view === "preview" ? <BeforeAfter cycle={cycle} /> : <RuleBuilder schools={cycle.schools} />}
    </Panel>
  );
}

function BeforeAfter({ cycle }: { cycle: Pick<Cycle, "fixes" | "problems" | "headerMaps" | "schools"> }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const rows = useMemo(() => buildCleaningPreview(cycle), [cycle]);
  const [page, setPage] = useState(0);
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{en ? `${rows.length} changes and flags on this cycle.` : `इस चक्र में ${rows.length} बदलाव व चिह्न।`}</p>
        <Btn kind="ghost" onClick={() => saveCsv("samiksha_cleaned_schools.csv", schoolsToCsv(cycle.schools))}>
          {en ? "Download cleaned CSV" : "साफ CSV डाउनलोड"}
        </Btn>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <TableHead cols={en ? ["File & row", "Before (raw)", "After (cleaned)", "Rule"] : ["फाइल व पंक्ति", "पहले (मूल)", "बाद (साफ)", "नियम"]} />
          <tbody>
            {rows.slice(page * PAGE, page * PAGE + PAGE).map((r, i) => (
              <tr key={`${r.file}-${r.row}-${i}`} className="border-t border-rule">
                <td className="px-4 py-3">{r.file}{r.row ? ` · ${r.row}` : ""}</td>
                <td className="tabular px-4 py-3 text-flag">{r.before}</td>
                <td className="tabular px-4 py-3 font-medium">{r.after}</td>
                <td className="px-4 py-3 text-muted">{r.rule[lang]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.ceil(rows.length / PAGE)} onPage={setPage} />
    </div>
  );
}

function RuleBuilder({ schools }: { schools: Cycle["schools"] }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const can = useCan();
  const { cleaningModel, commitCleaning } = useActions();
  const [text, setText] = useState("");
  const [applied, setApplied] = useState<CleaningResult | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [committed, setCommitted] = useState<number | null>(null);
  const preview = useMemo(() => (text.trim() ? parseAndApplyCustomCleaningRule(text, schools) : null), [text, schools]);
  const canCommit = can("upload_block_files").allowed;

  const askModel = async () => {
    setModelBusy(true);
    setModelNote(null);
    try {
      // The server compiles the rule into the same AST the on-device tiers produce,
      // and the AST is applied here to a working copy.
      const r = await cleaningModel(text);
      setModelNote(r.note);
      if (r.understood) {
        const appliedLocal = applyCleaningAst(r.ast, schools, "model");
        setApplied(appliedLocal);
      }
    } catch (err) {
      setModelNote(err instanceof Error ? err.message : "The model call failed.");
    } finally {
      setModelBusy(false);
    }
  };

  // Only trimmed names are written to the cycle; flags, cluster-mean fills and caps stay in the preview.
  const writable = applied ? applied.previewDiffs.filter((d) => d.field === "nameEn").length : 0;

  const commit = async () => {
    if (!applied || !writable) return;
    const ok = window.confirm(
      en
        ? `This writes ${writable} trimmed school name${writable === 1 ? "" : "s"} into the live cycle (logged before and after). Fills and caps are not written. It is undone only by re-running the cycle from its files. Continue?`
        : `इससे चालू चक्र में ${writable} साफ किए गए विद्यालय नाम लिखे जाएँगे (पहले-बाद सहित दर्ज)। भरे मान और सीमा नहीं लिखे जाते। पलटने के लिए फाइलों से चक्र फिर चलाना होगा। जारी रखें?`,
    );
    if (!ok) return;
    await commitCleaning(applied.ast);
    setCommitted(writable);
  };

  return (
    <div className="mt-4 space-y-3">
      <input
        className={fieldClass}
        value={text}
        onChange={(e) => { setText(e.target.value); setCommitted(null); }}
        placeholder={en ? "e.g. jin schools me attendance 65% se kam hai unko flag karo / impute missing with cluster mean…" : "जैसे: jin schools me attendance 65% se kam hai unko flag karo…"}
        aria-label={en ? "Cleaning rule" : "सफाई नियम"}
      />
      <div className="flex flex-wrap gap-2">
        {SUGGESTED_CLEANING_RULES.map((r) => (
          <button key={r.id} type="button" onClick={() => { setText(r.instruction); setCommitted(null); }} className="min-h-9 rounded-full border border-rule bg-sheet px-3 text-xs font-semibold">
            {r.label[lang]}
          </button>
        ))}
      </div>
      {preview ? (
        <div className="rounded-lg border border-rule bg-paper/60 p-4 text-sm">
          <p className={preview.understood ? "" : "text-flag"}>{en ? preview.ruleSummaryEn : preview.ruleSummaryHi}</p>
          {preview.previewDiffs.length ? (
            <ul className="mt-2 space-y-1 text-muted">
              {preview.previewDiffs.slice(0, 8).map((d, i) => (
                <li key={`${d.code}-${d.field}-${i}`}>
                  {d.school} · {d.field === "flag" ? d.after : `${d.field}: ${d.before} → ${d.after}`} · {d.action[lang]}
                </li>
              ))}
              {preview.previewDiffs.length > 8 ? <li>{en ? `…and ${preview.previewDiffs.length - 8} more` : `…और ${preview.previewDiffs.length - 8}`}</li> : null}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn kind="primary" disabled={!preview.understood} onClick={() => { setApplied(preview); setCommitted(null); }}>{en ? "Apply rule to preview" : "नियम लागू करें"}</Btn>
            <Btn
              kind="ghost"
              disabled={modelBusy || !text.trim()}
              title={en ? "Only if the two on-device tiers could not read the rule" : "केवल जब दो ऑन-डिवाइस स्तर नियम न पढ़ सके"}
              onClick={() => void askModel()}
            >
              {modelBusy ? (en ? "Asking the model…" : "मॉडल से पूछ रहे हैं…") : en ? "Ask the model" : "मॉडल से पूछें"}
            </Btn>
            <Btn kind="ghost" onClick={() => { setApplied(null); setText(""); setModelNote(null); setCommitted(null); }}>{en ? "Reset to canonical baseline" : "मूल आधार पर लौटें"}</Btn>
          </div>
          {modelNote ? <p className="mt-2 text-xs text-muted">{modelNote}</p> : null}
        </div>
      ) : null}
      {applied ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-seal bg-seal-soft p-4 text-sm">
          <span>
            <Chip tone="seal">{en ? `Applied · ${applied.matchedSchoolsCount} schools` : `लागू · ${applied.matchedSchoolsCount} विद्यालय`}</Chip>{" "}
            {en ? "Only this preview and its export changed. The brief and the baseline numbers use the original data." : "केवल यह पूर्वावलोकन और निर्यात बदला। ब्रीफ और स्लाइड 3 मूल डेटा पर हैं।"}
          </span>
          <div className="flex flex-wrap gap-2">
            <Btn kind="ghost" onClick={() => saveCsv("samiksha_custom_rule.csv", schoolsToCsv(applied.updatedSchools, applied.flaggedCodes))}>
              {en ? "Export cleaned CSV" : "साफ CSV निर्यात"}
            </Btn>
            <Btn
              kind="primary"
              disabled={!canCommit || !writable}
              title={!canCommit ? (en ? can("upload_block_files").reasonEn : can("upload_block_files").reasonHi) : !writable ? (en ? "Only trimmed school names are written to the cycle. Flags, cluster-mean fills and caps stay in this preview." : "चक्र में केवल साफ किए गए विद्यालय नाम लिखे जाते हैं। चिह्न, भरे मान और सीमा इसी पूर्वावलोकन में रहते हैं।") : undefined}
              onClick={() => void commit()}
            >
              {en ? "Commit working copy" : "कार्य प्रति कमिट करें"}
            </Btn>
          </div>
        </div>
      ) : null}
      {committed !== null ? (
        <p className="rounded-lg border border-seal bg-seal-soft p-3 text-sm">
          {en
            ? `Committed. ${committed} trimmed school name${committed === 1 ? "" : "s"} written to the cycle, each logged before and after. "Reset" clears this screen only; re-run the cycle from its files to undo the commit.`
            : `कमिट हो गया। ${committed} साफ किए गए विद्यालय नाम चक्र में लिखे गए, हर एक पहले-बाद सहित दर्ज। "रीसेट" केवल यह स्क्रीन साफ करता है; कमिट पलटने के लिए फाइलों से चक्र फिर चलाएँ।`}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        {en
          ? "Tiers 1 and 2 run on this device with fixed patterns and shorthand. The model is tier 3: it is called only when you ask, only up to the monthly cap, and it may only answer with the rule fields above."
          : "स्तर 1 व 2 इसी डिवाइस पर तय पैटर्न और संक्षेप से चलते हैं। मॉडल तीसरा स्तर है: वह तभी बुलाया जाता है जब आप कहें, मासिक सीमा तक ही, और वह केवल ऊपर दिए नियम-क्षेत्रों का उत्तर दे सकता है।"}
      </p>
    </div>
  );
}
