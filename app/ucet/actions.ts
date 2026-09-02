"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { clerkConfigured } from "@/src/mcp/config";
import { credentialsConfigured, deleteReaderCredential, isLibraryId, saveReaderCredential } from "@/src/mcp/credentials";

/**
 * The two things /ucet can do, as server actions: store a reader's library
 * login, and remove it. Both act only for the signed-in Clerk user — the
 * user id comes from the session, never from the form — and only when the
 * deployment can seal secrets at all.
 */

export interface ActionState {
  ok: boolean;
  message: string;
}

async function requireUser(): Promise<string> {
  if (!clerkConfigured()) throw new Error("Přihlášení není na tomto nasazení nastavené.");
  if (!credentialsConfigured()) throw new Error("Ukládání přihlašovacích údajů není na tomto nasazení zapnuté (CREDENTIALS_SECRET).");
  const { userId } = await auth();
  if (!userId) throw new Error("Nejste přihlášeni.");
  return userId;
}

export async function saveLibraryLogin(_previous: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const userId = await requireUser();
    const library = formData.get("library");
    if (!isLibraryId(library)) throw new Error("Neznámá knihovna.");
    const username = String(formData.get("username") ?? "");
    const password = String(formData.get("password") ?? "");
    await saveReaderCredential(userId, library, { username, password });
    revalidatePath("/ucet");
    return { ok: true, message: "Uloženo. Přihlášení se použije při dalším čtení licencované literatury." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Uložení se nepovedlo." };
  }
}

export async function deleteLibraryLogin(_previous: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const userId = await requireUser();
    const library = formData.get("library");
    if (!isLibraryId(library)) throw new Error("Neznámá knihovna.");
    await deleteReaderCredential(userId, library);
    revalidatePath("/ucet");
    return { ok: true, message: "Smazáno." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Smazání se nepovedlo." };
  }
}
