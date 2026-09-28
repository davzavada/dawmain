import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { USER_ID_RE } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { getLibraries, markLibraryForPurge } from "@/src/files/db/libraries";
import { audit, forgetTermsAcceptance } from "@/src/files/db/usage";
import { filesJson, logFilesError } from "@/src/files/errors";
import { envOnlyMode } from "@/src/files/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Soft delete: the library is purged by the daily cron after this grace period. */
const PURGE_GRACE_DAYS = 7;
const ORG_ID_RE = /^org_[A-Za-z0-9]+$/;

/**
 * POST /api/webhooks/clerk — Clerk (Svix-signed) account lifecycle events.
 *
 *   user.deleted / organization.deleted → the personal / team library is
 *     marked for purge in PURGE_GRACE_DAYS (the cron deletes the content);
 *     a deleted user's terms acceptances go at once;
 *   organizationMembership.deleted → nothing to store (access is computed
 *     from Clerk on every request); logged without payload.
 *
 * Idempotent (a repeated mark never postpones the date) and fast; answers
 * 2xx for events it does not need, 400 for a bad signature, 5xx only when
 * the database write failed — so Svix retries exactly those. Payloads carry
 * e-mail addresses and names: they are never logged.
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

  switch (event.type) {
    case "user.deleted":
      return scheduleLibraryPurge(event.data.id, "user");
    case "organization.deleted":
      return scheduleLibraryPurge(event.data.id, "org");
    case "organizationMembership.deleted":
      console.info("files: Clerk organization membership removed");
      return filesJson({ ok: true });
    default:
      return filesJson({ ok: true, ignored: true });
  }
}

async function scheduleLibraryPurge(id: unknown, kind: "user" | "org"): Promise<Response> {
  const valid = typeof id === "string" && (kind === "user" ? USER_ID_RE : ORG_ID_RE).test(id);
  // Nothing to purge without an id or without the feature's database.
  if (!valid || envOnlyMode() === "unconfigured") return filesJson({ ok: true, ignored: true });
  const libraryId = id as string;
  try {
    await withScope([libraryId], async (db) => {
      if (kind === "user") {
        await forgetTermsAcceptance(db, libraryId);
      }
      // Most accounts never stored anything: no library row, nothing to mark.
      if ((await getLibraries(db, [libraryId])).length === 0) return;
      await markLibraryForPurge(db, libraryId, new Date(Date.now() + PURGE_GRACE_DAYS * 86_400_000));
      await audit(db, {
        libraryId,
        actor: "clerk-webhook",
        action: `${kind === "user" ? "user" : "organization"}.deleted`,
        detail: { purgeInDays: PURGE_GRACE_DAYS },
      });
    });
  } catch (error) {
    logFilesError("webhook.purge", error);
    return filesJson({ error: "temporarily unavailable" }, 503);
  }
  return filesJson({ ok: true });
}
