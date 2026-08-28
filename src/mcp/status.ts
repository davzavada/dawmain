import { canaries, runCanary } from "./tools/probe";
import { allSourceResults, type SourceHealth } from "@/src/sources/shared/health";

/**
 * The green/red light next to each database on the home page.
 *
 * Cheap by construction, in three tiers:
 *  1. Real traffic. Every tool call already records how its source answered
 *     (src/sources/shared/health.ts), so an active server needs no probing
 *     at all — the light reports the last genuine call and when it happened.
 *  2. A cached canary. Only when no real call has been seen for
 *     FRESH_MS does the page fire the probe canary for that source, and the
 *     result is reused for CANARY_TTL_MS. On serverless the page function
 *     rarely shares memory with the MCP function, so in practice this is what
 *     a visitor sees — capped at one lightweight request per source per
 *     5 minutes per instance, all sources in parallel.
 *  3. Nothing. If a canary cannot run, the row simply says "neověřeno"
 *     rather than claiming an outage we did not observe.
 */

/** A real observation stays authoritative for this long. */
const FRESH_MS = 15 * 60 * 1000;
/** How long a canary result is reused before another one may run. */
const CANARY_TTL_MS = 5 * 60 * 1000;
/** Page renders must not hang on a dead upstream. */
const CANARY_TIMEOUT_MS = 6000;

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

const canaryCache = new Map<string, CachedCanary>();

function fresh(entry: { at: number } | undefined, ttl: number): boolean {
  return Boolean(entry && Date.now() - entry.at < ttl);
}

/** One canary, with its own timeout, never throwing. */
async function checkCanary(canaryId: string): Promise<CachedCanary | undefined> {
  const canary = canaries().find((item) => item.id === canaryId);
  if (!canary) return undefined;
  try {
    const result = await Promise.race([
      runCanary(canary),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), CANARY_TIMEOUT_MS),
      ),
    ]);
    const entry: CachedCanary = {
      ok: result.ok,
      at: Date.now(),
      ...(result.ok ? {} : { detail: result.http_status ? `HTTP ${result.http_status}` : "nedostupné" }),
    };
    canaryCache.set(canaryId, entry);
    return entry;
  } catch {
    const entry: CachedCanary = { ok: false, at: Date.now(), detail: "nedostupné" };
    canaryCache.set(canaryId, entry);
    return entry;
  }
}

/**
 * Status of every displayed database. Never throws — a status widget must not
 * be able to take the page down.
 */
export async function databaseStatuses(): Promise<DatabaseStatus[]> {
  const observed = new Map<string, SourceHealth>();
  for (const entry of allSourceResults()) observed.set(entry.source, entry);

  // Which rows need a canary: no fresh real call AND no fresh cached canary.
  const needed = DATABASES.filter(
    ({ source, canaryId }) =>
      !fresh(observed.get(source), FRESH_MS) && !fresh(canaryCache.get(canaryId), CANARY_TTL_MS),
  );
  await Promise.all(needed.map(({ canaryId }) => checkCanary(canaryId)));

  return DATABASES.map(({ label, href, source, canaryId }) => {
    const live = observed.get(source);
    if (fresh(live, FRESH_MS) && live) {
      return {
        label,
        href,
        ok: live.ok,
        at: live.at,
        via: "provoz" as const,
        ...(live.detail ? { detail: live.detail } : {}),
      };
    }
    const canary = canaryCache.get(canaryId);
    if (canary) {
      return {
        label,
        href,
        ok: canary.ok,
        at: canary.at,
        via: "kontrola" as const,
        ...(canary.detail ? { detail: canary.detail } : {}),
      };
    }
    return { label, href, ok: null, at: null, via: null };
  });
}

/** "14:07" in Prague time — what the light is as of. */
export function formatTime(at: number): string {
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(new Date(at));
}
