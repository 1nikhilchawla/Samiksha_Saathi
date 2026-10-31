/**
 * Laya (github.com/NandhaKishorM/laya): a local, non-generative decision model
 * that answers typed questions in one forward pass. Used where the product
 * needs a decision, not text. Runs as a sidecar: `pip install "laya[serve]"`,
 * then `laya-serve`; point LAYA_URL at it. Unset = this stage is skipped.
 */
export type LayaChoice = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type LayaResult = { model: string; answers: Record<string, LayaChoice>; tokensIn: number };

export function layaUrl(): string | null {
  return process.env.LAYA_URL?.trim().replace(/\/+$/, "") || null;
}

export async function layaDecide(state: string, questions: Record<string, unknown>): Promise<LayaResult> {
  const url = layaUrl();
  if (!url) throw new Error("LAYA_URL is not set.");
  const key = process.env.LAYA_API_KEY?.trim();
  const res = await fetch(`${url}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    // Hinglish is Latin script, which would route to the English checkpoint.
    body: JSON.stringify({ state, questions, model: process.env.LAYA_MODEL?.trim() || "multilingual" }),
    signal: AbortSignal.timeout(Number(process.env.LAYA_TIMEOUT_MS) || 8000),
  });
  if (!res.ok) throw new Error(`Laya error ${res.status}`);
  const body = (await res.json()) as {
    model?: string;
    routing?: { model?: string };
    usage?: { input_tokens?: number };
    answers?: Record<string, { choice?: string; confidence?: number; answer_confidence?: number; probabilities?: Record<string, number> }>;
  };
  const answers: Record<string, LayaChoice> = {};
  for (const [qid, a] of Object.entries(body.answers ?? {})) {
    if (typeof a?.choice !== "string") continue;
    answers[qid] = {
      choice: a.choice,
      // answer_confidence is Laya's calibrated number; confidence is normalized entropy.
      confidence: Number(a.answer_confidence ?? a.confidence ?? 0),
      probabilities: a.probabilities ?? {},
    };
  }
  return { model: body.routing?.model ?? body.model ?? "laya", answers, tokensIn: body.usage?.input_tokens ?? 0 };
}
