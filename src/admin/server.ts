import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminEnvIds, USER_ID_RE } from "@/src/files/config";
import { clerkStatus } from "@/src/files/errors";
import { metadataPatch, roleFrom, toAdminUser, type AdminChange, type AdminUser } from "./model";

/**
 * Server side of the admin page: who is an admin, the account list, one change.
 *
 * An admin is an account in ADMIN_USER_IDS / FILES_OPERATOR_IDS (Vercel: the
 * first admin and the way back), or one whose `publicMetadata.role` is
 * "admin" and that is not banned. Every page load and every action asks
 * again; a Server Function is a public endpoint.
 */

/** Accounts listed on the page (Clerk answers up to 500 per request). */
const MAX_USERS = 2000;

export function isEnvAdmin(userId: string | null | undefined): boolean {
  return typeof userId === "string" && USER_ID_RE.test(userId) && adminEnvIds().includes(userId);
}

export async function currentUserId(): Promise<string | null> {
  try {
    return (await auth()).userId;
  } catch {
    return null;
  }
}

/** The signed-in admin's user id, or null for everyone else (and for a Clerk failure). */
export async function requireAdmin(): Promise<string | null> {
  const userId = await currentUserId();
  if (!userId || !USER_ID_RE.test(userId)) return null;
  if (isEnvAdmin(userId)) return userId;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return roleFrom(user.publicMetadata) === "admin" && !user.banned && !user.locked ? userId : null;
  } catch {
    return null;
  }
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const client = await clerkClient();
  const users: AdminUser[] = [];
  for (let offset = 0; offset < MAX_USERS; offset += 500) {
    const { data, totalCount } = await client.users.getUserList({ limit: 500, offset, orderBy: "-created_at" });
    for (const u of data) users.push(toAdminUser(u, isEnvAdmin(u.id)));
    if (offset + data.length >= totalCount || data.length === 0) break;
  }
  return users;
}

export type ChangeResult = { ok: true; user: AdminUser } | { ok: false; error: string };

/** Apply one change to one account as `actor` (already verified as admin). */
export async function applyChange(actor: string, targetId: string, change: AdminChange): Promise<ChangeResult> {
  if (!USER_ID_RE.test(targetId)) return { ok: false, error: "Neplatný účet." };
  if (change.kind === "role" && !change.admin && targetId === actor) {
    return { ok: false, error: "Vlastní roli správce si tady odebrat nejde. Udělá to jiný správce." };
  }
  if (change.kind === "role" && !change.admin && isEnvAdmin(targetId)) {
    return { ok: false, error: "Tento účet je správce z nastavení nasazení (Vercel), roli tady odebrat nejde." };
  }
  try {
    const client = await clerkClient();
    const target = await client.users.getUser(targetId);
    const updated = await client.users.updateUserMetadata(targetId, { publicMetadata: metadataPatch(target.publicMetadata, change) });
    // Who changed what, never anything from the account's data.
    console.info("admin change", JSON.stringify({ actor, target: targetId, change }));
    return { ok: true, user: toAdminUser(updated, isEnvAdmin(targetId)) };
  } catch (error) {
    if (clerkStatus(error) === 404) return { ok: false, error: "Účet už neexistuje." };
    console.warn("admin change failed", clerkStatus(error));
    return { ok: false, error: "Změnu se nepodařilo uložit, Clerk neodpověděl. Zkus to za chvíli." };
  }
}
