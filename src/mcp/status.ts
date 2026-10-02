import { unstable_cache } from "next/cache";
import { canaries, runCanary } from "./tools/probe";
import { allSourceResults } from "@/src/sources/shared/health";
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
 * Cheap by construction, in three tiers:
 *  1. Real traffic. Every tool call already records how its source answered
 *     (src/sources/shared/health.ts), so an active server needs no probing
 *     at all - the light reports the last genuine call and when it happened.
 *  2. A cached canary. Only when no real call has been seen for
 *     FRESH_MS does the page fire the probe canary for that source. The page
 *     function rarely shares memory with the MCP function, so in practice
 *     this is what a visitor sees - which is why the result goes through
 *     Next's data cache rather than module memory: on Vercel that cache is
 *     shared across instances and visitors, so ONE canary per source per
 *     CANARY_TTL_MS serves everybody, not one per instance.
 *  3. Nothing. If a canary cannot run, the row simply says "neověřeno"
 *     rather than claiming an outage we did not observe.
 *
 * No page waits on any of this: the badges are filled in by the browser from
 * GET /api/status/[id] (app/_source-status.tsx), so a slow source can delay its
 * badge, never the page or the end of its HTML stream.
 */

/** A real observation stays authoritative for this long. */
const FRESH_MS = 15 * 60 * 1000;
/**
 * How long a canary result is reused before another one may run. The badge
 * shows the time of its check, so an older light is honest about its age;
 * a short TTL instead made visitors wait on fresh canaries (the NS search
 * alone often takes seconds) far more often than a source actually changed.
 * The cache below is shared, so this is one request per source per TTL for
 * everyone together.
 */
const CANARY_TTL_MS = 5 * 60 * 1000;
/**
 * How long a badge waits for its source. Shorter than the probe tool's 12 s
 * on purpose: a source that has not answered in 3 s is not healthy for a
 * visitor either, and its row then says "neověřeno" — not red, because a
 * request that died tells us nothing about the source (see runOneCanary).
 * The probe tool keeps the long timeout for diagnosing a slow source.
 */
const CANARY_TIMEOUT_MS = 3_000;

interface CachedCanary {
  /** null: the request itself died, nothing observed about the source. */
  ok: boolean | null;
  at: number;
  detail?: string;
}

function fresh(entry: { at: number } | undefined, ttl: number): boolean {
  return Boolean(entry && Date.now() - entry.at < ttl);
}

/**
 * One canary, with its own timeout. Red means THE SOURCE answered wrong - an
 * HTTP error, or a page the parsers would no longer understand. When the
 * request itself dies (DNS, egress, timeout) we observed nothing about the
 * source, so the answer is ok: null and the row shows "neověřeno" instead of
 * an outage we did not see. Getting that wrong once painted every row red at
 * the same minute a probe from the MCP function saw all sources healthy.
 * The unknown is cached like any other answer: when it threw instead,
 * nothing was cached and every visitor waited out the full timeout again
 * for as long as one source stayed slow.
 */
async function runOneCanary(canaryId: string): Promise<CachedCanary> {
  const canary = canaries().find((item) => item.id === canaryId);
  if (!canary) return { ok: false, at: Date.now(), detail: "neznámý zdroj" };
  const result = await runCanary(canary, false, CANARY_TIMEOUT_MS);
  // runCanary never throws; error is set exactly when the fetch itself failed.
  if (result.error !== null) return { ok: null, at: Date.now(), detail: result.error };
  return {
    ok: result.ok,
    at: Date.now(),
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

/**
 * The same canary behind Next's data cache. On Vercel that cache is shared
 * across instances and visitors, so a busy page costs one request per source
 * per CANARY_TTL_MS in total - not one per visitor and not one per instance,
 * which is what module memory would have given us.
 */
const cachedCanary = unstable_cache(runOneCanary, ["dawmain-source-canary"], {
  revalidate: CANARY_TTL_MS / 1000,
});

/**
 * Status of one displayed database (its canary id), null for an id that is
 * not one. Never throws - a status widget must not be able to take the page
 * down. One source at a time, so a slow source holds up only its own badge.
 */
export async function databaseStatus(id: string): Promise<DatabaseStatus | null> {
  const db = DATABASES.find((d) => d.canaryId === id);
  if (!db) return null;
  const { label, group, href, source, canaryId } = db;
  const row = { id: canaryId, label, group, href };
  // A real call this instance saw recently beats any canary - it is the
  // genuine article and costs nothing.
  const live = allSourceResults().find((entry) => entry.source === source);
  if (live && fresh(live, FRESH_MS)) {
    return {
      ...row,
      ok: live.ok,
      at: live.at,
      via: "provoz",
      ...(live.detail ? { detail: live.detail } : {}),
    };
  }
  try {
    const canary = await cachedCanary(canaryId);
    if (canary.ok === null) return { ...row, ok: null, at: null, via: null };
    return {
      ...row,
      ok: canary.ok,
      at: canary.at,
      via: "kontrola",
      ...(canary.detail ? { detail: canary.detail } : {}),
    };
  } catch {
    // A status widget must never take the page down.
    return { ...row, ok: null, at: null, via: null };
  }
}
