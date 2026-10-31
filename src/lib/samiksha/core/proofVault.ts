/**
 * Stored classroom proof: encryption and who may open it.
 *
 * Only the blurred, compressed photo is ever stored; the unblurred original
 * never leaves the device. It is encrypted with AES-256-GCM (WebCrypto, the
 * same code in Node and the browser) under a server key, SAMIKSHA_MEDIA_KEY,
 * so a copy of the database alone shows nothing. Opening it needs level 3
 * (BEO) or above and the BEO's tier-2 signature; the state level also needs
 * the DEO's tier-3 audit signature.
 *
 * The role now comes from a signed session token, so the gate is backed by an
 * identity rather than by a dropdown.
 */
import { ROLE_LEVEL, type OfficerRole } from "./rbac";

type Copy = { en: string; hi: string };

export const PROOF_MIN_ROLE_LEVEL = 3;

export type ProofConsent = { tier1By: OfficerRole | null; tier2By: OfficerRole | null; tier3By: OfficerRole | null };

/** A stored proof as the screens list it: details only, never the image. */
export type ProofMeta = ProofConsent & {
  id: number;
  at: string;
  taskNo: number | null;
  schoolCode: string | null;
  mime: string;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
  decisionCode: string;
  decisionConfidence: number;
  personCount: number;
};

/** Whether this role may open a stored proof, with the reason to show when not. */
export function canOpenProof(role: OfficerRole, consent: ProofConsent): { allowed: boolean; reason: Copy } {
  const level = ROLE_LEVEL[role];
  if (level < PROOF_MIN_ROLE_LEVEL) {
    return { allowed: false, reason: { en: "Encrypted. Opening needs level 3 (BEO) or above.", hi: "एन्क्रिप्टेड। खोलने के लिए स्तर 3 (BEO) या ऊपर चाहिए।" } };
  }
  if (!consent.tier1By || !consent.tier2By) {
    return { allowed: false, reason: { en: "Encrypted. Opening needs tier-1 and tier-2 consent first.", hi: "एन्क्रिप्टेड। खोलने से पहले स्तर 1 और 2 की सहमति चाहिए।" } };
  }
  if (level >= 5 && !consent.tier3By) {
    return { allowed: false, reason: { en: "Encrypted. The state level also needs the DEO's tier-3 audit signature.", hi: "एन्क्रिप्टेड। राज्य स्तर के लिए DEO के स्तर-3 ऑडिट हस्ताक्षर भी चाहिए।" } };
  }
  return { allowed: true, reason: { en: "Allowed.", hi: "अनुमति है।" } };
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available.");
  return s;
};

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
export const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Which key a ciphertext was written with. */
export type ProofKeyId = "v1" | "v2";

export type ProofSealed = { ivHex: string; cipherB64: string; keyId?: ProofKeyId };

/**
 * The key ring.
 *
 * `SAMIKSHA_MEDIA_KEY` is the current key (v2); `SAMIKSHA_MEDIA_KEY_PREV` is the
 * one before it (v1). A ciphertext carries the key id it was written with, so
 * rotating the key does not orphan a single photo: the old key stays in the
 * ring until every proof written with it has been re-saved.
 */
export function mediaKeyRingFrom(env: { current?: string | null; prev?: string | null }): { keyId: ProofKeyId; key: string }[] {
  const ring: { keyId: ProofKeyId; key: string }[] = [];
  if (env.current?.trim()) ring.push({ keyId: "v2", key: env.current.trim() });
  if (env.prev?.trim()) ring.push({ keyId: "v1", key: env.prev.trim() });
  return ring;
}

/** A 32-byte key from base64 (the SAMIKSHA_MEDIA_KEY format). */
export async function importProofKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key.trim());
  if (raw.length !== 32) {
    console.error("[samiksha] SAMIKSHA_MEDIA_KEY must be 32 bytes, base64-encoded.");
    throw new Error("The proof vault is not set up correctly on this server, so the photo was not stored or opened.");
  }
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM with a fresh 12-byte IV; the auth tag travels inside the ciphertext. `aad` binds it to its row. */
export async function encryptProof(key: CryptoKey, plain: Uint8Array, aad: string, keyId: ProofKeyId = "v2"): Promise<{ ivHex: string; cipherB64: string; keyId: ProofKeyId }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, Uint8Array.from(plain)));
  return { ivHex: toHex(iv), cipherB64: toBase64(cipher), keyId };
}

/** Throws if the key, the IV, the bound row or a single byte is wrong (GCM authentication). */
export async function decryptProof(key: CryptoKey, sealed: ProofSealed, aad: string): Promise<Uint8Array> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromHex(sealed.ivHex), additionalData: new TextEncoder().encode(aad) },
    key,
    fromBase64(sealed.cipherB64),
  );
  return new Uint8Array(plain);
}

/**
 * Re-encrypts a proof under a new key.
 *
 * The record keeps its row, its AAD and its id; only the ciphertext and the key
 * id change. A rotation therefore never orphans a photo and never leaves a row
 * that cannot be opened.
 */
export async function rotateProofCiphertext(
  record: { ivHex: string; cipherB64: string; keyId?: ProofKeyId },
  oldKey: CryptoKey,
  newKey: CryptoKey,
  newKeyId: ProofKeyId = "v2",
  aad = "",
): Promise<{ ivHex: string; cipherB64: string; keyId: ProofKeyId }> {
  const plain = await decryptProof(oldKey, record, aad);
  return encryptProof(newKey, plain, aad, newKeyId);
}

