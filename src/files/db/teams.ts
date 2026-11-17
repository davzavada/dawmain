import "server-only";
import { randomBytes } from "node:crypto";
import { ORG_ID_RE, USER_ID_RE } from "../config";
import type { Queryable } from "./client";

/**
 * Teams (migration 0007): a team and its members, kept here rather than in
 * Clerk. A team's id (`org_…`) is also the id of its shared library. The
 * tables carry no RLS — they hold no document content and are read before
 * any library scope exists — so every function here takes ids that the
 * caller has already authorised (an admin of the website, or the user's
 * own id for their memberships).
 */

export type TeamRole = "admin" | "member";

export interface TeamRow {
  id: string;
  name: string;
  pro: boolean;
  /** As `publicMetadata.features` on an account: files/zotero off with false, ukaz on with true. */
  features: Record<string, unknown>;
  quota_pages: number | null;
  created_at: string;
}

export interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: TeamRole;
}

/** One membership of a user, with the team it is in. */
export interface Membership {
  team: TeamRow;
  role: TeamRole;
}

const TEAM_COLUMNS = "t.id, t.name, t.pro, t.features, t.quota_pages, t.created_at";

function mapTeam(r: Record<string, unknown>): TeamRow {
  const features = r.features && typeof r.features === "object" && !Array.isArray(r.features) ? (r.features as Record<string, unknown>) : {};
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    pro: r.pro === true,
    features,
    quota_pages: typeof r.quota_pages === "number" ? r.quota_pages : null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
  };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A new team id: `org_` and 24 random letters and digits. */
export function newTeamId(): string {
  let id = "org_";
  for (const byte of randomBytes(24)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** The teams a user is a member of, by name. */
export async function membershipsOf(db: Queryable, userId: string): Promise<Membership[]> {
  if (!USER_ID_RE.test(userId)) return [];
  const { rows } = await db.query(
    `SELECT ${TEAM_COLUMNS}, m.role FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = $1 ORDER BY lower(t.name), t.id`,
    [userId],
  );
  return rows.map((r: Record<string, unknown>) => ({ team: mapTeam(r), role: r.role === "admin" ? "admin" : "member" }));
}

export async function getTeam(db: Queryable, teamId: string): Promise<TeamRow | null> {
  if (!ORG_ID_RE.test(teamId)) return null;
  const { rows } = await db.query(`SELECT ${TEAM_COLUMNS} FROM teams t WHERE t.id = $1`, [teamId]);
  return rows[0] ? mapTeam(rows[0]) : null;
}

export async function listTeams(db: Queryable): Promise<TeamRow[]> {
  const { rows } = await db.query(`SELECT ${TEAM_COLUMNS} FROM teams t ORDER BY lower(t.name), t.id`);
  return rows.map(mapTeam);
}

/** Members of the given teams (all of them when `teamIds` is omitted), admins first. */
export async function listMembers(db: Queryable, teamIds?: string[]): Promise<TeamMemberRow[]> {
  const { rows } = await db.query(
    `SELECT team_id, user_id, role FROM team_members
      WHERE $1::text[] IS NULL OR team_id = ANY($1::text[])
      ORDER BY team_id, role, added_at, user_id`,
    [teamIds ?? null],
  );
  return rows.map((r: Record<string, unknown>) => ({ team_id: String(r.team_id), user_id: String(r.user_id), role: r.role === "admin" ? "admin" : "member" }));
}

/** A new team with its first admin. Off until switched on. */
export async function createTeam(db: Queryable, args: { name: string; adminId: string; createdBy: string }): Promise<TeamRow> {
  const id = newTeamId();
  const { rows } = await db.query(
    `INSERT INTO teams AS t (id, name, created_by) VALUES ($1, $2, $3) RETURNING ${TEAM_COLUMNS}`,
    [id, args.name, args.createdBy],
  );
  await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')", [id, args.adminId]);
  return mapTeam(rows[0]);
}

/** Change what is given; false when the team does not exist. */
export async function updateTeam(
  db: Queryable,
  teamId: string,
  change: { name?: string; pro?: boolean; features?: Record<string, unknown>; quotaPages?: number | null },
): Promise<boolean> {
  if (!ORG_ID_RE.test(teamId)) return false;
  const { rows } = await db.query(
    `UPDATE teams SET name = coalesce($2, name), pro = coalesce($3, pro), features = coalesce($4::jsonb, features),
            quota_pages = CASE WHEN $5 THEN $6 ELSE quota_pages END
      WHERE id = $1 RETURNING id`,
    [
      teamId,
      change.name ?? null,
      change.pro ?? null,
      change.features === undefined ? null : JSON.stringify(change.features),
      change.quotaPages !== undefined,
      change.quotaPages ?? null,
    ],
  );
  return rows.length > 0;
}

/** Add a member or change their role. */
export async function setMember(db: Queryable, teamId: string, userId: string, role: TeamRole): Promise<void> {
  await db.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [teamId, userId, role],
  );
}

export async function removeMember(db: Queryable, teamId: string, userId: string): Promise<void> {
  await db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
}

/** A deleted account leaves every team (the files they uploaded there stay the team's). Returns the teams left. */
export async function forgetMemberships(db: Queryable, userId: string): Promise<string[]> {
  if (!USER_ID_RE.test(userId)) return [];
  const { rows } = await db.query("DELETE FROM team_members WHERE user_id = $1 RETURNING team_id", [userId]);
  return rows.map((r: Record<string, unknown>) => String(r.team_id));
}

/** Delete the team and its memberships (its library is purged separately). False when there was none. */
export async function deleteTeam(db: Queryable, teamId: string): Promise<boolean> {
  if (!ORG_ID_RE.test(teamId)) return false;
  const { rows } = await db.query("DELETE FROM teams WHERE id = $1 RETURNING id", [teamId]);
  return rows.length > 0;
}
