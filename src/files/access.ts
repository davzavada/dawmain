import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { TtlCache } from "@/src/sources/shared/cache";
import type { Access, LibraryAccess } from "./access-types";
import { LIMITS, USER_ID_RE } from "./config";
import { clerkStatus } from "./errors";

export type { Access, LibraryAccess } from "./access-types";

/**
 * Who may do what in which library — computed from Clerk on the server,
 * never from input, and never stored (no membership table to go stale):
 *
 *   - personal library `user_…`: Pro when `user.publicMetadata.pro === true`
 *     (strictly true — "true", 1 or {} are not Pro); the owner uploads and
 *     manages everything;
 *   - quota: `publicMetadata.filesQuota.pages` (a positive number) on the
 *     user overrides LIMITS.personalPages;
 *   - banned or locked users get no library at all;
 *   - feature switches: `publicMetadata.features` on the user, e.g.
 *     `{ "pro": true, "features": { "zotero": false } }`. Pro switches
 *     every feature on; `false` (strictly) switches one off. Features:
 *     `files` (Vlastní soubory: search, read, upload) and `zotero`. A
 *     switched-off library stays in `all` (list, delete, export), and only
 *     Pro itself decides the 90-day purge (libraryOwnerState below): a
 *     feature switched off never deletes anything.
 *
 * There are no shared (team) libraries: Clerk organizations are ignored.
 * `libraries` holds the Pro library (search, read, upload); `all` the
 * personal library, Pro or not (list, delete, export — a user who lost Pro
 * keeps control over what they stored).
 *
 * One Clerk call per lookup (getUser), cached per user for 60 s on the
 * instance; `fresh` (uploads, edits) accepts at most 10 s — which also caps
 * the Backend API rate one user can cause. Concurrent lookups of one user share a single request.
 * Cached objects are frozen: one warm instance serves many users at once,
 * and nothing may mutate what another request is reading.
 */

const CACHE_TTL_MS = 60_000;
const FRESH_TTL_MS = 10_000;
/** Name of the personal library in the UI and in tool output. */
export const PERSONAL_LIBRARY_NAME = "Osobní";

type Loader = (userId: string) => Promise<Access>;

const newCache = () => new TtlCache<{ at: number; access: Access }>(CACHE_TTL_MS, 1_000);
let cache = newCache();
const inflight = new Map<string, Promise<Access>>();
let testLoader: Loader | null = null;

/** Tests replace the Clerk lookup (and start from an empty cache). */
export function __setAccessLoaderForTests(loader: Loader | null): void {
  testLoader = loader;
  cache = newCache();
  inflight.clear();
}

/** Deep-freeze an Access so a cached value can be shared across requests. */
export function freezeAccess(access: Access): Access {
  for (const lib of access.all) Object.freeze(lib);
  for (const lib of access.libraries) Object.freeze(lib);
  Object.freeze(access.all);
  Object.freeze(access.libraries);
  return Object.freeze(access);
}

/** An account that exists nowhere (or is banned): no libraries. */
export function emptyAccess(userId: string, banned = false): Access {
  return freezeAccess({ userId, banned, libraries: [], all: [], zotero: false });
}

/**
 * The caller's access, from the instance cache when young enough (60 s,
 * 10 s with `fresh`). A malformed id never reaches
 * Clerk. Clerk failures throw (the caller answers "temporarily
 * unavailable"); a user Clerk does not know gets an empty access, which is
 * cached like any other.
 */
export async function getAccess(userId: string, opts: { fresh?: boolean } = {}): Promise<Access> {
  if (!USER_ID_RE.test(userId)) return emptyAccess(userId);
  const hit = cache.get(userId);
  const maxAge = opts.fresh ? FRESH_TTL_MS : CACHE_TTL_MS;
  if (hit && Date.now() - hit.at <= maxAge) return hit.access;

  const pending = inflight.get(userId);
  if (pending) return pending;
  const load = (async () => {
    try {
      const access = freezeAccess(await (testLoader ?? loadFromClerk)(userId));
      cache.set(userId, { at: Date.now(), access });
      return access;
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, load);
  return load;
}

/**
 * May modify a document — save or confirm its metadata (anything that
 * re-derives the index): the owner, and only in a Pro library.
 */
export function canEditDocument(lib: LibraryAccess, uploadedBy: string, userId: string): boolean {
  return lib.pro && (lib.canManageAll || (lib.canUpload && uploadedBy === userId));
}

/**
 * May delete or export a document — ownership only, Pro not required (a
 * user who lost Pro keeps control over what they stored): the uploader
 * or the owner of the library. The library must come from
 * ownedScope (the caller belongs to it).
 */
export function canDeleteDocument(lib: LibraryAccess, uploadedBy: string, userId: string): boolean {
  return lib.canManageAll || uploadedBy === userId;
}

// ---------------------------------------------------------------------------
// Clerk

/** `publicMetadata.filesQuota.pages` when it is a positive finite number, else the default. */
export function quotaFrom(metadata: unknown, fallback: number): number {
  const quota = (metadata as { filesQuota?: { pages?: unknown } } | null | undefined)?.filesQuota;
  const pages = quota && typeof quota === "object" ? quota.pages : undefined;
  return typeof pages === "number" && Number.isFinite(pages) && pages >= 1 ? Math.floor(pages) : fallback;
}

/** Strict Pro flag: only the boolean `true` counts. */
export function proFrom(metadata: unknown): boolean {
  return (metadata as { pro?: unknown } | null | undefined)?.pro === true;
}

/** Features Pro switches on and `publicMetadata.features` can switch off one by one. */
export type Feature = "files" | "zotero";

/** Strict switch-off: only the boolean `false` at `features.<name>` turns a feature off; anything else leaves it on. */
export function featureOff(metadata: unknown, feature: Feature): boolean {
  const features = (metadata as { features?: unknown } | null | undefined)?.features;
  return !!features && typeof features === "object" && (features as Record<string, unknown>)[feature] === false;
}

/** The subset of Clerk's User the access needs (keeps tests and mocks small). */
export interface ClerkUserLike {
  id: string;
  banned?: boolean;
  locked?: boolean;
  publicMetadata?: unknown;
}

/** Access from a Clerk user. Pure — unit-tested with plain objects. */
export function buildAccess(user: ClerkUserLike): Access {
  const userId = user.id;
  if (user.banned === true || user.locked === true) return emptyAccess(userId, true);
  const userPro = proFrom(user.publicMetadata);
  const userFilesOff = featureOff(user.publicMetadata, "files");
  const userZoteroOff = featureOff(user.publicMetadata, "zotero");
  const pro = userPro && !userFilesOff;
  const zotero = userPro && !userZoteroOff;
  const personal: LibraryAccess = {
    id: userId,
    kind: "user",
    name: PERSONAL_LIBRARY_NAME,
    slug: null,
    role: "owner",
    pro,
    canUpload: pro,
    canManageAll: true,
    quotaPages: quotaFrom(user.publicMetadata, LIMITS.personalPages),
  };
  const all = [personal];
  return { userId, banned: false, libraries: all.filter((l) => l.pro), all, zotero };
}

async function loadFromClerk(userId: string): Promise<Access> {
  const client = await clerkClient();
  let user: ClerkUserLike;
  try {
    user = await client.users.getUser(userId);
  } catch (error) {
    if (clerkStatus(error) === 404) return emptyAccess(userId);
    throw error;
  }
  return buildAccess(user);
}

// ---------------------------------------------------------------------------
// Library owners (daily cron)

export type OwnerState = "pro" | "not_pro" | "gone";
type OwnerLookup = (libraryId: string) => Promise<OwnerState>;
let testOwnerLookup: OwnerLookup | null = null;

/** Tests replace the Clerk lookup behind libraryOwnerState. */
export function __setOwnerLookupForTests(lookup: OwnerLookup | null): void {
  testOwnerLookup = lookup;
}

/**
 * Does the owner of a library still exist in Clerk, and is it Pro? Pro
 * alone — deliberately not the feature switches: `features.files: false`
 * pauses Vlastní soubory, it must never start the 90-day purge. One
 * Backend API call (getUser). A 404 is "gone" (the deletion webhook may
 * have been missed); other failures throw. A team library (`org_…`) left
 * over from before teams were removed is never Pro again: it takes the
 * ordinary 90-day path to deletion.
 */
export async function libraryOwnerState(libraryId: string): Promise<OwnerState> {
  if (testOwnerLookup) return testOwnerLookup(libraryId);
  if (libraryId.startsWith("org_")) return "not_pro";
  const client = await clerkClient();
  try {
    const user = await client.users.getUser(libraryId);
    return proFrom(user.publicMetadata) && !user.banned ? "pro" : "not_pro";
  } catch (error) {
    if (clerkStatus(error) === 404) return "gone";
    throw error;
  }
}
