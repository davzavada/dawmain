"use server";

import { revalidatePath } from "next/cache";
import { applyChange, requireAdmin, type ChangeResult } from "@/src/admin/server";
import { ADMIN_FEATURES, type AdminChange } from "@/src/admin/model";

/**
 * Server Function of the admin page: one change to one account. It
 * re-authenticates with Clerk and re-checks the admin itself — a Server
 * Function is a public endpoint, reachable without ever rendering the page.
 * The change is validated here, never trusted from the client.
 */

function validChange(change: unknown): change is AdminChange {
  if (!change || typeof change !== "object") return false;
  const c = change as Record<string, unknown>;
  if (c.kind === "role") return typeof c.admin === "boolean";
  if (c.kind === "pro") return typeof c.on === "boolean";
  if (c.kind === "feature") return typeof c.on === "boolean" && ADMIN_FEATURES.includes(c.feature as never);
  return false;
}

export async function changeUserAction(targetId: string, change: AdminChange): Promise<ChangeResult> {
  const actor = await requireAdmin();
  if (!actor) return { ok: false, error: "Nemáš oprávnění správce." };
  if (typeof targetId !== "string" || !validChange(change)) return { ok: false, error: "Neplatná změna." };
  // Rebuild the change from its checked fields: nothing extra the client sent goes further.
  const clean: AdminChange =
    change.kind === "role" ? { kind: "role", admin: change.admin } : change.kind === "pro" ? { kind: "pro", on: change.on } : { kind: "feature", feature: change.feature, on: change.on };
  const result = await applyChange(actor, targetId, clean);
  if (result.ok) revalidatePath("/sprava");
  return result;
}
