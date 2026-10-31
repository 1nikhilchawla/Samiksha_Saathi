import { createFileRoute } from "@tanstack/react-router";

/**
 * Daily 09:00 IST nudge for tasks due today. Vercel Cron calls it (vercel.json,
 * "30 3 * * *" UTC) with `Authorization: Bearer $CRON_SECRET`.
 */
async function nudge(request: Request) {
  const { secretMatches } = await import("@/server/samiksha/repo.server");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(bearer, process.env.CRON_SECRET)) return new Response("Unauthorized", { status: 401 });
  const { botLive, sendDueNudges } = await import("../../../../server/bot/telegram");
  if (!botLive()) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set." }, { status: 503 });
  return Response.json({ ok: true, blocks: await sendDueNudges() });
}

export const Route = createFileRoute("/api/cron/nudge")({
  server: { handlers: { GET: ({ request }) => nudge(request), POST: ({ request }) => nudge(request) } },
});
