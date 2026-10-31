import { createFileRoute } from "@tanstack/react-router";

/**
 * Telegram webhook. Register with `npm run bot:webhook -- https://<host>`;
 * Telegram then sends `X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET`.
 * Updates are idempotent (keyed by update_id), so a non-200 retry is safe.
 */
export const Route = createFileRoute("/api/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { secretMatches } = await import("@/server/samiksha/repo.server");
        if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const update = await request.json().catch(() => null);
        if (!update || typeof update.update_id !== "number") return new Response("Bad update", { status: 400 });
        try {
          const { handleUpdate } = await import("../../../../server/bot/telegram");
          await handleUpdate(update);
          return Response.json({ ok: true });
        } catch (err) {
          console.error("[bot] webhook update failed:", err);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
