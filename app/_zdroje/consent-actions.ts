"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import type { MentionConsent } from "@/src/admin/model";

/**
 * Server Function of the account menu's "Smím říct, že Dawmain používáte":
 * the signed-in account's own consent (privacy policy, row 8), on or off,
 * stored in its Clerk publicMetadata with the time of the change. Only the
 * account itself can change it — the caller comes from the session, never
 * from the client. Every change is logged (who, on/off, when), so a consent
 * can be shown later; the log carries no other data.
 */
export async function setMentionConsentAction(on: unknown): Promise<{ ok: true; consent: MentionConsent } | { ok: false; error: string }> {
  if (typeof on !== "boolean") return { ok: false, error: "Neplatná změna." };
  let userId: string | null = null;
  try {
    userId = (await auth()).userId;
  } catch {
    userId = null;
  }
  if (!userId) return { ok: false, error: "Nejste přihlášeni." };
  const consent: MentionConsent = { on, at: new Date().toISOString() };
  try {
    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, { publicMetadata: { mentionConsent: consent } });
  } catch {
    return { ok: false, error: "Uložení se nepovedlo. Zkuste to za chvíli." };
  }
  console.info("mention consent", JSON.stringify({ user: userId, on, at: consent.at }));
  return { ok: true, consent };
}
