/**
 * The parts of the live view added for the mentor review: the outbound queue,
 * recent failures (for /why on screen), stored proofs (details only, never the
 * image), sent appreciations, and which optional services are switched on.
 */
import { getSql } from "@/lib/db";
import type { LiveExtras } from "@/lib/samiksha/types";
import { llmModel } from "@/lib/samiksha/llm.server";
import { layaUrl } from "@/lib/samiksha/laya.server";
import { sttProvider } from "@/lib/samiksha/stt.server";
import { whatsAppConfigured } from "@/lib/samiksha/whatsapp";
import { MAX_BRIEF_RERANKS_PER_MONTH, narrateCallsThisMonth } from "@/lib/samiksha/narrate";
import { queueSummary } from "../../../server/bot/queue";
import { recentFailures } from "./diagnostics.server";
import { listProofs, mediaKeySet } from "./proofs.server";

export async function loadLiveExtras(blockId: string, cycleId: number): Promise<LiveExtras> {
  const sql = await getSql();
  const sent = await sql`
    select person_id, points, badges, awarded_by_role, created_at from worker_rewards_ledger
    where block_id = ${blockId} and cycle_id = ${cycleId} order by id desc limit 20`;
  return {
    queue: await queueSummary(blockId, cycleId),
    failures: await recentFailures(blockId, cycleId, 8),
    proofs: await listProofs(blockId, cycleId),
    appreciations: sent.map((r) => ({
      personId: r.person_id as string,
      points: Number(r.points),
      badges: (r.badges ?? []) as string[],
      role: r.awarded_by_role as string,
      at: new Date(String(r.created_at)).toISOString(),
    })),
    services: { mediaKey: mediaKeySet(), laya: Boolean(layaUrl()), model: Boolean(llmModel()), stt: sttProvider() !== "offline", whatsapp: whatsAppConfigured() },
    reorders: { used: await narrateCallsThisMonth(sql, blockId), cap: MAX_BRIEF_RERANKS_PER_MONTH },
  };
}
