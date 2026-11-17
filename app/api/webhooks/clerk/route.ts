import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { USER_ID_RE } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { getLibraries, markLibraryForPurge } from "@/src/files/db/libraries";
import { forgetMemberships } from "@/src/files/db/teams";
import { audit, forgetTermsAcceptance, forgetUserUsage } from "@/src/files/db/usage";
import { filesJson, logFilesError } from "@/src/files/errors";
import { envOnlyMode } from "@/src/files/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Soft delete: the library is purged by the daily cron after this grace period. */
const PURGE_GRACE_DAYS = 6;

/**
 * POST /api/webhooks/clerk — Clerk (Svix-signed) account lifecycle events.
 *
 *   user.deleted → what we keep about the account goes with it: at once
 *     the terms acceptances, the read and call counters and the team
 *     memberships; the personal library (documents, folders, index) is
 *     marked for purge in PURGE_GRACE_DAYS and deleted by the daily cron.
 *     Files the user uploaded into a TEAM's library stay — they are the
 *     team's. (Zotero credentials live in Clerk's private metadata and are
 *     deleted by Clerk with the account.)
 *
 * Teams are not Clerk organizations (src/files/db/teams.ts), so no other
 * event matters. Idempotent (a repeated mark never postpones the date) and
 * fast; answers 2xx for events it does not need, 400 for a bad signature,
 * 5xx only when the database write failed — so Svix retries exactly those.
 * Payloads carry e-mail addresses and names: they are never logged.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim()) {
    console.error("files: Clerk webhook received but CLERK_WEBHOOK_SIGNING_SECRET is not set");
    return filesJson({ error: "not configured" }, 503);
  }
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request);
  } catch {
    console.warn("files: Clerk webhook signature rejected");
    return filesJson({ error: "invalid signature" }, 400);
  }

  if (event.type !== "user.deleted") return filesJson({ ok: true, ignored: true });
  return forgetUser(event.data.id);
}

async function forgetUser(id: unknown): Promise<Response> {
  // Nothing to forget without an id or without the feature's database.
  if (typeof id !== "string" || !USER_ID_RE.test(id) || envOnlyMode() === "unconfigured") return filesJson({ ok: true, ignored: true });
  const userId = id;
  try {
    await withScope([userId], async (db) => {
      await forgetTermsAcceptance(db, userId);
      await forgetUserUsage(db, userId);
      await forgetMemberships(db, userId);
      // Most accounts never stored anything: no library row, nothing to mark.
      if ((await getLibraries(db, [userId])).length === 0) return;
      await markLibraryForPurge(db, userId, new Date(Date.now() + PURGE_GRACE_DAYS * 86_400_000));
      await audit(db, { libraryId: userId, actor: "clerk-webhook", action: "user.deleted", detail: { purgeInDays: PURGE_GRACE_DAYS } });
    });
  } catch (error) {
    logFilesError("webhook.purge", error);
    return filesJson({ error: "temporarily unavailable" }, 503);
  }
  return filesJson({ ok: true });
}
