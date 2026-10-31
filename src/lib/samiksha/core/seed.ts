import { asciiToDev } from "./config";
import type { Cycle, RawFile } from "./model";
import { runPipeline } from "./pipeline";

const CLUSTER_SIZES = [14, 14, 14, 14, 13, 14, 14, 13];

/**
 * Schools with a very small Grade 3 roll: two micro-hamlets in the middle of
 * the distribution. Their percentages swing on one child, so the engine must
 * report them as low confidence rather than as findings. The count of gaps and
 * flags does not change.
 */
const SMALL_ROLLS: Record<number, number> = { 36: 3, 60: 3 };

const E1 = ["Ram", "Shiv", "Dev", "Mohan", "Gopal", "Lakshmi", "Sita", "Tulsi", "Kamal", "Suraj", "Chandra", "Ganga", "Yamuna", "Bel", "Neem", "Aam", "Peepal", "Mahua", "Sagon", "Khair", "Sal", "Baans", "Kanchan", "Son", "Heera", "Moti", "Shyam", "Bihari", "Madhav", "Keshav", "Govind", "Nandlal", "Hari", "Brij", "Kishan", "Bholu", "Manglu", "Sukh", "Prem", "Vijay"];
const E2 = ["pur", "kheda", "gaon", "pura", "tola", "talai", "para", "nagar", "badi", "ganj"];
const H1 = ["राम", "शिव", "देव", "मोहन", "गोपाल", "लक्ष्मी", "सीता", "तुलसी", "कमल", "सूरज", "चन्द्र", "गंगा", "यमुना", "बेल", "नीम", "आम", "पीपल", "महुआ", "सागौन", "खैर", "साल", "बांस", "कंचन", "सोन", "हीरा", "मोती", "श्याम", "बिहारी", "माधव", "केशव", "गोविन्द", "नन्दलाल", "हरि", "बृज", "किशन", "भोलू", "मंगलू", "सुख", "प्रेम", "विजय"];
const H2 = ["पुर", "खेड़ा", "गाँव", "पुरा", "टोला", "तलाई", "पारा", "नगर", "बाड़ी", "गंज"];

type Kind = "khedi" | "harangaon" | "single" | "control" | "c6" | "plain" | "bad_missing" | "bad_impossible";

type Seed = {
  i: number;
  code: string;
  nameEn: string;
  nameHi: string;
  cluster: string;
  kind: Kind;
  singleIndex: number;
  controlIndex: number;
  workingTeachers: number;
  /**
   * Grade 3 children in the school. The denominator: without it a three-child
   * hamlet school and a sixty-child school produce the same percentage field.
   */
  nStudents: number;
  mathsPost: "Filled" | "Vacant";
  vacantSince: string;
  y1: number;
  y2: number | null;
  rounds: [number, number, number] | null;
  r4: number | null;
  att: number[];
  dec: number;
  visit: string;
  note: string;
};

function n10(tenths: number): number {
  return tenths / 10;
}

function village(n: number): { en: string; hi: string } {
  const a = n % 40;
  const b = Math.floor(n / 40);
  const suf = E2[b] ?? "pur";
  const hs = H2[b] ?? "पुर";
  return { en: `${E1[a]}${suf.charAt(0).toUpperCase()}${suf.slice(1)}`, hi: `${H1[a]}${hs}` };
}

function canonicalCode(i: number): string {
  if (i % 6 === 2) {
    const body = String(2311000000 + (i + 1)).padStart(10, "0");
    return `0${body}`;
  }
  return `231101${String(i + 1).padStart(5, "0")}`;
}

function messCode(code: string, i: number): string {
  const mode = i % 6;
  if (mode === 0) return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  if (mode === 1) return ` ${code.slice(0, 5)} ${code.slice(5)} `;
  if (mode === 2) return code.replace(/^0+/, "");
  if (mode === 3) return asciiToDev(code);
  if (mode === 4) return `${code}.0`;
  return Number(code).toExponential(10);
}

function baseSeeds(): Seed[] {
  const seeds: Seed[] = [];
  let i = 0;
  for (let c = 0; c < 8; c++) {
    for (let k = 0; k < CLUSTER_SIZES[c]!; k++) {
      const cluster = `C${c + 1}`;
      seeds.push({
        i,
        code: canonicalCode(i),
        nameEn: "",
        nameHi: "",
        cluster,
        kind: cluster === "C6" ? "c6" : "plain",
        singleIndex: -1,
        controlIndex: -1,
        workingTeachers: 2 + (i % 3),
        // A realistic Grade 3 roll. The two micro-hamlets have three children
        // each, so the low-confidence path is visible in the demo and not only
        // in theory. PS Khedi and the standard schools carry a normal roll.
        nStudents: SMALL_ROLLS[i] ?? 22 + (i % 17),
        mathsPost: "Filled",
        vacantSince: "",
        y1: 580,
        y2: 490,
        rounds: null,
        r4: null,
        att: [880, 870, 860, 860, 850],
        dec: 860,
        visit: "2025-11-18",
        note: "Routine numeracy classroom visit",
      });
      i++;
    }
  }
  return seeds;
}

function take(seeds: Seed[], pred: (s: Seed) => boolean): Seed {
  const s = seeds.find(pred);
  if (!s) throw new Error("seed placement failed");
  return s;
}

/** The scenarios the pipeline must surface: a vacancy drop, a perfect-score school, three single-teacher schools. */
function placeFlaggedSchools(seeds: Seed[]) {
  Object.assign(take(seeds, (s) => s.cluster === "C4"), {
    kind: "khedi" as Kind,
    nameEn: "PS Khedi",
    nameHi: "प्रा.शा. खेड़ी",
    mathsPost: "Vacant" as const,
    vacantSince: "2025-07",
    workingTeachers: 2,
    rounds: [520, 460, 340] as [number, number, number],
    r4: 450,
  });
  Object.assign(take(seeds, (s) => s.cluster === "C8"), {
    kind: "harangaon" as Kind,
    nameEn: "PS Harangaon",
    nameHi: "प्रा.शा. हरनगाँव",
    rounds: [1000, 1000, 1000] as [number, number, number],
    r4: 680,
  });
  const singleMeta: { cluster: string; en: string; hi: string; rounds: [number, number, number]; r4: number; dec: number }[] = [
    { cluster: "C2", en: "PS Amkheda", hi: "प्रा.शा. अमखेड़ा", rounds: [580, 550, 460], r4: 525, dec: 780 },
    { cluster: "C3", en: "PS Berkhadi", hi: "प्रा.शा. बेरखेड़ी", rounds: [570, 560, 470], r4: 535, dec: 780 },
    { cluster: "C7", en: "PS Sitapur", hi: "प्रा.शा. सीतापुर", rounds: [560, 570, 480], r4: 480, dec: 620 },
  ];
  singleMeta.forEach((m, idx) => {
    Object.assign(take(seeds, (x) => x.cluster === m.cluster && x.kind === "plain"), {
      kind: "single" as Kind,
      singleIndex: idx,
      nameEn: m.en,
      nameHi: m.hi,
      workingTeachers: 1,
      rounds: m.rounds,
      r4: m.r4,
      att: [820, 800, 720, 620, 600],
      dec: m.dec,
      visit: "2025-11-10",
      note: "फसल कटाई के कारण उपस्थिति कम (harvest season)",
    });
  });
}

/** Matched controls (low in R3, no action taken) and two deliberately bad rows. */
function placeControlsAndBadRows(seeds: Seed[]) {
  const controlMeta: { rounds: [number, number, number]; r4: number; en: string; hi: string }[] = [
    { rounds: [400, 380, 350], r4: 375, en: "PS Mahuar", hi: "प्रा.शा. महुअर" },
    { rounds: [410, 390, 360], r4: 385, en: "PS Patan", hi: "प्रा.शा. पाटन" },
    { rounds: [390, 360, 330], r4: 355, en: "PS Semra", hi: "प्रा.शा. सेमरा" },
    { rounds: [420, 400, 370], r4: 395, en: "PS Hinota", hi: "प्रा.शा. हिनोता" },
  ];
  const hosts = [
    ...seeds.filter((s) => s.cluster === "C1" && s.kind === "plain").slice(0, 2),
    ...seeds.filter((s) => s.cluster === "C5" && s.kind === "plain").slice(0, 2),
  ];
  hosts.forEach((s, idx) => {
    const m = controlMeta[idx]!;
    Object.assign(s, { kind: "control" as Kind, controlIndex: idx, nameEn: m.en, nameHi: m.hi, rounds: m.rounds, r4: m.r4 });
  });
  const bads = seeds.filter((s) => s.kind === "plain").slice(0, 2);
  bads[0]!.kind = "bad_missing";
  bads[0]!.y2 = null;
  bads[1]!.kind = "bad_impossible";
  bads[1]!.y2 = 1340;
}

/** Village names for unnamed schools, plus the round scores each kind carries. */
function nameAndScore(seeds: Seed[]) {
  let nameN = 0;
  for (const s of seeds) {
    if (!s.nameEn) {
      const v = village(nameN++);
      s.nameEn = `PS ${v.en}`;
      s.nameHi = `प्रा.शा. ${v.hi}`;
    }
    if (s.kind === "c6") {
      s.rounds = [495, 500, 502];
      s.r4 = 543;
      s.visit = "2025-09-11";
      s.note = "CRCC on BLO / election roll duty";
    } else if (s.kind === "plain") {
      const r3 = 480 + (s.i % 12) * 10;
      s.rounds = [r3 + 30, r3 + 20, r3];
      s.r4 = r3 + 12;
    } else if (s.kind === "bad_missing" || s.kind === "bad_impossible") {
      s.rounds = null;
      s.r4 = null;
    }
  }
}

function buildSeeds(): Seed[] {
  const seeds = baseSeeds();
  placeFlaggedSchools(seeds);
  placeControlsAndBadRows(seeds);
  nameAndScore(seeds);
  return seeds;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function renderSeedFiles(seeds = buildSeeds()): { cycle: RawFile[]; r4: RawFile[]; seeds: Seed[] } {
  const udiseRows: (string | number | null)[][] = [
    ["UDISE+ export (with vacancy list) — synthetic Kesli"],
    ["school_code", "school_name_en", "school_name_hi", "cluster", "working_teachers", "g3_students", "maths_teacher_post", "vacant_since"],
  ];
  for (const s of seeds) {
    udiseRows.push([messCode(s.code, s.i), s.nameEn, s.nameHi, s.cluster, s.workingTeachers, s.nStudents, s.mathsPost, s.vacantSince]);
  }
  udiseRows.push([seeds[0]!.code, seeds[0]!.nameEn, seeds[0]!.nameHi, seeds[0]!.cluster, seeds[0]!.workingTeachers, seeds[0]!.nStudents, seeds[0]!.mathsPost, seeds[0]!.vacantSince]);
  udiseRows.push([seeds[1]!.code, seeds[1]!.nameEn, seeds[1]!.nameHi, seeds[1]!.cluster, seeds[1]!.workingTeachers, seeds[1]!.nStudents, seeds[1]!.mathsPost, seeds[1]!.vacantSince]);

  const y1: (string | number | null)[][] = [["school_code", "academic_year", "g3_math_pct"]];
  const y2: (string | number | null)[][] = [["school_code", "academic_year", "g3_math_pct"]];
  for (const s of seeds) {
    y1.push([s.code, "2023-24", n10(s.y1)]);
    y2.push([s.code, "2024-25", s.y2 === null ? "" : n10(s.y2)]);
  }
  y1.push(["23999999999", "2023-24", 44]);

  const rounds: (string | number | null)[][] = [["विद्यालय कोड", "चक्र", "कक्षा 3 गणित (%)"]];
  const roundEcho: (string | number | null)[][] = [];
  for (const s of seeds) {
    if (!s.rounds) continue;
    (["R1", "R2", "R3"] as const).forEach((label, idx) => {
      const row = [s.code, label, n10(s.rounds![idx]!)];
      rounds.push(row);
      if ((s.kind === "plain" && s.i === seeds.find((x) => x.kind === "plain")?.i && label === "R1") || (s.kind === "khedi" && label === "R2") || (s.kind === "harangaon" && label === "R3")) {
        roundEcho.push(row);
      }
    });
  }
  for (const row of roundEcho) rounds.push(row);

  const att: (string | number | null)[][] = [["school_code", "month", "attendance_pct"]];
  const months = ["Jul", "Aug", "Sep", "Oct", "Nov"];
  for (const s of seeds) months.forEach((m, idx) => att.push([s.code, m, n10(s.att[idx]!)]));

  const visits: (string | number | null)[][] = [["school_code", "cluster", "visit_date", "note"]];
  for (const s of seeds) visits.push([s.code, s.cluster, s.visit, s.note]);

  const peers: (string | number | null)[][] = [
    ["block_name", "election_duty_2024", "rural_share_pct", "delta_pts"],
    ["Peer Block A", "Yes", 86, -1.5],
    ["Peer Block B", "Yes", 91, -0.8],
    ["Peer Block C", "Yes", 84, 0.5],
    ["Peer Block D", "Yes", 88, 1.4],
    ["Peer Block E", "No", 92, -8.2],
    ["Peer Block F", "Yes", 61, -6.4],
  ];

  const r4: (string | number | null)[][] = [["school_code", "round", "g3_math_pct"]];
  const dec: (string | number | null)[][] = [["school_code", "month", "attendance_pct"]];
  for (const s of seeds) {
    if (s.r4 !== null) r4.push([s.code, "R4", n10(s.r4)]);
    dec.push([s.code, "Dec", n10(s.dec)]);
  }

  return {
    seeds,
    cycle: [
      { name: "udise_2025-26.csv", csv: csv(udiseRows) },
      { name: "assess_2023-24.csv", csv: csv(y1) },
      { name: "assess_2024-25.csv", csv: csv(y2) },
      { name: "assess_2025-26_rounds.csv", csv: csv(rounds) },
      { name: "attendance_2025-26.csv", csv: csv(att) },
      { name: "crcc_visits.csv", csv: csv(visits) },
      { name: "peer_blocks.csv", csv: csv(peers) },
    ],
    r4: [
      { name: "assess_2025-26_r4.csv", csv: csv(r4) },
      { name: "attendance_2025-26_dec.csv", csv: csv(dec) },
    ],
  };
}

export function loadSeededCycle(): Cycle {
  const rendered = renderSeedFiles();
  const parsed = runPipeline(rendered.cycle);
  const contractErrors = parsed.contractErrors;
  return {
    ...parsed,
    r4Files: rendered.r4,
    contractErrors,
  };
}
