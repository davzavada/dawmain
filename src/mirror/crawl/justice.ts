import { SourceError } from "@/src/sources/shared/errors";
import { parseJusticeDecision } from "@/src/sources/justice";
import { readCursor, writeCursor, type RunCounts } from "../db/store";
import { pacedFetch } from "../http";
import { JUSTICE_PARSER_VERSION, justiceUuid, mapJustice, type JusticeListItem } from "../map/justice";
import type { DecisionRecord } from "../types";
import { fetchAndStore, spread, type CrawlContext } from "./workers";

/**
 * justice.cz backfill (v1-plan, zdroj 4) over the ministry's open data, by
 * DAY OF PUBLICATION: /api/opendata/{y}/{m} lists the days with their counts,
 * /api/opendata/{y}/{m}/{d}?page=N their decisions (100 a page, 0-based),
 * each checked against the day's count. Per decision one request,
 * /api/finaldoc/{uuid}. 611,353 decisions on 24. 10. 2026, first day
 * 2020-10-01. The server answers 429 under load (src/sources/justice.ts).
 */

const LABEL = "rozhodnuti.justice.cz – mirror";
const API = "https://rozhodnuti.justice.cz/api";
export const JUSTICE_FIRST_MONTH = "2020-10";

export interface JusticeEntry {
  uuid: string;
  item: JusticeListItem;
}

async function getJson<T>(ctx: CrawlContext, url: string): Promise<T> {
  const response = await pacedFetch(LABEL, ctx.pacer, url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`justice.cz answered HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** Days of a month that have decisions, with their counts ([] for a month without any: 404). */
export async function listJusticeDays(ctx: CrawlContext, month: string): Promise<Array<{ date: string; count: number }>> {
  const [y, m] = month.split("-").map(Number);
  const response = await pacedFetch(LABEL, ctx.pacer, `${API}/opendata/${y}/${m}`, { headers: { accept: "application/json" } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`justice.cz answered HTTP ${response.status} for month ${month}`);
  const days = (await response.json()) as Array<{ datum?: string; pocet?: number }>;
  return days.filter((d) => d.datum).map((d) => ({ date: d.datum!, count: Number(d.pocet ?? 0) }));
}

/** Every decision published on `date`; logs when the pages do not add up to the day's count. */
export async function discoverJusticeDay(ctx: CrawlContext, date: string, count: number): Promise<JusticeEntry[]> {
  const [y, m, d] = date.split("-").map(Number);
  const entries: JusticeEntry[] = [];
  for (let page = 0; ; page++) {
    const body = await getJson<{ items?: JusticeListItem[]; totalPages?: number }>(ctx, `${API}/opendata/${y}/${m}/${d}?page=${page}`);
    for (const item of body.items ?? []) {
      const uuid = justiceUuid(item);
      if (uuid) entries.push({ uuid, item });
    }
    if (!body.items?.length || page + 1 >= Number(body.totalPages ?? 0)) break;
  }
  const unique = [...new Map(entries.map((e) => [e.uuid, e])).values()];
  if (unique.length !== count) ctx.log(`justice: ${date}: ${unique.length} rozhodnutí, den uvádí ${count}`);
  return unique;
}

export async function fetchJusticeDecision(ctx: CrawlContext, entry: JusticeEntry): Promise<DecisionRecord> {
  const response = await pacedFetch(LABEL, ctx.pacer, `${API}/finaldoc/${entry.uuid}`, { headers: { accept: "application/json" } });
  if (response.status === 404) throw new Error(`justice.cz has no finaldoc ${entry.uuid} (404)`);
  if (!response.ok) throw new Error(`justice.cz answered HTTP ${response.status} for finaldoc ${entry.uuid}`);
  const json = await response.json();
  try {
    return mapJustice(entry.uuid, entry.item, parseJusticeDecision(json, entry.uuid));
  } catch (error) {
    // A finaldoc without any text: the record without it, queued (workers) — not a crash.
    if (error instanceof SourceError && error.kind === "PARSE_DRIFT") {
      const metadata = ((json as { metadata?: Record<string, unknown> | null })?.metadata ?? {}) as Record<string, unknown>;
      return mapJustice(entry.uuid, entry.item, { text: "", metadata });
    }
    throw error;
  }
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface JusticeBackfillOptions {
  /** Only these days of publication (pilot, "2025-03-12"); the cursor is left alone. */
  days?: string[];
  /** At most this many decisions in total, spread evenly over the days. */
  limit?: number;
  concurrency?: number;
}

/**
 * Full run: month by month from the cursor ({next: "YYYY-MM-DD"}, the first
 * day not done), day by day; the cursor moves after each finished day.
 */
export async function backfillJustice(ctx: CrawlContext, options: JusticeBackfillOptions, counts: RunCounts): Promise<void> {
  const job = (items: JusticeEntry[]) => ({
    source: "justice" as const,
    parserVersion: JUSTICE_PARSER_VERSION,
    items,
    id: (e: JusticeEntry) => e.uuid,
    fetch: (e: JusticeEntry) => fetchJusticeDecision(ctx, e),
    concurrency: options.concurrency ?? 1,
  });

  if (options.days) {
    const perDay = options.limit ? Math.ceil(options.limit / options.days.length) : undefined;
    let left = options.limit ?? Infinity;
    for (const date of options.days) {
      if (left <= 0 || ctx.shouldStop?.()) break;
      const month = date.slice(0, 7);
      const count = (await listJusticeDays(ctx, month)).find((d) => d.date === date)?.count ?? 0;
      const all = await discoverJusticeDay(ctx, date, count);
      const take = perDay ? spread(all, Math.min(perDay, left)) : all;
      ctx.log(`justice: ${date}: ${all.length} rozhodnutí, stahuji ${take.length}`);
      await fetchAndStore(ctx, job(take), counts);
      left -= take.length;
    }
    return;
  }

  const cursor = (await readCursor<{ next?: string }>(ctx.db, "justice"))?.next ?? `${JUSTICE_FIRST_MONTH}-01`;
  const last = currentMonth();
  for (let month = cursor.slice(0, 7); month <= last; month = nextMonth(month)) {
    for (const day of await listJusticeDays(ctx, month)) {
      if (ctx.shouldStop?.()) return;
      if (day.date < cursor) continue;
      const all = await discoverJusticeDay(ctx, day.date, day.count);
      ctx.log(`justice: ${day.date}: ${all.length} rozhodnutí`);
      await fetchAndStore(ctx, job(all), counts);
      if (ctx.shouldStop?.()) return;
      const next = new Date(`${day.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      await writeCursor(ctx.db, "justice", { next: next.toISOString().slice(0, 10) });
    }
  }
}
