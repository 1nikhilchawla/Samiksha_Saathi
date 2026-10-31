/**
 * The tabs' read-only mirror of the database (React Query) and the actions
 * that change it (server functions). Nothing here holds the cycle as state.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  appreciationFn, bulkReassignFn, cleaningModelFn, clusterNudgeFn, clusterObservationFn, commitCleaningFn, cycleActionFn, digestFn, dispatchFn, districtViewFn,
  explainFailureFn, extractFn, getCycle, getLive, hingePivotFn, issueOfficerSessionFn, layaFillFn, logFailureFn, proofOpenFn, proofRotateKeysFn, proofSignFn, proofStoreFn,
  resolveVacancyFn, runCycleFn, taskActionFn, todoActionFn, todosFn, updateTaskFn, updateThresholdsFn, watchlistDraftFn, whatsappCardFn,
} from "./api";
import {
  CONFIG, DEMO_TRANSCRIPT, DEMO_TRANSCRIPT_EN, REVIEW_DATE, loadSeededCycle, diagnoseFailure, dispatchBlockReason, fileKind, findHeaderRow, mapHeader, parseCsv, scanPii, suggestCanonical, validateFileSize,
  type CleaningAst, type FailureDiagnosticEntry, type HingePivotId, type OfficerRole, type Task,
} from "./engine";
import { SEEDED_NOTE, demoStt, useCycle } from "./store";
import { enqueueOfflineAction, isOffline, outboxCount } from "./offlineSync";
import { parseXlsxToCsv } from "./xlsx";
import { copy, type ActionResult, type CycleData, type LiveData } from "./types";

export const cycleKey = ["samiksha", "cycle"] as const;

/** What the screen says when a step needs the server and there is no signal. */
export const OFFLINE_NEEDS_SERVER = copy(
  "Offline: this step needs the server. The loaded cycle, Top 5/10/15, the cleaning preview, the photo checks and your drafts still work here; approvals and edits wait in the outbox.",
  "ऑफ़लाइन: इस चरण के लिए सर्वर चाहिए। लोड किया गया चक्र, शीर्ष 5/10/15, सफाई पूर्वावलोकन, फोटो जाँच और ड्राफ्ट यहीं चलते हैं; अनुमोदन और बदलाव आउटबॉक्स में रुकते हैं।",
);
export const liveKey = ["samiksha", "live"] as const;

const NEEDED = ["udise", "y1", "y2", "rounds", "attendance", "visits", "peer"];

export function useView() {
  const cq = useQuery({ queryKey: cycleKey, queryFn: () => getCycle({ data: {} }), staleTime: Number.POSITIVE_INFINITY });
  // No server cycle (no signal before the first load, or the server down): the same engine runs the seeded block on this device.
  const noServer = !cq.data && (cq.isError || cq.fetchStatus === "paused");
  const local = useMemo(() => (noServer ? onDeviceCycle() : null), [noServer]);
  const c = cq.data ?? local;
  const l = useQuery({ queryKey: liveKey, queryFn: () => getLive({ data: {} }), staleTime: 2000, refetchInterval: 5000 }).data;
  return {
    cycleId: c?.cycleId ?? null,
    blockId: c?.blockId ?? null,
    liveCycleId: l?.cycleId ?? null,
    cycle: c?.cycle ?? null,
    schools: c?.cycle.schools ?? [],
    gaps: c?.cycle.gaps ?? [],
    /** Core gaps then the watchlist (ranks 6-15); a cycle built before the watchlist has only the core gaps. */
    allRankedGaps: c?.cycle.allRankedGaps?.length ? c.cycle.allRankedGaps : (c?.cycle.gaps ?? []),
    isSeed: c?.isSeed ?? true,
    prepSeconds: c?.prepSeconds ?? 0,
    tasks: l?.tasks ?? [],
    messages: l?.messages ?? [],
    scorecard: l?.scorecard ?? null,
    llmCalls: l?.llmCalls ?? [],
    hingeDecisions: l?.hingeDecisions ?? [],
    simToday: l?.simToday ?? REVIEW_DATE,
    r4Loaded: l?.r4Loaded ?? false,
    bot: l?.bot ?? { live: false, username: "SamikshaSaathiBot" },
    queue: l?.queue ?? null,
    failures: l?.failures ?? [],
    proofs: l?.proofs ?? [],
    appreciations: l?.appreciations ?? [],
    services: l?.services ?? { mediaKey: false, laya: false, model: false, stt: false, whatsapp: false },
    reorders: l?.reorders ?? null,
    /** True when the screen shows the cycle computed on this device, not one from the server. */
    onDevice: Boolean(local && !cq.data),
  };
}

/** The seeded cycle, built by the engine in the browser with no network call. */
function onDeviceCycle(): CycleData {
  const cycle = loadSeededCycle();
  return { cycleId: 0, blockId: CONFIG.block_id, isSeed: true, prepSeconds: cycle.summary.runtime_s, cycle: cycle as CycleData["cycle"] };
}

export type UploadItem = { name: string; text: string; error?: string; failure?: FailureDiagnosticEntry };

/** A picked file as CSV text; an .xlsx workbook's first sheet is converted in the browser. Over 5 MB is refused unread. */
export async function readUpload(file: File): Promise<UploadItem> {
  const size = validateFileSize({ name: file.name, sizeBytes: file.size, kind: "spreadsheet" });
  if (!size.ok) return { name: file.name, text: "", error: size.diagnostic.explanation.whyFailed.en, failure: size.diagnostic };
  if (!/\.xlsx$/i.test(file.name)) return { name: file.name, text: await file.text() };
  try {
    return { name: file.name, text: await parseXlsxToCsv(await file.arrayBuffer()) };
  } catch (err) {
    return { name: file.name, text: "", error: err instanceof Error ? err.message : "The workbook could not be read." };
  }
}

/** The signed session the server issued. It travels with every call; the role alone is not trusted. */
const session = () => useCycle.getState().sessionToken ?? undefined;

/** The server's messages for a missing, forged, unreadable or expired session (verifyOfficerSessionToken). */
const SESSION_REFUSED = /officer session/i;

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined);

/** What every action needs: the stores, the request scope, and a runner that surfaces the gate message. */
function makeDeps(qc: QueryClient) {
  const set = useCycle.setState;
  const get = useCycle.getState;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: cycleKey }), qc.invalidateQueries({ queryKey: liveKey })]);
  const scope = () => {
    const c = qc.getQueryData<CycleData>(cycleKey);
    if (!c) throw new Error("The cycle is still loading.");
    return { blockId: c.blockId, cycleId: c.cycleId, requestId: rid() };
  };
  const tasks = () => qc.getQueryData<LiveData>(liveKey)?.tasks ?? [];
  /**
   * The acting role. There is no sign-in, so the browser declares it; the server
   * checks it against the role table and declares it to the database too.
   */
  const role = () => get().role;
  /**
   * When the device has no connection, the action is written to the outbox on
   * the device instead of being sent. It is replayed when the signal returns.
   * Returns true when the action was queued rather than sent.
   */
  const queueIfOffline = async (action: string, payload: Record<string, unknown>): Promise<boolean> => {
    if (!isOffline()) return false;
    await enqueueOfflineAction({ action, payload });
    const n = await outboxCount();
    set({
      pendingOutbox: n,
      gateMessage: copy(
        `Offline: "${action}" is queued on this device and will be sent when the connection returns.`,
        `ऑफ़लाइन: "${action}" इस डिवाइस पर कतार में है, संकेत लौटने पर भेजा जाएगा।`,
      ),
    });
    return true;
  };
  /** Record a failure the browser caught, so /why can explain it; never blocks the screen. */
  const logClientFailure = (f: FailureDiagnosticEntry) => {
    const c = qc.getQueryData<CycleData>(cycleKey);
    if (!c) return;
    void logFailureFn({ data: { blockId: c.blockId, cycleId: c.cycleId, requestId: rid(), code: f.code, surface: f.surface, facts: { ...f.facts, confidence: f.gate.confidence } } })
      .then(() => qc.invalidateQueries({ queryKey: liveKey }))
      .catch(() => undefined);
  };
  /**
   * A fresh session for the role on screen. A server instance that did not sign
   * the current token (a new serverless instance, or a restart, when no shared
   * session secret is set) refuses it; the browser then asks for a new one once.
   */
  const renewSession = async (): Promise<boolean> => {
    const c = qc.getQueryData<CycleData>(cycleKey);
    if (!c) return false;
    try {
      const s = await issueOfficerSessionFn({ data: { blockId: c.blockId, role: get().role, cluster: get().sessionCluster ?? null } });
      set({ sessionToken: s.token, sessionExpiresAt: s.expiresAt, sessionPersonId: s.personId, sessionCluster: s.clusterId === "ALL" ? null : s.clusterId });
      return true;
    } catch {
      return false;
    }
  };
  /** Runs a server call; if the session is refused, renews it once and runs the call again. */
  const withSession = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      if (SESSION_REFUSED.test(m) && (await renewSession())) return call();
      throw err;
    }
  };
  const run = async <T extends ActionResult>(call: () => Promise<T>, after?: (r: T) => void) => {
    // Offline, a step that needs the server is not attempted: nothing fails half-way, and the screen says what still works.
    if (isOffline()) {
      set({ gateMessage: OFFLINE_NEEDS_SERVER });
      return;
    }
    try {
      const r = await withSession(call);
      if (r.gate) set({ gateMessage: r.gate });
      after?.(r);
    } catch (err) {
      const m = err instanceof Error ? err.message : "Request failed.";
      set({ gateMessage: copy(m, m) });
    }
    await refresh();
  };
  const rebuild = async (files?: { name: string; csv: string }[]) => {
    const c = qc.getQueryData<CycleData>(cycleKey);
    await runCycleFn({ data: { blockId: c?.blockId, files, requestId: rid() } });
    await refresh();
  };
  return { set, get, refresh, scope, tasks, role, session, run, withSession, rebuild, logClientFailure, queueIfOffline };
}

type Deps = ReturnType<typeof makeDeps>;

/** Upload path: privacy guard and header check run in the browser, so refused rows never leave it. */
function makeIngest({ set, get, rebuild, logClientFailure }: Deps) {
  return async function ingestMany(items: UploadItem[]) {
    const notes = [...get().notes];
    let files = [...get().customFiles];
    for (const item of items) {
      const lower = item.name.toLowerCase();
      if (item.failure) logClientFailure(item.failure);
      if (item.error) {
        notes.push(copy(`${item.name}: ${item.error}`, `${item.name}: फाइल पढ़ी नहीं जा सकी (${item.error})`));
        continue;
      }
      if (lower.endsWith(".xls")) {
        notes.push(copy(
          `${item.name}: old .xls workbooks are not read. Save it as .xlsx or CSV.`,
          `${item.name}: पुरानी .xls फाइल नहीं पढ़ी जाती। इसे .xlsx या CSV में सहेजें।`,
        ));
        continue;
      }
      const grid = parseCsv(item.text);
      const hi = findHeaderRow(grid);
      const headers = grid[hi] ?? [];
      const pii = scanPii(headers, grid.slice(hi + 1));
      if (pii.hit) {
        // Only the file name and the matched column travel to the log, never a cell value.
        logClientFailure(diagnoseFailure("upload_file", "STUDENT_PII_DETECTED", { name: item.name, match: /^\d|identifier|PEN in/.test(pii.match) ? "an ID-number column" : pii.match }));
        notes.push(copy(
          `Privacy guard: ${item.name} was refused. “${pii.match}” looks like student-level data. Nothing was stored.`,
          `गोपनीयता गार्ड: ${item.name} रोकी गई। “${pii.match}” विद्यार्थी-स्तरीय डेटा लगता है। कुछ संग्रहीत नहीं हुआ।`,
        ));
        set({ notes, piiHit: pii.match, headerPrompt: null });
        return;
      }
      const unknown = headers.filter((h) => h.trim() && !mapHeader(h));
      if (unknown.length) {
        set({
          notes,
          headerPrompt: { fileName: item.name, text: item.text, headers, suggestions: unknown.map((h) => ({ from: h, to: suggestCanonical(h) })) },
        });
        return;
      }
      files = [...files.filter((f) => f.name !== item.name), { name: item.name, csv: item.text }];
      notes.push(copy(`${item.name}: accepted.`, `${item.name}: स्वीकार।`));
    }
    const names = files.map((f) => f.name);
    const kinds = new Set(names.map((n) => fileKind(n, names)));
    if (!NEEDED.every((k) => kinds.has(k))) {
      set({ customFiles: files, notes, piiHit: null });
      return;
    }
    notes.push(copy(
      "Full set received. The review cycle was rebuilt from your files.",
      "पूरी सेट मिल गई। समीक्षा चक्र आपकी फाइलों से फिर बना।",
    ));
    set({ customFiles: files, notes, piiHit: null, headerPrompt: null, banner: null, briefMode: "code", selectedTask: null });
    try {
      await rebuild(files);
    } catch (err) {
      const m = err instanceof Error ? err.message : "Upload failed.";
      set({ gateMessage: copy(m, m) });
    }
  };
}

function uploadActions(d: Deps) {
  const { set, get, rebuild } = d;
  const ingestMany = makeIngest(d);
  return {
    loadSeed: async () => {
      set({
        transcript: "", sttLabel: null, banner: null, briefMode: "code", gateMessage: null, notes: [SEEDED_NOTE],
        piiHit: null, headerPrompt: null, customFiles: [], selectedTask: null, briefSeen: false, topGapsLimit: 5, rankedLimit: null,
      });
      await rebuild();
    },
    ingestMany,
    confirmHeaders: () => {
      const prompt = get().headerPrompt;
      if (!prompt) return;
      const mapped = new Map(prompt.suggestions.map((s) => [s.from, s.to]));
      const headers = prompt.headers.map((h) => {
        const to = mapped.get(h);
        return !to || to === "ignore" || to === "BLOCKED_PII" ? h : to;
      });
      const text = prompt.text.replace(prompt.headers.join(","), headers.join(","));
      set({
        headerPrompt: null,
        notes: [...get().notes, copy(`${prompt.fileName}: column map confirmed by the officer.`, `${prompt.fileName}: कॉलम मैप अधिकारी ने पुष्टि किया।`)],
      });
      void ingestMany([{ name: prompt.fileName, text }]);
    },
    triggerPii: () =>
      ingestMany([{ name: "student_level_sample.csv", text: "student_name,aadhaar,school_code,g3_math_pct\nAsha Kumari,123412341234,23110100001,40\n" }]),
    triggerUnknownHeader: () => ingestMany([{ name: "messy_headers.csv", text: "sch_cd_v2,num_score\n23110100001,34\n" }]),
    /** The size gate with an 8.4 MB export: only its size is checked, no file is built. */
    triggerOversized: () => {
      const name = "district_export_full.xlsx";
      const size = validateFileSize({ name, sizeBytes: Math.round(8.4 * 1024 * 1024), kind: "spreadsheet" });
      return size.ok ? Promise.resolve() : ingestMany([{ name, text: "", error: size.diagnostic.explanation.whyFailed.en, failure: size.diagnostic }]);
    },
  };
}

function briefActions({ set, run, scope, role, refresh }: Deps) {
  return {
    /** A draft task for one watchlist gap; the result is shown on that card. */
    draftWatchlist: async (gapId: string): Promise<ActionResult> => {
      try {
        return await watchlistDraftFn({ data: { ...scope(), gapId, role: role(), sessionToken: session() } });
      } catch (err) {
        const m = err instanceof Error ? err.message : "Request failed.";
        return { ok: false, gate: copy(m, m) };
      } finally {
        await refresh();
      }
    },
    poisonBrief: (devanagari: boolean) => {
      set({
        banner: copy(
          "Number-check guardrail triggered. The invented figure was rejected. Showing the verified code brief.",
          "नंबर-चेक गार्डरेल सक्रिय। गढ़ा हुआ आँकड़ा अस्वीकार। सत्यापित कोड ब्रीफ दिख रहा है।",
        ),
        briefMode: "fallback",
      });
      return run(() => cycleActionFn({ data: { ...scope(), action: "guardrailTest", devanagari } }));
    },
  };
}

function decisionActions({ set, get, run, scope, tasks, role, queueIfOffline }: Deps) {
  const extract = (transcript: string) =>
    run(() => extractFn({ data: { ...scope(), transcript, role: role(), sessionToken: session() } }), () =>
      set((s) => ({ sttLabel: s.sttLabel ?? copy("Typed note · no audio", "टाइप किया नोट · ऑडियो नहीं") })),
    );
  const task = async (action: "approve" | "reject" | "restore" | "escalate", taskNo: number) => {
    const s = scope();
    const body = { ...s, taskNo, action, lang: get().lang, role: role(), sessionToken: session() };
    if (await queueIfOffline("task_action", { ...body })) return;
    await run(() => taskActionFn({ data: body }));
  };
  return {
    runVoiceDemo: async () => {
      const lang = get().lang;
      const transcript = lang === "en" ? DEMO_TRANSCRIPT_EN : DEMO_TRANSCRIPT;
      set({ transcript, sttLabel: demoStt(lang), tab: "approve" });
      // The sample note itself needs no key and no connection; turning it into drafts needs the server.
      if (isOffline()) {
        set({ gateMessage: copy(
          "Sample note loaded on this device. Extract the draft tasks when the connection returns.",
          "नमूना नोट इस डिवाइस पर लोड हो गया। कनेक्शन लौटने पर ड्राफ्ट कार्य निकालें।",
        ) });
        return;
      }
      await run(() => extractFn({ data: { ...scope(), transcript, role: role(), sessionToken: session() } }));
      set({ gateMessage: copy(
        "Five drafts. Task #18 has no owner and no due date, so Approve stays locked.",
        "पाँच ड्राफ्ट। कार्य #18 में जिम्मेदार और अंतिम तिथि नहीं है, इसलिए अनुमोदन बंद है।",
      ) });
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const utter = new SpeechSynthesisUtterance(transcript);
        utter.lang = lang === "en" ? "en-IN" : "hi-IN";
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
      }
    },
    extract: () => {
      const text = get().transcript.trim();
      return text ? extract(text) : Promise.resolve();
    },
    updateTask: async (taskNo: number, patch: Partial<Task>) => {
      const body = { ...scope(), taskNo, patch, role: role(), sessionToken: session() };
      if (await queueIfOffline("update_task", { ...body })) return;
      await run(() => updateTaskFn({ data: body }));
    },
    approve: (taskNo: number) => task("approve", taskNo),
    reject: (taskNo: number) => task("reject", taskNo),
    restore: (taskNo: number) => task("restore", taskNo),
    escalate: (taskNo: number) => task("escalate", taskNo),
    /** The DEO closes a vacancy: post filled, or a temporary arrangement made. */
    resolveVacancy: (taskNo: number) => run(() => resolveVacancyFn({ data: { ...scope(), taskNo, role: role(), sessionToken: session() } })),
    /**
     * Run one hinge pivot. `notifyTelegram` is false by default: HP-4 tells a real
     * DEO chat, so the screen asks before that happens.
     */
    runPivot: (pivotId: HingePivotId, notifyTelegram = false) =>
      run(() => hingePivotFn({ data: { ...scope(), pivotId, role: role(), sessionToken: session(), lang: get().lang, notifyTelegram } })),
    /** The cleaning studio's third tier: compile a rule with the model. */
    cleaningModel: (instruction: string) => cleaningModelFn({ data: { ...scope(), instruction, role: role(), sessionToken: session() } }),
    /** Commit a cleaning rule to the cycle's school records; the server re-applies it. */
    commitCleaning: (ast: CleaningAst) => run(() => commitCleaningFn({ data: { ...scope(), ast, role: role(), sessionToken: session() } })),
    dispatchApproved: () =>
      run(() => dispatchFn({ data: { ...scope(), lang: get().lang, role: role(), sessionToken: session() } }), (r) => {
        if (!r.sent) return;
        const first = tasks().find((t) => t.status === "approved");
        set({ tab: "follow", selectedTask: first?.id ?? get().selectedTask });
      }),
    tryIllegal: () => {
      const drafts = tasks().filter((t) => t.status === "draft" || t.status === "rejected");
      if (!drafts.length) {
        set({ gateMessage: copy(
          "No draft is sitting in the queue. Approve something, then send. A draft would still be blocked.",
          "कतार में कोई ड्राफ्ट नहीं। कुछ अनुमोदित करें, फिर भेजें। ड्राफ्ट फिर भी रुकेंगे।",
        ) });
        return;
      }
      const reasons = (lang: "en" | "hi") => drafts.map((t) => `#${t.id}: ${dispatchBlockReason(t, lang)}`).join(" · ");
      set({ gateMessage: copy(`Dispatch refused. ${reasons("en")}`, `प्रेषण अस्वीकृत। ${reasons("hi")}`) });
    },
    approveAllReady: () => run(() => cycleActionFn({ data: { ...scope(), action: "approveAllReady", role: role(), sessionToken: session() } })),
    jumpOverdue: () => run(() => cycleActionFn({ data: { ...scope(), action: "jumpOverdue" } })),
    closeLoop: () =>
      run(() => cycleActionFn({ data: { ...scope(), action: "closeLoop", lang: get().lang, role: role(), sessionToken: session() } }), () => set({ tab: "score", selectedTask: 14 })),
  };
}

/** A compressed JPEG proof. The server measures the photo itself, so nothing about its content is sent alongside. */
export type ProofUpload = {
  taskNo: number | null;
  schoolCode: string | null;
  mime: string;
  imageBase64: string;
  originalBytes: number;
};

/** Digest, appreciation, Laya fill, /why and stored proof. */
function mentorActions({ run, withSession, scope, role, logClientFailure }: Deps) {
  return {
    sendDigest: () => run(() => digestFn({ data: { ...scope(), role: role(), sessionToken: session() } })),
    sendAppreciation: (personId: string) => run(() => appreciationFn({ data: { ...scope(), personId, role: role(), sessionToken: session() } })),
    layaFill: (taskNo: number, approve: boolean) => run(() => layaFillFn({ data: { ...scope(), taskNo, approve, role: role(), sessionToken: session() } })),
    logClientFailure,
    // The plain-language /why needs the server: offline, or when the call fails, it answers with a note instead of throwing.
    explainFailure: () =>
      isOffline()
        ? Promise.resolve({ entry: null, note: OFFLINE_NEEDS_SERVER.en })
        : withSession(() => explainFailureFn({ data: { ...scope(), role: role(), sessionToken: session() } })).catch((err: unknown) => ({ entry: null, note: err instanceof Error ? err.message : "Request failed." })),
    storeProof: (p: ProofUpload) => run(() => proofStoreFn({ data: { ...scope(), ...p, role: role(), sessionToken: session() } })),
    rotateMediaKeys: () => run(() => proofRotateKeysFn({ data: { ...scope(), role: role(), sessionToken: session() } })),
    sendWhatsAppCard: (taskNo: number, phone: string, lang: "en" | "hi") =>
      run(() => whatsappCardFn({ data: { ...scope(), taskNo, phone, lang, role: role(), sessionToken: session() } })),
    signProof: (proofId: number, tier: 2 | 3) => run(() => proofSignFn({ data: { ...scope(), proofId, tier, role: role(), sessionToken: session() } })),
    // Opening a proof decrypts it on the server: offline, or when the call fails, it answers with the reason instead of throwing.
    openProof: (proofId: number) =>
      isOffline()
        ? Promise.resolve({ ok: false, dataUrl: null, gate: OFFLINE_NEEDS_SERVER })
        : withSession(() => proofOpenFn({ data: { ...scope(), proofId, role: role(), sessionToken: session() } })).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : "Request failed.";
            return { ok: false, dataUrl: null, gate: copy(m, m) };
          }),
  };
}

export function useActions() {
  const d = makeDeps(useQueryClient());
  return { ...uploadActions(d), ...briefActions(d), ...decisionActions(d), ...mentorActions(d), ...sessionActions(d), refresh: d.refresh };
}

/**
 * Replays one action that was queued on the device while offline.
 *
 * The queued payload is the same body the server would have received, so the
 * replay is the real call, not a summary of it. A failure returns false and the
 * item stays in the outbox for the next attempt.
 */
export async function sendOfflineAction(action: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    switch (action) {
      case "task_action": {
        const d = payload as unknown as {
          blockId: string;
          cycleId: number;
          taskNo: number;
          action: "approve" | "reject" | "restore" | "escalate";
          lang: "en" | "hi";
          role: OfficerRole;
          sessionToken: string;
        };
        await taskActionFn({ data: d });
        return true;
      }
      case "update_task": {
        const d = payload as unknown as {
          blockId: string;
          cycleId: number;
          taskNo: number;
          patch: Partial<Task>;
          role: OfficerRole;
          sessionToken: string;
        };
        await updateTaskFn({ data: d });
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * The officer's signed session and the powers that hang off it.
 *
 * The browser asks the server for a session for the role it is previewing; the
 * server picks the person and signs the token. Every other call then travels
 * with that token, so the role on the screen and the role on the server are
 * the same thing.
 */
function sessionActions({ set, get, run, withSession, scope, refresh }: Deps) {
  const issue = async (role: OfficerRole, cluster?: string | null) => {
    const c = scope();
    try {
      const s = await issueOfficerSessionFn({ data: { blockId: c.blockId, role, cluster: cluster ?? null } });
      set({ sessionToken: s.token, sessionExpiresAt: s.expiresAt, sessionPersonId: s.personId, sessionCluster: s.clusterId === "ALL" ? null : s.clusterId });
      return s;
    } catch (err) {
      const m = err instanceof Error ? err.message : "The officer session could not be issued.";
      set({ gateMessage: copy(m, m) });
      return null;
    }
  };
  return {
    /** Issues a fresh session for the role being previewed. */
    issueSession: issue,
    /** Moves every open task of one cluster to another officer, in one step. */
    bulkReassign: (cluster: string | null, toOwnerId: string, toOwnerName: string, reason = "") =>
      run(() => bulkReassignFn({ data: { ...scope(), cluster, toOwnerId, toOwnerName, reason, sessionToken: get().sessionToken ?? undefined } })),
    /** The DEO's district view: every block on the same axes. */
    districtView: async () => {
      const c = scope();
      try {
        return await withSession(() => districtViewFn({ data: { blockId: c.blockId, sessionToken: get().sessionToken ?? undefined } }));
      } catch (err) {
        const m = err instanceof Error ? err.message : "The district view could not be loaded.";
        set({ gateMessage: copy(m, m) });
        return null;
      }
    },
    /** The CRCC logs what the cluster looks like this week. */
    clusterObservation: (note: string) =>
      run(() => clusterObservationFn({ data: { ...scope(), note, sessionToken: get().sessionToken ?? undefined } })),
    /** The CRCC nudges the schools of one cluster. */
    clusterNudge: (cluster: string | null) =>
      run(() => clusterNudgeFn({ data: { ...scope(), cluster, sessionToken: get().sessionToken ?? undefined } })),
    /** The SPD changes one threshold for this block. */
    updateThreshold: (key: string, value: number) =>
      run(() => updateThresholdsFn({ data: { ...scope(), key, value, sessionToken: get().sessionToken ?? undefined } })),
    /** Re-reads the cycle and the live view after a change. */
    reload: refresh,
  };
}

/** The officer's own to-do items, kept per person so two officers of the same level do not share a list. */
export function useTodos() {
  const role = useCycle((s) => s.role) as OfficerRole;
  const sessionToken = useCycle((s) => s.sessionToken);
  const qc = useQueryClient();
  const key = ["samiksha", "todos", role, sessionToken] as const;
  const q = useQuery({ queryKey: key, queryFn: () => todosFn({ data: { role, sessionToken: sessionToken ?? undefined } }) });
  const act = async (d: { add?: string; id?: number; done?: boolean | null }) => {
    const rows = await todoActionFn({ data: { role, sessionToken: sessionToken ?? undefined, requestId: rid(), ...d } });
    qc.setQueryData(key, rows);
  };
  return {
    todos: q.data ?? [],
    add: (text: string) => act({ add: text }),
    toggle: (id: number, done: boolean) => act({ id, done }),
    remove: (id: number) => act({ id, done: null }),
  };
}
