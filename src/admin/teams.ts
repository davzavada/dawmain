/**
 * Teams on the admin page (app/sprava/tymy): what a team looks like to an
 * admin. A team is a row of the files database (`teams`, with its members
 * in `team_members`; src/files/db/teams.ts) — not a Clerk organization, so
 * it has as many members as it needs. Its shared library of Vlastní
 * soubory has the team's id (`org_…`). Pure, no server-only imports, so
 * client components can use the types.
 *
 * What an admin switches has the very shape of an account's switches
 * (src/admin/model.ts), where the access code reads it (src/files/access.ts):
 *
 *   pro       the team is on: its members share a library and get the
 *             team's features, with no Pro of their own;
 *   features  { files, zotero } switch one off with `false`, { ukaz }
 *             switches UKAŽ on with `true`;
 *   quota     the shared library's own page quota.
 *
 * Roles: "admin" (manages every file of the team) and "member" (uploads;
 * renames, moves and deletes what they uploaded).
 */

import type { AdminFeature } from "./model";

export type TeamRole = "admin" | "member";

export interface AdminTeamMember {
  userId: string;
  role: TeamRole;
}

export interface AdminTeam {
  id: string;
  name: string;
  pro: boolean;
  features: Record<AdminFeature, boolean>;
  /** The team library's own quota, or null when the default applies. */
  quotaPages: number | null;
  /** Admins first. */
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

/** The subset of a `teams` row and its `team_members` rows a team is built from. */
export interface TeamRowLike {
  id: string;
  name: string;
  pro: boolean;
  features: Record<string, unknown>;
  quota_pages: number | null;
}

export function toAdminTeam(team: TeamRowLike, members: ReadonlyArray<{ user_id: string; role: TeamRole }>): AdminTeam {
  const f = team.features ?? {};
  return {
    id: team.id,
    name: team.name,
    pro: team.pro,
    features: { files: f.files !== false, zotero: f.zotero !== false, ukaz: f.ukaz === true },
    quotaPages: team.quota_pages,
    members: members
      .map((m) => ({ userId: m.user_id, role: m.role }))
      .sort((a, b) => (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1)),
  };
}

/** The `teams` columns one change sets, given the team's current features. Pure. */
export function teamPatch(features: Record<string, unknown>, change: TeamChange): { pro?: boolean; features?: Record<string, unknown>; quotaPages?: number | null } {
  switch (change.kind) {
    case "pro":
      return { pro: change.on };
    case "feature":
      return { features: { ...features, [change.feature]: change.on } };
    case "quota":
      return { quotaPages: change.pages };
  }
}

/** Is this the team's only admin? (Removing or demoting them would leave nobody to manage its files.) */
export function isLastAdmin(team: AdminTeam, userId: string): boolean {
  const admins = team.members.filter((m) => m.role === "admin");
  return admins.length === 1 && admins[0].userId === userId;
}
