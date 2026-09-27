import "server-only";
import { z } from "zod";
import { getAccess, type Access, type LibraryAccess } from "./access";
import { envOnlyMode } from "./guards";
import { LIBRARY_ID_RE, USER_ID_RE } from "./config";
import { withScope } from "./db/client";
import { invitationMarks } from "./db/documents-web";
import { audit } from "./db/usage";
import { FilesUserError, logFilesError, MESSAGES } from "./errors";
import { declineInvitation, findInvitation, inviteMember, removeMember, resendInvitation, revokeInvitation, teamOverview } from "./team";
import type { TeamView } from "./web-types";

/**
 * The web API of team management (app/api/files/team/**): the admin of a
 * Pro team lists members and invitations, invites, revokes, re-sends and
 * removes; an invitee declines. Clerk does the work (src/files/team.ts);
 * this layer decides who may. A team the caller does not belong to is
 * "not found"; a member who is not an admin is "forbidden".
 *
 * The audit log of the team library records invitations and removals (ids
 * only — never an e-mail address), and remembers which revoked
 * invitations were declined by the invitee (Clerk only says "revoked").
 * Those writes are best-effort: team management works even while the
 * Vlastní zdroje database is unavailable.
 */

const INVITATION_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

/** The team library the caller administers — 404 for foreign or unknown, 403 for a plain member or a team without Pro. */
export function adminLibrary(access: Access, orgId: string): LibraryAccess {
  const lib = LIBRARY_ID_RE.test(orgId) && orgId.startsWith("org_") ? access.all.find((l) => l.id === orgId) : undefined;
  if (!lib || access.banned) throw new FilesUserError(404, "Tým nenalezen.");
  if (lib.role !== "org:admin" || !lib.pro) throw new FilesUserError(403, "Tým může spravovat jen jeho správce.");
  return lib;
}

function checkInvitationId(id: string): string {
  if (!INVITATION_ID_RE.test(id)) throw new FilesUserError(404, "Pozvánka nenalezena.");
  return id;
}

/** Append to the team's audit log unless the database is off; never fails the caller. */
async function auditQuietly(entry: { libraryId: string; actor: string; action: string; detail?: unknown }): Promise<void> {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return;
  try {
    await withScope([], (db) => audit(db, entry));
  } catch (error) {
    logFilesError("team.audit", error);
  }
}

async function marksOf(orgId: string): Promise<{ declined: Set<string>; dismissed: Set<string> }> {
  const empty = { declined: new Set<string>(), dismissed: new Set<string>() };
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return empty;
  try {
    return await withScope([], (db) => invitationMarks(db, orgId));
  } catch (error) {
    logFilesError("team.marks", error);
    return empty;
  }
}

/** GET /api/files/team?org= */
export async function teamFor(userId: string, orgId: string): Promise<TeamView> {
  const lib = adminLibrary(await getAccess(userId), orgId);
  const team = await teamOverview(lib.id, await marksOf(lib.id));
  return {
    orgId: team.orgId,
    name: team.name,
    members: team.members.map((m) => ({ ...m, self: m.userId === userId })),
    invitations: team.invitations,
  };
}

const inviteSchema = z.strictObject({ org: z.string().max(80), email: z.string().max(320) });

/** POST /api/files/team/invitations { org, email } */
export async function inviteFor(userId: string, body: unknown, siteOrigin: string): Promise<void> {
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  const lib = adminLibrary(await getAccess(userId, { fresh: true }), parsed.data.org);
  const created = await inviteMember({
    orgId: lib.id,
    email: parsed.data.email,
    inviterUserId: userId,
    redirectUrl: new URL("/?zdroje=tym", siteOrigin).toString(),
  });
  await auditQuietly({ libraryId: lib.id, actor: userId, action: "invitation.create", detail: { invitation: created.id } });
}

/**
 * DELETE /api/files/team/invitations/[id]?org= — a pending invitation is
 * revoked; a declined one is only removed from the list.
 */
export async function revokeFor(userId: string, orgId: string, invitationId: string): Promise<void> {
  const lib = adminLibrary(await getAccess(userId, { fresh: true }), orgId);
  const id = checkInvitationId(invitationId);
  const invitation = await findInvitation(lib.id, id);
  if (!invitation) throw new FilesUserError(404, "Pozvánka nenalezena.");
  if (invitation.status === "pending") {
    await revokeInvitation(lib.id, id, userId);
    await auditQuietly({ libraryId: lib.id, actor: userId, action: "invitation.revoke", detail: { invitation: id } });
  } else {
    await auditQuietly({ libraryId: lib.id, actor: userId, action: "invitation.dismissed", detail: { invitation: id } });
  }
}

/** POST /api/files/team/invitations/[id]/resend { org } */
export async function resendFor(userId: string, body: unknown, invitationId: string, siteOrigin: string): Promise<void> {
  const parsed = z.strictObject({ org: z.string().max(80) }).safeParse(body);
  if (!parsed.success) throw new FilesUserError(400, MESSAGES.badRequest);
  const lib = adminLibrary(await getAccess(userId, { fresh: true }), parsed.data.org);
  const id = checkInvitationId(invitationId);
  const created = await resendInvitation({
    orgId: lib.id,
    invitationId: id,
    inviterUserId: userId,
    redirectUrl: new URL("/?zdroje=tym", siteOrigin).toString(),
  });
  // The old entry (pending → revoked, or declined) leaves the list.
  await auditQuietly({ libraryId: lib.id, actor: userId, action: "invitation.dismissed", detail: { invitation: id } });
  await auditQuietly({ libraryId: lib.id, actor: userId, action: "invitation.create", detail: { invitation: created.id } });
}

/** POST /api/files/team/invitations/[id]/decline — the invitee refuses. */
export async function declineFor(userId: string, invitationId: string): Promise<void> {
  const { orgId } = await declineInvitation(userId, checkInvitationId(invitationId));
  await auditQuietly({ libraryId: orgId, actor: userId, action: "invitation.declined", detail: { invitation: invitationId } });
}

/** DELETE /api/files/team/members/[userId]?org= */
export async function removeFor(userId: string, orgId: string, memberId: string): Promise<void> {
  const lib = adminLibrary(await getAccess(userId, { fresh: true }), orgId);
  if (!USER_ID_RE.test(memberId)) throw new FilesUserError(404, "Člen nenalezen.");
  await removeMember(lib.id, memberId, userId);
  await auditQuietly({ libraryId: lib.id, actor: userId, action: "member.remove", detail: { member: memberId } });
}
