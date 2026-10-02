import { getAccess, type Access, type Feature } from "@/src/files/access";
import { callerFromCtx } from "@/src/mcp/caller";

/**
 * The entitlement every personal Pro tool shares (files_*, zotero_*): a
 * personal OAuth sign-in — never the shared access code — whose account
 * may use the feature: for "files" its library with Vlastní soubory on
 * (access.libraries), for "zotero" access.zotero — both Pro, minus the
 * switches in Clerk's publicMetadata.features
 * (src/files/access.ts).
 *
 * Deliberately only the identity and the account: each tool family keeps
 * its own deployment switches and limits in its own gate. The files gate
 * adds envOnlyMode / effectiveMode (the free-tier database guards) and its
 * rate limit; Zotero must not inherit those — envOnlyMode would switch it
 * off wherever the files database is not configured, and effectiveMode
 * wakes that database on every call.
 *
 * The reasons are granular enough for each gate to word its own refusal
 * (the files gate's texts are pinned by tests/files-tools.test.ts):
 *
 *   shared-token  the shared access code — a deployment secret, no user;
 *   anonymous     no (valid) signed-in user in the request context;
 *   banned        Clerk marks the account banned or locked;
 *   no-pro        a real account without the feature (no Pro, or switched off).
 *
 * Clerk failures are NOT a reason: getAccess throws and so does this, so
 * each caller maps them to its own fixed "could not be verified" text
 * instead of mistaking an outage for "not Pro". Nothing is looked up for a
 * caller that is not a signed-in user.
 */

export type ProCallerRefusal = "shared-token" | "anonymous" | "banned" | "no-pro";

export type ProCaller =
  | { ok: true; userId: string; clientId: string; access: Access }
  | { ok: false; reason: ProCallerRefusal };

export async function personalProCaller(ctx: unknown, feature: Feature): Promise<ProCaller> {
  const caller = callerFromCtx(ctx);
  if (caller.kind === "shared-token") return { ok: false, reason: "shared-token" };
  if (caller.kind !== "user") return { ok: false, reason: "anonymous" };
  const access = await getAccess(caller.userId);
  const refusal = proRefusal(access, feature);
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, userId: caller.userId, clientId: caller.clientId, access };
}

/**
 * The account half of personalProCaller as a pure rule on an Access, for a
 * caller that already knows the user from a web session (the Zotero routes,
 * src/zotero/web.ts): null when the account may use the personal Pro tools,
 * else why not. personalProCaller applies the same rule in the same order,
 * so "Pro" on the website and in the MCP gate cannot drift apart
 * (tests/zotero-routes.test.ts compares the two).
 */
export function proRefusal(access: Access, feature: Feature): Extract<ProCallerRefusal, "banned" | "no-pro"> | null {
  // A banned account keeps no library at all (buildAccess), but the flag is
  // checked first so a gate can tell the two apart if it ever needs to.
  if (access.banned) return "banned";
  const allowed = feature === "zotero" ? access.zotero : access.libraries.length > 0;
  return allowed ? null : "no-pro";
}
