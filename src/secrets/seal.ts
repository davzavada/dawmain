import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Sealing small per-user secrets (a Zotero API key, the OAuth request token
 * that waits in a cookie between /connect and /callback).
 *
 * AES-256-GCM with a fresh 12-byte IV per seal; the key is derived with
 * HKDF from CREDENTIALS_SECRET, an environment variable that never leaves
 * the deployment. Each use has its own `purpose` (the HKDF info), so a blob
 * sealed for one purpose never opens as another; `aad` binds the blob to
 * its context (e.g. the Clerk user id), so a blob copied onto another
 * account does not open either. The store alone (a Clerk export, a
 * dashboard screen, a cookie) reveals nothing; the deployment alone holds
 * nothing to reveal.
 *
 * Format: "v1." + base64url(iv ‖ tag ‖ ciphertext).
 *
 * Restored and generalised from the reader-credentials store removed in
 * 85d0bcc (src/mcp/credentials.ts).
 */

export type SealPurpose = "zotero-api-key-v1" | "zotero-oauth-state-v1";

const MIN_SECRET_CHARS = 32;
const PREFIX = "v1.";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Whether the deployment can seal anything at all (env only). */
export function secretsConfigured(): boolean {
  return (process.env.CREDENTIALS_SECRET?.trim().length ?? 0) >= MIN_SECRET_CHARS;
}

function key(purpose: SealPurpose): Buffer {
  const secret = process.env.CREDENTIALS_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_CHARS) {
    throw new Error(`CREDENTIALS_SECRET is not set (needs at least ${MIN_SECRET_CHARS} characters) — secrets cannot be sealed or opened.`);
  }
  // HKDF over a high-entropy secret (the secret IS the key material); the
  // purpose keeps each use's key distinct.
  return Buffer.from(hkdfSync("sha256", secret, "dawmain", purpose, 32));
}

/** AES-256-GCM; a fresh IV per call, tag stored before the ciphertext. */
export function sealSecret(plain: string, purpose: SealPurpose, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Throws on a wrong secret, purpose or aad, and on any tampering. */
export function openSecret(sealed: string, purpose: SealPurpose, aad: string): string {
  if (typeof sealed !== "string" || !sealed.startsWith(PREFIX)) throw new Error("Sealed secret has an unknown format.");
  const body = sealed.slice(PREFIX.length);
  const raw = Buffer.from(body, "base64url");
  // Node's decoder skips characters outside the alphabet and ignores the
  // spare bits of the last one, so many strings decode to the same bytes.
  // Only the exact encoding sealSecret produced is accepted.
  if (raw.toString("base64url") !== body) throw new Error("Sealed secret has an unknown format.");
  // An empty plaintext seals to exactly IV + tag; anything shorter is not ours.
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed secret is too short.");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  // A fixed tag length: GCM would otherwise accept a truncated tag.
  const decipher = createDecipheriv("aes-256-gcm", key(purpose), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
