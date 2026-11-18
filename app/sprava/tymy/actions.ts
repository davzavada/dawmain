"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/admin/server";
import { applyTeamChange, type TeamResult } from "@/src/admin/teams";
import { cleanTeamChange } from "@/src/admin/teams-model";

/**
 * Server Function of the Týmy tab: one change to one team (or a new team).
 * It re-checks the admin itself — a Server Function is a public endpoint —
 * and rebuilds the change from its validated fields only.
 */
export async function changeTeamAction(teamId: string | null, change: unknown): Promise<TeamResult> {
  const actor = await requireAdmin();
  if (!actor) return { ok: false, error: "Nemáš oprávnění správce." };
  const clean = cleanTeamChange(change);
  if (!clean) {
    const kind = (change as { kind?: unknown } | null)?.kind;
    const naming = kind === "create" || kind === "rename";
    return { ok: false, error: naming ? "Název týmu: 2 až 60 znaků, písmena, číslice a běžná interpunkce." : "Neplatná změna." };
  }
  const result = await applyTeamChange(actor, typeof teamId === "string" ? teamId : null, clean);
  if (result.ok) revalidatePath("/sprava/tymy");
  return result;
}
