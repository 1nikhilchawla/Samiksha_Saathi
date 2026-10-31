import { useState } from "react";
import { Btn, Chip, Panel, TableHead } from "@/components/samiksha/ui";
import { STATE_CODES, STATE_VSK_PROFILES, cleanSchoolCode, detectStateProfile, parseCsv, readTable } from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";

/** Pick a state profile, see its officer titles, and convert its sample export into Samiksha's columns. */
export function StateAdapterPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const code = useCycle((s) => s.stateCode);
  const setCode = useCycle((s) => s.setStateCode);
  const [shown, setShown] = useState<string | null>(null);
  const profile = STATE_VSK_PROFILES[code];

  const demo = (() => {
    if (shown !== code) return null;
    const grid = parseCsv(profile.sample.csv);
    const header = grid[0] ?? [];
    const table = readTable(profile.sample.csv, profile.sample.fileName);
    const rawScore = header.findIndex((h) => /math|numeracy|गणित|competency/i.test(h));
    const rawCode = header.findIndex((h) => /code|udise|dise|कोड/i.test(h));
    return {
      detected: detectStateProfile(header, profile.sample.fileName),
      maps: table.maps,
      rows: table.data.map((r, i) => ({
        rawCode: grid[i + 1]?.[rawCode] ?? "",
        code: cleanSchoolCode(r.cells.school_code ?? "").code,
        round: r.cells.round ?? "",
        rawScore: grid[i + 1]?.[rawScore] ?? "",
        pct: r.cells.g3_math_pct ?? "",
      })),
      conversions: table.conversions.length,
    };
  })();

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "State export format adapter" : "राज्य VSK प्रारूप"}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {en
              ? "States name columns, grade scores and title officers differently. Pick a state to convert its export into the same columns this review reads."
              : "राज्य कॉलम, अंक पैमाने और अधिकारी पद अलग नाम से रखते हैं। राज्य चुनें, उसका निर्यात इसी समीक्षा के कॉलम में बदलेगा।"}
          </p>
        </div>
        <Chip tone="flag">{en ? "Sample profiles · confirm with a real export" : "नमूना प्रोफ़ाइल · असली निर्यात से पुष्टि करें"}</Chip>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label={en ? "State profile" : "राज्य प्रोफ़ाइल"}>
        {STATE_CODES.map((c) => {
          const p = STATE_VSK_PROFILES[c];
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === code}
              onClick={() => setCode(c)}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${c === code ? "border-seal bg-seal text-seal-fg" : "border-rule bg-sheet"}`}
            >
              {`${c} · ${p.systemEn}${c === "MP" ? (en ? " (default)" : " (मूल)") : ""}`}
            </button>
          );
        })}
      </div>
      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted">{en ? "Score scale" : "अंक पैमाना"}</dt><dd className="font-medium">{en ? profile.scaleEn : profile.scaleHi}</dd></div>
        {(["HM", "CRCC", "BEO", "DEO", "SPD"] as const).map((r) => (
          <div key={r}><dt className="text-muted">{r}</dt><dd className="font-medium">{profile.roles[r][lang]}</dd></div>
        ))}
      </dl>
      <Btn kind="soft" className="mt-4" onClick={() => setShown(code)}>
        {en ? "Test multi-state format conversion" : "राज्य प्रारूप रूपांतरण जाँचें"}
      </Btn>
      {demo ? (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            {en ? "Detected profile" : "पहचाना गया"}: <span className="font-semibold">{STATE_VSK_PROFILES[demo.detected][en ? "nameEn" : "nameHi"]}</span>
            {" · "}
            {demo.maps.map((m) => `${m.from} → ${m.to}`).join(" · ")}
          </p>
          <div className="overflow-x-auto rounded-lg border border-rule">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <TableHead cols={en ? ["Raw code", "school_code", "Round", "Raw score", "g3_math_pct"] : ["मूल कोड", "school_code", "चक्र", "मूल अंक", "g3_math_pct"]} />
              <tbody>
                {demo.rows.map((r) => (
                  <tr key={r.rawCode} className="border-t border-rule">
                    <td className="tabular px-4 py-3">{r.rawCode}</td>
                    <td className="tabular px-4 py-3">{r.code}</td>
                    <td className="px-4 py-3">{r.round}</td>
                    <td className="tabular px-4 py-3">{r.rawScore}</td>
                    <td className="tabular px-4 py-3 font-semibold">{r.pct ? `${r.pct}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted">
            {demo.conversions
              ? (en ? `${demo.conversions} scores converted to percent and logged as auto-fixes when a real file is uploaded.` : `${demo.conversions} अंक प्रतिशत में बदले; असली फाइल अपलोड पर स्वतः सुधार में दर्ज होंगे।`)
              : (en ? "Scores were already percentages; only column names changed." : "अंक पहले से प्रतिशत थे; केवल कॉलम नाम बदले।")}
            {code === "HR" ? (en ? " Level-to-percent values are assumed band midpoints." : " स्तर से प्रतिशत मान अनुमानित मध्य मान हैं।") : ""}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
