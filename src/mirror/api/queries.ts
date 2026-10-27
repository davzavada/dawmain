import { queryIdentKeys, stripIdentifiers } from "@/src/files/index/identifiers";
import { bestWindow, findMatches } from "@/src/files/index/highlight";
import { buildTsQuery } from "@/src/files/text/analyze";
import { DOC_PAGE_CHARS, charPage } from "@/src/sources/shared/text";
import type { Queryable } from "../db/client";
import { MIRROR_SOURCES, type DecisionType, type MirrorSource } from "../types";

/**
 * Reads of the API (role mirror_reader). Search runs two channels over
 * decision_chunk, as Vlastní zdroje does: the lexical one (tsvector built by
 * the application, query by buildTsQuery — AND of the terms, OR when AND
 * finds nothing) and the identifier one (ident_keys && the query's sp. zn. /
 * § / ECLI keys). Each decision ranks by its best chunk; the hit carries
 * that chunk's excerpt with the matches marked.
 *
 * With a RUM index on the courts' chunks (`rum`), the lexical channel ranks
 * only the RUM_CANDIDATES chunks the index orders first (its own ts_rank
 * distance) instead of every matching chunk: a common phrase ("bezdůvodné
 * obohacení") matches hundreds of thousands of chunks, ranked in a minute.
 * The pilot on NS kept 18–20 of the top 20 decisions at 5,000 candidates.
 * Filters (court, date, category) apply after that cut.
 */

export const MAX_LIMIT = 50;
export const EXCERPT_CHARS = 400;
const RANK_WEIGHTS = "{0.05,0.12,0.2,1.0}";
/** One identifier match counts like a strong lexical match. */
const IDENT_SCORE = 0.5;
export const RUM_CANDIDATES = 5000;

export interface SearchInput {
  q?: string;
  /** Any of these courts; none = all. */
  sources?: MirrorSource[];
  court?: string;
  type?: DecisionType;
  from?: string;
  to?: string;
  /** A case number the decision must carry or cite ("I. ÚS 1169/26"). */
  caseNumber?: string;
  /** NS categories, any of them (["A", "B"]). */
  categories?: string[];
  limit?: number;
  /** Every searched court's chunks have the RUM index (decision_chunk_<source>_tsv_rum). */
  rum?: boolean;
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

async function runChannel(db: Queryable, input: SearchInput, tsquery: string | null, keys: string[], caseKeys: string[]): Promise<ChunkRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_LIMIT);
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH q AS (SELECT CASE WHEN $1::text IS NULL THEN NULL ELSE to_tsquery('simple', $1::text) END AS tsq),
     candidates AS (${
       input.rum
         ? // The tsquery spelled out, not from q: the index orders by a constant, not by a joined value.
           `(SELECT c.source, c.decision_id, c.char_start, c.char_end, c.tsv, c.ident_keys
             FROM mirror.decision_chunk c
             WHERE ($3::text[] IS NULL OR c.source = ANY($3)) AND $1::text IS NOT NULL AND c.tsv @@ to_tsquery('simple', $1::text)
             ORDER BY c.tsv <=> to_tsquery('simple', $1::text) LIMIT ${RUM_CANDIDATES})
            UNION ALL
            SELECT c.source, c.decision_id, c.char_start, c.char_end, c.tsv, c.ident_keys
            FROM mirror.decision_chunk c
            WHERE ($3::text[] IS NULL OR c.source = ANY($3)) AND cardinality($2::text[]) > 0 AND c.ident_keys && $2::text[]`
         : `SELECT c.source, c.decision_id, c.char_start, c.char_end, c.tsv, c.ident_keys
            FROM mirror.decision_chunk c, q
            WHERE ($3::text[] IS NULL OR c.source = ANY($3))  -- prunes to the courts' partitions
              AND ((q.tsq IS NOT NULL AND c.tsv @@ q.tsq) OR (cardinality($2::text[]) > 0 AND c.ident_keys && $2::text[]))`
     }),
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
              b.score, b.char_start, b.char_end
       FROM best b
       JOIN mirror.decision d ON d.id = b.decision_id
       WHERE ($3::text[] IS NULL OR d.source = ANY($3))
         AND ($4::text IS NULL OR d.court ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR d.decision_type = $5)
         AND ($6::date IS NULL OR d.decided_on >= $6)
         AND ($7::date IS NULL OR d.decided_on <= $7)
         AND (cardinality($8::text[]) = 0 OR EXISTS (
               SELECT 1 FROM mirror.decision_chunk c2 WHERE c2.decision_id = d.id AND c2.ident_keys && $8::text[]))
         AND (cardinality($10::text[]) = 0 OR d.category = ANY($10::text[]))
       ORDER BY b.score DESC, d.decided_on DESC NULLS LAST
       LIMIT $9
     )
     -- The text only for the hits kept, not for every candidate.
     SELECT r.source, r.source_id, r.case_number, r.court, r.decision_type, r.category, r.decided_on::text, r.published_on::text, r.ecli, r.url,
            r.score::float8 AS score, r.char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = r.id) AS dissent_starts,
            substr(t.body, r.char_start + 1, r.char_end - r.char_start) AS chunk
     FROM top r
     JOIN mirror.decision_text t ON t.decision_id = r.id
     ORDER BY r.score DESC, r.decided_on DESC NULLS LAST`,
    [tsquery, keys, input.sources?.length ? input.sources : null, input.court ?? null, input.type ?? null, input.from ?? null, input.to ?? null, caseKeys, limit, input.categories ?? []],
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
async function runBm25(db: Queryable, input: SearchInput, text: string, all: boolean, tsquery: string | null): Promise<ChunkRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_LIMIT);
  const params: unknown[] = [text, tsquery, limit];
  // Filters spelled out only when given: the index takes them in, an "$n IS NULL OR …" it would not.
  const where = [`t.body ${all ? "&&&" : "|||"} $1::text`];
  if (input.sources?.length) where.push(`t.source = ANY($${params.push(input.sources)}::text[])`);
  if (input.type) where.push(`t.decision_type = $${params.push(input.type)}`);
  if (input.from) where.push(`t.decided_on >= $${params.push(input.from)}::date`);
  if (input.to) where.push(`t.decided_on <= $${params.push(input.to)}::date`);
  if (input.categories?.length) where.push(`t.category = ANY($${params.push(input.categories)}::text[])`);
  const { rows } = await db.query<ChunkRow & Record<string, unknown>>(
    `WITH top AS (
       SELECT t.decision_id, pdb.score(t.decision_id) AS score
       FROM mirror.decision_text t
       WHERE ${where.join(" AND ")}
       ORDER BY pdb.score(t.decision_id) DESC
       LIMIT $3
     ),
     best AS (
       SELECT DISTINCT ON (c.decision_id) c.decision_id, c.char_start, c.char_end
       FROM top JOIN mirror.decision_chunk c ON c.decision_id = top.decision_id
       ORDER BY c.decision_id,
                coalesce(ts_rank_cd('${RANK_WEIGHTS}'::float4[], c.tsv, to_tsquery('simple', $2::text)), 0) DESC, c.char_start
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on::text, d.published_on::text, d.ecli, d.url,
            top.score::float8 AS score, coalesce(b.char_start, 0) AS char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = d.id) AS dissent_starts,
            substr(t.body, coalesce(b.char_start, 0) + 1, coalesce(b.char_end - b.char_start, ${EXCERPT_CHARS * 4})) AS chunk
     FROM top
     JOIN mirror.decision d ON d.id = top.decision_id
     JOIN mirror.decision_text t ON t.decision_id = top.decision_id
     LEFT JOIN best b ON b.decision_id = top.decision_id
     ORDER BY top.score DESC, d.decided_on DESC NULLS LAST`,
    params,
  );
  return rows;
}

export async function searchDecisions(db: Queryable, input: SearchInput): Promise<SearchResult> {
  const p = plan(input);
  const keys = [...new Set([...p.keys, ...p.caseKeys])];
  if (!p.tsAnd && keys.length === 0) return { hits: [], channel: null, terms: [], identKeys: [] };
  // BM25 for words alone; identifiers (sp. zn., §, the case filter) and the court-name filter keep the chunk channels.
  const words = input.q ? stripIdentifiers(input.q).trim() : "";
  if (input.bm25 && p.tsAnd && words && keys.length === 0 && !input.court) {
    let rows = await runBm25(db, input, words, true, p.tsAnd);
    let channel: SearchResult["channel"] = "and";
    if (rows.length === 0) {
      channel = "or";
      rows = await runBm25(db, input, words, false, p.tsOr ?? p.tsAnd);
    }
    return { hits: rows.map((r) => toHit(r, p.terms, [])), channel, terms: p.terms, identKeys: [] };
  }
  // The case filter alone is not a search query; with nothing else, it lists that case's decisions.
  const rankKeys = p.tsAnd || p.keys.length ? p.keys : p.caseKeys;
  let channel: SearchResult["channel"] = p.tsAnd ? "and" : "ident";
  let rows = await runChannel(db, input, p.tsAnd, rankKeys, p.caseKeys);
  if (rows.length === 0 && p.tsOr) {
    channel = "or";
    rows = await runChannel(db, input, p.tsOr, rankKeys, p.caseKeys);
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
                      FROM mirror.decision_image i JOIN mirror.image_blob b ON b.sha256 = i.sha256 WHERE i.decision_id = d.id), '[]'::json) AS images
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
