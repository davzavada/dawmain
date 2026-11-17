import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { TtlCache } from "@/src/sources/shared/cache";
import type { Access, LibraryAccess } from "./access-types";
import { LIMITS, ORG_ID_RE, USER_ID_RE } from "./config";
import { clerkStatus } from "./errors";

export type { Access, LibraryAccess } from "./access-types";

/**
 * Who may do what in which library — computed from Clerk on the server,
 * never from input, and never stored (no membership table to go stale):
 *
 *   - personal library `user_…`: Pro when `user.publicMetadata.pro === true`
 *     (strictly true — "true", 1 or {} are not Pro); the owner uploads and
 *     manages everything;
 *   - team library `org_…`: one per Clerk organization the user is a member
 *     of, Pro when the ORGANIZATION's `publicMetadata.pro === true` — the
 *     member needs no Pro of their own. Every member searches, reads and
 *     uploads; a member edits and deletes what they uploaded, the team's
 *     admin (Clerk role `org:admin`) everything;
 *   - quota: `publicMetadata.filesQuota.pages` (a positive number) on the
 *     user / the organization overrides LIMITS.personalPages / teamPages;
 *   - banned or locked users get no library at all;
 *   - feature switches: `publicMetadata.features`, the same shape on the
 *     user and on the organization, e.g.
 *     `{ "pro": true, "features": { "zotero": false } }`. Pro switches
 *     every feature on; `false` (strictly) switches one off. Features:
 *     `files` (Vlastní soubory: search, read, upload) and `zotero`. A
 *     switched-off library stays in `all` (list, delete, export), and only
 *     Pro itself decides the 90-day purge (libraryOwnerState below): a
 *     feature switched off never deletes anything. `features.ukaz` works the
 *     other way round: UKAŽ (doctrine_*) stays off until an admin sets it
 *     to `true`, and like the rest it needs Pro;
 *   - a team's features reach its members: Zotero and UKAŽ are on for a
 *     user when their own Pro OR one of their Pro teams grants them. A
 *     switch-off on a TEAM applies in that team only; a switch-off on the
 *     USER (`features.files` / `features.zotero` strictly false) switches
 *     the feature off for them everywhere, their teams included.
 *
 * `libraries` holds the Pro libraries (search, read, upload); `all` every
 * library the user owns or belongs to, Pro or not, the personal one first
 * (list, delete, export — a user who lost Pro keeps control over what they
 * stored).
 *
 * Two Clerk calls per lookup, in parallel (getUser and the user's
 * organization memberships, which carry each organization with its
 * metadata), cached per user for 60 s on the
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
  return freezeAccess({ userId, banned, libraries: [], all: [], zotero: false, ukaz: false });
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
 * May modify a document — rename it, save its metadata (anything that
 * re-derives the index): in a Pro library, the owner or the team's admin,
 * and a member for what they uploaded.
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

/**
 * Features an admin switches on one by one: `publicMetadata.features.ukaz`
 * must be strictly `true` (UKAŽ, the doctrine tools). The opposite of
 * featureOff: nothing but an explicit grant turns it on.
 */
export function ukazOn(metadata: unknown): boolean {
  return featureOn(metadata, "ukaz");
}

/** An opt-in feature (`ukaz`): on only when strictly `true`. */
export function featureOn(metadata: unknown, feature: "ukaz"): boolean {
  const features = (metadata as { features?: unknown } | null | undefined)?.features;
  return !!features && typeof features === "object" && (features as Record<string, unknown>)[feature] === true;
}

/** The subset of Clerk's User the access needs (keeps tests and mocks small). */
export interface ClerkUserLike {
  id: string;
  banned?: boolean;
  locked?: boolean;
  publicMetadata?: unknown;
}

/** The subset of Clerk's OrganizationMembership the access needs. */
export interface ClerkMembershipLike {
  role?: string | null;
  organization?: { id?: string; name?: string | null; slug?: string | null; publicMetadata?: unknown } | null;
}

/** Teams one user's access carries (Clerk caps memberships far lower; the sign-in hint keeps at most 20 libraries). */
const MAX_TEAMS = 19;

/**
 * One team library from a membership; null for a membership without a
 * usable organization. `filesOff`: the user has Vlastní soubory switched
 * off themselves, which holds in their teams too. Pure.
 */
export function teamLibrary(membership: ClerkMembershipLike, filesOff = false): LibraryAccess | null {
  const org = membership.organization;
  if (!org || typeof org.id !== "string" || !ORG_ID_RE.test(org.id)) return null;
  const pro = proFrom(org.publicMetadata) && !featureOff(org.publicMetadata, "files") && !filesOff;
  const admin = membership.role === "org:admin";
  return {
    id: org.id,
    kind: "org",
    name: (org.name ?? "").trim() || "Tým",
    slug: org.slug ?? null,
    role: admin ? "admin" : "member",
    pro,
    canUpload: pro,
    canManageAll: admin,
    quotaPages: quotaFrom(org.publicMetadata, LIMITS.teamPages),
  };
}

/** Access from a Clerk user and their organization memberships. Pure — unit-tested with plain objects. */
export function buildAccess(user: ClerkUserLike, memberships: readonly ClerkMembershipLike[] = []): Access {
  const userId = user.id;
  if (user.banned === true || user.locked === true) return emptyAccess(userId, true);
  const userPro = proFrom(user.publicMetadata);
  const filesOff = featureOff(user.publicMetadata, "files");
  const pro = userPro && !filesOff;
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
  // What the Pro teams grant their members (a team without Pro grants nothing).
  const teamMeta: unknown[] = [];
  for (const membership of memberships) {
    const team = teamLibrary(membership, filesOff);
    if (!team || teams.some((t) => t.id === team.id)) continue;
    if (teams.length < MAX_TEAMS) teams.push(team);
    if (proFrom(membership.organization?.publicMetadata)) teamMeta.push(membership.organization?.publicMetadata);
  }
  teams.sort((a, b) => a.name.localeCompare(b.name, "cs") || a.id.localeCompare(b.id));
  const all = [personal, ...teams];
  // The user's own switch-off holds everywhere; otherwise their Pro or any Pro team with Zotero on grants it.
  const zotero = !featureOff(user.publicMetadata, "zotero") && (userPro || teamMeta.some((m) => !featureOff(m, "zotero")));
  // UKAŽ hangs under Pro like the rest: switched on and Pro — on the user or on a team.
  const ukaz = (userPro && ukazOn(user.publicMetadata)) || teamMeta.some(ukazOn);
  return { userId, banned: false, libraries: all.filter((l) => l.pro), all, zotero, ukaz };
}

/**
 * The user's organization memberships. An instance without organizations
 * (or one that refuses the call) simply has no teams: 403/404 is an empty
 * list, so the personal library never depends on the teams being set up.
 * Anything else throws like a failed getUser.
 */
async function loadMemberships(client: Awaited<ReturnType<typeof clerkClient>>, userId: string): Promise<ClerkMembershipLike[]> {
  try {
    const { data } = await client.users.getOrganizationMembershipList({ userId, limit: 100 });
    return data;
  } catch (error) {
    const status = clerkStatus(error);
    if (status === 403 || status === 404) return [];
    throw error;
  }
}

async function loadFromClerk(userId: string): Promise<Access> {
  const client = await clerkClient();
  let user: ClerkUserLike;
  let memberships: ClerkMembershipLike[];
  try {
    [user, memberships] = await Promise.all([client.users.getUser(userId), loadMemberships(client, userId)]);
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
 * Does the owner of a library still exist in Clerk, and is it Pro? Pro
 * alone — deliberately not the feature switches: `features.files: false`
 * pauses Vlastní soubory, it must never start the 90-day purge. One
 * Backend API call: getUser for a personal library, getOrganization for a
 * team's (`org_…`). A 404 is "gone" (the deletion webhook may have been
 * missed); other failures throw.
 */
export async function libraryOwnerState(libraryId: string): Promise<OwnerState> {
  if (testOwnerLookup) return testOwnerLookup(libraryId);
  const client = await clerkClient();
  try {
    if (ORG_ID_RE.test(libraryId)) {
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
