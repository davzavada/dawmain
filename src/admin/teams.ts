/**
 * Teams on the admin page (app/sprava/tymy): what a team looks like to an
 * admin. A team is a Clerk organization; its shared library of Vlastní
 * soubory has the organization's id (`org_…`). Pure, no server-only
 * imports, so client components can use the types.
 *
 * What an admin switches lives in the ORGANIZATION's `publicMetadata`, in
 * the very shape of an account's (src/admin/model.ts), where the access
 * code reads it (src/files/access.ts):
 *
 *   pro       true = the team is on: its members share a library and get
 *             the team's features, with no Pro of their own;
 *   features  { files, zotero } switch one off with `false`, { ukaz }
 *             switches UKAŽ on with `true`;
 *   filesQuota.pages  the shared library's own page quota.
 *
 * Roles are Clerk's: `org:admin` (manages every file of the team) and
 * `org:member` (uploads; renames and deletes what they uploaded).
 */

import type { AdminFeature } from "./model";

export type TeamRole = "admin" | "member";

export interface AdminTeamMember {
  userId: string;
  name: string;
  /** The member's identifier in Clerk (their e-mail). */
  email: string;
  role: TeamRole;
}

export interface AdminTeam {
  id: string;
  name: string;
  createdAt: number | null;
  pro: boolean;
  features: Record<AdminFeature, boolean>;
  /** The team library's own quota, or null when the default applies. */
  quotaPages: number | null;
  members: AdminTeamMember[];
}

/** What changes on a team: the switches of an account minus the admin role. */
export type TeamChange =
  | { kind: "pro"; on: boolean }
  | { kind: "feature"; feature: AdminFeature; on: boolean }
  | { kind: "quota"; pages: number | null };

/** A team's name: 2–60 characters, one line. */
export const TEAM_NAME_MAX = 60;

export function cleanTeamName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= TEAM_NAME_MAX ? name : null;
}

export function clerkRole(role: TeamRole): "org:admin" | "org:member" {
  return role === "admin" ? "org:admin" : "org:member";
}

export function teamRole(role: unknown): TeamRole {
  return role === "org:admin" ? "admin" : "member";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The subset of Clerk's Organization and OrganizationMembership a team is built from. */
export interface ClerkOrgLike {
  id: string;
  name?: string | null;
  createdAt?: number | null;
  publicMetadata?: unknown;
}
export interface ClerkOrgMemberLike {
  role?: string | null;
  publicUserData?: { userId?: string; identifier?: string; firstName?: string | null; lastName?: string | null } | null;
}

export function toAdminTeam(org: ClerkOrgLike, memberships: readonly ClerkOrgMemberLike[]): AdminTeam {
  const meta = record(org.publicMetadata);
  const features = record(meta.features);
  const pages = record(meta.filesQuota).pages;
  const members: AdminTeamMember[] = [];
  for (const m of memberships) {
    const u = m.publicUserData;
    if (!u || typeof u.userId !== "string") continue;
    const email = u.identifier ?? "";
    members.push({ userId: u.userId, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || email || u.userId, email, role: teamRole(m.role) });
  }
  // Admins first, then by name.
  members.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, "cs") : a.role === "admin" ? -1 : 1));
  return {
    id: org.id,
    name: (org.name ?? "").trim() || org.id,
    createdAt: org.createdAt ?? null,
    pro: meta.pro === true,
    features: { files: features.files !== false, zotero: features.zotero !== false, ukaz: features.ukaz === true },
    quotaPages: typeof pages === "number" && Number.isFinite(pages) && pages >= 1 ? Math.floor(pages) : null,
    members,
  };
}

/** Is this the team's only admin? (Removing or demoting them would leave nobody to manage its files.) */
export function isLastAdmin(team: AdminTeam, userId: string): boolean {
  const admins = team.members.filter((m) => m.role === "admin");
  return admins.length === 1 && admins[0].userId === userId;
}
