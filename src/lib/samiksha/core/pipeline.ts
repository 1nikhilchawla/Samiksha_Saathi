import { ACTION_LIBRARY, CONFIG, REVIEW_DATE, effectiveThresholds, type Thresholds } from "./config";
import { checkContract } from "./contract";
import { detectGaps, gapTier, watchlistGaps } from "./gaps";
import { buildPeople } from "./people";
import { cleanSchoolCode, fileKind, numOrNull, readTable, utcDays, type Table } from "./ingest";
import { scanPromptInjection } from "./guards";
import { matchControlSchools } from "./scorecard";
import { isSmallSample } from "./smallSample";
import type { StateCode } from "./stateFormats";
import type { Cycle, Gap, Issue, JoinedSchool, PeerBlock, Person, RawFile, SchoolRow } from "./model";

type Schools = Map<string, JoinedSchool>;

type ProblemIn = Pick<Issue, "severity" | "issueType" | "schoolCode" | "rawValue" | "sourceFile" | "sourceRow"> & {
  en: string;
  hi: string;
  fixedValue?: string;
};

function problem(p: ProblemIn): Issue {
  return {
    category: "data_problem",
    severity: p.severity,
    issueType: p.issueType,
    schoolCode: p.schoolCode,
    rawValue: p.rawValue,
    fixedValue: p.fixedValue ?? "",
    sourceFile: p.sourceFile,
    sourceRow: p.sourceRow,
    descriptionEn: p.en,
    descriptionHi: p.hi,
  };
}

/** Tables by export kind. Files of one kind (one per round, say) read as one table; each row keeps its file. */
function readFiles(files: RawFile[]) {
  const names = files.map((f) => f.name);
  const byKind = new Map<string, Table>();
  const rowCounts = new Map<string, number>();
  const fileRows = new Map<string, number>();
  const headerMaps: Cycle["headerMaps"] = [];
  const scaleFixes: Issue[] = [];
  const injections: Issue[] = [];
  const stateCodes = new Map<StateCode, number>();
  for (const f of files) {
    const kind = fileKind(f.name, names);
    const table = readTable(f.csv, f.name);
    stateCodes.set(table.stateCode, (stateCodes.get(table.stateCode) ?? 0) + 1);
    // A cell is data, never an instruction: any injected instruction is cut out before the text reaches a brief or a prompt.
    for (const r of table.data) {
      for (const [col, value] of Object.entries(r.cells)) {
        const scan = scanPromptInjection(value);
        if (scan.safe) continue;
        r.cells[col] = scan.sanitized;
        injections.push({
          category: "data_problem", severity: "warning", issueType: "prompt_injection_stripped", schoolCode: cleanSchoolCode(r.cells.school_code ?? "").code,
          rawValue: value.slice(0, 120), fixedValue: scan.sanitized.slice(0, 120), sourceFile: f.name, sourceRow: r.row,
          descriptionEn: `Instruction-like text removed from ${col} (${scan.detections.join(", ")}); a cell is read as data only.`,
          descriptionHi: `${col} से निर्देश जैसा पाठ हटाया गया (${scan.detections.join(", ")}); कोशिका केवल डेटा के रूप में पढ़ी जाती है।`,
        });
      }
    }
    for (const c of table.conversions) {
      const code = cleanSchoolCode(c.schoolCode).code;
      scaleFixes.push({
        category: "auto_fixed", severity: "info", issueType: "state_scale_normalized", schoolCode: code,
        rawValue: c.from, fixedValue: c.to, sourceFile: f.name, sourceRow: c.row,
        descriptionEn: `State score ${c.from} converted to ${c.to}${c.rule === "level_to_percent" ? " (assumed band midpoint)" : ""}.`,
        descriptionHi: `राज्य अंक ${c.from} को ${c.to} में बदला${c.rule === "level_to_percent" ? " (अनुमानित मध्य मान)" : ""}।`,
      });
    }
    const round = f.name.match(/[_\s-]r([1-4])(?![a-z0-9])/i)?.[1];
    if (round) for (const r of table.data) r.cells.round ||= `R${round}`;
    const prev = byKind.get(kind);
    byKind.set(kind, prev ? { ...prev, data: [...prev.data, ...table.data] } : table);
    rowCounts.set(kind, (rowCounts.get(kind) ?? 0) + table.data.length);
    fileRows.set(f.name, table.data.length);
    for (const m of table.maps) headerMaps.push({ file: f.name, ...m });
  }
  return { names, byKind, rowCounts, fileRows, headerMaps, scaleFixes, injections, stateCodes };
}

function newSchool(code: string, cells: Record<string, string>): JoinedSchool {
  return {
    code,
    nameEn: cells.school_name_en || code,
    nameHi: cells.school_name_hi || code,
    cluster: cells.cluster || "",
    workingTeachers: Number(cells.working_teachers || 0),
    nStudents: numOrNull(cells.g3_students ?? "") ?? 0,
    // A blank cell in the vacancy column means the post is filled; a file without the column says nothing either way.
    mathsPost: cells.maths_teacher_post === undefined ? "Unknown" : cells.maths_teacher_post || "Filled",
    vacantSince: cells.vacant_since || "",
    y1: null,
    y2: null,
    r1: null,
    r2: null,
    r3: null,
    r4: null,
    julAug: null,
    octNov: null,
    decAtt: null,
    daysSinceVisit: null,
    lastVisit: "",
    lastNote: "",
    kind: "plain",
  };
}

/** UDISE+ is the spine: one row per school code, first row wins. */
function joinUdise(udise: Table, problems: Issue[], fixes: Issue[]): Schools {
  const schools: Schools = new Map();
  for (const rec of udise.data) {
    const raw = rec.cells.school_code ?? "";
    const cleaned = cleanSchoolCode(raw);
    if (cleaned.changed && /^\d{11}$/.test(cleaned.code)) {
      fixes.push({
        category: "auto_fixed",
        severity: "info",
        issueType: "format_autofix",
        schoolCode: cleaned.code,
        rawValue: raw.trim(),
        fixedValue: cleaned.code,
        sourceFile: rec.file || "udise_2025-26.csv",
        sourceRow: rec.row,
        descriptionEn: `School code normalised from “${raw.trim()}” to ${cleaned.code}.`,
        descriptionHi: `विद्यालय कोड “${raw.trim()}” से ${cleaned.code} किया गया।`,
      });
    }
    if (schools.has(cleaned.code)) {
      problems.push(problem({
        severity: "warning", issueType: "duplicate", schoolCode: cleaned.code, rawValue: raw.trim(), fixedValue: cleaned.code,
        sourceFile: rec.file || "udise_2025-26.csv", sourceRow: rec.row,
        en: "Duplicate UDISE row. First row kept.", hi: "UDISE में दोहरी पंक्ति। पहली पंक्ति रखी गई।",
      }));
      continue;
    }
    schools.set(cleaned.code, newSchool(cleaned.code, rec.cells));
  }
  return schools;
}

function joinAssessment(table: Table | undefined, fallbackFile: string, yearLabel: string, field: "y1" | "y2", schools: Schools, problems: Issue[]) {
  if (!table) return;
  const seen = new Set<string>();
  for (const rec of table.data) {
    const file = rec.file || fallbackFile;
    const code = cleanSchoolCode(rec.cells.school_code ?? "").code;
    const score = numOrNull(rec.cells.g3_math_pct ?? "");
    const school = schools.get(code);
    const at = { schoolCode: code, sourceFile: file, sourceRow: rec.row };
    if (!school) {
      problems.push(problem({
        ...at, severity: "error", issueType: "unknown_code", rawValue: rec.cells.school_code ?? "",
        en: `Unknown school code ${code} in ${file}. Row dropped.`, hi: `${file} में अज्ञात कोड ${code}। पंक्ति हटाई गई।`,
      }));
      continue;
    }
    if (seen.has(code + yearLabel)) {
      problems.push(problem({
        ...at, severity: "warning", issueType: "duplicate", rawValue: String(score ?? ""),
        en: "Duplicate assessment row. First score kept.", hi: "आकलन की दोहरी पंक्ति। पहला अंक रखा गया।",
      }));
      continue;
    }
    seen.add(code + yearLabel);
    if (score === null) {
      problems.push(problem({
        ...at, severity: "warning", issueType: "missing_value", rawValue: "",
        en: `Missing Grade 3 numeracy for ${school.nameEn}.`, hi: `${school.nameHi} का कक्षा 3 अंक खाली है।`,
      }));
      continue;
    }
    if (score > 100 || score < 0) {
      problems.push(problem({
        ...at, severity: "error", issueType: "impossible_value", rawValue: String(score),
        en: `Impossible score ${score}% at ${school.nameEn}. Excluded from the mean.`, hi: `${school.nameHi} में असंभव अंक ${score}%। औसत से बाहर।`,
      }));
      continue;
    }
    school[field] = score;
  }
}

/** R1–R3 scores per school; returns every score seen per school for the perfect-score check. */
function joinRounds(rounds: Table | undefined, schools: Schools, problems: Issue[]): Map<string, number[]> {
  const hits = new Map<string, number[]>();
  if (!rounds) return hits;
  const seen = new Set<string>();
  for (const rec of rounds.data) {
    const code = cleanSchoolCode(rec.cells.school_code ?? "").code;
    const round = (rec.cells.round || "").trim();
    const score = numOrNull(rec.cells.g3_math_pct ?? "");
    const school = schools.get(code);
    if (!school) continue;
    const key = `${code}|${round}`;
    if (seen.has(key)) {
      problems.push(problem({
        severity: "warning", issueType: "duplicate", schoolCode: code, rawValue: `${round}=${score}`,
        sourceFile: rec.file || "assess_2025-26_rounds.csv", sourceRow: rec.row,
        en: `Duplicate ${round} row for ${school.nameEn}.`, hi: `${school.nameHi} की ${round} पंक्ति दोहरी है।`,
      }));
      continue;
    }
    seen.add(key);
    if (score === null) continue;
    if (round === "R1") school.r1 = score;
    if (round === "R2") school.r2 = score;
    if (round === "R3") school.r3 = score;
    hits.set(code, [...(hits.get(code) ?? []), score]);
    school.roundRows = { ...school.roundRows, [round]: rec.row };
    school.roundSrc = { ...school.roundSrc, [round]: rec.file };
  }
  return hits;
}

function flagPerfectScores(schools: Schools, hits: Map<string, number[]>, problems: Issue[]) {
  const { suspicious_rounds_min: minRounds, suspicious_perfect_score: perfect } = CONFIG.thresholds;
  for (const school of schools.values()) {
    const bag = hits.get(school.code) ?? [];
    if (bag.length < minRounds || !bag.every((x) => x === perfect)) continue;
    school.kind = "harangaon";
    problems.push(problem({
      severity: "warning", issueType: "suspicious_100", schoolCode: school.code, rawValue: "100, 100, 100",
      sourceFile: school.roundSrc?.R1 || "assess_2025-26_rounds.csv", sourceRow: school.roundRows?.R1 ?? 0,
      en: `${school.nameEn} scored 100% in all ${bag.length} rounds. Flagged for a spot check.`,
      hi: `${school.nameHi} ने सभी ${bag.length} चक्रों में 100% पाया। औचक जांच चिह्नित।`,
    }));
  }
}

function joinAttendance(att: Table | undefined, schools: Schools) {
  const months = new Map<string, Record<string, number>>();
  for (const rec of att?.data ?? []) {
    const code = cleanSchoolCode(rec.cells.school_code ?? "").code;
    const score = numOrNull(rec.cells.attendance_pct ?? "");
    const school = schools.get(code);
    if (!school || score === null) continue;
    const month = monthKey(rec.cells.month || "");
    months.set(code, { ...months.get(code), [month]: score });
    school.attRefs = { ...school.attRefs, [month]: { row: rec.row, file: rec.file, pct: score } };
  }
  for (const school of schools.values()) {
    const bag = months.get(school.code) ?? {};
    if (bag.Jul !== undefined && bag.Aug !== undefined) school.julAug = (bag.Jul + bag.Aug) / 2;
    if (bag.Oct !== undefined && bag.Nov !== undefined) school.octNov = (bag.Oct + bag.Nov) / 2;
  }
}

/** Full English and Hindi month names, read as the three-letter keys the attendance join uses. */
const MONTH_KEYS: Record<string, string> = {
  jul: "Jul", july: "Jul", जुलाई: "Jul",
  aug: "Aug", august: "Aug", अगस्त: "Aug",
  oct: "Oct", october: "Oct", अक्टूबर: "Oct", अक्तूबर: "Oct",
  nov: "Nov", november: "Nov", नवम्बर: "Nov", नवंबर: "Nov",
  dec: "Dec", december: "Dec", दिसम्बर: "Dec", दिसंबर: "Dec",
};
const monthKey = (raw: string) => {
  const m = raw.trim();
  return MONTH_KEYS[m.toLowerCase()] ?? m;
};

/** The latest visit per school, whatever order the rows come in; `reviewDate` is the day the gap is measured from. */
function joinVisits(visits: Table | undefined, schools: Schools, reviewDate: string) {
  for (const rec of visits?.data ?? []) {
    const school = schools.get(cleanSchoolCode(rec.cells.school_code ?? "").code);
    if (!school) continue;
    const date = (rec.cells.visit_date || "").trim();
    // ISO dates sort as strings; an older row never replaces a newer one.
    if (school.lastVisit && date < school.lastVisit) continue;
    school.lastVisit = date;
    school.lastNote = rec.cells.note || "";
    school.daysSinceVisit = date ? utcDays(date, reviewDate) : null;
    school.visitRow = rec.row;
    school.visitSrc = rec.file;
  }
}

function classifySchools(schools: Schools, problems: Issue[], t: Thresholds = CONFIG.thresholds) {
  for (const school of schools.values()) {
    if (school.kind === "harangaon") continue;
    const { r2, r3 } = school;
    if (school.mathsPost === "Vacant" && r3 !== null && r2 !== null && r3 <= t.drop_flag_r3_max && r3 - r2 <= t.drop_flag_delta_max) school.kind = "khedi";
    else if (school.workingTeachers === 1) school.kind = "single";
    else if (school.cluster === "C6") school.kind = "c6";
    else if (school.y2 === null) school.kind = "bad_missing";
    else if (school.y1 !== null && school.y2 !== null && r3 === null && school.y2 > 100) school.kind = "bad_impossible";
  }
  // Impossible scores were never stored on the school, so read them back from the problems.
  for (const p of problems) {
    const s = schools.get(p.schoolCode);
    if (!s) continue;
    if (p.issueType === "impossible_value") s.kind = "bad_impossible";
    if (p.issueType === "missing_value" && s.kind === "plain") s.kind = "bad_missing";
  }
  // Controls: unflagged schools in the drop school's R3 band that did not drop.
  const target = [...schools.values()].find((s) => s.kind === "khedi");
  if (target) for (const s of matchControlSchools([...schools.values()], target, undefined, t.drop_flag_delta_max)) s.kind = "control";
}

const isPilotRow = (name: string) => {
  const n = name.trim().toLowerCase();
  return n === "pilot" || n === CONFIG.block_id.toLowerCase() || n === CONFIG.block_name_en.toLowerCase();
};

/** The excuse check: this block's year-on-year change against matched peer blocks. */
function peerCheck(schools: Schools, peerTable: Table | undefined) {
  const comparable = [...schools.values()].filter((s) => s.y1 !== null && s.y2 !== null && s.y2 >= 0 && s.y2 <= 100);
  const mean = (f: (s: SchoolRow) => number) => comparable.reduce((a, s) => a + f(s), 0) / comparable.length;
  const pilotDelta = comparable.length ? mean((s) => s.y2! - s.y1!) : 0;
  const rows = (peerTable?.data ?? []).map((rec) => ({
    name: rec.cells.block_name || "Peer",
    election: (rec.cells.election_duty_2024 || "").trim(),
    rural: numOrNull(rec.cells.rural_share_pct ?? "") ?? 0,
    delta: numOrNull(rec.cells.delta_pts ?? "") ?? 0,
  }));
  // A row named after this block (or "Pilot") gives the block's own election duty; otherwise CONFIG does.
  const pilotRow = rows.find((r) => isPilotRow(r.name));
  const election = pilotRow?.election || CONFIG.peer_rule.election_duty_2024;
  const minRural = CONFIG.peer_rule.rural_share_pct_min;
  const peers: PeerBlock[] = rows
    .filter((r) => r !== pilotRow)
    .map((r) => ({ ...r, matched: r.election === election && r.rural >= minRural }));
  const matchedPeers = peers.filter((p) => p.matched);
  const sufficient = matchedPeers.length >= CONFIG.peer_rule.min_peer_blocks;
  const drop = Math.abs(pilotDelta).toFixed(1);
  const peer = {
    pilotDelta,
    matchedDeltas: matchedPeers.map((p) => p.delta),
    sufficient,
    rule: `election_duty_2024 == ${election} AND rural_share_pct >= ${minRural}`,
    y1: mean((s) => s.y1!),
    y2: mean((s) => s.y2!),
    comparedSchools: comparable.length,
    conclusionEn: sufficient
      ? `Election duty alone does not explain the ${drop}-point drop.`
      : "Insufficient comparable blocks (<2) matching rule; peer comparison skipped.",
    conclusionHi: sufficient
      ? `केवल चुनाव ड्यूटी से ${drop} अंक की गिरावट नहीं समझी जा सकती।`
      : "नियम से मेल खाते तुलनात्मक विकासखंड 2 से कम हैं; तुलना छोड़ी गई।",
  };
  return { peers, matchedPeers, peer };
}

type Peer = ReturnType<typeof peerCheck>["peer"];

function summarise(x: { files: RawFile[]; names: string[]; rowCounts: Map<string, number>; schools: Schools; problems: Issue[]; fixes: Issue[]; flags: unknown[]; runtime: number }): Cycle["summary"] {
  const all = [...x.schools.values()];
  const years = new Set<string>();
  if (all.some((s) => s.y1 !== null)) years.add("2023-24");
  if (all.some((s) => s.y2 !== null)) years.add("2024-25");
  if (all.some((s) => s.r1 !== null || s.r2 !== null || s.r3 !== null)) years.add("2025-26");
  return {
    files_read: x.files.filter((f) => ["udise", "y1", "y2", "rounds", "attendance", "visits", "peer"].includes(fileKind(f.name, x.names))).length,
    schools: x.schools.size,
    years_joined: years.size,
    assessment_rows: (x.rowCounts.get("y1") ?? 0) + (x.rowCounts.get("y2") ?? 0) + (x.rowCounts.get("rounds") ?? 0),
    data_problems: x.problems.length,
    auto_fixed: x.fixes.length,
    flags: x.flags.length,
    runtime_s: x.runtime,
  };
}

function briefInputOf(summary: Cycle["summary"], peer: Peer, gaps: Gap[], reviewDate: string): Record<string, unknown> {
  return {
    // Only the context the brief quotes; thresholds and targets stay out, so a model cannot cite them as facts.
    context: {
      review_date: reviewDate,
      competency: CONFIG.context_stats.competency,
      arranges_numbers_up_to: CONFIG.context_stats.arranges_numbers_up_to,
      parakh_g3_c84_avg_pct: CONFIG.context_stats.parakh_g3_c84_avg_pct,
    },
    summary,
    peer,
    gaps: gaps.map((g) => ({
      id: g.id,
      code_rank: g.codeRank,
      fact_en: g.factEn,
      fact_hi: g.factHi,
      reason_en: g.reasonEn,
      reason_hi: g.reasonHi,
      justification_en: g.rankJustificationEn,
      justification_hi: g.rankJustificationHi,
      action_id: g.actionId,
      allowed_actions: g.allowedActions,
      target: g.targetLabel,
      source_refs: g.sourceRefs,
    })),
    action_ids: Object.keys(ACTION_LIBRARY),
  };
}

/** The verified code brief, in both languages. Every number in it comes from the inputs above. */
function writeBriefs(summary: Cycle["summary"], gaps: Gap[], peer: Peer, matchedPeers: PeerBlock[], reviewDate: string) {
  const s = summary;
  const ctx = CONFIG.context_stats;
  const deltas = matchedPeers.map((p) => p.delta.toFixed(1)).join(", ");
  const change = peer.pilotDelta.toFixed(1);
  const briefEn = [
    `${CONFIG.block_name_en}. Review date ${reviewDate}.`,
    `Code read ${s.files_read} files, ${s.schools} schools, ${s.years_joined} years, ${s.assessment_rows} assessment rows. ${s.data_problems} data problems. ${s.auto_fixed} codes auto-fixed. ${s.flags} flags.`,
    `Grade 3 on PARAKH ${ctx.competency} is the measure in this brief. National Grade 3 average on arranging numbers up to 99 was ${ctx.parakh_g3_c84_avg_pct}%.`,
    ...gaps.map((g) => `${g.codeRank}. ${g.targetLabel}. ${g.factEn} ${g.reasonEn} Action: ${ACTION_LIBRARY[g.actionId].name_en}.`),
    `Excuse check. Rule: ${peer.rule}. Pilot change ${change} pts (${peer.y1.toFixed(1)} to ${peer.y2.toFixed(1)}), against ${deltas}. ${peer.conclusionEn}`,
  ].join("\n");
  const briefHi = [
    `${CONFIG.block_name_hi}। समीक्षा तिथि ${reviewDate}।`,
    `कोड ने ${s.files_read} फाइलें, ${s.schools} स्कूल, ${s.years_joined} वर्ष, ${s.assessment_rows} आकलन पंक्तियाँ पढ़ीं। ${s.data_problems} डेटा समस्याएँ। ${s.auto_fixed} कोड अपने आप ठीक। ${s.flags} ध्वज।`,
    `इस एजेंडा का माप PARAKH ${ctx.competency} पर कक्षा 3 है। 99 तक संख्या सजाने पर कक्षा 3 का राष्ट्रीय औसत ${ctx.parakh_g3_c84_avg_pct}% था।`,
    ...gaps.map((g) => `${g.codeRank}. ${g.targetLabelHi}. ${g.factHi} ${g.reasonHi} कार्य: ${ACTION_LIBRARY[g.actionId].name_hi}.`),
    `बहाना जाँच। नियम: ${peer.rule}। पायलट परिवर्तन ${change} अंक (${peer.y1.toFixed(1)} से ${peer.y2.toFixed(1)}), तुलना में ${deltas}। ${peer.conclusionHi}`,
  ].join("\n");
  return { briefEn, briefHi };
}

/**
 * `opts.thresholds` is the block's SPD overrides (block_settings.thresholds);
 * without it the run uses CONFIG.thresholds, as the Slide 3 contract expects.
 * `opts.reviewDate` is the day the review is held (an upload's own date); the
 * seeded run uses REVIEW_DATE, so "days since the last visit" is counted from
 * the right day either way.
 */
export function runPipeline(files: RawFile[], opts: { thresholds?: Record<string, unknown> | null; reviewDate?: string } = {}): Omit<Cycle, "r4Files" | "contractErrors" | "briefEn" | "briefHi" | "briefInput" | "thresholds"> & {
  briefEn: string;
  briefHi: string;
  briefInput: Record<string, unknown>;
  contractErrors: string[];
  people: Person[];
  thresholds: Thresholds;
} {
  const t0 = performance.now();
  const t = effectiveThresholds(opts.thresholds);
  const reviewDate = opts.reviewDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.reviewDate) ? opts.reviewDate : REVIEW_DATE;
  const problems: Issue[] = [];
  const fixes: Issue[] = [];
  const { names, byKind, rowCounts, fileRows, headerMaps, scaleFixes, injections, stateCodes } = readFiles(files);
  problems.push(...injections);
  const udise = byKind.get("udise");
  if (!udise) throw new Error("UDISE file missing");

  const schools = joinUdise(udise, problems, fixes);
  fixes.push(...scaleFixes);
  joinAssessment(byKind.get("y1"), "assess_2023-24.csv", "2023-24", "y1", schools, problems);
  joinAssessment(byKind.get("y2"), "assess_2024-25.csv", "2024-25", "y2", schools, problems);
  flagPerfectScores(schools, joinRounds(byKind.get("rounds"), schools, problems), problems);
  joinAttendance(byKind.get("attendance"), schools);
  joinVisits(byKind.get("visits"), schools, reviewDate);
  classifySchools(schools, problems, t);
  for (const s of schools.values()) s.smallSampleNoise = isSmallSample(s.nStudents, t.min_g3_students_for_flag);

  const { peers, matchedPeers, peer } = peerCheck(schools, byKind.get("peer"));
  const detected = detectGaps(schools, udise, t);
  const { flags, metrics } = detected;
  const gaps = detected.gaps.map((g) => ({ ...g, tier: gapTier(g.codeRank) }));
  // Ranks 6-15 for Top 10 / Top 15. They stay out of the brief text and the contract.
  const allRankedGaps = [...gaps, ...watchlistGaps(schools, gaps, t)];
  const summary = summarise({ files, names, rowCounts, schools, problems, fixes, flags, runtime: (performance.now() - t0) / 1000 });
  // The state profile the files were detected as, so the screen can show the
  // right officer titles over the right numbers.
  const detectedStateCode: StateCode = [...stateCodes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "MP";
  const briefInput = briefInputOf(summary, peer, gaps, reviewDate);
  const { briefEn, briefHi } = writeBriefs(summary, gaps, peer, matchedPeers, reviewDate);
  const contractErrors = checkContract({
    summary,
    pilotDelta: peer.pilotDelta,
    matched: peer.matchedDeltas,
    ...metrics,
    gaps,
    flags,
    briefEn,
    briefHi,
    briefInput,
    peerConclusion: peer.conclusionEn,
  });

  return {
    files: files.map((f) => ({ name: f.name, csv: f.csv, dataRows: fileRows.get(f.name) ?? 0 })),
    problems,    fixes,
    headerMaps,
    schools: [...schools.values()].sort((a, b) => a.cluster.localeCompare(b.cluster) || a.nameEn.localeCompare(b.nameEn)),
    flags,
    gaps,
    allRankedGaps,
    peers,
    peer,
    detectedStateCode,
    summary,
    briefInput,
    briefEn,
    briefHi,
    people: buildPeople([...schools.values()]),
    contractErrors,
    thresholds: t,
  };
}
