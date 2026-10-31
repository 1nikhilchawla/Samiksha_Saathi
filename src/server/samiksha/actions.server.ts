import { randomUUID } from "node:crypto";
/**
 * Cycle operations shared by the web tabs and the Telegram bot. Every write is
 * scoped by block_id and keyed by a client_request_id so retries are no-ops.
 * Every officer action takes the acting role, checks it first
 * (assertRolePermission) and declares it to the database for the transaction,
 * where the tasks_role_guard trigger checks it again (migration 0007).
 * Outbound delivery (cards, nudges) lives in server/bot/telegram.ts.
 */
import { getSql, withTransaction, type Sql } from "@/lib/db";
import {
  ACTION_LIBRARY,
  DEMO_TRANSCRIPT,
  EDITABLE_THRESHOLDS,
  type EditableThreshold,
  DEMO_TRANSCRIPT_EN,
  HINGE_PIVOT_IDS,
  REPLY_OPEN_STATUSES,
  ROLE_LEVEL,
  applyCleaningAst,
  approveBlockers,
  assertOfficerPermission,
  officerOf,
  WATCHLIST_GAP_PREFIX,
  WATCHLIST_TASK_NO_FROM,
  canonicalFieldTasks,
  checkWatchlistDraft,
  executeHingePivot,
  isWatchlistGap,
  extractCustomTasks,
  extractTasks,
  formatTaskCard,
  mergeR4,
  parseFieldReply,
  sanitizeCleaningAst,
  watchlistDraft,
  type ActionId,
  type ActingOfficer,
  type HingePivotId,
  type OfficerRole,
  type Scorecard,
  type Task,
  scanPromptInjection,
} from "@/lib/samiksha/engine";
import { REPLY_PARSE_MONTHLY_LIMIT, parseFieldReplyAudited, type ParseAudit } from "@/lib/samiksha/parseReply";
import { copy, type ActionResult, type Copy, type CycleData, type Lang } from "@/lib/samiksha/types";
import { STATUS_LABEL, fieldList, label } from "@/lib/samiksha/labels";
import {
  clockToday,
  cycleById,
  insertLlmCall,
  insertMessage,
  istToday,
  latestCycle,
  loadCycleData,
  loadSchools,
  loadTasks,
  simulatedCall,
  snapshotScorecard,
  stableUuid,
  type TaskRow,
} from "./repo.server";
import { NOTE_EXTRACT_MONTHLY_LIMIT, extractTasksWithModel } from "./extractLlm.server";
import { runCycle } from "./runPipeline.server";

const ok = (gate: Copy | null): ActionResult => ({ ok: true, gate });
/**
 * Who is acting. A signed session (the browser's path) or a bare role (the
 * unit tests and the bot flow script, which call these functions directly).
 */
type Who = OfficerRole | ActingOfficer;

const refuse = (gate: Copy): ActionResult => ({ ok: false, gate });

/**
 * Tell the database which officer this transaction acts as.
 *
 * The block, the role, the person and the cluster are all declared, so the
 * database can check the transaction against the session it came from. The
 * tasks trigger and the role guard read these settings back.
 */
async function actAs(sql: Sql, who: Who, blockId?: string) {
  const officer = officerOf(who);
  await sql`select set_config('app.current_role', ${officer.role}, true)`;
  await sql`select set_config('app.current_person_id', ${officer.personId}, true)`;
  await sql`select set_config('app.current_cluster', ${officer.cluster ?? "ALL"}, true)`;
  if (blockId) await sql`select set_config('app.block_id', ${blockId}, true)`;
  await sql`select samiksha_assert_scope()`;
}

/** The block's current cycle; a first visit builds it from the seeded files. */
export async function ensureCycle(blockId: string): Promise<number> {
  const c = await latestCycle(blockId);
  if (c) return c.id;
  return (await runCycle({ blockId, clientRequestId: stableUuid(blockId, "bootstrap-seed") })).cycleId;
}

async function taskBlockers(blockId: string, cycleId: number, task: Task, sql: Sql): Promise<string[]> {
  const blockers = approveBlockers(task);
  const [gap] = await sql`select allowed_actions from gaps where block_id = ${blockId} and cycle_id = ${cycleId} and gap_id = ${task.gapId}`;
  if (gap && !(gap.allowed_actions as string[]).includes(task.actionId)) blockers.push("action_not_in_library_for_gap");
  return blockers;
}

export async function writeTask(sql: Sql, t: TaskRow) {
  await sql`
    update tasks set action_id = ${t.actionId}, what_en = ${t.whatEn}, what_hi = ${t.whatHi}, owner_id = ${t.ownerId},
      due_date = ${t.dueDate}, success_en = ${t.successEn}, success_hi = ${t.successHi}, status = ${t.status},
      missing_fields = ${JSON.stringify(t.missingFields)}::jsonb, approved_by = ${t.approvedBy}, approved_at = ${t.approvedAt},
      completed_at = ${t.completedAt}, units_done = ${t.unitsDone}, note = ${t.note}, note_hi = ${t.noteHi},
      approved_as_level = ${t.approvedAsLevel ?? null}, approved_by_person_id = ${t.approvedByPersonId ?? null},
      approved_is_override = ${t.approvedIsOverride ?? false}, updated_at = now()
    where id = ${t.dbId}`;
}

async function insertTasks(sql: Sql, blockId: string, cycleId: number, requestId: string, tasks: Task[]) {
  await sql`
    insert into tasks (block_id, client_request_id, cycle_id, task_no, gap_id, action_id, what_en, what_hi, owner_id,
      target_label, target_label_hi, target_codes, due_date, success_en, success_hi, status, missing_fields,
      approved_by, approved_at, completed_at, units_done, note, note_hi)
    select ${blockId}, x.crid, ${cycleId}, x.id, x."gapId", x."actionId", x."whatEn", x."whatHi", x."ownerId",
      x."targetLabel", x."targetLabelHi", x."targetCodes", x."dueDate", x."successEn", x."successHi", x.status,
      x."missingFields", x."approvedBy", x."approvedAt", x."completedAt", x."unitsDone", x.note, x."noteHi"
    from jsonb_to_recordset(${JSON.stringify(tasks.map((t) => ({ ...t, crid: stableUuid(requestId, "task", t.id) })))}::jsonb)
      as x(crid uuid, id int, "gapId" text, "actionId" text, "whatEn" text, "whatHi" text, "ownerId" text,
           "targetLabel" text, "targetLabelHi" text, "targetCodes" jsonb, "dueDate" date, "successEn" text, "successHi" text,
           status text, "missingFields" jsonb, "approvedBy" text, "approvedAt" timestamptz, "completedAt" date,
           "unitsDone" int, note text, "noteHi" text)
    on conflict (block_id, client_request_id) do nothing`;
}

type NoteRead = {
  tasks: Task[];
  passed: boolean;
  ledger: { model: string; tokensIn: number; tokensOut: number; simulated: boolean; billable: boolean; note: string };
};

/**
 * Reads a note, cheapest first: the seeded demo note by its own rules, then roster
 * rules (any school or cluster, any date), then the bounded model when a key is set,
 * then the demo keyword rules. The ledger row says which one read it.
 */
async function readNote(blockId: string, text: string, cycle: CycleData["cycle"]): Promise<NoteRead> {
  const byRules = (tasks: Task[], note: string): NoteRead => ({ tasks, passed: true, ledger: { ...simulatedCall(text), note } });
  if (text === DEMO_TRANSCRIPT || text === DEMO_TRANSCRIPT_EN) return byRules(extractTasks(text, cycle), "Seeded demo note, read by its rules. No model call.");
  const custom = extractCustomTasks(text, cycle);
  if (custom.length) return byRules(custom, "Read by roster rules. No model call.");
  const sql = await getSql();
  const [usage] = await sql<{ n: number }>`
    select count(*)::int as n from llm_calls
    where block_id = ${blockId} and purpose = 'voice_to_tasks' and billable
      and created_at >= (${istToday().slice(0, 7) + "-01"}::date - interval '330 minutes')`;
  // The note goes to the model only after any instruction in it is cut out; the cut is logged for /why.
  const { logPromptInjection } = await import("./diagnostics.server");
  await logPromptInjection(sql, blockId, null, "review note", scanPromptInjection(text).detections, randomUUID());
  const model = await extractTasksWithModel(text, cycle, NOTE_EXTRACT_MONTHLY_LIMIT - Number(usage?.n ?? 0)).catch((err: unknown) => ({
    tasks: [] as Task[], model: "unavailable", tokensIn: 0, tokensOut: 0, billable: false, note: err instanceof Error ? err.message : "Model call failed.",
  }));
  const ledger = (m: NonNullable<typeof model>, note: string) => ({ model: m.model, tokensIn: m.tokensIn, tokensOut: m.tokensOut, simulated: false, billable: m.billable, note });
  if (model?.tasks.length) return { tasks: model.tasks, passed: true, ledger: ledger(model, model.note) };
  const legacy = extractTasks(text, cycle);
  if (model) return { tasks: legacy, passed: false, ledger: ledger(model, `${model.note} Fell back to keyword rules.`) };
  return byRules(legacy, "Read by keyword rules; the AI co-pilot is not available right now.");
}

/**
 * Voice note / typed note -> draft tasks. The note's drafts are replaced; watchlist
 * drafts from the brief and decided tasks stay, and are not drafted twice.
 */
export async function extractDrafts(blockId: string, cycleId: number, transcript: string, requestId: string, role: Who): Promise<ActionResult & { count: number }> {
  assertOfficerPermission(role, "record_note");
  const text = transcript.trim().slice(0, 4000);
  if (!text) return { ...refuse(copy("The note is empty.", "नोट खाली है।")), count: 0 };
  const data = await loadCycleData(blockId, cycleId);
  const ledgerId = stableUuid(requestId, "llm");
  const sql = await getSql();
  const [applied] = await sql`select 1 from llm_calls where block_id = ${blockId} and client_request_id = ${ledgerId}`;
  if (applied) return { ...ok(null), count: (await loadTasks(cycleId, sql)).filter((t) => t.status === "draft").length };
  // The model call (if any) runs before the transaction, so no connection is held open over the network.
  const read = await readNote(blockId, text, data.cycle);
  return withTransaction(async (tx) => {
    const existing = await loadTasks(cycleId, tx);
    const kept = existing.filter((t) => t.status !== "draft" || isWatchlistGap({ id: t.gapId }));
    // Watchlist tasks (#101 on) do not move the note's numbering; a number already taken is skipped.
    const own = kept.filter((t) => !isWatchlistGap({ id: t.gapId }));
    const used = new Set(kept.map((t) => t.id));
    let next = own.reduce((m, t) => Math.max(m, t.id), 13);
    const key = (t: Task) => `${t.actionId}|${[...t.targetCodes].sort().join(",")}`;
    const decided = new Set(kept.filter((t) => t.status !== "rejected" && t.status !== "cancelled").map(key));
    const fresh = read.tasks.filter((t) => !decided.has(key(t))).map((t) => {
      let id = t.id;
      if (own.length || used.has(id)) {
        do next += 1;
        while (used.has(next));
        id = next;
      }
      used.add(id);
      return { ...t, id };
    });
    await tx`delete from tasks where block_id = ${blockId} and cycle_id = ${cycleId} and status = 'draft' and gap_id not like ${WATCHLIST_GAP_PREFIX + "%"}`;
    await insertTasks(tx, blockId, cycleId, requestId, fresh);
    // Written last, so its presence means this request already landed.
    await insertLlmCall(tx, { blockId, requestId: ledgerId, cycleId, purpose: "voice_to_tasks", passed: read.passed, ...read.ledger });
    return { ...ok(null), count: fresh.length };
  });
}

/**
 * One draft task for a watchlist gap (ranks 6-15), from the brief's Top 10 / Top 15
 * list. Owner and due date start empty, so approval stays locked until the officer
 * sets them. A comparison school waits for Round 4.
 */
export async function draftWatchlistGap(blockId: string, cycleId: number, gapId: string, requestId: string, role: Who): Promise<ActionResult & { taskNo: number | null }> {
  assertOfficerPermission(role, "record_note");
  const data = await loadCycleData(blockId, cycleId);
  const gap = data.cycle.allRankedGaps.find((g) => g.id === gapId);
  if (!gap) throw new Error("Unknown gap.");
  return withTransaction(async (sql) => {
    await actAs(sql, role, blockId);
    const c = await cycleById(blockId, cycleId, sql);
    const existing = await loadTasks(cycleId, sql);
    const check = checkWatchlistDraft(gap, existing, c.r4Loaded);
    if (!check.ok) {
      const reason = copy(check.reason.en, check.reason.hi);
      return { ...(check.existing ? ok(reason) : refuse(reason)), taskNo: check.existing };
    }
    const taskNo = existing.reduce((m, t) => Math.max(m, t.id), WATCHLIST_TASK_NO_FROM - 1) + 1;
    await insertTasks(sql, blockId, cycleId, requestId, [watchlistDraft(gap, taskNo)]);
    return {
      ...ok(copy(
        `Draft task #${taskNo} added for ${gap.targetLabel}. Set the owner and due date in Stage 3 before approval.`,
        `${gap.targetLabelHi} के लिए ड्राफ्ट कार्य #${taskNo} जोड़ा। अनुमोदन से पहले चरण 3 में जिम्मेदार और अंतिम तिथि भरें।`,
      )),
      taskNo,
    };
  });
}

type Editable = Partial<Pick<Task, "actionId" | "ownerId" | "dueDate" | "successEn" | "successHi" | "whatEn" | "whatHi">>;

export async function updateTask(blockId: string, cycleId: number, taskNo: number, patch: Editable, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "edit_task");
  const c = await cycleById(blockId, cycleId);
  if (patch.actionId !== undefined && !(patch.actionId in ACTION_LIBRARY)) throw new Error("Unknown action id.");
  if (patch.ownerId !== undefined && patch.ownerId !== null && !c.people.some((p) => p.id === patch.ownerId)) throw new Error("Unknown owner.");
  if (patch.dueDate !== undefined && patch.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) throw new Error("Bad due date.");
  for (const k of ["successEn", "successHi", "whatEn", "whatHi"] as const) {
    if (patch[k] !== undefined && (typeof patch[k] !== "string" || patch[k]!.length > 500)) throw new Error(`Bad ${k}.`);
  }
  return withTransaction(async (sql) => {
    await actAs(sql, role, blockId);
    const task = (await loadTasks(cycleId, sql)).find((t) => t.id === taskNo);
    if (!task) throw new Error(`Task #${taskNo} not found.`);
    const next: TaskRow = { ...task, ...patch };
    next.missingFields = await taskBlockers(blockId, cycleId, next, sql);
    // An edit that breaks guardrail (c) sends the task back for approval.
    if (next.missingFields.length && !["draft", "rejected", "cancelled"].includes(next.status)) {
      Object.assign(next, { status: "draft", approvedBy: null, approvedAt: null });
    }
    await writeTask(sql, next);
    return ok(null);
  });
}

export async function approveTask(blockId: string, cycleId: number, taskNo: number, role: Who): Promise<ActionResult> {
  const { officer, isSupervisoryOverride } = assertOfficerPermission(role, "approve_task");
  const approver = officer.role.toLowerCase();
  return withTransaction(async (sql) => {
    await actAs(sql, officer, blockId);
    const task = (await loadTasks(cycleId, sql)).find((t) => t.id === taskNo);
    if (!task) throw new Error(`Task #${taskNo} not found.`);
    const blockers = await taskBlockers(blockId, cycleId, task, sql);
    if (blockers.length) {
      return refuse(copy(`Task #${taskNo} cannot be approved. Missing: ${blockers.join(", ")}.`, `कार्य #${taskNo} अनुमोदित नहीं हो सकता। अधूरी जानकारी: ${fieldList(blockers, "hi")}।`));
    }
    if (task.status !== "draft") return ok(copy(`Task #${taskNo} is already ${task.status}.`, `कार्य #${taskNo} पहले से ${label(STATUS_LABEL, task.status, "hi")} है।`));
    await writeTask(sql, {
      ...task,
      status: "approved",
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
      missingFields: [],
      approvedAsLevel: ROLE_LEVEL[officer.role],
      approvedByPersonId: officer.personId,
      approvedIsOverride: isSupervisoryOverride,
    });
    return ok(copy(`Task #${taskNo} approved. It is still not sent.`, `कार्य #${taskNo} अनुमोदित। अभी भेजा नहीं गया।`));
  });
}

/** Approve every draft whose owner, date and success measure are complete; the rest stay locked. */
export async function approveAllReady(blockId: string, cycleId: number, role: Who): Promise<ActionResult> {
  const { officer, isSupervisoryOverride } = assertOfficerPermission(role, "approve_task");
  return withTransaction(async (sql) => {
    await actAs(sql, officer, blockId);
    let approved = 0;
    let locked = 0;
    for (const task of (await loadTasks(cycleId, sql)).filter((t) => t.status === "draft")) {
      if ((await taskBlockers(blockId, cycleId, task, sql)).length) {
        locked += 1;
        continue;
      }
      await writeTask(sql, {
        ...task,
        status: "approved",
        approvedBy: officer.role.toLowerCase(),
        approvedAt: new Date().toISOString(),
        missingFields: [],
        approvedAsLevel: ROLE_LEVEL[officer.role],
        approvedByPersonId: officer.personId,
        approvedIsOverride: isSupervisoryOverride,
      });
      approved += 1;
    }
    return ok(copy(
      `${approved} complete draft${approved === 1 ? "" : "s"} approved. ${locked} still locked. Nothing is sent yet.`,
      `${approved} पूर्ण ड्राफ्ट अनुमोदित। ${locked} अभी रुके हैं। अभी कुछ नहीं भेजा गया।`,
    ));
  });
}

export async function rejectTask(blockId: string, cycleId: number, taskNo: number, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "approve_task");
  const sql = await getSql();
  await sql`update tasks set status = 'rejected', approved_by = null, approved_at = null, updated_at = now()
            where block_id = ${blockId} and cycle_id = ${cycleId} and task_no = ${taskNo} and status in ('draft', 'approved')`;
  return ok(copy(`Task #${taskNo} rejected. The bot cannot see it.`, `कार्य #${taskNo} अस्वीकृत। बॉट इसे नहीं देख सकता।`));
}

export async function restoreTask(blockId: string, cycleId: number, taskNo: number, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "approve_task");
  const sql = await getSql();
  await sql`update tasks set status = 'draft', updated_at = now()
            where block_id = ${blockId} and cycle_id = ${cycleId} and task_no = ${taskNo} and status = 'rejected'`;
  return ok(null);
}

/** The DEO line in the thread when a task is escalated. */
async function escalationNote(sql: Sql, input: { blockId: string; cycleId: number; requestId: string; task: TaskRow; deo: CycleData["cycle"]["people"][number] | undefined; lang: Lang }) {
  const { blockId, cycleId, requestId, task, deo, lang } = input;
  const c = {
    en: `Task #${task.id} escalated to DEO ${deo?.nameEn ?? ""}. A block officer cannot close a vacancy alone.`,
    hi: `कार्य #${task.id} DEO ${deo?.nameHi ?? ""} को अग्रेषित। ब्लॉक अधिकारी अकेले रिक्ति बंद नहीं कर सकते।`,
  };
  await insertMessage(sql, { blockId, requestId, cycleId, taskDbId: task.dbId, direction: "sys", kind: "system", channel: "web", text: c[lang], textCopy: c });
}

export async function escalateTask(blockId: string, cycleId: number, taskNo: number, lang: Lang, requestId: string, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "escalate_to_deo");
  const c = await cycleById(blockId, cycleId);
  const deo = c.people.find((p) => p.role === "DEO");
  return withTransaction(async (sql) => {
    await actAs(sql, role, blockId);
    const task = (await loadTasks(cycleId, sql)).find((t) => t.id === taskNo);
    if (!task || ["draft", "rejected", "cancelled"].includes(task.status)) {
      return refuse(copy(`Task #${taskNo} has not been sent, so it cannot be escalated.`, `कार्य #${taskNo} भेजा नहीं गया, इसलिए अग्रेषित नहीं हो सकता।`));
    }
    await writeTask(sql, { ...task, status: "escalated" });
    await escalationNote(sql, { blockId, cycleId, requestId, task, deo, lang });
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(requestId, "score"));
    return ok(null);
  });
}

const VACANCY_OPEN = new Set(["approved", "sent", "reminded", "partial", "blocked", "overdue", "escalated"]);

/** The DEO records the post filled (or the temporary arrangement made). Only a DEO may close a vacancy task. */
export async function resolveVacancy(blockId: string, cycleId: number, taskNo: number, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "resolve_vacancy");
  const c = await cycleById(blockId, cycleId);
  const today = clockToday(c);
  return withTransaction(async (sql) => {
    await actAs(sql, role, blockId);
    const task = (await loadTasks(cycleId, sql)).find((t) => t.id === taskNo);
    if (!task || task.actionId !== "vacancy") return refuse(copy(`Task #${taskNo} is not a vacancy task.`, `कार्य #${taskNo} रिक्ति कार्य नहीं है।`));
    if (!VACANCY_OPEN.has(task.status)) return refuse(copy(`Task #${taskNo} is ${task.status}, so it cannot be closed.`, `कार्य #${taskNo} ${label(STATUS_LABEL, task.status, "hi")} है, इसलिए बंद नहीं हो सकता।`));
    await writeTask(sql, {
      ...task, status: "done", completedAt: today, unitsDone: task.targetCodes.length,
      note: `${task.note} Closed by the DEO on ${today}.`.trim(), noteHi: `${task.noteHi} DEO ने ${today} को बंद किया।`.trim(),
    });
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(blockId, "vacancy-closed", cycleId, taskNo));
    return ok(copy(`Task #${taskNo} closed by the DEO: post filled or arrangement made.`, `कार्य #${taskNo} DEO ने बंद किया: पद भरा या व्यवस्था हुई।`));
  });
}

/**
 * Execute one hinge pivot: re-derive the hinge point from the database, apply
 * executeHingePivot's task changes, write the decision record, and return the
 * escalated task numbers so the caller can tell the DEO on Telegram.
 */
export async function executeHingePivotAction(
  blockId: string,
  cycleId: number,
  pivotId: HingePivotId,
  role: Who,
  lang: Lang,
  requestId: string,
): Promise<ActionResult & { escalated: number[] }> {
  if (!HINGE_PIVOT_IDS.includes(pivotId)) throw new Error("Unknown hinge pivot.");
  const pivotAction = pivotId === "PIVOT_ESCALATE_SLA_BREACH_TO_DEO" ? "escalate_to_deo" : pivotId === "PIVOT_COMPLETE_TASK_GOVERNANCE_FIELDS" || pivotId === "PIVOT_INVALIDATE_BOX_TICK_AND_SPAWN_AUDIT" ? "edit_task" : "approve_task";
  const { isSupervisoryOverride } = assertOfficerPermission(role, pivotAction);
  const data = await loadCycleData(blockId, cycleId);
  const recordId = stableUuid(requestId, "hinge");
  return withTransaction(async (sql) => {
    const [seen] = await sql`select 1 from hinge_decisions where block_id = ${blockId} and client_request_id = ${recordId}`;
    if (seen) return { ...ok(null), escalated: [] };
    await actAs(sql, role, blockId);
    const c = await cycleById(blockId, cycleId, sql);
    const rows = await loadTasks(cycleId, sql);
    const [snap] = await sql`select data from scorecard_snapshots where cycle_id = ${cycleId} order by id desc limit 1`;
    const score = c.r4Loaded && snap ? (snap.data as Scorecard) : null;
    const result = executeHingePivot(pivotId, { cycle: data.cycle, tasks: rows, score, simToday: clockToday(c), role: officerOf(role).role });
    if (!result.ok) return { ...refuse(result.reason), escalated: [] };
    const byNo = new Map(rows.map((r) => [r.id, r]));
    const deo = data.cycle.people.find((p) => p.role === "DEO");
    for (const t of result.changed) {
      const row: TaskRow = { ...t, dbId: byNo.get(t.id)!.dbId };
      await writeTask(sql, row);
      if (result.escalated.includes(t.id)) await escalationNote(sql, { blockId, cycleId, requestId: stableUuid(requestId, "escalate", t.id), task: row, deo, lang });
    }
    if (result.created.length) await insertTasks(sql, blockId, cycleId, requestId, result.created);
    const r = result.record;
    const officer = officerOf(role);
    await sql`
      insert into hinge_decisions (block_id, client_request_id, cycle_id, code, pivot_id, officer_role, summary, changes,
        is_supervisory_override, acted_as_level, actor_person_id)
      values (${blockId}, ${recordId}, ${cycleId}, ${r.code}, ${r.pivotId}, ${r.role}, ${JSON.stringify(r.summary)}::jsonb, ${JSON.stringify(r.changes)}::jsonb,
        ${isSupervisoryOverride}, ${ROLE_LEVEL[officer.role]}, ${officer.personId})`;
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(requestId, "score"));
    const list = (l: Lang) => r.changes.map((x) => x.what[l]).join(" · ");
    return {
      ...ok(copy(`${r.code} pivot done. ${list("en")}. Nothing is sent until the BEO sends it.`, `${r.code} निर्णय लागू। ${list("hi")}। BEO के भेजने तक कुछ नहीं जाता।`)),
      escalated: result.escalated,
    };
  });
}

const OVERDUE_DATE = "2025-12-23";

/**
 * The only school field a commit writes: the trimmed name. A cluster-mean fill or
 * a cap at 100 would store an invented number as if it were measured, so those
 * stay in the preview and its CSV.
 */
const COMMIT_COLUMNS = { nameEn: "name_en" } as const;
type CommitField = keyof typeof COMMIT_COLUMNS;

/**
 * Commit a cleaning rule to the cycle's school records. The browser sends only
 * the compiled rule (the AST); the server sanitises it, re-applies it to its own
 * copy of the schools, writes only trimmed names, and logs each value
 * before -> after in the issues table. Flags, fills and caps are not stored.
 */
export async function commitCleaningCopy(
  blockId: string,
  cycleId: number,
  rawAst: unknown,
  role: Who,
  requestId: string,
): Promise<ActionResult & { changed: number }> {
  assertOfficerPermission(role, "upload_block_files");
  const ast = sanitizeCleaningAst(rawAst);
  return withTransaction(async (sql) => {
    const [seen] = await sql`select 1 from issues where block_id = ${blockId} and client_request_id = ${stableUuid(requestId, "clean", 0)}`;
    if (seen) return { ...ok(null), changed: 0 };
    await actAs(sql, role, blockId);
    const before = await loadSchools(cycleId, sql);
    const result = applyCleaningAst(ast, before, "rules");
    if (!result.understood) return { ...refuse(copy("The rule was not understood, so nothing was written.", "नियम समझ नहीं आया, इसलिए कुछ नहीं लिखा गया।")), changed: 0 };
    const writes = result.previewDiffs.filter((d) => d.field in COMMIT_COLUMNS);
    if (!writes.length) {
      return { ...ok(copy(
        "Nothing to write: only trimmed school names are written to the cycle. Flags, cluster-mean fills and caps stay in the preview and its CSV export.",
        "लिखने को कुछ नहीं: चक्र में केवल साफ किए गए विद्यालय नाम लिखे जाते हैं। चिह्न, क्लस्टर औसत से भरे मान और सीमा पूर्वावलोकन व CSV में रहते हैं।",
      )), changed: 0 };
    }
    const after = new Map(result.updatedSchools.map((s) => [s.code, s]));
    const [top] = await sql<{ last: number }>`select coalesce(max(seq), 0)::int as last from issues where cycle_id = ${cycleId}`;
    const first = Number(top?.last ?? 0) + 1;
    for (const [i, d] of writes.entries()) {
      const field = d.field as CommitField;
      // The column name comes from the fixed COMMIT_COLUMNS table, never from the request.
      await sql.query(`update schools set ${COMMIT_COLUMNS[field]} = $1 where cycle_id = $2 and code = $3`, [after.get(d.code)![field], cycleId, d.code]);
      await sql`
        insert into issues (block_id, client_request_id, cycle_id, seq, category, severity, issue_type, school_code,
          raw_value, fixed_value, source_file, source_row, description_en, description_hi)
        values (${blockId}, ${stableUuid(requestId, "clean", i)}, ${cycleId}, ${first + i}, 'auto_fixed', 'info',
          'cleaning_rule_committed', ${d.code}, ${`${field}: ${d.before}`}, ${`${field}: ${d.after}`}, 'cleaning_studio', ${i + 1},
          ${`${d.action.en}. ${result.ruleSummaryEn}`.slice(0, 500)}, ${`${d.action.hi}। ${result.ruleSummaryHi}`.slice(0, 500)})`;
    }
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(requestId, "score"));
    const n = new Set(writes.map((d) => d.code)).size;
    return {
      ...ok(copy(
        `Committed: ${writes.length} value${writes.length === 1 ? "" : "s"} in ${n} school${n === 1 ? "" : "s"} changed, each logged before and after. The brief still quotes the uploaded files; re-run the cycle from its files to undo.`,
        `कमिट: ${n} विद्यालयों में ${writes.length} मान बदले, हर एक पहले-बाद सहित दर्ज। ब्रीफ अब भी अपलोड की गई फाइलों पर है; पलटने के लिए फाइलों से चक्र फिर चलाएँ।`,
      )),
      changed: writes.length,
    };
  });
}
export async function jumpOverdue(blockId: string, cycleId: number, requestId: string): Promise<ActionResult> {
  await withTransaction(async (sql) => {
    await sql`update cycles set sim_today = ${OVERDUE_DATE} where block_id = ${blockId} and id = ${cycleId}`;
    await sql`update tasks set status = 'overdue', updated_at = now()
              where block_id = ${blockId} and cycle_id = ${cycleId} and due_date < ${OVERDUE_DATE}
                and status in ('sent', 'reminded', 'approved', 'partial', 'blocked')`;
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(requestId, "score"));
  });
  return ok(copy(
    "Clock moved to 23 Dec 2025. Tasks still open past their due date are overdue.",
    "घड़ी 23 दिसम्बर 2025 पर है। समय-सीमा के बाद खुले कार्य अतिदेय हैं।",
  ));
}

/** Join Round 4. A cycle with no tasks yet seats the seeded field cycle (demo); existing tasks are scored and never deleted. */
export async function closeLoop(blockId: string, cycleId: number, lang: Lang, requestId: string, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, "upload_block_files");
  const data = await loadCycleData(blockId, cycleId);
  return withTransaction(async (sql) => {
    await actAs(sql, role, blockId);
    const merged = mergeR4(await loadSchools(cycleId, sql), data.cycle.r4Files);
    await sql`
      update schools s set r4 = x.r4, dec_att = x."decAtt"
      from jsonb_to_recordset(${JSON.stringify(merged.map((s) => ({ code: s.code, r4: s.r4, decAtt: s.decAtt })))}::jsonb)
        as x(code text, r4 float8, "decAtt" float8)
      where s.cycle_id = ${cycleId} and s.code = x.code`;
    await sql`update cycles set r4_loaded = true where block_id = ${blockId} and id = ${cycleId}`;
    const tasks = await loadTasks(cycleId, sql);
    let gate: Copy;
    if (!tasks.length) {
      const seeded = canonicalFieldTasks({ ...data.cycle, schools: merged });
      await insertTasks(sql, blockId, cycleId, requestId, seeded);
      const rows = await loadTasks(cycleId, sql);
      for (const t of rows) {
        const owner = data.cycle.people.find((p) => p.id === t.ownerId);
        await insertMessage(sql, { blockId, requestId: stableUuid(requestId, "card", t.id), cycleId, taskDbId: t.dbId, direction: "out", kind: "card", channel: "web", personId: t.ownerId, text: formatTaskCard(t, owner, lang) });
      }
      const doneText = lang === "en" ? "Done sir" : "हो गया सर";
      const attendance = rows.find((t) => t.actionId === "attendance");
      await insertMessage(sql, { blockId, requestId: stableUuid(requestId, "reply"), cycleId, taskDbId: attendance?.dbId ?? null, direction: "in", kind: "reply", channel: "web", personId: attendance?.ownerId, text: doneText, parsed: parseFieldReply(doneText, { openTasks: 1, hasPhoto: false }), parseSource: "rules" });
      gate = copy(
        "Round 4 files joined. Closure is counted from the block's field cycle. The box-tick row is not a success.",
        "राउंड 4 फाइलें जुड़ गईं। समापन विकासखंड के फील्ड चक्र से गिना गया है। बॉक्स-टिक पंक्ति सफलता नहीं है।",
      );
    } else {
      gate = copy(
        "Round 4 files joined. Closure is counted from this cycle's tasks. The box-tick row is not a success.",
        "राउंड 4 फाइलें जुड़ गईं। समापन इस चक्र के कार्यों से गिना गया है। बॉक्स-टिक पंक्ति सफलता नहीं है।",
      );
    }
    await snapshotScorecard(sql, blockId, cycleId, stableUuid(requestId, "score"));
    return ok(gate);
  });
}

/** The brief's "inject 42%" test: the guardrail rejects it; the rejection is logged. */
export async function logGuardrailTest(blockId: string, cycleId: number, devanagari: boolean, requestId: string): Promise<ActionResult> {
  const extra = devanagari ? "औसत ४२% है।" : "The block average is 42%.";
  const sql = await getSql();
  await insertLlmCall(sql, { blockId, requestId, cycleId, purpose: "brief_generation", passed: false, ...simulatedCall(extra) });
  return ok(copy(`Rejected text: “${extra}”`, `अस्वीकृत पाठ: “${extra}”`));
}

export type ReplyOutcome = { ack: string; taskNo: number | null; audit: ParseAudit | null };

/**
 * Reply router core: find the task, parse (Laya -> LLM -> simulate), write the
 * messages row with its parse, move the task, snapshot the scorecard.
 */
export async function applyFieldReply(input: {
  blockId: string;
  personId: string;
  chatId: string | null;
  text: string;
  photo: boolean;
  requestId: string;
  /** Where the reply came in; Telegram unless said otherwise. */
  channel?: "telegram" | "whatsapp";
}): Promise<ReplyOutcome> {
  const channel = input.channel ?? "telegram";
  const { blockId, personId, photo, requestId } = input;
  // An instruction hidden in a reply is cut out before any reading of it, by rules or by the model.
  const screened = scanPromptInjection(input.text);
  const text = screened.sanitized;
  const hi = /[ऀ-ॿ]/.test(text);
  const c = await latestCycle(blockId);
  if (!c) return { ack: hi ? "अभी कोई समीक्षा चक्र नहीं है।" : "There is no review cycle yet.", taskNo: null, audit: null };

  const sql = await getSql();
  const [seen] = await sql`select 1 from messages where block_id = ${blockId} and client_request_id = ${requestId}`;
  if (seen) return { ack: "", taskNo: null, audit: null }; // a redelivered update

  const tasks = await loadTasks(c.id, sql);
  const open = tasks.filter((t) => REPLY_OPEN_STATUSES.includes(t.status) && t.ownerId === personId);
  // The task can be named ("task 14", "#14") or led by its number ("14 done").
  const named = text.match(/(?:#|task\s*#?|कार्य\s*#?)\s*(\d{1,4})/i) ?? text.match(/^\s*(\d{1,4})\b/);
  const target = named ? open.find((t) => t.id === Number(named[1])) : open.length === 1 ? open[0] : undefined;
  // When the number named a task, it is not part of the reply: "14 done" means
  // "task 14, done", not "fourteen schools done". The number is cut out before
  // the reply is read, so it cannot be mistaken for a count.
  // A reply may reach the model: an instruction in it is logged here and cut out in parseReply.
  const { logPromptInjection } = await import("./diagnostics.server");
  await logPromptInjection(sql, blockId, c.id, "field reply", screened.detections, requestId);
  const replyText =
    target && named && named.index !== undefined
      ? (text.slice(0, named.index) + " " + text.slice(named.index + named[0].length)).trim()
      : text;
  const [usage] = await sql<{ n: number }>`
    select count(*)::int as n from llm_calls
    where block_id = ${blockId} and purpose = 'reply_parse' and billable
      and created_at >= (${istToday().slice(0, 7) + "-01"}::date - interval '330 minutes')`;

  const audit = await parseFieldReplyAudited(
    {
      task_id: target?.id ?? null,
      action_id: (target?.actionId as ActionId | undefined) ?? null,
      what_en: target?.whatEn ?? "",
      target_label: target?.targetLabel ?? "",
      success_en: target?.successEn ?? "",
      success_hi: target?.successHi ?? "",
      units_total: Math.max(1, target?.targetCodes.length ?? 1),
      units_done: target?.unitsDone ?? 0,
      open_tasks: open.length,
      today: clockToday(c),
      llm_budget_left: REPLY_PARSE_MONTHLY_LIMIT - Number(usage?.n ?? 0),
      tasks: target ? tasks : undefined,
    },
    replyText,
    photo,
  );

  const p = audit.parse;
  let ack = "";
  await withTransaction(async (tx) => {
    for (const [i, a] of audit.attempts.entries()) {
      await insertLlmCall(tx, {
        blockId, requestId: stableUuid(requestId, "llm", i), cycleId: c.id,
        purpose: a.stage === "llm_retry" ? "reply_parse_retry" : a.stage === "simulate" ? "reply_simulate" : "reply_parse",
        model: a.model, tokensIn: a.tokensIn, tokensOut: a.tokensOut, passed: a.ok, simulated: false, billable: a.billable,
        note: a.reason.slice(0, 300), detail: { stage: a.stage },
      });
    }
    await insertMessage(tx, {
      blockId, requestId, cycleId: c.id, taskDbId: target?.dbId ?? null, direction: "in", kind: "reply", channel,
      personId, chatId: input.chatId, text: photo && !text.trim() ? "[photo]" : text, parsed: p, parseSource: audit.source,
    });
    if (audit.simulate && !audit.simulate.ok) {
      await insertMessage(tx, {
        blockId, requestId: stableUuid(requestId, "simulate"), cycleId: c.id, taskDbId: target?.dbId ?? null,
        direction: "sys", kind: "system", channel, text: audit.simulate.reasonEn,
        textCopy: { en: audit.simulate.reasonEn, hi: audit.simulate.reasonHi },
      });
    }
    if (!target || !audit.proposed) {
      ack = target || open.length
        ? ((hi ? p.follow_up_question_hi : p.follow_up_question_en) ?? (hi ? "कृपया कार्य संख्या लिखें।" : "Please write the task number."))
        : hi ? "आपके लिए कोई खुला कार्य उत्तर की प्रतीक्षा में नहीं है।" : "No open task is waiting for your reply.";
      return;
    }
    const { status, unitsDone, completedAt } = audit.proposed;
    await writeTask(tx, {
      ...target,
      status,
      unitsDone,
      completedAt: completedAt ?? target.completedAt,
      ...(status === "blocked" ? { note: p.reason_en, noteHi: p.reason_hi } : {}),
    });
    await snapshotScorecard(tx, blockId, c.id, stableUuid(requestId, "score"));
    const total = Math.max(1, target.targetCodes.length);
    ack = status === "done"
      ? (hi ? `कार्य #${target.id} पूर्ण दर्ज हुआ। धन्यवाद।` : `Task #${target.id} recorded as done. Thank you.`)
      : status === "partial"
        ? (hi ? `कार्य #${target.id} आंशिक दर्ज (${total} में से ${unitsDone} स्कूल)।` : `Task #${target.id} recorded as partly done (${unitsDone} of ${total} schools).`)
        : (hi ? `कार्य #${target.id} रुका दर्ज: ${p.reason_hi}` : `Task #${target.id} recorded as blocked: ${p.reason_en}`);
  });
  return { ack, taskNo: target?.id ?? null, audit };
}

/* ------------------------------------------------------------------ *
 * The CRCC's own rung, the DEO's transfer tool, and the SPD's
 * threshold editor. These are the powers the ladder used to advertise
 * without having.
 * ------------------------------------------------------------------ */

/** The CRCC logs what the cluster looks like this week. Level 2. */
export async function recordClusterObservation(blockId: string, cycleId: number, note: string, role: Who, requestId: string): Promise<ActionResult> {
  const { officer } = assertOfficerPermission(role, "record_cluster_observation");
  const text = note.trim().slice(0, 600);
  if (!text) return refuse(copy("The observation is empty.", "अवलोकन खाली है।"));
  const sql = await getSql();
  await sql`
    insert into messages (block_id, client_request_id, cycle_id, direction, kind, channel, text, text_copy, person_id)
    values (${blockId}, ${stableUuid(requestId, "obs")}, ${cycleId}, 'in', 'note', 'web', ${text},
      ${JSON.stringify({ en: text, hi: text })}::jsonb, ${officer.personId})`;
  return ok(copy(`Cluster observation recorded.`, `क्लस्टर अवलोकन दर्ज किया गया।`));
}

/** The CRCC nudges the schools of one cluster. Level 2. */
export async function sendClusterNudge(blockId: string, cycleId: number, cluster: string | null, role: Who, requestId: string): Promise<ActionResult & { queued: number }> {
  const { officer } = assertOfficerPermission(role, "send_cluster_nudge");
  const data = await loadCycleData(blockId, cycleId);
  const scope = officer.cluster ?? cluster ?? data.cycle.schools[0]?.cluster ?? null;
  if (!scope) return { ...refuse(copy("No cluster is in scope.", "कोई क्लस्टर निर्धारित नहीं है।")), queued: 0 };
  const schools = data.cycle.schools.filter((s) => s.cluster === scope);
  const sql = await getSql();
  let queued = 0;
  const { enqueueOutbound, factContext } = await import("../../../server/bot/queue");
  const ctx = await factContext(blockId, cycleId, sql);
  for (const school of schools) {
    const copyText = {
      en: `Cluster ${scope}: ${school.nameEn} — a numeracy check is due this week. Please share the Grade 3 attendance sheet.`,
      hi: `क्लस्टर ${scope}: ${school.nameHi} — इस सप्ताह संख्या ज्ञान जाँच करनी है। कृपया कक्षा 3 की उपस्थिति पत्रक भेजें।`,
    };
    await enqueueOutbound(
      sql,
      {
        blockId,
        requestId: stableUuid(requestId, "nudge", school.code),
        cycleId,
        kind: "nudge",
        personId: `hm-${school.code.toLowerCase()}`,
        chatId: "",
        text: copyText.en,
        textCopy: copyText,
      },
      ctx,
    );
    queued += 1;
  }
  return { ...ok(copy(`${queued} cluster nudges queued for ${scope}.`, `${scope} के लिए ${queued} क्लस्टर नुस्के कतार में हैं।`)), queued };
}

/**
 * The officer a cluster's work is handed to. They may be new: a CRCC who has
 * just taken over the cluster and is not on the roster yet.
 */
export type ActingOfficerRef = {
  id: string;
  nameEn: string;
  nameHi: string;
  role: OfficerRole;
  scope: string | null;
};

/** One bulk transfer, in the shape the client sends it. */
export type BulkReassignInput = {
  blockId: string;
  cycleId: number;
  /** The cluster, or the owner, the work is taken away from. */
  fromOwnerIdOrCluster: string | null;
  /** The officer the work goes to. */
  actingOfficer: ActingOfficerRef;
  /** Why the work is moving. It goes into the audit trail. */
  reason: string;
  /** Who is doing it. */
  role: Who;
  requestId: string;
};

/**
 * Move every open task of one cluster to another owner in a single step.
 *
 * The new owner may be an acting officer who is not on the roster yet, so the
 * server can add one. This is the mid-cycle transfer case: the old CRCC goes,
 * the new one arrives, and the block's work does not stall in a dead queue.
 *
 * Every moved task leaves a `bulk_reassigned` event behind, with the officer who
 * moved it and the reason they gave.
 */
export async function bulkReassignClusterTasks(input: BulkReassignInput): Promise<ActionResult & { moved: number; ownerId: string }> {
  const { blockId, cycleId, fromOwnerIdOrCluster, actingOfficer, reason, role, requestId } = input;
  const { officer, isSupervisoryOverride } = assertOfficerPermission(role, "edit_task");
  const owner = actingOfficer.id.trim();
  const toOwnerName = actingOfficer.nameEn.trim() || actingOfficer.nameHi.trim();
  if (!owner) return { ...refuse(copy("Pick the officer who takes the work.", "काम संभालने वाला अधिकारी चुनें।")), moved: 0, ownerId: owner };
  const data = await loadCycleData(blockId, cycleId);
  const c = data.cycle;
  const scope = officer.cluster ?? fromOwnerIdOrCluster ?? actingOfficer.scope ?? c.schools[0]?.cluster ?? null;
  const codes = new Set(c.schools.filter((s) => s.cluster === scope).map((s) => s.code));
  const open = ["approved", "sent", "reminded", "partial", "blocked", "overdue", "escalated", "draft"];
  const why = reason.trim();
  return withTransaction(async (sql) => {
    await actAs(sql, officer, blockId);
    const tasks = await loadTasks(cycleId, sql);
    const moving = tasks.filter((t) => open.includes(t.status) && t.targetCodes.some((code) => codes.has(code)));
    for (const t of moving) await writeTask(sql, { ...t, ownerId: owner });
    // One event per moved task: who moved it, from whom, to whom, and why.
    for (const t of moving) {
      await sql`
        insert into task_events (block_id, cycle_id, task_id, task_no, from_status, to_status, acted_as_level, actor_person_id, is_supervisory_override)
        values (${blockId}, ${cycleId}, ${t.dbId ?? null}, ${t.id}, ${t.status}, 'bulk_reassigned', ${ROLE_LEVEL[officer.role]}, ${officer.personId}, ${isSupervisoryOverride ? true : false})`;
    }
    if (toOwnerName) {
      // The acting officer is added to the cycle roster so their tasks and the
      // to-do list can belong to a person.
      await sql`
        update cycles set people = ${JSON.stringify([
          ...c.people,
          { id: owner, role: actingOfficer.role, nameEn: actingOfficer.nameEn.trim() || toOwnerName, nameHi: actingOfficer.nameHi.trim() || toOwnerName, cluster: actingOfficer.scope ?? scope, kind: "roster" },
        ])}::jsonb
        where id = ${cycleId}`;
    }
    const summary = `${moving.length} open tasks in cluster ${scope} moved to ${owner}.`;
    await insertMessage(sql, {
      blockId,
      requestId: stableUuid(requestId, "reassign"),
      cycleId,
      taskDbId: null,
      direction: "sys",
      kind: "system",
      channel: "web",
      text: summary,
      textCopy: {
        en: why ? `${summary} Reason: ${why}` : summary,
        hi: why ? `क्लस्टर ${scope} के ${moving.length} खुले कार्य ${owner} को सौंपे गए। कारण: ${why}` : `क्लस्टर ${scope} के ${moving.length} खुले कार्य ${owner} को सौंपे गए।`,
      },
    });
    return { ...ok(copy(summary, `क्लस्टर ${scope} के ${moving.length} खुले कार्य ${owner} को सौंपे गए।`)), moved: moving.length, ownerId: owner };
  });
}

/**
 * The SPD's exclusive power: change one threshold for this block at runtime.
 * The change is written to block_settings, so it survives a restart and is in
 * the audit trail.
 */
export async function updateConfigThresholds(blockId: string, key: string, value: number, role: Who, requestId: string): Promise<ActionResult> {
  const { officer } = assertOfficerPermission(role, "edit_thresholds");
  const k = key.trim() as EditableThreshold;
  if (!EDITABLE_THRESHOLDS.includes(k)) return refuse(copy(`"${key}" is not a threshold the SPD can change.`, `"${key}" वह सीमा नहीं है जो SPD बदल सकते हैं।`));
  if (!Number.isFinite(value)) return refuse(copy("The new value must be a number.", "नया मान संख्या होना चाहिए।"));
  const sql = await getSql();
  // One row per block holds every threshold. The changed one is merged into the
  // jsonb, so the other thresholds of the block are kept.
  await sql`
    insert into block_settings (block_id, thresholds, updated_by_role, updated_by_person_id)
    values (${blockId}, ${JSON.stringify({ [k]: value })}::jsonb, ${officer.role}, ${officer.personId})
    on conflict (block_id) do update
      set thresholds = block_settings.thresholds || ${JSON.stringify({ [k]: value })}::jsonb,
        updated_by_role = ${officer.role}, updated_by_person_id = ${officer.personId}, updated_at = now()`;
  // The pipeline reads block_settings when it builds a cycle, so the current cycle keeps the rules it was built with.
  return ok(copy(
    `${k} is now ${value} for this block. It applies from the next cycle build (reload or upload in Stage 1).`,
    `इस ब्लॉक के लिए ${k} अब ${value} है। यह अगले चक्र से लागू होगा (चरण 1 में फिर लोड या अपलोड)।`,
  ));
}
