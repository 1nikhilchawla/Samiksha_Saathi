/**
 * Voice/typed note -> draft tasks with the bounded model, for notes the rules in
 * core/customTasks.ts cannot read. The model only picks from the roster, the
 * action library and the people list; every item is re-checked here, and any
 * owner or date the note did not give stays empty, which locks approval.
 */
import { ACTION_LIBRARY, REVIEW_DATE, customDraft, layaSecondCheckOnClaude, resolveTarget, scanPromptInjection, type ActionId, type Cycle, type SecondCheck, type Task } from "@/lib/samiksha/engine";
import { complete, llmModel, parseJsonObject } from "@/lib/samiksha/llm.server";

export const NOTE_EXTRACT_MONTHLY_LIMIT = 30;

const SYSTEM = [
  "You turn a block education officer's review note (Hindi, English or Hinglish) into draft tasks. Reply with JSON only:",
  '{"tasks":[{"target":"","action_id":"","owner_id":null,"due_date":null,"what_en":"","what_hi":""}]}',
  "target: a school name or 'Cluster C<n>' from allowed.schools / allowed.clusters. action_id: one of allowed.action_ids.",
  "owner_id: an id from allowed.people only if the note names that person or role; otherwise null. Never guess an owner.",
  "due_date: YYYY-MM-DD only if the note states a date after allowed.review_date; otherwise null. Never guess a date.",
  "what_en / what_hi: one short sentence each, from the note. One task per decision in the note; none if it decides nothing.",
].join("\n");

type Item = { target?: unknown; action_id?: unknown; owner_id?: unknown; due_date?: unknown; what_en?: unknown; what_hi?: unknown };

export type NoteExtract = { tasks: Task[]; model: string; tokensIn: number; tokensOut: number; billable: boolean; note: string; secondCheck?: SecondCheck };

export async function extractTasksWithModel(text: string, cycle: Pick<Cycle, "gaps" | "people" | "schools">, budgetLeft: number, firstId = 14): Promise<NoteExtract | null> {
  const model = llmModel();
  if (!model) return null;
  if (budgetLeft <= 0) return { tasks: [], model, tokensIn: 0, tokensOut: 0, billable: false, note: `Monthly limit of ${NOTE_EXTRACT_MONTHLY_LIMIT} note extractions reached; model call refused.` };
  // A voice note or typed note is untrusted: any instruction in it is cut out before the prompt.
  const user = scanPromptInjection(JSON.stringify({
    note: text,
    allowed: {
      review_date: REVIEW_DATE,
      action_ids: Object.keys(ACTION_LIBRARY),
      schools: cycle.schools.map((s) => s.nameEn),
      clusters: [...new Set(cycle.schools.map((s) => s.cluster))].map((c) => `Cluster ${c}`),
      people: cycle.people.filter((p) => p.role !== "BEO").map((p) => ({ id: p.id, role: p.role, name: p.nameEn, scope: p.scope })),
    },
  })).sanitized;
  const res = await complete(SYSTEM, [{ role: "user", content: user }], { temperature: 0.1, maxTokens: 1500 });
  let items: Item[] = [];
  try {
    items = parseJsonObject<{ tasks?: Item[] }>(res.text).tasks ?? [];
  } catch {
    return { tasks: [], model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, billable: res.billable, note: "Response was not usable JSON." };
  }
  const people = new Set(cycle.people.filter((p) => p.role !== "BEO").map((p) => p.id));
  const tasks: Task[] = [];
  let dropped = 0;
  for (const it of items) {
    const target = typeof it.target === "string" ? resolveTarget(it.target, cycle.schools) : null;
    const actionId = typeof it.action_id === "string" && it.action_id in ACTION_LIBRARY ? (it.action_id as ActionId) : null;
    if (!target || !actionId) {
      dropped += 1;
      continue;
    }
    const ownerId = typeof it.owner_id === "string" && people.has(it.owner_id) ? it.owner_id : null;
    const due = typeof it.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.due_date) && it.due_date > REVIEW_DATE ? it.due_date : null;
    const what = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 240) : "");
    const en = what(it.what_en) || what(it.what_hi);
    const hi = what(it.what_hi) || en;
    if (!en) {
      dropped += 1;
      continue;
    }
    tasks.push(customDraft({ id: firstId + tasks.length, gaps: cycle.gaps, target, actionId, ownerId, dueDate: due, what: [en, hi] }));
  }
  // Second check: no number in the drafts that is not in the note or the roster, and only library actions.
  const secondCheck = layaSecondCheckOnClaude(
    "voice_task_extraction",
    { text: tasks.map((t) => `${t.whatEn} ${t.whatHi}`).join(" "), actionIds: items.map((it) => String(it.action_id ?? "")).filter(Boolean) },
    { allowedFrom: { note: text, schools: cycle.schools.map((s) => s.nameEn), dates: tasks.map((t) => t.dueDate) } },
  );
  if (!secondCheck.verified) {
    return { tasks: [], model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, billable: res.billable, secondCheck, note: `Model drafts not used. ${secondCheck.badge.en}` };
  }
  const note = `${tasks.length} draft${tasks.length === 1 ? "" : "s"} from the model${dropped ? `; ${dropped} item${dropped === 1 ? "" : "s"} outside the roster or library dropped` : ""}. ${secondCheck.badge.en}.`;
  return { tasks, model: res.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, billable: res.billable, secondCheck, note };
}
