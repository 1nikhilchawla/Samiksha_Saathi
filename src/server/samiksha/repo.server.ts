/** Samiksha rows <-> engine shapes. Server-only; every query is scoped by block_id. */
import { createHash, timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";
import {
  CONFIG,
  DEFAULT_TOP_GAPS_LIMIT,
  buildScorecard,
  estimateCallCost,
  gapTier,
  type ActionId,
  type Cycle,
  type Gap,
  type Issue,
  type Person,
  type SchoolRow,
  type Scorecard,
  type Task,
} from "@/lib/samiksha/engine";
import type { ChatMsg, CycleData, HingeDecision, LiveData, LiveExtras, LlmCall } from "@/lib/samiksha/types";

type Row = Record<string, unknown>;

/** Deterministic UUID from parts, so a retried write maps to the same client_request_id. */
export function stableUuid(...parts: (string | number)[]): string {
  const h = createHash("sha256").update(parts.join("␟")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Constant-time check of a shared secret; an unset secret never matches. */
export function secretMatches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!expected?.trim() || !given) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected.trim()));
}

/** Today in India, as YYYY-MM-DD. */
export function istToday(now = Date.now()): string {
  return new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export function assertBlockId(blockId: string): string {
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(blockId)) throw new Error("Invalid block id.");
  return blockId;
}

export const defaultBlockId = () => process.env.SAMIKSHA_BLOCK_ID?.trim() || CONFIG.block_id;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function toSchool(r: Row): SchoolRow {
  return {
    code: r.code as string,
    nameEn: r.name_en as string,
    nameHi: r.name_hi as string,
    cluster: r.cluster as string,
    workingTeachers: Number(r.working_teachers),
    nStudents: num(r.n_students) ?? 0,
    mathsPost: r.maths_post as string,
    vacantSince: r.vacant_since as string,
    y1: num(r.y1),
    y2: num(r.y2),
    r1: num(r.r1),
    r2: num(r.r2),
    r3: num(r.r3),
    r4: num(r.r4),
    julAug: num(r.jul_aug),
    octNov: num(r.oct_nov),
    decAtt: num(r.dec_att),
    daysSinceVisit: num(r.days_since_visit),
    lastVisit: r.last_visit as string,
    lastNote: r.last_note as string,
    kind: r.kind as string,
  };
}

function toIssue(r: Row): Issue {
  return {
    category: r.category as Issue["category"],
    severity: r.severity as Issue["severity"],
    issueType: r.issue_type as string,
    schoolCode: r.school_code as string,
    rawValue: r.raw_value as string,
    fixedValue: r.fixed_value as string,
    sourceFile: r.source_file as string,
    sourceRow: Number(r.source_row),
    descriptionEn: r.description_en as string,
    descriptionHi: r.description_hi as string,
  };
}

function toGap(r: Row): Gap {
  return {
    id: r.gap_id as string,
    tier: gapTier(Number(r.code_rank)),
    codeRank: Number(r.code_rank),
    claudeRank: Number(r.claude_rank),
    rankJustificationEn: r.rank_justification_en as string,
    rankJustificationHi: r.rank_justification_hi as string,
    targetLabel: r.target_label as string,
    targetLabelHi: r.target_label_hi as string,
    targetType: r.target_type as Gap["targetType"],
    targetCodes: r.target_codes as string[],
    gapKind: r.gap_kind as string,
    factEn: r.fact_en as string,
    factHi: r.fact_hi as string,
    reasonEn: r.reason_en as string,
    reasonHi: r.reason_hi as string,
    actionId: r.action_id as ActionId,
    allowedActions: r.allowed_actions as ActionId[],
    sourceRefs: r.source_refs as Gap["sourceRefs"],
    codeScore: Number(r.code_score),
    ...(r.low_sample ? { lowSample: { n: Number((r.low_sample as { n: number }).n), minimum: Number((r.low_sample as { minimum: number }).minimum) } } : {}),
  };
}

export type TaskRow = Task & { dbId: number };

export function toTask(r: Row): TaskRow {
  return {
    dbId: Number(r.id),
    id: Number(r.task_no),
    gapId: r.gap_id as string,
    actionId: r.action_id as ActionId,
    whatEn: r.what_en as string,
    whatHi: r.what_hi as string,
    ownerId: (r.owner_id as string | null) ?? null,
    targetLabel: r.target_label as string,
    targetLabelHi: r.target_label_hi as string,
    targetCodes: r.target_codes as string[],
    dueDate: (r.due_date as string | null) ?? null,
    successEn: r.success_en as string,
    successHi: r.success_hi as string,
    status: r.status as Task["status"],
    missingFields: r.missing_fields as string[],
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: iso(r.approved_at),
    approvedAsLevel: r.approved_as_level === null || r.approved_as_level === undefined ? null : Number(r.approved_as_level),
    approvedByPersonId: (r.approved_by_person_id as string | null) ?? null,
    approvedIsOverride: Boolean(r.approved_is_override),
    completedAt: (r.completed_at as string | null) ?? null,
    unitsDone: Number(r.units_done ?? 0),
    note: r.note as string,
    noteHi: r.note_hi as string,
  };
}

export type CycleRow = {
  id: number;
  blockId: string;
  source: "seed" | "upload";
  reviewDate: string;
  simToday: string | null;
  prepSeconds: number;
  r4Loaded: boolean;
  people: Person[];
  r4Files: { name: string; csv: string }[];
  briefInput: Record<string, unknown>;
};

function toCycleRow(r: Row): CycleRow {
  return {
    id: Number(r.id),
    blockId: r.block_id as string,
    source: r.source as CycleRow["source"],
    reviewDate: r.review_date as string,
    simToday: (r.sim_today as string | null) ?? null,
    prepSeconds: Number(r.prep_seconds),
    r4Loaded: Boolean(r.r4_loaded),
    people: r.people as Person[],
    r4Files: r.r4_files as CycleRow["r4Files"],
    briefInput: r.brief_input as Record<string, unknown>,
  };
}

/** The cycle clock: synthetic cycles keep their own date, real ones run on IST. */
export const clockToday = (c: Pick<CycleRow, "simToday">) => c.simToday ?? istToday();

export async function latestCycle(blockId: string, sql?: Sql): Promise<CycleRow | null> {
  const db = sql ?? (await getSql());
  const rows = await db`select * from cycles where block_id = ${blockId} order by id desc limit 1`;
  return rows[0] ? toCycleRow(rows[0]) : null;
}

export async function cycleById(blockId: string, cycleId: number, sql?: Sql): Promise<CycleRow> {
  const db = sql ?? (await getSql());
  const rows = await db`select * from cycles where block_id = ${blockId} and id = ${cycleId}`;
  if (!rows[0]) throw new Error(`Cycle ${cycleId} not found for ${blockId}.`);
  return toCycleRow(rows[0]);
}

export async function loadCycleData(blockId: string, cycleId: number): Promise<CycleData> {
  const sql = await getSql();
  const [c] = await sql`select * from cycles where block_id = ${blockId} and id = ${cycleId}`;
  if (!c) throw new Error(`Cycle ${cycleId} not found for ${blockId}.`);
  const schools = await sql`select * from schools where cycle_id = ${cycleId} order by cluster, name_en`;
  const issues = await sql`select * from issues where cycle_id = ${cycleId} order by seq`;
  const gaps = await sql`select * from gaps where cycle_id = ${cycleId} order by claude_rank, code_rank`;
  const ranked = gaps.map(toGap);
  const all = issues.map(toIssue);
  const cycle: CycleData["cycle"] = {
    files: c.files as Cycle["files"],
    r4Files: c.r4_files as Cycle["r4Files"],
    problems: all.filter((i) => i.category === "data_problem"),
    fixes: all.filter((i) => i.category === "auto_fixed"),
    headerMaps: c.header_maps as Cycle["headerMaps"],
    schools: schools.map(toSchool),
    flags: c.flags as Cycle["flags"],
    // Ranks 1-5 are the core gaps everything else reads; 6-15 are the Top 10 / Top 15 watchlist.
    gaps: ranked.filter((g) => g.codeRank <= DEFAULT_TOP_GAPS_LIMIT),
    allRankedGaps: ranked,
    peers: c.peers as Cycle["peers"],
    peer: c.peer as Cycle["peer"],
    detectedStateCode: (c.detected_state_code as Cycle["detectedStateCode"]) ?? "MP",
    thresholds: (c.thresholds as Cycle["thresholds"] | null) ?? undefined,
    summary: c.summary as Cycle["summary"],
    briefInput: c.brief_input as CycleData["cycle"]["briefInput"],
    briefEn: c.brief_en as string,
    briefHi: c.brief_hi as string,
    people: c.people as Person[],
    contractErrors: c.contract_errors as string[],
  };
  return { cycleId, blockId, isSeed: c.source === "seed", prepSeconds: Number(c.prep_seconds), cycle };
}

export async function loadTasks(cycleId: number, sql?: Sql): Promise<TaskRow[]> {
  const db = sql ?? (await getSql());
  const rows = await db`select * from tasks where cycle_id = ${cycleId} order by task_no`;
  return rows.map(toTask);
}

export async function loadSchools(cycleId: number, sql?: Sql): Promise<SchoolRow[]> {
  const db = sql ?? (await getSql());
  return (await db`select * from schools where cycle_id = ${cycleId} order by cluster, name_en`).map(toSchool);
}

export async function loadLive(blockId: string, cycleId: number): Promise<Omit<LiveData, keyof LiveExtras>> {
  const sql = await getSql();
  const c = await cycleById(blockId, cycleId, sql);
  const tasks = await loadTasks(cycleId, sql);
  const msgs = await sql`
    select m.id, m.direction, m.text, m.text_copy, m.parsed, t.task_no
    from messages m left join tasks t on t.id = m.task_id
    where m.block_id = ${blockId} and m.cycle_id = ${cycleId}
    order by m.id`;
  const [snap] = await sql`select data from scorecard_snapshots where cycle_id = ${cycleId} order by id desc limit 1`;
  const calls = await sql`select * from llm_calls where block_id = ${blockId} and cycle_id = ${cycleId} order by id`;
  const hinges = await sql`
    select id, code, pivot_id, officer_role, created_at, summary, changes
    from hinge_decisions where block_id = ${blockId} and cycle_id = ${cycleId}
    order by id`;
  return {
    cycleId,
    simToday: clockToday(c),
    r4Loaded: c.r4Loaded,
    tasks: tasks.map(({ dbId: _dbId, ...t }) => t),
    messages: msgs.map(
      (m): ChatMsg => ({
        id: `msg-${m.id}`,
        taskId: m.task_no === null || m.task_no === undefined ? null : Number(m.task_no),
        direction: m.direction as ChatMsg["direction"],
        text: m.text as string,
        ...(m.text_copy ? { textCopy: m.text_copy as ChatMsg["textCopy"] } : {}),
        ...(m.parsed ? { parsed: m.parsed as ChatMsg["parsed"] } : {}),
      }),
    ),
    // Shown once Round 4 is joined, as before; snapshots are written on every status change.
    scorecard: c.r4Loaded && snap ? (snap.data as Scorecard) : null,
    hingeDecisions: hinges.map(
      (h): HingeDecision => ({
        id: `hinge-${h.id}`,
        code: h.code as HingeDecision["code"],
        pivotId: h.pivot_id as HingeDecision["pivotId"],
        role: h.officer_role as HingeDecision["role"],
        at: String(h.created_at),
        summary: h.summary as HingeDecision["summary"],
        changes: (h.changes ?? []) as HingeDecision["changes"],
      }),
    ),
    llmCalls: calls.map(
      (r): LlmCall => ({
        id: `llm-${r.id}`,
        purpose: r.purpose as string,
        model: r.model as string,
        tokensIn: Number(r.tokens_in),
        tokensOut: Number(r.tokens_out),
        inr: Number(r.inr),
        passed: Boolean(r.passed),
        simulated: Boolean(r.simulated),
        note: r.note as string,
      }),
    ),
    bot: {
      live: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      username: process.env.TELEGRAM_BOT_USERNAME?.trim() || "SamikshaSaathiBot",
    },
  };
}

export async function insertMessage(
  sql: Sql,
  m: {
    blockId: string;
    requestId: string;
    cycleId: number | null;
    taskDbId?: number | null;
    direction: "in" | "out" | "sys";
    kind: "card" | "nudge" | "reply" | "system" | "command";
    channel: "telegram" | "web" | "whatsapp";
    personId?: string | null;
    chatId?: string | null;
    text: string;
    textCopy?: { en: string; hi: string };
    parsed?: unknown;
    parseSource?: string | null;
  },
): Promise<boolean> {
  const rows = await sql`
    insert into messages (block_id, client_request_id, cycle_id, task_id, direction, kind, channel, person_id, chat_id, text, text_copy, parsed, parse_source)
    values (${m.blockId}, ${m.requestId}, ${m.cycleId}, ${m.taskDbId ?? null}, ${m.direction}, ${m.kind}, ${m.channel},
            ${m.personId ?? null}, ${m.chatId ?? null}, ${m.text}, ${m.textCopy ? JSON.stringify(m.textCopy) : null}::jsonb, ${m.parsed === undefined ? null : JSON.stringify(m.parsed)}::jsonb, ${m.parseSource ?? null})
    on conflict (block_id, client_request_id) do nothing
    returning id`;
  return rows.length > 0;
}

export async function insertLlmCall(
  sql: Sql,
  c: {
    blockId: string;
    requestId: string;
    cycleId: number | null;
    purpose: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    passed: boolean;
    simulated: boolean;
    billable: boolean;
    note: string;
    detail?: unknown;
    /** A cost the caller already knows (speech-to-text by the hour); otherwise priced from tokens. */
    inr?: number;
  },
) {
  const inr = c.inr ?? (c.billable || c.simulated ? estimateCallCost(c.tokensIn, c.tokensOut, c.model).inr : 0);
  await sql`
    insert into llm_calls (block_id, client_request_id, cycle_id, purpose, model, tokens_in, tokens_out, inr, passed, simulated, billable, note, detail)
    values (${c.blockId}, ${c.requestId}, ${c.cycleId}, ${c.purpose}, ${c.model}, ${c.tokensIn}, ${c.tokensOut}, ${inr},
            ${c.passed}, ${c.simulated}, ${c.billable}, ${c.note}, ${c.detail === undefined ? null : JSON.stringify(c.detail)}::jsonb)
    on conflict (block_id, client_request_id) do nothing`;
}

/** Ledger row for code that produced text without a model (token estimate, like the original ledger). */
export function simulatedCall(text: string) {
  return {
    model: "code-template",
    tokensIn: Math.max(40, Math.round(text.length / 4)),
    tokensOut: Math.max(30, Math.round(text.length / 8)),
    simulated: true,
    billable: false,
    note: "Simulated ledger row. No live model call.",
  };
}

/** Recompute the scorecard from the DB and append a snapshot. */
export async function snapshotScorecard(sql: Sql, blockId: string, cycleId: number, requestId: string) {
  const c = await cycleById(blockId, cycleId, sql);
  const gaps = await sql<{ id: string }>`select gap_id as id from gaps where cycle_id = ${cycleId} and code_rank <= ${DEFAULT_TOP_GAPS_LIMIT}`;
  const scorecard = buildScorecard(await loadSchools(cycleId, sql), await loadTasks(cycleId, sql), c.people, c.prepSeconds, gaps);
  await sql`
    insert into scorecard_snapshots (block_id, client_request_id, cycle_id, approved, closed_on_time, closure_pct, data)
    values (${blockId}, ${requestId}, ${cycleId}, ${scorecard.approved}, ${scorecard.closedOnTime}, ${scorecard.closurePct}, ${JSON.stringify(scorecard)}::jsonb)
    on conflict (block_id, client_request_id) do nothing`;
  return scorecard;
}
