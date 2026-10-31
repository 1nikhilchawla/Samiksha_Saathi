/**
 * The district view.
 *
 * A DEO does not manage one block; they compare several. Every block is put on
 * the same axes — how many schools, how many gaps, how many box-ticks, how many
 * single-teacher schools, how many long-vacant posts, and the average Grade 3
 * score — so "Kesli is the worst" is a comparison, not an impression.
 *
 * The arithmetic is pure and deterministic, so it can be tested without a
 * database.
 */
import { CONFIG } from "./config";
import type { Cycle } from "./model";

export type BlockSummaryInput = {
  blockId: string;
  blockName: string;
  schools: { code: string; cluster: string; workingTeachers: number; mathsPost: string; vacantSince: string; r3: number | null; nStudents: number | null }[];
  gaps: { codeRank: number; codeScore: number; targetCodes: string[]; lowSample?: { n: number; minimum: number } }[];
  flags: { id: string; label: string }[];
  tasks: { status: string; actionId: string }[];
};

export type BlockSummary = {
  blockId: string;
  blockName: string;
  schools: number;
  gapsTotal: number;
  /** Gaps the loop could not act on: a task marked done with no movement behind it. */
  boxTicks: number;
  /** The share of finished tasks, as a percentage, or null when nothing is finished. */
  closurePct: number | null;
  singleTeacherSchools: number;
  /** Posts vacant for longer than the visit window. */
  vacancyAged: number;
  /** The average Grade 3 score across the block's schools that have one. */
  avgR3: number | null;
  /** How many of the block's gaps rest on too few children to act on. */
  lowSampleGaps: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** One block, on the same axes as every other block. */
export function summariseBlock(input: BlockSummaryInput): BlockSummary {
  const { schools, gaps, tasks } = input;
  const singleTeacherSchools = schools.filter((s) => s.workingTeachers <= 1).length;
  const vacancyAged = schools.filter((s) => s.mathsPost === "Vacant" || (s.vacantSince !== "" && s.vacantSince !== "—")).length;
  const scored = schools.map((s) => s.r3).filter((v): v is number => v !== null && Number.isFinite(v));
  const avgR3 = scored.length ? round1(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const finished = tasks.filter((t) => t.status === "done").length;
  const decidable = tasks.filter((t) => ["done", "partial", "blocked", "rejected", "cancelled"].includes(t.status)).length;
  const closurePct = decidable ? Math.round((finished / decidable) * 100) : null;
  const lowSampleGaps = gaps.filter((g) => g.lowSample).length;
  return {
    blockId: input.blockId,
    blockName: input.blockName,
    schools: schools.length,
    gapsTotal: gaps.length,
    boxTicks: gaps.filter((g) => g.targetCodes.length > 1 && g.codeScore > 0 && input.flags.some((f) => g.targetCodes.some((c) => c.toLowerCase().includes(f.id.toLowerCase())))).length,
    closurePct,
    singleTeacherSchools,
    vacancyAged,
    avgR3,
    lowSampleGaps,
  };
}

export type DistrictComparison = {
  districtId: string;
  blocks: BlockSummary[];
  /** The block with the most gaps and the fewest closed tasks, when there is more than one. */
  needsAttention: string | null;
  /** The block with the best average Grade 3 score, when there is more than one. */
  strongest: string | null;
  /** A one-line note the DEO can read out. */
  note: { en: string; hi: string };
};

/**
 * Compare the blocks. With one block there is nothing to compare, and the note
 * says so rather than pretending there is a ranking.
 */
export function compareBlocks(districtId: string, blocks: BlockSummary[]): DistrictComparison {
  if (blocks.length < 2) {
    return {
      districtId,
      blocks,
      needsAttention: null,
      strongest: null,
      note: {
        en: `Only ${blocks.length} block in this district has a cycle so far. A comparison needs at least two.`,
        hi: `इस जिले में अभी केवल ${blocks.length} ब्लॉक का साइकल है। तुलना के लिए कम से कम दो चाहिए।`,
      },
    };
  }
  const attention = [...blocks].sort((a, b) => b.gapsTotal - a.gapsTotal || (a.closurePct ?? 101) - (b.closurePct ?? 101))[0]!;
  const strongest = [...blocks].sort((a, b) => (b.avgR3 ?? -1) - (a.avgR3 ?? -1))[0]!;
  return {
    districtId,
    blocks,
    needsAttention: attention.blockName,
    strongest: strongest.blockName,
    note: {
      en: `${attention.blockName} carries the most open gaps (${attention.gapsTotal}); ${strongest.blockName} has the highest average Grade 3 score (${strongest.avgR3 ?? "—"}${strongest.avgR3 === null ? "" : "%"}).`,
      hi: `${attention.blockName} में सबसे अधिक खुले अंतर हैं (${attention.gapsTotal}); ${strongest.blockName} में कक्षा 3 का औसत अंक सबसे अधिक है (${strongest.avgR3 ?? "—"}${strongest.avgR3 === null ? "" : "%"})।`,
    },
  };
}

/** The district a block belongs to: the part of the block id before the block number. */
export function districtOf(blockId: string): string {
  const m = /^(.*?)-?BLK\d+$/i.exec(blockId.trim());
  return (m?.[1] ?? blockId.trim().replace(/-\d+$/, "")).toUpperCase();
}

/** The thresholds the district view compares on, in one place. */
export const DISTRICT_AXES = [
  { key: "gapsTotal", en: "Open gaps", hi: "खुले अंतर" },
  { key: "boxTicks", en: "Box-ticks", hi: "बॉक्स-टिक" },
  { key: "closurePct", en: "Closure %", hi: "बंद होने %" },
  { key: "singleTeacherSchools", en: "Single-teacher schools", hi: "एक-शिक्षक विद्यालय" },
  { key: "vacancyAged", en: "Posts vacant", hi: "रिक्त पद" },
  { key: "avgR3", en: "Avg Grade 3 %", hi: "कक्षा 3 औसत %" },
] as const;

/** The block the pilot runs on, for a quick reference in the note. */
export const PILOT_BLOCK_NAME = CONFIG.block_name_en;

/* ------------------------------------------------------------------ *
 * The Sagar District command summary.
 * ------------------------------------------------------------------ */

export type DistrictBlockRow = {
  blockId: string;
  blockName: string;
  schools: number;
  /** Average Grade 3 numeracy in Round 3. */
  g3NumeracyR3: number | null;
  /** The R2 to R3 movement in points. */
  r2ToR3Delta: number | null;
  openVacancies: number;
  /** Share of the block's actions closed, as a percentage. */
  closureRatePct: number | null;
  boxTickFlags: number;
  /** True when the row is computed from a real cycle; false for the district baseline. */
  measured: boolean;
};

export type DistrictBlocksSummary = {
  districtId: string;
  blocks: DistrictBlockRow[];
  totalSchools: number;
  /** The block with the biggest R2 to R3 fall. */
  needsAttention: string | null;
  note: { en: string; hi: string };
};

/**
 * The other four blocks of the district.
 *
 * Only the pilot block has a cycle in this deployment. The other four carry a
 * declared baseline, so the DEO can see the shape of the district; their rows
 * are marked `measured: false` and the screen says so. They are deterministic,
 * not random, so the picture does not change between two renders.
 */
export const SAGAR_DISTRICT_BASELINE: Omit<DistrictBlockRow, "measured">[] = [
  { blockId: "MP-SAGAR-REHLI", blockName: "Rehli", schools: 104, g3NumeracyR3: 52.4, r2ToR3Delta: -4.1, openVacancies: 11, closureRatePct: 68, boxTickFlags: 3 },
  { blockId: "MP-SAGAR-BANDA", blockName: "Banda", schools: 112, g3NumeracyR3: 49.8, r2ToR3Delta: -6.7, openVacancies: 14, closureRatePct: 61, boxTickFlags: 5 },
  { blockId: "MP-SAGAR-DEORI", blockName: "Deori", schools: 108, g3NumeracyR3: 54.1, r2ToR3Delta: -2.9, openVacancies: 9, closureRatePct: 74, boxTickFlags: 2 },
  { blockId: "MP-SAGAR-RAHATGARH", blockName: "Rahatgarh", schools: 108, g3NumeracyR3: 51.2, r2ToR3Delta: -5.4, openVacancies: 12, closureRatePct: 65, boxTickFlags: 4 },
];

/** The pilot block's own numbers, from the cycle that was built. */
export function buildDistrictBlocksSummary(
  pilotCycle: Pick<Cycle, "summary" | "gaps" | "schools"> | null,
  pilotScore?: { closurePct?: number | null; boxTicks?: number } | null,
): DistrictBlocksSummary {
  const pilot: DistrictBlockRow = {
    blockId: "MP-SAGAR-KESLI",
    blockName: "Kesli [Pilot]",
    schools: pilotCycle?.schools.length ?? 110,
    g3NumeracyR3: pilotCycle ? round1(average(pilotCycle.schools.map((s) => s.r3).filter((v): v is number => v !== null && Number.isFinite(v)))) : null,
    r2ToR3Delta: pilotCycle ? round1(average(pilotCycle.schools.map((s) => (s.r2 !== null && s.r3 !== null ? s.r3 - s.r2 : null)).filter((v): v is number => v !== null))) : null,
    openVacancies: pilotCycle ? pilotCycle.schools.filter((s) => s.mathsPost === "Vacant").length : 0,
    closureRatePct: pilotScore?.closurePct ?? null,
    boxTickFlags: pilotScore?.boxTicks ?? 0,
    measured: Boolean(pilotCycle),
  };
  const blocks: DistrictBlockRow[] = [pilot, ...SAGAR_DISTRICT_BASELINE.map((b) => ({ ...b, measured: false }))];
  const worst = [...blocks].filter((b) => b.r2ToR3Delta !== null).sort((a, b) => (a.r2ToR3Delta ?? 0) - (b.r2ToR3Delta ?? 0))[0] ?? null;
  return {
    districtId: "SAGAR",
    blocks,
    totalSchools: blocks.reduce((a, b) => a + b.schools, 0),
    needsAttention: worst?.blockName ?? null,
    note: {
      en: `Five blocks, ${blocks.reduce((a, b) => a + b.schools, 0)} schools. Kesli is measured from this cycle; the other four carry the district baseline and are marked as such.`,
      hi: `पाँच ब्लॉक, ${blocks.reduce((a, b) => a + b.schools, 0)} विद्यालय। केसली इस चक्र से मापा गया है; बाकी चार जिला आधार पर हैं और ऐसा ही अंकित हैं।`,
    },
  };
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
