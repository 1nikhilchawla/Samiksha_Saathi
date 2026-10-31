/**
 * Server functions behind the five tabs. Handlers import server modules lazily
 * so nothing server-only reaches the client bundle. The browser never runs the
 * pipeline and never holds the cycle as state: it reads these and re-fetches.
 */
import { createServerFn } from "@tanstack/react-start";
import type { ActingOfficer, CleaningAst, HingePivotId, OfficerRole, RawFile, Task } from "./engine";
import { copy, type ActionResult, type CycleData, type Lang, type LiveData } from "./types";

type Block = { blockId?: string };
type Scope = { blockId: string; cycleId: number; requestId?: string };
type TaskScope = Scope & { taskNo: number };
type Editable = Partial<Pick<Task, "actionId" | "ownerId" | "dueDate" | "successEn" | "successHi" | "whatEn" | "whatHi">>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scope(d: Scope) {
  const repo = await import("@/server/samiksha/repo.server");
  const requestId = d.requestId && UUID_RE.test(d.requestId) ? d.requestId : crypto.randomUUID();
  return { blockId: repo.assertBlockId(d.blockId), cycleId: Number(d.cycleId), requestId };
}

/**
 * The acting officer.
 *
 * The browser does not choose its own role any more: it sends the signed
 * session token the server issued, and the role comes out of that token. A
 * token that is missing, forged or expired is refused, and the request stops.
 *
 * The legacy path (a raw role string, no token) exists only for the unit tests
 * and the bot flow script, which call the server actions directly. The browser
 * cannot reach it.
 */
async function actor(d: { role?: unknown; sessionToken?: unknown }): Promise<ActingOfficer> {
  const { verifyOfficerSessionToken } = await import("@/lib/samiksha/core/sessionToken");
  const checked = await verifyOfficerSessionToken(d.sessionToken);
  if (checked.ok) {
    return {
      role: checked.claims.role,
      personId: checked.claims.personId,
      blockId: checked.claims.blockId,
      cluster: checked.claims.clusterId === "ALL" ? null : checked.claims.clusterId,
      sessionId: checked.claims.jti,
    };
  }
  const legacyAllowed = process.env.NODE_ENV === "test" || process.env.SAMIKSHA_ALLOW_CLIENT_ROLE === "1";
  if (!legacyAllowed) throw new Error(checked.message);
  const role = d.role;
  if (typeof role !== "string" || !role) throw new Error("No officer role was given.");
  return { role: role as OfficerRole, personId: String(role).toLowerCase(), blockId: "", cluster: null, sessionId: "legacy", legacy: true };
}

/** The scope, checked against the session: a session for one block cannot act on another. */
async function scopeAs(d: Scope & { role?: unknown; sessionToken?: unknown }) {
  const s = await scope(d);
  const officer = await actor(d);
  if (!officer.legacy && officer.blockId && officer.blockId !== s.blockId) {
    throw new Error("This officer session belongs to another block.");
  }
  return { ...s, officer };
}

async function block(d: Block) {
  const repo = await import("@/server/samiksha/repo.server");
  return repo.assertBlockId(d.blockId ?? repo.defaultBlockId());
}

const lang = (l: unknown): Lang => (l === "hi" ? "hi" : "en");

export const getCycle = createServerFn({ method: "GET" })
  .validator((d: Block) => d)
  .handler(async ({ data }): Promise<CycleData> => {
    const blockId = await block(data);
    const { ensureCycle } = await import("@/server/samiksha/actions.server");
    const { loadCycleData } = await import("@/server/samiksha/repo.server");
    return loadCycleData(blockId, await ensureCycle(blockId));
  });

export const getLive = createServerFn({ method: "GET" })
  .validator((d: Block) => d)
  .handler(async ({ data }): Promise<LiveData> => {
    const blockId = await block(data);
    const { ensureCycle } = await import("@/server/samiksha/actions.server");
    const { loadLive } = await import("@/server/samiksha/repo.server");
    const { loadLiveExtras } = await import("@/server/samiksha/live.server");
    const cycleId = await ensureCycle(blockId);
    return { ...(await loadLive(blockId, cycleId)), ...(await loadLiveExtras(blockId, cycleId)) };
  });

/** The server-function face of POST /api/samiksha/runCycle. */
export const runCycleFn = createServerFn({ method: "POST" })
  .validator((d: Block & { files?: RawFile[]; requestId?: string }) => d)
  .handler(async ({ data }) => {
    const blockId = await block(data);
    const { runCycle } = await import("@/server/samiksha/runPipeline.server");
    const files = data.files?.filter((f) => typeof f?.name === "string" && typeof f?.csv === "string");
    // The browser checks sizes on pick; this is the same limit for whatever arrives.
    const { validateFileSize } = await import("./engine");
    for (const f of files ?? []) {
      const size = validateFileSize({ name: f.name, sizeBytes: new TextEncoder().encode(f.csv).length, kind: "spreadsheet" });
      if (!size.ok) throw new Error(size.diagnostic.explanation.whyFailed.en);
    }
    return runCycle({ blockId, files, clientRequestId: data.requestId && UUID_RE.test(data.requestId) ? data.requestId : undefined });
  });

export const extractFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { transcript: string; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { extractDrafts } = await import("@/server/samiksha/actions.server");
    return extractDrafts(s.blockId, s.cycleId, String(data.transcript ?? ""), s.requestId, s.officer);
  });

/** A draft task for one Top 10 / Top 15 watchlist gap, from the brief. */
export const watchlistDraftFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { gapId: string; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { draftWatchlistGap } = await import("@/server/samiksha/actions.server");
    return draftWatchlistGap(s.blockId, s.cycleId, String(data.gapId ?? ""), s.requestId, s.officer);
  });

export const updateTaskFn = createServerFn({ method: "POST" })
  .validator((d: TaskScope & { patch: Editable; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { updateTask } = await import("@/server/samiksha/actions.server");
    return updateTask(s.blockId, s.cycleId, Number(data.taskNo), data.patch ?? {}, s.officer);
  });

export const taskActionFn = createServerFn({ method: "POST" })
  .validator((d: TaskScope & { action: "approve" | "reject" | "restore" | "escalate"; lang?: Lang; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const a = await import("@/server/samiksha/actions.server");
    const role = s.officer;
    const no = Number(data.taskNo);
    if (data.action === "approve") return a.approveTask(s.blockId, s.cycleId, no, role);
    if (data.action === "reject") return a.rejectTask(s.blockId, s.cycleId, no, role);
    if (data.action === "restore") return a.restoreTask(s.blockId, s.cycleId, no, role);
    if (data.action === "escalate") {
      const r = await a.escalateTask(s.blockId, s.cycleId, no, lang(data.lang), s.requestId, role);
      if (!r.ok) return r;
      const { notifyEscalation } = await import("../../../server/bot/telegram");
      const told = await notifyEscalation(s.blockId, s.cycleId, no, s.requestId);
      return {
        ...r,
        gate: told.sent
          ? copy(`Task #${no} escalated. The DEO was told on Telegram.`, `कार्य #${no} अग्रेषित। DEO को टेलीग्राम पर सूचना गई।`)
          : copy(`Task #${no} escalated. The DEO was not told on Telegram: ${told.reason.en}.`, `कार्य #${no} अग्रेषित। DEO को टेलीग्राम सूचना नहीं गई: ${told.reason.hi}।`),
      };
    }
    throw new Error("Unknown action.");
  });

/** The DEO closes a teacher vacancy. Only the DEO's role may call this. */
export const resolveVacancyFn = createServerFn({ method: "POST" })
  .validator((d: TaskScope & { role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { resolveVacancy } = await import("@/server/samiksha/actions.server");
    return resolveVacancy(s.blockId, s.cycleId, Number(data.taskNo), s.officer);
  });

/**
 * Run one hinge pivot: the server re-derives the hinge point from the database,
 * applies the change, writes the audit row and hands back the escalated task
 * numbers. HP-4 tells the DEO on Telegram, so the caller asks first.
 */
export const hingePivotFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { pivotId: HingePivotId; role?: OfficerRole; sessionToken?: string; lang?: Lang; notifyTelegram?: boolean }) => d)
  .handler(async ({ data }): Promise<ActionResult & { escalated: number[]; notified: boolean }> => {
    const s = await scopeAs(data);
    const { executeHingePivotAction } = await import("@/server/samiksha/actions.server");
    const r = await executeHingePivotAction(s.blockId, s.cycleId, data.pivotId, s.officer, lang(data.lang), s.requestId);
    if (!r.ok || !r.escalated.length || data.notifyTelegram === false) return { ...r, notified: false };
    const { notifyEscalation } = await import("../../../server/bot/telegram");
    let notified = false;
    for (const no of r.escalated) {
      const told = await notifyEscalation(s.blockId, s.cycleId, no, s.requestId);
      notified = notified || told.sent;
    }
    return { ...r, notified };
  });

export const dispatchFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { lang?: Lang; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult & { sent: number }> => {
    const s = await scopeAs(data);
    const { dispatchApproved } = await import("../../../server/bot/telegram");
    return dispatchApproved(s.blockId, s.cycleId, lang(data.lang), s.requestId, s.officer);
  });

export const cycleActionFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { action: "jumpOverdue" | "closeLoop" | "guardrailTest" | "approveAllReady"; lang?: Lang; devanagari?: boolean; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const a = await import("@/server/samiksha/actions.server");
    if (data.action === "jumpOverdue") return a.jumpOverdue(s.blockId, s.cycleId, s.requestId);
    if (data.action === "closeLoop") return a.closeLoop(s.blockId, s.cycleId, lang(data.lang), s.requestId, s.officer);
    if (data.action === "approveAllReady") return a.approveAllReady(s.blockId, s.cycleId, s.officer);
    if (data.action === "guardrailTest") return a.logGuardrailTest(s.blockId, s.cycleId, Boolean(data.devanagari), s.requestId);
    throw new Error("Unknown action.");
  });

/**
 * Commit a cleaning rule to the cycle's school records. Only the compiled rule
 * travels; the server re-applies it to its own copy and logs each value it changes.
 */
export const commitCleaningFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { ast: CleaningAst; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult & { changed: number }> => {
    const s = await scopeAs(data);
    const { commitCleaningCopy } = await import("@/server/samiksha/actions.server");
    return commitCleaningCopy(s.blockId, s.cycleId, data.ast, s.officer, s.requestId);
  });

/**
 * The cleaning studio's third tier: compile one rule with the model. The model
 * may only answer with the AST fields; the server sanitises it and the browser
 * applies it to a working copy. The monthly cap is read from the same ledger the
 * other model calls use.
 */
export const cleaningModelFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { instruction: string; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    // A billable call on the app owner's key: only the officer who cleans the block files may spend it.
    const { RoleForbiddenError, canPerform } = await import("./engine");
    const role = s.officer;
    const right = canPerform(role.role, "upload_block_files");
    if (!right.allowed) throw new RoleForbiddenError({ en: `${role.role}: ${right.reasonEn}`, hi: `${role.role}: ${right.reasonHi}` });
    const { getSql } = await import("@/lib/db");
    const { insertLlmCall, istToday, stableUuid } = await import("@/server/samiksha/repo.server");
    const { CLEANING_MODEL_MONTHLY_LIMIT, compileCleaningRuleWithModel } = await import("./cleaningLlm.server");
    const sql = await getSql();
    const monthStart = `${istToday().slice(0, 7)}-01`;
    const [usage] = await sql<{ n: number }>`
      select count(*)::int as n from llm_calls
      where block_id = ${s.blockId} and purpose = 'cleaning_rule' and billable
        and created_at >= (${monthStart}::date - interval '330 minutes')`;
    const left = CLEANING_MODEL_MONTHLY_LIMIT - Number(usage?.n ?? 0);
    const { scanPromptInjection } = await import("./engine");
    const { logPromptInjection } = await import("@/server/samiksha/diagnostics.server");
    await logPromptInjection(sql, s.blockId, s.cycleId, "cleaning rule", scanPromptInjection(String(data.instruction ?? "")).detections, s.requestId);
    const r = await compileCleaningRuleWithModel(String(data.instruction ?? ""), left);
    if (r.billable) {
      await insertLlmCall(sql, {
        blockId: s.blockId, requestId: stableUuid(s.requestId, "cleaning"), cycleId: s.cycleId, purpose: "cleaning_rule",
        model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, passed: r.understood, simulated: false, billable: true,
        note: r.note, detail: r.ast,
      });
    }
    return r;
  });

/** BEO voice note from the browser recorder -> transcript (Sarvam / Bhashini / Whisper, or empty when none is set up). */
export const transcribeFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { audioBase64: string; mimeType: string; lang?: Lang; durationSeconds?: number }) => d)
  .handler(async ({ data }) => {
    if (typeof data.audioBase64 !== "string" || !data.audioBase64) throw new Error("Audio missing.");
    const { base64Bytes, validateFileSize } = await import("./engine");
    const size = validateFileSize({ name: "voice note", sizeBytes: base64Bytes(data.audioBase64), kind: "audio" });
    if (!size.ok) throw new Error(size.diagnostic.explanation.whyFailed.en);
    const s = await scope(data);
    const { transcribeAudio } = await import("./stt.server");
    const heard = await transcribeAudio({
      audioBase64: data.audioBase64,
      mimeType: String(data.mimeType || "audio/webm"),
      lang: lang(data.lang),
      durationSeconds: Math.max(0, Number(data.durationSeconds) || 0),
    });
    if (heard.provider !== "offline") {
      const { getSql } = await import("@/lib/db");
      const { insertLlmCall, stableUuid } = await import("@/server/samiksha/repo.server");
      await insertLlmCall(await getSql(), {
        blockId: s.blockId, requestId: stableUuid(s.requestId, "stt"), cycleId: s.cycleId, purpose: "speech_to_text", model: heard.provider,
        tokensIn: 0, tokensOut: 0, inr: heard.costInr, passed: Boolean(heard.transcript), simulated: false, billable: heard.costInr > 0,
        note: `${Math.round(heard.durationSeconds)} s voice note`,
      });
    }
    return heard;
  });

/** The weekly pending-task digest, now: the BEO and every linked owner with open work, through the fact-checked queue. */
export const digestFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { sendWeeklyDigest } = await import("../../../server/bot/telegram");
    return sendWeeklyDigest(s.blockId, s.officer, s.requestId);
  });

/** A fact-checked appreciation card to one field worker (level 3 and above). */
export const appreciationFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { personId: string; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { sendAppreciation } = await import("../../../server/bot/telegram");
    return sendAppreciation(s.blockId, s.cycleId, String(data.personId ?? ""), s.officer, s.requestId);
  });

/** Fill a draft's missing owner and due date (roster rule, checked against Laya when it runs), and approve when asked. */
export const layaFillFn = createServerFn({ method: "POST" })
  .validator((d: TaskScope & { approve?: boolean; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { applyLayaAutofill } = await import("@/server/samiksha/assist.server");
    return applyLayaAutofill(s.blockId, s.cycleId, Number(data.taskNo), s.officer, Boolean(data.approve));
  });

export const todosFn = createServerFn({ method: "GET" })
  .validator((d: Block & { role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const blockId = await block(data);
    const officer = await actor(data);
    const { listTodos } = await import("@/server/samiksha/assist.server");
    return listTodos(blockId, officer);
  });

export const todoActionFn = createServerFn({ method: "POST" })
  .validator((d: Block & { role?: OfficerRole; sessionToken?: string; requestId?: string; add?: string; id?: number; done?: boolean | null }) => d)
  .handler(async ({ data }) => {
    const blockId = await block(data);
    const a = await import("@/server/samiksha/assist.server");
    const role = await actor(data);
    if (typeof data.add === "string") await a.addTodo(blockId, role, data.add, data.requestId && UUID_RE.test(data.requestId) ? data.requestId : crypto.randomUUID());
    else if (typeof data.id === "number") await a.setTodo(blockId, role, data.id, data.done ?? null);
    return a.listTodos(blockId, role);
  });

/** Log a failure the browser caught (size limit, student-data guard, photo check) so /why can explain it. */
export const logFailureFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { code: string; surface: string; facts: Record<string, unknown> }) => d)
  .handler(async ({ data }) => {
    const s = await scope(data);
    const { logClientFailure } = await import("@/server/samiksha/diagnostics.server");
    return logClientFailure(s.blockId, s.cycleId, String(data.code), String(data.surface), data.facts, s.requestId);
  });

/** /why on screen: the latest failure, reworded plainly by the model when one is set up and the cap allows. */
export const explainFailureFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { RoleForbiddenError, canPerform } = await import("./engine");
    const role = s.officer;
    const right = canPerform(role.role, "ask_failure_why");
    if (!right.allowed) throw new RoleForbiddenError({ en: `${role.role}: ${right.reasonEn}`, hi: `${role.role}: ${right.reasonHi}` });
    const { explainFailureWithModel, latestFailure } = await import("@/server/samiksha/diagnostics.server");
    const entry = await latestFailure(s.blockId);
    if (!entry) return { entry: null, note: "No failure recorded." };
    return explainFailureWithModel(s.blockId, s.cycleId, entry, s.requestId);
  });

/**
 * Store a blurred, compressed classroom proof, encrypted on the server (tier 1
 * signed by the uploader). The server decodes the photo and checks it again; a
 * refusal comes back as 422 with the reason, whatever the browser claimed.
 */
export const proofStoreFn = createServerFn({ method: "POST" })
  .validator((d: Scope & {
    role?: OfficerRole; sessionToken?: string; taskNo?: number | null; schoolCode?: string | null; mime: string; imageBase64: string; originalBytes: number;
    decisionCode?: string; decisionConfidence?: number; personCount?: number; width?: number; height?: number;
  }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { storeProof } = await import("@/server/samiksha/proofs.server");
    const result = await storeProof({
      blockId: s.blockId, cycleId: s.cycleId, requestId: s.requestId, role: s.officer, taskNo: data.taskNo ?? null, schoolCode: data.schoolCode ?? null,
      mime: String(data.mime), imageBase64: String(data.imageBase64 ?? ""), originalBytes: Number(data.originalBytes),
      claimed: { decisionCode: data.decisionCode, decisionConfidence: data.decisionConfidence, personCount: data.personCount, width: data.width, height: data.height },
    });
    if (result.httpStatus === 422) {
      const { setResponseStatus } = await import("@tanstack/react-start/server");
      setResponseStatus(422);
    }
    return result;
  });

/** Send one approved or sent task as a WhatsApp utility template, and link the number to its owner. */
export const whatsappCardFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { taskNo: number; phone: string; lang: Lang; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { sendWhatsAppCard } = await import("@/server/samiksha/whatsapp.server");
    return sendWhatsAppCard({
      blockId: s.blockId, cycleId: s.cycleId, taskNo: Number(data.taskNo), phone: String(data.phone ?? ""), lang: data.lang === "hi" ? "hi" : "en",
      role: s.officer, requestId: s.requestId,
    });
  });

/** Level 5 only: re-encrypt the block's stored proofs under the current media key. */
export const proofRotateKeysFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { rotateBlockMediaKeys } = await import("@/server/samiksha/proofs.server");
    return rotateBlockMediaKeys(s.blockId, s.officer);
  });

export const proofSignFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { proofId: number; tier: 2 | 3; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }): Promise<ActionResult> => {
    const s = await scopeAs(data);
    const { signProof } = await import("@/server/samiksha/proofs.server");
    return signProof(s.blockId, Number(data.proofId), data.tier === 3 ? 3 : 2, s.officer);
  });

export const proofOpenFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { proofId: number; role?: OfficerRole; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { openProof } = await import("@/server/samiksha/proofs.server");
    return openProof(s.blockId, Number(data.proofId), s.officer);
  });

/**
 * Issue an officer session.
 *
 * The browser asks for a session for the role it wants to preview; the server
 * picks the person from the cycle roster, signs the token and hands it back.
 * From then on the browser sends the token, not a role.
 */
export const issueOfficerSessionFn = createServerFn({ method: "POST" })
  .validator((d: Block & { role: OfficerRole; cluster?: string | null }) => d)
  .handler(async ({ data }) => {
    const blockId = await block(data);
    const { mintSessionToken, personForRole, toSession, logSessionIssued } = await import("@/server/samiksha/session.server");
    const { ensureCycle } = await import("@/server/samiksha/actions.server");
    const { loadCycleData } = await import("@/server/samiksha/repo.server");
    const cycleId = await ensureCycle(blockId);
    const cycle = await loadCycleData(blockId, cycleId);
    const who = personForRole(cycle.cycle.people, data.role, data.cluster ?? null);
    const { token, claims } = await mintSessionToken({ role: data.role, blockId, personId: who.personId, clusterId: who.clusterId });
    await logSessionIssued(blockId, claims);
    return toSession(token, claims);
  });

/** The CRCC's own rung: log what the cluster looks like this week. */
export const clusterObservationFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { note: string; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { recordClusterObservation } = await import("@/server/samiksha/actions.server");
    return recordClusterObservation(s.blockId, s.cycleId, String(data.note ?? ""), s.officer, s.requestId);
  });

/** The CRCC's own rung: a nudge to the schools of one cluster. */
export const clusterNudgeFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { cluster?: string | null; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { sendClusterNudge } = await import("@/server/samiksha/actions.server");
    return sendClusterNudge(s.blockId, s.cycleId, data.cluster ?? null, s.officer, s.requestId);
  });

/**
 * Move every open task of one cluster to another owner in a single step, for a
 * mid-cycle transfer. The new owner may be an acting officer who is not yet on
 * the roster, so the server can add one.
 */
export const bulkReassignFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { cluster?: string | null; toOwnerId: string; toOwnerName?: string; reason?: string; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { bulkReassignClusterTasks } = await import("@/server/samiksha/actions.server");
    return bulkReassignClusterTasks({
      blockId: s.blockId,
      cycleId: s.cycleId,
      fromOwnerIdOrCluster: data.cluster ?? null,
      actingOfficer: {
        id: String(data.toOwnerId ?? ""),
        nameEn: String(data.toOwnerName ?? ""),
        nameHi: String(data.toOwnerName ?? ""),
        role: "CRCC",
        scope: data.cluster ?? null,
      },
      reason: String(data.reason ?? ""),
      role: s.officer,
      requestId: s.requestId,
    });
  });

/** The DEO's district view: every block in the district, on the same axes. */
export const districtViewFn = createServerFn({ method: "GET" })
  .validator((d: Block & { sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const blockId = await block(data);
    const officer = await actor(data);
    if (!officer.legacy && officer.blockId && officer.blockId !== blockId) {
      throw new Error("This officer session belongs to another block.");
    }
    const { loadDistrictView } = await import("@/server/samiksha/district.server");
    return loadDistrictView(blockId, officer);
  });

/** The SPD's exclusive power: change a threshold for this block at runtime. */
export const updateThresholdsFn = createServerFn({ method: "POST" })
  .validator((d: Scope & { key: string; value: number; sessionToken?: string }) => d)
  .handler(async ({ data }) => {
    const s = await scopeAs(data);
    const { updateConfigThresholds } = await import("@/server/samiksha/actions.server");
    return updateConfigThresholds(s.blockId, String(data.key ?? ""), Number(data.value), s.officer, s.requestId);
  });
