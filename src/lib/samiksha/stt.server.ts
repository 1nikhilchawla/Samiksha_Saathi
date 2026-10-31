/**
 * Speech-to-text for BEO voice notes and field voice replies, server-only.
 * Providers, first configured wins:
 *   Sarvam    SARVAM_API_KEY (model SARVAM_STT_MODEL, default saaras:v4)
 *   Bhashini  BHASHINI_API_KEY + BHASHINI_INFERENCE_URL + BHASHINI_ASR_SERVICE_ID (Dhruva compute endpoint)
 *   Whisper   OPENAI_API_KEY (model whisper-1)
 * With none set, nothing is sent anywhere: the caller's fallback text comes back
 * marked simulated (the demo note), or an empty transcript the caller must handle.
 */
import { CONFIG } from "./engine";

export type SttProvider = "sarvam" | "bhashini" | "whisper" | "offline";
export type SttResult = { provider: SttProvider; transcript: string; durationSeconds: number; costInr: number; simulated: boolean };
export type SttInput = { audioBase64: string; mimeType: string; lang: "hi" | "en"; durationSeconds?: number; fallback?: string };

const env = (k: string) => process.env[k]?.trim() || undefined;

export function sttProvider(): SttProvider {
  if (env("SARVAM_API_KEY")) return "sarvam";
  if (env("BHASHINI_API_KEY") && env("BHASHINI_INFERENCE_URL") && env("BHASHINI_ASR_SERVICE_ID")) return "bhashini";
  if (env("OPENAI_API_KEY")) return "whisper";
  return "offline";
}

function audioBlob(input: SttInput): Blob {
  return new Blob([Buffer.from(input.audioBase64, "base64")], { type: input.mimeType || "audio/ogg" });
}

async function sarvam(input: SttInput): Promise<string> {
  const form = new FormData();
  form.append("file", audioBlob(input), "note.ogg");
  form.append("model", env("SARVAM_STT_MODEL") ?? "saaras:v4");
  form.append("language_code", input.lang === "hi" ? "hi-IN" : "en-IN");
  const base = (process.env.SARVAM_API_URL?.trim() || "https://api.sarvam.ai").replace(/\/+$/, "");
  const res = await fetch(`${base}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": env("SARVAM_API_KEY")! },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Sarvam speech-to-text error ${res.status}`);
  return String(((await res.json()) as { transcript?: string }).transcript ?? "");
}

async function bhashini(input: SttInput): Promise<string> {
  const res = await fetch(env("BHASHINI_INFERENCE_URL")!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: env("BHASHINI_API_KEY")! },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: "asr", config: { language: { sourceLanguage: input.lang }, serviceId: env("BHASHINI_ASR_SERVICE_ID") } }],
      inputData: { audio: [{ audioContent: input.audioBase64 }] },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Bhashini speech-to-text error ${res.status}`);
  const body = (await res.json()) as { pipelineResponse?: { output?: { source?: string }[] }[] };
  return String(body.pipelineResponse?.[0]?.output?.[0]?.source ?? "");
}

async function whisper(input: SttInput): Promise<string> {
  const form = new FormData();
  form.append("file", audioBlob(input), "note.ogg");
  form.append("model", "whisper-1");
  form.append("language", input.lang);
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Whisper speech-to-text error ${res.status}`);
  return String(((await res.json()) as { text?: string }).text ?? "");
}

export async function transcribeAudio(input: SttInput): Promise<SttResult> {
  const provider = sttProvider();
  const durationSeconds = input.durationSeconds ?? 0;
  if (provider === "offline") {
    return { provider, transcript: input.fallback ?? "", durationSeconds, costInr: 0, simulated: true };
  }
  const run = provider === "sarvam" ? sarvam : provider === "bhashini" ? bhashini : whisper;
  const transcript = (await run(input)).trim();
  // Only Sarvam is priced here (CONFIG.pricing); the others show ₹0 in the ledger.
  const costInr = provider === "sarvam" ? (durationSeconds / 3600) * CONFIG.pricing.sarvam_stt_inr_per_hour : 0;
  return { provider, transcript, durationSeconds, costInr, simulated: false };
}
