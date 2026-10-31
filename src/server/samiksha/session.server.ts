/**
 * Minting and checking the officer's signed session. Server-only glue over
 * `core/sessionToken.ts`: the same HMAC, plus the roster lookup that decides
 * *who* the session belongs to and the audit row that records it.
 */
import { getSql } from "@/lib/db";
import type { OfficerRole } from "@/lib/samiksha/core/rbac";
import { signOfficerSessionToken, verifyOfficerSessionToken, type OfficerSessionClaims, type SessionVerifyResult } from "@/lib/samiksha/core/sessionToken";

export type { OfficerSessionClaims };

export type OfficerSession = {
  /** The signed token to send back with every call. */
  token: string;
  role: OfficerRole;
  personId: string;
  clusterId: string;
  blockId: string;
  /** Expiry, in seconds since the epoch. */
  expiresAt: number;
};

/** Issues a token for an officer. The caller has already decided who they are. */
export async function mintSessionToken(claims: { role: OfficerRole; blockId: string; personId: string; clusterId: string; udiseCode?: string }): Promise<{ token: string; claims: OfficerSessionClaims }> {
  const token = await signOfficerSessionToken(claims);
  const decoded = await verifyOfficerSessionToken(token);
  if (!decoded.ok) throw new Error(decoded.message);
  return { token, claims: decoded.claims };
}

/** Checks a token and returns its claims. */
export async function verifySessionToken(token: unknown): Promise<SessionVerifyResult> {
  return verifyOfficerSessionToken(token);
}

/**
 * The roster person for a role, taken from the cycle's own people. The role is
 * never taken from the browser: the server picks the person and signs it.
 */
export function personForRole(
  people: { id: string; role: OfficerRole; cluster: string | null }[],
  role: OfficerRole,
  cluster?: string | null,
): { personId: string; clusterId: string } {
  if (role === "SPD") return { personId: "spd-mp", clusterId: "ALL" };
  const ofRole = people.filter((p) => p.role === role);
  if (role === "CRCC") {
    const picked = cluster ? ofRole.find((p) => p.cluster === cluster) : undefined;
    const first = picked ?? ofRole[0];
    return { personId: first?.id ?? `crcc-${cluster ?? "C4"}`, clusterId: first?.cluster ?? cluster ?? "C4" };
  }
  if (role === "HM") {
    const first = ofRole[0];
    return { personId: first?.id ?? "hm-23110100101", clusterId: first?.cluster ?? "ALL" };
  }
  return { personId: ofRole[0]?.id ?? (role === "BEO" ? "beo-kesli" : "deo-sagar"), clusterId: "ALL" };
}

/** The public shape of an issued session. */
export function toSession(token: string, claims: OfficerSessionClaims): OfficerSession {
  return {
    token,
    role: claims.role,
    personId: claims.personId,
    clusterId: claims.clusterId,
    blockId: claims.blockId,
    expiresAt: claims.exp,
  };
}

/** Writes the session into the audit trail. A database without the table must not stop the officer working. */
export async function logSessionIssued(blockId: string, claims: OfficerSessionClaims): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      insert into officer_session_log (block_id, session_jti, officer_role, person_id, cluster, expires_at)
      values (${blockId}, ${claims.jti}, ${claims.role}, ${claims.personId}, ${claims.clusterId}, to_timestamp(${claims.exp}))
      on conflict (session_jti) do nothing`;
  } catch {
    /* the audit table is not there yet; the session still works */
  }
}
