import { SourceError } from "@/src/sources/shared/errors";
import { decodeBody, htmlToText, looksLikeHtml } from "@/src/sources/shared/html";
import { decodeRendition, isNssMissingBody, parseNssDetail, searchNss, type NssHit } from "@/src/sources/nss";
import { readCursor, writeCursor, type RunCounts } from "../db/store";
import { SourceStopped, pacedFetch } from "../http";
import { NSS_PARSER_VERSION, mapNss } from "../map/nss";
import type { DecisionRecord } from "../types";
import { fetchAndStore, spread, type CrawlContext } from "./workers";

/**
 * NSS backfill (v1-plan, zdroj 3). The ids are sparse (~22 % of 1–790,000
 * taken, live 24. 10. 2026), so they are not walked: the search lists them
 * by month of the decision date (searchNss — antiforgery session shared,
 * page 1 = 40 rows, later pages 20), checked against "Počet nalezených
 * záznamů"; a month whose rows and total disagree is split down to days.
 * Per decision: /DokumentDetail/Index (metadata), /DokumentOriginal/Text
 * (UTF-16), /DokumentOriginal/Html when Text is missing.
 */

const LABEL = "Nejvyšší správní soud – mirror";
const BASE = "https://vyhledavac.nssoud.cz";
/** Before NSS (2003) the database holds the krajské soudy's decisions; the walk starts with the Republic. */
export const NSS_FIRST_MONTH = "1993-01";

// ---------- months ----------

export function monthRange(month: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`not a month: ${month} (expected e.g. 2024-03)`);
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- discover ----------

/** searchNss behind the pacer; a 429/403 becomes SourceStopped. */
async function pacedSearch(ctx: CrawlContext, from: string, to: string, page: number) {
  await ctx.pacer.wait();
  try {
    return await searchNss({ dateFrom: from, dateTo: to }, page);
  } catch (error) {
    if (error instanceof SourceError && /HTTP (429|403)\b/.test(error.message)) {
      throw new SourceStopped(Number(/HTTP (\d{3})/.exec(error.message)![1]), `${BASE}/Home/Index`);
    }
    throw error;
  }
}

async function searchRange(ctx: CrawlContext, from: string, to: string): Promise<{ hits: NssHit[]; total: number }> {
  const first = await pacedSearch(ctx, from, to, 1);
  const total = first.total ?? first.hits.length;
  const hits = [...first.hits];
  for (let page = 2; hits.length < total; page++) {
    const next = await pacedSearch(ctx, from, to, page);
    if (next.hits.length === 0) break;
    hits.push(...next.hits);
  }
  return { hits, total };
}

/** Every decision decided from..to; splits the range while rows and total disagree. */
export async function discoverNss(ctx: CrawlContext, from: string, to: string): Promise<NssHit[]> {
  const { hits, total } = await searchRange(ctx, from, to);
  const unique = [...new Map(hits.map((h) => [h.id, h])).values()];
  if (unique.length === total) return unique;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  if (days < 1) {
    ctx.log(`nss: ${from}: ${unique.length} řádků z ${total} (nejde dál dělit)`);
    return unique;
  }
  ctx.log(`nss: ${from}..${to}: ${unique.length} řádků z ${total}, dělím interval`);
  const mid = addDays(from, Math.floor(days / 2));
  return [...(await discoverNss(ctx, from, mid)), ...(await discoverNss(ctx, addDays(mid, 1), to))];
}

// ---------- fetch ----------

async function nssText(ctx: CrawlContext, id: string): Promise<{ body: string; source: string } | null> {
  const textResponse = await pacedFetch(LABEL, ctx.pacer, `${BASE}/DokumentOriginal/Text/${id}`);
  if (textResponse.ok) {
    // UTF-16; Aspose leaves control characters where dashes belong (\u001e in case numbers).
    const text = (await decodeBody(textResponse, "utf-16le"))
      .replace(/\u001e/g, "-")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
      .trim();
    if (text && !isNssMissingBody(text)) return { body: looksLikeHtml(text) ? htmlToText(text) : text, source: "nss:text" };
  } else {
    await textResponse.body?.cancel().catch(() => undefined);
  }
  const htmlResponse = await pacedFetch(LABEL, ctx.pacer, `${BASE}/DokumentOriginal/Html/${id}`);
  if (!htmlResponse.ok) {
    await htmlResponse.body?.cancel().catch(() => undefined);
    if (htmlResponse.status === 404 || htmlResponse.status === 410) return null;
    throw new Error(`NSS answered HTTP ${htmlResponse.status} for the text of ${id}`);
  }
  const html = await decodeRendition(htmlResponse);
  const converted = isNssMissingBody(html) ? "" : htmlToText(html);
  if (!converted || /^\s*(?:N\/A(?:\s*-\s*text)?\s*)+$/i.test(converted)) return null;
  return { body: converted, source: "nss:html" };
}

export async function fetchNssDecision(ctx: CrawlContext, hit: NssHit): Promise<DecisionRecord> {
  const detail = await pacedFetch(LABEL, ctx.pacer, `${BASE}/DokumentDetail/Index/${hit.id}`);
  if (!detail.ok) throw new Error(`NSS detail answered HTTP ${detail.status} for ${hit.id}`);
  const metadata = parseNssDetail(await detail.text());
  if (!metadata["Spisová značka"] && !metadata["ECLI"]) throw new Error(`NSS detail of ${hit.id} carries no case number nor ECLI`);
  return mapNss(hit.id, metadata, await nssText(ctx, hit.id));
}

// ---------- backfill ----------

export interface NssBackfillOptions {
  /** Only these months (pilot); the cursor is left alone. Default: from the cursor to this month. */
  months?: string[];
  /** At most this many decisions in total, spread evenly over the months. */
  limit?: number;
  concurrency?: number;
}

export async function backfillNss(ctx: CrawlContext, options: NssBackfillOptions, counts: RunCounts): Promise<void> {
  const pilot = options.months !== undefined;
  let months = options.months;
  if (!months) {
    const cursor = await readCursor<{ next?: string }>(ctx.db, "nss");
    const last = currentMonth();
    months = [];
    for (let m = cursor?.next ?? NSS_FIRST_MONTH; m <= last; m = nextMonth(m)) months.push(m);
  }
  const perMonth = options.limit ? Math.ceil(options.limit / months.length) : undefined;
  let left = options.limit ?? Infinity;
  for (const month of months) {
    if (left <= 0 || ctx.shouldStop?.()) break;
    const { from, to } = monthRange(month);
    const all = await discoverNss(ctx, from, to);
    const take = perMonth ? spread(all, Math.min(perMonth, left)) : all;
    ctx.log(`nss: ${month}: ${all.length} rozhodnutí, stahuji ${take.length}`);
    await fetchAndStore(
      ctx,
      {
        source: "nss",
        parserVersion: NSS_PARSER_VERSION,
        items: take,
        id: (h) => h.id,
        fetch: (h) => fetchNssDecision(ctx, h),
        concurrency: options.concurrency ?? 1,
      },
      counts,
    );
    left -= take.length;
    if (ctx.shouldStop?.()) break;
    if (!pilot && !options.limit) await writeCursor(ctx.db, "nss", { next: nextMonth(month) });
  }
}
