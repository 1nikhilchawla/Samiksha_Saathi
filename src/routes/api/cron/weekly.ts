import { createFileRoute } from "@tanstack/react-router";

/**
 * Monday 09:00 IST weekly digest, and a sweep of the outbound queue. Vercel Cron
 * calls it (vercel.json, "30 3 * * 1" UTC) with `Authorization: Bearer $CRON_SECRET`.
 */
async function weekly(request: Request) {
  const { defaultBlockId, istToday, secretMatches, stableUuid } = await import("@/server/samiksha/repo.server");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(bearer, process.env.CRON_SECRET)) return new Response("Unauthorized", { status: 401 });
  const { botLive, sendWeeklyDigest } = await import("../../../../server/bot/telegram");
  if (!botLive()) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set." }, { status: 503 });
  const r = await sendWeeklyDigest(defaultBlockId(), "BEO", stableUuid("weekly", istToday()));
  const { drainQueue } = await import("../../../../server/bot/queue");
  return Response.json({ ok: r.ok, queued: r.queued, delivered: r.delivered, sweep: await drainQueue({ budgetMs: 20_000 }) });
}

export const Route = createFileRoute("/api/cron/weekly")({
  server: { handlers: { GET: ({ request }) => weekly(request), POST: ({ request }) => weekly(request) } },
});
