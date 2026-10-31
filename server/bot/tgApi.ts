/**
 * The Telegram Bot API call, shared by the bot (telegram.ts) and the outbound
 * queue worker (queue.ts). TELEGRAM_API_BASE points at a local stand-in in the
 * flow test. A failed call throws with Telegram's error code and, on a 429, the
 * retry_after seconds Telegram asked for.
 */
const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
export const apiBase = () => (process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
export const botToken = token;
export const botLive = () => Boolean(token());

export type TgError = Error & { code?: number; retryAfter?: number };

export async function tg<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const res = await fetch(`${apiBase()}/bot${t}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (!json.ok) {
    throw Object.assign(new Error(`Telegram ${method}: ${json.description ?? res.status}`), {
      code: json.error_code ?? res.status,
      retryAfter: json.parameters?.retry_after,
    }) as TgError;
  }
  return json.result as T;
}
