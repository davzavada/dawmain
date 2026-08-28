import { unstable_cache } from "next/cache";
import { canaries, runCanary } from "./tools/probe";
import { allSourceResults, type SourceHealth } from "@/src/sources/shared/health";

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
 *     5 minutes serves everybody, not one per instance.
 *  3. Nothing. If a canary cannot run, the row simply says "neověřeno"
 *     rather than claiming an outage we did not observe.
 */

/** A real observation stays authoritative for this long. */
const FRESH_MS = 15 * 60 * 1000;
/**
 * How long a canary result is reused before another one may run. Short on
 * purpose: the page function and the MCP function are different instances, so
 * a visitor almost never sees tier 1, and the light would otherwise sit on a
 * five-minute-old check after a source came back. One minute keeps it honest
 * while still costing at most one request per source per minute for everyone
 * together, because the cache below is shared, not per instance.
 */
const CANARY_TTL_MS = 60 * 1000;
/**
 * Matches the probe's own timeout. A shorter one produced FALSE REDS: the NS
 * Domino search regularly needs more than a few seconds, so a tight deadline
 * reported a healthy source as down. The page never waits on this anyway,
 * the status list streams in its own Suspense boundary.
 */
const CANARY_TIMEOUT_MS = 12_000;

export interface DatabaseStatus {
  /** Display name of the database. */
  label: string;
  /** Where a human can verify the source themselves. */
  href: string;
  ok: boolean | null;
  /** Epoch ms of the observation behind `ok`, null when unknown. */
  at: number | null;
  /** "provoz" = seen on a real call, "kontrola" = canary, null = unknown. */
  via: "provoz" | "kontrola" | null;
  detail?: string;
}

/**
 * The databases shown on the page, each tied to the SOURCE constant its
 * client reports under and to the probe canary that can stand in for it.
 */
const DATABASES: Array<{ label: string; href: string; source: string; canaryId: string }> = [
  {
    label: "Nejvyšší soud",
    href: "https://rozhodnuti.nsoud.cz",
    source: "Nejvyšší soud",
    canaryId: "ns",
  },
  {
    label: "Nejvyšší správní soud",
    href: "https://vyhledavac.nssoud.cz",
    source: "Nejvyšší správní soud",
    canaryId: "nss",
  },
  {
    label: "Ústavní soud (NALUS)",
    href: "https://nalus.usoud.cz",
    source: "Ústavní soud (NALUS)",
    canaryId: "nalus",
  },
  {
    label: "obecné soudy",
    href: "https://rozhodnuti.justice.cz",
    source: "rozhodnuti.justice.cz",
    canaryId: "justice",
  },
  {
    label: "Soudní dvůr EU (InfoCuria)",
    href: "https://infocuria.curia.europa.eu",
    source: "CJEU (InfoCuria)",
    canaryId: "curia",
  },
  {
    label: "e-Sbírka",
    href: "https://www.e-sbirka.cz",
    source: "e-Sbírka",
    canaryId: "esbirka-api",
  },
  {
    label: "EUR-Lex (Cellar)",
    href: "https://eur-lex.europa.eu",
    source: "EUR-Lex (Cellar)",
    canaryId: "cellar-sparql",
  },
];

interface CachedCanary {
  ok: boolean;
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
 * source, so this THROWS: unstable_cache then caches nothing and the row
 * shows "neověřeno" instead of an outage we did not see. Getting that wrong
 * once painted every row red at the same minute a probe from the MCP
 * function saw all sources healthy.
 */
async function runOneCanary(canaryId: string): Promise<CachedCanary> {
  const canary = canaries().find((item) => item.id === canaryId);
  if (!canary) return { ok: false, at: Date.now(), detail: "neznámý zdroj" };
  const result = await Promise.race([
    runCanary(canary),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CANARY_TIMEOUT_MS),
    ),
  ]);
  // runCanary never throws; error is set exactly when the fetch itself failed.
  if (result.error !== null) throw new Error(result.error);
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
 * Status of every displayed database. Never throws - a status widget must not
 * be able to take the page down.
 */
export async function databaseStatuses(): Promise<DatabaseStatus[]> {
  const observed = new Map<string, SourceHealth>();
  for (const entry of allSourceResults()) observed.set(entry.source, entry);

  return Promise.all(
    DATABASES.map(async ({ label, href, source, canaryId }): Promise<DatabaseStatus> => {
      // A real call this instance saw recently beats any canary - it is the
      // genuine article and costs nothing.
      const live = observed.get(source);
      if (live && fresh(live, FRESH_MS)) {
        return {
          label,
          href,
          ok: live.ok,
          at: live.at,
          via: "provoz",
          ...(live.detail ? { detail: live.detail } : {}),
        };
      }
      try {
        const canary = await cachedCanary(canaryId);
        return {
          label,
          href,
          ok: canary.ok,
          at: canary.at,
          via: "kontrola",
          ...(canary.detail ? { detail: canary.detail } : {}),
        };
      } catch {
        // A status widget must never take the page down.
        return { label, href, ok: null, at: null, via: null };
      }
    }),
  );
}

/** "14:07" in Prague time - what the light is as of. */
export function formatTime(at: number): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(new Date(at));
}
