import type { ActionId, Thresholds } from "./config";
import type { StateCode } from "./stateFormats";

export type Person = {
  id: string;
  role: "BEO" | "DEO" | "CRCC" | "HM";
  nameEn: string;
  nameHi: string;
  scope: string;
  cluster: string | null;
};

export type Issue = {
  category: "data_problem" | "auto_fixed";
  severity: "error" | "warning" | "info";
  issueType: string;
  schoolCode: string;
  rawValue: string;
  fixedValue: string;
  sourceFile: string;
  sourceRow: number;
  descriptionEn: string;
  descriptionHi: string;
};

export type SchoolRow = {
  code: string;
  nameEn: string;
  nameHi: string;
  cluster: string;
  workingTeachers: number;
  /**
   * How many Grade 3 children the school has. Without this the engine cannot
   * tell a three-child hamlet school from a sixty-child school, and a single
   * absent child moved the percentage as much as a real collapse.
   */
  nStudents: number;
  /** True when the Grade 3 sample is too small for the percentage to mean much. */
  smallSampleNoise?: boolean;
  mathsPost: string;
  vacantSince: string;
  y1: number | null;
  y2: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  r4: number | null;
  julAug: number | null;
  octNov: number | null;
  decAtt: number | null;
  daysSinceVisit: number | null;
  lastVisit: string;
  lastNote: string;
  kind: string;
};

export type Citation = {
  file: string;
  row: number;
  schoolOrCluster: string;
  verbatim: string;
};

/** Ranks 1-5 are the flagged gaps; 6-10 and 11-15 are the watchlist that Top 10 and Top 15 add. */
export type GapTier = "core_top_5" | "extended_top_10" | "extended_top_15";

export type Gap = {
  id: string;
  tier?: GapTier;
  codeRank: number;
  claudeRank: number;
  rankJustificationEn: string;
  rankJustificationHi: string;
  targetLabel: string;
  targetLabelHi: string;
  targetType: "school" | "cluster" | "school_group";
  targetCodes: string[];
  gapKind: string;
  factEn: string;
  factHi: string;
  reasonEn: string;
  reasonHi: string;
  actionId: ActionId;
  allowedActions: ActionId[];
  sourceRefs: Citation[];
  codeScore: number;
  /**
   * Set when the school behind the gap has too few Grade 3 children for the
   * percentage to mean much. The gap is reported as low confidence, not as a
   * finding to act on.
   */
  lowSample?: { n: number; minimum: number };
};

export type PeerBlock = {
  name: string;
  election: string;
  rural: number;
  delta: number;
  matched: boolean;
};

export type Cycle = {
  files: { name: string; csv: string; dataRows: number }[];
  r4Files: { name: string; csv: string }[];
  problems: Issue[];
  fixes: Issue[];
  headerMaps: { file: string; from: string; to: string }[];
  schools: SchoolRow[];
  flags: { id: string; label: string }[];
  /**
   * The state profile the uploaded files were detected as, from their own
   * headers. The screen shows the officer titles of this state, not a default.
   */
  detectedStateCode: StateCode;
  /** The 5 core gaps (code ranks 1-5). Tasks, the scorecard and the Slide 3 contract read these. */
  gaps: Gap[];
  /** The core gaps, then up to 10 watchlist schools (code ranks 6-15). */
  allRankedGaps: Gap[];
  /** The thresholds this cycle was built with: CONFIG plus the block's SPD overrides. Absent on older cycles. */
  thresholds?: Thresholds;
  peers: PeerBlock[];
  peer: {
    pilotDelta: number;
    matchedDeltas: number[];
    sufficient: boolean;
    rule: string;
    conclusionEn: string;
    conclusionHi: string;
    y1: number;
    y2: number;
    comparedSchools: number;
  };
  summary: {
    files_read: number;
    schools: number;
    years_joined: number;
    assessment_rows: number;
    data_problems: number;
    auto_fixed: number;
    flags: number;
    runtime_s: number;
  };
  briefInput: Record<string, unknown>;
  briefEn: string;
  briefHi: string;
  people: Person[];
  contractErrors: string[];
};

export type TaskStatus =
  | "draft"
  | "approved"
  | "rejected"
  | "sent"
  | "reminded"
  | "done"
  | "partial"
  | "blocked"
  | "overdue"
  | "escalated"
  | "outcome_checked"
  | "cancelled";

export type Task = {
  id: number;
  gapId: string;
  actionId: ActionId;
  whatEn: string;
  whatHi: string;
  ownerId: string | null;
  targetLabel: string;
  targetLabelHi: string;
  targetCodes: string[];
  dueDate: string | null;
  successEn: string;
  successHi: string;
  status: TaskStatus;
  missingFields: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  /** The level the approver acted at, so a supervisory override is visible in the trail. */
  approvedAsLevel?: number | null;
  /** The roster person who approved, from the signed session. */
  approvedByPersonId?: string | null;
  /** True when the officer acted above the level the action needs. */
  approvedIsOverride?: boolean;
  completedAt: string | null;
  /** Target schools reported finished so far (0..targetCodes.length). */
  unitsDone: number;
  note: string;
  noteHi: string;
};

export type ReplyParse = {
  parsed_status: "done" | "partial" | "blocked" | "unknown";
  confidence: number;
  reason_hi: string;
  reason_en: string;
  needs_clarification: boolean;
  follow_up_question_hi: string | null;
  follow_up_question_en: string | null;
};

export type RawFile = { name: string; csv: string };

/** A joined school plus the source rows its citations point at. */
export type JoinedSchool = SchoolRow & {
  roundRows?: Record<string, number>;
  roundSrc?: Record<string, string>;
  visitRow?: number;
  visitSrc?: string;
  /** Attendance rows by month, with the value as the file wrote it. */
  attRefs?: Record<string, { row: number; file: string; pct: number }>;
};
