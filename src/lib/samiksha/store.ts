import { create } from "zustand";
import {
  ACTION_LIBRARY,
  addDays,
  canPerform,
  cleanSchoolCode,
  DEMO_TRANSCRIPT,
  DEMO_TRANSCRIPT_EN,
  DEFAULT_TOP_GAPS_LIMIT,
  REVIEW_DATE,
  type ActionId,
  type OfficerRole,
  type Person,
  type RbacAction,
  type StateCode,
  type TopGapsLimit,
} from "./engine";
import { copy, type Copy, type Lang } from "./types";

/**
 * UI state only: language, tab, selected task, and transient screen state
 * (typed note, banners, upload prompts). The cycle, tasks, messages and the
 * scorecard live in the database; read them with useView() from ./view.
 */
export type TabId = "upload" | "brief" | "approve" | "follow" | "score";
export type { ChatMsg, LlmCall } from "./types";
export { copy };
export type { Copy, Lang };

export function tx(value: Copy | null | undefined, lang: Lang): string {
  return value ? value[lang] : "";
}

export type HeaderPrompt = {
  fileName: string;
  text: string;
  headers: string[];
  suggestions: { from: string; to: string }[];
};

export const SEEDED_NOTE = copy(
  "Block files loaded. The same seven CSVs can be downloaded and uploaded again.",
  "विकासखंड फाइलें लोड हो गईं। वही सात CSV फिर डाउनलोड और अपलोड की जा सकती हैं।",
);

export function demoStt(lang: Lang) {
  return lang === "en"
    ? copy(
        "Sample voice note · English · transcribed text below",
        "नमूना वॉइस नोट · अंग्रेज़ी · लिखा हुआ पाठ नीचे",
      )
    : copy(
        "Sample voice note · Hindi · transcribed text below",
        "नमूना वॉइस नोट · हिन्दी · लिखा हुआ पाठ नीचे",
      );
}

type State = {
  lang: Lang;
  tab: TabId;
  selectedTask: number | null;
  transcript: string;
  sttLabel: Copy | null;
  banner: Copy | null;
  briefMode: "code" | "claude" | "fallback";
  /** How many priority gaps the brief lists. Starts at 5 on every load; never stored. */
  topGapsLimit: TopGapsLimit;
  /** The list the last Claude order covered, so the chip can say which one. */
  rankedLimit: TopGapsLimit | null;
  /** The confidence the second check gave the Claude reorder, 0.00 to 1.00. */
  layaConfidence: number | null;
  setTopGapsLimit: (limit: TopGapsLimit) => void;
  gateMessage: Copy | null;
  notes: Copy[];
  piiHit: string | null;
  headerPrompt: HeaderPrompt | null;
  customFiles: { name: string; csv: string }[];
  grokBusy: boolean;
  briefSeen: boolean;
  /**
   * The officer view being previewed. The role itself comes from a signed
   * session the server issued; this is only what the screen shows.
   */
  role: OfficerRole;
  /** The signed session token sent with every call. Null until the server issues one. */
  sessionToken: string | null;
  /** When the session expires, in seconds since the epoch. */
  sessionExpiresAt: number | null;
  /** The roster person the session belongs to ("crcc-4", "beo", ...). */
  sessionPersonId: string | null;
  /** The cluster the signed officer is scoped to, when the role has one. */
  sessionCluster: string | null;
  /** True when the device has no connection to the server right now. */
  offline: boolean;
  /** How many outbox items are waiting to be sent. */
  pendingOutbox: number;
  /** State export profile whose officer titles the UI shows. */
  stateCode: StateCode;
  /** True when the officer chose the profile by hand, so the file does not override it. */
  stateCodeManual: boolean;
  hingeOpen: boolean;
  /** The full hinge studio screen, below the header dropdown. */
  hingeStudio: boolean;
  setRole: (role: OfficerRole) => void;
  /** The cluster a CRCC is working in. The picker in the command bar changes it. */
  activeCluster: string;
  /** Focused meeting mode: the secondary diagnostics collapse into accordions. */
  meetingMode: boolean;
  setActiveCluster: (cluster: string) => void;
  setMeetingMode: (on: boolean) => void;
  setSession: (session: { token: string; expiresAt: number; personId: string; cluster: string | null } | null) => void;
  setStateCode: (code: StateCode, manual?: boolean) => void;
  setConnectivity: (offline: boolean, pendingOutbox?: number) => void;
  toggleHinge: () => void;
  openHingeStudio: () => void;
  closeHingeStudio: () => void;
  setLang: (lang: Lang) => void;
  setTab: (tab: TabId) => void;
  selectTask: (id: number | null) => void;
  setTranscript: (v: string) => void;
  setGrokBusy: (v: boolean) => void;
  clearBanner: () => void;
  dismissHeaders: () => void;
};

export const useCycle = create<State>((set, get) => ({
  lang: "en",
  tab: "upload",
  selectedTask: null,
  transcript: "",
  sttLabel: null,
  banner: null,
  briefMode: "code",
  topGapsLimit: DEFAULT_TOP_GAPS_LIMIT,
  rankedLimit: null,
  layaConfidence: null,
  setTopGapsLimit: (topGapsLimit) => set({ topGapsLimit }),
  gateMessage: null,
  notes: [SEEDED_NOTE],
  piiHit: null,
  headerPrompt: null,
  customFiles: [],
  grokBusy: false,
  briefSeen: false,
  role: "BEO",
  sessionToken: null,
  sessionExpiresAt: null,
  sessionPersonId: null,
  sessionCluster: null,
  offline: false,
  pendingOutbox: 0,
  stateCode: "MP",
  stateCodeManual: false,
  hingeOpen: false,
  hingeStudio: false,
  // Switching the previewed role drops the old session: the server issues a new
  // one for the role that was chosen, and the old token is not reused.
  setRole: (role) => set({ role, sessionToken: null, sessionExpiresAt: null, sessionPersonId: null, sessionCluster: null }),
  setSession: (session) =>
    set(
      session
        ? { sessionToken: session.token, sessionExpiresAt: session.expiresAt, sessionPersonId: session.personId, sessionCluster: session.cluster }
        : { sessionToken: null, sessionExpiresAt: null, sessionPersonId: null, sessionCluster: null },
    ),
  setStateCode: (stateCode, manual) => set({ stateCode, stateCodeManual: manual ?? true }),
  activeCluster: "C4",
  meetingMode: false,
  setActiveCluster: (activeCluster) => set({ activeCluster }),
  setMeetingMode: (meetingMode) => set({ meetingMode }),
  setConnectivity: (offline, pendingOutbox) =>
    set((s) => ({ offline, pendingOutbox: pendingOutbox ?? s.pendingOutbox })),
  toggleHinge: () => set((s) => ({ hingeOpen: !s.hingeOpen })),
  openHingeStudio: () => set({ hingeStudio: true, hingeOpen: false }),
  closeHingeStudio: () => set({ hingeStudio: false }),

  setLang: (lang) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("samiksha.lang", lang);
      } catch {
        /* private mode */
      }
    }
    const current = get().transcript;
    const isDemo = current === DEMO_TRANSCRIPT || current === DEMO_TRANSCRIPT_EN;
    set({
      lang,
      ...(isDemo
        ? {
            transcript: lang === "en" ? DEMO_TRANSCRIPT_EN : DEMO_TRANSCRIPT,
            sttLabel: demoStt(lang),
          }
        : {}),
    });
  },

  setTab: (tab) => set((s) => ({ tab, briefSeen: s.briefSeen || tab === "brief" })),
  selectTask: (selectedTask) => set({ selectedTask }),
  setTranscript: (transcript) => set({ transcript }),
  setGrokBusy: (grokBusy) => set({ grokBusy }),
  clearBanner: () => set({ banner: null, briefMode: "code", gateMessage: null }),
  dismissHeaders: () => set({ headerPrompt: null }),
}));

/** Whether the previewed officer role may take an action, with the reason to show when not. */
export function useCan() {
  const role = useCycle((s) => s.role);
  return (action: RbacAction) => canPerform(role, action);
}

export function personById(people: Person[], id: string | null) {
  return people.find((p) => p.id === id);
}

export function actionName(id: ActionId) {
  return ACTION_LIBRARY[id];
}

export { ACTION_LIBRARY, addDays, cleanSchoolCode, REVIEW_DATE };
