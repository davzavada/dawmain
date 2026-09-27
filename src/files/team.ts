import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { TtlCache } from "@/src/sources/shared/cache";
import { sanitizeLine } from "./dmd/normalize";
import { clerkStatus, FilesUserError } from "./errors";

/**
 * Team management for the admins of a Pro team, and the invitee's side of
 * an invitation — thin wrappers over the Clerk Backend API (Clerk keeps the
 * memberships; nothing is mirrored into the database).
 *
 *   teamOverview      members + pending invitations (+ invitations the
 *                     invitee declined, which Clerk only knows as "revoked")
 *   inviteMember      role org:member, inviterUserId, the inviter's name in
 *                     publicMetadata (the invitee's menu shows "Jana
 *                     Nováková vás zve…"), redirect back to the site
 *   revoke / resend   revoke; resend = revoke + a fresh invitation
 *   removeMember      never the last admin, never oneself
 *   declineInvitation the Clerk frontend API can accept an invitation but
 *                     not decline it: the server checks the invitation is
 *                     addressed to one of the caller's VERIFIED e-mail
 *                     addresses and revokes it
 *   memberNames       userId → display name, for "nahrál(a) …" in a team list
 *
 * Authorization (is the caller an admin of this Pro team?) is the route's
 * job, from getAccess; these functions trust their orgId. Names and e-mail
 * addresses are personal data: returned to the team's own admin only,
 * never logged. Clerk errors become FilesUserError with Czech messages.
 */

// ---------------------------------------------------------------------------
// The subset of Clerk's backend client this module uses (tests pass a fake)

export interface ClerkMembershipLike {
  role: string;
  createdAt: number;
  publicUserData?: { userId: string; identifier: string; firstName: string | null; lastName: string | null } | null;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface ClerkInvitationLike {
  id: string;
  emailAddress: string;
  organizationId: string;
  status?: InvitationStatus;
  createdAt: number;
  publicMetadata?: Record<string, unknown> | null;
  publicOrganizationData?: { name?: string | null } | null;
}

export interface TeamClerk {
  organizations: {
    getOrganization(p: { organizationId: string; includeMembersCount?: boolean }): Promise<{ id: string; name: string; membersCount?: number }>;
    getOrganizationMembershipList(p: { organizationId: string; limit?: number }): Promise<{ data: ClerkMembershipLike[] }>;
    getOrganizationInvitationList(p: { organizationId: string; status?: InvitationStatus[]; limit?: number }): Promise<{ data: ClerkInvitationLike[] }>;
    createOrganizationInvitation(p: {
      organizationId: string;
      emailAddress: string;
      role: string;
      inviterUserId?: string;
      publicMetadata?: Record<string, unknown>;
      redirectUrl?: string;
    }): Promise<ClerkInvitationLike>;
    revokeOrganizationInvitation(p: { organizationId: string; invitationId: string; requestingUserId?: string }): Promise<unknown>;
    deleteOrganizationMembership(p: { organizationId: string; userId: string }): Promise<unknown>;
  };
  users: {
    getUser(userId: string): Promise<{
      firstName: string | null;
      lastName: string | null;
      emailAddresses: Array<{ emailAddress: string; verification: { status: string } | null }>;
    }>;
    getOrganizationInvitationList(p: { userId: string; status?: InvitationStatus; limit?: number }): Promise<{ data: ClerkInvitationLike[] }>;
  };
}

let testClient: TeamClerk | null = null;

/** Tests replace the Clerk client (and start from empty caches). */
export function __setTeamClientForTests(client: TeamClerk | null): void {
  testClient = client;
  namesCache = newCache();
  countCache = newCache();
}

async function client(): Promise<TeamClerk> {
  return testClient ?? ((await clerkClient()) as unknown as TeamClerk);
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Clerk caps page sizes at 100; a team bigger than that is an operator matter. */
const PAGE = 100;
const MAX_NAME = 80;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** "Jana Nováková", else the identifier (e-mail), one sanitized line. Pure. */
export function displayName(first: string | null | undefined, last: string | null | undefined, fallback = ""): string {
  const name = [first, last].filter((s): s is string => typeof s === "string" && s.trim() !== "").join(" ");
  return sanitizeLine(name || fallback, MAX_NAME);
}

/** Trimmed, lower-cased e-mail address, or null when it is not one. Pure. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  admin: boolean;
  /** Membership start, epoch ms. */
  since: number;
}

export interface TeamInvitation {
  id: string;
  email: string;
  state: "pending" | "declined";
  /** Sent, epoch ms. */
  sentAt: number;
}

export interface TeamOverview {
  orgId: string;
  name: string;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

/** Clerk memberships → members, admins first, then by name. Pure. */
export function mapMembers(list: ClerkMembershipLike[]): TeamMember[] {
  const out: TeamMember[] = [];
  for (const m of list) {
    const u = m.publicUserData;
    if (!u || typeof u.userId !== "string") continue;
    out.push({
      userId: u.userId,
      name: displayName(u.firstName, u.lastName, u.identifier),
      email: sanitizeLine(u.identifier ?? "", 254),
      admin: m.role === "org:admin",
      since: typeof m.createdAt === "number" ? m.createdAt : 0,
    });
  }
  return out.sort((a, b) => Number(b.admin) - Number(a.admin) || a.name.localeCompare(b.name, "cs"));
}

/**
 * Invitations to show an admin: pending ones, and revoked ones the invitee
 * declined (marks from the audit log) that the admin has not dismissed.
 * Revocations by the admin disappear from the list. Newest first. Pure.
 */
export function mapInvitations(list: ClerkInvitationLike[], marks: { declined: Set<string>; dismissed: Set<string> }): TeamInvitation[] {
  const out: TeamInvitation[] = [];
  for (const inv of list) {
    const email = sanitizeLine(inv.emailAddress ?? "", 254);
    if (inv.status === "pending") out.push({ id: inv.id, email, state: "pending", sentAt: inv.createdAt });
    else if (inv.status === "revoked" && marks.declined.has(inv.id) && !marks.dismissed.has(inv.id)) {
      out.push({ id: inv.id, email, state: "declined", sentAt: inv.createdAt });
    }
  }
  return out.sort((a, b) => b.sentAt - a.sentAt);
}

// ---------------------------------------------------------------------------
// Caches (per instance): uploader names and member counts change rarely

const TTL_MS = 60_000;
const newCache = <T>() => new TtlCache<T>(TTL_MS, 500);
let namesCache = newCache<Map<string, string>>();
let countCache = newCache<number>();

function forget(orgId: string): void {
  namesCache.delete(orgId);
  countCache.delete(orgId);
}

/** Map a Clerk failure to a user-facing refusal (404 → "not found"); anything else rethrows. */
function refusal(error: unknown, notFound: string): never {
  const status = clerkStatus(error);
  if (status === 404) throw new FilesUserError(404, notFound);
  if (status !== null && status >= 400 && status < 500) {
    throw new FilesUserError(422, "Clerk požadavek odmítl. Zkontrolujte zadání a zkuste to znovu.");
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Admin side

/** Members and invitations of a team (the caller verified admin rights). */
export async function teamOverview(orgId: string, marks: { declined: Set<string>; dismissed: Set<string> }): Promise<TeamOverview> {
  const c = await client();
  try {
    const [org, members, invitations] = await Promise.all([
      c.organizations.getOrganization({ organizationId: orgId }),
      c.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: PAGE }),
      c.organizations.getOrganizationInvitationList({ organizationId: orgId, status: ["pending", "revoked"], limit: PAGE }),
    ]);
    const mapped = mapMembers(members.data);
    namesCache.set(orgId, new Map(mapped.map((m) => [m.userId, m.name])));
    countCache.set(orgId, mapped.length);
    return {
      orgId,
      name: sanitizeLine(org.name ?? "", 120) || "Tým",
      members: mapped,
      invitations: mapInvitations(invitations.data, marks),
    };
  } catch (error) {
    return refusal(error, "Tým nenalezen.");
  }
}

/** Display names of the team's members (for the uploader column), cached 60 s. Empty on Clerk failure. */
export async function memberNames(orgId: string): Promise<Map<string, string>> {
  const hit = namesCache.get(orgId);
  if (hit) return hit;
  try {
    const list = await (await client()).organizations.getOrganizationMembershipList({ organizationId: orgId, limit: PAGE });
    const names = new Map(mapMembers(list.data).map((m) => [m.userId, m.name]));
    namesCache.set(orgId, names);
    return names;
  } catch {
    return new Map();
  }
}

/** Member count of a team, cached 60 s; null when Clerk does not answer. */
export async function memberCount(orgId: string): Promise<number | null> {
  const hit = countCache.get(orgId);
  if (hit !== undefined) return hit;
  try {
    const org = await (await client()).organizations.getOrganization({ organizationId: orgId, includeMembersCount: true });
    if (typeof org.membersCount !== "number") return null;
    countCache.set(orgId, org.membersCount);
    return org.membersCount;
  } catch {
    return null;
  }
}

/**
 * Invite `email` as org:member. Refused when the address already belongs
 * to a member or already has a pending invitation.
 */
export async function inviteMember(args: { orgId: string; email: string; inviterUserId: string; redirectUrl: string }): Promise<TeamInvitation> {
  const email = normalizeEmail(args.email);
  if (!email) throw new FilesUserError(400, "Zadejte platnou e-mailovou adresu.");
  const c = await client();
  try {
    const [members, pending, inviter] = await Promise.all([
      c.organizations.getOrganizationMembershipList({ organizationId: args.orgId, limit: PAGE }),
      c.organizations.getOrganizationInvitationList({ organizationId: args.orgId, status: ["pending"], limit: PAGE }),
      c.users.getUser(args.inviterUserId),
    ]);
    if (members.data.some((m) => m.publicUserData?.identifier?.toLowerCase() === email)) {
      throw new FilesUserError(409, "Tato adresa už v týmu je.");
    }
    if (pending.data.some((i) => i.emailAddress.toLowerCase() === email)) {
      throw new FilesUserError(409, "Pozvánka pro tuto adresu už čeká na přijetí.");
    }
    const inviterName = displayName(inviter.firstName, inviter.lastName);
    const created = await c.organizations.createOrganizationInvitation({
      organizationId: args.orgId,
      emailAddress: email,
      role: "org:member",
      inviterUserId: args.inviterUserId,
      publicMetadata: inviterName ? { inviterName } : {},
      redirectUrl: args.redirectUrl,
    });
    return { id: created.id, email, state: "pending", sentAt: created.createdAt };
  } catch (error) {
    if (error instanceof FilesUserError) throw error;
    return refusal(error, "Tým nenalezen.");
  }
}

/** Revoke a pending invitation of the team. */
export async function revokeInvitation(orgId: string, invitationId: string, requestingUserId: string): Promise<void> {
  try {
    await (await client()).organizations.revokeOrganizationInvitation({ organizationId: orgId, invitationId, requestingUserId });
  } catch (error) {
    refusal(error, "Pozvánka nenalezena.");
  }
}

/** The team's invitation with this id (pending or revoked), or null. */
export async function findInvitation(orgId: string, invitationId: string): Promise<ClerkInvitationLike | null> {
  try {
    const list = await (await client()).organizations.getOrganizationInvitationList({
      organizationId: orgId,
      status: ["pending", "revoked"],
      limit: PAGE,
    });
    return list.data.find((i) => i.id === invitationId) ?? null;
  } catch (error) {
    return refusal(error, "Tým nenalezen.");
  }
}

/** "Pozvat znovu": revoke the old invitation when still pending, then invite the same address again. */
export async function resendInvitation(args: { orgId: string; invitationId: string; inviterUserId: string; redirectUrl: string }): Promise<TeamInvitation> {
  const old = await findInvitation(args.orgId, args.invitationId);
  if (!old) throw new FilesUserError(404, "Pozvánka nenalezena.");
  if (old.status === "pending") await revokeInvitation(args.orgId, old.id, args.inviterUserId);
  return inviteMember({ orgId: args.orgId, email: old.emailAddress, inviterUserId: args.inviterUserId, redirectUrl: args.redirectUrl });
}

/** Remove a member. Never oneself (that is "leave the team", in the account settings) and never the last admin. */
export async function removeMember(orgId: string, userId: string, requestingUserId: string): Promise<void> {
  if (userId === requestingUserId) throw new FilesUserError(400, "Sami sebe z týmu odebrat nemůžete.");
  const c = await client();
  try {
    const list = mapMembers((await c.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: PAGE })).data);
    const target = list.find((m) => m.userId === userId);
    if (!target) throw new FilesUserError(404, "Člen nenalezen.");
    if (target.admin && list.filter((m) => m.admin).length <= 1) {
      throw new FilesUserError(409, "Posledního správce týmu odebrat nelze.");
    }
    await c.organizations.deleteOrganizationMembership({ organizationId: orgId, userId });
    forget(orgId);
  } catch (error) {
    if (error instanceof FilesUserError) throw error;
    refusal(error, "Člen nenalezen.");
  }
}

// ---------------------------------------------------------------------------
// Invitee side

/**
 * Decline an invitation addressed to the caller: it must be among the
 * user's pending invitations AND its address one of the user's verified
 * addresses. Revokes it and returns the team id (for the "declined" mark).
 * Anything else is one "not found".
 */
export async function declineInvitation(userId: string, invitationId: string): Promise<{ orgId: string }> {
  const c = await client();
  try {
    const [user, invitations] = await Promise.all([
      c.users.getUser(userId),
      c.users.getOrganizationInvitationList({ userId, status: "pending", limit: PAGE }),
    ]);
    const verified = new Set(
      user.emailAddresses.filter((e) => e.verification?.status === "verified").map((e) => e.emailAddress.toLowerCase()),
    );
    const invitation = invitations.data.find((i) => i.id === invitationId);
    if (!invitation || !verified.has(invitation.emailAddress.toLowerCase())) {
      throw new FilesUserError(404, "Pozvánka nenalezena.");
    }
    await c.organizations.revokeOrganizationInvitation({ organizationId: invitation.organizationId, invitationId });
    return { orgId: invitation.organizationId };
  } catch (error) {
    if (error instanceof FilesUserError) throw error;
    return refusal(error, "Pozvánka nenalezena.");
  }
}
