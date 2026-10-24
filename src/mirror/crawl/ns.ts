import { decodeBody } from "@/src/sources/shared/html";
import { nsBodyMissing } from "@/src/sources/ns";
import { readCursor, writeCursor, type RunCounts } from "../db/store";
import { pacedFetch } from "../http";
import { NS_PARSER_VERSION, mapNs, markNsPictures, parseNsMarked } from "../map/ns";
import type { DecisionImage, DecisionRecord } from "../types";
import { fetchAndStore, spread, type CrawlContext } from "./workers";

/**
 * NS backfill (v1-plan, zdroj 2). Discover: the Domino view behind the
 * search lists every document, `WebSearch?ReadViewEntries&OutputFormat=JSON`
 * — UNID and case number, up to 3,000 a request (165,460 on 24. 10. 2026),
 * ordered by UNID. Fetch: WebPrint/{UNID}, WebSearch/{UNID} when WebPrint
 * has no body (nsBodyMissing; the longer text wins, as getNsDecision does),
 * then the decision's own pictures (the state emblem…) one by one.
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

async function fetchRendition(ctx: CrawlContext, unid: string, rendition: "WebPrint" | "WebSearch") {
  const response = await pacedFetch(LABEL, ctx.pacer, `${DB}/${rendition}/${unid}?openDocument`);
  if (response.status === 404) throw new Error(`NS has no document ${unid} (404)`);
  if (!response.ok) throw new Error(`NS answered HTTP ${response.status} for ${rendition}/${unid}`);
  const { html, pictures } = markNsPictures(await decodeBody(response));
  return { ...parseNsMarked(html, unid, pictures.length), pictures };
}

export async function fetchNsDecision(ctx: CrawlContext, entry: NsEntry): Promise<DecisionRecord> {
  let page = await fetchRendition(ctx, entry.unid, "WebPrint");
  let textSource: "ns:webprint" | "ns:websearch" = "ns:webprint";
  if (nsBodyMissing(page.decision.text)) {
    const other = await fetchRendition(ctx, entry.unid, "WebSearch");
    if (other.decision.text.length > page.decision.text.length) {
      page = { ...other, decision: { ...other.decision, metadata: { ...other.decision.metadata, ...page.decision.metadata } } };
      textSource = "ns:websearch";
    }
  }
  const images: DecisionImage[] = [];
  for (const [i, pic] of page.pictures.entries()) {
    const response = await pacedFetch(LABEL, ctx.pacer, pic.url);
    if (!response.ok) throw new Error(`NS picture ${i} answered HTTP ${response.status}`);
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mime = type === "image/png" || type === "image/jpeg" || type === "image/gif" ? type : null;
    if (!mime) throw new Error(`NS picture ${i} is ${type || "untyped"}, not an image`);
    images.push({
      charAt: page.offsets[i] ?? 0,
      mime,
      width: pic.width,
      height: pic.height,
      bytes: new Uint8Array(await response.arrayBuffer()),
      sourceUrl: pic.url,
    });
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
