import { devToAscii } from "./config";
import { STATE_ALIASES, STATE_VSK_PROFILES, convertStateScales, detectStateProfile, stateHeaderKey, type ScaleNote, type StateCode } from "./stateFormats";
import { MAX_ROWS_PER_FILE } from "./uploadLimits";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const pushRow = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") pushRow();
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) pushRow();
  return rows;
}

const ALIASES: Record<string, string> = {
  school_code: "school_code",
  udise_code: "school_code",
  udise: "school_code",
  "विद्यालय कोड": "school_code",
  "स्कूल कोड": "school_code",
  school_name_en: "school_name_en",
  school_name_hi: "school_name_hi",
  "school name": "school_name_en",
  school_name: "school_name_en",
  "udise code": "school_code",
  "विद्यालय का नाम": "school_name_hi",
  cluster: "cluster",
  "cluster name": "cluster",
  cluster_name: "cluster",
  क्लस्टर: "cluster",
  working_teachers: "working_teachers",
  "कार्यरत शिक्षक": "working_teachers",
  g3_students: "g3_students",
  students_g3: "g3_students",
  "g3 students": "g3_students",
  "class 3 students": "g3_students",
  "कक्षा 3 विद्यार्थी": "g3_students",
  "कक्षा 3 छात्र": "g3_students",
  maths_teacher_post: "maths_teacher_post",
  "गणित शिक्षक पद": "maths_teacher_post",
  vacant_since: "vacant_since",
  "रिक्त कब से": "vacant_since",
  academic_year: "academic_year",
  "शैक्षणिक वर्ष": "academic_year",
  g3_math_pct: "g3_math_pct",
  "कक्षा 3 गणित (%)": "g3_math_pct",
  "कक्षा 3 गणित": "g3_math_pct",
  round: "round",
  चक्र: "round",
  month: "month",
  माह: "month",
  attendance_pct: "attendance_pct",
  "उपस्थिति (%)": "attendance_pct",
  visit_date: "visit_date",
  note: "note",
  टिप्पणी: "note",
  block_name: "block_name",
  election_duty_2024: "election_duty_2024",
  rural_share_pct: "rural_share_pct",
  delta_pts: "delta_pts",
};

/** The reader's own column names (no state aliases). */
export function coreHeader(raw: string): string | null {
  const t = raw.trim();
  return ALIASES[t] ?? ALIASES[t.toLowerCase()] ?? null;
}

export function mapHeader(raw: string): string | null {
  return coreHeader(raw) ?? STATE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * A count of children, not a child: the Grade 3 roll and its synonyms. These
 * are checked before any "student" pattern, so the denominator column is read
 * as g3_students and never refused as personal data.
 */
const AGGREGATE_COUNT = /\b(g3_students|students_g3|n_students|student_count|students_count|total_students|no_of_students|enrolled|enrolment|enrollment|assessed|strength)\b|छात्र[_\s-]?संख्या|विद्यार्थी[_\s-]?संख्या|कक्षा\s*3\s*(छात्र|विद्यार्थी)/i;
export const isAggregateCountHeader = (raw: string) => coreHeader(raw) === "g3_students" || AGGREGATE_COUNT.test(raw.trim());

export function suggestCanonical(raw: string): string {
  const h = raw.trim().toLowerCase();
  if (isAggregateCountHeader(raw)) return "g3_students";
  if (/aadhaar|आधार|apaar|pen_number|student|child_name|father|छात्र|samagra|समग्र/i.test(raw)) return "BLOCKED_PII";
  if (/code|udise|कोड/.test(raw) || /code|udise/.test(h)) return "school_code";
  if (/math|गणित|numeracy|score|g3/.test(raw) || /math|score|g3/.test(h)) return "g3_math_pct";
  if (/attend|उपस्थित/.test(raw) || /attend/.test(h)) return "attendance_pct";
  if (/round|चक्र/.test(raw) || h === "round") return "round";
  if (/cluster|क्लस्टर/.test(raw)) return "cluster";
  if (/visit/.test(h)) return "visit_date";
  if (/note|टिप्प/.test(raw) || h === "note") return "note";
  return "ignore";
}

// MP's Samagra ID is a family and member ID (the state keys student records on it), so a Samagra column is student data.
const PII_HEADER = /(student[_\s-]?name|child[_\s-]?name|father[_\s-]?name|mother[_\s-]?name|guardian[_\s-]?name|aadhaar|aadhar|apaar|\bpen(?:[_\s-]?(?:number|no|id))?\b|\bdob\b|date[_\s-]?of[_\s-]?birth|samagra|समग्र|छात्र|आधार|विद्यार्थी का नाम|पिता का नाम|माता का नाम|अभिभावक का नाम|mobile|phone|contact[_\s-]?(no|number|num)|whatsapp|मोबाइल|फ़ोन|फोन)/i;
// 12 digits, optionally spaced or hyphenated in fours: Aadhaar and APAAR share the shape.
const AADHAAR_LIKE = /(?:^|\D)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?:\D|$)/;
const STUDENT_COLUMN = /pen|student|child|छात्र|विद्यार्थी/i;

/**
 * Refuses student-level data: a personal-data header, a 12-digit Aadhaar/APAAR
 * value in any cell, or an 11-digit PEN in a PEN/student column. Pass every row;
 * a flat list of cells is read as one column.
 */
export function scanPii(headers: string[], rows: string[][] | string[]): { hit: boolean; match: string } {
  for (const h of headers) {
    // A Grade 3 count ("कक्षा 3 छात्र", "student_count") is aggregate data, not a child's.
    if (isAggregateCountHeader(h)) continue;
    if (PII_HEADER.test(h)) return { hit: true, match: h.trim() };
  }
  for (const row of rows.map((r) => (Array.isArray(r) ? r : [r]))) {
    for (const [i, raw] of row.entries()) {
      const cell = devToAscii(raw).trim();
      if (AADHAAR_LIKE.test(cell)) return { hit: true, match: "12-digit identifier resembling Aadhaar or APAAR" };
      const header = headers[i] ?? "";
      if (/^\d{11}$/.test(cell) && STUDENT_COLUMN.test(header) && !isAggregateCountHeader(header)) return { hit: true, match: `11-digit PEN in column “${header.trim()}”` };
    }
  }
  return { hit: false, match: "" };
}

export function cleanSchoolCode(raw: string): { code: string; changed: boolean } {
  const original = raw;
  let s = devToAscii(raw).trim();
  s = s.replace(/[\s-]/g, "");
  if (/[eE.]/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(Math.round(n));
  }
  if (/^\d+$/.test(s) && s.length > 0 && s.length < 11) s = s.padStart(11, "0");
  return { code: s, changed: original !== s };
}

export function utcDays(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function looksLikeHeader(cells: string[]): boolean {
  const mapped = cells.map(mapHeader).filter(Boolean);
  return mapped.length >= 2;
}

/** Index of the header row: the first of the top eight rows with two known columns, else 0. */
export function findHeaderRow(grid: string[][]): number {
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    if (looksLikeHeader(grid[i] ?? [])) return i;
  }
  return 0;
}

export type TableRow = { cells: Record<string, string>; row: number; file: string };
export type Table = {
  header: string[];
  data: TableRow[];
  maps: { from: string; to: string }[];
  /** State scales converted to percent (Punjab 0–10, Haryana levels), one per row. */
  conversions: (ScaleNote & { row: number; schoolCode: string })[];
  /** The state profile this file was detected as, from its own headers. */
  stateCode: StateCode;
};

/** Rows keyed by canonical column name; each row remembers its source file and 1-based line. */
export function readTable(text: string, file = ""): Table {
  const grid = parseCsv(text);
  // The header row plus at most MAX_ROWS_PER_FILE data rows; a bigger file is refused before it is mapped.
  if (grid.length > MAX_ROWS_PER_FILE + 1) {
    throw new Error(`${file || "This file"} has ${grid.length - 1} data rows; the limit is ${MAX_ROWS_PER_FILE.toLocaleString("en-IN")} a file.`);
  }
  let start = 0;
  while (start < grid.length && !looksLikeHeader(grid[start]!)) start++;
  const headerCells = grid[start] ?? [];
  const maps: { from: string; to: string }[] = [];
  const header = headerCells.map((h) => {
    const to = mapHeader(h);
    if (to && to !== h.trim()) maps.push({ from: h.trim(), to });
    return to ?? h.trim();
  });
  const conversions: Table["conversions"] = [];
  // The same mapping and scale conversion as normalizeStateRow, with each header mapped once per file.
  const detected = detectStateProfile(headerCells, file);
  const profile = STATE_VSK_PROFILES[detected];
  const keys = headerCells.map((h) => stateHeaderKey(h, profile, coreHeader));
  const data = grid.slice(start + 1).map((cells, i) => {
    const rec: Record<string, string> = {};
    keys.forEach((k, idx) => {
      rec[k] = cells[idx] ?? "";
    });
    const row = start + 2 + i;
    for (const n of convertStateScales(rec)) conversions.push({ ...n, row, schoolCode: rec.school_code ?? "" });
    return { cells: rec, row, file };
  });
  return { header, data, maps, conversions, stateCode: detected };
}

export function numOrNull(raw: string): number | null {
  const s = devToAscii(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ACADEMIC_YEAR = /(20\d{2})[-_]\d{2}(?!\d)/;

function baseKind(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("udise")) return "udise";
  if (n.includes("r4")) return "r4";
  if (n.includes("round") || /[_\s-]r[1-3](?![a-z0-9])/.test(n)) return "rounds";
  if (n.includes("dec")) return "dec";
  if (n.includes("attend")) return "attendance";
  if (n.includes("crcc") || n.includes("visit")) return "visits";
  if (n.includes("peer")) return "peer";
  if (ACADEMIC_YEAR.test(n)) return "year";
  return "unknown";
}

const startYear = (name: string) => Number(name.toLowerCase().match(ACADEMIC_YEAR)?.[1] ?? 0);

/**
 * Which export a file is, from its name. A file named only by academic year is an
 * earlier assessment: with every uploaded name given, the newest such year is y2
 * and the one before it y1. Alone, a 2023-24 file is y1 and any other year y2.
 */
export function fileKind(name: string, names?: readonly string[]): string {
  const kind = baseKind(name);
  if (kind !== "year") return kind;
  // Guarded so fileKind also works as a bare Array.map callback (index, array arguments).
  const all = Array.isArray(names) ? names : [name];
  const years = [...new Set(all.filter((x) => baseKind(x) === "year").map(startYear))].sort((a, b) => a - b);
  if (years.length < 2) return name.includes("2023") ? "y1" : "y2";
  const y = startYear(name);
  if (y === years.at(-1)) return "y2";
  return y === years.at(-2) ? "y1" : "unknown";
}
