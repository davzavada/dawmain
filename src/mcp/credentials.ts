import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "@/src/sources/shared/cache";

/**
 * Readers' library logins — the one piece of state this server keeps about
 * a person beyond the account itself, and it keeps it only when the person
 * types it in on /ucet.
 *
 * Where: Clerk's private user metadata, the account store the server already
 * relies on (server-side only; never sent to the browser by Clerk). How: the
 * password AES-256-GCM-encrypted under a key derived from CREDENTIALS_SECRET,
 * an environment variable that never leaves the deployment — so the store
 * alone (a Clerk export, a dashboard screen) reveals a username and a blob,
 * and the deployment alone reveals nothing. Removing the entry on /ucet
 * deletes it; deleting the account deletes it with the account.
 *
 * Who reads it: doctrine_get_document, for the caller identified by the
 * OAuth token, to sign in to that reader's library proxy and open a licensed
 * work on their behalf. The shared access code identifies nobody, so it
 * cannot use these.
 */

export type LibraryId = "peacepalace" | "cuni";

export const LIBRARIES: Record<LibraryId, { label: string; loginHint: string }> = {
  peacepalace: {
    label: "Peace Palace Library (Haag)",
    loginHint: "Čtenářské jméno a heslo, kterými se přihlašujete na peacepalacelibrary.nl / WorldCat (SAML).",
  },
  cuni: {
    label: "Univerzita Karlova (UKAŽ, vzdálený přístup)",
    loginHint: "Přihlašovací jméno a heslo do CAS UK (cas.cuni.cz) — stejné jako do SIS.",
  },
};

export const LIBRARY_IDS = Object.keys(LIBRARIES) as LibraryId[];

export function isLibraryId(value: unknown): value is LibraryId {
  return typeof value === "string" && (LIBRARY_IDS as string[]).includes(value);
}

export interface ReaderCredential {
  username: string;
  password: string;
}

/** What is stored: the username in the clear (it is what the page shows
 * back), the password sealed. */
export interface StoredCredential {
  username: string;
  /** base64(iv ‖ tag ‖ ciphertext) */
  sealed: string;
  updatedAt: string;
}

const MIN_SECRET_CHARS = 16;

/** Whether the deployment can seal anything at all. */
export function credentialsConfigured(): boolean {
  return (process.env.CREDENTIALS_SECRET?.trim().length ?? 0) >= MIN_SECRET_CHARS;
}

function key(): Buffer {
  const secret = process.env.CREDENTIALS_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_CHARS) {
    throw new Error(`CREDENTIALS_SECRET is not set (needs at least ${MIN_SECRET_CHARS} characters) — reader logins cannot be stored or read.`);
  }
  // A fixed derivation of a high-entropy secret; the secret IS the key material.
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM; a fresh IV per call, tag appended. Pure given the env. */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function openSecret(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 12 + 16 + 1) throw new Error("Sealed secret is too short.");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const METADATA_KEY = "libraries";

type Libraries = Partial<Record<LibraryId, StoredCredential>>;

function librariesOf(privateMetadata: unknown): Libraries {
  const meta = (privateMetadata ?? {}) as Record<string, unknown>;
  const stored = meta[METADATA_KEY];
  if (!stored || typeof stored !== "object") return {};
  const out: Libraries = {};
  for (const id of LIBRARY_IDS) {
    const entry = (stored as Record<string, unknown>)[id];
    if (!entry || typeof entry !== "object") continue;
    const { username, sealed, updatedAt } = entry as Record<string, unknown>;
    if (typeof username === "string" && typeof sealed === "string") {
      out[id] = { username, sealed, updatedAt: typeof updatedAt === "string" ? updatedAt : "" };
    }
  }
  return out;
}

async function fetchLibraries(userId: string): Promise<Libraries> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return librariesOf(user.privateMetadata);
}

/** What /ucet shows: never the secret. */
export async function readerCredentialSummary(userId: string): Promise<Record<LibraryId, { username: string; updatedAt: string } | null>> {
  const stored = await fetchLibraries(userId);
  const out = {} as Record<LibraryId, { username: string; updatedAt: string } | null>;
  for (const id of LIBRARY_IDS) {
    const entry = stored[id];
    out[id] = entry ? { username: entry.username, updatedAt: entry.updatedAt } : null;
  }
  return out;
}

export async function saveReaderCredential(userId: string, library: LibraryId, credential: ReaderCredential): Promise<void> {
  const username = credential.username.trim();
  if (!username || username.length > 200 || !credential.password || credential.password.length > 500) {
    throw new Error("Přihlašovací jméno i heslo musí být vyplněné (jméno do 200, heslo do 500 znaků).");
  }
  const stored: StoredCredential = { username, sealed: sealSecret(credential.password), updatedAt: new Date().toISOString() };
  const client = await clerkClient();
  // Deep-merged by Clerk: other libraries' entries survive.
  await client.users.updateUserMetadata(userId, { privateMetadata: { [METADATA_KEY]: { [library]: stored } } });
  credentialCache.set(memoKey("reader-credentials", userId), undefined as never);
}

export async function deleteReaderCredential(userId: string, library: LibraryId): Promise<void> {
  const client = await clerkClient();
  // null removes the key under Clerk's deep merge.
  await client.users.updateUserMetadata(userId, { privateMetadata: { [METADATA_KEY]: { [library]: null } } });
  credentialCache.set(memoKey("reader-credentials", userId), undefined as never);
}

const credentialCache = new TtlCache<Partial<Record<LibraryId, ReaderCredential>>>(SEARCH_TTL_MS, 100);

/**
 * The caller's usable logins, unsealed — for the tool, per invocation,
 * cached briefly so a research session does not hit Clerk on every read.
 * Undecryptable entries (secret rotated) are skipped, not fatal.
 */
export async function loadReaderCredentials(userId: string): Promise<Partial<Record<LibraryId, ReaderCredential>>> {
  const cacheKey = memoKey("reader-credentials", userId);
  const cached = credentialCache.get(cacheKey);
  if (cached) return cached;
  if (!credentialsConfigured()) return {};
  const stored = await fetchLibraries(userId);
  const out: Partial<Record<LibraryId, ReaderCredential>> = {};
  for (const id of LIBRARY_IDS) {
    const entry = stored[id];
    if (!entry) continue;
    try {
      out[id] = { username: entry.username, password: openSecret(entry.sealed) };
    } catch {
      // Sealed under another secret — unusable, and not the tool's business to say more.
    }
  }
  credentialCache.set(cacheKey, out);
  return out;
}
