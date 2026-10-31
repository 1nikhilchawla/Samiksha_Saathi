/**
 * Failure log behind /why. Stage 1 (the gate) and the exact stage-2 explanation
 * come from core/failureDiagnostics.ts; this file stores them, finds the latest
 * one for a block or a person, and, when someone asks, lets the model reword
 * the explanation in plainer language. The model gets only the stored facts,
 * is capped per month, and its words must pass the second check (no number
 * that is not in the facts) or the exact explanation is shown instead.
 */
import { getSql, type Sql } from "@/lib/db";
import { FAILURE_CODES, diagnoseFailure, layaSecondCheckOnClaude, scanPromptInjection, type FailureCode, type FailureDiagnosticEntry, type FailureFacts, type FailureSurface } from "@/lib/samiksha/engine";
import { complete, llmModel, parseJsonObject } from "@/lib/samiksha/llm.server";
import { insertLlmCall, istToday, stableUuid } from "./repo.server";

export const FAILURE_EXPLAIN_MONTHLY_LIMIT = 30;

/** An instruction was cut out of text on its way to a model; /why can show it. Does nothing when nothing was found. */
export async function logPromptInjection(sql: Sql, blockId: string, cycleId: number | null, where: string, detections: string[], requestId: string): Promise<void> {
  if (!detections.length) return;
  await logFailure(sql, blockId, cycleId, diagnoseFailure("model_input", "PROMPT_INJECTION_BLOCKED", { where, patterns: detections.join(", ") }), stableUuid(requestId, "injection", where));
}

export async function logFailure(sql: Sql, blockId: string, cycleId: number | null, e: FailureDiagnosticEntry, requestId: string): Promise<void> {
  await sql`
    insert into failure_diagnostics_log (block_id, client_request_id, cycle_id, surface, failure_code, person_id, confidence, gate_source, facts, why_failed, how_to_fix, explained_by)
    values (${blockId}, ${requestId}, ${cycleId}, ${e.surface}, ${e.code}, ${e.personId ?? null}, ${e.gate.confidence}, ${e.gate.source},
            ${JSON.stringify(e.facts)}::jsonb, ${JSON.stringify(e.explanation.whyFailed)}::jsonb, ${JSON.stringify(e.explanation.howToFix)}::jsonb, ${e.explanation.source})
    on conflict (block_id, client_request_id) do nothing`;
}

/** Re-derive the entry from a stored row: the explanation is rebuilt from the facts, never trusted from the row. */
function fromRow(r: Record<string, unknown>): FailureDiagnosticEntry {
  const code = r.failure_code as FailureCode;
  return diagnoseFailure(r.surface as FailureSurface, code, (r.facts ?? {}) as FailureFacts, {
    id: `FAIL-${r.id}`,
    at: new Date(String(r.created_at)).toISOString(),
    confidence: Number(r.confidence),
    source: r.gate_source === "laya" ? "laya" : "rules",
    personId: (r.person_id as string | null) ?? null,
  });
}

/** The latest failure for the block, or for one person when given (a field worker's /why). */
export async function latestFailure(blockId: string, personId?: string | null): Promise<FailureDiagnosticEntry | null> {
  const sql = await getSql();
  const [row] = personId
    ? await sql`select * from failure_diagnostics_log where block_id = ${blockId} and person_id = ${personId} order by id desc limit 1`
    : await sql`select * from failure_diagnostics_log where block_id = ${blockId} order by id desc limit 1`;
  return row ? fromRow(row) : null;
}

export async function recentFailures(blockId: string, cycleId: number, limit = 10): Promise<FailureDiagnosticEntry[]> {
  const sql = await getSql();
  const rows = await sql`select * from failure_diagnostics_log where block_id = ${blockId} and (cycle_id = ${cycleId} or cycle_id is null) order by id desc limit ${limit}`;
  return rows.map(fromRow);
}

/** Log a failure the browser caught (a size limit, the student-data guard, a photo check). Only the code and facts travel. */
export async function logClientFailure(blockId: string, cycleId: number, code: string, surface: string, facts: unknown, requestId: string): Promise<FailureDiagnosticEntry> {
  if (!(FAILURE_CODES as string[]).includes(code)) throw new Error("Unknown failure code.");
  const clean: FailureFacts = {};
  for (const [k, v] of Object.entries((facts && typeof facts === "object" ? facts : {}) as Record<string, unknown>).slice(0, 20)) {
    if (/^[a-zA-Z]{1,24}$/.test(k) && (typeof v === "number" || typeof v === "boolean" || v === null || (typeof v === "string" && v.length <= 200))) clean[k] = v as FailureFacts[string];
  }
  const entry = diagnoseFailure(surface as FailureSurface, code as FailureCode, clean, {
    confidence: typeof clean.confidence === "number" ? Math.max(0, Math.min(1, clean.confidence)) : 1,
  });
  await logFailure(await getSql(), blockId, cycleId, entry, requestId);
  return entry;
}

const SYSTEM = [
  "You reword one failure message for a school education officer in India. Reply with JSON only:",
  '{"why_en":"","why_hi":""}',
  "Use only the facts given. Do not add any number, name or date that is not in the facts. One or two short sentences each; plain words, no jargon.",
].join("\n");

/**
 * The plain-language rewording, when a model is configured and the monthly cap
 * allows. Returns the entry unchanged (exact explanation) otherwise.
 */
export async function explainFailureWithModel(blockId: string, cycleId: number | null, entry: FailureDiagnosticEntry, requestId: string): Promise<{ entry: FailureDiagnosticEntry; note: string }> {
  const model = llmModel();
  if (!model) return { entry, note: "This is the exact explanation from the facts; the plain-words AI rewording is not available right now." };
  const sql = await getSql();
  const [usage] = await sql<{ n: number }>`
    select count(*)::int as n from llm_calls
    where block_id = ${blockId} and purpose = 'failure_explain' and billable
      and created_at >= (${`${istToday().slice(0, 7)}-01`}::date - interval '330 minutes')`;
  if (FAILURE_EXPLAIN_MONTHLY_LIMIT - Number(usage?.n ?? 0) <= 0) return { entry, note: `Monthly limit of ${FAILURE_EXPLAIN_MONTHLY_LIMIT} plain-language explanations reached; this is the exact explanation.` };
  const input = { code: entry.code, facts: entry.facts, exact_en: entry.explanation.whyFailed.en, exact_hi: entry.explanation.whyFailed.hi };
  let res: Awaited<ReturnType<typeof complete>>;
  try {
    const screened = scanPromptInjection(JSON.stringify(input));
    await logPromptInjection(sql, blockId, cycleId, "failure explanation", screened.detections, requestId);
    res = await complete(SYSTEM, [{ role: "user", content: screened.sanitized }], { temperature: 0, maxTokens: 300 });
  } catch (err) {
    return { entry, note: err instanceof Error ? err.message : "Model call failed." };
  }
  let out: { why_en?: unknown; why_hi?: unknown } = {};
  try {
    out = parseJsonObject(res.text);
  } catch {
    out = {};
  }
  const en = typeof out.why_en === "string" ? out.why_en.trim().slice(0, 400) : "";
  const hi = typeof out.why_hi === "string" ? out.why_hi.trim().slice(0, 400) : "";
  const check = layaSecondCheckOnClaude("failure_explanation", { text: `${en} ${hi}` }, { allowedFrom: input });
  const passed = Boolean(en && hi && check.verified);
  await insertLlmCall(sql, {
    blockId, requestId: stableUuid(requestId, "explain"), cycleId, purpose: "failure_explain", model: res.model,
    tokensIn: res.tokensIn, tokensOut: res.tokensOut, passed, simulated: false, billable: res.billable,
    note: passed ? "Reworded; second check passed." : `Not shown: ${check.badge.en}`,
  });
  if (!passed) return { entry, note: `The model's wording failed the second check, so the exact explanation is shown. ${check.badge.en}` };
  return { entry: { ...entry, explanation: { ...entry.explanation, whyFailed: { en, hi }, source: "model" } }, note: check.badge.en };
}
