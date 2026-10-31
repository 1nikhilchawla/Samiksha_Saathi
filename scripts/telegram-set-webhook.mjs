#!/usr/bin/env node
/**
 * Point the Telegram bot at a deployed app: npm run bot:webhook -- https://your-app.vercel.app
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment.
 * Long polling (npm run dev) stops working for this token until the webhook is deleted.
 */
const base = process.argv[2]?.replace(/\/+$/, "");
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
if (!base?.startsWith("https://") || !token || !secret) {
  console.error("usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… npm run bot:webhook -- https://<host>");
  process.exit(2);
}
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: `${base}/api/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "edited_message"] }),
});
const body = await res.json();
console.log(body.ok ? `webhook set: ${base}/api/telegram/webhook` : `failed: ${body.description}`);
process.exit(body.ok ? 0 : 1);
