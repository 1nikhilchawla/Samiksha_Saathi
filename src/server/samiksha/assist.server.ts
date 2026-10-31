/**
 * Officer assists: the Laya fill on the Approve tab and the custom to-do list.
 *
 * The fill proposes a draft's missing owner and due date from the roster and
 * the action library (layaEngine.ts). When the Laya sidecar runs (LAYA_URL)
 * and there is more than one roster candidate, Laya is asked to choose too;
 * if it disagrees with the roster rule, nothing is filled and the officer
 * chooses. The write goes through updateTask and approveTask, so the approval
 * gate, the role checks and the database rules all still apply.
 */
import { getSql } from "@/lib/db";
import { ACTION_LIBRARY, assertOfficerPermission,
  officerOf, layaAutoFillTaskGovernance, type OfficerRole,
  type ActingOfficer, type Person } from "@/lib/samiksha/engine";
import { layaDecide, layaUrl } from "@/lib/samiksha/laya.server";
import { copy, type ActionResult } from "@/lib/samiksha/types";
/** Who is acting: a signed session, or a bare role in the legacy test path. */
type Who = OfficerRole | ActingOfficer;

import { approveTask, updateTask } from "./actions.server";
import { clockToday, cycleById, loadCycleData, loadTasks } from "./repo.server";

/** Roster people who could own this action for these schools. */
function candidates(people: Person[], actionId: keyof typeof ACTION_LIBRARY, clusters: Set<string>, codes: string[]): Person[] {
  const role = ACTION_LIBRARY[actionId].default_owner_role;
  if (role === "DEO") return people.filter((p) => p.role === "DEO");
  if (role === "HM") {
    const hms = people.filter((p) => p.role === "HM" && codes.some((c) => p.id === `hm-${c}`));
    if (hms.length) return hms;
  }
  return people.filter((p) => p.role === "CRCC" && p.cluster !== null && clusters.has(p.cluster));
}

export async function applyLayaAutofill(blockId: string, cycleId: number, taskNo: number, role: Who, approve: boolean): Promise<ActionResult> {
  assertOfficerPermission(role, "edit_task");
  if (approve) assertOfficerPermission(role, "approve_task");
  const data = await loadCycleData(blockId, cycleId);
  const c = await cycleById(blockId, cycleId);
  const task = (await loadTasks(cycleId)).find((t) => t.id === taskNo);
  if (!task || task.status !== "draft") return { ok: false, gate: copy(`Task #${taskNo} is not a draft.`, `कार्य #${taskNo} ड्राफ्ट नहीं है।`) };
  const fill = layaAutoFillTaskGovernance(task, data.cycle, clockToday(c));
  let ownerNote = `${Math.round(fill.ownerConfidence * 100)}% rule score`;
  if (!task.ownerId && fill.ownerId && layaUrl()) {
    const codes = task.targetCodes;
    const clusters = new Set(data.cycle.schools.filter((s) => codes.includes(s.code)).map((s) => s.cluster));
    const pool = candidates(data.cycle.people, task.actionId, clusters, codes);
    if (pool.length > 1) {
      try {
        const r = await layaDecide(`Task: ${ACTION_LIBRARY[task.actionId].name_en} for ${task.targetLabel}.`, {
          owner: {
            type: "choice",
            instructions: "Who on the block roster should own this task? Pick the person whose role and area match the target.",
            criteria: Object.fromEntries(pool.map((p) => [p.id, `${p.nameEn}, ${p.role}, ${p.scope}`])),
          },
        });
        const a = r.answers.owner;
        if (!a || a.choice !== fill.ownerId) {
          return { ok: false, gate: copy(`Laya and the roster rule disagree on the owner (rule: ${fill.ownerId}, Laya: ${a?.choice ?? "none"}). Choose the owner yourself.`, `जिम्मेदार पर Laya और रोस्टर नियम सहमत नहीं (नियम: ${fill.ownerId}, Laya: ${a?.choice ?? "कोई नहीं"})। जिम्मेदार स्वयं चुनें।`) };
        }
        ownerNote = `Laya ${Math.round(a.confidence * 100)}%, agrees with the roster rule`;
      } catch {
        ownerNote += "; Laya unavailable";
      }
    }
  }
  const patch = { ...(task.ownerId ? {} : { ownerId: fill.ownerId }), ...(task.dueDate === fill.dueDate ? {} : { dueDate: fill.dueDate }) };
  if (Object.keys(patch).length) await updateTask(blockId, cycleId, taskNo, patch, role);
  const owner = data.cycle.people.find((p) => p.id === fill.ownerId);
  const filled = copy(
    `Task #${taskNo}: owner ${owner?.nameEn ?? "—"} (${ownerNote}), due ${fill.dueDate} (${Math.round(fill.dueConfidence * 100)}%, action-library default).`,
    `कार्य #${taskNo}: जिम्मेदार ${owner?.nameHi ?? "—"} (${ownerNote}), अंतिम तिथि ${fill.dueDate} (${Math.round(fill.dueConfidence * 100)}%, कार्य सूची)।`,
  );
  if (!approve) return { ok: true, gate: filled };
  const r = await approveTask(blockId, cycleId, taskNo, role);
  return { ok: r.ok, gate: copy(`${filled.en} ${r.gate?.en ?? ""}`.trim(), `${filled.hi} ${r.gate?.hi ?? ""}`.trim()) };
}

export type TodoRow = { id: number; text: string; done: boolean };

/**
 * The to-do list belongs to a person, not to a role. Two BEOs in one block used
 * to read and clear each other's items, because the list was keyed by the role.
 */
export async function listTodos(blockId: string, who: Who): Promise<TodoRow[]> {
  const officer = assertOfficerPermission(who, "manage_personal_todo").officer;
  const sql = await getSql();
  const rows = await sql`select id, text, done from officer_todos where block_id = ${blockId} and person_id = ${officer.personId} order by id`;
  return rows.map((r) => ({ id: Number(r.id), text: r.text as string, done: Boolean(r.done) }));
}

export async function addTodo(blockId: string, who: Who, text: string, requestId: string): Promise<void> {
  const officer = assertOfficerPermission(who, "manage_personal_todo").officer;
  const clean = text.trim().slice(0, 200);
  if (!clean) return;
  const sql = await getSql();
  await sql`insert into officer_todos (block_id, client_request_id, officer_role, person_id, text)
            values (${blockId}, ${requestId}, ${officer.role}, ${officer.personId}, ${clean})
            on conflict (block_id, client_request_id) do nothing`;
}

/** Tick, untick, or (done = null) remove one of the officer's own items. */
export async function setTodo(blockId: string, who: Who, id: number, done: boolean | null): Promise<void> {
  const officer = assertOfficerPermission(who, "manage_personal_todo").officer;
  const sql = await getSql();
  if (done === null) await sql`delete from officer_todos where block_id = ${blockId} and person_id = ${officer.personId} and id = ${id}`;
  else await sql`update officer_todos set done = ${done}, updated_at = now() where block_id = ${blockId} and person_id = ${officer.personId} and id = ${id}`;
}
