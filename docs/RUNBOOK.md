# Samiksha Saathi — runbook

## Where things live

- **Local secrets:** `.env.local` (gitignored; template in `.env.example`). Every npm script loads it via `node --env-file-if-exists=.env.local`. Fill `ANTHROPIC_API_KEY=` there yourself.
- **Database:** a Supabase project (free plan; its ref, region and host stay in `DATABASE_URL`, not in the repo). The app connects as its own app role through the transaction pooler (`<pooler-host>:6543`). That role owns the app tables, so it is not subject to RLS; Supabase `anon` has no access, `authenticated` reads only its block.
- **Bot:** @Samiksha_saathi_bot. BEO chat is set in `TELEGRAM_BEO_CHAT_ID`. An unknown chat's `/start` is logged as `[bot] /start from chat <id>`.
- **Hardening still open:** `DATABASE_URL` uses `sslmode=no-verify` (encrypted, server certificate not checked) because Supabase signs with its own root CA. To verify, download the CA from Dashboard → Database → SSL and pin it.
- **Deploy to Vercel:** add every non-empty key from `.env.local` to the Vercel project env, deploy, then run `npm run bot:webhook -- https://<host>`. While the webhook is set, local long polling stays off for this token.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | deploy (required) | Postgres (Supabase: use the pooled connection string, `?sslmode=require`). Unset in dev = in-memory PGlite. |
| `SAMIKSHA_BLOCK_ID` | optional | Block this deployment serves. Default `MP-PILOT-BLK01`. |
| `SAMIKSHA_RUN_SECRET` | deploy | Shared secret for `POST /api/samiksha/runCycle` (`x-samiksha-secret` header). Unset = endpoint returns 503. |
| `CRON_SECRET` | deploy | Vercel Cron sends it as `Authorization: Bearer …` to `/api/cron/nudge`. |
| `TELEGRAM_BOT_TOKEN` | deploy + dev | From @BotFather. Unset = no bot; cards are recorded in the DB only. |
| `TELEGRAM_BOT_USERNAME` | optional | Shown in the Follow tab. Default `SamikshaSaathiBot`. |
| `TELEGRAM_BEO_CHAT_ID` | deploy + dev | The only chat allowed to run BEO commands. |
| `TELEGRAM_WEBHOOK_SECRET` | deploy | Telegram's `X-Telegram-Bot-Api-Secret-Token` for the webhook. |
| `TELEGRAM_MODE` | optional | `webhook` stops the dev server from long polling. |
| `LAYA_URL`, `LAYA_API_KEY`, `LAYA_MODEL`, `LAYA_MIN_CONFIDENCE` | optional | Laya sidecar for reply decisions (see below). `LAYA_MODEL` default `multilingual`. |
| `ANTHROPIC_API_KEY` (+ `SAMIKSHA_CLAUDE_MODEL`, default `claude-sonnet-5`) | optional | The bounded LLM for `narrateGaps` and `parseFieldReplyLLM`. |
| `XAI_API_KEY` | optional | Original narrate provider, used when no Anthropic key is set. |
| `OLLAMA_MODEL`, `OLLAMA_URL` | optional | Local model for the same two calls on an offline box; not billed, not counted in the 100/month cap. |

## Database

- Schema: `migrations/0002_samiksha.sql` (tables), `migrations/0003_rls.sql` (BEO reads only their block via JWT claim `app_metadata.block_id`). Applied on `npm run build` (`npm run db:migrate`) and to PGlite on dev start.
- The server connects as the table owner / service role (bypasses RLS) and scopes every query by `block_id`.

## Telegram

1. Create the bot with @BotFather; set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BEO_CHAT_ID`.
2. Dev / a pilot box: `npm run dev` long-polls automatically and runs the 09:00 IST nudge.
3. Vercel: set `TELEGRAM_WEBHOOK_SECRET`, deploy, then `npm run bot:webhook -- https://<host>`.
4. BEO in Telegram: `/seed`, then a plain-text review note → drafts; `/approve 14`; `/link crcc-4 <chat id>`; `/send`.
5. Field staff send `/start` to learn their chat id; replies like "हो गया सर" update the task.

Limits: 30 cards + nudges per block per IST day; 100 billable LLM reply-parses per block per month.

## Laya sidecar (reply decisions without an LLM call)

```bash
pip install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_PORT=8765 LAYA_MODELS=multilingual laya-serve
# then: LAYA_URL=http://127.0.0.1:8765
```

On Windows without symlink rights the Hugging Face cache fails; download `convaiinnovations/laya` `multilingual/*` with `local_dir=` and register it via `LAYA_EXTRA_MODELS='{"mlocal": "<dir>/multilingual"}'`, `LAYA_MODEL=mlocal`.

Laya decides alone only when its answer matches an unambiguous cue in the reply; mixed replies go to the LLM.

## Checks

```bash
npm run typecheck
npm run build
npm run check:auth          # needs npm run dev running
npm run test:flow           # Telegram loop end to end on a fresh PGlite + mock Telegram
npm run eval:replies        # 12 Hinglish fixtures; uses LAYA_URL / LLM keys from the shell
curl -X POST -H "x-samiksha-secret: $SAMIKSHA_RUN_SECRET" http://127.0.0.1:8080/api/samiksha/runCycle
```
