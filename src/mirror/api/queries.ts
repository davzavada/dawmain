import { queryIdentKeys, stripIdentifiers } from "@/src/files/index/identifiers";
import { bestWindow, findMatches } from "@/src/files/index/highlight";
import { buildTsQuery } from "@/src/files/text/analyze";
import { DOC_PAGE_CHARS, charPage } from "@/src/sources/shared/text";
import type { Queryable } from "../db/client";
import type { Structure } from "../structure";
import { BooleanSyntaxError, booleanSql, hasOperators, parseBoolean, positiveText } from "./boolean";
import { citedCount } from "./citations";
import { basePredicates, hasMeta, metaPredicates, resolveMetaIds, type MetaFilters } from "./filters";
import { MIRROR_SOURCES, type DecisionType, type MirrorSource } from "../types";

/**
 * Reads of the API (role mirror_reader). Search runs two channels over
 * decision_chunk, as Vlastní zdroje does: the lexical one (tsvector built by
 * the application, query by buildTsQuery — AND of the terms, OR when AND
 * finds nothing) and the identifier one (ident_keys && the query's sp. zn. /
 * § / ECLI keys). Each decision ranks by its best chunk; the hit carries
 * that chunk's excerpt with the matches marked.
 *
 * Words alone go to BM25 over whole decisions (runBm25). Words with an
 * identifier keep the chunk channels, the lexical
 * one within the BM25_CANDIDATES decisions BM25 ranks first (`within`):
 * there is no tsvector index on the chunks — a common phrase matches
 * hundreds of thousands of them.
 */

export const MAX_LIMIT = 50;
/** Deepest a list may be paged: past it a query is to be narrowed, not walked. */
export const MAX_OFFSET = 2000;
export const EXCERPT_CHARS = 400;
const RANK_WEIGHTS = "{0.05,0.12,0.2,1.0}";
/** What a match in the letterhead of a decision is worth beside one in its výrok or reasoning, when the excerpt is chosen. */
const HEADER_CHUNK_WEIGHT = 0.2;
/** One identifier match counts like a strong lexical match. */
const IDENT_SCORE = 0.5;
/** The court-name filter: applied to this many BM25-first decisions. */
export const BM25_CANDIDATES = 5000;
/** Words with an identifier: the words' chunks are read for this many BM25-first decisions (~20 chunks each). */
const WITHIN_CANDIDATES = 1000;
/** A court (court_code) with at most this many decisions under the filters is searched whole when BM25's candidates fall short. */
export const COURT_EXACT_MAX = 5000;
/** BM25's first decisions that the importance prior reorders. */
const RERANK_CANDIDATES = 200;

/**
 * How much a decision weighs beside its text match: a nález of the Ústavní soud before its usnesení, the
 * plenum before a senate, a stanovisko before both. Measured by scripts/mirror-eval.ts against the live
 * NALUS ranking: ÚS parity 4 % → 20 % (top 10), NS unchanged; the NS categories (A–E) made NS worse, so
 * they weigh nothing.
 */
function prior(d: string, all = true): string {
  // The form of a decision says something only about decisions that are about the question: under
  // "any word" (no decision holds all the words) the boost lifted plenary nálezy that share one
  // common word with the query to the top of the ÚS lane (seven of ten hits in a test research, 11/2026).
  const us = all
    ? ` * CASE WHEN ${d}.source = 'us' AND ${d}.decision_type = 'nalez' THEN 2 ELSE 1 END
    * CASE WHEN ${d}.source = 'us' AND ${d}.case_number LIKE 'Pl.%' THEN 1.3 ELSE 1 END`
    : "";
  return `(CASE WHEN ${d}.decision_type = 'stanovisko' THEN 1.5 ELSE 1 END${us})`;
}

/**
 * How much the courts themselves rely on a decision, as a factor on its text score: 1 for a decision
 * nobody cites, growing with the logarithm of the mirrored decisions citing it. BM25 alone ranks by the
 * words: the velký senát judgment on moderace smluvní pokuty (417 citing decisions) was not among 16 hits
 * while a decision cited 8 times led, R 122/2012 (1 050) came eleventh (five test researches, 11/2026).
 *
 * Only decisions whose text score is within a tenth of the best one are weighed (AUTHORITY_GATE). Without
 * the gate the much-cited decisions of a whole field rose over the ones on the question: for "zneužití
 * práva na informace" 8 As 22/2010 and 1 As 27/2011 led and 1 As 96/2021 fell from fifth to tenth; with
 * it 1 As 96/2021 is second, 31 Cdo 2273/2022 and 30 Cdo 2813/2011 first in their queries. Both numbers
 * were set on the production index over six queries (11/2026) — tests/mirror-api.test.ts pins the SQL.
 */
export const AUTHORITY_WEIGHT = 0.35;
export const AUTHORITY_GATE = 0.9;
function authority(score: string, id: string): string {
  return `CASE WHEN ${score} >= ${AUTHORITY_GATE} * max(${score}) OVER () THEN (1 + ${AUTHORITY_WEIGHT} * ln(1 + ${citedCount(id)})) ELSE 1 END`;
}

/** Mirror NSS holds the regional administrative courts too; caselaw_search's NSS lane does not. */
function topCourtsOnly(d: string): string {
  return `(${d}.source <> 'nss' OR coalesce(${d}.court, 'Nejvyšší správní soud') ILIKE 'Nejvyšší správní soud%')`;
}

/**
 * The court code of a general court's decision (decision.court_code, migration 0022): the third part of
 * its ECLI ("ECLI:CZ:KSBR:2024:…" → KSBR) where that is a real code, else the code the court's name
 * carries — a trigger fills it. Exact match; a pobočka shares its court's code, as in the ECLI.
 * Served by the index decision_court_code, whose WHERE is this source literal.
 */
function courtCodeIn(d: string, param: string): string {
  return `(${d}.source = 'justice' AND ${d}.court_code = ANY(${param}::text[]))`;
}

/** The regional administrative courts are left out unless asked for, or unless a court is named. */
function withoutRegional(input: SearchInput): boolean {
  return !input.regional && !input.court && (!input.sources?.length || input.sources.includes("nss"));
}

export interface SearchInput {
  q?: string;
  /** Any of these courts; none = all. */
  sources?: MirrorSource[];
  court?: string;
  /** rozhodnuti.justice.cz court codes, any of them (["KSBR", "KSBRJI"]); source justice only. */
  courtCodes?: string[];
  type?: DecisionType;
  /** Several forms at once (ÚS: nález and stanovisko); with `type`, the union. */
  types?: DecisionType[];
  /** The filters the BM25 index does not carry — senate, registry, area, web date, a cited provision, the own značka (./filters.ts). */
  meta?: MetaFilters;
  /** How bare words combine: every word (default, "any word" when none has all), any word, or the words as one phrase. */
  match?: "all" | "any" | "phrase";
  /** Hits to skip (paging); at most MAX_OFFSET. */
  offset?: number;
  /** With sort "newest": by the decision date (default) or by the day the court put it on the web. */
  newestBy?: "decided" | "published";
  from?: string;
  to?: string;
  /** A case number the decision must carry or cite ("I. ÚS 1169/26"). */
  caseNumber?: string;
  /** NS categories, any of them (["A", "B"]). */
  categories?: string[];
  /** NSS with the regional administrative courts (krajské soudy); default the NSS itself only. */
  regional?: boolean;
  /** "relevance" (default: text match × importance) or "newest" (date of the decision, newest first). */
  sort?: "relevance" | "newest";
  /** "vyrok": the words in the výrok only (decision_verdict), not in the whole text. */
  in?: "vyrok";
  /** The BM25 index over decision_verdict is built (decision_verdict_bm25); without it the výroky are scanned. */
  verdictBm25?: boolean;
  limit?: number;
  /** The BM25 index over decision_text is built (decision_text_bm25, pg_search). */
  bm25?: boolean;
}

/** The shape of caselaw_search's AggregatedHit, plus the local fields. */
export interface MirrorHit {
  source: MirrorSource;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: DecisionType | null;
  /** NS "Kategorie rozhodnutí" A–E; null elsewhere. */
  category: string | null;
  date: string | null;
  published: string | null;
  ecli: string | null;
  url: string;
  score: number;
  excerpt: string;
  /** [start, end) of the matches within `excerpt`. */
  highlights: Array<[number, number]>;
  /** The excerpt lies in an odlišné stanovisko. */
  inDissent: boolean;
  /** Which one (0-based, as in DecisionView.dissents); null outside any. */
  dissent: number | null;
}

export interface SearchResult {
  hits: MirrorHit[];
  /** "and" | "or" (AND found nothing) | "ident" (identifiers only) | null (nothing searchable). */
  channel: "and" | "or" | "ident" | null;
  terms: string[];
  identKeys: string[];
  /** How many decisions pass the filters — given where it is counted (a listing without words). */
  total?: number;
}

/** The forms asked for: `types`, with the single `type` among them; undefined = any. */
function formsOf(input: SearchInput): DecisionType[] | undefined {
  const all = [...(input.types ?? []), ...(input.type ? [input.type] : [])];
  return all.length ? [...new Set(all)] : undefined;
}

function pageOf(input: SearchInput): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_LIMIT),
    offset: Math.min(Math.max(0, Math.floor(input.offset ?? 0)), MAX_OFFSET),
  };
}

/** How the meta filters reach one statement: the ids resolved beforehand, or (too many to list) the predicates themselves. */
interface MetaScope {
  ids: number[] | null;
  meta: MetaFilters;
}

/** Conditions on the decision `d` for a statement that filters its candidates itself. */
function metaOn(scope: MetaScope | undefined, d: string, params: unknown[]): string[] {
  if (!scope) return [];
  if (scope.ids) return [`${d}.id = ANY($${params.push(scope.ids)}::bigint[])`];
  return metaPredicates(scope.meta, d, params);
}

interface ChunkRow {
  source: MirrorSource;
  source_id: string;
  case_number: string | null;
  court: string | null;
  decision_type: DecisionType | null;
  category: string | null;
  decided_on: string | null;
  published_on: string | null;
  ecli: string | null;
  url: string;
  score: number;
  char_start: number;
  chunk: string;
  dissent_starts: number[] | null;
}

function plan(input: SearchInput): { tsAnd: string | null; tsOr: string | null; terms: string[]; keys: string[]; caseKeys: string[] } {
  const text = input.q?.trim() ?? "";
  const ids = text ? queryIdentKeys(text) : { keys: [] as string[] };
  const ts = buildTsQuery(text ? stripIdentifiers(text) : "", { loneStopwords: ids.keys.length === 0 });
  const caseKeys = input.caseNumber ? queryIdentKeys(input.caseNumber).keys.filter((k) => k.startsWith("sz:")) : [];
  return { tsAnd: ts.and, tsOr: ts.or, terms: ts.terms, keys: ids.keys, caseKeys };
}

async function runChannel(
  db: Queryable,
  input: SearchInput,
  tsquery: string | null,
  keys: string[],
  caseKeys: string[],
  within?: number[],
  scope?: MetaScope,
): Promise<ChunkRow[]> {
  const { limit, offset } = pageOf(input);
  const params: unknown[] = [
    tsquery,
    keys,
    input.sources?.length ? input.sources : null,
    input.court ?? null,
    formsOf(input) ?? null,
    input.from ?? null,
    input.to ?? null,
    caseKeys,
    limit + offset,
    input.categories ?? [],
    withoutRegional(input),
    input.sort === "newest",
    input.courtCodes?.length ? input.courtCodes : null,
    ...(within ? [within] : []),
  ];
  const metaWhere = metaOn(scope, "d", params);
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH q AS (SELECT CASE WHEN $1::text IS NULL THEN NULL ELSE to_tsquery('simple', $1::text) END AS tsq),
     -- Two channels as UNION ALL, each on its own index: an OR of the two makes the planner read every chunk.
     -- $1 IS NOT NULL / cardinality($2) > 0 are one-time filters: a channel without input is not scanned.
     candidates AS (
       SELECT c.source, c.decision_id, c.char_start, c.char_end, c.tsv, c.ident_keys
       FROM mirror.decision_chunk c, q
       WHERE $1::text IS NOT NULL AND ($3::text[] IS NULL OR c.source = ANY($3)) AND c.tsv @@ q.tsq${
         // The words only in the decisions BM25 found (decision_id index); without BM25 every chunk is read.
         within ? " AND c.decision_id = ANY($14::bigint[])" : ""
       }
       UNION ALL
       SELECT c.source, c.decision_id, c.char_start, c.char_end, c.tsv, c.ident_keys
       FROM mirror.decision_chunk c
       WHERE cardinality($2::text[]) > 0 AND ($3::text[] IS NULL OR c.source = ANY($3)) AND c.ident_keys && $2::text[]
     ),
     matched AS (
       SELECT c.source, c.decision_id, c.char_start, c.char_end,
              coalesce(ts_rank_cd('${RANK_WEIGHTS}'::float4[], c.tsv, q.tsq), 0)
                + ${IDENT_SCORE} * cardinality(ARRAY(SELECT unnest(c.ident_keys) INTERSECT SELECT unnest($2::text[]))) AS score
       FROM candidates c, q
     ),
     best AS (
       SELECT DISTINCT ON (m.decision_id) m.* FROM matched m ORDER BY m.decision_id, m.score DESC, m.char_start
     ),
     top AS (
       SELECT d.id, d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on, d.published_on, d.ecli, d.url,
              b.score * ${prior("d")} AS score, b.char_start, b.char_end
       FROM best b
       JOIN mirror.decision d ON d.id = b.decision_id
       WHERE ($3::text[] IS NULL OR d.source = ANY($3))
         AND ($4::text IS NULL OR d.court ILIKE '%' || $4 || '%')
         AND ($5::text[] IS NULL OR d.decision_type = ANY($5))
         AND ($6::date IS NULL OR d.decided_on >= $6)
         AND ($7::date IS NULL OR d.decided_on <= $7)
         AND (cardinality($8::text[]) = 0 OR EXISTS (
               SELECT 1 FROM mirror.decision_chunk c2 WHERE c2.decision_id = d.id AND c2.ident_keys && $8::text[]))
         AND (cardinality($10::text[]) = 0 OR d.category = ANY($10::text[]))
         AND (NOT $11::boolean OR ${topCourtsOnly("d")})
         AND ($13::text[] IS NULL OR ${courtCodeIn("d", "$13")})${metaWhere.map((w) => `\n         AND ${w}`).join("")}
       ORDER BY CASE WHEN $12::boolean THEN d.decided_on END DESC NULLS LAST, score DESC, d.decided_on DESC NULLS LAST
       LIMIT $9
     )
     -- The text only for the hits kept, not for every candidate.
     SELECT r.source, r.source_id, r.case_number, r.court, r.decision_type, r.category, r.decided_on::text, r.published_on::text, r.ecli, r.url,
            r.score::float8 AS score, r.char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = r.id) AS dissent_starts,
            substr(t.body, r.char_start + 1, r.char_end - r.char_start) AS chunk
     FROM top r
     JOIN mirror.decision_text t ON t.decision_id = r.id
     ORDER BY CASE WHEN $12::boolean THEN r.decided_on END DESC NULLS LAST, r.score DESC, r.decided_on DESC NULLS LAST
     OFFSET ${offset}`,
    params,
  );
  return rows;
}

function toHit(row: ChunkRow, terms: string[], identKeys: string[]): MirrorHit {
  const window = bestWindow(row.chunk, findMatches(row.chunk, { terms, identKeys }), EXCERPT_CHARS);
  const start = window?.start ?? 0;
  const end = window?.end ?? Math.min(row.chunk.length, EXCERPT_CHARS);
  const excerpt = row.chunk.slice(start, end);
  const highlights = findMatches(excerpt, { terms, identKeys }).map((s): [number, number] => [s.start, s.end]);
  const at = row.char_start + start;
  const starts = (row.dissent_starts ?? []).map(Number);
  const inside = starts.filter((s) => at >= s).length;
  const dissent = inside > 0 ? inside - 1 : null;
  return {
    source: row.source,
    id: row.source_id,
    caseNumber: row.case_number,
    court: row.court,
    form: row.decision_type,
    category: row.category ?? null,
    date: row.decided_on,
    published: row.published_on,
    ecli: row.ecli,
    url: row.url,
    score: Math.round(Number(row.score) * 1000) / 1000,
    excerpt,
    highlights,
    inDissent: dissent !== null,
    dissent,
  };
}

/**
 * Words only, through BM25 (pg_search): the index ranks whole decisions and returns the top ones with
 * the court / type / date / category filters applied inside it — milliseconds where ranking chunks took
 * seconds on common phrases. Czech stems, diacritics folded. The excerpt is the decision's best chunk
 * for the same words (ts_rank_cd), looked up for the hits kept only. `all`: every word (&&&), else any (|||).
 */
function bm25Where(input: SearchInput, all: boolean, params: unknown[], match?: (params: unknown[]) => string, ids?: number[] | null): string {
  // Filters spelled out only when given: the index takes them in, an "$n IS NULL OR …" it would not.
  // `match`: the body predicate of a query with operators (./boolean.ts) in place of "every / any word";
  // $1 stays in the statement, as a parameter nothing refers to has no type.
  const where = [match ? `$1::text IS NOT NULL AND ${match(params)}` : `t.body ${all ? "&&&" : "|||"} $1::text`];
  if (input.sources?.length) where.push(`t.source = ANY($${params.push(input.sources)}::text[])`);
  const forms = formsOf(input);
  if (forms?.length === 1) where.push(`t.decision_type = $${params.push(forms[0])}`);
  else if (forms) where.push(`t.decision_type = ANY($${params.push(forms)}::text[])`);
  // The decisions a selective meta filter passes, as a term set on the key field (./filters.ts).
  if (ids) where.push(`t.decision_id = ANY($${params.push(ids)}::bigint[])`);
  if (input.from) where.push(`t.decided_on >= $${params.push(input.from)}::date`);
  if (input.to) where.push(`t.decided_on <= $${params.push(input.to)}::date`);
  if (input.categories?.length) where.push(`t.category = ANY($${params.push(input.categories)}::text[])`);
  return where.join(" AND ");
}

/** The BM25-first decisions for the words (every word, else any), the chunk channels' `within`. */
async function bm25Candidates(db: Queryable, input: SearchInput, text: string, limit: number): Promise<number[]> {
  for (const all of [true, false]) {
    const params: unknown[] = [text];
    const { rows } = await db.query<{ id: string }>(
      `SELECT t.decision_id::text AS id FROM mirror.decision_text t WHERE ${bm25Where(input, all, params)}
       ORDER BY pdb.score(t.decision_id) DESC LIMIT ${limit}`,
      params,
    );
    if (rows.length) return rows.map((r) => Number(r.id));
  }
  return [];
}

async function runBm25(
  db: Queryable,
  input: SearchInput,
  text: string,
  all: boolean,
  tsquery: string | null,
  match?: (params: unknown[]) => string,
  scope?: MetaScope,
): Promise<ChunkRow[]> {
  const { limit, offset } = pageOf(input);
  // $3 = how many of the best are kept: the page asked for and everything before it.
  const params: unknown[] = [text, tsquery, limit + offset];
  const where = bm25Where(input, all, params, match, scope?.ids);
  const newest = input.sort === "newest";
  // The court is not in the index: the BM25-first candidates, then the court, then the prior, then the limit.
  const courts = [
    input.court ? `d.court ILIKE '%' || $${params.push(input.court)} || '%'` : "",
    input.courtCodes?.length ? courtCodeIn("d", `$${params.push(input.courtCodes)}`) : "",
    withoutRegional(input) ? topCourtsOnly("d") : "",
    // A meta filter too broad to list by id: checked on the BM25 candidates, like the court's name.
    ...(scope && !scope.ids ? metaPredicates(scope.meta, "d", params) : []),
  ].filter(Boolean);
  const pool = newest ? "$3" : String(Math.max(RERANK_CANDIDATES, limit + offset));
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH top AS (
       SELECT t.decision_id, pdb.score(t.decision_id) AS score
       FROM mirror.decision_text t
       WHERE ${where}
       ORDER BY ${newest ? "t.decided_on DESC NULLS LAST" : "pdb.score(t.decision_id) DESC"}
       LIMIT ${courts.length ? BM25_CANDIDATES : pool}
     ),
     filtered AS (
       SELECT top.decision_id, top.score * ${prior("d", all)} AS score, d.decided_on
       FROM top JOIN mirror.decision d ON d.id = top.decision_id
       ${courts.length ? `WHERE ${courts.join(" AND ")}` : ""}
       ORDER BY ${newest ? "d.decided_on DESC NULLS LAST" : "top.score DESC"} LIMIT ${pool}
     ),
     -- The citing count is looked up for the candidates kept so far only (at most the pool).
     weighed AS (
       SELECT f.decision_id, f.score * ${authority("f.score", "f.decision_id")} AS score, f.decided_on FROM filtered f
     ),
     kept AS (
       SELECT * FROM weighed ORDER BY ${newest ? "decided_on DESC NULLS LAST, score DESC" : "score DESC"} LIMIT $3
     ),
     best AS (
       -- The passage shown: the best-matching chunk — one from the letterhead (the bench, the parties and
       -- their addresses, before the reasoning starts) counts for a fraction, so "výše" is not found in
       -- "Vyšehradská 16" while the reasoning speaks of the amount.
       SELECT DISTINCT ON (c.decision_id) c.decision_id, c.char_start, c.char_end
       FROM kept top JOIN mirror.decision_chunk c ON c.decision_id = top.decision_id
       LEFT JOIN LATERAL (
         SELECT min((x->>'start')::int) AS at FROM mirror.decision_structure st, jsonb_array_elements(st.sections) x
         WHERE st.decision_id = top.decision_id AND x->>'kind' IN ('vyrok', 'oduvodneni')
       ) body ON true
       ORDER BY c.decision_id,
                coalesce(ts_rank_cd('${RANK_WEIGHTS}'::float4[], c.tsv, to_tsquery('simple', $2::text)), 0)
                  * CASE WHEN c.char_end <= coalesce(body.at, 0) THEN ${HEADER_CHUNK_WEIGHT} ELSE 1 END DESC,
                c.char_start
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on::text, d.published_on::text, d.ecli, d.url,
            top.score::float8 AS score, coalesce(b.char_start, 0) AS char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = d.id) AS dissent_starts,
            substr(t.body, coalesce(b.char_start, 0) + 1, coalesce(b.char_end - b.char_start, ${EXCERPT_CHARS * 4})) AS chunk
     FROM kept top
     JOIN mirror.decision d ON d.id = top.decision_id
     JOIN mirror.decision_text t ON t.decision_id = top.decision_id
     LEFT JOIN best b ON b.decision_id = top.decision_id
     ORDER BY ${newest ? "d.decided_on DESC NULLS LAST, top.score DESC" : "top.score DESC, d.decided_on DESC NULLS LAST"}
     OFFSET ${offset}`,
    params,
  );
  return rows;
}

/**
 * Words in the výroky only: BM25 over decision_verdict (filters in the index as on decision_text), or
 * without its index every výrok scanned for all the words. The excerpt is the výrok itself.
 */
async function runVerdict(db: Queryable, input: SearchInput, text: string, all: boolean): Promise<ChunkRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_LIMIT);
  const params: unknown[] = [text, limit];
  const newest = input.sort === "newest";
  const courts = [
    input.court ? `d.court ILIKE '%' || $${params.push(input.court)} || '%'` : "",
    input.courtCodes?.length ? courtCodeIn("d", `$${params.push(input.courtCodes)}`) : "",
    withoutRegional(input) ? topCourtsOnly("d") : "",
  ].filter(Boolean);
  let top: string;
  if (input.verdictBm25) {
    const where = bm25Where(input, all, params).replace(/\bt\./g, "v.");
    top = `SELECT v.decision_id, pdb.score(v.decision_id) AS score FROM mirror.decision_verdict v WHERE ${where}
           ORDER BY ${newest ? "v.decided_on DESC NULLS LAST" : "pdb.score(v.decision_id) DESC"}
           LIMIT ${courts.length ? BM25_CANDIDATES : newest ? "$2" : RERANK_CANDIDATES}`;
  } else {
    const words = text.split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
    const like = `v.body ILIKE ${all ? "ALL" : "ANY"}($${params.push(words.map((w) => `%${w.replace(/[%_\\]/g, "\\$&")}%`))}::text[])`;
    const filters = [
      "$1::text IS NOT NULL",
      like,
      input.sources?.length ? `v.source = ANY($${params.push(input.sources)}::text[])` : "",
      formsOf(input) ? `v.decision_type = ANY($${params.push(formsOf(input))}::text[])` : "",
      input.from ? `v.decided_on >= $${params.push(input.from)}::date` : "",
      input.to ? `v.decided_on <= $${params.push(input.to)}::date` : "",
      input.categories?.length ? `v.category = ANY($${params.push(input.categories)}::text[])` : "",
    ].filter(Boolean);
    top = `SELECT v.decision_id, 1.0::float8 AS score FROM mirror.decision_verdict v WHERE ${filters.join(" AND ")}
           ORDER BY v.decided_on DESC NULLS LAST LIMIT ${BM25_CANDIDATES}`;
  }
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH top AS (${top}),
     kept AS (
       SELECT top.decision_id, top.score * ${prior("d")} AS score FROM top JOIN mirror.decision d ON d.id = top.decision_id
       ${courts.length ? `WHERE ${courts.join(" AND ")}` : ""}
       ORDER BY ${newest ? "d.decided_on DESC NULLS LAST" : "top.score * " + prior("d") + " DESC"} LIMIT $2
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on::text, d.published_on::text, d.ecli, d.url,
            kept.score::float8 AS score,
            coalesce((SELECT (x->>'start')::int FROM mirror.decision_structure s, jsonb_array_elements(s.sections) x
                      WHERE s.decision_id = d.id AND x->>'kind' = 'vyrok' LIMIT 1), 0) AS char_start,
            NULL::int[] AS dissent_starts, v.body AS chunk
     FROM kept JOIN mirror.decision d ON d.id = kept.decision_id JOIN mirror.decision_verdict v ON v.decision_id = d.id
     ORDER BY ${newest ? "d.decided_on DESC NULLS LAST, kept.score DESC" : "kept.score DESC, d.decided_on DESC NULLS LAST"}`,
    params,
  );
  return rows;
}

/**
 * The decisions of the courts asked for (court_code) under the date and type filters, by the index
 * decision_justice_court_code — at most `limit` ids.
 */
async function courtDecisionIds(db: Queryable, input: SearchInput, limit: number): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT d.id::text AS id FROM mirror.decision d
     WHERE ${courtCodeIn("d", "$1")}
       AND ($2::date IS NULL OR d.decided_on >= $2) AND ($3::date IS NULL OR d.decided_on <= $3)
       AND ($4::text[] IS NULL OR d.decision_type = ANY($4))
     LIMIT $5`,
    [input.courtCodes, input.from ?? null, input.to ?? null, formsOf(input) ?? null, limit],
  );
  return rows.map((r) => Number(r.id));
}

export class UnsupportedSearch extends Error {}

/**
 * A query with search operators (AND / OR / NOT, NEAR, `prefix*`, brackets — ./boolean.ts): one BM25
 * query over the whole decisions, the filters and the importance prior as for plain words. No "any
 * word" fallback: the reader spelled the logic out, and an empty answer is the answer. The excerpt and
 * its marks come from what the query asks to find, not from what it excludes.
 */
/** Characters of text a listed decision is shown with. */
const LIST_CHUNK_CHARS = 1600;
/** How far before a cited provision its excerpt starts. */
const LIST_BEFORE_CHARS = 150;

/**
 * A search without words: the decisions passing the filters, newest first (by
 * the decision date, or by the day they were put on the web), with their
 * count. What the courts' forms answer to "everything of the rozšířený senát
 * since 2024", "what the NS published this week", "decisions applying § 82
 * s. ř. s." — a filter-only call used to go to the live court. The excerpt
 * is the text around the cited provision when one is asked for, else the
 * právní věta, else the výrok (the opening of a text is its letterhead), else
 * the opening of the text.
 */
async function listDecisions(db: Queryable, input: SearchInput): Promise<SearchResult> {
  const { limit, offset } = pageOf(input);
  const meta = input.meta ?? {};
  const params: unknown[] = [];
  const where = [
    ...basePredicates({ sources: input.sources, types: formsOf(input), from: input.from, to: input.to, categories: input.categories }, "d", params),
    ...metaPredicates(meta, "d", params),
    input.court ? `d.court ILIKE '%' || $${params.push(input.court)} || '%'` : "",
    input.courtCodes?.length ? courtCodeIn("d", `$${params.push(input.courtCodes)}`) : "",
    withoutRegional(input) && !meta.courtClass ? topCourtsOnly("d") : "",
  ].filter(Boolean);
  const filter = where.length ? where.join(" AND ") : "true";
  const order = input.newestBy === "published" ? "d.published_on DESC NULLS LAST, d.id DESC" : "d.decided_on DESC NULLS LAST, d.id DESC";
  const { rows: count } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM mirror.decision d WHERE ${filter}`, params);
  const provision = meta.act
    ? `(SELECT min(p.first_at) FROM mirror.decision_provision p WHERE p.decision_id = d.id AND p.act_id = $${params.push(meta.act)}::text${
        meta.provision ? ` AND p.provision = $${params.push(meta.provision)}::text` : ""
      })`
    : "NULL::int";
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH page AS (
       SELECT d.id, ${provision} AS at FROM mirror.decision d WHERE ${filter} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on::text, d.published_on::text, d.ecli, d.url,
            0::float8 AS score, greatest(0, coalesce(page.at, 0) - ${LIST_BEFORE_CHARS}) AS char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = d.id) AS dissent_starts,
            CASE WHEN page.at IS NULL AND coalesce(d.legal_sentence, '') <> '' THEN d.legal_sentence
                 WHEN page.at IS NULL AND coalesce(v.body, '') <> '' THEN v.body
                 ELSE coalesce(substr(t.body, greatest(1, coalesce(page.at, 0) + 1 - ${LIST_BEFORE_CHARS}), ${LIST_CHUNK_CHARS}), '') END AS chunk
     FROM page JOIN mirror.decision d ON d.id = page.id LEFT JOIN mirror.decision_text t ON t.decision_id = d.id
     LEFT JOIN mirror.decision_verdict v ON v.decision_id = d.id
     ORDER BY ${order}`,
    params,
  );
  return { hits: rows.map((r) => toHit(r, [], [])), channel: "ident", terms: [], identKeys: [], total: Number(count[0]?.n ?? 0) };
}

/** The meta filters of a search with words, resolved once: ids when selective, the predicates otherwise; undefined without any. */
async function scopeOf(db: Queryable, input: SearchInput): Promise<MetaScope | undefined> {
  const meta = input.meta;
  if (!meta || !hasMeta(meta)) return undefined;
  const ids = await resolveMetaIds(db, meta, { sources: input.sources, types: formsOf(input), from: input.from, to: input.to, categories: input.categories });
  return { ids, meta };
}

async function searchBoolean(db: Queryable, input: SearchInput, query: string): Promise<SearchResult> {
  if (input.in === "vyrok") throw new UnsupportedSearch("search operators are not read in výroky (in=vyrok) — plain words only");
  if (input.caseNumber) throw new UnsupportedSearch("search operators and the case filter do not combine");
  if (!input.bm25) throw new UnsupportedSearch("search operators need the BM25 index, which this mirror does not have");
  let tree;
  try {
    tree = parseBoolean(query);
    // Built once here, so a query that cannot be put to the index is refused before any statement runs.
    booleanSql(tree, "t.body", []);
  } catch (error) {
    if (error instanceof BooleanSyntaxError) throw new UnsupportedSearch(`the query could not be read: ${error.message}`);
    throw error;
  }
  const found = positiveText(tree);
  const ts = buildTsQuery(found, { loneStopwords: true });
  const scope = await scopeOf(db, input);
  if (scope?.ids?.length === 0) return { hits: [], channel: "and", terms: ts.terms, identKeys: [] };
  const rows = await runBm25(db, input, found, true, ts.or ?? ts.and, (params) => booleanSql(tree, "t.body", params), scope);
  return { hits: rows.map((r) => toHit(r, ts.terms, [])), channel: "and", terms: ts.terms, identKeys: [] };
}

export async function searchDecisions(db: Queryable, input: SearchInput): Promise<SearchResult> {
  const query = input.q?.trim() ?? "";
  // Nothing to search for and nothing to cite: the filters alone list the decisions that pass them.
  if (!query && !input.caseNumber) return listDecisions(db, input);
  if (query && hasOperators(query)) return searchBoolean(db, input, query);
  const p = plan(input);
  const keys = [...new Set([...p.keys, ...p.caseKeys])];
  if (!p.tsAnd && keys.length === 0) return { hits: [], channel: null, terms: [], identKeys: [] };
  const scope = await scopeOf(db, input);
  if (scope?.ids?.length === 0) return { hits: [], channel: "and", terms: p.terms, identKeys: keys };
  if (input.in === "vyrok") {
    if (keys.length) throw new UnsupportedSearch("in=vyrok takes words only, not a sp. zn., § or ECLI");
    const words = input.q ? input.q.trim() : "";
    let rows = await runVerdict(db, input, words, true);
    let channel: SearchResult["channel"] = "and";
    if (rows.length === 0) {
      channel = "or";
      rows = await runVerdict(db, input, words, false);
    }
    return { hits: rows.map((r) => toHit(r, p.terms, [])), channel, terms: p.terms, identKeys: [] };
  }
  // BM25 for words alone (the court-name filter on its first candidates); identifiers (sp. zn., §, the case filter) keep the chunk channels.
  const words = input.q ? stripIdentifiers(input.q).trim() : "";
  if (input.bm25 && p.tsAnd && words && keys.length === 0) {
    // match "phrase": the words side by side in this order; "any": any of them, said as asked for (not as a fallback).
    const phrase = input.match === "phrase" ? (params: unknown[]) => `t.body ### $${params.push(words.replace(/["„“”‟«»]/g, " ").trim())}::text` : undefined;
    let rows = input.match === "any" ? [] : await runBm25(db, input, words, true, p.tsAnd, phrase, scope);
    let channel: SearchResult["channel"] = "and";
    if (rows.length === 0 && !phrase) {
      channel = input.match === "any" ? "and" : "or";
      rows = await runBm25(db, input, words, false, p.tsOr ?? p.tsAnd, undefined, scope);
    }
    // The court code is checked on BM25's first candidates only: a small court under a common phrase
    // gets fewer hits than it has. Such a court is searched whole instead, chunk by chunk.
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_LIMIT);
    if (input.courtCodes?.length && rows.length < limit) {
      const own = await courtDecisionIds(db, input, COURT_EXACT_MAX + 1);
      if (own.length > 0 && own.length <= COURT_EXACT_MAX && !phrase && input.match !== "any") {
        let exact = await runChannel(db, input, p.tsAnd, [], [], own, scope);
        const exactChannel: SearchResult["channel"] = exact.length || !p.tsOr ? "and" : "or";
        if (exact.length === 0 && p.tsOr) exact = await runChannel(db, input, p.tsOr, [], [], own, scope);
        if (exact.length > rows.length || (exactChannel === "and" && channel === "or" && exact.length > 0)) {
          rows = exact;
          channel = exactChannel;
        }
      }
    }
    return { hits: rows.map((r) => toHit(r, p.terms, [])), channel, terms: p.terms, identKeys: [] };
  }
  // Words with an identifier: the words' chunks only within BM25's first decisions.
  const within = input.bm25 && p.tsAnd && words ? await bm25Candidates(db, input, words, WITHIN_CANDIDATES) : undefined;
  // The case filter alone is not a search query; with nothing else, it lists that case's decisions.
  const rankKeys = p.tsAnd || p.keys.length ? p.keys : p.caseKeys;
  let channel: SearchResult["channel"] = p.tsAnd ? "and" : "ident";
  let rows = await runChannel(db, input, p.tsAnd, rankKeys, p.caseKeys, within, scope);
  if (rows.length === 0 && p.tsOr) {
    channel = "or";
    rows = await runChannel(db, input, p.tsOr, rankKeys, p.caseKeys, within, scope);
  }
  return { hits: rows.map((r) => toHit(r, p.terms, keys)), channel, terms: p.terms, identKeys: keys };
}

// ---------- one decision ----------

export interface DecisionImageInfo {
  ord: number;
  charAt: number;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface DecisionView {
  source: MirrorSource;
  id: string;
  caseNumber: string | null;
  caseNumbers: string[];
  court: string | null;
  form: DecisionType | null;
  category: string | null;
  date: string | null;
  published: string | null;
  ecli: string | null;
  legalSentence: string | null;
  url: string;
  textSource: string | null;
  dissents: Array<{ ord: number; charStart: number; charEnd: number; heading: string | null }>;
  /** Sections, numbered paragraphs and headings as offsets into the text (src/mirror/structure.ts); null before it is derived. */
  structure: Structure | null;
  images: DecisionImageInfo[];
  firstSeenAt: string;
  lastChangedAt: string;
  goneAt: string | null;
}

export interface FullDecision extends DecisionView {
  body: string | null;
}

export function isMirrorSource(value: string): value is MirrorSource {
  return (MIRROR_SOURCES as readonly string[]).includes(value);
}

export async function getDecision(db: Queryable, source: MirrorSource, id: string): Promise<FullDecision | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT d.source, d.source_id, d.case_number, d.case_numbers, d.court, d.decision_type, d.category, d.decided_on::text AS decided_on,
            d.published_on::text AS published_on, d.ecli, d.legal_sentence, d.url, d.first_seen_at, d.last_changed_at, d.gone_at,
            t.body, t.text_source,
            coalesce((SELECT json_agg(json_build_object('ord', x.ord, 'charStart', x.char_start, 'charEnd', x.char_end,
                                                        'heading', x.heading) ORDER BY x.ord)
                      FROM mirror.decision_dissent x WHERE x.decision_id = d.id), '[]'::json) AS dissents,
            coalesce((SELECT json_agg(json_build_object('ord', i.ord, 'charAt', i.char_at, 'mime', i.mime, 'width', i.width,
                                                        'height', i.height, 'bytes', length(b.bytes)) ORDER BY i.ord)
                      FROM mirror.decision_image i JOIN mirror.image_blob b ON b.sha256 = i.sha256 WHERE i.decision_id = d.id), '[]'::json) AS images,
            (SELECT json_build_object('sections', s.sections, 'paragraphs', s.paragraphs, 'headings', s.headings)
             FROM mirror.decision_structure s WHERE s.decision_id = d.id) AS structure
     FROM mirror.decision d LEFT JOIN mirror.decision_text t ON t.decision_id = d.id
     WHERE d.source = $1 AND d.source_id = $2`,
    [source, id],
  );
  const r = rows[0];
  if (!r) return null;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  return {
    source: r.source as MirrorSource,
    id: String(r.source_id),
    caseNumber: (r.case_number as string | null) ?? null,
    caseNumbers: (r.case_numbers as string[]) ?? [],
    court: (r.court as string | null) ?? null,
    form: (r.decision_type as DecisionType | null) ?? null,
    category: (r.category as string | null) ?? null,
    date: (r.decided_on as string | null) ?? null,
    published: (r.published_on as string | null) ?? null,
    ecli: (r.ecli as string | null) ?? null,
    legalSentence: (r.legal_sentence as string | null) ?? null,
    url: String(r.url),
    textSource: (r.text_source as string | null) ?? null,
    dissents: (typeof r.dissents === "string" ? JSON.parse(r.dissents) : r.dissents) as DecisionView["dissents"],
    images: (typeof r.images === "string" ? JSON.parse(r.images) : r.images) as DecisionImageInfo[],
    structure: r.structure === null || r.structure === undefined ? null : ((typeof r.structure === "string" ? JSON.parse(r.structure) : r.structure) as Structure),
    firstSeenAt: iso(r.first_seen_at)!,
    lastChangedAt: iso(r.last_changed_at)!,
    goneAt: iso(r.gone_at),
    body: (r.body as string | null) ?? null,
  };
}

/** The JSON view: metadata + one page (45k chars, as pageOrExcerpt) of the text. */
export function decisionPage(d: FullDecision, page: number) {
  const { body, ...meta } = d;
  return { ...meta, text: body === null ? null : charPage(body, page, DOC_PAGE_CHARS) };
}

export async function getImage(
  db: Queryable,
  source: MirrorSource,
  id: string,
  ord: number,
): Promise<{ mime: string; bytes: Uint8Array; sha256: string } | null> {
  const { rows } = await db.query<{ mime: string; bytes: Uint8Array; sha256: string }>(
    `SELECT i.mime, b.bytes, i.sha256 FROM mirror.decision_image i JOIN mirror.image_blob b ON b.sha256 = i.sha256
     JOIN mirror.decision d ON d.id = i.decision_id
     WHERE d.source = $1 AND d.source_id = $2 AND i.ord = $3`,
    [source, id, ord],
  );
  return rows[0] ?? null;
}

/** All pictures with their bytes (for the HTML rendering, which inlines them). */
export async function getImages(db: Queryable, source: MirrorSource, id: string) {
  const { rows } = await db.query<{ ord: number; char_at: number; mime: string; width: number | null; height: number | null; bytes: Uint8Array }>(
    `SELECT i.ord, i.char_at, i.mime, i.width, i.height, b.bytes FROM mirror.decision_image i
     JOIN mirror.image_blob b ON b.sha256 = i.sha256 JOIN mirror.decision d ON d.id = i.decision_id WHERE d.source = $1 AND d.source_id = $2 ORDER BY i.ord`,
    [source, id],
  );
  return rows;
}
