/**
 * Teams on the admin page (app/sprava/tymy): what a team looks like to an
 * admin and how one change becomes a Clerk call. Pure, no server-only
 * imports, so client components can use the types and the validators.
 *
 * A team is a Clerk organization. Admins create, rename, staff and delete
 * teams; members never invite anyone (src/files/access.ts reads the
 * memberships). Everything an admin switches on a team lives in the
 * organization's `publicMetadata`, where the access code already reads it:
 *
 *   pro         true = the team is active (its library is searched and
 *               uploaded into); false = deactivated (members still list,
 *               delete and export, and the purge starts: about a week, the same as a user who lost Pro);
 *   filesQuota  { mb } overrides LIMITS.teamBytes (storage of the originals).
 *
 * Roles: org:admin = "správce týmu" (manages every document of the team),
 * org:member = "člen" (uploads, edits and deletes their own).
 */

import { MAX_QUOTA_MB, ownQuotaMb, validQuotaMb } from "./model";

export type TeamRole = "org:admin" | "org:member";
export const TEAM_ROLES: readonly TeamRole[] = ["org:admin", "org:member"];

export interface TeamMember {
  userId: string;
  role: TeamRole;
  /** Epoch ms of joining, null where Clerk has none. */
  joinedAt: number | null;
}

/** What the files database knows about the team's library; null when it was never used or is not reachable. */
export interface TeamLibraryStats {
  documents: number;
  pages: number;
  /** Bytes of originals stored or being uploaded (what the quota counts). */
  bytes: number;
  /** Deactivated and waiting for the purge (ISO), or null. */
  purgeAfter: string | null;
}

export interface AdminTeam {
  id: string;
  name: string;
  slug: string | null;
  createdAt: number | null;
  /** publicMetadata.pro === true: the library is searched and uploaded into. */
  active: boolean;
  /** The team's own storage quota in MB, or null for the installation's default (LIMITS.teamBytes). */
  quotaMb: number | null;
  members: TeamMember[];
  library: TeamLibraryStats | null;
  /** The logo an admin uploaded (Clerk's organization image), or null: initials are shown instead. */
  logoUrl: string | null;
}

export type TeamChange =
  | { kind: "create"; name: string }
  | { kind: "rename"; name: string }
  | { kind: "active"; on: boolean }
  /** `mb: null` removes the team's own quota (back to the default). */
  | { kind: "quota"; mb: number | null }
  | { kind: "addMember"; userId: string; role: TeamRole }
  | { kind: "setRole"; userId: string; role: TeamRole }
  | { kind: "removeMember"; userId: string }
  | { kind: "delete" };

/** The largest per-team quota an admin can set, in MB. Same cap as an account's. */
export const MAX_TEAM_QUOTA_MB = MAX_QUOTA_MB;

const USER_ID = /^user_[A-Za-z0-9]+$/;
export const TEAM_ID = /^org_[A-Za-z0-9]+$/;

/** A team name: 2–60 characters of letters, digits and light punctuation (it is printed in tool output). */
const TEAM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()\-–]{1,59}$/u;

/** The name as it will be stored (whitespace collapsed), or null when it is not a plain name. */
export function cleanTeamName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return TEAM_NAME.test(name) ? name : null;
}

export function validTeamQuota(value: unknown): value is number {
  return validQuotaMb(value);
}

function isRole(value: unknown): value is TeamRole {
  return TEAM_ROLES.includes(value as TeamRole);
}

/**
 * A change rebuilt from its checked fields only — nothing extra the client
 * sent goes further — or null when it is not valid.
 */
export function cleanTeamChange(change: unknown): TeamChange | null {
  if (!change || typeof change !== "object") return null;
  const c = change as Record<string, unknown>;
  switch (c.kind) {
    case "create":
    case "rename": {
      const name = cleanTeamName(c.name);
      return name ? { kind: c.kind, name } : null;
    }
    case "active":
      return typeof c.on === "boolean" ? { kind: "active", on: c.on } : null;
    case "quota":
      return c.mb === null || validTeamQuota(c.mb) ? { kind: "quota", mb: c.mb as number | null } : null;
    case "addMember":
    case "setRole":
      return typeof c.userId === "string" && USER_ID.test(c.userId) && isRole(c.role) ? { kind: c.kind, userId: c.userId, role: c.role } : null;
    case "removeMember":
      return typeof c.userId === "string" && USER_ID.test(c.userId) ? { kind: "removeMember", userId: c.userId } : null;
    case "delete":
      return { kind: "delete" };
    default:
      return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The subset of Clerk's Organization an AdminTeam is built from. */
export interface ClerkOrgLike {
  id: string;
  name?: string | null;
  slug?: string | null;
  createdAt?: number | null;
  publicMetadata?: unknown;
  imageUrl?: string | null;
  /** Clerk always has an imageUrl (a generated one); only hasImage says an admin uploaded a logo. */
  hasImage?: boolean | null;
}

/** The subset of Clerk's OrganizationMembership the team needs. */
export interface ClerkOrgMembershipLike {
  role: string;
  createdAt?: number | null;
  publicUserData?: { userId?: string | null } | null;
}

/** An AdminTeam from Clerk's organization and its memberships. Pure. Members with an unknown role count as members. */
export function toAdminTeam(org: ClerkOrgLike, memberships: readonly ClerkOrgMembershipLike[], library: TeamLibraryStats | null): AdminTeam {
  const meta = record(org.publicMetadata);
  const members: TeamMember[] = [];
  const seen = new Set<string>();
  for (const m of memberships) {
    const userId = m.publicUserData?.userId;
    if (typeof userId !== "string" || !USER_ID.test(userId) || seen.has(userId)) continue;
    seen.add(userId);
    members.push({ userId, role: m.role === "org:admin" ? "org:admin" : "org:member", joinedAt: m.createdAt ?? null });
  }
  return {
    id: org.id,
    name: (typeof org.name === "string" && org.name.trim()) || org.slug || "Tým",
    slug: org.slug || null,
    createdAt: org.createdAt ?? null,
    active: meta.pro === true,
    quotaMb: ownQuotaMb(meta.filesQuota),
    members,
    library,
    logoUrl: org.hasImage === true && typeof org.imageUrl === "string" && org.imageUrl.startsWith("https://") ? org.imageUrl : null,
  };
}

/** Image types a team logo may be (what Clerk accepts for an organization image). */
export const LOGO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** Largest team logo, kept under the 1 MB body of a Server Function. */
export const MAX_LOGO_BYTES = 512 * 1024;

/** Why a picked file cannot be a team logo (Czech, for the admin), or null when it can. Pure. */
export function logoProblem(type: string, size: number): string | null {
  if (!LOGO_TYPES.includes(type)) return "Logo musí být obrázek PNG, JPG, WebP nebo GIF.";
  if (size <= 0) return "Soubor je prázdný.";
  if (size > MAX_LOGO_BYTES) return `Logo má ${Math.ceil(size / 1024)} kB, nejvýš jde 512 kB. Zmenši ho prosím.`;
  return null;
}

/** The organization publicMetadata to send for an "active" or "quota" change (Clerk merges it deeply and drops a key set to null). */
export function teamMetadataPatch(change: Extract<TeamChange, { kind: "active" | "quota" }>): Record<string, unknown> {
  return change.kind === "active" ? { pro: change.on } : { filesQuota: change.mb === null ? null : { mb: change.mb, pages: null } };
}

/** "3 členové", "1 člen", "5 členů". */
export function membersLabel(n: number): string {
  return `${n} ${n === 1 ? "člen" : n >= 2 && n <= 4 ? "členové" : "členů"}`;
}
