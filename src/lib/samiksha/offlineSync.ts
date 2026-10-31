/**
 * Offline drafts and an outbox.
 *
 * A CRCC in a village with one bar of signal dictates a note, the signal drops,
 * and the tab reloads. Without this the note is gone. The draft is written to
 * IndexedDB as it is typed, and any action taken offline is queued in an outbox
 * and sent when the connection returns.
 *
 * Every call is wrapped: when IndexedDB is missing or blocked, the app falls
 * back to localStorage, and when that is blocked too it falls back to memory.
 * The app still works; it just remembers for less time.
 */
import type { Lang } from "./types";

const DB_NAME = "samiksha_offline_db";
const DB_VERSION = 1;
const DRAFT_STORE = "draft_state";
const OUTBOX_STORE = "offline_outbox";

/** localStorage keys, used when IndexedDB is unavailable. */
const LS_DRAFT_KEY = "samiksha.offline.draft_state";
const LS_OUTBOX_KEY = "samiksha.offline.offline_outbox";

export type DraftStateInput = {
  transcript: string;
  role: string;
  clusterId: string;
  stateCode: string;
  topGapsLimitUserPicked: number | null;
  step: string;
};

/** The whole working state of the officer, as it was when the signal dropped. */
export type OfflineDraftState = DraftStateInput & {
  savedAt: string;
};

export type OfflineAction = {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
};

/* ------------------------------------------------------- in-memory fallback */

const memDraft = new Map<string, OfflineDraftState>();
const memOutbox = new Map<string, OfflineAction>();

function lsAvailable(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = "__samiksha_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- IndexedDB */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: "savedAt" });
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function withStore<T>(name: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/* ---------------------------------------------------------------- draft state */

/**
 * Writes the officer's working state to the device.
 *
 * Only one draft is kept: the state of the review in progress. When the officer
 * comes back, the transcript, the role, the cluster, the state profile, the
 * chosen Top-N and the stage they were on are all restored.
 */
export async function saveOfflineDraftState(state: DraftStateInput): Promise<void> {
  const row: OfflineDraftState = { ...state, savedAt: new Date().toISOString() };
  const stored = await withStore(DRAFT_STORE, "readwrite", (s) => s.put(row) as unknown as IDBRequest<never>);
  if (stored !== null) return;
  // IndexedDB is not available: localStorage, then memory.
  if (lsAvailable()) {
    try {
      localStorage.setItem(LS_DRAFT_KEY, JSON.stringify(row));
      return;
    } catch {
      /* fall through to memory */
    }
  }
  memDraft.set("draft", row);
}

/** Reads back the working state, or null when the device holds none. */
export async function loadOfflineDraftState(): Promise<OfflineDraftState | null> {
  const rows = await withStore<OfflineDraftState[]>(DRAFT_STORE, "readonly", (s) => s.getAll());
  if (rows && rows.length) {
    return rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0]!;
  }
  if (lsAvailable()) {
    try {
      const raw = localStorage.getItem(LS_DRAFT_KEY);
      if (raw) return JSON.parse(raw) as OfflineDraftState;
    } catch {
      /* fall through to memory */
    }
  }
  return memDraft.get("draft") ?? null;
}

/** Forgets the draft once it has reached the server. */
export async function clearOfflineDraftState(): Promise<void> {
  await withStore(DRAFT_STORE, "readwrite", (s) => s.clear());
  if (lsAvailable()) {
    try {
      localStorage.removeItem(LS_DRAFT_KEY);
    } catch {
      /* nothing to do */
    }
  }
  memDraft.delete("draft");
}

/* -------------------------------------------------------------------- outbox */

/** Queues an action taken while offline. */
export async function enqueueOfflineAction(action: { action: string; payload?: Record<string, unknown> }): Promise<string | null> {
  const id = `${action.action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item: OfflineAction = {
    id,
    action: action.action,
    payload: action.payload ?? {},
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  const stored = await withStore(OUTBOX_STORE, "readwrite", (s) => s.put(item) as unknown as IDBRequest<never>);
  if (stored !== null) return id;
  if (lsAvailable()) {
    try {
      const list = lsOutbox();
      list.push(item);
      localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(list));
      return id;
    } catch {
      /* fall through to memory */
    }
  }
  memOutbox.set(id, item);
  return id;
}

function lsOutbox(): OfflineAction[] {
  try {
    const raw = localStorage.getItem(LS_OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OfflineAction[]) : [];
  } catch {
    return [];
  }
}

/** Everything waiting to be sent, oldest first. */
export async function listOfflineOutbox(): Promise<OfflineAction[]> {
  const rows = await withStore<OfflineAction[]>(OUTBOX_STORE, "readonly", (s) => s.getAll());
  if (rows && rows.length) return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (lsAvailable() && lsOutbox().length) return lsOutbox().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...memOutbox.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** How many items are waiting. */
export async function outboxCount(): Promise<number> {
  return (await listOfflineOutbox()).length;
}

/** Removes one item once it has been sent. */
export async function removeOfflineAction(id: string): Promise<void> {
  await withStore(OUTBOX_STORE, "readwrite", (s) => s.delete(id));
  if (lsAvailable()) {
    try {
      localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(lsOutbox().filter((i) => i.id !== id)));
    } catch {
      /* nothing to do */
    }
  }
  memOutbox.delete(id);
}

/** Marks an attempt, so a permanently failing item does not spin forever. */
export async function markOfflineAttempt(id: string): Promise<void> {
  const item = (await listOfflineOutbox()).find((i) => i.id === id);
  if (!item) return;
  const next = { ...item, attempts: item.attempts + 1 };
  await withStore(OUTBOX_STORE, "readwrite", (s) => s.put(next) as unknown as IDBRequest<never>);
  if (lsAvailable()) {
    try {
      localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(lsOutbox().map((i) => (i.id === id ? next : i))));
    } catch {
      /* nothing to do */
    }
  }
  memOutbox.set(id, next);
}

/**
 * Sends everything in the outbox, oldest first, and removes the items that go
 * through. An item that fails three times is dropped, so one bad payload does
 * not block the rest.
 */
export async function flushOfflineOutbox(onFlush: (action: OfflineAction) => Promise<boolean>): Promise<{ sent: number; failed: number }> {
  const items = await listOfflineOutbox();
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (item.attempts >= 3) {
      await removeOfflineAction(item.id);
      continue;
    }
    try {
      const ok = await onFlush(item);
      if (ok) {
        await removeOfflineAction(item.id);
        sent += 1;
      } else {
        await markOfflineAttempt(item.id);
        failed += 1;
      }
    } catch {
      await markOfflineAttempt(item.id);
      failed += 1;
    }
  }
  return { sent, failed };
}

/* -------------------------------------------------------------- connection */

/** True when the device says it has no connection. */
/**
 * The one-click signal test. When on, the app behaves exactly as it does when
 * the signal drops: no server call is made, actions go to the outbox, and the
 * screen says so. It changes nothing else.
 */
let simulatedOffline = false;
export function setSimulatedOffline(on: boolean): void {
  simulatedOffline = on;
}
export const isSimulatedOffline = () => simulatedOffline;

export function isOffline(): boolean {
  if (simulatedOffline) return true;
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === false;
}

/** A short note for the officer about what is saved on the device. */
export function draftNote(draft: OfflineDraftState | null, lang: Lang): { en: string; hi: string } | null {
  if (!draft || !draft.transcript.trim()) return null;
  const when = new Date(draft.savedAt);
  const time = `${when.getHours().toString().padStart(2, "0")}:${when.getMinutes().toString().padStart(2, "0")}`;
  return {
    en: `A saved note from ${time} is on this device. It has not reached the server yet.`,
    hi: `इस डिवाइस पर ${time} की सहेजी गई नोट है। यह अभी सर्वर तक नहीं पहुँची है।`,
  };
}
