/**
 * The one completion helper behind the two allowed model calls (narrateGaps,
 * parseFieldReplyLLM). Claude when ANTHROPIC_API_KEY is set, else xAI when
 * XAI_API_KEY is set (the original narrate path), else a local Ollama model
 * when OLLAMA_MODEL is set (offline pilot box / tests), else unavailable.
 */
import { DEFAULT_CLAUDE_MODEL, DEFAULT_XAI_MODEL } from "./core/config";

export type LlmTurn = { role: "user" | "assistant"; content: string };
export type Completion = { text: string; tokensIn: number; tokensOut: number; model: string; billable: boolean };

const env = (k: string) => process.env[k]?.trim() || undefined;

export function llmModel(): string | null {
  if (env("ANTHROPIC_API_KEY")) return env("SAMIKSHA_CLAUDE_MODEL") ?? DEFAULT_CLAUDE_MODEL;
  if (env("XAI_API_KEY")) return env("SAMIKSHA_XAI_MODEL") ?? DEFAULT_XAI_MODEL;
  if (env("OLLAMA_MODEL")) return `ollama:${env("OLLAMA_MODEL")}`;
  return null;
}

export async function complete(
  system: string,
  turns: LlmTurn[],
  opts: { temperature: number; maxTokens: number; /** Longer replies (a Top 15 order) need longer than the 20 s default. */ timeoutMs?: number },
): Promise<Completion> {
  const model = llmModel();
  if (!model) throw new Error("The AI co-pilot is not available right now.");
  const timeout = opts.timeoutMs ?? 20_000;

  if (env("ANTHROPIC_API_KEY")) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ timeout, maxRetries: 1 });
    // Claude 5 models reject non-default sampling, so temperature is not sent;
    // thinking is off so the short max_tokens is spent on the JSON answer.
    const res = await client.messages.create({
      model,
      max_tokens: opts.maxTokens,
      system,
      messages: turns,
      thinking: /sonnet-5-5/.test(model) ? { type: "between_tools" } : { type: "disabled" },
    });
    if (res.stop_reason === "refusal") throw new Error("Model declined the request.");
    if (res.stop_reason === "max_tokens") throw new Error(`Model reply was cut off at ${opts.maxTokens} tokens.`);
    return {
      text: res.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
      tokensIn: res.usage.input_tokens,
      tokensOut: res.usage.output_tokens,
      model,
      billable: true,
    };
  }

  if (!env("XAI_API_KEY")) {
    const base = (env("OLLAMA_URL") ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env("OLLAMA_MODEL"),
        stream: false,
        format: "json",
        // Both prompts are ~1-2k tokens; a model's default context can need tens of GB of KV cache.
        options: { temperature: opts.temperature, num_predict: opts.maxTokens, num_ctx: 4096 },
        messages: [{ role: "system", content: system }, ...turns],
      }),
      signal: AbortSignal.timeout(120_000), // a cold local model loads before it answers
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return { text: body.message?.content ?? "", tokensIn: body.prompt_eval_count ?? 0, tokensOut: body.eval_count ?? 0, model, billable: false };
  }

  // The public xAI endpoint; XAI_BASE_URL points at a proxy or gateway instead.
  // aislop-ignore-next-line
  const xaiBase = (env("XAI_BASE_URL") ?? "https://api.x.ai/v1").replace(/\/+$/, "");
  const res = await fetch(`${xaiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("XAI_API_KEY")}` },
    body: JSON.stringify({
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: [{ role: "system", content: system }, ...turns],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`AI error ${res.status}`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
    model,
    billable: true,
  };
}

/** First {...} block of a model reply. */
export function parseJsonObject<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1)) as T;
}
