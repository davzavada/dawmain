import { searchNs } from "@/src/sources/ns";
import type { NssHit } from "@/src/sources/nss";
import { readCursor, type RunCounts } from "./db/store";
import { currentMonth as nssCurrentMonth, discoverNss, fetchNssDecision } from "./crawl/nss";
import { NSS_PARSER_VERSION } from "./map/nss";
import { discoverJusticeDay, fetchJusticeDecision, listJusticeDays, type JusticeEntry } from "./crawl/justice";
import { JUSTICE_PARSER_VERSION } from "./map/justice";
import { fetchNsDecision, type NsEntry } from "./crawl/ns";
import { NS_PARSER_VERSION } from "./map/ns";
import { discoverUs, fetchUsDecision } from "./crawl/us";
import { US_PARSER_VERSION, type UsHit } from "./map/us";
import { fetchSdeuDecision, listSdeu, sdeuCelexQuery, sdeuRecentQuery } from "./crawl/sdeu";
import { SDEU_PARSER_VERSION, type SdeuListItem } from "./map/sdeu";
import { fetchAndStore, type CrawlContext } from "./crawl/workers";
import type { MirrorSource } from "./types";

/**
 * Daily sync (v1-plan, krok 6) and the retry of fetch_queue. Run by
 * mirror-sync.timer at 03:30.
 *
 * sync: what each source PUBLISHED in the last days (ÚS, NS, NSS 7 days,
 * justice 14, SDEU 7 — received by the Publications Office), every item
 * fetched again (refresh), so a decision the source corrected is rewritten
 * and last_changed_at moves (saveDecision keeps it when nothing changed).
 *
 * retry: fetch_queue rows that are due (next_try_at), rebuilt from what is
 * stored about them (or from the source alone when nothing is), fetched
 * again; success dequeues, failure backs off (enqueue: 1 h · 2^n, ≤ 7 days).
 */

export const SYNC_DAYS: Record<MirrorSource, number> = { us: 7, ns: 7, nss: 7, justice: 14, sdeu: 7 };
/** fetch_queue rows retried per source and run. */
export const RETRY_BATCH = 500;

export function daysAgo(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (const d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface SyncOptions {
  /** Window length in days (default SYNC_DAYS of the source). */
  days?: number;
  concurrency: number;
  now?: Date;
}

/** NSS is synced only once its backfill has reached this month (the two would share one 403 budget). */
export async function nssBackfillDone(ctx: CrawlContext, now = new Date()): Promise<boolean> {
  const next = (await readCursor<{ next?: string }>(ctx.db, "nss"))?.next;
  return next !== undefined && next > nssCurrentMonth(now);
}

export async function syncSource(ctx: CrawlContext, source: MirrorSource, options: SyncOptions, counts: RunCounts): Promise<void> {
  const now = options.now ?? new Date();
  const from = daysAgo(options.days ?? SYNC_DAYS[source], now);
  const to = now.toISOString().slice(0, 10);
  const concurrency = options.concurrency;

  if (source === "us") {
    const hits = await discoverUs(ctx, from, to, "published");
    ctx.log(`us: sync ${from}..${to}: ${hits.length} zpřístupněných rozhodnutí`);
    await fetchAndStore(ctx, { source, parserVersion: US_PARSER_VERSION, items: hits, id: (h) => h.sz, fetch: (h) => fetchUsDecision(ctx, h), concurrency, refresh: true }, counts);
    return;
  }

  if (source === "ns") {
    const entries: NsEntry[] = [];
    for (let start = 1; ; start += 100) {
      await ctx.pacer.wait();
      const page = await searchNs({ publishedFrom: from, publishedTo: to }, start, 100);
      entries.push(...page.hits.map((h) => ({ unid: h.unid.toUpperCase(), caseNumber: h.caseNumbers[0] ?? null })));
      if (page.hits.length < 100 || (page.total !== null && start + 99 >= page.total)) break;
    }
    const unique = [...new Map(entries.map((e) => [e.unid, e])).values()];
    ctx.log(`ns: sync ${from}..${to}: ${unique.length} rozhodnutí předaných na web`);
    await fetchAndStore(ctx, { source, parserVersion: NS_PARSER_VERSION, items: unique, id: (e) => e.unid, fetch: (e) => fetchNsDecision(ctx, e), concurrency, refresh: true }, counts);
    return;
  }

  if (source === "nss") {
    if (!(await nssBackfillDone(ctx, now))) {
      ctx.log("nss: sync přeskočen — backfill ještě běží (sdílí s ním limit NSS)");
      return;
    }
    const hits = await discoverNss(ctx, from, to, "published");
    ctx.log(`nss: sync ${from}..${to}: ${hits.length} zpřístupněných rozhodnutí`);
    await fetchAndStore(ctx, { source, parserVersion: NSS_PARSER_VERSION, items: hits, id: (h) => h.id, fetch: (h) => fetchNssDecision(ctx, h), concurrency, refresh: true }, counts);
    return;
  }

  if (source === "justice") {
    const months = [...new Set(eachDay(from, to).map((d) => d.slice(0, 7)))];
    const entries: JusticeEntry[] = [];
    for (const month of months) {
      for (const day of await listJusticeDays(ctx, month)) {
        if (day.date < from || day.date > to) continue;
        entries.push(...(await discoverJusticeDay(ctx, day.date, day.count)));
      }
    }
    ctx.log(`justice: sync ${from}..${to}: ${entries.length} zveřejněných rozhodnutí`);
    await fetchAndStore(ctx, { source, parserVersion: JUSTICE_PARSER_VERSION, items: entries, id: (e) => e.uuid, fetch: (e) => fetchJusticeDecision(ctx, e), concurrency, refresh: true }, counts);
    return;
  }

  const items = await listSdeu(ctx, (offset) => sdeuRecentQuery(from, offset), `přijato od ${from}`);
  ctx.log(`sdeu: sync od ${from}: ${items.length} dokumentů`);
  await fetchAndStore(ctx, { source, parserVersion: SDEU_PARSER_VERSION, items, id: (i) => i.celex, fetch: (i) => fetchSdeuDecision(ctx, i), concurrency, refresh: true }, counts);
}

// ---------- retry ----------

interface StoredRow {
  source_id: string;
  case_number: string | null;
  case_numbers: string[] | null;
  court: string | null;
  decision_type: string | null;
  decided_on: string | null;
  published_on: string | null;
  ecli: string | null;
}

async function dueIds(ctx: CrawlContext, source: MirrorSource): Promise<string[]> {
  const { rows } = await ctx.db.query<{ source_id: string }>(
    `SELECT source_id FROM mirror.fetch_queue WHERE source = $1 AND next_try_at <= now()
     GROUP BY source_id ORDER BY min(next_try_at) LIMIT $2`,
    [source, RETRY_BATCH],
  );
  return rows.map((r) => r.source_id);
}

async function stored(ctx: CrawlContext, source: MirrorSource, ids: string[]): Promise<Map<string, StoredRow>> {
  const { rows } = await ctx.db.query<StoredRow & Record<string, unknown>>(
    `SELECT source_id, case_number, case_numbers, court, decision_type, decided_on::text AS decided_on,
            published_on::text AS published_on, ecli
     FROM mirror.decision WHERE source = $1 AND source_id = ANY($2::text[])`,
    [source, ids],
  );
  return new Map(rows.map((r) => [r.source_id, r]));
}

/** Retry the due fetch_queue rows of `source`; returns how many were due. */
export async function retrySource(ctx: CrawlContext, source: MirrorSource, concurrency: number, counts: RunCounts): Promise<number> {
  if (source === "nss" && !(await nssBackfillDone(ctx))) {
    ctx.log("nss: opakování fronty přeskočeno — backfill ještě běží (sdílí s ním limit NSS)");
    return 0;
  }
  const ids = await dueIds(ctx, source);
  if (ids.length === 0) return 0;
  const rows = await stored(ctx, source, ids);
  ctx.log(`${source}: opakuji ${ids.length} rozhodnutí z fronty`);
  const common = { concurrency, refresh: true as const };

  if (source === "us") {
    const items: UsHit[] = ids.map((sz) => {
      const r = rows.get(sz);
      return { sz, caseNumber: r?.case_number ?? "", date: r?.decided_on ?? undefined, ecli: r?.ecli ?? undefined, publishedOn: r?.published_on ?? undefined, url: null };
    });
    await fetchAndStore(ctx, { source, parserVersion: US_PARSER_VERSION, items, id: (h) => h.sz, fetch: (h) => fetchUsDecision(ctx, h), ...common }, counts);
  } else if (source === "ns") {
    const items: NsEntry[] = ids.map((unid) => ({ unid, caseNumber: rows.get(unid)?.case_number ?? null }));
    await fetchAndStore(ctx, { source, parserVersion: NS_PARSER_VERSION, items, id: (e) => e.unid, fetch: (e) => fetchNsDecision(ctx, e), ...common }, counts);
  } else if (source === "nss") {
    const items = ids.map((id) => ({ id, url: `https://vyhledavac.nssoud.cz/DokumentDetail/Index/${id}` }) as NssHit);
    await fetchAndStore(ctx, { source, parserVersion: NSS_PARSER_VERSION, items, id: (h) => h.id, fetch: (h) => fetchNssDecision(ctx, h), ...common }, counts);
  } else if (source === "justice") {
    const items: JusticeEntry[] = ids.map((uuid) => {
      const r = rows.get(uuid);
      return {
        uuid,
        item: {
          jednaciCislo: r?.case_numbers?.[1] ?? r?.case_number ?? undefined,
          soud: r?.court ?? undefined,
          ecli: r?.ecli ?? undefined,
          datumVydani: r?.decided_on ?? undefined,
          datumZverejneni: r?.published_on ?? undefined,
        },
      };
    });
    await fetchAndStore(ctx, { source, parserVersion: JUSTICE_PARSER_VERSION, items, id: (e) => e.uuid, fetch: (e) => fetchJusticeDecision(ctx, e), ...common }, counts);
  } else {
    // SDEU: the listing fields come from Cellar itself (a document may never have been stored).
    const listed = new Map((await listSdeu(ctx, (offset) => sdeuCelexQuery(ids, offset), "fronta")).map((i) => [i.celex, i]));
    const items: SdeuListItem[] = ids.map((celex) => listed.get(celex) ?? { celex });
    await fetchAndStore(ctx, { source, parserVersion: SDEU_PARSER_VERSION, items, id: (i) => i.celex, fetch: (i) => fetchSdeuDecision(ctx, i), ...common }, counts);
  }
  return ids.length;
}
