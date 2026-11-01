# Samiksha Saathi — Architecture, Intent and Trade-Offs

**State of the code:** 29 Oct 2026, after the jury-audit fixes (Defects A–Y, Moves 1–4).
**Tests:** `npm test` → 133/133 TypeScript tests (74 in the engine suite). The template's own `scripts/**/*.test.mjs` suite runs separately (`npm run test:template`); some of it fails outside the app-builder sandbox (symlink permission and share-card tests) and predates this work. `npm run test:flow` → 64/64 checks on an in-memory database. Tone, prompt-injection and offline evidence is in `docs/DECK_RUBRIC_EVIDENCE_AND_EVALS.md`.
**Citations** are generated: this file is rendered from `docs/ARCHITECTURE_AND_INTENT_REPORT.template.md` by `npm run docs:report`, which looks each one up in the current code and refuses to render a citation it cannot find. `npm run docs:report -- --check` fails when the report is out of date.

**Benchmark, in the words the app also uses:** 4 state VSK format adapters (MP, UP, PB, HR), checked on a 33-block multi-format test and on a 313-block scale run of the seeded block (median under 10 ms a block), all on synthetic data.

---

## 0. Deterministic engine

- **Every number comes from code.** `runPipeline` reads the exports, cleans them and computes the gaps (src/lib/samiksha/core/pipeline.ts:424). The trust meter re-runs it on the stored files and requires identical facts (src/lib/samiksha/core/trustMeter.ts:66).
- **Slide 3 is a tested contract:** 7 files, 110 schools, 3 years, 548 rows, 9 problems, 110 auto-fixed, 4 flags, under 0.1 s (src/lib/samiksha/samiksha.test.ts:45).
- **Scale:** the seeded block run 313 times finishes in under 2.5 s, median under 10 ms a block (src/lib/samiksha/samiksha.test.ts:55).
- **The review date is the upload's own.** An upload is measured from its review day; the seeded run keeps 30 Nov 2025 (src/lib/samiksha/core/pipeline.ts:434, passed by src/server/samiksha/runPipeline.server.ts:77).
- **Hygiene:** the latest visit wins whatever the row order (src/lib/samiksha/core/pipeline.ts:269); full English and Hindi month names are read (src/lib/samiksha/core/pipeline.ts:251); a file without the vacancy column leaves the post "Unknown" instead of "Filled" (src/lib/samiksha/core/pipeline.ts:92).
- **Small samples:** a Grade 3 roll from 1 to 4 is marked as noise; 0 means the count was not in the file and is not marked (src/lib/samiksha/core/smallSample.ts:26); the pipeline sets the flag on every school row (src/lib/samiksha/core/pipeline.ts:450).

**Why:** an officer must be able to re-derive any figure in the brief; a model is never the source of a number.

## 1. State formats, privacy and upload limits

- **Profiles and detection:** `STATE_CODES` lists the four adapters (src/lib/samiksha/core/stateFormats.ts:154); a file's state is detected from its headers (src/lib/samiksha/core/stateFormats.ts:189) and its scale converted at ingest (src/lib/samiksha/core/stateFormats.ts:200).
- **The 33-block test** runs the seed in all four formats; Haryana's assumed level banding loses one gap, and the test pins that (src/lib/samiksha/samiksha.test.ts:371).
- **Student data is refused** on headers and on Aadhaar- or PEN-shaped values (src/lib/samiksha/core/ingest.ts:127). A Grade 3 count column ("कक्षा 3 छात्र", `student_count`) is aggregate data and is read as `g3_students`, not refused (src/lib/samiksha/core/ingest.ts:99).
- **Limits:** 5 MiB a file and 25 MiB an upload, the same in the browser and on the server (src/lib/samiksha/core/uploadLimits.ts:9, src/server/samiksha/runPipeline.server.ts:56); at most 10,000 data rows a file (src/lib/samiksha/core/ingest.ts:190).

**Caveat:** the four profiles are built from sample exports, not verified state systems. A deployed Vercel function also caps a request body well below 25 MiB.

## 2. Classroom photo proof

- **On the phone:** skin-colour blobs estimate the faces (src/lib/samiksha/core/visionGuard.ts:201), each face box is pixelated (src/lib/samiksha/core/visionGuard.ts:271), and only that copy is compressed, always as JPEG (src/components/samiksha/proof-gate.tsx:93). It is a heuristic, not a trained face detector.
- **On the server (Defect A):** the server decodes the JPEG it received and runs the checks again on those pixels (src/lib/samiksha/core/cvPipeline.ts:133). Nothing the browser says about the photo is read; the stored decision, confidence and child count are the server's own (src/server/samiksha/proofs.server.ts:141). A refusal answers 422 (src/lib/samiksha/api.ts:376).
- **The vault (Defect B):** AES-256-GCM, bound to its row. There is no key derived from anything public: without `SAMIKSHA_MEDIA_KEY` a development machine uses a random local key and production stores nothing (src/server/samiksha/proofs.server.ts:56). The SPD's rotation re-encrypts every proof under the current key (src/server/samiksha/proofs.server.ts:208, using src/lib/samiksha/core/proofVault.ts:122); the button is on the proof screen (src/components/samiksha/proof-gate.tsx:391).
- **Consent:** three tiers, each signed by a higher level than the one below; opening needs level 3 and tier 2, the state level also tier 3 (src/lib/samiksha/core/proofVault.ts:39).
- **Tests:** the stored JPEG of a close-up and of a dark photo are refused (src/lib/samiksha/samiksha.test.ts:1383); a forged "accepted" label is refused end to end (scripts/verify-bot-flow.mjs:261); a rotation re-encrypts and the old key can go (scripts/verify-bot-flow.mjs:289).

**Caveat:** the server cannot prove the faces were blurred, because they arrive already pixelated; it re-measures what it will store.

## 3. Officer levels and sessions

- **Five cumulative levels** (HM 1 to SPD 5): src/lib/samiksha/core/rbac.ts:23; each action's minimum level: src/lib/samiksha/core/rbac.ts:52; `canPerform` returns a decision object, so every caller reads `.allowed` (src/lib/samiksha/core/rbac.ts:128). The district view now really is level 4 and above (Defect C, src/components/samiksha/district-command.tsx:23).
- **Signed sessions:** the server reads the role from an HMAC-SHA256 token (src/lib/samiksha/core/sessionToken.ts:128, checked in src/lib/samiksha/api.ts:34). The database checks the declared role on task writes (migrations/0008_queue_proofs_rewards.sql:128).
- **One next step per role:** the mission strip under the role bar (src/components/samiksha/role-mission-strip.tsx:15).

**Caveat:** there is no sign-in yet. The server still issues a session for whichever role the preview asks for (src/lib/samiksha/api.ts:425), so the token proves which session acted, not who the person is.

## 4. Hinge points

- At most five, each linked to the stage that resolves it (src/lib/samiksha/core/hingePoints.ts:74; rules in src/lib/samiksha/core/hingePoints.ts:354; the no-visit trigger is src/lib/samiksha/core/hingePoints.ts:76 days).

## 5. Trust meter and workload split

- **Baseline design split** across the five stages, and **the Laya-assisted design target** of 92 / 8 (src/lib/samiksha/core/trustMeter.ts:63), now both on screen (Defect G, src/components/samiksha/insight-panels.tsx:74), beside the share measured on the cycle (src/lib/samiksha/core/trustMeter.ts:169).

**Caveat:** both splits are design targets, and the screen says so; only the measured share is a measurement.

## 6. Feedback-loop monitor

- Six break points with live status (src/lib/samiksha/core/loopHealth.ts:49).

## 7. Data-cleaning studio

- Fixed patterns first (src/lib/samiksha/core/cleaningStudio.ts:124), applied to a copy (src/lib/samiksha/core/cleaningStudio.ts:186); a bounded model call only when the officer asks and both on-device tiers failed, capped per month and second-checked (src/lib/samiksha/cleaningLlm.server.ts:17).

## 8. The Claude reorder of the brief

- **Code picks the list, Claude orders it** (src/lib/samiksha/narrate.ts:104).
- **Cache before cap (Defect J):** the stored order for the same list is served first and is free (src/lib/samiksha/narrate.ts:157); only a new order meets the monthly cap (src/lib/samiksha/narrate.ts:174), which counts asks, not retries (src/lib/samiksha/narrate.ts:42). The brief shows the asks left (src/components/samiksha/brief-tab.tsx:261).
- **Five checks (Defect I, plus tone):** number fidelity, action library validity, citation completeness, target preservation, tone and safety; confidence is passed / 5 (src/lib/samiksha/core/layaEngine.ts:215). An order is applied only at 5 of 5, so a stored order reads 100%; a refused one reports its score.
- **Task cards show their own confidence (Defect H):** owner and due-date confidence from the governance fill, not the brief's score (src/components/samiksha/approve-tab.tsx:307).
- **Tests:** scripts/verify-bot-flow.mjs:319, scripts/verify-bot-flow.mjs:330, src/lib/samiksha/samiksha.test.ts:1477.

## 9. Delivery: fact-check, queue, Telegram, WhatsApp

- **Fact-check before the queue:** numbers, school names, dates, the task's state, and now the action and its evidence (Defect F, src/lib/samiksha/core/telegramFactCheck.ts:118). A minus sign is part of the claim: "-34%" does not pass on "34%" (Defect T, src/lib/samiksha/core/guards.ts:15).
- **Queue:** at most 25 a second, one a second per chat (src/lib/samiksha/core/messageQueue.ts:16).
- **WhatsApp (Defect L):** Meta's handshake and signed replies at src/routes/api/whatsapp/webhook.ts:9; the signature check (src/server/samiksha/whatsapp.server.ts:30); replies recorded with the Telegram rules (src/server/samiksha/whatsapp.server.ts:40); a number moves a task only after the BEO's card links it (migrations/0012_whatsapp.sql:8; screen: src/components/samiksha/follow-tab.tsx:237).

**Caveat:** WhatsApp sends nothing until Meta approves the templates and the keys are set; migration 0012 reaches the live database on the next `npm run build`.

## 10. Rewards and coaching

- Points only from verified outcomes; a "done" that Round 4 does not bear out is held, and a coaching note goes instead (Defect K, src/lib/samiksha/core/habitRewards.ts:146, sent by server/bot/telegram.ts:263, shown with src/components/samiksha/todo-rewards-panel.tsx:107).
- The closure card states when it is below the 80% target and what the loop caught (Defect P, src/components/samiksha/score-tab.tsx:83).

## 11. Explaining the system

- **How it works:** eight layers, one school traced end to end (PS Khedi, PS Sitapur, Cluster C6) and the jury's questions (src/components/samiksha/architecture-panel.tsx:150), with a line under each stage (src/components/samiksha/architecture-panel.tsx:21).
- **Integrations and roadmap**, each row marked by what is actually running (src/components/samiksha/roadmap-panel.tsx:19).

---

## Jury-audit defects and where each is fixed

| Defect | Fix | Where |
|---|---|---|
| A | Server re-checks the decoded photo; 422 on refusal | src/lib/samiksha/core/cvPipeline.ts:133 |
| B | No public-derived key; SPD rotation wired | src/server/samiksha/proofs.server.ts:208 |
| C | Role guards read `.allowed` | src/components/samiksha/district-command.tsx:23 |
| D | A roll of 0 is unknown, not noise | src/lib/samiksha/core/smallSample.ts:28 |
| E | Upload review date threaded | src/lib/samiksha/core/pipeline.ts:434 |
| F | Fact-check checks the action and citations | src/lib/samiksha/core/telegramFactCheck.ts:118 |
| G | 92 / 8 shown beside the baseline | src/components/samiksha/insight-panels.tsx:74 |
| H | Task cards show their own confidence | src/components/samiksha/approve-tab.tsx:307 |
| I | Five named ranking checks | src/lib/samiksha/core/layaEngine.ts:215 |
| J | Cache before the cap; asks counted once | src/lib/samiksha/narrate.ts:157 |
| K | Held reward sends a coaching note | server/bot/telegram.ts:263 |
| L | WhatsApp route and card | src/routes/api/whatsapp/webhook.ts:9 |
| M, N | One byte limit; 10,000-row cap | src/lib/samiksha/core/uploadLimits.ts:13 |
| O | Grade 3 counts are not PII | src/lib/samiksha/core/ingest.ts:99 |
| P | Below-target closure badge | src/components/samiksha/score-tab.tsx:83 |
| Q | Small-sample flag set on school rows | src/lib/samiksha/core/pipeline.ts:450 |
| R | Missing vacancy column → "Unknown" | src/lib/samiksha/core/pipeline.ts:92 |
| S | Latest visit kept; full month names | src/lib/samiksha/core/pipeline.ts:251 |
| T | Sign-aware number check | src/lib/samiksha/core/guards.ts:15 |
| U | This report, generated from the code | scripts/render-architecture-report.mjs:31 |
| V | grok-4.5 priced | src/lib/samiksha/core/config.ts:16 |
| W | One threshold editor (Stage 1) | src/components/samiksha/upload-tab.tsx:431 |
| X | Roles in ladder order; header comment corrected | src/lib/samiksha/core/rbac.ts:22 |
| Y | Budget figure tied to the projection; tests read `STATE_CODES` | src/lib/samiksha/core/config.ts:78 |

---

## Jury Q&A

1. **"Can the AI invent a number?"** No figure comes from a model. Code computes every number and the model only orders and words; a digit not in the facts is refused (src/lib/samiksha/core/layaEngine.ts:215).
2. **"Can someone pose as a senior officer?"** The server reads the role from a signed session, not from the browser. There is no sign-in yet, and the preview issues a session for the role it is asked for; sign-in is the next step.
3. **"How are children protected?"** School-level data only; a proof photo is blurred on the phone, checked again on the server, encrypted, and opened only after consent at two levels.
4. **"Does it scale?"** 4 state VSK format adapters (MP, UP, PB, HR), checked on a 33-block multi-format test and on a 313-block scale run of the seeded block (median under 10 ms a block), all on synthetic data.
5. **"What does it cost?"** About ₹102.51 of model tokens per block a month before the 2x buffer and speech-to-text (src/lib/samiksha/core/scorecard.ts:271).
6. **"What if someone just says done?"** Round 4 checks the outcome; a flat "done" is held and a coaching note goes instead.
7. **"Is the data real?"** No: a synthetic pilot block of 110 schools in the shape of real exports, with no student data.
