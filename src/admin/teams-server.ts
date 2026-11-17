import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { ORG_ID_RE, USER_ID_RE } from "@/src/files/config";
import { clerkStatus } from "@/src/files/errors";
import { metadataPatch } from "./model";
import { clerkRole, isLastAdmin, toAdminTeam, type AdminTeam, type TeamChange, type TeamRole } from "./teams";

/**
 * Server side of the Týmy page: the teams (Clerk organizations) with their
 * members, and one change at a time. Every caller has already been
 * verified as an admin (requireAdmin); ids are validated here, never
 * trusted from the client. Clerk's messages are not passed on.
 */

/** Teams listed on the page; each costs one more Clerk call for its members. */
const MAX_TEAMS = 100;
const MAX_MEMBERS = 100;

export type TeamsLoad = { state: "ok"; teams: AdminTeam[] } | { state: "disabled" } | { state: "failed" };
export type TeamResult = { ok: true; team: AdminTeam | null } | { ok: false; error: string };

const FAILED = "Změnu se nepodařilo uložit, Clerk neodpověděl. Zkus to za chvíli.";

type Client = Awaited<ReturnType<typeof clerkClient>>;

async function loadTeam(client: Client, organizationId: string): Promise<AdminTeam> {
  const [org, members] = await Promise.all([
    client.organizations.getOrganization({ organizationId }),
    client.organizations.getOrganizationMembershipList({ organizationId, limit: MAX_MEMBERS }),
  ]);
  return toAdminTeam(org, members.data);
}

/** Every team with its members; "disabled" where the Clerk instance has no organizations switched on. */
export async function listAdminTeams(): Promise<TeamsLoad> {
  try {
    const client = await clerkClient();
    const { data } = await client.organizations.getOrganizationList({ limit: MAX_TEAMS, orderBy: "+name" });
    const teams = await Promise.all(
      data.map(async (org) => {
        const members = await client.organizations.getOrganizationMembershipList({ organizationId: org.id, limit: MAX_MEMBERS });
        return toAdminTeam(org, members.data);
      }),
    );
    return { state: "ok", teams };
  } catch (error) {
    const status = clerkStatus(error);
    if (status === 403 || status === 404) return { state: "disabled" };
    console.warn("admin teams failed", status);
    return { state: "failed" };
  }
}

function failure(error: unknown, what: string): TeamResult {
  const status = clerkStatus(error);
  console.warn(`admin team ${what} failed`, status);
  if (status === 404) return { ok: false, error: "Tým nebo účet už neexistuje." };
  if (status === 403) return { ok: false, error: "Clerk změnu odmítl. Jsou v Clerku zapnuté Organizace a není tým plný?" };
  if (status === 400 || status === 422) return { ok: false, error: "Clerk změnu odmítl. Není už účet členem týmu?" };
  return { ok: false, error: FAILED };
}

/** The most members a team may have: Clerk's ceiling without its paid add-on. */
const MAX_TEAM_MEMBERS = 20;

/**
 * A new team with its first admin — created in THEIR name (`createdBy`),
 * so the admin of the website does not become a member and never sees the
 * team's documents. Off until switched on.
 */
export async function createTeam(actor: string, name: string, adminId: string): Promise<TeamResult> {
  if (!USER_ID_RE.test(adminId)) return { ok: false, error: "Vyber správce týmu." };
  try {
    const client = await clerkClient();
    const org = await client.organizations.createOrganization({ name, createdBy: adminId, maxAllowedMemberships: MAX_TEAM_MEMBERS });
    console.info("admin team", JSON.stringify({ actor, team: org.id, action: "create" }));
    return { ok: true, team: await loadTeam(client, org.id) };
  } catch (error) {
    return failure(error, "create");
  }
}

export async function changeTeam(actor: string, teamId: string, change: TeamChange): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: teamId });
    await client.organizations.updateOrganizationMetadata(teamId, { publicMetadata: metadataPatch(org.publicMetadata, change) });
    console.info("admin team", JSON.stringify({ actor, team: teamId, change }));
    return { ok: true, team: await loadTeam(client, teamId) };
  } catch (error) {
    return failure(error, "change");
  }
}

export async function renameTeam(actor: string, teamId: string, name: string): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  try {
    const client = await clerkClient();
    await client.organizations.updateOrganization(teamId, { name });
    console.info("admin team", JSON.stringify({ actor, team: teamId, action: "rename" }));
    return { ok: true, team: await loadTeam(client, teamId) };
  } catch (error) {
    return failure(error, "rename");
  }
}

/** Add a member, change a member's role, or (role null) remove them. The last admin stays. */
export async function setTeamMember(actor: string, teamId: string, userId: string, role: TeamRole | null): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId) || !USER_ID_RE.test(userId)) return { ok: false, error: "Neplatný tým nebo účet." };
  try {
    const client = await clerkClient();
    const team = await loadTeam(client, teamId);
    const current = team.members.find((m) => m.userId === userId);
    if (current && role !== "admin" && isLastAdmin(team, userId)) {
      return { ok: false, error: "Tým musí mít aspoň jednoho správce. Nejdřív jmenuj jiného." };
    }
    const params = { organizationId: teamId, userId };
    if (role === null) {
      if (current) await client.organizations.deleteOrganizationMembership(params);
    } else if (current) {
      if (current.role !== role) await client.organizations.updateOrganizationMembership({ ...params, role: clerkRole(role) });
    } else {
      await client.organizations.createOrganizationMembership({ ...params, role: clerkRole(role) });
    }
    console.info("admin team", JSON.stringify({ actor, team: teamId, member: userId, role }));
    return { ok: true, team: await loadTeam(client, teamId) };
  } catch (error) {
    return failure(error, "member");
  }
}

/**
 * Delete the team. Clerk's `organization.deleted` webhook marks its library
 * for purge (app/api/webhooks/clerk); the daily cron also notices a team
 * that is gone.
 */
export async function deleteTeam(actor: string, teamId: string): Promise<TeamResult> {
  if (!ORG_ID_RE.test(teamId)) return { ok: false, error: "Neplatný tým." };
  try {
    const client = await clerkClient();
    await client.organizations.deleteOrganization(teamId);
    console.info("admin team", JSON.stringify({ actor, team: teamId, action: "delete" }));
    return { ok: true, team: null };
  } catch (error) {
    return failure(error, "delete");
  }
}
