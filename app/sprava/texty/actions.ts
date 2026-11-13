"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/admin/server";
import { saveSiteText, type SaveResult } from "@/src/content/store";

/**
 * Server Function of the text editor: one field stored, or put back to its
 * default (`value` null). A Server Function is a public endpoint, so it
 * asks Clerk who is calling and checks the admin itself; the field and the
 * text are validated in saveSiteText, never trusted from the client.
 *
 * The public pages are static: a save revalidates the three that show
 * editable texts, so the next visit renders them with the new wording.
 */

/** The pages that render editable texts (src/content/texts.ts). */
const PAGES = ["/", "/podminky", "/soukromi"];

export async function saveTextAction(key: string, value: string | null): Promise<SaveResult> {
  const actor = await requireAdmin();
  if (!actor) return { ok: false, error: "Nemáš oprávnění správce." };
  if (typeof key !== "string" || (value !== null && typeof value !== "string")) return { ok: false, error: "Neplatná změna." };
  const result = await saveSiteText(key, value);
  if (result.ok) {
    // Who changed which field, never the text itself.
    console.info("admin text", JSON.stringify({ actor, key, chars: value === null ? null : value.length }));
    for (const page of PAGES) revalidatePath(page);
    revalidatePath("/sprava/texty");
  }
  return result;
}
