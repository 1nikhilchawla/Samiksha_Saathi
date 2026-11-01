import { useMemo, useState } from "react";
import { Btn, Chip, Pager, Panel, TableHead, fieldClass } from "@/components/samiksha/ui";
import { CleaningStudio } from "@/components/samiksha/cleaning-studio";
import { ThresholdEditor } from "@/components/samiksha/district-command";
import { MeetingSection } from "@/components/samiksha/meeting-section";
import { FailureWhy } from "@/components/samiksha/failure-why";
import { StateAdapterPanel } from "@/components/samiksha/state-adapter";
import { CONFIG, filterByRoleScope, isSmallSample, MIN_STUDENTS_FOR_FLAG, type Cycle } from "@/lib/samiksha/engine";
import { tx, useCan, useCycle, type Copy, type Lang } from "@/lib/samiksha/store";
import { readUpload, useActions, useView } from "@/lib/samiksha/view";
import { ISSUE_TYPE_LABEL, label, peerRuleText } from "@/lib/samiksha/labels";

const PAGE = 8;

type CycleView = NonNullable<ReturnType<typeof useView>["cycle"]>;

const THRESHOLD_LABEL: Record<string, Copy> = {
  drop_flag_r3_max: { en: "R3 numeracy flag, at or below", hi: "R3 संख्या ज्ञान ध्वज, इससे कम या बराबर" },
  drop_flag_delta_max: { en: "Drop flag, points at or below", hi: "गिरावट ध्वज, अंक इससे कम या बराबर" },
  no_visit_days_min: { en: "Days without a CRCC visit", hi: "CRCC भ्रमण के बिना दिन" },
  single_teacher_oct_nov_att_max: { en: "Single-teacher Oct–Nov attendance flag", hi: "एकल-शिक्षक अक्टूबर-नवम्बर उपस्थिति ध्वज" },
  suspicious_perfect_score: { en: "Perfect-score flag", hi: "पूर्ण अंक ध्वज" },
  suspicious_rounds_min: { en: "Consecutive perfect rounds", hi: "लगातार पूर्ण चक्र" },
};

/** Slide 3 figures and what the seeded files must reproduce. */
const BASELINE: { en: string; hi: string; value: (s: Cycle["summary"]) => string | number; expect: string; accent: "flag" | "seal" | "none" }[] = [
  { en: "Files read", hi: "पढ़ी गई फाइलें", value: (s) => s.files_read, expect: "7", accent: "none" },
  { en: "Schools", hi: "विद्यालय", value: (s) => s.schools, expect: "110", accent: "none" },
  { en: "Years joined", hi: "जुड़े वर्ष", value: (s) => s.years_joined, expect: "3", accent: "none" },
  { en: "Assessment rows", hi: "आकलन पंक्तियाँ", value: (s) => s.assessment_rows, expect: "548", accent: "none" },
  { en: "Data problems", hi: "डेटा समस्याएँ", value: (s) => s.data_problems, expect: "9", accent: "flag" },
  { en: "Codes auto-fixed", hi: "स्वतः सुधारे कोड", value: (s) => s.auto_fixed, expect: "110", accent: "seal" },
  { en: "Flags", hi: "ध्वज (Flags)", value: (s) => s.flags, expect: "4", accent: "flag" },
  { en: "Compute", hi: "गणना समय", value: (s) => `${s.runtime_s.toFixed(3)} s`, expect: "< 0.10 s", accent: "seal" },
];

export function UploadTab() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { cycle, prepSeconds: prep, isSeed } = useView();
  const { loadSeed } = useActions();

  if (!cycle) {
    return (
      <Panel>
        <h1 className="font-display text-3xl">{en ? "Seven files, one review" : "सात फाइलें, एक समीक्षा"}</h1>
        <p className="mt-2 max-w-xl text-muted">
          {en
            ? "Seven messy exports become one block agenda. Load the Kesli block files to start."
            : "सात अव्यवस्थित निर्यात एक विकासखंड एजेंडा बनते हैं। शुरू करने के लिए केसली की सीडेड फाइलें लोड करें।"}
        </p>
        <Btn kind="primary" className="mt-4" onClick={loadSeed}>
          {en ? "Load block files" : "विकासखंड फाइलें लोड करें"}
        </Btn>
      </Panel>
    );
  }

  return (
    <div className="rise space-y-8">
      <div>
        <h1 className="font-display text-3xl">{en ? "Data Upload & Validation" : "डेटा अपलोड व जाँच"}</h1>
        <p className="mt-1 text-muted">
          {en
            ? "Join and validate exports. Brief generation stays locked until the validation report exists."
            : "निर्यात फाइलें जोड़ें और जाँचें। सत्यापन रिपोर्ट बनने तक एजेंडा बंद रहता है।"}
        </p>
      </div>
      <BaselinePanel summary={cycle.summary} en={en} />
      <RunLedger cycle={cycle} prep={prep} isSeed={isSeed} en={en} />
      <UploadControls en={en} />
      <UploadNotices lang={lang} />
      <StateAdapterPanel />
      <SourceFiles cycle={cycle} en={en} />
      <IssuesPanel cycle={cycle} lang={lang} />
      <CleaningStudioSection cycle={cycle} />
      <SchoolTrend cycle={cycle} en={en} />
      <ThresholdsPanel lang={lang} />
    </div>
  );
}

/** The cleaning studio is a diagnostic: it folds away in meeting mode. */
function CleaningStudioSection({ cycle }: { cycle: CycleView }) {
  return (
    <MeetingSection titleEn="Cleaning studio — what the code fixed and why" titleHi="सफ़ाई स्टूडियो — कोड ने क्या सुधारा और क्यों">
      <CleaningStudio cycle={cycle} />
    </MeetingSection>
  );
}

function BaselinePanel({ summary, en }: { summary: Cycle["summary"]; en: boolean }) {
  return (
    <Panel>
      <h2 className="font-display text-2xl">{en ? "Baseline Verification" : "आधार सत्यापन"}</h2>
      <p className="mt-1 text-sm text-muted">{en ? "Computed directly from the 7 raw CSV exports." : "सीधे 7 कच्ची फाइलों से गणना की गई।"}</p>
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {BASELINE.map((row) => (
          <div
            key={row.en}
            className={`rounded-xl border border-rule bg-paper/60 p-4 ${row.accent === "flag" ? "border-l-4 border-l-flag" : row.accent === "seal" ? "border-l-4 border-l-seal" : ""}`}
          >
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">{en ? row.en : row.hi}</p>
            <p className="tabular mt-2 font-display text-3xl font-bold text-ink">{row.value(summary)}</p>
            <p className="mt-1.5 inline-block rounded border border-rule bg-sheet px-2 py-0.5 text-xs text-muted">
              {en ? `Expected ${row.expect}` : `अपेक्षित ${row.expect}`}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RunLedger({ cycle, prep, isSeed, en }: { cycle: CycleView; prep: number; isSeed: boolean; en: boolean }) {
  const holds = isSeed && cycle.contractErrors.length === 0;
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "Run ledger" : "रन खाता"}</h2>
          <p className="mt-1 text-sm text-muted">
            {en
              ? `Prep ${prep.toFixed(2)} s from files to brief. Manual join for this block is measured in days. Compute stays under a tenth of a second.`
              : `फाइलों से ब्रीफ तक तैयारी ${prep.toFixed(2)} सेकंड। इस विकासखंड की हाथ से जोड़ने में दिन लगते हैं। गणना एक सेकंड के दसवें हिस्से से कम रहती है।`}
          </p>
        </div>
        {holds ? (
          <Chip tone="ok">{en ? "Baseline checks hold" : "आधार जाँच सही"}</Chip>
        ) : (
          <Chip tone="flag">{en ? "Custom upload · contract not claimed" : "कस्टम अपलोड · अनुबंध दावा नहीं"}</Chip>
        )}
      </div>
      {cycle.contractErrors.length > 0 && isSeed ? (
        <ul className="mt-3 text-sm text-flag">
          {cycle.contractErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-4 text-sm">
        {en ? "Peer rule" : "समकक्ष नियम"}: {peerRuleText(cycle.peer.rule, en ? "en" : "hi")}. {en ? "Pilot" : "पायलट"} {cycle.peer.pilotDelta.toFixed(1)} {en ? "pts against" : "अंक, तुलना"} {cycle.peer.matchedDeltas.map((d) => d.toFixed(1)).join(", ")}.
      </p>
      <p className="mt-1 text-sm text-muted">{en ? cycle.peer.conclusionEn : cycle.peer.conclusionHi}</p>
    </Panel>
  );
}

function UploadControls({ en }: { en: boolean }) {
  const { loadSeed, ingestMany, triggerPii, triggerUnknownHeader, triggerOversized } = useActions();
  const upload = useCan()("upload_block_files");
  const setRole = useCycle((s) => s.setRole);
  return (
    <>
      {upload.allowed ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-flag">
          {en ? upload.reasonEn : upload.reasonHi}
          <Btn kind="soft" onClick={() => setRole("BEO")}>
            {en ? "Switch to BEO view to upload" : "अपलोड हेतु BEO दृश्य पर जाएँ"}
          </Btn>
        </p>
      )}
      <div className="flex flex-wrap gap-3.5">
        <Btn kind="primary" onClick={loadSeed} disabled={!upload.allowed}>
          {en ? "Reload Block Files (R1–R3)" : "विकासखंड फाइलें फिर लोड करें"}
        </Btn>
        <label className={`inline-flex min-h-11 items-center rounded-lg border border-rule bg-sheet px-4 py-2.5 text-sm font-semibold shadow-xs ${upload.allowed ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}>
          {en ? "Upload CSV / XLSX" : "CSV / XLSX अपलोड करें"}
          <input
            type="file"
            accept=".csv,.txt,.xlsx,text/csv"
            multiple
            disabled={!upload.allowed}
            className="sr-only"
            onChange={async (e) => {
              const list = [...(e.target.files ?? [])];
              const items = await Promise.all(list.map(readUpload));
              e.target.value = "";
              await ingestMany(items);
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-rule-strong bg-paper/70 p-4">
        <p className="text-sm font-semibold text-ink">{en ? "Interactive Guardrail Verification Tests" : "इंटरैक्टिव गार्डरेल जाँच"}</p>
        <div className="flex flex-wrap gap-3">
          <Btn kind="ghost" onClick={triggerPii}>
            {en ? "Test Student PII Blocker" : "विद्यार्थी फाइल रोकें (PII जाँच)"}
          </Btn>
          <Btn kind="ghost" onClick={triggerUnknownHeader}>
            {en ? "Test Unknown Column Mapper" : "अनजाना कॉलम जाँचें"}
          </Btn>
          <Btn kind="ghost" onClick={() => void triggerOversized()}>
            {en ? "Test oversized file (8.4 MB) and /why" : "बड़ी फाइल (8.4 MB) व /why जाँचें"}
          </Btn>
        </div>
      </div>
      <FailureWhy surfaces={["upload_file"]} />
    </>
  );
}

/** The privacy refusal, the column-map prompt and the last few ingest notes. */
function UploadNotices({ lang }: { lang: Lang }) {
  const en = lang === "en";
  const { confirmHeaders } = useActions();
  const notes = useCycle((s) => s.notes);
  const piiHit = useCycle((s) => s.piiHit);
  const headerPrompt = useCycle((s) => s.headerPrompt);
  const dismissHeaders = useCycle((s) => s.dismissHeaders);
  return (
    <>
      {piiHit ? (
        <Panel className="border-flag bg-flag-soft">
          <h2 className="font-medium text-flag">{en ? "Privacy guard" : "गोपनीयता गार्ड"}</h2>
          <p className="mt-1 text-sm">
            {en
              ? `“${piiHit}” was refused. Student names, Aadhaar, APAAR and PEN never enter the block file.`
              : `“${piiHit}” रोका गया। विद्यार्थी नाम, आधार, APAAR और PEN ब्लॉक फाइल में नहीं जाते।`}
          </p>
        </Panel>
      ) : null}
      {headerPrompt ? (
        <Panel>
          <h2 className="font-display text-xl">{en ? "Confirm Column Mapping" : "कॉलम मैप की पुष्टि"}</h2>
          <p className="mt-1 text-sm text-muted">
            {headerPrompt.fileName} · {en ? "confirm before any join." : "जोड़ने से पहले पुष्टि करें।"}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {headerPrompt.suggestions.map((sug) => (
              <li key={sug.from} className="flex flex-wrap gap-2">
                <span className="font-medium">{sug.from}</span>
                <span className="text-muted">→ {sug.to}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Btn kind="primary" onClick={confirmHeaders}>
              {en ? "Confirm Mapping" : "पुष्टि करें"}
            </Btn>
            <Btn kind="ghost" onClick={dismissHeaders}>
              {en ? "Cancel" : "छोड़ें"}
            </Btn>
          </div>
        </Panel>
      ) : null}
      {notes.length ? (
        <ul className="space-y-1 text-sm text-muted">
          {notes.slice(-4).map((n) => (
            <li key={n.en}>{tx(n, lang)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SourceFiles({ cycle, en }: { cycle: CycleView; en: boolean }) {
  const download = (name: string, csv: string) => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "7 Source Exports (UDISE+ includes Vacancy List)" : "सात स्रोत निर्यात (UDISE+ में रिक्ति सूची शामिल)"}</h2>
      <p className="mt-1 text-sm text-muted">
        {en ? "Round-file headers map themselves" : "राउंड फाइल के शीर्षक स्वयं मैप होते हैं"}: {cycle.headerMaps.map((m) => `${m.from} → ${m.to}`).join(" · ") || (en ? "none" : "कोई नहीं")}.
      </p>
      <ul className="mt-4 divide-y divide-rule">
        {cycle.files.map((f) => (
          <li key={f.name} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <span>
              <span className="block text-sm font-medium">{f.name}</span>
              <span className="tabular text-xs text-muted">{f.dataRows} {en ? "data rows" : "डेटा पंक्तियाँ"}</span>
            </span>
            <Btn kind="ghost" onClick={() => download(f.name, f.csv)}>
              {en ? "Download CSV" : "डाउनलोड"}
            </Btn>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function IssuesPanel({ cycle, lang }: { cycle: CycleView; lang: Lang }) {
  const en = lang === "en";
  const [filter, setFilter] = useState<"problems" | "fixes">("problems");
  const [page, setPage] = useState(0);
  const issues = filter === "problems" ? cycle.problems : cycle.fixes;
  const show = (next: "problems" | "fixes") => {
    setFilter(next);
    setPage(0);
  };
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl">
          {filter === "problems" ? (en ? "Data Problems" : "डेटा समस्याएँ") : (en ? "Auto-Fixed Codes" : "स्वतः सुधार")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Btn kind={filter === "problems" ? "primary" : "ghost"} onClick={() => show("problems")}>
            {en ? `Problems (${cycle.problems.length})` : `समस्याएँ (${cycle.problems.length})`}
          </Btn>
          <Btn kind={filter === "fixes" ? "primary" : "ghost"} onClick={() => show("fixes")}>
            {en ? `Auto-Fixes (${cycle.fixes.length})` : `सुधार (${cycle.fixes.length})`}
          </Btn>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <TableHead cols={en ? ["Type", "School Code", "File", "Row", "Description"] : ["प्रकार", "विद्यालय कोड", "फाइल", "पंक्ति", "विवरण"]} />
          <tbody>
            {issues.slice(page * PAGE, page * PAGE + PAGE).map((issue, i) => (
              <tr key={`${issue.sourceRow}-${issue.issueType}-${i}`} className="border-t border-rule hover:bg-paper/50">
                <td className="px-4 py-3.5">{label(ISSUE_TYPE_LABEL, issue.issueType, lang)}</td>
                <td className="tabular px-4 py-3.5">{issue.schoolCode}</td>
                <td className="px-4 py-3.5">{issue.sourceFile}</td>
                <td className="tabular px-4 py-3.5">{issue.sourceRow}</td>
                <td className="px-4 py-3.5">{en ? issue.descriptionEn : issue.descriptionHi}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.ceil(issues.length / PAGE)} onPage={setPage} />
    </Panel>
  );
}

function SchoolTrend({ cycle, en }: { cycle: CycleView; en: boolean }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const role = useCycle((s) => s.role);
  const rows = useMemo(() => {
    const inScope = filterByRoleScope(role, cycle, []).schools;
    const needle = q.trim().toLowerCase();
    if (!needle) return inScope;
    return inScope.filter((s) => `${s.nameEn} ${s.nameHi} ${s.code} ${s.cluster}`.toLowerCase().includes(needle));
  }, [cycle, q, role]);
  return (
    <Panel>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "3-Year School Trend (2023-24 to 2025-26 R3)" : "तीन वर्ष का विद्यालय रुझान (2023-24 से 2025-26 R3)"}</h2>
          <p className="mt-1 text-sm text-muted">
            {en ? "School-level only. Thresholds live in the open config below." : "केवल विद्यालय स्तर। सीमाएँ नीचे खुले कॉन्फ़िग में हैं।"}
          </p>
        </div>
        <input
          className={`${fieldClass} max-w-xs`}
          placeholder={en ? "Search school, code, or cluster..." : "स्कूल, कोड या क्लस्टर खोजें..."}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          aria-label={en ? "Search schools" : "स्कूल खोजें"}
        />
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <TableHead
            cols={
              en
                ? ["School", "Cluster", "2023-24", "2024-25", "R1", "R2", "R3", "G3 students", "Teachers"]
                : ["विद्यालय", "क्लस्टर", "2023-24", "2024-25", "R1", "R2", "R3", "कक्षा 3 विद्यार्थी", "शिक्षक"]
            }
          />
          <tbody>
            {rows.slice(page * PAGE, page * PAGE + PAGE).map((school) => {
              const small = isSmallSample(school.nStudents);
              return (
                <tr key={school.code} className="border-t border-rule hover:bg-paper/50">
                  <td className="px-4 py-3.5 font-medium">{en ? school.nameEn : school.nameHi}</td>
                  <td className="px-4 py-3.5">{school.cluster}</td>
                  {[school.y1, school.y2, school.r1, school.r2, school.r3].map((v, i) => (
                    <td key={i} className="tabular px-4 py-3.5">{pct(v)}</td>
                  ))}
                  <td className="px-4 py-3.5">
                    <span className="tabular">{`N = ${school.nStudents} ${en ? "students" : "विद्यार्थी"}`}</span>
                    {small ? (
                      <span className="mt-1 block">
                        <Chip tone="flag">{en ? "Small-N (<5) · Noise Guard" : "छोटा-N (<5) · शोर गार्ड"}</Chip>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3.5">
                    {school.workingTeachers}
                    {school.mathsPost === "Vacant" ? (en ? " · Maths Vacant" : " · गणित पद रिक्त") : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        {en
          ? `A percentage on three children moves ten points when one is absent, so a school with fewer than ${MIN_STUDENTS_FOR_FLAG} students in Grade 3 is shown with a noise guard. The gap is still listed; it is marked low-confidence and ranked lower.`
          : `तीन विद्यार्थियों के प्रतिशत में एक के अनुपस्थित होने से दस अंक बदल जाते हैं, इसलिए कक्षा 3 में ${MIN_STUDENTS_FOR_FLAG} से कम विद्यार्थियों वाले विद्यालय में शोर गार्ड दिखता है। अंतर फिर भी सूची में रहता है; वह कम-विश्वसनीयता के रूप में चिह्नित होकर नीचे क्रम में आता है।`}
      </p>
      <Pager page={page} pages={Math.ceil(rows.length / PAGE)} onPage={setPage} />
    </Panel>
  );
}

function ThresholdsPanel({ lang }: { lang: Lang }) {
  const role = useCycle((s) => s.role);
  // The values this cycle was built with (CONFIG plus any SPD change); older cycles fall back to CONFIG.
  const { cycle } = useView();
  return (
    <Panel>
      <h2 className="font-display text-xl">{lang === "en" ? "Visible Configuration Thresholds (CONFIG)" : "खुली सीमाएँ (CONFIG Thresholds)"}</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {Object.entries(cycle?.thresholds ?? CONFIG.thresholds).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 border-b border-rule py-2 text-sm">
            <dt>
              <span className="block text-muted">{THRESHOLD_LABEL[k]?.[lang] ?? k}</span>
              {lang === "en" ? <span className="text-xs text-faint">{k}</span> : null}
            </dt>
            <dd className="tabular font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {role === "SPD" ? <ThresholdEditor /> : null}
    </Panel>
  );
}

function pct(n: number | null) {
  if (n === null || Number.isNaN(n)) return "—";
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
}
