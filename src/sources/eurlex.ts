import { SourceError } from "./shared/errors";
import { recordSourceResult } from "./shared/health";
import {
  budgetSpent,
  cellarDeadline,
  fetchCellarDocument,
  fetchWithinDeadline,
  hasBudget,
  isTimeoutError,
  normalizeCelex,
  normalizeEcli,
  requireCellarLanguage,
} from "./cellar";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * EUR-Lex — searched through the official Publications Office Cellar SPARQL
 * endpoint (keyless; the machine interface behind EUR-Lex itself). Covers
 * legislation (regulations, directives, decisions), CJEU case law and
 * legislative materials (sector-5 preparatory documents) in one graph.
 * Searches match TITLES + identifiers + dates — Cellar exposes no
 * full-text index of document bodies over SPARQL; for full-text CJEU search
 * use sdeu_search. Texts come from Cellar by CELEX/ECLI.
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
 * as HTTP 200 with an error text or an HTML page, and — measured live
 * 2026-09 — as HTTP 500 for a query it refuses (a wildcard on a short stem);
 * several rows per work (types, titles, ECLIs), so the search groups by work.
 */

const SOURCE = "EUR-Lex (Cellar)";
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CDM = "http://publications.europa.eu/ontology/cdm#";
const AUTHORITY = "http://publications.europa.eu/resource/authority";

/** Tool-facing type → Cellar resource-type authority codes (unknown codes in
 * an IN() filter simply match nothing). Commission implementing and
 * delegated acts carry their own codes — seen live 2026-09: REG_IMPL,
 * REG_DEL, DIR_DEL, DEC_IMPL (adequacy decisions), DEC_FRAMW (JHA framework
 * decisions); DIR_IMPL, DEC_DEL, DEC_ENTSCHEID and REG_FINANC complete the
 * authority table. With the bare REG/DIR/DEC, types ['regulation'] silently
 * dropped most recent regulations and decisions. */
export const EURLEX_TYPES: Record<string, string[]> = {
  regulation: ["REG", "REG_IMPL", "REG_DEL", "REG_FINANC"],
  directive: ["DIR", "DIR_IMPL", "DIR_DEL"],
  decision: ["DEC", "DEC_IMPL", "DEC_DEL", "DEC_ENTSCHEID", "DEC_FRAMW"],
  implementing_act: ["REG_IMPL", "DIR_IMPL", "DEC_IMPL"],
  delegated_act: ["REG_DEL", "DIR_DEL", "DEC_DEL"],
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

/** Virtuoso refuses a wildcard word with fewer leading characters — and
 * refuses the whole query, as HTTP 500 (live 2026-09: 'da*', 'dat*' → 500;
 * 'protect*' fine). */
const WILDCARD_MIN_STEM = 4;

/** Keyword sanitizer: Virtuoso bif:contains gets quoted terms joined by AND.
 * Every character outside the word class SEPARATES words, as in Virtuoso's
 * own title index ('2016/679' is indexed as '2016' '679'): deleting it
 * instead glued act and case numbers into '2016679' or 'C-31118', which no
 * title contains. Quotes and backslashes never survive into a term, so the
 * literal stays injection-safe. NFC first, or decomposed input would lose
 * its diacritics with the combining marks. Pure — unit-tested. */
export function buildContainsExpression(query: string): string | null {
  const terms = query
    .normalize("NFC")
    .split(/[^0-9A-Za-zÀ-žƀ-ɏ*-]+/u)
    // An inner '*' separates too; only a trailing one is a wildcard.
    .flatMap((token) => token.split(/\*+(?=[^*])/u))
    .map((token) => {
      const wildcard = token.endsWith("*");
      const word = token.replace(/^[-*]+/u, "").replace(/[-*]+$/u, "");
      // The stem Virtuoso counts is the last hyphen-separated word ('C-311*' → '311').
      const stem = word.split("-").pop() ?? "";
      return wildcard && stem.length >= WILDCARD_MIN_STEM ? `${word}*` : word;
    })
    .filter((term) => term.length >= 2 && /[0-9A-Za-zÀ-žƀ-ɏ]/u.test(term))
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((term) => `'${term}'`).join(" AND ");
}

/** A real calendar day: the schema checks only the shape, and Virtuoso
 * compares against "2024-02-30"^^xsd:date as false without an error — the
 * search then answered "no documents matched" for a typo in the date. */
function calendarDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const day = new Date(`${value}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(+day) && day.toISOString().startsWith(value)) {
    return value;
  }
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `${field} "${value}" is not a real calendar date.`,
    "Use an existing day as YYYY-MM-DD (the last day of February 2024 is 2024-02-29).",
  );
}

/** Strip what could close the SPARQL string literal. */
const literal = (value: string) => value.replace(/["\\]/g, "");

/** Build the SELECT query. Validates and normalises the input (language,
 * identifiers, dates) — equal requests build the same text, which is also
 * the cache key. One row per WORK (GROUP BY ?celex): LIMIT/OFFSET used to
 * page raw rows that were deduplicated afterwards, so a page came back short,
 * a work straddling the boundary showed on two pages and "a full page means
 * more" failed. One row beyond the page tells whether more exist. ?celex
 * breaks date ties, so pages are deterministic and a judgment (62024CJ0474)
 * lists before its _RES/_SUM siblings. The date is a GROUP BY key, not
 * MAX(?date): live (2026-10) Virtuoso handed every group of a title search
 * the newest date of the whole result — Planet49 (2019) came back dated
 * 2026-09-03, "newest first" was arbitrary and the GDPR itself fell off the
 * page of 'Regulation 2016/679'. A work has one work_date_document; were
 * there two, hitsOf keeps its first (newest) row. Pure — unit-tested. */
export function buildEurlexSparql(input: EurlexSearchInput, limit: number, offset: number): string {
  const language = requireCellarLanguage(SOURCE, input.language ?? "en").iso3.toUpperCase();
  const celex = input.celex ? literal(normalizeCelex(input.celex)) : "";
  const ecli = input.ecli ? literal(normalizeEcli(input.ecli)) : "";
  const query = input.query?.trim() ?? "";
  if (!query && !celex && !ecli) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "EUR-Lex search needs at least one criterion.",
      "Provide query (title keywords), celex, or ecli — optionally narrowed by types and dates.",
    );
  }
  const dateFrom = calendarDate(input.dateFrom, "date_from");
  const dateTo = calendarDate(input.dateTo, "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `date_from ${dateFrom} is after date_to ${dateTo}.`,
      "The range is inverted — swap the two dates.",
    );
  }

  const titleIn = (lang: string, expr: string, title: string) =>
    `?${expr} cdm:expression_belongs_to_work ?work ; cdm:expression_uses_language <${AUTHORITY}/language/${lang}> ; cdm:expression_title ?${title} .`;
  const clauses: string[] = [
    `?work cdm:resource_legal_id_celex ?celex .`,
    `?work cdm:work_date_document ?date .`,
    `?work cdm:work_has_resource-type ?type .`,
    ecli ? `?work cdm:case-law_ecli ?ecli .` : `OPTIONAL { ?work cdm:case-law_ecli ?ecli . }`,
    // The identifiers next to the triples they bind, ahead of the title
    // OPTIONALs: the lookup narrows to its one work before any title joins.
    ...(celex ? [`FILTER(STR(?celex) = "${celex}")`] : []),
    ...(ecli ? [`FILTER(STR(?ecli) = "${ecli}")`] : []),
  ];
  // The matched title, or for an identifier lookup its fallback chain —
  // taken inside the aggregate rather than by a BIND in the pattern, which
  // would wrap the pattern before the group's filters can narrow it.
  let titleExpression = "?title";

  if (query) {
    const contains = buildContainsExpression(query);
    if (!contains) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        "The query contains no usable keywords.",
        "Use at least one word of 2+ letters; operators and punctuation are stripped.",
      );
    }
    // The title search needs the title in the requested language.
    clauses.push(titleIn(language, "expr", "title"), `?title bif:contains "${contains}" .`);
  } else {
    // An identifier lookup asks "which document is this", not "has it a
    // title in cs": a General Court order in the language of the case and
    // French only, or a pre-accession act (31983R1983 has no Czech version),
    // used to answer "no documents matched". The title falls back to English,
    // then to any language (one work — the fan-out is grouped away).
    clauses.push(
      `OPTIONAL { ${titleIn(language, "expr", "titleLang")} }`,
      ...(language !== "ENG" ? [`OPTIONAL { ${titleIn("ENG", "exprEn", "titleEn")} }`] : []),
      `OPTIONAL { ?exprAny cdm:expression_belongs_to_work ?work ; cdm:expression_title ?titleAny . }`,
    );
    titleExpression = `COALESCE(?titleLang, ${language !== "ENG" ? "?titleEn, " : ""}?titleAny)`;
  }
  if (input.types?.length) {
    const codes = new Set(
      input.types.flatMap((type) => (Object.hasOwn(EURLEX_TYPES, type) ? EURLEX_TYPES[type] : [])),
    );
    const uris = [...codes].map((code) => `<${AUTHORITY}/resource-type/${code}>`);
    if (uris.length) clauses.push(`FILTER(?type IN (${uris.join(", ")}))`);
  }
  if (dateFrom) clauses.push(`FILTER(?date >= "${dateFrom}"^^xsd:date)`);
  if (dateTo) clauses.push(`FILTER(?date <= "${dateTo}"^^xsd:date)`);

  return [
    `PREFIX cdm: <${CDM}>`,
    `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`,
    `SELECT ?celex (?date AS ?d) (SAMPLE(${titleExpression}) AS ?t) (SAMPLE(?ecli) AS ?e) (SAMPLE(?type) AS ?ty) WHERE {`,
    ...clauses.map((clause) => `  ${clause}`),
    `}`,
    `GROUP BY ?celex ?date`,
    `ORDER BY DESC(?d) ?celex`,
    `LIMIT ${limit + 1} OFFSET ${offset}`,
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

export interface EurlexSearchPage {
  hits: EurlexHit[];
  /** Cellar holds more works past this page (the query asked one row beyond it). */
  hasMore: boolean;
}

type SparqlBindings = Array<Record<string, { value?: string } | undefined>>;

function bindingsOf(json: unknown): SparqlBindings {
  const bindings = (json as { results?: { bindings?: SparqlBindings } }).results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Cellar SPARQL response has no results.bindings.",
      "The endpoint may be rate-limiting (it then returns HTML) — wait a minute and retry.",
    );
  }
  return bindings;
}

function hitsOf(bindings: SparqlBindings): EurlexHit[] {
  const seen = new Set<string>();
  const hits: EurlexHit[] = [];
  for (const binding of bindings) {
    const celex = binding.celex?.value ?? "";
    // One CELEX is one work. Keyed on the ECLI instead, a judgment and its
    // case-law abstract (62024CJ0474 and 62024CJ0474_RES share it) collapsed
    // into whichever row came first — live, often the abstract, so the
    // judgment itself vanished from the list.
    if (!celex || seen.has(celex)) continue;
    seen.add(celex);
    const date = binding.d?.value ?? binding.date?.value;
    const ecli = binding.e?.value ?? binding.ecli?.value;
    const type = (binding.ty?.value ?? binding.type?.value)?.split("/").pop();
    hits.push({
      celex,
      title: binding.t?.value ?? binding.title?.value ?? "",
      ...(date ? { date } : {}),
      ...(ecli ? { ecli } : {}),
      ...(type ? { type } : {}),
      url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`,
    });
  }
  return hits;
}

/** Parse SPARQL JSON results (grouped ?d/?t/?e/?ty or plain columns); one
 * hit per CELEX — a safety net under the GROUP BY. Pure. */
export function parseEurlexResults(json: unknown): EurlexHit[] {
  return hitsOf(bindingsOf(json));
}

/** A page of `limit` hits from a query that asked limit + 1 rows. Pure. */
export function parseEurlexPage(json: unknown, limit: number): EurlexSearchPage {
  const bindings = bindingsOf(json);
  return { hits: hitsOf(bindings.slice(0, limit)), hasMore: bindings.length > limit };
}

const searchCache = new TtlCache<EurlexSearchPage>(SEARCH_TTL_MS);

export async function searchEurlex(
  input: EurlexSearchInput,
  limit: number,
  offset: number,
  options: { deadline?: number } = {},
): Promise<EurlexSearchPage> {
  // Keyed on the query built, not the raw input: 'cs' and 'cz', 'CELEX:32016r0679'
  // and '32016R0679', 'data, protection' and 'data protection' send the same
  // SPARQL. An input error throws here, before the cache is touched.
  const sparql = buildEurlexSparql(input, limit, offset);
  const deadline = options.deadline ?? cellarDeadline();
  return searchCache.through(memoKey("eurlex-search", sparql), async () =>
    parseEurlexPage(await runSparql(sparql, deadline), limit),
  );
}

const VIRTUOSO_ERROR_RE = /Virtuoso\s+\S*\s*Error|SP031|query execution timed out/i;
/** Virtuoso gave up on the run time: estimated or actual. */
const VIRTUOSO_TIMEOUT_RE = /S1T00|SR171|timed out|exceeds the limit|estimated execution time/i;
/** Virtuoso refused the query text itself: SPARQL compiler, free-text expression. */
const VIRTUOSO_QUERY_RE = /\b(?:SP\d{3}|FT\d{3}|XM\d{3})\b|SPARQL compiler|free-text|wildcard/i;

/** Slow-query advice — the endpoint is slow on broad title terms, not down. */
const NARROW_HINT =
  "Simplify the keywords or narrow the date range or types; the endpoint times out on broad title queries (a few common words over all years) and rate-limits bursts. Identifier lookups (celex, ecli) stay fast.";

/**
 * The error a Virtuoso answer carries, or null for a usable one. Its body
 * names the cause: a query it refuses is the caller's to rephrase (and says
 * nothing about the endpoint's health); a run-time limit calls for a narrower
 * query. Pure — unit-tested.
 */
export function virtuosoFailure(status: number, text: string): SourceError | null {
  const flagged = VIRTUOSO_ERROR_RE.test(text);
  if (status >= 200 && status < 300 && !flagged) return null;
  if (flagged && VIRTUOSO_TIMEOUT_RE.test(text)) {
    return new SourceError(SOURCE, "UPSTREAM_ERROR", "Cellar SPARQL gave up on the query: it runs too long.", NARROW_HINT);
  }
  if (flagged && VIRTUOSO_QUERY_RE.test(text)) {
    const detail = /Error\s+([^\n]{1,200})/.exec(text)?.[1]?.trim();
    return new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `Cellar SPARQL refused the query${detail ? `: ${detail}` : "."}`,
      `Rephrase the title keywords as plain words; a trailing * works only after ${WILDCARD_MIN_STEM}+ letters (protect*, not da*).`,
    );
  }
  return new SourceError(
    SOURCE,
    "UPSTREAM_ERROR",
    `Cellar SPARQL rejected the query (HTTP ${status}).`,
    NARROW_HINT,
  );
}

/**
 * One SPARQL request gets 45 s — within the call's budget, and past
 * Virtuoso's usual answer time by far; a timed-out query is never sent again
 * (it would only time out again and cost the endpoint a second run). A fast
 * 429/502/503/504 or dropped connection gets one retry while the budget
 * allows. A 500 is read, not thrown: Virtuoso answers a query it refuses
 * with 500 as well (live 2026-09), and only the body tells the two apart —
 * a refused query is the caller's to rephrase and is never resent, a query
 * past its run-time limit gets the narrowing hint, and any other 500 is a
 * transient store error worth the one retry.
 */
const SPARQL_TIMEOUT_MS = 45_000;
/** A retry of a bare Virtuoso 500 is started only with this much budget left. */
const SPARQL_RETRY_MIN_LEFT_MS = 10_000;

/** POST a SELECT to the Cellar endpoint. One home for the Virtuoso error
 * lore, shared by the search and legislative-history queries. */
async function runSparql(sparql: string, deadline: number): Promise<unknown> {
  const body = new URLSearchParams({ query: sparql, format: "application/sparql-results+json" });
  const started = Date.now();
  const failure = (error: unknown): unknown => {
    if (isTimeoutError(error)) {
      return new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `Cellar SPARQL did not answer within ${Math.round((Date.now() - started) / 1000)} s.`,
        `${NARROW_HINT} If a narrow query times out too, the endpoint is overloaded — run dawmain_probe_sources.`,
      );
    }
    return error;
  };
  // `again`: this is already the one retry — no second one inside it.
  const post = async (again = false): Promise<{ response: Response; text: string }> => {
    try {
      const response = await fetchWithinDeadline(
        SOURCE,
        SPARQL_ENDPOINT,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/sparql-results+json",
          },
          body: body.toString(),
        },
        {
          deadline,
          timeoutMs: SPARQL_TIMEOUT_MS,
          retryOnTimeout: false,
          retryStatus: (status) => !again && (status === 429 || status === 502 || status === 503 || status === 504),
          passStatus: (status) => status === 500,
          what: "running the SPARQL query",
        },
      );
      return { response, text: await response.text() };
    } catch (error) {
      throw failure(error);
    }
  };
  let { response, text } = await post();
  let rejected = virtuosoFailure(response.status, text);
  // A bare 500 whose body names no refusal and no run-time limit: the store
  // itself failed (a deadlock, a restart) — one retry while the budget lasts.
  const bare = (error: SourceError | null, status: number) =>
    status === 500 && error !== null && error.kind === "UPSTREAM_ERROR" && !VIRTUOSO_TIMEOUT_RE.test(text);
  if (bare(rejected, response.status) && deadline - Date.now() >= SPARQL_RETRY_MIN_LEFT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
    ({ response, text } = await post(true));
    rejected = virtuosoFailure(response.status, text);
  }
  if (rejected) {
    // passStatus counted a 500 as an answer; only a bare one (no refusal,
    // no run-time limit in its body) says the endpoint is unwell.
    if (bare(rejected, response.status)) recordSourceResult(SOURCE, false, "HTTP 500");
    // A refused query is the caller's, not an outage: the endpoint answered.
    if (rejected.kind === "INPUT_INVALID") recordSourceResult(SOURCE, true);
    if (bare(rejected, response.status)) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        "Cellar SPARQL answered HTTP 500.",
        "The endpoint failed on its side, not on the query — wait a minute and retry; if a simple lookup (celex: '32016R0679') fails too, the endpoint is down — run dawmain_probe_sources.",
      );
    }
    throw rejected;
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
  const resolved = requireCellarLanguage(SOURCE, input.language ?? "en");
  const lang3 = resolved.iso3.toUpperCase();
  // Dossier titles carry 2-letter language tags; expressions use authority
  // URIs. Both come from the resolved language — the tag taken from the raw
  // input ('ces', 'cs-CZ') would match no title. English doubles as the
  // fallback, fetched alongside unless it IS the requested language.
  const lang2 = resolved.iso2;
  const withEnglishFallback = lang3 !== "ENG";

  const anchor: string[] = [];
  const celex = input.celex ? literal(normalizeCelex(input.celex)) : "";
  if (celex) {
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
  options: { deadline?: number } = {},
): Promise<LegislativeHistoryResult> {
  // Keyed on the query built: equivalent spellings of one anchor share it.
  const sparql = buildLegislativeHistorySparql(input);
  const deadline = options.deadline ?? cellarDeadline();
  return historyCache.through(memoKey("eurlex-history", sparql), async () =>
    parseLegislativeHistoryResults(await runSparql(sparql, deadline)),
  );
}

export interface EurlexDocument {
  text: string;
  url: string;
  /** ISO 639-1 of the text served. */
  language: string;
  /** The requested language had no text; `language` is the English fallback. */
  fallback: boolean;
}

export async function getEurlexDocument(options: {
  celex?: string;
  ecli?: string;
  language?: string;
  deadline?: number;
}): Promise<EurlexDocument> {
  const requested = requireCellarLanguage(SOURCE, options.language ?? "en");
  // One deadline for every step: the celex path (listing, parts, English
  // fallback) and then the ECLI path run in sequence.
  const deadline = options.deadline ?? cellarDeadline();
  const celex = options.celex ? normalizeCelex(options.celex) : "";
  const ecli = options.ecli ? normalizeEcli(options.ecli) : "";
  const found = (document: { text: string; language: string }, url: string): EurlexDocument => ({
    ...document,
    url,
    fallback: document.language !== requested.iso2,
  });
  if (celex) {
    const document = await fetchCellarDocument(SOURCE, `/celex/${encodeURIComponent(celex)}`, requested.iso2, { deadline });
    if (document) return found(document, `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`);
  }
  if (ecli) {
    if (celex && !hasBudget(deadline)) {
      throw budgetSpent(
        SOURCE,
        `trying the ECLI (the CELEX ${celex} gave no text)`,
        "Call again with the ecli alone.",
      );
    }
    const document = await fetchCellarDocument(SOURCE, `/ecli/${encodeURIComponent(ecli)}`, requested.iso2, { deadline });
    if (document) return found(document, `https://publications.europa.eu/resource/ecli/${ecli}`);
  }
  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    "Cellar has no retrievable text for the given identifiers.",
    "Check the CELEX (e.g. 32016R0679 for GDPR, 62018CJ0311 for a judgment, 52012PC0011 for a legislative proposal) or ECLI; some documents exist only in selected languages — try 'en' or 'fr'.",
  );
}
