import { CookieSession } from "@/src/sources/shared/http";
import {
  buildNalusForm,
  classifyNalusPostBody,
  parseFormState,
  parseNalusAbstract,
  parseNalusDecision,
  parseNalusResults,
  type NalusAbstract,
} from "@/src/sources/nalus";
import type { Db } from "../db/client";
import { dequeue, enqueue, idsWithText, readCursor, saveDecision, writeCursor, type RunCounts } from "../db/store";
import { Pacer, SourceStopped, pacedFetch } from "../http";
import { mapUs, parseUsPublishedDates, US_PARSER_VERSION, usTextExtras, type UsHit } from "../map/us";

/**
 * ÚS backfill (v1-plan, zdroj 1): Search.aspx by quarter of the decision date
 * (80 rows a page) → the rows give sz, case number, ECLI, dates → per
 * decision GetText.aspx + GetAbstract.aspx (stateless). A quarter is listed
 * whole before any decision is fetched, so the search session never idles
 * while documents download. When the rows collected do not match the
 * banner's total (a cap, a page that came back short), the range is split
 * in half down to single days.
 */

const LABEL = "Ústavní soud (NALUS) – mirror";
const BASE = "https://nalus.usoud.cz/Search";
const PAGE_SIZE = 80;
/** First quarter of the court's decisions. */
export const US_FIRST_QUARTER = "1993Q1";

export interface CrawlContext {
  db: Db;
  pacer: Pacer;
  log: (line: string) => void;
  /** Called after every stored or failed decision (the CLI writes counts every 50). */
  progress?: (counts: RunCounts) => Promise<void>;
}

/** Requests per second across all workers (MIRROR_US_RPS; v1-plan default 1, set 4 on 24. 10.). */
export function newUsPacer(rps = 1): Pacer {
  if (!(rps > 0 && rps <= 10)) throw new Error(`requests per second must be in (0, 10], got ${rps}`);
  return new Pacer(1_000 / rps);
}

// ---------- quarters ----------

export function quarterRange(q: string): { from: string; to: string } {
  const m = /^(\d{4})Q([1-4])$/.exec(q);
  if (!m) throw new Error(`not a quarter: ${q} (expected e.g. 2024Q1)`);
  const year = Number(m[1]);
  const first = (Number(m[2]) - 1) * 3;
  const from = new Date(Date.UTC(year, first, 1));
  const to = new Date(Date.UTC(year, first + 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function nextQuarter(q: string): string {
  const m = /^(\d{4})Q([1-4])$/.exec(q)!;
  const n = Number(m[2]);
  return n === 4 ? `${Number(m[1]) + 1}Q1` : `${m[1]}Q${n + 1}`;
}

export function currentQuarter(now = new Date()): string {
  return `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------- discover ----------

/** All rows of one search (decision date from..to), page by page in one session. */
async function searchRange(ctx: CrawlContext, from: string, to: string): Promise<{ hits: UsHit[]; total: number }> {
  const session = new CookieSession();
  const formResponse = await pacedFetch(LABEL, ctx.pacer, `${BASE}/Search.aspx`);
  session.absorb(formResponse);
  const state = parseFormState(await formResponse.text());

  const post = await pacedFetch(LABEL, ctx.pacer, `${BASE}/Search.aspx`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: session.header(), referer: `${BASE}/Search.aspx` },
    body: buildNalusForm(state, { dateFrom: from, dateTo: to }, PAGE_SIZE).toString(),
    redirect: "manual",
  });
  session.absorb(post);
  if (post.status !== 302) {
    classifyNalusPostBody(await post.text()); // throws unless it is the zero-hits answer
    return { hits: [], total: 0 };
  }
  await post.body?.cancel().catch(() => undefined);

  const hits: UsHit[] = [];
  let total = 0;
  for (let page = 0; ; page++) {
    const response = await pacedFetch(LABEL, ctx.pacer, `${BASE}/Results.aspx${page > 0 ? `?page=${page}` : ""}`, {
      headers: { cookie: session.header(), referer: `${BASE}/Search.aspx` },
    });
    session.absorb(response);
    const html = await response.text();
    const parsed = parseNalusResults(html);
    const published = parseUsPublishedDates(html);
    total = parsed.total ?? 0;
    for (const hit of parsed.hits) {
      if (hit.sz) hits.push({ ...hit, sz: hit.sz, publishedOn: published.get(hit.sz) });
    }
    if (parsed.hits.length === 0 || (page + 1) * PAGE_SIZE >= total) break;
  }
  return { hits, total };
}

/** Every row decided from..to; splits the range while rows and total disagree. */
export async function discoverUs(ctx: CrawlContext, from: string, to: string): Promise<UsHit[]> {
  const { hits, total } = await searchRange(ctx, from, to);
  const unique = [...new Map(hits.map((h) => [h.sz, h])).values()];
  if (unique.length === total) return unique;
  const days = daysBetween(from, to);
  if (days < 1) {
    ctx.log(`us: ${from}: ${unique.length} řádků z ${total} (nejde dál dělit)`);
    return unique;
  }
  ctx.log(`us: ${from}..${to}: ${unique.length} řádků z ${total}, dělím interval`);
  const mid = addDays(from, Math.floor(days / 2));
  return [...(await discoverUs(ctx, from, mid)), ...(await discoverUs(ctx, addDays(mid, 1), to))];
}

// ---------- fetch ----------

export async function fetchUsDecision(ctx: CrawlContext, hit: UsHit) {
  const textResponse = await pacedFetch(LABEL, ctx.pacer, `${BASE}/GetText.aspx?sz=${hit.sz}`);
  const html = await textResponse.text();
  const decision = parseNalusDecision(html, hit.sz);
  let abstract: NalusAbstract | null = null;
  try {
    const abstractResponse = await pacedFetch(LABEL, ctx.pacer, `${BASE}/GetAbstract.aspx?sz=${hit.sz}`);
    abstract = parseNalusAbstract(await abstractResponse.text());
  } catch (error) {
    if (error instanceof SourceStopped) throw error;
    ctx.log(`us: ${hit.sz}: GetAbstract selhal (${error instanceof Error ? error.message : String(error)}), ukládám bez právní věty`);
  }
  return mapUs(hit, decision, abstract, usTextExtras(html));
}

/**
 * Fetch and store `hits` (skipping those stored with text) with `concurrency`
 * workers sharing ctx.pacer — the pacer, not the worker count, sets the
 * rate; more workers only keep it up while NALUS answers slowly. Failures go
 * to fetch_queue; a SourceStopped stops every worker and is rethrown.
 */
async function fetchAndStore(ctx: CrawlContext, hits: UsHit[], counts: RunCounts, concurrency: number): Promise<void> {
  const done = await idsWithText(ctx.db, "us", hits.map((h) => h.sz), US_PARSER_VERSION);
  const todo = hits.filter((h) => !done.has(h.sz));
  let next = 0;
  let stopped: SourceStopped | null = null;
  const worker = async () => {
    while (stopped === null && next < todo.length) {
      const hit = todo[next++];
      try {
        const record = await fetchUsDecision(ctx, hit);
        const saved = await saveDecision(ctx.db, record);
        counts.fetched++;
        if (saved.inserted || saved.textChanged) counts.changed++;
        await dequeue(ctx.db, "us", hit.sz);
      } catch (error) {
        if (error instanceof SourceStopped) {
          stopped = error;
          return;
        }
        counts.failed++;
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`us: ${hit.sz}: ${message}`);
        await enqueue(ctx.db, "us", hit.sz, "decision", message);
      }
      await ctx.progress?.(counts);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (stopped) throw stopped;
}

// ---------- backfill ----------

export interface UsBackfillOptions {
  /** Only these quarters (pilot); the cursor is left alone. Default: from the cursor to today. */
  quarters?: string[];
  /** At most this many decisions in total, spread evenly over the quarters and within each. */
  limit?: number;
  /** Decisions fetched at once (MIRROR_US_CONCURRENCY); default 1. */
  concurrency?: number;
}

/** Every k-th row so a sample spans the whole quarter (nálezy and usnesení alike). */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

export async function backfillUs(ctx: CrawlContext, options: UsBackfillOptions, counts: RunCounts): Promise<void> {
  const pilot = options.quarters !== undefined;
  let quarters = options.quarters;
  if (!quarters) {
    const cursor = await readCursor<{ next?: string }>(ctx.db, "us");
    const last = currentQuarter();
    quarters = [];
    for (let q = cursor?.next ?? US_FIRST_QUARTER; q <= last; q = nextQuarter(q)) quarters.push(q);
  }
  const perQuarter = options.limit ? Math.ceil(options.limit / quarters.length) : undefined;
  let left = options.limit ?? Infinity;
  for (const q of quarters) {
    if (left <= 0) break;
    const { from, to } = quarterRange(q);
    const all = await discoverUs(ctx, from, to);
    const take = perQuarter ? spread(all, Math.min(perQuarter, left)) : all;
    ctx.log(`us: ${q}: ${all.length} rozhodnutí, stahuji ${take.length}`);
    await fetchAndStore(ctx, take, counts, options.concurrency ?? 1);
    left -= take.length;
    if (!pilot && !options.limit) await writeCursor(ctx.db, "us", { next: nextQuarter(q) });
  }
}
