import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { invalidateAccess } from "@/src/files/access";
import { withScope } from "@/src/files/db/client";
import { allLibraryBytes, listAllLibraries } from "@/src/files/db/libraries";
import { clerkStatus } from "@/src/files/errors";
import { effectiveMode } from "@/src/files/guards";
import { logoProblem, TEAM_ID, teamMetadataPatch, toAdminTeam, type AdminTeam, type TeamChange, type TeamLibraryStats } from "./teams-model";

/**
 * Server side of the Týmy tab: the team list with members and library use,
 * and one change to one team. Teams are Clerk organizations; the caller
 * (app/sprava/tymy/actions.ts) has already checked that the actor is an
 * admin. Every change is logged with who did what — never document content.
 */

/** Teams listed on the page; an installation with more is an operator anomaly. */
const MAX_TEAMS = 500;
/** Members read per team (Clerk's page cap). */
const MAX_MEMBERS = 100;

/** The library counters of every team, by org id — null when the files database is off or unreachable. */
async function teamLibraryStats(): Promise<Map<string, TeamLibraryStats> | null> {
  try {
    const mode = await effectiveMode();
    if (mode === "off" || mode === "unconfigured") return null;
    const { rows, bytes } = await withScope([], async (db) => ({ rows: await listAllLibraries(db), bytes: await allLibraryBytes(db) }));
    return new Map(
      rows
        .filter((r) => r.kind === "org")
        .map((r) => [r.id, { documents: r.doc_count, pages: r.page_count, bytes: bytes.get(r.id) ?? 0, purgeAfter: r.purge_after }]),
    );
  } catch {
    return null;
  }
}

async function loadTeam(client: Awaited<ReturnType<typeof clerkClient>>, orgId: string, stats: Map<string, TeamLibraryStats> | null): Promise<AdminTeam> {
  const [org, memberships] = await Promise.all([
    client.organizations.getOrganization({ organizationId: orgId }),
    client.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: MAX_MEMBERS }),
  ]);
  return toAdminTeam(org, memberships.data, stats ? (stats.get(orgId) ?? { documents: 0, pages: 0, bytes: 0, purgeAfter: null }) : null);
}

/** Every team with its members and library use, by name. */
export async function listAdminTeams(): Promise<{ teams: AdminTeam[]; statsAvailable: boolean }> {
  const client = await clerkClient();
  const stats = await teamLibraryStats();
  const orgs: Array<{ id: string }> = [];
  for (let offset = 0; offset < MAX_TEAMS; offset += 100) {
    const { data, totalCount } = await client.organizations.getOrganizationList({ limit: 100, offset });
    orgs.push(...data);
    if (offset + data.length >= totalCount || data.length === 0) break;
  }
  const teams = await Promise.all(
    orgs.map(async (org) => {
      const memberships = await client.organizations.getOrganizationMembershipList({ organizationId: org.id, limit: MAX_MEMBERS });
      return toAdminTeam(org, memberships.data, stats ? (stats.get(org.id) ?? { documents: 0, pages: 0, bytes: 0, purgeAfter: null }) : null);
    }),
  );
  teams.sort((a, b) => a.name.localeCompare(b.name, "cs") || a.id.localeCompare(b.id));
  return { teams, statsAvailable: stats !== null };
}

export type TeamResult =
  | { ok: true; team: AdminTeam }
  /** The team was deleted. */
  | { ok: true; team: null; deletedId: string }
  | { ok: false; error: string };

/**
 * Apply one change as `actor` (already verified as admin). `teamId` is
 * ignored for "create". A membership change forgets the member's cached
 * access on this instance so the team appears (or disappears) at once.
 */
export async function applyTeamChange(actor: string, teamId: string | null, change: TeamChange): Promise<TeamResult> {
  if (change.kind !== "create" && (typeof teamId !== "string" || !TEAM_ID.test(teamId))) return { ok: false, error: "Neplatný tým." };
  try {
    const client = await clerkClient();
    let id = teamId as string;
    switch (change.kind) {
      case "create": {
        const org = await client.organizations.createOrganization({ name: change.name, publicMetadata: { pro: true } });
        id = org.id;
        break;
      }
      case "rename":
        await client.organizations.updateOrganization(id, { name: change.name });
        break;
      case "active":
      case "quota":
        await client.organizations.updateOrganizationMetadata(id, { publicMetadata: teamMetadataPatch(change) });
        break;
      case "addMember":
        try {
          await client.organizations.createOrganizationMembership({ organizationId: id, userId: change.userId, role: change.role });
        } catch (error) {
          // Already a member: set the role instead of failing.
          if (clerkStatus(error) !== 422 && clerkStatus(error) !== 400) throw error;
          await client.organizations.updateOrganizationMembership({ organizationId: id, userId: change.userId, role: change.role });
        }
        invalidateAccess(change.userId);
        break;
      case "setRole":
        await client.organizations.updateOrganizationMembership({ organizationId: id, userId: change.userId, role: change.role });
        invalidateAccess(change.userId);
        break;
      case "removeMember":
        await client.organizations.deleteOrganizationMembership({ organizationId: id, userId: change.userId });
        invalidateAccess(change.userId);
        break;
      case "delete": {
        const members = await client.organizations.getOrganizationMembershipList({ organizationId: id, limit: MAX_MEMBERS });
        await client.organizations.deleteOrganization(id);
        for (const m of members.data) if (m.publicUserData?.userId) invalidateAccess(m.publicUserData.userId);
        // The organization.deleted webhook (or the daily cron, which finds it gone) schedules the library purge.
        console.info("admin team change", JSON.stringify({ actor, team: id, change }));
        return { ok: true, team: null, deletedId: id };
      }
    }
    console.info("admin team change", JSON.stringify({ actor, team: id, change }));
    const stats = await teamLibraryStats();
    return { ok: true, team: await loadTeam(client, id, stats) };
  } catch (error) {
    const status = clerkStatus(error);
    if (status === 404) return { ok: false, error: change.kind === "addMember" ? "Účet nebo tým už neexistuje." : "Tým už neexistuje." };
    if (status === 403) {
      return { ok: false, error: "Clerk týmy odmítl. Zkontroluj, že jsou v Clerku zapnuté Organizations a že tým nepřekročil limit členů." };
    }
    console.warn("admin team change failed", status);
    return { ok: false, error: "Změnu se nepodařilo uložit, Clerk neodpověděl. Zkus to za chvíli." };
  }
}

/**
 * Upload (a file) or remove (null) the team's logo, as `actor` (already
 * verified as admin). The logo is the Clerk organization's image: members
 * see it next to the team in the sidebar and on the team's files page.
 */
export async function setTeamLogo(actor: string, teamId: string, file: File | null): Promise<TeamResult> {
  if (!TEAM_ID.test(teamId)) return { ok: false, error: "Neplatný tým." };
  if (file) {
    const problem = logoProblem(file.type, file.size);
    if (problem) return { ok: false, error: problem };
  }
  try {
    const client = await clerkClient();
    if (file) await client.organizations.updateOrganizationLogo(teamId, { file, uploaderUserId: actor });
    else await client.organizations.deleteOrganizationLogo(teamId);
    const stats = await teamLibraryStats();
    const team = await loadTeam(client, teamId, stats);
    // Members see the logo in their sidebar: forget their cached access on this instance.
    for (const m of team.members) invalidateAccess(m.userId);
    console.info("admin team change", JSON.stringify({ actor, team: teamId, change: { kind: file ? "logo" : "logo.remove" } }));
    return { ok: true, team };
  } catch (error) {
    const status = clerkStatus(error);
    if (status === 404) return { ok: false, error: "Tým už neexistuje." };
    if (status === 400 || status === 422) return { ok: false, error: "Clerk obrázek nepřijal. Zkuste jiný soubor (PNG nebo JPG)." };
    console.warn("admin team logo failed", status);
    return { ok: false, error: "Logo se nepodařilo uložit, Clerk neodpověděl. Zkus to za chvíli." };
  }
}
