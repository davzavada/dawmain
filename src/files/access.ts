import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { TtlCache } from "@/src/sources/shared/cache";
import type { Access, LibraryAccess } from "./access-types";
import { LIMITS, USER_ID_RE } from "./config";
import { sanitizeLine } from "./dmd/normalize";
import { clerkStatus } from "./errors";

export type { Access, LibraryAccess } from "./access-types";

/**
 * Who may do what in which library — computed from Clerk on the server,
 * never from input, and never stored (no membership table to go stale):
 *
 *   - personal library `user_…`: Pro when `user.publicMetadata.pro === true`
 *     (strictly true — "true", 1 or {} are not Pro); the owner uploads and
 *     manages everything;
 *   - team library `org_…` for every membership: Pro when
 *     `organization.publicMetadata?.pro === true` (publicMetadata may be
 *     null); every member uploads and edits their own documents, org:admin
 *     manages all of them;
 *   - quota: `publicMetadata.filesQuota.pages` (a positive number) on the
 *     user / organization overrides LIMITS.personalPages / teamPages;
 *   - banned or locked users get no library at all.
 *
 * `libraries` holds the Pro libraries (search, read, upload); `all` every
 * library the user owns or belongs to, Pro or not (list, delete, export —
 * a user who lost Pro keeps control over what they stored).
 *
 * Two Clerk calls per lookup (getUser + getOrganizationMembershipList, in
 * parallel), cached per user for 60 s on the instance; `fresh` (uploads,
 * edits) accepts at most 10 s, `joined` (right after accepting a team
 * invitation, so the team shows up at once) at most 2 s — which also caps
 * the Backend API rate one user can cause. Concurrent lookups of one user share a single request.
 * Cached objects are frozen: one warm instance serves many users at once,
 * and nothing may mutate what another request is reading.
 */

const CACHE_TTL_MS = 60_000;
const FRESH_TTL_MS = 10_000;
const JOINED_TTL_MS = 2_000;
/** Clerk's page size cap for membership lists; a user in more teams is an operator anomaly. */
const MEMBERSHIP_LIMIT = 100;
/** Name of the personal library in the UI and in tool output. */
export const PERSONAL_LIBRARY_NAME = "Osobní";
const MAX_NAME = 120;

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

/**
 * Forget a user's cached access on this instance — after a change made
 * here that alters it (a member removed from a team). Other instances
 * catch up within their TTL.
 */
export function invalidateAccess(userId: string): void {
  cache.delete(userId);
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
  return freezeAccess({ userId, banned, libraries: [], all: [] });
}

/**
 * The caller's access, from the instance cache when young enough (60 s,
 * 10 s with `fresh`, 2 s with `joined`). A malformed id never reaches
 * Clerk. Clerk failures throw (the caller answers "temporarily
 * unavailable"); a user Clerk does not know gets an empty access, which is
 * cached like any other.
 */
export async function getAccess(userId: string, opts: { fresh?: boolean; joined?: boolean } = {}): Promise<Access> {
  if (!USER_ID_RE.test(userId)) return emptyAccess(userId);
  const hit = cache.get(userId);
  const maxAge = opts.joined ? JOINED_TTL_MS : opts.fresh ? FRESH_TTL_MS : CACHE_TTL_MS;
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

/** Member edits own documents; owner / org:admin edit all. Uploading rights (Pro) are required either way. */
export function canEditDocument(lib: LibraryAccess, uploadedBy: string, userId: string): boolean {
  return lib.canManageAll || (lib.canUpload && uploadedBy === userId);
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

/** The subset of Clerk's User the access needs (keeps tests and mocks small). */
export interface ClerkUserLike {
  id: string;
  banned?: boolean;
  locked?: boolean;
  publicMetadata?: unknown;
}

export interface ClerkMembershipLike {
  role: string;
  organization: { id: string; name?: string | null; slug?: string | null; publicMetadata?: unknown };
}

/**
 * Access from a Clerk user and their memberships. Pure — unit-tested with
 * plain objects. Personal library first, then teams in name order;
 * duplicates and malformed org ids are dropped.
 */
export function buildAccess(user: ClerkUserLike, memberships: ClerkMembershipLike[]): Access {
  const userId = user.id;
  if (user.banned === true || user.locked === true) return emptyAccess(userId, true);
  const pro = proFrom(user.publicMetadata);
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
  const teams: LibraryAccess[] = [];
  const seen = new Set<string>();
  for (const m of memberships) {
    const org = m?.organization;
    if (!org || typeof org.id !== "string" || !/^org_[A-Za-z0-9]+$/.test(org.id) || seen.has(org.id)) continue;
    seen.add(org.id);
    const teamPro = proFrom(org.publicMetadata);
    const admin = m.role === "org:admin";
    const slug = typeof org.slug === "string" ? sanitizeLine(org.slug, MAX_NAME) : "";
    teams.push({
      id: org.id,
      kind: "org",
      name: sanitizeLine(typeof org.name === "string" ? org.name : "", MAX_NAME) || slug || "Tým",
      slug: slug || null,
      role: admin ? "org:admin" : "org:member",
      pro: teamPro,
      canUpload: teamPro,
      canManageAll: admin,
      quotaPages: quotaFrom(org.publicMetadata, LIMITS.teamPages),
    });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name, "cs") || a.id.localeCompare(b.id));
  const all = [personal, ...teams];
  return { userId, banned: false, libraries: all.filter((l) => l.pro), all };
}

async function loadFromClerk(userId: string): Promise<Access> {
  const client = await clerkClient();
  let user: ClerkUserLike;
  let memberships: ClerkMembershipLike[];
  try {
    const [u, list] = await Promise.all([
      client.users.getUser(userId),
      client.users.getOrganizationMembershipList({ userId, limit: MEMBERSHIP_LIMIT }),
    ]);
    user = u;
    memberships = list.data;
  } catch (error) {
    if (clerkStatus(error) === 404) return emptyAccess(userId);
    throw error;
  }
  return buildAccess(user, memberships);
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
 * Does the owner of a library still exist in Clerk, and is it Pro? One
 * Backend API call (getUser / getOrganization). A 404 is "gone" (the
 * deletion webhook may have been missed); other failures throw.
 */
export async function libraryOwnerState(libraryId: string): Promise<OwnerState> {
  if (testOwnerLookup) return testOwnerLookup(libraryId);
  const client = await clerkClient();
  try {
    if (libraryId.startsWith("org_")) {
      const org = await client.organizations.getOrganization({ organizationId: libraryId });
      return proFrom(org.publicMetadata) ? "pro" : "not_pro";
    }
    const user = await client.users.getUser(libraryId);
    return proFrom(user.publicMetadata) && !user.banned ? "pro" : "not_pro";
  } catch (error) {
    if (clerkStatus(error) === 404) return "gone";
    throw error;
  }
}
