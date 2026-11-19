import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { clerkStatus } from "@/src/files/errors";
import { currentUserId, requireAdmin } from "./server";
import { applyTeamChange } from "./teams";
import { cleanTeamName, TEAM_ID, TEAM_ROLES, type TeamRole } from "./teams-model";

/**
 * "Spravovat tým" on a team's files page: the team's own manager
 * (org:admin) adds members by e-mail, changes their roles and removes
 * them; a site admin (Správa) may do the same in any team and also rename
 * it. Every call checks the caller's rights again from Clerk — never from
 * the cached access — and goes through applyTeamChange like Správa → Týmy.
 *
 * A manager cannot change their own role or remove themselves, so a team
 * never loses its last manager by accident; a site admin can.
 */

/** Members read per team (Clerk's page cap); same as Správa. */
const MAX_MEMBERS = 100;

export interface TeamPanelMember {
  userId: string;
  name: string;
  email: string;
  imageUrl: string | null;
  role: TeamRole;
}

export interface TeamPanel {
  /** Manager of this team, or a site admin. */
  canManage: boolean;
  /** Site admins only. */
  canRename: boolean;
  me: string;
  members: TeamPanelMember[];
}

export type TeamManageChange =
  | { kind: "addByEmail"; email: string; role: TeamRole }
  | { kind: "setRole"; userId: string; role: TeamRole }
  | { kind: "removeMember"; userId: string }
  | { kind: "rename"; name: string };

export type TeamManageResult = { ok: true; panel: TeamPanel } | { ok: false; error: string };

const USER_ID = /^user_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function isRole(value: unknown): value is TeamRole {
  return TEAM_ROLES.includes(value as TeamRole);
}

/** A change rebuilt from its checked fields only, or null. Pure. */
export function cleanTeamManageChange(raw: unknown): TeamManageChange | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case "addByEmail": {
      const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
      return EMAIL.test(email) && isRole(c.role) ? { kind: "addByEmail", email, role: c.role } : null;
    }
    case "setRole":
      return typeof c.userId === "string" && USER_ID.test(c.userId) && isRole(c.role) ? { kind: "setRole", userId: c.userId, role: c.role } : null;
    case "removeMember":
      return typeof c.userId === "string" && USER_ID.test(c.userId) ? { kind: "removeMember", userId: c.userId } : null;
    case "rename": {
      const name = cleanTeamName(c.name);
      return name ? { kind: "rename", name } : null;
    }
    default:
      return null;
  }
}

type Client = Awaited<ReturnType<typeof clerkClient>>;

async function loadMembers(client: Client, teamId: string): Promise<TeamPanelMember[]> {
  const list = await client.organizations.getOrganizationMembershipList({ organizationId: teamId, limit: MAX_MEMBERS });
  const members: TeamPanelMember[] = [];
  for (const m of list.data) {
    const u = m.publicUserData;
    if (!u?.userId || !isRole(m.role)) continue;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    members.push({ userId: u.userId, name: name || u.identifier || "Účet", email: u.identifier ?? "", imageUrl: u.imageUrl || null, role: m.role });
  }
  members.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, "cs") : a.role === "org:admin" ? -1 : 1));
  return members;
}

/** The caller, their rights in the team and its members; null for anyone who may not manage it. */
async function rights(teamId: string): Promise<{ client: Client; me: string; siteAdmin: boolean; members: TeamPanelMember[] } | null> {
  if (!TEAM_ID.test(teamId)) return null;
  const me = await currentUserId();
  if (!me) return null;
  const client = await clerkClient();
  const [siteAdmin, members] = await Promise.all([requireAdmin().then((id) => id === me), loadMembers(client, teamId)]);
  const manager = members.some((m) => m.userId === me && m.role === "org:admin");
  return siteAdmin || manager ? { client, me, siteAdmin, members } : null;
}

/** What the caller may do with the team, with its members when they may manage it. */
export async function teamPanel(teamId: string): Promise<TeamPanel | null> {
  try {
    const r = await rights(teamId);
    if (!r) return null;
    return { canManage: true, canRename: r.siteAdmin, me: r.me, members: r.members };
  } catch (error) {
    console.warn("team panel failed", clerkStatus(error));
    return null;
  }
}

/** Apply one change as the signed-in manager or site admin. */
export async function manageTeam(teamId: string, change: TeamManageChange): Promise<TeamManageResult> {
  let r: Awaited<ReturnType<typeof rights>>;
  try {
    r = await rights(teamId);
  } catch (error) {
    console.warn("team manage failed", clerkStatus(error));
    return { ok: false, error: "Clerk neodpověděl. Zkuste to za chvíli." };
  }
  if (!r) return { ok: false, error: "Tento tým spravovat nemůžete." };
  const { client, me, siteAdmin } = r;

  if (change.kind === "rename" && !siteAdmin) return { ok: false, error: "Tým může přejmenovat jen správce Dawmainu." };
  if ((change.kind === "setRole" || change.kind === "removeMember") && change.userId === me && !siteAdmin) {
    return { ok: false, error: "Svou vlastní roli ani členství tu změnit nemůžete. Požádejte jiného správce týmu." };
  }
  if ((change.kind === "setRole" || change.kind === "removeMember") && !r.members.some((m) => m.userId === change.userId)) {
    return { ok: false, error: "Tento účet už v týmu není." };
  }

  let result;
  if (change.kind === "addByEmail") {
    let userId: string | undefined;
    try {
      const found = await client.users.getUserList({ emailAddress: [change.email], limit: 5 });
      // Clerk matches e-mails partially: take only the exact address.
      userId = found.data.find((u) => u.emailAddresses.some((e) => e.emailAddress.toLowerCase() === change.email))?.id;
    } catch (error) {
      console.warn("team manage lookup failed", clerkStatus(error));
      return { ok: false, error: "Clerk neodpověděl. Zkuste to za chvíli." };
    }
    if (!userId) return { ok: false, error: "Účet s tímto e-mailem v Dawmainu není. Ať se nejdřív přihlásí, pak ho přidáte." };
    if (r.members.some((m) => m.userId === userId)) return { ok: false, error: "Tento účet už v týmu je." };
    result = await applyTeamChange(me, teamId, { kind: "addMember", userId, role: change.role });
  } else {
    result = await applyTeamChange(me, teamId, change);
  }
  if (!result.ok) return result;
  const panel = await teamPanel(teamId);
  // A site admin who removed themselves stays a site admin; a manager always keeps their membership.
  return panel ? { ok: true, panel } : { ok: false, error: "Změna se uložila, ale tým se nepodařilo znovu načíst." };
}
