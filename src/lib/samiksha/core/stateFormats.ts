/**
 * State export profiles: the column names, score scales and officer titles that
 * differ between states. readTable (ingest.ts) runs every row through
 * normalizeStateRow, so uploads and tests share one path. The column names follow
 * each state's portal vocabulary but are not copied from verified exports:
 * confirm them against a real export before a pilot.
 */
import { devToAscii } from "./config";

// Local parser: ingest.ts imports this module, so importing ingest back would form a cycle.
const numOrNull = (raw: string): number | null => {
  const s = devToAscii(raw).trim();
  const n = s ? Number(s) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export type StateCode = "MP" | "UP" | "PB" | "HR";
type Copy = { en: string; hi: string };

export type StateProfile = {
  code: StateCode;
  nameEn: string;
  nameHi: string;
  systemEn: string;
  scale: "percent" | "ten_point" | "levels";
  scaleEn: string;
  scaleHi: string;
  /** Lower-cased state column name -> canonical Samiksha column. */
  aliases: Record<string, string>;
  /** Officer titles, school level up to state level. */
  roles: { HM: Copy; CRCC: Copy; BEO: Copy; DEO: Copy; SPD: Copy };
  sample: { fileName: string; csv: string };
};

/**
 * Competency level -> percent. The four level names follow the PARAKH / NAS
 * performance levels (L1 / D Below Basic, L2 / C Basic, L3 / B Proficient,
 * L4 / A Advanced). The percent bands behind them (below 40, 40–59, 60–79,
 * 80–100) and the midpoints used here are this prototype's assumption, not a
 * published PARAKH table: a state sets its own before a pilot.
 */
export const LEVEL_TO_PCT: Record<string, number> = { L1: 30, L2: 50, L3: 72, L4: 90, A: 90, B: 72, C: 50, D: 30 };

export const STATE_VSK_PROFILES: Record<StateCode, StateProfile> = {
  MP: {
    code: "MP",
    nameEn: "Madhya Pradesh",
    nameHi: "मध्य प्रदेश",
    systemEn: "RSK · Shaala Gunvatta",
    scale: "percent",
    scaleEn: "Percent, 0–100",
    scaleHi: "प्रतिशत, 0–100",
    aliases: {
      rsk_school_code: "school_code",
      jan_shiksha_kendra: "cluster",
      jsk: "cluster",
      jsk_code: "cluster",
      "भ्रमण दिनांक": "visit_date",
      भ्रमण_दिनांक: "visit_date",
    },
    roles: {
      HM: { en: "HM (Pradhan Adhyapak)", hi: "प्रधानाध्यापक" },
      CRCC: { en: "CRCC (Jan Shiksha Kendra)", hi: "जन शिक्षक (CRCC)" },
      BEO: { en: "BEO / BRCC", hi: "विकासखंड शिक्षा अधिकारी (BEO)" },
      DEO: { en: "DEO / DPC", hi: "जिला शिक्षा अधिकारी (DEO)" },
      SPD: { en: "SPD (Rajya Shiksha Kendra)", hi: "राज्य परियोजना संचालक (RSK)" },
    },
    sample: {
      fileName: "mp_rsk_rounds_sample.csv",
      csv: "RSK_School_Code,JSK_Code,चक्र,कक्षा 3 गणित (%)\n2311-0100-043,C4,R3,34\n23110100044,C4,R3,58\n",
    },
  },
  UP: {
    code: "UP",
    nameEn: "Uttar Pradesh",
    nameHi: "उत्तर प्रदेश",
    systemEn: "NIPUN Bharat · Prerna / Saral",
    scale: "percent",
    scaleEn: "Percent, 0–100",
    scaleHi: "प्रतिशत, 0–100",
    aliases: {
      dise_code: "school_code",
      nyay_panchayat: "cluster",
      nipun_lakshya_g3_math_pct: "g3_math_pct",
      arp_name: "officer_name",
      shiksha_mitra_working: "shiksha_mitra_working",
    },
    roles: {
      HM: { en: "HM (Pradhanadhyapak)", hi: "प्रधानाध्यापक" },
      CRCC: { en: "ARP (Academic Resource Person)", hi: "एआरपी (शैक्षिक संदर्भ व्यक्ति)" },
      BEO: { en: "BEO (Khand Shiksha Adhikari)", hi: "खंड शिक्षा अधिकारी" },
      DEO: { en: "BSA (Basic Shiksha Adhikari)", hi: "बेसिक शिक्षा अधिकारी" },
      SPD: { en: "SPD (Samagra Shiksha UP)", hi: "राज्य परियोजना निदेशक (समग्र शिक्षा)" },
    },
    sample: {
      fileName: "up_prerna_rounds_sample.csv",
      csv: "DISE_Code,Nyay_Panchayat,ARP_Name,round,NIPUN_Lakshya_G3_Math_Pct\n09110100043,NP-4,Shri A. Verma,R3,41\n09110100044,NP-4,Shri A. Verma,R3,77\n",
    },
  },
  PB: {
    code: "PB",
    nameEn: "Punjab",
    nameHi: "पंजाब",
    systemEn: "e-Punjab School · Padho Punjab",
    scale: "ten_point",
    scaleEn: "Score out of 10, converted to percent",
    scaleHi: "10 में से अंक, प्रतिशत में बदले",
    aliases: {
      pseb_udise_id: "school_code",
      cht_cluster_code: "cluster",
      g3_numeracy_scale_10: "g3_math_scale10",
      attendance_rate: "attendance_pct",
      bpeo_block: "block_label",
    },
    roles: {
      HM: { en: "HT (Head Teacher)", hi: "मुख्य शिक्षक (HT)" },
      CRCC: { en: "CHT (Centre Head Teacher)", hi: "केंद्र मुख्य शिक्षक (CHT)" },
      BEO: { en: "BPEO (Block Primary Education Officer)", hi: "ब्लॉक प्राथमिक शिक्षा अधिकारी" },
      DEO: { en: "DEO (Elementary)", hi: "जिला शिक्षा अधिकारी (प्रारंभिक)" },
      SPD: { en: "DGSE (Punjab)", hi: "महानिदेशक स्कूल शिक्षा (पंजाब)" },
    },
    sample: {
      fileName: "punjab_epunjab_rounds_sample.csv",
      csv: "PSEB_UDISE_Id,CHT_Cluster_Code,BPEO_Block,round,G3_Numeracy_Scale_10\n03110100043,CHT-4,Block 1,R3,3.4\n03110100044,CHT-4,Block 1,R3,7.5\n",
    },
  },
  HR: {
    code: "HR",
    nameEn: "Haryana",
    nameHi: "हरियाणा",
    systemEn: "NIPUN Haryana · Saksham Samiksha",
    scale: "levels",
    scaleEn: "Competency level L1–L4 (or A–D), mapped to an assumed percent",
    scaleHi: "दक्षता स्तर L1–L4 (या A–D), अनुमानित प्रतिशत में",
    aliases: {
      school_code_11: "school_code",
      abrc_cluster: "cluster",
      competency_c84_grade: "g3_math_level",
    },
    roles: {
      HM: { en: "HM (Head Master)", hi: "मुख्याध्यापक" },
      CRCC: { en: "ABRC / BRP", hi: "एबीआरसी / बीआरपी" },
      BEO: { en: "BEO", hi: "खंड शिक्षा अधिकारी" },
      DEO: { en: "DEEO (District Elementary Education Officer)", hi: "जिला मौलिक शिक्षा अधिकारी" },
      SPD: { en: "SPD (Samagra Shiksha Haryana)", hi: "राज्य परियोजना निदेशक" },
    },
    sample: {
      fileName: "haryana_saksham_rounds_sample.csv",
      csv: "School_Code_11,ABRC_Cluster,round,Competency_C84_Grade\n06110100043,ABRC-4,R3,L1\n06110100044,ABRC-4,R3,L3\n",
    },
  },
};

export const STATE_CODES = Object.keys(STATE_VSK_PROFILES) as StateCode[];

/** Every state alias, for the header reader. */
export const STATE_ALIASES: Record<string, string> = Object.assign({}, ...STATE_CODES.map((c) => STATE_VSK_PROFILES[c].aliases));

const FILE_HINTS: [StateCode, RegExp][] = [
  ["UP", /(^|[_\s-])(up|uttar|prerna|saral)([_\s.-]|$)/i],
  ["PB", /(punjab|epunjab|pseb|(^|[_\s-])pb([_\s.-]|$))/i],
  ["HR", /(haryana|saksham|(^|[_\s-])hr([_\s.-]|$))/i],
  ["MP", /(madhya|rsk|shaala|(^|[_\s-])mp([_\s.-]|$))/i],
];

export type StateDetection = { code: StateCode; matched: string[]; fileHint: boolean; byFallback: boolean };

/**
 * The state whose columns the headers match best (2 points a column), a
 * file-name hint adding 1. With no match at all it falls back to MP, and says so.
 */
export function detectStateProfileDetail(headers: string[], fileName = ""): StateDetection {
  const low = headers.map((h) => h.trim().toLowerCase());
  let best: StateDetection = { code: "MP", matched: [], fileHint: false, byFallback: true };
  let bestScore = 0;
  for (const code of STATE_CODES) {
    const keys = Object.keys(STATE_VSK_PROFILES[code].aliases);
    const matched = headers.filter((_, i) => keys.includes(low[i]!)).map((h) => h.trim());
    const fileHint = Boolean(FILE_HINTS.find(([c]) => c === code)?.[1].test(fileName));
    const score = matched.length * 2 + (fileHint ? 1 : 0);
    if (score > bestScore) {
      best = { code, matched, fileHint, byFallback: false };
      bestScore = score;
    }
  }
  return best;
}

export function detectStateProfile(headers: string[], fileName = ""): StateCode {
  return detectStateProfileDetail(headers, fileName).code;
}

export type ScaleNote = { field: string; from: string; to: string; rule: "ten_point_to_percent" | "level_to_percent" };

/**
 * Fill g3_math_pct from a state scale when the row has no percent: a 0–10 score
 * becomes score × 10, a competency level becomes its assumed band midpoint.
 * Mutates and returns the notes, so the pipeline can log each conversion.
 */
export function convertStateScales(cells: Record<string, string>): ScaleNote[] {
  const notes: ScaleNote[] = [];
  if ((cells.g3_math_pct ?? "").trim()) return notes;
  const ten = numOrNull(cells.g3_math_scale10 ?? "");
  if (ten !== null && ten >= 0 && ten <= 10) {
    const pct = Math.round(ten * 100) / 10;
    cells.g3_math_pct = String(pct);
    notes.push({ field: "g3_math_scale10", from: `${ten} / 10`, to: `${pct}%`, rule: "ten_point_to_percent" });
    return notes;
  }
  const level = (cells.g3_math_level ?? "").trim().toUpperCase();
  if (level && LEVEL_TO_PCT[level] !== undefined) {
    cells.g3_math_pct = String(LEVEL_TO_PCT[level]);
    notes.push({ field: "g3_math_level", from: level, to: `${LEVEL_TO_PCT[level]}%`, rule: "level_to_percent" });
  }
  return notes;
}

/**
 * The canonical name for one state column. `coreHeader` is the reader's own
 * column map (ingest.ts passes it), tried before the state's aliases. readTable
 * maps each header once with this; normalizeStateRow maps a single row with it.
 */
export function stateHeaderKey(raw: string, profile: StateProfile, coreHeader: (raw: string) => string | null = () => null): string {
  const key = raw.trim().toLowerCase();
  return coreHeader(raw) ?? profile.aliases[key] ?? STATE_ALIASES[key] ?? raw.trim();
}

/** One raw row (state column -> value) in canonical columns, with the scale conversions made. */
export function normalizeStateRow(
  row: Record<string, string>,
  profile: StateProfile,
  coreHeader: (raw: string) => string | null = () => null,
): { cells: Record<string, string>; notes: ScaleNote[] } {
  const cells: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) cells[stateHeaderKey(k, profile, coreHeader)] = v;
  return { cells, notes: convertStateScales(cells) };
}
