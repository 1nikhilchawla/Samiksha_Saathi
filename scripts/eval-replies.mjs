#!/usr/bin/env node
/**
 * The 12 Hinglish field-reply fixtures for parseFieldReplyLLM. Uses whatever
 * decision makers this shell has: Laya (LAYA_URL), then the bounded LLM
 * (ANTHROPIC_API_KEY or XAI_API_KEY), then the rule baseline.
 * Run: npm run eval:replies   (exit 1 unless all 12 match)
 */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const FIXTURES = [
  { action: "tarl", text: "हो गया सर, फोटो संलग्न है", photo: true, want: "done" },
  { action: "no_visit", text: "सर आज 3 स्कूल गए, 2 में maths हुआ, एक छुट्टी पे थी", want: "partial", units: 2 },
  { action: "tarl", text: "done 75%", want: "partial" },
  { action: "tarl", text: "teacher transfer ho gaya, naye ko bata dena", want: "blocked" },
  { action: "tarl", text: "Sir camp complete ho gaya, sab bacche aaye the", want: "done" },
  { action: "no_visit", text: "aadha kaam hua hai, 5 school baaki hai", want: "partial", units: 9 },
  { action: "no_visit", text: "BLO duty lagi hai sir, is hafte nahi ho payega", want: "blocked" },
  { action: "no_visit", text: "14 में से 10 स्कूलों में अवलोकन हो गया", want: "partial", units: 10 },
  { action: "data_check", text: "spot check kar liya, 10 bacchon ki sheet upload kar di", want: "done" },
  { action: "tarl", text: "ok sir 👍", want: "unknown" },
  { action: "attendance", text: "Ek school me SMC baithak ho gayi, baaki do me agle hafte", want: "partial", units: 1 },
  { action: "no_visit", text: "sir network nahi hai, kal baat karte hain", want: "unknown" },
];

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  resolve: { tsconfigPaths: true },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
});
const engine = await vite.ssrLoadModule("/src/lib/samiksha/engine.ts");
const { parseFieldReplyAudited } = await vite.ssrLoadModule("/src/lib/samiksha/parseReply.ts");

// The seeded cycle's five approved tasks, as they stand right after the cards go out.
const cycle = engine.loadSeededCycle();
const tasks = engine.canonicalFieldTasks(cycle).map((t) => ({ ...t, status: "sent", completedAt: null, unitsDone: 0 }));

let hits = 0;
for (const [i, f] of FIXTURES.entries()) {
  const task = tasks.find((t) => t.actionId === f.action);
  const audit = await parseFieldReplyAudited(
    {
      task_id: task.id,
      action_id: task.actionId,
      what_en: task.whatEn,
      target_label: task.targetLabel,
      success_en: task.successEn,
      success_hi: task.successHi,
      units_total: task.targetCodes.length,
      units_done: 0,
      open_tasks: 1,
      today: engine.REVIEW_DATE,
      llm_budget_left: 100,
      tasks,
    },
    f.text,
    Boolean(f.photo),
  );
  const p = audit.parse;
  const unitsOk = f.units === undefined || audit.proposed?.unitsDone === f.units;
  const ok = p.parsed_status === f.want && unitsOk && Boolean(p.reason_en) && audit.attempts.length > 0;
  if (ok) hits += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${String(i + 1).padStart(2)}. [${f.action}] ${f.text}`);
  console.log(`      want ${f.want}${f.units !== undefined ? ` (${f.units} schools)` : ""} · got ${p.parsed_status} @ ${p.confidence.toFixed(2)}${audit.proposed ? ` (${audit.proposed.unitsDone} schools)` : ""} · via ${audit.source}`);
  console.log(`      reason: ${p.reason_en}`);
  console.log(`      audit: ${audit.attempts.map((a) => `${a.stage}:${a.ok ? "ok" : "no"}(${a.reason})`).join(" → ")}`);
}
await vite.close();
console.log(`\n${hits}/${FIXTURES.length} fixtures classified correctly`);
process.exit(hits === FIXTURES.length ? 0 : 1);
