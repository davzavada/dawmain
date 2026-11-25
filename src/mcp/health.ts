import { withScope } from "@/src/files/db/client";
import { mirrorApiStatus, mirrorConfigured } from "@/src/sources/mirror";

/**
 * The check behind GET /api/status/health (app/api/status/health/route.ts) → 200 `{ ok: true, … }` when the service can do its
 * work, 503 with the failing checks otherwise. For an uptime monitor.
 *
 * /api/status (the home page's panel) is prerendered and reports the courts'
 * own sites: it stays 200 while this server's database is down or the nightly
 * mirror sync has been failing for days — which is how a failed sync went
 * unnoticed (pre-release audit, 11/2026). This one asks what only this
 * deployment can answer:
 *
 *   database  the files database answers a query (accounts' libraries, limits)
 *   mirror    the case-law mirror API answers
 *   sync      every court's last sync run ended without an error, and not
 *             longer ago than SYNC_MAX_AGE_HOURS
 *
 * Public and under /api/status, outside proxy.ts's matcher: a monitor carries
 * no credentials. It says which check failed and how old a sync is — never an
 * error text, a count or anything of a user's. One real check a minute at
 * most: the answer is kept for CACHE_MS, so polling it costs nothing.
 */
/** A nightly sync that has not finished for this long has missed at least one night. */
export const SYNC_MAX_AGE_HOURS = 36;
const CACHE_MS = 60_000;
const DB_TIMEOUT_MS = 3_000;

export interface Health {
  ok: boolean;
  checkedAt: string;
  database: "ok" | "down";
  /** "off" = this deployment has no mirror configured (not a failure). */
  mirror: "ok" | "down" | "off";
  /** Per court: hours since its last sync run finished, and whether that run failed. */
  sync: Record<string, { ageHours: number | null; failed: boolean; stale: boolean }>;
  failing: string[];
}

let cached: { at: number; health: Health } | null = null;

/** Tests: forget the kept answer. */
export function resetHealthCache(): void {
  cached = null;
}

export async function checkHealth(now = Date.now()): Promise<Health> {
  const failing: string[] = [];
  let database: Health["database"] = "ok";
  try {
    await withScope([], (db) => db.query("SELECT 1"), { statementTimeoutMs: DB_TIMEOUT_MS });
  } catch {
    database = "down";
    failing.push("database");
  }
  let mirror: Health["mirror"] = "off";
  const sync: Health["sync"] = {};
  if (mirrorConfigured()) {
    try {
      const status = await mirrorApiStatus();
      mirror = status ? "ok" : "down";
      for (const source of status?.sources ?? []) {
        const run = source.lastRun;
        const finished = run?.finishedAt ? Date.parse(run.finishedAt) : NaN;
        const ageHours = Number.isFinite(finished) ? Math.round(((now - finished) / 3_600_000) * 10) / 10 : null;
        const failed = Boolean(run?.error);
        const stale = ageHours === null || ageHours > SYNC_MAX_AGE_HOURS;
        sync[source.source] = { ageHours, failed, stale };
        if (failed || stale) failing.push(`sync:${source.source}`);
      }
    } catch {
      mirror = "down";
    }
    if (mirror === "down") failing.push("mirror");
  }
  return { ok: failing.length === 0, checkedAt: new Date(now).toISOString(), database, mirror, sync, failing };
}

/** The answer for the route: kept for a minute, so a monitor polling it costs one check a minute. */
export async function currentHealth(): Promise<Health> {
  if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), health: await checkHealth() };
  return cached.health;
}
