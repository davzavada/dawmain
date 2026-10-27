import { decodeBody } from "@/src/sources/shared/html";
import { buildNsQuery, nsBodyMissing, nsSearchUrl, parseNsSearch } from "@/src/sources/ns";
import { readCursor, writeCursor, type RunCounts } from "../db/store";
import { SourceStopped, pacedFetch } from "../http";
import { NS_PARSER_VERSION, mapNs, markNsPictures, parseNsMarked } from "../map/ns";
import type { DecisionImage, DecisionRecord } from "../types";
import { fetchAndStore, spread, type CrawlContext } from "./workers";

/**
 * NS backfill (v1-plan, zdroj 2). Discover: the Domino view behind the
 * search lists every document, `WebSearch?ReadViewEntries&OutputFormat=JSON`
 * — UNID and case number, up to 3,000 a request (165,460 on 24. 10. 2026),
 * ordered by UNID. Fetch: WebSearch/{UNID}, WebPrint/{UNID} when it has no
 * body (nsBodyMissing; the longer text wins), then the decision's own
 * pictures (the state emblem of older decisions) one by one.
 *
 * Domino answers a burst with HTTP 500 for minutes: the plan's 1 req/s and
 * at most 2 at once, plus the workers' cool-down after a run of failures.
 */

const LABEL = "Nejvyšší soud – mirror";
const DB = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";
/** The most entries the view returns in one request (measured). */
export const NS_VIEW_PAGE = 3_000;

export interface NsEntry {
  unid: string;
  caseNumber: string | null;
}

/** One page of the view (1-based `start`). Pure parse of Domino's JSON. */
export function parseNsViewPage(json: string): { entries: NsEntry[]; total: number } {
  const data = JSON.parse(json) as {
    "@toplevelentries"?: string;
    viewentry?: Array<{ "@unid"?: string; entrydata?: Array<{ "@name"?: string; text?: Record<string, string> }> }>;
  };
  const entries: NsEntry[] = [];
  for (const v of data.viewentry ?? []) {
    const unid = v["@unid"];
    if (!unid || !/^[0-9A-F]{32}$/i.test(unid)) continue;
    const znacka = v.entrydata?.find((e) => e["@name"] === "znacka")?.text?.["0"] ?? null;
    entries.push({ unid: unid.toUpperCase(), caseNumber: znacka?.trim() || null });
  }
  return { entries, total: Number(data["@toplevelentries"] ?? 0) };
}

export async function listNsPage(ctx: CrawlContext, start: number): Promise<{ entries: NsEntry[]; total: number }> {
  const response = await pacedFetch(LABEL, ctx.pacer, `${DB}/WebSearch?ReadViewEntries&OutputFormat=JSON&Count=${NS_VIEW_PAGE}&Start=${start}`);
  return parseNsViewPage(await decodeBody(response));
}

/** The whole view, page by page; checks the count against the view's own total. */
export async function discoverNs(ctx: CrawlContext): Promise<NsEntry[]> {
  const all: NsEntry[] = [];
  let total = 0;
  for (let start = 1; ; start += NS_VIEW_PAGE) {
    const page = await listNsPage(ctx, start);
    total = page.total;
    all.push(...page.entries);
    if (page.entries.length < NS_VIEW_PAGE || all.length >= total) break;
  }
  const unique = [...new Map(all.map((e) => [e.unid, e])).values()];
  if (unique.length !== total) ctx.log(`ns: výčet ${unique.length} UNID, pohled uvádí ${total}`);
  return unique;
}

/** GIF, PNG or JPEG by their magic bytes; null for anything else. Pure. */
export function sniffImage(bytes: Uint8Array): "image/gif" | "image/png" | "image/jpeg" | null {
  const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

async function fetchRendition(ctx: CrawlContext, unid: string, rendition: "WebPrint" | "WebSearch") {
  const response = await pacedFetch(LABEL, ctx.pacer, `${DB}/${rendition}/${unid}?openDocument`);
  if (response.status === 404) throw new Error(`NS has no document ${unid} (404)`);
  if (!response.ok) throw new Error(`NS answered HTTP ${response.status} for ${rendition}/${unid}`);
  const { html, pictures } = markNsPictures(await decodeBody(response));
  return { ...parseNsMarked(html, unid, pictures.length), pictures };
}

/**
 * WebSearch first: it alone carries "Zveřejněno na webu", and its text equals
 * WebPrint's (pilot 24. 10.: 100/100 once the leading citation note is cut).
 * WebPrint only when WebSearch has no body; the longer text wins, WebSearch's
 * metadata where both have a field.
 */
export async function fetchNsDecision(ctx: CrawlContext, entry: NsEntry): Promise<DecisionRecord> {
  let page = await fetchRendition(ctx, entry.unid, "WebSearch");
  let textSource: "ns:webprint" | "ns:websearch" = "ns:websearch";
  if (nsBodyMissing(page.decision.text)) {
    const other = await fetchRendition(ctx, entry.unid, "WebPrint");
    if (other.decision.text.length > page.decision.text.length) {
      page = { ...other, decision: { ...other.decision, metadata: { ...other.decision.metadata, ...page.decision.metadata } } };
      textSource = "ns:webprint";
    }
  }
  // A picture the source cannot serve (live: HTTP 404 on an emblem) is its
  // defect, not ours: the decision is stored with its text and without that
  // picture, and the log says which. Only 429/403 (SourceStopped) propagates.
  const images: DecisionImage[] = [];
  for (const [i, pic] of page.pictures.entries()) {
    try {
      const response = await pacedFetch(LABEL, ctx.pacer, pic.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      // Domino labels some pictures application/octet-stream: the bytes say what they are.
      const mime = sniffImage(bytes) ?? (type === "image/png" || type === "image/jpeg" || type === "image/gif" ? type : null);
      if (!mime) throw new Error(`${type || "untyped"}, not a GIF, PNG or JPEG`);
      images.push({ charAt: page.offsets[i] ?? 0, mime, width: pic.width, height: pic.height, bytes, sourceUrl: pic.url });
    } catch (error) {
      if (error instanceof SourceStopped) throw error;
      ctx.log(`ns: ${entry.unid}: obrázek ${i} nedostupný (${error instanceof Error ? error.message : String(error)}), ukládám bez něj`);
    }
  }
  return mapNs(entry.unid, page.decision, textSource, images);
}

export interface NsBackfillOptions {
  /** Pilot: at most this many decisions, spread over the whole view; the cursor is left alone. */
  limit?: number;
  concurrency?: number;
}

/**
 * Full run: the view page by page from the cursor ({start}), each page's
 * decisions fetched before the cursor moves on. Pilot (limit): the whole view
 * is listed, a spread sample fetched.
 */
export async function backfillNs(ctx: CrawlContext, options: NsBackfillOptions, counts: RunCounts): Promise<void> {
  const job = (items: NsEntry[]) => ({
    source: "ns" as const,
    parserVersion: NS_PARSER_VERSION,
    items,
    id: (e: NsEntry) => e.unid,
    fetch: (e: NsEntry) => fetchNsDecision(ctx, e),
    concurrency: options.concurrency ?? 1,
  });
  if (options.limit) {
    const all = await discoverNs(ctx);
    const take = spread(all, options.limit);
    ctx.log(`ns: pohled ${all.length} rozhodnutí, vzorek ${take.length}`);
    await fetchAndStore(ctx, job(take), counts);
    return;
  }
  let start = (await readCursor<{ start?: number }>(ctx.db, "ns"))?.start ?? 1;
  for (;;) {
    if (ctx.shouldStop?.()) return;
    const page = await listNsPage(ctx, start);
    ctx.log(`ns: pohled od ${start}: ${page.entries.length} z ${page.total}`);
    if (page.entries.length === 0) return;
    await fetchAndStore(ctx, job(page.entries), counts);
    if (ctx.shouldStop?.()) return;
    start += page.entries.length;
    await writeCursor(ctx.db, "ns", { start });
    if (page.entries.length < NS_VIEW_PAGE) return;
  }
}

/** Fewer hits than this in a window: the search listed it whole (it addresses 900 at most). */
const NS_SEARCH_WHOLE = 900;

/**
 * `mirror ns-categories`: "Kategorie rozhodnutí" of stored NS decisions from
 * the search result rows, which carry it — the view used to discover them
 * does not. Date windows of `days` (by datum_rozhodnuti), halved while the
 * search might not list one whole. Writes only where the category differs;
 * counts hits that are not stored (a completeness signal).
 */
export async function fillNsCategories(
  ctx: CrawlContext,
  options: { from: string; to: string; days?: number },
  counts: RunCounts,
): Promise<{ unknown: number }> {
  const DAY = 86_400_000;
  // A dropped connection ("terminated", 27. 10.) is retried; a refusal (SourceStopped) is not.
  const searchWithRetry = async (url: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return parseNsSearch(await decodeBody(await pacedFetch(LABEL, ctx.pacer, url, { timeoutMs: 120_000 })));
      } catch (error) {
        if (error instanceof SourceStopped || attempt >= 3) throw error;
        ctx.log(`ns: kategorie — ${error instanceof Error ? error.message : String(error)}, znovu za ${30 * attempt} s`);
        await new Promise((r) => setTimeout(r, 30_000 * attempt));
      }
    }
  };
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  let unknown = 0;
  const window = async (from: number, to: number): Promise<void> => {
    if (ctx.shouldStop?.()) return;
    const query = buildNsQuery({ dateFrom: iso(from), dateTo: iso(to) });
    const page = await searchWithRetry(nsSearchUrl(query, false, 1, 1000));
    const listed = page.matched ?? page.total ?? page.hits.length;
    if ((listed >= NS_SEARCH_WHOLE || page.hits.length < listed) && to > from) {
      const mid = from + Math.floor((to - from) / DAY / 2) * DAY;
      await window(from, mid);
      await window(mid + DAY, to);
      return;
    }
    if (page.hits.length < listed) ctx.log(`ns: ${iso(from)}: vyhledávání vypsalo ${page.hits.length} z ${listed}`);
    const rows = page.hits.filter((h) => h.category);
    const { rows: res } = await ctx.db.query<{ updated: number; known: number }>(
      `WITH x AS (SELECT * FROM unnest($1::text[], $2::text[]) AS x(unid, category)),
            upd AS (UPDATE mirror.decision d SET category = x.category FROM x
                    WHERE d.source = 'ns' AND d.source_id = x.unid AND d.category IS DISTINCT FROM x.category RETURNING 1)
       SELECT (SELECT count(*) FROM upd)::int AS updated,
              (SELECT count(*) FROM mirror.decision d WHERE d.source = 'ns' AND d.source_id = ANY($3::text[]))::int AS known`,
      [rows.map((h) => h.unid.toUpperCase()), rows.map((h) => h.category!), page.hits.map((h) => h.unid.toUpperCase())],
    );
    counts.fetched += page.hits.length;
    counts.changed += res[0].updated;
    unknown += page.hits.length - res[0].known;
    await ctx.progress?.(counts);
  };
  const days = options.days ?? 30;
  const end = Date.parse(options.to);
  for (let t = Date.parse(options.from); t <= end; t += days * DAY) {
    await window(t, Math.min(end, t + (days - 1) * DAY));
    ctx.log(`ns: kategorie do ${iso(Math.min(end, t + (days - 1) * DAY))} — ${counts.fetched} v hledání, ${counts.changed} doplněno, ${unknown} neuložených`);
  }
  return { unknown };
}
