import { createFileRoute } from "@tanstack/react-router";

/**
 * POST /api/samiksha/runCycle — run the deterministic pipeline on the server and
 * write a `cycles` row. Requires `x-samiksha-secret: $SAMIKSHA_RUN_SECRET`.
 * Body (all optional): { blockId, files: [{ name, csv }], clientRequestId }.
 * An `Idempotency-Key` header (UUID) may stand in for clientRequestId.
 */
export const Route = createFileRoute("/api/samiksha/runCycle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { defaultBlockId, secretMatches } = await import("@/server/samiksha/repo.server");
        if (!process.env.SAMIKSHA_RUN_SECRET?.trim()) return Response.json({ error: "SAMIKSHA_RUN_SECRET is not configured." }, { status: 503 });
        if (!secretMatches(request.headers.get("x-samiksha-secret"), process.env.SAMIKSHA_RUN_SECRET)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        let body: { blockId?: string; files?: { name: string; csv: string }[]; clientRequestId?: string } = {};
        const raw = await request.text();
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            return Response.json({ error: "Body must be JSON." }, { status: 400 });
          }
        }
        if (body.files && (!Array.isArray(body.files) || body.files.some((f) => typeof f?.name !== "string" || typeof f?.csv !== "string"))) {
          return Response.json({ error: "files must be [{ name, csv }]." }, { status: 400 });
        }
        try {
          const { runCycle } = await import("@/server/samiksha/runPipeline.server");
          const result = await runCycle({
            blockId: body.blockId ?? defaultBlockId(),
            files: body.files,
            clientRequestId: body.clientRequestId ?? request.headers.get("idempotency-key") ?? undefined,
          });
          return Response.json(result, { status: result.created ? 201 : 200 });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Run failed." }, { status: 400 });
        }
      },
    },
  },
});
