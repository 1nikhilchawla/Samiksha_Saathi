/**
 * The officer's signed session token.
 *
 * The browser does not choose its own role any more: it asks the server for a
 * session and sends the signed token back with every call. The token is opaque
 * to the client — it holds no secret and signs nothing — and the HMAC key lives
 * only on the server.
 *
 * The signing uses WebCrypto, which is the same code in Node and in the
 * browser, so this file is safe to import from either side.
 */
import type { OfficerRole } from "./rbac";

export type SessionKeyId = "v1" | "v2";

export interface OfficerSessionClaims {
  /** The roster person holding the session ("beo-kesli", "crcc-C4", "hm-23110100101"). */
  personId: string;
  /** The officer level this session may act at. */
  role: OfficerRole;
  /** The block the session is bound to; a session for one block cannot act on another. */
  blockId: string;
  /** The cluster the officer is scoped to, or "ALL". */
  clusterId: string;
  /** The UDISE code, for a session that acts for one school. */
  udiseCode?: string;
  /** Issued-at and expiry, in seconds since the epoch. */
  issuedAt: number;
  exp: number;
  /** A random id, so two sessions for the same officer can be told apart in the audit trail. */
  jti: string;
}

export type SessionVerifyResult =
  | { ok: true; claims: OfficerSessionClaims }
  | { ok: false; reason: "NO_SESSION" | "BAD_SESSION" | "EXPIRED_SESSION"; message: string };

const TOKEN_VERSION = "v1";

/** How long a session lasts. A block officer's session outlives one working day. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/**
 * The signing key: `SAMIKSHA_SESSION_SECRET`.
 *
 * Without it, a random 32-byte key is made once per server process (kept on
 * globalThis so a dev reload does not change it), so no key is ever written in
 * the source, where anyone reading it could forge a session. In production that
 * key lasts only as long as the instance: a session signed by another instance
 * is refused, and the browser asks for a fresh one and retries (view.ts). Set
 * the variable to make sessions last across instances. A caller that must not
 * fall back passes `requireExplicitEnvInProd`.
 */
export function sessionSecret(opts: { requireExplicitEnvInProd?: boolean } = {}): string {
  const env: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};
  const fromEnv = env.SAMIKSHA_SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const production = env.NODE_ENV === "production";
  if (production && opts.requireExplicitEnvInProd) {
    // The operator's fix goes to the server log; the officer sees a plain message.
    console.error("[samiksha] SAMIKSHA_SESSION_SECRET is not set; officer sessions cannot be signed until it is set in the deployment environment.");
    throw new Error("Officer sign-in is not available on this server right now. Please contact the state IT cell.");
  }
  const g = globalThis as typeof globalThis & { __samikshaSessionSecret__?: string };
  if (!g.__samikshaSessionSecret__) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    g.__samikshaSessionSecret__ = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (production) console.warn("[samiksha] SAMIKSHA_SESSION_SECRET not set; using a process-scoped random secret for this server instance.");
  }
  return g.__samikshaSessionSecret__;
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available.");
  return s;
};

const toB64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (text: string) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmac(payload: string): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", new TextEncoder().encode(sessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle().sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

/** Constant-time comparison of two byte strings. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Signs a claim set into a token. */
export async function signOfficerSessionToken(claims: Omit<OfficerSessionClaims, "issuedAt" | "exp" | "jti"> & { ttlSeconds?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: OfficerSessionClaims = {
    personId: claims.personId,
    role: claims.role,
    blockId: claims.blockId,
    clusterId: claims.clusterId,
    ...(claims.udiseCode ? { udiseCode: claims.udiseCode } : {}),
    issuedAt: now,
    exp: now + (claims.ttlSeconds ?? SESSION_TTL_SECONDS),
    jti: globalThis.crypto.randomUUID(),
  };
  const payload = toB64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig = toB64url(await hmac(payload));
  return `${TOKEN_VERSION}.${payload}.${sig}`;
}

/**
 * Checks a token. A forged, tampered or expired token is refused; none of them
 * falls back to a claimed role.
 */
export async function verifyOfficerSessionToken(token: unknown): Promise<SessionVerifyResult> {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, reason: "NO_SESSION", message: "No officer session was sent." };
  }
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "BAD_SESSION", message: "The officer session is not a valid token." };
  }
  const [, payload, signature] = parts as [string, string, string];
  let given: Uint8Array;
  try {
    given = fromB64url(signature);
  } catch {
    return { ok: false, reason: "BAD_SESSION", message: "The officer session is not a valid token." };
  }
  const expected = await hmac(payload);
  if (!sameBytes(given, expected)) {
    return { ok: false, reason: "BAD_SESSION", message: "The officer session signature does not match." };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return { ok: false, reason: "BAD_SESSION", message: "The officer session could not be read." };
  }
  if (!isOfficerSessionClaims(claims)) {
    return { ok: false, reason: "BAD_SESSION", message: "The officer session is incomplete." };
  }
  if (claims.exp * 1000 <= Date.now()) {
    return { ok: false, reason: "EXPIRED_SESSION", message: "The officer session has expired." };
  }
  return { ok: true, claims };
}

/** True when the claim set is shaped like a session. */
export function isOfficerSessionClaims(v: unknown): v is OfficerSessionClaims {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<OfficerSessionClaims>;
  return (
    typeof c.personId === "string" &&
    typeof c.role === "string" &&
    typeof c.blockId === "string" &&
    typeof c.clusterId === "string" &&
    typeof c.issuedAt === "number" &&
    typeof c.exp === "number" &&
    typeof c.jti === "string"
  );
}

/**
 * A ready-made signed session for a role, for the server endpoint and for the
 * tests. The person id follows the brief's naming.
 */
export async function mintDefaultSessionToken(role: OfficerRole, clusterId = "C4", blockId = "MP-PILOT-BLK01"): Promise<string> {
  const personId = role === "HM" ? "hm-23110100101" : role === "CRCC" ? `crcc-${clusterId}` : role === "BEO" ? "beo-kesli" : role === "DEO" ? "deo-sagar" : "spd-mp";
  return signOfficerSessionToken({ personId, role, blockId, clusterId: role === "CRCC" || role === "HM" ? clusterId : "ALL" });
}
