import { canaries, runCanary } from "./tools/probe";
import { DATABASES, type DatabaseStatus } from "./databases";

export {
  DATABASE_GROUPS,
  DATABASES,
  formatTime,
  type DatabaseGroup,
  type DatabaseStatus,
} from "./databases";

/**
 * The green/red light next to each database on the home page.
 *
 * One canary per database, all at once, behind GET /api/status - a static
 * Route Handler that Next regenerates in the background at most once an hour
 * (app/api/status/route.ts). The CDN serves the last answer to every
 * visitor without running a function, and outside Clerk's proxy, so no
 * visitor ever waits on a canary, and no cron is needed: the first request
 * after the hour is up gets the old answer and triggers the next check.
 *
 * Nobody waits on a regeneration, so the canaries keep the probe tool's
 * full timeout: a slow source gets time to answer instead of being written
 * off as "neověřeno" for a whole hour.
 */

/**
 * One canary. Red means THE SOURCE answered wrong - an HTTP error, or a page
 * the parsers would no longer understand. When the request itself dies (DNS,
 * egress, timeout) we observed nothing about the source, so the answer is
 * ok: null and the row shows "neověřeno" instead of an outage we did not see.
 * Getting that wrong once painted every row red at the same minute a probe
 * from the MCP function saw all sources healthy.
 */
async function check(db: (typeof DATABASES)[number]): Promise<DatabaseStatus> {
  const { label, group, href, canaryId } = db;
  const row = { id: canaryId, label, group, href };
  const canary = canaries().find((item) => item.id === canaryId);
  if (!canary) return { ...row, ok: false, at: Date.now(), via: "kontrola", detail: "neznámý zdroj" };
  // runCanary never throws; error is set exactly when the fetch itself failed.
  const result = await runCanary(canary);
  if (result.error !== null) return { ...row, ok: null, at: null, via: null };
  return {
    ...row,
    ok: result.ok,
    at: Date.now(),
    via: "kontrola",
    ...(result.ok
      ? {}
      : {
          // The source answered: either with an error status, or with a 2xx
          // body missing the marker the parsers rely on (parse drift).
          detail:
            result.http_status && (result.http_status < 200 || result.http_status >= 300)
              ? `HTTP ${result.http_status}`
              : "neočekávaná odpověď",
        }),
  };
}

/** Every displayed database's status, in DATABASES order. Never throws. */
export function allDatabaseStatuses(): Promise<DatabaseStatus[]> {
  return Promise.all(DATABASES.map(check));
}
