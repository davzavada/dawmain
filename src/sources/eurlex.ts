import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { CELLAR_LANGS, fetchCellarText } from "./cellar";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * EUR-Lex — searched through the official Publications Office Cellar SPARQL
 * endpoint (keyless; the machine interface behind EUR-Lex itself). Covers
 * legislation (regulations, directives, decisions) and CJEU case law in one
 * graph. Searches match TITLES + identifiers + dates — Cellar exposes no
 * full-text index of document bodies over SPARQL; for full-text CJEU search
 * use curia_search. Texts come from Cellar by CELEX/ECLI.
 *
 * Virtuoso quirks handled (documented by production clients): errors arrive
 * as HTTP 200 with an error text or an HTML page; duplicate rows per work.
 */

const SOURCE = "EUR-Lex (Cellar)";
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CDM = "http://publications.europa.eu/ontology/cdm#";
const AUTHORITY = "http://publications.europa.eu/resource/authority";

export const EURLEX_TYPES: Record<string, string> = {
  regulation: "REG",
  directive: "DIR",
  decision: "DEC",
  judgment: "JUDG",
  order: "ORDER",
  ag_opinion: "OPIN_AG",
};

export interface EurlexSearchInput {
  query?: string;
  celex?: string;
  ecli?: string;
  types?: string[];
  dateFrom?: string;
  dateTo?: string;
  language?: string;
}

/** Keyword sanitizer: Virtuoso bif:contains gets quoted terms joined by AND. */
export function buildContainsExpression(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^0-9A-Za-zÀ-žƀ-ɏ*-]/gu, ""))
    .filter((term) => term.length >= 2 && /[0-9A-Za-zÀ-žƀ-ɏ]/u.test(term))
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((term) => `'${term}'`).join(" AND ");
}

/** Build the SELECT query. Pure — unit-tested. */
export function buildEurlexSparql(input: EurlexSearchInput, limit: number, offset: number): string {
  const language = (CELLAR_LANGS[(input.language ?? "en").toLowerCase()] ?? "eng").toUpperCase();
  const clauses: string[] = [
    `?work cdm:resource_legal_id_celex ?celex .`,
    `?work cdm:work_date_document ?date .`,
    `?work cdm:work_has_resource-type ?type .`,
    `OPTIONAL { ?work cdm:case-law_ecli ?ecli . }`,
    `?expr cdm:expression_belongs_to_work ?work ;`,
    `      cdm:expression_uses_language <${AUTHORITY}/language/${language}> ;`,
    `      cdm:expression_title ?title .`,
  ];

  if (input.query) {
    const contains = buildContainsExpression(input.query);
    if (!contains) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        "The query contains no usable keywords.",
        "Use at least one word of 2+ letters; operators and punctuation are stripped.",
      );
    }
    clauses.push(`?title bif:contains "${contains}" .`);
  }
  if (input.celex) {
    clauses.push(`FILTER(STR(?celex) = "${input.celex.replace(/["\\]/g, "")}")`);
  }
  if (input.ecli) {
    clauses.push(`FILTER(STR(?ecli) = "${input.ecli.replace(/["\\]/g, "")}")`);
  }
  if (input.types?.length) {
    const uris = input.types
      .map((type) => EURLEX_TYPES[type])
      .filter(Boolean)
      .map((code) => `<${AUTHORITY}/resource-type/${code}>`);
    if (uris.length) clauses.push(`FILTER(?type IN (${uris.join(", ")}))`);
  }
  if (input.dateFrom) clauses.push(`FILTER(?date >= "${input.dateFrom}"^^xsd:date)`);
  if (input.dateTo) clauses.push(`FILTER(?date <= "${input.dateTo}"^^xsd:date)`);

  return [
    `PREFIX cdm: <${CDM}>`,
    `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`,
    `SELECT DISTINCT ?celex ?date ?title ?ecli ?type WHERE {`,
    ...clauses.map((clause) => `  ${clause}`),
    `}`,
    `ORDER BY DESC(?date)`,
    `LIMIT ${limit} OFFSET ${offset}`,
  ].join("\n");
}

export interface EurlexHit {
  celex: string;
  title: string;
  date?: string;
  ecli?: string;
  type?: string;
  url: string;
}

/** Parse SPARQL JSON results; dedupe (Cellar yields duplicate rows). Pure. */
export function parseEurlexResults(json: unknown): EurlexHit[] {
  const bindings = (
    json as { results?: { bindings?: Array<Record<string, { value?: string }>> } }
  ).results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Cellar SPARQL response has no results.bindings.",
      "The endpoint may be rate-limiting (it then returns HTML) — wait a minute and retry.",
    );
  }
  const seen = new Set<string>();
  const hits: EurlexHit[] = [];
  for (const binding of bindings) {
    const celex = binding.celex?.value ?? "";
    if (!celex) continue;
    const key = binding.ecli?.value || celex;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      celex,
      title: binding.title?.value ?? "",
      date: binding.date?.value,
      ecli: binding.ecli?.value,
      type: binding.type?.value?.split("/").pop(),
      url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`,
    });
  }
  return hits;
}

const VIRTUOSO_ERROR_RE = /Virtuoso\s+\S*\s*Error|SP031|query execution timed out/i;

const searchCache = new TtlCache<EurlexHit[]>(SEARCH_TTL_MS);

export async function searchEurlex(
  input: EurlexSearchInput,
  limit: number,
  offset: number,
): Promise<EurlexHit[]> {
  return searchCache.through(memoKey("eurlex-search", [input, limit, offset]), () =>
    runSearchEurlex(input, limit, offset),
  );
}

async function runSearchEurlex(
  input: EurlexSearchInput,
  limit: number,
  offset: number,
): Promise<EurlexHit[]> {
  if (!input.query && !input.celex && !input.ecli) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "EUR-Lex search needs at least one criterion.",
      "Provide query (title keywords), celex, or ecli — optionally narrowed by types and dates.",
    );
  }
  const sparql = buildEurlexSparql(input, limit, offset);
  const body = new URLSearchParams({ query: sparql, format: "application/sparql-results+json" });
  const response = await fetchUpstream(SOURCE, SPARQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/sparql-results+json",
    },
    body: body.toString(),
    timeoutMs: 30_000,
    retry: true,
  });
  const text = await response.text();
  if (!response.ok || VIRTUOSO_ERROR_RE.test(text)) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `Cellar SPARQL rejected the query (HTTP ${response.status}).`,
      "Simplify the keywords or narrow the date range; the endpoint times out on broad queries (~100 s server limit) and rate-limits bursts.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      "Cellar SPARQL returned non-JSON (typically an HTML rate-limit page).",
      "Wait a minute and retry.",
    );
  }
  return parseEurlexResults(json);
}

export async function getEurlexDocument(options: {
  celex?: string;
  ecli?: string;
  language?: string;
}): Promise<{ text: string; url: string }> {
  const language = options.language ?? "en";
  if (options.celex) {
    const text = await fetchCellarText(SOURCE, `/celex/${encodeURIComponent(options.celex)}`, language);
    if (text) {
      return { text, url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${options.celex}` };
    }
  }
  if (options.ecli) {
    const text = await fetchCellarText(SOURCE, `/ecli/${encodeURIComponent(options.ecli)}`, language);
    if (text) return { text, url: `https://publications.europa.eu/resource/ecli/${options.ecli}` };
  }
  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    "Cellar has no retrievable text for the given identifiers.",
    "Check the CELEX (e.g. 32016R0679 for GDPR, 62018CJ0311 for a judgment) or ECLI; some documents exist only in selected languages — try 'en' or 'fr'.",
  );
}
