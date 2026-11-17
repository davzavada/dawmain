import "server-only";
import { envMode, ORG_ID_RE, USER_ID_RE } from "@/src/files/config";
import { withScope, type Queryable } from "@/src/files/db/client";
import { markLibraryForPurge } from "@/src/files/db/libraries";
import { createTeam as insertTeam, deleteTeam as removeTeam, getTeam, listMembers, listTeams, removeMember, setMember, updateTeam } from "@/src/files/db/teams";
import { audit } from "@/src/files/db/usage";
import { logFilesError } from "@/src/files/errors";
import { isLastAdmin, teamPatch, toAdminTeam, type AdminTeam, type TeamChange, type TeamRole } from "./teams";

/**
 * Server side of the Týmy page: the teams with their members, and one
 * change at a time — all in the files database (src/files/db/teams.ts).
 * Every caller has already been verified as an admin (requireAdmin); ids
 * are validated here, never trusted from the client.
 */

/** A deleted team's library is purged by the daily cron after this grace period. */
const PURGE_GRACE_DAYS = 6;

export type TeamsLoad = { state: "ok"; teams: AdminTeam[] } | { state: "unconfigured" } | { state: "failed" };
export type TeamResult = { ok: true; team: AdminTeam | null } | { ok: false; error: string };

const FAILED = "Změnu se nepodařilo uložit, databáze neodpověděla. Zkus to za chvíli.";
const NO_TEAM = "Tým už neexistuje.";

async function loadTeam(db: Queryable, teamId: string): Promise<AdminTeam | null> {
  const team = await getTeam(db, teamId);
  return team ? toAdminTeam(team, await listMembers(db, [teamId])) : null;
}

/** Every team with its members; "unconfigured" where the deployment has no files database. */
export async function listAdminTeams(): Promise<TeamsLoad> {
  if (envMode() === "unconfigured") return { state: "unconfigured" };
  try {
    return await withScope([], async (db) => {
      const [teams, members] = [await listTeams(db), await listMembers(db)];
      return { state: "ok" as const, teams: teams.map((t) => toAdminTeam(t, members.filter((m) => m.team_id === t.id))) };
    });
  } catch (error) {
    logFilesError("admin.teams", error);
    return { state: "failed" };
  }
}

/** Run one change in a transaction; a thrown error is logged and answered with the fixed message. */
async function change(what: string, teamId: string | null, work: (db: Queryable) => Promise<TeamResult>): Promise<TeamResult> {
  if (envMode() === "unconfigured") return { ok: false, error: "Vlastní soubory nemají na tomto nasazení databázi." };
  try {
    // The team's library is in scope only where the change touches it (deleting the team).
    return await withScope(teamId ? [teamId] : [], work);
  } catch (error) {
    logFilesError(`admin.team.${what}`, error);
    return { ok: false, error: FAILED };
  }
}

/** A new team with its first admin. Off until the admin switches it on. */
export async function createTeam(actor: string, name: string, adminId: string): Promise<TeamResult> {
  if (!USER_ID_RE.test(adminId)) return { ok: false, error: "Vyber správce týmu." };
  return change("create", null, async (db) => {
    const team = await insertTeam(db, { name, adminId, createdBy: actor });
    console.info("admin team", JSON.stringify({ actor, team: team.id, action: "create" }));
    return { ok: true, team: await loadTeam(db, team.id) };
  });
}

export async function changeTeam(actor: string, teamId: string, what: TeamChange): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  return change("change", null, async (db) => {
    const team = await getTeam(db, teamId);
    if (!team || !(await updateTeam(db, teamId, teamPatch(team.features, what)))) return { ok: false, error: NO_TEAM };
    console.info("admin team", JSON.stringify({ actor, team: teamId, change: what }));
    return { ok: true, team: await loadTeam(db, teamId) };
  });
}

export async function renameTeam(actor: string, teamId: string, name: string): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  return change("rename", null, async (db) => {
    if (!(await updateTeam(db, teamId, { name }))) return { ok: false, error: NO_TEAM };
    console.info("admin team", JSON.stringify({ actor, team: teamId, action: "rename" }));
    return { ok: true, team: await loadTeam(db, teamId) };
  });
}

/** Add a member, change a member's role, or (role null) remove them. The last admin stays. */
export async function setTeamMember(actor: string, teamId: string, userId: string, role: TeamRole | null): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId) || !USER_ID_RE.test(userId)) return { ok: false, error: "Neplatný tým nebo účet." };
  return change("member", null, async (db) => {
    const team = await loadTeam(db, teamId);
    if (!team) return { ok: false, error: NO_TEAM };
    const current = team.members.find((m) => m.userId === userId);
    if (current && role !== "admin" && isLastAdmin(team, userId)) {
      return { ok: false, error: "Tým musí mít aspoň jednoho správce. Nejdřív jmenuj jiného." };
    }
    if (role === null) await removeMember(db, teamId, userId);
    else await setMember(db, teamId, userId, role);
    console.info("admin team", JSON.stringify({ actor, team: teamId, member: userId, role }));
    return { ok: true, team: await loadTeam(db, teamId) };
  });
}

/**
 * Delete the team: its members lose the shared library at once (within the
 * minute the access is cached), and the library is marked for purge — the
 * daily cron deletes its documents after PURGE_GRACE_DAYS.
 */
export async function deleteTeam(actor: string, teamId: string): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  return change("delete", teamId, async (db) => {
    if (!(await removeTeam(db, teamId))) return { ok: false, error: NO_TEAM };
    await markLibraryForPurge(db, teamId, new Date(Date.now() + PURGE_GRACE_DAYS * 86_400_000));
    await audit(db, { libraryId: teamId, actor, action: "team.deleted", detail: { purgeInDays: PURGE_GRACE_DAYS } });
    console.info("admin team", JSON.stringify({ actor, team: teamId, action: "delete" }));
    return { ok: true, team: null };
  });
}
