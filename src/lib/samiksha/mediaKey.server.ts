/**
 * The proof vault's AES-256 key, from whatever the operator put in the
 * environment. Server-only: it uses node:crypto.
 *
 * Base64 that decodes to exactly 32 bytes is used as it is. Any other non-empty
 * text (a passphrase typed into the deployment settings) is hashed with SHA-256
 * into 32 bytes, so a key in the wrong format never stops a photo from being
 * stored. Nothing here is derived from anything public: with no text there is
 * no key.
 */
import { createHash } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function resolveMediaKey(raw?: string | null): Buffer | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.length % 4 === 0 && BASE64.test(text)) {
    const bytes = Buffer.from(text, "base64");
    if (bytes.length === 32) return bytes;
  }
  return createHash("sha256").update(text, "utf8").digest();
}

/** The same key as base64, the form the key ring carries; null when there is no key. */
export function mediaKeyBase64(raw?: string | null): string | null {
  return resolveMediaKey(raw)?.toString("base64") ?? null;
}
