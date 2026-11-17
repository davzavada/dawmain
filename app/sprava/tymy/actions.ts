"use server";

import { revalidatePath } from "next/cache";
import { ADMIN_FEATURES, validQuotaPages, type AdminFeature } from "@/src/admin/model";
import { requireAdmin } from "@/src/admin/server";
import { cleanTeamName, type TeamChange, type TeamRole } from "@/src/admin/teams";
import { changeTeam, createTeam, deleteTeam, renameTeam, setTeamMember, type TeamResult } from "@/src/admin/teams-server";

/**
 * Server Functions of the Týmy page. Each re-authenticates and re-checks
 * the admin itself (a Server Function is a public endpoint) and validates
 * what the client sent before anything reaches Clerk.
 */

const NO_ADMIN: TeamResult = { ok: false, error: "Nemáš oprávnění správce." };
const INVALID: TeamResult = { ok: false, error: "Neplatná změna." };

async function run(work: (actor: string) => Promise<TeamResult>): Promise<TeamResult> {
  const actor = await requireAdmin();
  if (!actor) return NO_ADMIN;
  const result = await work(actor);
  if (result.ok) revalidatePath("/sprava/tymy");
  return result;
}

function cleanChange(change: unknown): TeamChange | null {
  if (!change || typeof change !== "object") return null;
  const c = change as Record<string, unknown>;
  if (c.kind === "pro" && typeof c.on === "boolean") return { kind: "pro", on: c.on };
  if (c.kind === "feature" && typeof c.on === "boolean" && ADMIN_FEATURES.includes(c.feature as never)) {
    return { kind: "feature", feature: c.feature as AdminFeature, on: c.on };
  }
  if (c.kind === "quota" && (c.pages === null || validQuotaPages(c.pages))) return { kind: "quota", pages: c.pages };
  return null;
}

export async function createTeamAction(name: string, adminId: string): Promise<TeamResult> {
  const clean = cleanTeamName(name);
  if (!clean || typeof adminId !== "string") return { ok: false, error: "Zadej název týmu (2–60 znaků) a vyber jeho správce." };
  return run((actor) => createTeam(actor, clean, adminId));
}

export async function changeTeamAction(teamId: string, change: TeamChange): Promise<TeamResult> {
  const clean = cleanChange(change);
  if (typeof teamId !== "string" || !clean) return INVALID;
  return run((actor) => changeTeam(actor, teamId, clean));
}

export async function renameTeamAction(teamId: string, name: string): Promise<TeamResult> {
  const clean = cleanTeamName(name);
  if (typeof teamId !== "string" || !clean) return { ok: false, error: "Název týmu má mít 2–60 znaků." };
  return run((actor) => renameTeam(actor, teamId, clean));
}

/** `role: null` removes the member. */
export async function setTeamMemberAction(teamId: string, userId: string, role: TeamRole | null): Promise<TeamResult> {
  if (typeof teamId !== "string" || typeof userId !== "string" || !(role === null || role === "admin" || role === "member")) return INVALID;
  return run((actor) => setTeamMember(actor, teamId, userId, role));
}

export async function deleteTeamAction(teamId: string): Promise<TeamResult> {
  if (typeof teamId !== "string") return INVALID;
  return run((actor) => deleteTeam(actor, teamId));
}
