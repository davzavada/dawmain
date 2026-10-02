import "server-only";
import { createHash } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { USER_ID_RE } from "@/src/files/config";
import { openSecret, sealSecret } from "@/src/secrets/seal";
import { TtlCache } from "@/src/sources/shared/cache";
import { CACHE_TTL_MS, ZOTERO_KEY_RE, type ZoteroMode } from "./config";
import type { ConnectionState } from "./types";

/**
 * A user's Zotero connection, kept in Clerk's private user metadata under
 * `zotero` — server-side only, gone with the account, no migration, and no
 * database to wake on every tool call. The API key is sealed
 * (src/secrets/seal.ts) with aad "zotero:<Clerk user id>", so a Clerk
 * export or a blob copied onto another account reveals and opens nothing.
 *
 * Stored shape (v1), written whole on every save:
 *
 *   { v: 1, userID, username, sealed, fp, notes, groups, connectedAt, revokedAt, mode, keyWrite }
 *
 * `mode` and `keyWrite` came later and stay optional on read: a record
 * without them (connected while the integration was read-only) is "read".
 * `keyWrite` is what /keys/current said about writing to the personal
 * library at connect time; the effective mode is "write" only when both
 * the stored mode and keyWrite say so.
 *
 * updateUserMetadata deep-merges objects (arrays and scalars are replaced),
 * so a partial write would keep whatever it leaves out — a stale revokedAt
 * would make a fresh key look revoked. A null deletes the key it is written
 * to, at any depth: `zotero: null` removes the connection, and the null
 * fields of a record (sealed, fp, revokedAt) read back as absent.
 *
 * `fp` (a short hash of the key) lets markRevoked clear exactly the key that
 * Zotero rejected, and not a newer one the user connected in the meantime.
 *
 * Read fresh from Clerk: the disconnect and the callback run on other
 * instances, and a cache here would keep using a key the user just
 * removed. Only a 2-second micro-cache and in-flight sharing smooth out the
 * bursts of one tool call (gate + tool body), and every write here clears
 * them for that user.
 */

const METADATA_KEY = "zotero";
const MAX_USERNAME_CHARS = 255;
const NONE: ConnectionState = Object.freeze({ state: "none" });

type Groups = "all" | "none" | number[];

interface StoredConnection {
  v: 1;
  userID: number;
  username: string;
  sealed: string | null;
  fp: string | null;
  notes: boolean;
  groups: Groups;
  connectedAt: string;
  revokedAt: string | null;
  mode: ZoteroMode;
  keyWrite: boolean;
}

/** What the OAuth callback hands over after checking the key. */
export interface NewConnection {
  userID: number;
  username: string;
  key: string;
  notes: boolean;
  groups: Groups;
  /** The effective mode (the callback has already narrowed "write" to what the key allows). */
  mode: ZoteroMode;
  /** Whether the key may write to the personal library (whatever the mode). */
  keyWrite: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers

/** First 16 hex characters of sha256(key) — identifies a key without revealing it. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

function keyAad(userId: string): string {
  return `zotero:${userId}`;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isGroups(value: unknown): value is Groups {
  return value === "all" || value === "none" || (Array.isArray(value) && value.every(isPositiveId));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * The stored record when it has the v1 shape, else null (treated as "not
 * connected"). The nullable fields may be absent: Clerk's merge deletes a
 * key written as null instead of storing the null.
 */
function parseStored(raw: unknown): StoredConnection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isPositiveId(r.userID)) return null;
  if (typeof r.username !== "string" || r.username.length > MAX_USERNAME_CHARS) return null;
  if (typeof r.notes !== "boolean" || !isGroups(r.groups) || !isTimestamp(r.connectedAt)) return null;
  const sealed = r.sealed ?? null;
  const fp = r.fp ?? null;
  const revokedAt = r.revokedAt ?? null;
  if (sealed !== null && typeof sealed !== "string") return null;
  if (fp !== null && typeof fp !== "string") return null;
  if (revokedAt !== null && !isTimestamp(revokedAt)) return null;
  // Older records carry neither; an unknown value never widens to "write".
  const keyWrite = r.keyWrite === true;
  const mode: ZoteroMode = r.mode === "write" && keyWrite ? "write" : "read";
  return {
    v: 1,
    userID: r.userID,
    username: r.username,
    sealed,
    fp,
    notes: r.notes,
    groups: Array.isArray(r.groups) ? [...r.groups] : r.groups,
    connectedAt: r.connectedAt,
    revokedAt,
    mode,
    keyWrite,
  };
}

/**
 * The state a stored record means for `userId`. A revocation wins over a
 * key (a key Zotero rejected is never tried again — invalid keys count
 * towards Zotero's per-IP block); a key that does not open, or opens to
 * something whose fingerprint does not match, is unreadable — markRevoked
 * could never clear it, so it must not be used.
 */
function toState(userId: string, raw: unknown): ConnectionState {
  const stored = parseStored(raw);
  if (!stored) return NONE;
  const { username } = stored;
  if (stored.revokedAt !== null) return { state: "revoked", username, revokedAt: stored.revokedAt };
  if (stored.sealed === null) return NONE;
  let key: string;
  try {
    key = openSecret(stored.sealed, "zotero-api-key-v1", keyAad(userId));
  } catch {
    // CREDENTIALS_SECRET rotated (or the blob belongs to another account).
    return { state: "unreadable", username };
  }
  const fp = keyFingerprint(key);
  if (!ZOTERO_KEY_RE.test(key) || stored.fp !== fp) return { state: "unreadable", username };
  return {
    state: "ok",
    conn: {
      creds: { userID: stored.userID, key },
      username,
      notes: stored.notes,
      groups: stored.groups,
      connectedAt: stored.connectedAt,
      fp,
      mode: stored.mode,
    },
  };
}

/** Cached states are shared by concurrent requests of the instance; nothing may mutate them. */
function freezeState(state: ConnectionState): ConnectionState {
  if (state.state === "ok") {
    Object.freeze(state.conn.creds);
    if (Array.isArray(state.conn.groups)) Object.freeze(state.conn.groups);
    Object.freeze(state.conn);
  }
  return Object.freeze(state);
}

function assertUserId(userId: string): void {
  if (!USER_ID_RE.test(userId)) throw new Error("invalid user id");
}

// ---------------------------------------------------------------------------
// Clerk I/O

const newCache = () => new TtlCache<ConnectionState>(CACHE_TTL_MS.connection, 1_000);
let cache = newCache();
const inflight = new Map<string, Promise<ConnectionState>>();

/** Tests start from an empty micro-cache. */
export function __resetZoteroStoreForTests(): void {
  cache = newCache();
  inflight.clear();
}

/** Drop the cached state and detach any in-flight read, so neither outlives a write. */
function forget(userId: string): void {
  cache.delete(userId);
  inflight.delete(userId);
}

/** Clerk's "no such user" (ClerkAPIResponseError 404), duck-typed so a mocked client's errors count too. */
function clerkNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  return !!e && typeof e === "object" && e.code === "api_response_error" && e.status === 404;
}

/** The raw `privateMetadata.zotero` value; undefined for a user Clerk does not know. */
async function readRaw(userId: string): Promise<unknown> {
  const client = await clerkClient();
  try {
    const user = await client.users.getUser(userId);
    const meta = user.privateMetadata as Record<string, unknown> | null | undefined;
    return meta?.[METADATA_KEY];
  } catch (error) {
    if (clerkNotFound(error)) return undefined;
    throw error;
  }
}

async function write(userId: string, value: StoredConnection | null): Promise<void> {
  // Before: no read that started earlier may be joined or cached. After: a
  // read that started during the write may have seen the old value.
  forget(userId);
  try {
    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, { privateMetadata: { [METADATA_KEY]: value } });
  } finally {
    forget(userId);
  }
}

/**
 * The user's connection. Clerk failures throw (the caller answers
 * "temporarily unavailable"); an unknown user, a malformed id and any
 * record that is not exactly v1 are "none". Concurrent calls for one user
 * share a single Clerk read, and the result is reused for
 * CACHE_TTL_MS.connection.
 */
export async function loadConnection(userId: string): Promise<ConnectionState> {
  if (!USER_ID_RE.test(userId)) return NONE;
  const hit = cache.get(userId);
  if (hit) return hit;
  const pending = inflight.get(userId);
  if (pending) return pending;
  const load: Promise<ConnectionState> = readShared(userId, () => inflight.get(userId) === load);
  inflight.set(userId, load);
  return load;
}

/**
 * One Clerk read on behalf of every caller joined to it. `current()` turns
 * false once a write detached this read from `inflight`: its result may
 * predate the write, so it is returned to the callers that were already
 * waiting but never cached.
 */
async function readShared(userId: string, current: () => boolean): Promise<ConnectionState> {
  try {
    const state = freezeState(toState(userId, await readRaw(userId)));
    if (current()) cache.set(userId, state);
    return state;
  } finally {
    if (current()) inflight.delete(userId);
  }
}

/**
 * Store a freshly authorised key, replacing whatever was there (including a
 * revocation — revokedAt is written as null explicitly). Throws on a
 * malformed input or when CREDENTIALS_SECRET is missing; no message
 * carries the key.
 */
export async function saveConnection(userId: string, input: NewConnection): Promise<void> {
  assertUserId(userId);
  if (!isPositiveId(input.userID)) throw new Error("invalid Zotero userID");
  if (typeof input.key !== "string" || !ZOTERO_KEY_RE.test(input.key)) throw new Error("malformed Zotero API key");
  if (typeof input.username !== "string") throw new Error("invalid Zotero username");
  if (typeof input.notes !== "boolean") throw new Error("invalid notes flag");
  if (!isGroups(input.groups)) throw new Error("invalid group access");
  if (input.mode !== "read" && input.mode !== "write") throw new Error("invalid Zotero connection mode");
  if (typeof input.keyWrite !== "boolean") throw new Error("invalid write flag");
  if (input.mode === "write" && !input.keyWrite) throw new Error("write mode needs a key that can write");
  const record: StoredConnection = {
    v: 1,
    userID: input.userID,
    username: input.username.trim().slice(0, MAX_USERNAME_CHARS),
    sealed: sealSecret(input.key, "zotero-api-key-v1", keyAad(userId)),
    fp: keyFingerprint(input.key),
    notes: input.notes,
    groups: Array.isArray(input.groups) ? [...new Set(input.groups)].sort((a, b) => a - b) : input.groups,
    connectedAt: new Date().toISOString(),
    revokedAt: null,
    mode: input.mode,
    keyWrite: input.keyWrite,
  };
  await write(userId, record);
}

/**
 * Zotero rejected the key with fingerprint `fp`: drop the sealed key and
 * remember when, so the gate stops before calling Zotero again. Re-reads
 * Clerk (not the micro-cache) and writes only when the stored key is still
 * that one — a key the user reconnected in the meantime stays. Clerk has
 * no conditional write, so a reconnect landing in the milliseconds between
 * this read and write can still be overwritten; the next call then finds
 * "revoked" and the user connects again. Returns whether it marked.
 */
export async function markRevoked(userId: string, fp: string): Promise<boolean> {
  assertUserId(userId);
  const stored = parseStored(await readRaw(userId));
  if (!stored || stored.sealed === null || stored.fp === null || stored.fp !== fp || stored.revokedAt !== null) return false;
  await write(userId, { ...stored, sealed: null, fp: null, revokedAt: new Date().toISOString() });
  return true;
}

/** Forget the connection entirely (disconnect). The key on zotero.org is the caller's to revoke. */
export async function deleteConnection(userId: string): Promise<void> {
  assertUserId(userId);
  await write(userId, null);
}
