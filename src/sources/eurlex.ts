import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { CELLAR_LANGS, fetchCellarText } from "./cellar";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * EUR-Lex — searched through the official Publications Office Cellar SPARQL
 * endpoint (keyless; the machine interface behind EUR-Lex itself). Covers
 * legislation (regulations, directives, decisions), CJEU case law and
 * legislative materials (sector-5 preparatory documents) in one graph.
 * Searches match TITLES + identifiers + dates — Cellar exposes no
 * full-text index of document bodies over SPARQL; for full-text CJEU search
 * use curia_search. Texts come from Cellar by CELEX/ECLI.
 *
 * Legislative history rides on the CDM dossier model (verified live against
 * the endpoint): a cdm:dossier is the interinstitutional procedure —
 * cdm:dossier_contains_work links it to EVERY document of the procedure,
 * the adopted act included, so one query resolves the whole travaux
 * préparatoires from any member's CELEX. The dossier itself carries the
 * procedure reference (2012/0011/COD), titles in all languages, legal basis
 * and adopted/pending/withdrawn state.
 *
 * Virtuoso quirks handled (documented by production clients): errors arrive
 * as HTTP 200 with an error text or an HTML page; duplicate rows per work.
 */

const SOURCE = "EUR-Lex (Cellar)";
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CDM = "http://publications.europa.eu/ontology/cdm#";
const AUTHORITY = "http://publications.europa.eu/resource/authority";

/** Tool-facing type → Cellar resource-type authority codes (all verified
 * against live data; unknown codes in an IN() filter simply match nothing). */
export const EURLEX_TYPES: Record<string, string[]> = {
  regulation: ["REG"],
  directive: ["DIR"],
  decision: ["DEC"],
  judgment: ["JUDG"],
  order: ["ORDER"],
  ag_opinion: ["OPIN_AG"],
  // Legislative materials (CELEX sector 5 — travaux préparatoires):
  proposal: ["PROP_REG", "PROP_DIR", "PROP_DEC", "PROP_ACT", "AMEND_PROP_REG", "AMEND_PROP_DIR", "AMEND_PROP_DEC"],
  communication: ["COMMUNIC", "JOINT_COMMUNIC", "COMMUNIC_POSIT"],
  green_paper: ["PAPER_GREEN"],
  white_paper: ["PAPER_WHITE"],
  staff_working_document: ["SWD", "JOINT_SWD", "WORK_DOC"],
  impact_assessment: ["IMPACT_ASSESS", "IMPACT_ASSESS_SUM", "IMPACT_ASSESS_INCEP"],
  opinion: ["OPIN", "OPIN_EESC", "OPIN_COR", "OWNINI_OPIN", "OWNINI_OPIN_EESC", "OWNINI_OPIN_COR"],
  ep_position: ["RES_LEGIS"],
  council_position: ["POSIT", "STAT_REASON"],
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
      .flatMap((type) => EURLEX_TYPES[type] ?? [])
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
  return parseEurlexResults(await runSparql(buildEurlexSparql(input, limit, offset)));
}

/** POST a SELECT to the Cellar endpoint. One home for the Virtuoso error
 * lore, shared by the search and legislative-history queries. */
async function runSparql(sparql: string): Promise<unknown> {
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
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      "Cellar SPARQL returned non-JSON (typically an HTML rate-limit page).",
      "Wait a minute and retry.",
    );
  }
}

// --- Legislative history (travaux préparatoires) --------------------------

export interface LegislativeHistoryInput {
  celex?: string;
  procedure?: string;
  language?: string;
}

export interface LegislativeDossierDocument {
  celex?: string;
  type?: string;
  date?: string;
  title?: string;
  url: string;
}

export interface LegislativeDossier {
  procedure?: string;
  procedure_type?: string;
  legal_basis?: string;
  status: "adopted" | "pending" | "withdrawn" | "unknown";
  date_adopted?: string;
  title?: string;
  url?: string;
  documents: LegislativeDossierDocument[];
}

export interface LegislativeHistoryResult {
  dossiers: LegislativeDossier[];
  /** The row cap was hit — with ORDER BY date ascending the NEWEST rows are
   * the ones dropped, so an outsized dossier must not render as complete. */
  truncated: boolean;
}

/** "2012/0011(COD)", "2012/11 COD", "2012_11_COD" → "2012/0011/COD" (the
 * form Cellar stores). EUR-Lex displays split procedures with a letter
 * suffix — "2016/0062A(NLE)" — that Cellar's stored reference omits
 * (verified live: it holds "2016/0062/NLE"), so the suffix is accepted and
 * dropped. Without the code the year+number still anchor via a prefix
 * match. Returns null for unparseable input. Pure — unit-tested. */
export function normalizeProcedureReference(
  input: string,
): { exact?: string; prefix?: string } | null {
  const m = /^\s*(\d{4})\s*[/_.\s-]\s*(\d{1,4})[A-Za-z]?\s*(?:[/_.\s(-]+([A-Za-z]{2,4}))?\)?\s*$/.exec(input);
  if (!m) return null;
  const base = `${m[1]}/${m[2].padStart(4, "0")}`;
  return m[3] ? { exact: `${base}/${m[3].toUpperCase()}` } : { prefix: `${base}/` };
}

/** Rows are dossier × member; the parser regroups them. A GDPR-sized dossier
 * is ~50 members with at most a few duplicate rows each, so 500 covers even
 * outsized procedures with a wide margin. */
const HISTORY_ROW_CAP = 500;

/** Build the dossier query. Pure — unit-tested. */
export function buildLegislativeHistorySparql(input: LegislativeHistoryInput): string {
  const language = (input.language ?? "en").toLowerCase();
  const lang3 = (CELLAR_LANGS[language] ?? "eng").toUpperCase();
  // Dossier titles carry 2-letter language tags; expressions use authority
  // URIs. English doubles as the fallback, fetched alongside unless it IS
  // the requested language.
  const lang2 = lang3 === "ENG" ? "en" : language;
  const withEnglishFallback = lang3 !== "ENG";

  const anchor: string[] = [];
  if (input.celex) {
    const celex = input.celex.replace(/["\\]/g, "").trim();
    anchor.push(
      `?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .`,
      `?dossier cdm:dossier_contains_work ?work .`,
    );
  } else if (input.procedure) {
    const ref = normalizeProcedureReference(input.procedure.replace(/["\\]/g, ""));
    if (!ref) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `"${input.procedure}" is not an interinstitutional procedure reference.`,
        `Use the year/number/code form, e.g. "2012/0011(COD)" or "2012/0011/COD".`,
      );
    }
    anchor.push(
      ref.exact
        ? `?dossier cdm:procedure_code_interinstitutional_reference_procedure "${ref.exact}"^^xsd:string .`
        : `?dossier cdm:procedure_code_interinstitutional_reference_procedure ?procRef .`,
    );
    if (ref.prefix) anchor.push(`FILTER(STRSTARTS(STR(?procRef), "${ref.prefix}"))`);
  } else {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "Legislative history needs a celex or a procedure reference.",
      "Pass the CELEX of the adopted act or of any procedure document (e.g. 32016R0679 or 52012PC0011), or a procedure like '2012/0011(COD)'.",
    );
  }

  const vars = [
    "?dossier ?identifier ?procedure ?procType ?basis ?adopted ?pending ?withdrawn ?dateAdopted ?dossierTitle",
    withEnglishFallback ? "?dossierTitleEn" : "",
    "?member ?celex ?date ?type ?title",
    withEnglishFallback ? "?titleEn" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const clauses = [
    ...anchor,
    `?dossier cdm:dossier_contains_work ?member .`,
    `OPTIONAL { ?dossier cdm:dossier_identifier ?identifier . FILTER(STRSTARTS(STR(?identifier), "procedure:")) }`,
    `OPTIONAL { ?dossier cdm:procedure_code_interinstitutional_reference_procedure ?procedure . }`,
    `OPTIONAL { ?dossier cdm:procedure_code_interinstitutional_has_type_concept_type_procedure_code_interinstitutional ?procType . }`,
    `OPTIONAL { ?dossier cdm:procedure_code_interinstitutional_basis_legal ?basis . }`,
    `OPTIONAL { ?dossier cdm:dossier_adopted-proposal ?adopted . }`,
    `OPTIONAL { ?dossier cdm:dossier_pending-proposal ?pending . }`,
    `OPTIONAL { ?dossier cdm:dossier_withdrawn-proposal ?withdrawn . }`,
    `OPTIONAL { ?dossier cdm:dossier_date_adopted ?dateAdopted . }`,
    `OPTIONAL { ?dossier cdm:dossier_title ?dossierTitle . FILTER(LCASE(LANG(?dossierTitle)) = "${lang2}") }`,
    ...(withEnglishFallback
      ? [`OPTIONAL { ?dossier cdm:dossier_title ?dossierTitleEn . FILTER(LCASE(LANG(?dossierTitleEn)) = "en") }`]
      : []),
    `OPTIONAL { ?member cdm:resource_legal_id_celex ?celex . }`,
    `OPTIONAL { ?member cdm:work_date_document ?date . }`,
    `OPTIONAL { ?member cdm:work_has_resource-type ?type . }`,
    `OPTIONAL { ?expr cdm:expression_belongs_to_work ?member ; cdm:expression_uses_language <${AUTHORITY}/language/${lang3}> ; cdm:expression_title ?title . }`,
    ...(withEnglishFallback
      ? [
          `OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?member ; cdm:expression_uses_language <${AUTHORITY}/language/ENG> ; cdm:expression_title ?titleEn . }`,
        ]
      : []),
  ];

  return [
    `PREFIX cdm: <${CDM}>`,
    `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`,
    `SELECT DISTINCT ${vars} WHERE {`,
    ...clauses.map((clause) => `  ${clause}`),
    `}`,
    `ORDER BY ?date`,
    `LIMIT ${HISTORY_ROW_CAP}`,
  ].join("\n");
}

type SparqlRow = Record<string, { value?: string } | undefined>;

const flagSet = (binding?: { value?: string }) =>
  binding?.value === "1" || binding?.value === "true";

/** Regroup dossier × member rows into dossiers. Pure — unit-tested. */
export function parseLegislativeHistoryResults(json: unknown): LegislativeHistoryResult {
  const bindings = (json as { results?: { bindings?: SparqlRow[] } }).results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Cellar SPARQL response has no results.bindings.",
      "The endpoint may be rate-limiting (it then returns HTML) — wait a minute and retry.",
    );
  }

  interface DossierAccumulator {
    dossier: LegislativeDossier;
    members: Map<string, LegislativeDossierDocument>;
  }
  const dossiers = new Map<string, DossierAccumulator>();

  for (const row of bindings) {
    const dossierUri = row.dossier?.value;
    if (!dossierUri) continue;
    let acc = dossiers.get(dossierUri);
    if (!acc) {
      acc = { dossier: { status: "unknown", documents: [] }, members: new Map() };
      dossiers.set(dossierUri, acc);
    }
    const { dossier } = acc;
    dossier.procedure ??= row.procedure?.value;
    dossier.procedure_type ??= row.procType?.value?.split("/").pop();
    dossier.legal_basis ??= row.basis?.value;
    dossier.date_adopted ??= row.dateAdopted?.value;
    dossier.title ??= row.dossierTitle?.value ?? row.dossierTitleEn?.value;
    const procedureId = row.identifier?.value?.replace(/^procedure:/, "");
    if (procedureId && !dossier.url) {
      dossier.url = `https://eur-lex.europa.eu/procedure/EN/${procedureId}`;
    }
    if (dossier.status === "unknown") {
      if (flagSet(row.adopted)) dossier.status = "adopted";
      else if (flagSet(row.withdrawn)) dossier.status = "withdrawn";
      else if (flagSet(row.pending)) dossier.status = "pending";
    }

    const memberUri = row.member?.value;
    if (!memberUri) continue;
    const member = acc.members.get(memberUri) ?? { url: memberUri };
    member.celex ??= row.celex?.value;
    member.type ??= row.type?.value?.split("/").pop();
    member.date ??= row.date?.value;
    member.title ??= row.title?.value ?? row.titleEn?.value;
    acc.members.set(memberUri, member);
  }

  const grouped = [...dossiers.values()].map(({ dossier, members }) => {
    const documents = [...members.values()]
      // Bare rows (an OJ edition or a Council addendum with no CELEX, type
      // or title) would render as "unknown document" noise — the citable
      // form of the same document is in the dossier under its own URI.
      .filter((member) => member.celex || member.type || member.title)
      .map((member) => ({
        ...member,
        url: member.celex
          ? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${member.celex}`
          : member.url,
      }))
      .sort(
        (a, b) =>
          (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
          (a.celex ?? a.url).localeCompare(b.celex ?? b.url),
      );
    return { ...dossier, documents };
  });
  return { dossiers: grouped, truncated: bindings.length >= HISTORY_ROW_CAP };
}

const historyCache = new TtlCache<LegislativeHistoryResult>(SEARCH_TTL_MS);

export async function getLegislativeHistory(
  input: LegislativeHistoryInput,
): Promise<LegislativeHistoryResult> {
  return historyCache.through(memoKey("eurlex-history", [input]), async () =>
    parseLegislativeHistoryResults(await runSparql(buildLegislativeHistorySparql(input))),
  );
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
    "Check the CELEX (e.g. 32016R0679 for GDPR, 62018CJ0311 for a judgment, 52012PC0011 for a legislative proposal) or ECLI; some documents exist only in selected languages — try 'en' or 'fr'.",
  );
}
