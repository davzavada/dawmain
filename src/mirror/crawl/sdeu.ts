import { cellarChoiceParts } from "@/src/sources/cellar";
import { htmlToText } from "@/src/sources/shared/html";
import { readCursor, writeCursor, type RunCounts } from "../db/store";
import { SourceStopped, pacedFetch } from "../http";
import { SDEU_CELEX_RE, SDEU_PARSER_VERSION, mapSdeu, type SdeuListItem } from "../map/sdeu";
import type { DecisionRecord } from "../types";
import { fetchAndStore, spread, type CrawlContext } from "./workers";

/**
 * SDEU backfill: Cellar's SPARQL endpoint lists the case law of one CELEX
 * year (the year the case was registered; ~2,900 documents for 2019, 7 s)
 * with ECLI, dates and the Czech case identifier and parties; the Czech text
 * comes from /resource/celex/{CELEX} with Accept-Language: ces (HTTP 300 =
 * a multi-part document, its parts fetched and joined; 404/406 = no Czech
 * version). Companion records (_SUM summaries, _INF notices) are left out.
 */

const LABEL = "SDEU (Cellar) – mirror";
const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR = "https://publications.europa.eu/resource";
/** The Court's first cases. */
export const SDEU_FIRST_YEAR = 1954;

/**
 * One CELEX year, one row per (work, value) combination. No SPARQL
 * aggregates: Cellar's endpoint returned MIN(?date) = 2025-05-05 for a
 * judgment of 2020-12-03 (and for unrelated documents), so rows are
 * grouped in parseSdeuYear instead.
 */
export function sdeuYearQuery(year: number, offset = 0): string {
  return sdeuQuery(`FILTER(STRSTARTS(STR(?celex), "6${year}"))`, offset);
}

/** Case law received by the Publications Office on `sinceIso` (YYYY-MM-DD) or later — the daily sync. */
export function sdeuRecentQuery(sinceIso: string, offset = 0): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceIso)) throw new Error(`not a date: ${sinceIso}`);
  return sdeuQuery(
    `FILTER(STRSTARTS(STR(?celex), "6"))
  ?w cdm:work_datetime_transmission ?since .
  FILTER(?since >= "${sinceIso}T00:00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>)`,
    offset,
  );
}

/** These CELEX numbers only (a retry of documents never stored). */
export function sdeuCelexQuery(celexes: string[], offset = 0): string {
  const safe = celexes.filter((c) => SDEU_CELEX_RE.test(c));
  if (safe.length === 0) throw new Error("no valid CELEX");
  return sdeuQuery(`VALUES ?celex { ${safe.map((c) => `"${c}"^^<http://www.w3.org/2001/XMLSchema#string>`).join(" ")} }`, offset);
}

function sdeuQuery(filter: string, offset: number): string {
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?celex ?ecli ?date ?published ?caseCs ?partiesCs WHERE {
  ?w cdm:resource_legal_id_celex ?celex .
  ${filter}
  OPTIONAL { ?w cdm:case-law_ecli ?ecli }
  OPTIONAL { ?w cdm:work_date_document ?date }
  OPTIONAL { ?w cdm:work_datetime_transmission ?published }
  OPTIONAL { ?e cdm:expression_belongs_to_work ?w ;
                cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/CES> .
             OPTIONAL { ?e cdm:expression_case-law_identifier_case ?caseCs }
             OPTIONAL { ?e cdm:expression_case-law_parties ?partiesCs } }
} ORDER BY ?celex ?date ?published ?ecli ?caseCs ?partiesCs LIMIT ${SPARQL_PAGE} OFFSET ${offset}`;
}

/** Rows per SPARQL request: Cellar's endpoint caps a result at 10,000 rows, silently. */
export const SPARQL_PAGE = 5_000;

/** SPARQL JSON rows → one item per case-law CELEX (earliest dates, first values). Pure. */
export function parseSdeuYear(json: unknown): SdeuListItem[] {
  const rows = (json as { results?: { bindings?: Array<Record<string, { value?: string }>> } })?.results?.bindings ?? [];
  const byCelex = new Map<string, SdeuListItem>();
  const earlier = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a < b ? a : b);
  for (const row of rows) {
    const celex = row.celex?.value;
    if (!celex || !SDEU_CELEX_RE.test(celex)) continue;
    const item = byCelex.get(celex) ?? { celex };
    item.ecli ??= row.ecli?.value;
    item.date = earlier(item.date, row.date?.value);
    item.published = earlier(item.published, row.published?.value);
    item.caseCs ??= row.caseCs?.value;
    item.partiesCs ??= row.partiesCs?.value;
    byCelex.set(celex, item);
  }
  return [...byCelex.values()].sort((a, b) => a.celex.localeCompare(b.celex));
}

/** Attempts per SPARQL page; Cellar's endpoint answers 502 now and then (pilot 25. 10.). */
const SPARQL_ATTEMPTS = 3;
const SPARQL_RETRY_MS = 30_000;

async function sparqlPage(ctx: CrawlContext, query: (offset: number) => string, what: string, offset: number): Promise<unknown[]> {
  const url = `${SPARQL}?query=${encodeURIComponent(query(offset))}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await pacedFetch(LABEL, ctx.pacer, url, { headers: { accept: "application/sparql-results+json" }, timeoutMs: 120_000 });
      if (!response.ok) throw new Error(`Cellar SPARQL answered HTTP ${response.status} for ${what}`);
      return ((await response.json()) as { results?: { bindings?: unknown[] } }).results?.bindings ?? [];
    } catch (error) {
      if (error instanceof SourceStopped || attempt >= SPARQL_ATTEMPTS) throw error;
      ctx.log(`sdeu: ${what}: výčet selhal (${error instanceof Error ? error.message : String(error)}), znovu za ${SPARQL_RETRY_MS / 1000} s`);
      await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(SPARQL_RETRY_MS);
    }
  }
}

/** A year's rows page by page (SPARQL_PAGE), grouped once all are in. */
export async function listSdeuYear(ctx: CrawlContext, year: number): Promise<SdeuListItem[]> {
  return listSdeu(ctx, (offset) => sdeuYearQuery(year, offset), `year ${year}`);
}

export async function listSdeu(ctx: CrawlContext, query: (offset: number) => string, what: string): Promise<SdeuListItem[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += SPARQL_PAGE) {
    const page = await sparqlPage(ctx, query, what, offset);
    rows.push(...page);
    if (page.length < SPARQL_PAGE) break;
  }
  return parseSdeuYear({ results: { bindings: rows } });
}

/** The Czech text, or null when Cellar has no Czech version. */
async function czechText(ctx: CrawlContext, celex: string): Promise<string | null> {
  const headers = { accept: "application/xhtml+xml, text/html", "accept-language": "ces" };
  const response = await pacedFetch(LABEL, ctx.pacer, `${CELLAR}/celex/${encodeURIComponent(celex)}`, { headers, timeoutMs: 60_000 });
  if (response.status === 404 || response.status === 406) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.status === 300) {
    // One manifestation's parts, in order, all or nothing (cellarChoiceParts, as fetchCellarDocument).
    const parts = cellarChoiceParts(await response.text());
    if (parts.length === 0) throw new Error(`Cellar listed no parts for ${celex}`);
    const texts: string[] = [];
    for (const part of parts) {
      const r = await pacedFetch(LABEL, ctx.pacer, part, { headers, timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`Cellar answered HTTP ${r.status} for a part of ${celex}`);
      texts.push(htmlToText(await r.text()));
    }
    return texts.filter(Boolean).join("\n\n") || null;
  }
  if (!response.ok) throw new Error(`Cellar answered HTTP ${response.status} for ${celex}`);
  const text = htmlToText(await response.text());
  return text.trim() ? text : null;
}

/**
 * Always asks Cellar: a Czech expression can exist without the case
 * identifier the listing reads from it, so the listing alone cannot say
 * "no Czech version".
 */
export async function fetchSdeuDecision(ctx: CrawlContext, item: SdeuListItem): Promise<DecisionRecord> {
  return mapSdeu(item, await czechText(ctx, item.celex));
}

export interface SdeuBackfillOptions {
  /** Only these CELEX years (pilot); the cursor is left alone. */
  years?: number[];
  limit?: number;
  concurrency?: number;
}

export async function backfillSdeu(ctx: CrawlContext, options: SdeuBackfillOptions, counts: RunCounts): Promise<void> {
  const pilot = options.years !== undefined;
  let years = options.years;
  if (!years) {
    const from = (await readCursor<{ next?: number }>(ctx.db, "sdeu"))?.next ?? SDEU_FIRST_YEAR;
    years = [];
    for (let y = from; y <= new Date().getUTCFullYear(); y++) years.push(y);
  }
  const perYear = options.limit ? Math.ceil(options.limit / years.length) : undefined;
  let left = options.limit ?? Infinity;
  for (const year of years) {
    if (left <= 0 || ctx.shouldStop?.()) break;
    const all = await listSdeuYear(ctx, year);
    const take = perYear ? spread(all, Math.min(perYear, left)) : all;
    ctx.log(`sdeu: ${year}: ${all.length} dokumentů (${all.filter((i) => i.caseCs).length} s českou verzí), stahuji ${take.length}`);
    await fetchAndStore(
      ctx,
      {
        source: "sdeu",
        parserVersion: SDEU_PARSER_VERSION,
        items: take,
        id: (i) => i.celex,
        fetch: (i) => fetchSdeuDecision(ctx, i),
        concurrency: options.concurrency ?? 1,
      },
      counts,
    );
    left -= take.length;
    if (ctx.shouldStop?.()) break;
    if (!pilot && !options.limit) await writeCursor(ctx.db, "sdeu", { next: year + 1 });
  }
}
