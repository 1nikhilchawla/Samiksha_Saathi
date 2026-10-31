/**
 * The officer's signed session.
 *
 * The browser never chooses its own role any more: it asks the server for a
 * session and sends the signed token back with every call. The token is opaque
 * to the client (it holds no secret and signs nothing); the HMAC key lives only
 * on the server, in `session.server.ts`.
 *
 * This file is client-safe on purpose: it holds the claim shape and the pure
 * helpers, and nothing that needs `node:crypto`.
 */
import type { OfficerRole } from "./rbac";

export type SessionClaims = {
  /** The officer level this session may act at. */
  role: OfficerRole;
  /** The block the session is bound to; a session for one block cannot act on another. */
  blockId: string;
  /** The roster id of the person holding the session ("crcc-4", "beo", ...). */
  personId: string;
  /** The cluster the officer is scoped to, when the role has one. */
  cluster: string | null;
  /** Issued-at and expiry, in seconds since the epoch. */
  iat: number;
  exp: number;
  /** A random id, so two sessions for the same officer can be told apart in the audit trail. */
  jti: string;
  /**
   * True when the role came from the legacy test path (a raw role string) rather
   * than from a signed token. The browser can never produce this.
   */
  legacy?: boolean;
};

export type OfficerSession = {
  /** The signed token to send back with every call. */
  token: string;
  role: OfficerRole;
  personId: string;
  cluster: string | null;
  blockId: string;
  /** Expiry, in seconds since the epoch. */
  expiresAt: number;
};

export type SessionErrorCode = "NO_SESSION" | "BAD_SESSION" | "EXPIRED_SESSION" | "WRONG_BLOCK";

export type SessionError = { code: SessionErrorCode; message: string };

/** How long a session lasts. A block officer's session outlives one working day. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/** True when the claim set is shaped like a session. Used to reject a forged payload before it reaches a role check. */
export function isSessionClaims(v: unknown): v is SessionClaims {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<SessionClaims>;
  return (
    typeof c.role === "string" &&
    typeof c.blockId === "string" &&
    typeof c.personId === "string" &&
    typeof c.iat === "number" &&
    typeof c.exp === "number" &&
    typeof c.jti === "string"
  );
}

/** The officer a session belongs to, as the UI shows it. */
export function sessionLabel(role: OfficerRole, personId: string, cluster: string | null): string {
  if (role === "CRCC") return cluster ? `CRCC · Cluster ${cluster}` : `CRCC · ${personId}`;
  return `${role} · ${personId}`;
}
