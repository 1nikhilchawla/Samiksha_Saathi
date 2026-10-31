/**
 * Five officer levels (Samagra Shiksha style) and what each may do. Powers are
 * cumulative: each action has a minimum level, and every higher level holds it
 * too (SPD 5 > DEO 4 > BEO 3 > CRCC 2 > HM 1). An officer acting below their own
 * level is a supervisory override, and the screen says so. The same table
 * decides the UI, the server actions (assertRolePermission) and the database
 * trigger on tasks (migration 0008).
 *
 * The server reads the role from an HMAC-SHA256 signed session token
 * (sessionToken.ts, checked in api.ts `actor`), never from a role string the
 * browser sends. There is no sign-in yet: the server still issues a session for
 * whichever role the preview asks for, so the token proves which session made a
 * call, not who the person is.
 */
import type { Cycle, Task } from "./model";

type Copy = { en: string; hi: string };

export type OfficerRole = "SPD" | "DEO" | "BEO" | "CRCC" | "HM";
export type RoleLevel = 1 | 2 | 3 | 4 | 5;
/** In ladder order, level 1 to level 5. */
export const OFFICER_ROLES: OfficerRole[] = ["HM", "CRCC", "BEO", "DEO", "SPD"];
export const ROLE_LEVEL: Record<OfficerRole, RoleLevel> = { HM: 1, CRCC: 2, BEO: 3, DEO: 4, SPD: 5 };
export const LEVEL_ROLE: Record<RoleLevel, OfficerRole> = { 1: "HM", 2: "CRCC", 3: "BEO", 4: "DEO", 5: "SPD" };

export type RbacAction =
  | "send_field_reply"
  | "upload_group_photo"
  | "sign_consent_tier1"
  | "manage_personal_todo"
  | "ask_failure_why"
  | "upload_block_files"
  | "record_note"
  | "edit_task"
  | "approve_task"
  | "dispatch_tasks"
  | "escalate_to_deo"
  | "sign_consent_tier2"
  | "view_photo_evidence"
  | "send_weekly_digest"
  | "award_appreciation"
  | "resolve_vacancy"
  | "sign_consent_tier3"
  | "view_all_blocks"
  | "edit_thresholds"
  | "rotate_media_key"
  | "record_cluster_observation"
  | "co_sign_photo_tier1"
  | "send_cluster_nudge";

/** The lowest level that holds each action; every level above holds it too. */
export const ACTION_MIN_LEVEL: Record<RbacAction, RoleLevel> = {
  send_field_reply: 1,
  upload_group_photo: 1,
  sign_consent_tier1: 1,
  manage_personal_todo: 1,
  ask_failure_why: 1,
  // Level 2 is the CRCC's own rung: without these three, a CRCC held exactly
  // what a headmaster held and the ladder had a dead rung in the middle.
  record_cluster_observation: 2,
  co_sign_photo_tier1: 2,
  send_cluster_nudge: 2,
  upload_block_files: 3,
  record_note: 3,
  edit_task: 3,
  approve_task: 3,
  dispatch_tasks: 3,
  escalate_to_deo: 3,
  sign_consent_tier2: 3,
  view_photo_evidence: 3,
  send_weekly_digest: 3,
  award_appreciation: 3,
  resolve_vacancy: 4,
  sign_consent_tier3: 4,
  view_all_blocks: 4,
  edit_thresholds: 5,
  rotate_media_key: 5,
};

const ALL_ACTIONS = Object.keys(ACTION_MIN_LEVEL) as RbacAction[];

export const ACTION_TEXT: Record<RbacAction, Copy> = {
  view_all_blocks: { en: "view every block's scorecard", hi: "सभी विकासखंडों का स्कोरकार्ड देखना" },
  edit_thresholds: { en: "change the state thresholds", hi: "राज्य सीमाएँ बदलना" },
  rotate_media_key: { en: "re-encrypt stored photo proofs under a new vault key", hi: "संग्रहीत फोटो प्रमाण नई वॉल्ट कुंजी से फिर एन्क्रिप्ट करना" },
  upload_block_files: { en: "upload and clean the block files", hi: "विकासखंड फाइलें अपलोड व साफ करना" },
  record_note: { en: "turn a review note into draft tasks", hi: "समीक्षा नोट से ड्राफ्ट कार्य बनाना" },
  edit_task: { en: "edit draft tasks", hi: "ड्राफ्ट कार्य बदलना" },
  approve_task: { en: "approve or reject tasks", hi: "कार्य अनुमोदित या अस्वीकार करना" },
  dispatch_tasks: { en: "send approved task cards", hi: "अनुमोदित कार्य कार्ड भेजना" },
  escalate_to_deo: { en: "escalate a task to the DEO", hi: "कार्य DEO को अग्रेषित करना" },
  resolve_vacancy: { en: "resolve a teacher vacancy or redeployment", hi: "शिक्षक रिक्ति या पुनर्नियोजन हल करना" },
  send_field_reply: { en: "reply on a task (done, partly done, blocked)", hi: "कार्य पर उत्तर देना (हो गया, आधा, रुका)" },
  upload_group_photo: { en: "upload a group-activity photo", hi: "समूह गतिविधि फोटो अपलोड करना" },
  sign_consent_tier1: { en: "sign tier-1 photo consent", hi: "स्तर-1 फोटो सहमति देना" },
  sign_consent_tier2: { en: "counter-sign photo consent (tier 2)", hi: "फोटो सहमति पर प्रति-हस्ताक्षर (स्तर 2)" },
  sign_consent_tier3: { en: "sign the photo audit (tier 3)", hi: "फोटो ऑडिट पर हस्ताक्षर (स्तर 3)" },
  view_photo_evidence: { en: "open stored, consented photo proof", hi: "संग्रहीत, सहमति वाला फोटो प्रमाण खोलना" },
  manage_personal_todo: { en: "keep a personal to-do list", hi: "अपनी कार्य-सूची रखना" },
  ask_failure_why: { en: "ask why something failed (/why)", hi: "पूछना कि कुछ क्यों विफल हुआ (/why)" },
  send_weekly_digest: { en: "send the weekly pending-task digest", hi: "साप्ताहिक लंबित कार्य सारांश भेजना" },
  award_appreciation: { en: "send an appreciation card", hi: "प्रशंसा पत्र भेजना" },
  record_cluster_observation: { en: "log a cluster observation", hi: "क्लस्टर अवलोकन दर्ज करना" },
  co_sign_photo_tier1: { en: "co-sign a photo consent (tier 1)", hi: "फोटो सहमति पर सह-हस्ताक्षर (स्तर 1)" },
  send_cluster_nudge: { en: "send a cluster nudge to its schools", hi: "क्लस्टर को नुस्का भेजना" },
};

export const ROLE_SCOPE: Record<OfficerRole, Copy> = {
  SPD: { en: "State-wide (this prototype holds one block)", hi: "पूरा राज्य (इस प्रोटोटाइप में एक विकासखंड)" },
  DEO: { en: "Whole district (this prototype holds one block)", hi: "पूरा जिला (इस प्रोटोटाइप में एक विकासखंड)" },
  BEO: { en: "One block", hi: "एक विकासखंड" },
  CRCC: { en: "One cluster", hi: "एक क्लस्टर" },
  HM: { en: "One school", hi: "एक विद्यालय" },
};

export const isOfficerRole = (v: unknown): v is OfficerRole => typeof v === "string" && (OFFICER_ROLES as string[]).includes(v);

export type RbacDecision = {
  allowed: boolean;
  roleLevel: number;
  requiredLevel: RoleLevel;
  /** A higher level acting on work that belongs to a lower one (a DEO approving a block task). */
  isSupervisoryOverride: boolean;
  reasonEn: string;
  reasonHi: string;
};

export function canPerform(role: OfficerRole, action: RbacAction): RbacDecision {
  const need = ACTION_MIN_LEVEL[action];
  const have = isOfficerRole(role) ? ROLE_LEVEL[role] : 0;
  const t = ACTION_TEXT[action];
  const owner = LEVEL_ROLE[need];
  if (have >= need) {
    const override = have > need;
    return {
      allowed: true, roleLevel: have, requiredLevel: need, isSupervisoryOverride: override,
      reasonEn: override ? `${role} (level ${have}) may ${t.en}, as a supervisory override of ${owner} work.` : `${role} may ${t.en}.`,
      reasonHi: override ? `${role} (स्तर ${have}) ${t.hi} कर सकते हैं, ${owner} कार्य पर पर्यवेक्षी अधिकार से।` : `${role} ${t.hi} कर सकते हैं।`,
    };
  }
  return {
    allowed: false, roleLevel: have, requiredLevel: need, isSupervisoryOverride: false,
    reasonEn: `Needs level ${need} (${owner}) or above to ${t.en}; ${role} is level ${have}.`,
    reasonHi: `${t.hi} के लिए स्तर ${need} (${owner}) या ऊपर चाहिए; ${role} स्तर ${have} है।`,
  };
}

/** The power ladder: how many of the actions each level holds, and which ones it adds over the level below. */
export function powerLadder(role: OfficerRole): { level: number; holds: number; total: number; addsOverBelow: RbacAction[] } {
  const level = ROLE_LEVEL[role];
  return {
    level,
    holds: ALL_ACTIONS.filter((a) => ACTION_MIN_LEVEL[a] <= level).length,
    total: ALL_ACTIONS.length,
    addsOverBelow: ALL_ACTIONS.filter((a) => ACTION_MIN_LEVEL[a] === level),
  };
}

/** Thrown when a role calls an action it does not hold; the message is the officer-facing reason. */
export class RoleForbiddenError extends Error {
  readonly code = "ROLE_FORBIDDEN";
  readonly status = 403;
  readonly reason: Copy;
  constructor(reason: Copy) {
    super(reason.en);
    this.name = "RoleForbiddenError";
    this.reason = reason;
  }
}

/** Throws RoleForbiddenError unless the role may take the action. Every mutating server action calls this first. */
export function assertRolePermission(role: unknown, action: RbacAction): asserts role is OfficerRole {
  if (!isOfficerRole(role)) throw new RoleForbiddenError({ en: "No officer role was given.", hi: "कोई अधिकारी स्तर नहीं दिया गया।" });
  const r = canPerform(role, action);
  if (!r.allowed) throw new RoleForbiddenError({ en: `${role}: ${r.reasonEn}`, hi: `${role}: ${r.reasonHi}` });
}

/**
 * The officer behind a request. The role inside it came from a signed session
 * token, so the person is known and can be written into the audit trail.
 */
export type ActingOfficer = {
  role: OfficerRole;
  personId: string;
  blockId: string;
  cluster: string | null;
  /** The session id, so two sessions for the same officer can be told apart. */
  sessionId: string;
  /** True when the role came from the legacy test path rather than a signed token. */
  legacy?: boolean;
};

/** Accepts either a bare role (the legacy test path) or a signed acting officer. */
export function officerOf(who: OfficerRole | ActingOfficer): ActingOfficer {
  if (typeof who === "string") {
    return { role: who, personId: who.toLowerCase(), blockId: "", cluster: null, sessionId: "legacy", legacy: true };
  }
  return who;
}

/**
 * The permission check for a server action. It returns the decision, so the
 * caller can record whether the officer acted above the level the action needs.
 */
export function assertOfficerPermission(who: OfficerRole | ActingOfficer, action: RbacAction): { officer: ActingOfficer; isSupervisoryOverride: boolean } {
  const officer = officerOf(who);
  assertRolePermission(officer.role, action);
  const decision = canPerform(officer.role, action);
  return { officer, isSupervisoryOverride: decision.isSupervisoryOverride };
}

/** The actions a role has and lacks, for the access banner. */
export function roleMatrix(role: OfficerRole): { can: RbacAction[]; cannot: RbacAction[] } {
  const level = ROLE_LEVEL[role];
  return { can: ALL_ACTIONS.filter((a) => ACTION_MIN_LEVEL[a] <= level), cannot: ALL_ACTIONS.filter((a) => ACTION_MIN_LEVEL[a] > level) };
}

export type RoleScope = {
  schools: Cycle["schools"];
  tasks: Task[];
  scope: Copy;
  cluster: string | null;
  schoolCode: string | null;
};

/**
 * What a role sees. A CRCC sees one cluster (the one in their session, C4 when
 * nothing is given) and the tasks they own or that touch it; an HM sees one
 * school (PS Khedi's kind unless given) and its tasks.
 */
export function filterByRoleScope(
  role: OfficerRole,
  cycle: Pick<Cycle, "schools">,
  tasks: Task[],
  pick: { cluster?: string; ownerCluster?: string; schoolCode?: string } = {},
): RoleScope {
  if (role === "CRCC") {
    // The cluster comes from the signed session, so a CRCC sees their own
    // cluster rather than a hardcoded one.
    const cluster = pick.cluster ?? pick.ownerCluster ?? "C4";
    const schools = cycle.schools.filter((s) => s.cluster === cluster);
    const codes = new Set(schools.map((s) => s.code));
    const owner = `crcc-${cluster.replace(/^C/i, "")}`;
    return {
      schools,
      tasks: tasks.filter((t) => t.ownerId === owner || t.targetCodes.some((c) => codes.has(c))),
      scope: { en: `Cluster ${cluster} · ${schools.length} schools`, hi: `क्लस्टर ${cluster} · ${schools.length} विद्यालय` },
      cluster,
      schoolCode: null,
    };
  }
  if (role === "HM") {
    const school = cycle.schools.find((s) => s.code === pick.schoolCode) ?? cycle.schools.find((s) => s.kind === "khedi") ?? cycle.schools[0];
    const code = school?.code ?? "";
    return {
      schools: school ? [school] : [],
      tasks: tasks.filter((t) => t.ownerId === `hm-${code}` || t.targetCodes.includes(code)),
      scope: { en: `${school?.nameEn ?? "—"} · 1 school`, hi: `${school?.nameHi ?? "—"} · 1 विद्यालय` },
      cluster: school?.cluster ?? null,
      schoolCode: code || null,
    };
  }
  const n = cycle.schools.length;
  const base = ROLE_SCOPE[role];
  return {
    schools: cycle.schools,
    tasks,
    scope: role === "BEO" ? { en: `Block · ${n} schools`, hi: `विकासखंड · ${n} विद्यालय` } : { en: `${base.en} · ${n} schools`, hi: `${base.hi} · ${n} विद्यालय` },
    cluster: null,
    schoolCode: null,
  };
}
