import { createFileRoute } from "@tanstack/react-router";

/**
 * WhatsApp Business Cloud API webhook. Meta first calls GET with
 * hub.mode=subscribe and our WHATSAPP_VERIFY_TOKEN; then every POST carries
 * X-Hub-Signature-256 over the raw body, checked with WHATSAPP_APP_SECRET.
 * Replies are idempotent (keyed by the WhatsApp message id), so a retry is safe.
 */
export const Route = createFileRoute("/api/whatsapp/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { verifyWhatsAppChallenge } = await import("@/server/samiksha/whatsapp.server");
        const out = verifyWhatsAppChallenge(new URL(request.url).searchParams);
        return new Response(out.body, { status: out.status, headers: { "content-type": "text/plain" } });
      },
      POST: async ({ request }) => {
        const { handleWhatsAppWebhook, whatsAppSignatureValid } = await import("@/server/samiksha/whatsapp.server");
        const raw = await request.text();
        if (!whatsAppSignatureValid(raw, request.headers.get("x-hub-signature-256"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response("Bad payload", { status: 400 });
        }
        try {
          return Response.json({ ok: true, ...(await handleWhatsAppWebhook(payload)) });
        } catch (err) {
          console.error("[whatsapp] webhook failed:", err);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
