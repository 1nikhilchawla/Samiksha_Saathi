/**
 * WhatsApp Business Cloud API (Meta Graph v21.0) for task cards: the utility
 * template payload, a sender (WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID, server
 * only), and an inbound webhook parser that reads replies with the same rule
 * baseline as Telegram. The templates samiksha_task_card_en / _hi must be
 * approved in Meta Business Manager before the sender can be used.
 */
import { ACTION_LIBRARY, parseFieldReply, type Person, type ReplyParse, type Task } from "./engine";

export const WHATSAPP_GRAPH_VERSION = "v21.0";
export const WHATSAPP_TEMPLATES = { en: "samiksha_task_card_en", hi: "samiksha_task_card_hi" } as const;

/**
 * The utility template message for one task card. Body parameters, in template
 * order: {{1}} task number, {{2}} action, {{3}} school or cluster, {{4}} owner,
 * {{5}} due date, {{6}} success measure.
 */
export function buildWhatsAppUtilityTemplate(task: Task, owner: Person | undefined, lang: "en" | "hi", to = "<owner phone in E.164>") {
  const hi = lang === "hi";
  const action = ACTION_LIBRARY[task.actionId];
  const text = (v: string) => ({ type: "text" as const, text: v.slice(0, 1024) || "—" });
  return {
    messaging_product: "whatsapp" as const,
    to,
    type: "template" as const,
    template: {
      name: WHATSAPP_TEMPLATES[lang],
      language: { code: hi ? "hi" : "en" },
      components: [
        {
          type: "body" as const,
          parameters: [
            text(String(task.id)),
            text(hi ? action.name_hi : action.name_en),
            text(hi ? task.targetLabelHi || task.targetLabel : task.targetLabel),
            text(owner ? (hi ? owner.nameHi : owner.nameEn) : "—"),
            text(task.dueDate ?? "—"),
            text(hi ? task.successHi || task.successEn : task.successEn),
          ],
        },
      ],
    },
  };
}

/** Whether this server can send WhatsApp cards at all. Server only. */
export function whatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN?.trim() && process.env.WHATSAPP_PHONE_NUMBER_ID?.trim());
}

/** Sends one task card. Server only; returns why it did not send instead of throwing. */
export async function sendWhatsAppTaskCard(task: Task, owner: Person | undefined, lang: "en" | "hi", to: string): Promise<{ sent: boolean; id?: string; reason?: string }> {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) return { sent: false, reason: "WhatsApp sending is not switched on for this block yet. The card stays on Telegram and in the block action register." };
  const phone = to.replace(/^\+/, "");
  if (!/^\d{10,15}$/.test(phone)) return { sent: false, reason: "The recipient must be a phone number in E.164 form." };
  const graph = (process.env.WHATSAPP_GRAPH_URL?.trim() || "https://graph.facebook.com").replace(/\/+$/, "");
  const res = await fetch(`${graph}/${WHATSAPP_GRAPH_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildWhatsAppUtilityTemplate(task, owner, lang, phone)),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok) return { sent: false, reason: body.error?.message ?? `Graph API error ${res.status}` };
  return { sent: true, id: body.messages?.[0]?.id };
}

type WaMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string } };
  image?: { id?: string; caption?: string };
  audio?: { id?: string };
};
type WaPayload = { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] };

export type WhatsAppReply = { from: string; id: string; timestamp: string; type: string; text: string; mediaId: string | null; parse: ReplyParse };

/** Field replies in a Meta webhook payload, each read by the offline rule baseline. */
export function parseWhatsAppWebhook(payload: unknown, openTasks = 1): WhatsAppReply[] {
  const messages = ((payload as WaPayload)?.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.messages ?? []));
  return messages.map((m) => {
    const text = (m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.image?.caption ?? "").trim();
    return {
      from: m.from ?? "",
      id: m.id ?? "",
      timestamp: m.timestamp ?? "",
      type: m.type ?? "unknown",
      text,
      mediaId: m.image?.id ?? m.audio?.id ?? null,
      parse: parseFieldReply(text, { openTasks, hasPhoto: m.type === "image" }),
    };
  });
}
