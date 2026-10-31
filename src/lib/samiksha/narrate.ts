import { createServerFn } from "@tanstack/react-start";
import type { Sql } from "@/lib/db";
import {
  DEFAULT_TOP_GAPS_LIMIT,
  TOP_GAPS_OPTIONS,
  briefRankingSecondCheck,
  checkGapOrder,
  gapOrderInput,
  scanPromptInjection,
  validateActions,
  validateCitations,
  type ActionId,
  type Citation,
  type GapOrderRow,
  type TopGapsLimit,
} from "./engine";

export type NarrateResult =
  | { ok: true; order: GapOrderRow[]; limit: TopGapsLimit; tokensIn: number; tokensOut: number; model: string; layaConfidence: number; cached?: boolean; callsLeft?: number }
  | { ok: false; error: string; callsLeft?: number };

/**
 * The monthly cap on brief re-ranks for one block.
 *
 * The failure explanations have a cap of 30 a month. The reorder had none, so a
 * bored officer could spend the whole budget on one brief. It has a cap of 40
 * now, and it says how many calls are left.
 */
export const MAX_BRIEF_RERANKS_PER_MONTH = 40;

/** The old name, kept so the import sites do not break. */
export const NARRATE_MONTHLY_LIMIT = MAX_BRIEF_RERANKS_PER_MONTH;

/**
 * How many reorders the officers of this block asked for this month. One ask is
 * one operation, however many attempts the second check needed: the retry is
 * the system's cost, not the officer's. Rows from before the operation id was
 * recorded count one each. A cached answer writes no row, so it is free.
 */
export async function narrateCallsThisMonth(sql: Sql, blockId: string): Promise<number> {
  const rows = await sql`
    select count(distinct coalesce(detail->>'operation', client_request_id::text))::int as n from llm_calls
    where block_id = ${blockId} and purpose = 'brief_generation' and not simulated
      and created_at >= date_trunc('month', now())`;
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

type CacheKey = { blockId: string; cycleId: number; limit: number; signature: string };
type CachedOrder = { order: GapOrderRow[]; layaConfidence: number; model: string | null; tokensIn: number; tokensOut: number };

/** The stored order for this exact list, or null. A database without narrate_cache (before 0009) only misses. */
async function readCachedOrder(sql: Sql, k: CacheKey): Promise<CachedOrder | null> {
  try {
    const rows = await sql`
      select gap_order, laya_confidence, model, tokens_in, tokens_out from narrate_cache
      where block_id = ${k.blockId} and cycle_id = ${k.cycleId} and list_limit = ${k.limit} and gap_signature = ${k.signature}`;
    const c = rows[0];
    if (!c) return null;
    return {
      order: c.gap_order as GapOrderRow[],
      layaConfidence: Number(c.laya_confidence ?? 1),
      model: (c.model as string | null) ?? null,
      tokensIn: Number(c.tokens_in ?? 0),
      tokensOut: Number(c.tokens_out ?? 0),
    };
  } catch {
    return null;
  }
}

/** Keeps a passed order for the next ask. Without the cache table the next ask simply calls the model again. */
async function writeCachedOrder(sql: Sql, k: CacheKey, r: { order: GapOrderRow[]; layaConfidence: number; model: string; tokensIn: number; tokensOut: number }) {
  try {
    await sql`
      insert into narrate_cache (block_id, cycle_id, list_limit, gap_signature, gap_order, laya_confidence, model, tokens_in, tokens_out)
      values (${k.blockId}, ${k.cycleId}, ${k.limit}, ${k.signature}, ${JSON.stringify(r.order)}::jsonb,
        ${r.layaConfidence}, ${r.model}, ${r.tokensIn}, ${r.tokensOut})
      on conflict (block_id, cycle_id, list_limit) do update set gap_signature = ${k.signature},
        gap_order = ${JSON.stringify(r.order)}::jsonb, laya_confidence = ${r.layaConfidence},
        model = ${r.model}, tokens_in = ${r.tokensIn}, tokens_out = ${r.tokensOut}, created_at = now()`;
  } catch {
    /* no cache table yet */
  }
}

/**
 * Claude orders the brief's Top 5, Top 10 or Top 15 list. Code picks which gaps
 * are in the list (code rank N or better); Claude only reorders them and writes a
 * one-line reason for each. The order must keep every gap once with ranks 1..N,
 * and the Laya second check refuses any number the facts do not contain.
 */
export const narrateGaps = createServerFn({ method: "POST" })
  .validator((input: { blockId: string; cycleId: number; limit?: number }) => input)
  .handler(async ({ data }): Promise<NarrateResult> => reorderGaps(data));

/** The model call, passed in so the flow test can count calls without a key. */
type Completer = typeof import("./llm.server").complete;

/**
 * The reorder itself. Order of the gates: the stored order for this exact list
 * first (free, and never blocked by the monthly cap), then the cap, then the
 * model. `deps` replaces the model in the flow test.
 */
export async function reorderGaps(
  data: { blockId: string; cycleId: number; limit?: number },
  deps: { complete?: Completer; model?: string | null } = {},
): Promise<NarrateResult> {
  const llm = await import("./llm.server");
  const complete = deps.complete ?? llm.complete;
  const { parseJsonObject } = llm;
  const model = deps.model !== undefined ? deps.model : llm.llmModel();
  const limit = TOP_GAPS_OPTIONS.find((n) => n === data.limit) ?? DEFAULT_TOP_GAPS_LIMIT;

  // Facts come from the persisted cycle, never from the browser.
  const { getSql, withTransaction } = await import("@/lib/db");
  const { assertBlockId, insertLlmCall, stableUuid } = await import("@/server/samiksha/repo.server");
  const blockId = assertBlockId(data.blockId);
  const sql = await getSql();
  const rows = await sql`
    select gap_id, code_rank, gap_kind, fact_en, fact_hi, action_id, allowed_actions, source_refs from gaps
    where block_id = ${blockId} and cycle_id = ${data.cycleId} and code_rank <= ${limit} order by code_rank`;
  const [cycle] = await sql`select peer from cycles where block_id = ${blockId} and id = ${data.cycleId}`;
  const gaps = rows.map((r) => ({
    id: r.gap_id as string,
    codeRank: Number(r.code_rank),
    gapKind: r.gap_kind as string,
    factEn: r.fact_en as string,
    factHi: r.fact_hi as string,
    actionId: r.action_id as ActionId,
    allowedActions: r.allowed_actions as ActionId[],
    sourceRefs: r.source_refs as Citation[],
  }));
  if (!gaps.length || !cycle) return { ok: false, error: "Nothing to reorder." };
  if (gaps.length < limit) return { ok: false, error: `This cycle has ${gaps.length} ranked gaps. Run the cycle again to build the Top ${limit} watchlist.` };

  const used = await narrateCallsThisMonth(sql, blockId);
  const callsLeft = Math.max(0, MAX_BRIEF_RERANKS_PER_MONTH - used);

  // A gap outside the action library or without a citation is not sent to the model at all.
  const broken = [...validateActions(gaps), ...validateCitations(gaps)];
  if (broken.length) return { ok: false, error: `Gap check failed before the model call: ${broken.join(", ")}.`, callsLeft };

  const input = gapOrderInput(gaps, (cycle.peer as { conclusionEn: string }).conclusionEn);
  const ids = gaps.map((g) => g.id);
  // The signature of the list being reordered. The same list in the same cycle
  // serves the stored order instead of spending another call.
  const signature = ids.join("|");
  const cacheKey: CacheKey = { blockId, cycleId: data.cycleId, limit, signature };
  const applyOrder = async (q: Sql, order: GapOrderRow[]) => {
    for (const o of order) {
      await q`update gaps set claude_rank = ${o.claude_rank}, rank_justification_en = ${o.justification_en}, rank_justification_hi = ${o.justification_hi}
               where block_id = ${blockId} and cycle_id = ${data.cycleId} and gap_id = ${o.gap_id}`;
    }
    // Gaps outside this list go back to their code rank, so ranks never collide across lists.
    await q`update gaps set claude_rank = code_rank where block_id = ${blockId} and cycle_id = ${data.cycleId} and code_rank > ${limit}`;
  };
  const hit = await readCachedOrder(sql, cacheKey);
  if (hit) {
    // Another list may have been reordered since, so the stored order is written back before it is served.
    await withTransaction((tx) => applyOrder(tx, hit.order));
    return {
      ok: true,
      order: hit.order,
      limit,
      tokensIn: hit.tokensIn,
      tokensOut: hit.tokensOut,
      model: hit.model ?? model ?? "cache",
      layaConfidence: hit.layaConfidence,
      cached: true,
      callsLeft,
    };
  }

  // Only a new order needs the model, and only a new order counts against the monthly cap.
  if (!model) return { ok: false, error: "AI co-pilot unavailable. Standard Rule Ranking Active — All Gap Numbers Verified.", callsLeft };
  if (callsLeft <= 0) {
    return { ok: false, error: `This block has used its ${MAX_BRIEF_RERANKS_PER_MONTH} AI reorders for the month. The code order stays.`, callsLeft: 0 };
  }
  // Matched schools for the Round 4 scorecard: a camp there before Round 4 would blur the comparison.
  const comparisonIds = gaps.filter((g) => g.gapKind === "watchlist_control").map((g) => g.id);
  const system = [
    `You order ${gaps.length} gaps for a block education officer. Reply with JSON only.`,
    '{"order":[{"gap_id":"","claude_rank":1,"justification_en":"","justification_hi":""}]}',
    "Rules: use every given gap id exactly once. Do not invent a gap, a school, or a number.",
    'A "flag" gap crossed a review threshold; a "watchlist" school is below the thresholds and next by urgency.',
    'A "comparison_school" is a matched comparison school for the Round 4 scorecard. Its justification must say so ("Round 4 comparison school" / "राउंड 4 तुलना विद्यालय") and must not recommend a camp or any action there before Round 4; say only why it is watched.',
    "Each justification is one short sentence on why the gap matters. Any digit you write must already appear in the facts.",
  ].join("\n");
  // School names and facts come from uploaded files: any instruction in them is cut out before the prompt.
  const screened = scanPromptInjection(JSON.stringify(input));
  if (!screened.safe) {
    const { logPromptInjection } = await import("@/server/samiksha/diagnostics.server");
    await logPromptInjection(sql, blockId, data.cycleId, "brief reorder", screened.detections, crypto.randomUUID());
  }
  const user = screened.sanitized;
  // Replies grow with the list: each gap carries an English and a Hindi sentence.
  const size = Math.ceil(gaps.length / DEFAULT_TOP_GAPS_LIMIT);
  const opts = { temperature: 0.2, maxTokens: 2000 * size, timeoutMs: 20_000 * size };

  let layaConfidence = 0;
  const check = (order: GapOrderRow[]) => {
    const shape = checkGapOrder(order, ids, comparisonIds);
    if (shape) return shape;
    // Five checks: numbers, library actions, citations, every gap once, tone and safety. Applied only at 5 of 5.
    const second = briefRankingSecondCheck(order, gaps, input);
    layaConfidence = second.confidence;
    const failed = second.checks.filter((c) => !c.pass);
    return second.verified ? "" : `Second check ${second.checks.length - failed.length}/${second.checks.length} failed on: ${failed.map((c) => `${c.id} (${c.detail.replace(/^invented: /, "")})`).join(", ")}`;
  };

  const requestId = crypto.randomUUID();
  const ledger: { tokensIn: number; tokensOut: number; passed: boolean; billable: boolean; note: string }[] = [];
  const finish = async (result: NarrateResult) => {
    await withTransaction(async (tx) => {
      for (const [i, l] of ledger.entries()) {
        // The operation id ties a retry to its ask, so the monthly cap counts the ask once.
        await insertLlmCall(tx, {
          blockId, requestId: stableUuid(requestId, i), cycleId: data.cycleId, purpose: "brief_generation", model,
          tokensIn: l.tokensIn, tokensOut: l.tokensOut, passed: l.passed, simulated: false, billable: l.billable, note: l.note,
          detail: { operation: requestId, attempt: i },
        });
      }
      if (result.ok) await applyOrder(tx, result.order);
    });
    // After the commit: a database without the cache table must not undo the ranks or the ledger.
    if (result.ok) await writeCachedOrder(sql, cacheKey, result);
    // This ask is now spent, whether or not it passed.
    return { ...result, callsLeft: ledger.length ? Math.max(0, callsLeft - 1) : callsLeft };
  };

  try {
    const first = await complete(system, [{ role: "user", content: user }], opts);
    let order: GapOrderRow[] = [];
    let problem = "";
    try {
      order = parseJsonObject<{ order?: GapOrderRow[] }>(first.text).order ?? [];
      problem = check(order);
    } catch {
      problem = "Response was not usable JSON.";
    }
    ledger.push({ tokensIn: first.tokensIn, tokensOut: first.tokensOut, passed: !problem, billable: first.billable, note: problem || `Live reorder, Top ${limit}.` });
    if (problem) {
      const second = await complete(
        system,
        [
          { role: "user", content: user },
          { role: "assistant", content: first.text.slice(0, 1500) },
          { role: "user", content: `Rejected: ${problem} Try again. Use only the given numbers.` },
        ],
        opts,
      );
      try {
        order = parseJsonObject<{ order?: GapOrderRow[] }>(second.text).order ?? [];
        problem = check(order);
      } catch {
        problem = "Response was not usable JSON.";
      }
      ledger.push({ tokensIn: second.tokensIn, tokensOut: second.tokensOut, passed: !problem, billable: second.billable, note: problem || `Live reorder, Top ${limit} (retry).` });
      if (problem) return finish({ ok: false, error: problem });
    }
    const tokensIn = ledger.reduce((n, l) => n + l.tokensIn, 0);
    const tokensOut = ledger.reduce((n, l) => n + l.tokensOut, 0);
    return finish({ ok: true, order, limit, tokensIn, tokensOut, model, layaConfidence });
  } catch (err) {
    return finish({ ok: false, error: err instanceof Error ? err.message : "AI call failed." });
  }
}
