import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
/**
 * Stored classroom proof. The browser blurs faces and compresses the photo
 * (cvPipeline.ts) before it sends anything. The server decodes the JPEG it
 * received and runs the photo checks again on those pixels (recheckStoredPhoto);
 * whatever the browser says about the photo is ignored. Only then does it
 * encrypt the photo (proofVault.ts) and store the ciphertext. Tier 2 and tier 3
 * are signed later, each by a higher level than the tier below. Opening
 * decrypts on the server for a role that canOpenProof allows.
 */
import { getSql, withTransaction } from "@/lib/db";
import {
  MAX_STORED_PROOF_BYTES,
  ROLE_LEVEL,
  assertOfficerPermission,
  officerOf,
  base64Bytes,
  canOpenProof,
  decryptProof,
  encryptProof,
  fromBase64,
  importProofKey,
  mediaKeyRingFrom,
  recheckStoredPhoto,
  rotateProofCiphertext,
  type ProofKeyId,
  isOfficerRole,
  toBase64,
  type OfficerRole,
  type ActingOfficer,
  type ProofMeta,
  type StoredPhotoCheck,
} from "@/lib/samiksha/engine";
import { copy, type ActionResult } from "@/lib/samiksha/types";
import { mediaKeyBase64 } from "@/lib/samiksha/mediaKey.server";
/** Who is acting: a signed session, or a bare role in the legacy test path. */
type Who = OfficerRole | ActingOfficer;


export const mediaKeySet = () => keyRing().length > 0;

/** Where a development machine keeps its own random media key. Ignored by git. */
const LOCAL_KEY_FILE = ".samiksha-media-key";

/**
 * A random key for a development machine without SAMIKSHA_MEDIA_KEY.
 *
 * It is generated once and kept in a local file next to the project, so photos
 * stored on this machine still open after a restart. Nothing in the source can
 * reproduce it. A production server never uses it: there the key must come
 * from the environment, and without it nothing is stored.
 */
function localMediaKey(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const g = globalThis as { __samikshaLocalMediaKey__?: string };
  if (g.__samikshaLocalMediaKey__) return g.__samikshaLocalMediaKey__;
  const file = join(process.cwd(), LOCAL_KEY_FILE);
  let key = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!key) {
    key = randomBytes(32).toString("base64");
    try {
      writeFileSync(file, `${key}\n`, { mode: 0o600 });
    } catch {
      // A read-only folder: the key lives for this process only, and the proofs stored with it close on restart.
    }
  }
  g.__samikshaLocalMediaKey__ = key;
  return key;
}

/**
 * The key ring, server-side.
 *
 * `SAMIKSHA_MEDIA_KEY` is the current key (v2) and `SAMIKSHA_MEDIA_KEY_PREV` the
 * one before it (v1). Either may be 32-byte base64 or a passphrase
 * (resolveMediaKey). There is no key derived from anything public: without the
 * environment key, a development machine uses its own random local key and a
 * production server stores nothing, because a per-instance random key would
 * leave proofs that another serverless instance, or the next cold start, can
 * never open.
 */
export function keyRing(): { keyId: ProofKeyId; key: string }[] {
  const current = mediaKeyBase64(process.env.SAMIKSHA_MEDIA_KEY) ?? localMediaKey();
  const prev = mediaKeyBase64(process.env.SAMIKSHA_MEDIA_KEY_PREV);
  return mediaKeyRingFrom({ current, prev });
}

/** The key new proofs are written with. */
export async function key(): Promise<{ key: CryptoKey; keyId: ProofKeyId }> {
  const ring = keyRing();
  const first = ring[0]!;
  return { key: await importProofKey(first.key), keyId: first.keyId };
}

/** Opens a proof, trying each key in the ring. */
export async function openWithRing(sealed: { ivHex: string; cipherB64: string; keyId?: ProofKeyId }, aad: string): Promise<Uint8Array> {
  let last: unknown = null;
  for (const entry of keyRing()) {
    try {
      return await decryptProof(await importProofKey(entry.key), sealed, aad);
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No key in the ring opened this proof. ${last instanceof Error ? last.message : ""}`.trim());
}

/** The row a ciphertext is bound to; a ciphertext moved to another row will not decrypt. */
const aad = (blockId: string, requestId: string) => `samiksha-proof:${blockId}:${requestId}`;

/** The largest photo the server will decode: the compressor never sends more than 640×480. */
const MAX_PROOF_PIXELS = 640 * 480;

/** Decode a stored-proof JPEG to RGBA, or null when the bytes are not a JPEG this server can read. */
export function decodeProofJpeg(bytes: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null {
  try {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 64 });
    if (!img.width || !img.height || img.width * img.height > MAX_PROOF_PIXELS) return null;
    return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
  } catch {
    return null;
  }
}

export type StoreProofResult = ActionResult & {
  id: number | null;
  /** 422 when the server's own photo check refused the upload. */
  httpStatus?: 422;
  /** What the server measured on the bytes it received; the browser's claims are never read. */
  serverCheck?: StoredPhotoCheck;
};

/**
 * `claimed` is what the browser said about the photo (its decision code,
 * confidence and person count). It is accepted for compatibility and ignored:
 * the stored decision, confidence and count are the server's own.
 */
export async function storeProof(input: {
  blockId: string;
  cycleId: number;
  requestId: string;
  role: Who;
  taskNo: number | null;
  schoolCode: string | null;
  mime: string;
  imageBase64: string;
  originalBytes: number;
  claimed?: { decisionCode?: unknown; decisionConfidence?: unknown; personCount?: unknown; width?: unknown; height?: unknown };
}): Promise<StoreProofResult> {
  assertOfficerPermission(input.role, "upload_group_photo");
  assertOfficerPermission(input.role, "sign_consent_tier1");
  if (input.mime !== "image/jpeg") {
    return { ok: false, id: null, httpStatus: 422, gate: copy("Only a JPEG proof is stored, so the server can check the photo itself.", "केवल JPEG प्रमाण संग्रहीत होता है, ताकि सर्वर स्वयं फोटो जाँच सके।") };
  }
  const bytes = base64Bytes(input.imageBase64);
  if (bytes < 1 || bytes > MAX_STORED_PROOF_BYTES) {
    return { ok: false, id: null, httpStatus: 422, gate: copy(`The compressed photo is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_STORED_PROOF_BYTES / 1024} KB.`, `संपीड़ित फोटो ${Math.round(bytes / 1024)} KB है; सीमा ${MAX_STORED_PROOF_BYTES / 1024} KB है।`) };
  }
  const plain = fromBase64(input.imageBase64);
  const img = decodeProofJpeg(plain);
  if (!img) {
    return { ok: false, id: null, httpStatus: 422, gate: copy("The server could not read this photo as a JPEG of 640×480 or smaller, so it was not stored.", "सर्वर इस फोटो को 640×480 तक की JPEG के रूप में नहीं पढ़ सका, इसलिए संग्रहीत नहीं हुई।") };
  }
  const check = recheckStoredPhoto(img.data, img.width, img.height);
  if (!check.ok) {
    const m = check.measures;
    const why = `${check.decision.code} · ${m.detectedPersonCount} children, largest face ${Math.round(m.maxFaceAreaRatio * 100)}% of the frame, sharpness ${m.sharpnessScore}, brightness ${m.brightnessScore}`;
    return {
      ok: false, id: null, httpStatus: 422, serverCheck: check,
      gate: copy(`Refused by the server's own photo check (${why}). ${check.verdict.reason.en}`, `सर्वर की अपनी फोटो जाँच ने रोका (${why})। ${check.verdict.reason.hi}`),
    };
  }
  const k = await key();
  const sealed = await encryptProof(k.key, plain, aad(input.blockId, input.requestId), k.keyId);
  const sql = await getSql();
  const rows = await sql`
    insert into encrypted_media_proofs (block_id, client_request_id, cycle_id, task_no, school_code, mime, original_bytes, compressed_bytes, width, height,
      iv_hex, cipher_b64, key_id, min_role_level, decision_code, decision_confidence, person_count, consent_tier1_by)
    values (${input.blockId}, ${input.requestId}, ${input.cycleId}, ${input.taskNo}, ${input.schoolCode}, ${input.mime}, ${Math.max(0, Math.round(input.originalBytes))}, ${bytes},
      ${img.width}, ${img.height}, ${sealed.ivHex}, ${sealed.cipherB64}, ${sealed.keyId}, 3, ${check.decision.code}, ${check.decision.confidence},
      ${check.measures.detectedPersonCount}, ${officerOf(input.role).role})
    on conflict (block_id, client_request_id) do nothing
    returning id`;
  return {
    ok: true,
    id: rows[0] ? Number(rows[0].id) : null,
    serverCheck: check,
    gate: copy(
      `Stored encrypted (AES-256-GCM): ${Math.round(bytes / 1024)} KB. The server's own check counted ${check.measures.detectedPersonCount} children (confidence ${Math.round(check.decision.confidence * 100)}%). Tier 1 signed by ${officerOf(input.role).role}.`,
      `एन्क्रिप्टेड संग्रहीत (AES-256-GCM): ${Math.round(bytes / 1024)} KB। सर्वर की अपनी जाँच में ${check.measures.detectedPersonCount} बच्चे (विश्वसनीयता ${Math.round(check.decision.confidence * 100)}%)। स्तर 1 पर ${officerOf(input.role).role} के हस्ताक्षर।`,
    ),
  };
}

/**
 * Re-encrypt every stored proof of a block under the current key.
 *
 * The rotation itself is an operator step: the new key goes into
 * SAMIKSHA_MEDIA_KEY and the old one into SAMIKSHA_MEDIA_KEY_PREV. Each proof
 * the current key cannot open is then opened with an older key in the ring and
 * sealed again with the current one (rotateProofCiphertext), in one
 * transaction. When the count of unreadable proofs is zero, the old key can be
 * dropped from the environment.
 */
export async function rotateBlockMediaKeys(blockId: string, role: Who): Promise<ActionResult & { rotated: number; current: number; unreadable: number }> {
  assertOfficerPermission(role, "rotate_media_key");
  const ring = keyRing();
  if (!ring.length) return { ok: false, rotated: 0, current: 0, unreadable: 0, gate: copy("The proof vault is not switched on for this block, so there is nothing to re-encrypt.", "इस विकासखंड के लिए प्रमाण वॉल्ट चालू नहीं है, इसलिए दोबारा एन्क्रिप्ट करने को कुछ नहीं।") };
  const now = { key: await importProofKey(ring[0]!.key), keyId: ring[0]!.keyId };
  const older = await Promise.all(ring.slice(1).map(async (e) => ({ key: await importProofKey(e.key), keyId: e.keyId })));
  const counts = await withTransaction(async (sql) => {
    const rows = await sql`select id, client_request_id, iv_hex, cipher_b64, key_id from encrypted_media_proofs where block_id = ${blockId} order by id for update`;
    let rotated = 0;
    let current = 0;
    let unreadable = 0;
    for (const r of rows) {
      const sealed = { ivHex: r.iv_hex as string, cipherB64: r.cipher_b64 as string };
      const bound = aad(blockId, r.client_request_id as string);
      const opensNow = await decryptProof(now.key, sealed, bound).then(() => true, () => false);
      if (opensNow) {
        if (r.key_id !== now.keyId) await sql`update encrypted_media_proofs set key_id = ${now.keyId} where id = ${r.id}`;
        current += 1;
        continue;
      }
      let moved = false;
      for (const old of older) {
        const next = await rotateProofCiphertext(sealed, old.key, now.key, now.keyId, bound).catch(() => null);
        if (!next) continue;
        await sql`update encrypted_media_proofs set iv_hex = ${next.ivHex}, cipher_b64 = ${next.cipherB64}, key_id = ${next.keyId} where id = ${r.id}`;
        rotated += 1;
        moved = true;
        break;
      }
      if (!moved) unreadable += 1;
    }
    return { rotated, current, unreadable };
  });
  return {
    ok: counts.unreadable === 0,
    ...counts,
    gate: copy(
      `Vault key rotation: ${counts.rotated} proof(s) re-encrypted under the current key, ${counts.current} already on it, ${counts.unreadable} no key in the ring could open.${counts.unreadable === 0 ? " The previous key can now be removed." : ""}`,
      `वॉल्ट कुंजी परिवर्तन: ${counts.rotated} प्रमाण नई कुंजी से फिर एन्क्रिप्ट, ${counts.current} पहले से उसी पर, ${counts.unreadable} किसी कुंजी से नहीं खुले।${counts.unreadable === 0 ? " पुरानी कुंजी अब हटाई जा सकती है।" : ""}`,
    ),
  };
}

/** Sign tier 2 (BEO and above) or tier 3 (DEO and above); the signer must outrank the tier below. */
export async function signProof(blockId: string, proofId: number, tier: 2 | 3, role: Who): Promise<ActionResult> {
  assertOfficerPermission(role, tier === 2 ? "sign_consent_tier2" : "sign_consent_tier3");
  return withTransaction(async (sql) => {
    const [p] = await sql`select consent_tier1_by, consent_tier2_by, consent_tier3_by from encrypted_media_proofs where block_id = ${blockId} and id = ${proofId} for update`;
    if (!p) return { ok: false, gate: copy("Proof not found.", "प्रमाण नहीं मिला।") };
    const below = (tier === 2 ? p.consent_tier1_by : p.consent_tier2_by) as string | null;
    if (!below || !isOfficerRole(below)) return { ok: false, gate: copy(`Tier ${tier - 1} must be signed first.`, `पहले स्तर ${tier - 1} पर हस्ताक्षर चाहिए।`) };
    if (ROLE_LEVEL[officerOf(role).role] <= ROLE_LEVEL[below]) {
      return { ok: false, gate: copy(`Tier ${tier} needs a higher level than ${below}, who signed tier ${tier - 1}.`, `स्तर ${tier} के लिए ${below} (स्तर ${tier - 1} हस्ताक्षरकर्ता) से ऊँचा स्तर चाहिए।`) };
    }
    if (tier === 2) await sql`update encrypted_media_proofs set consent_tier2_by = ${officerOf(role).role} where id = ${proofId}`;
    else await sql`update encrypted_media_proofs set consent_tier3_by = ${officerOf(role).role} where id = ${proofId}`;
    return { ok: true, gate: copy(`Tier ${tier} signed by ${officerOf(role).role}.`, `स्तर ${tier} पर ${officerOf(role).role} के हस्ताक्षर।`) };
  });
}

/** Decrypt for a role that may open it; otherwise refuse without touching the ciphertext. */
export async function openProof(blockId: string, proofId: number, role: Who): Promise<ActionResult & { dataUrl: string | null }> {
  const officerRole = officerOf(role).role;
  const sql = await getSql();
  const [p] = await sql`select * from encrypted_media_proofs where block_id = ${blockId} and id = ${proofId}`;
  if (!p) return { ok: false, dataUrl: null, gate: copy("Proof not found.", "प्रमाण नहीं मिला।") };
  const consent = {
    tier1By: (p.consent_tier1_by as OfficerRole | null) ?? null,
    tier2By: (p.consent_tier2_by as OfficerRole | null) ?? null,
    tier3By: (p.consent_tier3_by as OfficerRole | null) ?? null,
  };
  const allowed = canOpenProof(officerRole, consent);
  if (!allowed.allowed) return { ok: false, dataUrl: null, gate: allowed.reason };
  const plain = await openWithRing({ ivHex: p.iv_hex as string, cipherB64: p.cipher_b64 as string, keyId: (p.key_id as ProofKeyId | null) ?? undefined }, aad(blockId, p.client_request_id as string));
  return { ok: true, dataUrl: `data:${p.mime};base64,${toBase64(plain)}`, gate: copy(`Decrypted for ${officerOf(role).role}.`, `${officerOf(role).role} के लिए खोला गया।`) };
}

export async function listProofs(blockId: string, cycleId: number): Promise<ProofMeta[]> {
  const sql = await getSql();
  const rows = await sql`
    select id, created_at, task_no, school_code, mime, original_bytes, compressed_bytes, width, height, decision_code, decision_confidence, person_count,
      consent_tier1_by, consent_tier2_by, consent_tier3_by
    from encrypted_media_proofs where block_id = ${blockId} and cycle_id = ${cycleId} order by id desc limit 20`;
  return rows.map((r) => ({
    id: Number(r.id), at: new Date(String(r.created_at)).toISOString(), taskNo: r.task_no === null ? null : Number(r.task_no),
    schoolCode: (r.school_code as string | null) ?? null, mime: r.mime as string, originalBytes: Number(r.original_bytes), compressedBytes: Number(r.compressed_bytes),
    width: Number(r.width), height: Number(r.height), decisionCode: r.decision_code as string, decisionConfidence: Number(r.decision_confidence),
    personCount: Number(r.person_count), tier1By: (r.consent_tier1_by as OfficerRole | null) ?? null, tier2By: (r.consent_tier2_by as OfficerRole | null) ?? null,
    tier3By: (r.consent_tier3_by as OfficerRole | null) ?? null,
  }));
}
