import { libraryOwnerState } from "@/src/files/access";
import { cronSecret, envMode } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { clearStalePending, ingestCandidates, MAX_INGEST_ATTEMPTS } from "@/src/files/db/documents";
import {
  listAllLibraries,
  lockDuePurge,
  markLibraryForPurge,
  purgeLibraryContent,
  reviveLibrary,
  setProRevoked,
  type LibraryRow,
} from "@/src/files/db/libraries";
import {
  audit,
  forgetLibraryUsage,
  forgetPurgedAudit,
  forgetTermsAcceptance,
  forgetUserUsage,
  pendingReindexRequests,
  pruneUsage,
  recountLibraries,
  setSystemState,
} from "@/src/files/db/usage";
import { errorCode, filesJson } from "@/src/files/errors";
import { effectiveMode, GUARDS_STATE_KEY, measureGuards } from "@/src/files/guards";
import { ingestDocument } from "@/src/files/ingest";
import { reindexRequested } from "@/src/files/reindex";
import { tokenMatches } from "@/src/mcp/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Libraries purged per run (each deletes in batches; a big one takes a while). */
const PURGE_PER_RUN = 5;
/** Clerk lookups per run (the Backend API budget is shared with OAuth verification). */
const OWNER_CHECKS_PER_RUN = 50;
/** Pro revoked this long → the library is purged (plan: 90 days of read/delete/export). */
const REVOKED_PURGE_DAYS = 90;
/** Failed uploads keep their text this long (for an operator requeue), then it is dropped. */
const PENDING_KEEP_DAYS = 7;
/** Libraries whose failed uploads are swept per run. */
const SWEEP_PER_RUN = 200;
/** Ingests this run may start in mode "on" (plus any number of over-attempt fast fails). */
const INGESTS_PER_RUN = 3;
/** Deferred re-derivations (metadata saves over a library's daily budget) this run may catch up on. */
const REINDEXES_PER_RUN = 30;
/** Stop starting new work after this long, to finish inside maxDuration. */
const SOFT_DEADLINE_MS = 240_000;
const DAY_MS = 86_400_000;

/**
 * GET /api/cron/files — the daily maintenance run (vercel.json, 03:00 UTC).
 * `Authorization: Bearer ${CRON_SECRET}`, compared in constant time; fails
 * closed when the secret is unset. Tasks, each capped and isolated (one
 * failing does not stop the rest):
 *
 *   1. guards: measure DB size, pages and the compute-hour estimate, store
 *      the snapshot (system_state "guards") — the automatic read-only mode
 *      itself is applied live by effectiveMode();
 *   2. purge libraries whose purge date passed (Clerk deletion + 7 days,
 *      or Pro revoked for 90 days) — with their counters and their audit
 *      rows but the purge record;
 *   3. owners and Pro: ≤ 50 Clerk lookups, rotating through the libraries —
 *      a deleted owner (missed webhook) schedules a purge and, for a user,
 *      drops their terms acceptance and read counters as the webhook would;
 *      a lost Pro sets pro_revoked_at (restored Pro clears it), 90 days
 *      revoked → purge; Pro restored before that purge ran revives the
 *      library (the mark is cleared);
 *   4. ingest queue: documents over their attempts are failed (reservation
 *      released) in any mode; waiting ones are ingested when the mode is "on";
 *   5. re-derivations deferred by the libraries' daily budget (mode "on");
 *   6. drop the stored text of uploads that failed more than 7 days ago;
 *   7. recount every library's page and document counters from its
 *      documents (a takedown or a crash never leaves them drifting);
 *   8. retention (/soukromi): usage counters after 12 months (per-document
 *      read counters after 2 days), compute-activity minutes after 62 days,
 *      audit rows of purged libraries.
 *
 * Returns a JSON summary of counts (no ids, no content).
 */
export async function GET(request: Request): Promise<Response> {
  const secret = cronSecret();
  if (!secret) {
    console.error("files: cron called but CRON_SECRET is not set — refusing");
    return filesJson({ error: "not configured" }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!provided || !tokenMatches(secret, provided)) return filesJson({ error: "unauthorized" }, 401);

  if (envMode() === "unconfigured") return filesJson({ ok: true, skipped: "unconfigured" });
  return filesJson(await runMaintenance(Date.now()));
}

interface Summary {
  ok: boolean;
  mode: string | null;
  dbBytes: number | null;
  purged: number;
  purgedDocuments: number;
  ownersChecked: number;
  proRevoked: number;
  proRestored: number;
  scheduledPurges: number;
  ingestsFailed: number;
  ingestsRun: number;
  pendingCleared: number;
  reindexed: number;
  countersFixed: number;
  usagePruned: number;
  auditForgotten: number;
  errors: string[];
}

async function runMaintenance(started: number): Promise<Summary> {
  const summary: Summary = {
    ok: true,
    mode: null,
    dbBytes: null,
    purged: 0,
    purgedDocuments: 0,
    ownersChecked: 0,
    proRevoked: 0,
    proRestored: 0,
    scheduledPurges: 0,
    ingestsFailed: 0,
    ingestsRun: 0,
    pendingCleared: 0,
    reindexed: 0,
    countersFixed: 0,
    usagePruned: 0,
    auditForgotten: 0,
    errors: [],
  };
  const late = () => Date.now() - started > SOFT_DEADLINE_MS;
  const task = async (name: string, fn: () => Promise<void>) => {
    if (late()) {
      summary.errors.push(`${name}:skipped`);
      return;
    }
    try {
      await fn();
    } catch (error) {
      summary.ok = false;
      summary.errors.push(`${name}:${errorCode(error)}`);
      console.error(`files: cron ${name} failed (${errorCode(error)})`);
    }
  };

  await task("guards", async () => {
    const snapshot = await withScope([], async (db) => {
      const m = await measureGuards(db);
      const value = { ...m, at: new Date().toISOString() };
      await setSystemState(db, GUARDS_STATE_KEY, value);
      return m;
    });
    summary.dbBytes = snapshot.dbBytes;
    summary.mode = await effectiveMode();
  });

  let libraries: Array<LibraryRow & { created_at: string }> = [];
  /** Purged by this run: the owners task leaves them alone. */
  const purgedNow = new Set<string>();
  await task("libraries", async () => {
    libraries = await withScope([], (db) => listAllLibraries(db));
  });

  await task("purge", async () => {
    const due = libraries.filter((l) => l.purge_after && Date.parse(l.purge_after) <= Date.now()).slice(0, PURGE_PER_RUN);
    for (const lib of due) {
      if (late()) break;
      const deleted = await withScope(
        [lib.id],
        async (db) => {
          // Re-checked under the row lock: an upload may have revived the
          // library since it was listed (reviveLibrary), or the database's
          // clock may not have reached the date yet. Then nothing is wiped,
          // audited or counted.
          if (!(await lockDuePurge(db, lib.id))) return null;
          const n = await purgeLibraryContent(db, lib.id);
          await forgetLibraryUsage(db, lib.id);
          await audit(db, { libraryId: lib.id, actor: "cron", action: "library.purged", detail: { documents: n } });
          summary.auditForgotten += await forgetPurgedAudit(db);
          return n;
        },
        { statementTimeoutMs: 60_000 },
      );
      if (deleted === null) continue;
      purgedNow.add(lib.id);
      summary.purged += 1;
      summary.purgedDocuments += deleted;
    }
  });

  await task("owners", async () => {
    // Unmarked libraries, plus those marked because Pro stayed revoked for
    // 90 days: restored Pro before the purge runs revives them. (A library
    // marked because its owner was deleted cannot get Pro back.)
    const checked = libraries.filter((l) => !purgedNow.has(l.id) && (!l.purge_after || l.pro_revoked_at));
    for (const lib of rotate(checked, OWNER_CHECKS_PER_RUN, Math.floor(started / DAY_MS))) {
      if (late()) break;
      let state: Awaited<ReturnType<typeof libraryOwnerState>>;
      try {
        state = await libraryOwnerState(lib.id);
      } catch (error) {
        summary.errors.push(`owner:${errorCode(error)}`);
        continue;
      }
      summary.ownersChecked += 1;
      await withScope([lib.id], async (db) => {
        if (lib.purge_after) {
          // Marked for purge (revoked_expired): only restored Pro changes anything.
          if (state === "pro" && (await reviveLibrary(db, lib.id))) {
            await audit(db, { libraryId: lib.id, actor: "cron", action: "library.revived" });
            summary.proRestored += 1;
          }
          return;
        }
        if (state === "gone") {
          await markLibraryForPurge(db, lib.id, new Date(Date.now() + 7 * DAY_MS));
          if (lib.id.startsWith("user_")) {
            // The user.deleted webhook was missed: what goes with the account goes now.
            await forgetTermsAcceptance(db, lib.id);
            await forgetUserUsage(db, lib.id);
          }
          await audit(db, { libraryId: lib.id, actor: "cron", action: "library.owner_gone" });
          summary.scheduledPurges += 1;
          return;
        }
        const revokedAt = lib.pro_revoked_at ? Date.parse(lib.pro_revoked_at) : null;
        if (state === "pro") {
          if (revokedAt !== null) {
            await setProRevoked(db, lib.id, false);
            summary.proRestored += 1;
          }
          return;
        }
        if (revokedAt === null) {
          await setProRevoked(db, lib.id, true);
          await audit(db, { libraryId: lib.id, actor: "cron", action: "library.pro_revoked" });
          summary.proRevoked += 1;
        } else if (Date.now() - revokedAt >= REVOKED_PURGE_DAYS * DAY_MS) {
          await markLibraryForPurge(db, lib.id, new Date());
          await audit(db, { libraryId: lib.id, actor: "cron", action: "library.revoked_expired" });
          summary.scheduledPurges += 1;
        }
      });
    }
  });

  await task("ingest", async () => {
    const candidates = await withScope([], (db) => ingestCandidates(db, 100));
    const runnable = summary.mode === "on";
    let run = 0;
    for (const c of candidates) {
      if (late()) break;
      if (c.attempts >= MAX_INGEST_ATTEMPTS) {
        // Claiming bumps attempts past the maximum: ingest fails it at once and releases its pages.
        await ingestDocument(c.id, c.libraryId);
        summary.ingestsFailed += 1;
      } else if (runnable && run < INGESTS_PER_RUN) {
        run += 1;
        await ingestDocument(c.id, c.libraryId);
        summary.ingestsRun += 1;
      }
    }
  });

  await task("reindex", async () => {
    if (summary.mode !== "on") return;
    const candidates = await withScope([], (db) => pendingReindexRequests(db, REINDEXES_PER_RUN));
    summary.reindexed = (await reindexRequested(candidates, late)).done;
  });

  await task("pending", async () => {
    for (const lib of libraries.slice(0, SWEEP_PER_RUN)) {
      if (late()) break;
      summary.pendingCleared += await withScope([lib.id], (db) => clearStalePending(db, lib.id, PENDING_KEEP_DAYS));
    }
  });

  await task("recount", async () => {
    summary.countersFixed = await withScope([], (db) => recountLibraries(db));
  });

  await task("retention", async () => {
    await withScope(
      [],
      async (db) => {
        const pruned = await pruneUsage(db);
        summary.usagePruned = pruned.usage + pruned.activity;
        summary.auditForgotten += await forgetPurgedAudit(db);
      },
      { statementTimeoutMs: 60_000 },
    );
  });

  return summary;
}

/** Up to `n` items starting at a position that moves every day, so every library gets its turn. */
function rotate<T>(items: T[], n: number, day: number): T[] {
  if (items.length <= n) return items;
  const start = (day * n) % items.length;
  return [...items.slice(start), ...items.slice(0, start)].slice(0, n);
}
