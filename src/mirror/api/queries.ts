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
 */

export const MAX_LIMIT = 50;
export const EXCERPT_CHARS = 400;
const RANK_WEIGHTS = "{0.05,0.12,0.2,1.0}";
/** One identifier match counts like a strong lexical match. */
const IDENT_SCORE = 0.5;

export interface SearchInput {
  q?: string;
  source?: MirrorSource;
  court?: string;
  type?: DecisionType;
  from?: string;
  to?: string;
  /** A case number the decision must carry or cite ("I. ÚS 1169/26"). */
  caseNumber?: string;
  limit?: number;
}

/** The shape of caselaw_search's AggregatedHit, plus the local fields. */
export interface MirrorHit {
  source: MirrorSource;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: DecisionType | null;
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
     matched AS (
       SELECT c.source, c.decision_id, c.char_start, c.char_end,
              coalesce(ts_rank_cd('${RANK_WEIGHTS}'::float4[], c.tsv, q.tsq), 0)
                + ${IDENT_SCORE} * cardinality(ARRAY(SELECT unnest(c.ident_keys) INTERSECT SELECT unnest($2::text[]))) AS score
       FROM mirror.decision_chunk c, q
       WHERE ($3::text IS NULL OR c.source = $3)  -- prunes to one partition
         AND ((q.tsq IS NOT NULL AND c.tsv @@ q.tsq) OR (cardinality($2::text[]) > 0 AND c.ident_keys && $2::text[]))
     ),
     best AS (
       SELECT DISTINCT ON (m.decision_id) m.* FROM matched m ORDER BY m.decision_id, m.score DESC, m.char_start
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.decided_on::text, d.published_on::text, d.ecli, d.url,
            b.score::float8 AS score, b.char_start,
            (SELECT array_agg(x.char_start ORDER BY x.ord) FROM mirror.decision_dissent x WHERE x.decision_id = d.id) AS dissent_starts,
            substr(t.body, b.char_start + 1, b.char_end - b.char_start) AS chunk
     FROM best b
     JOIN mirror.decision d ON d.id = b.decision_id
     JOIN mirror.decision_text t ON t.decision_id = d.id
     WHERE ($3::text IS NULL OR d.source = $3)
       AND ($4::text IS NULL OR d.court ILIKE '%' || $4 || '%')
       AND ($5::text IS NULL OR d.decision_type = $5)
       AND ($6::date IS NULL OR d.decided_on >= $6)
       AND ($7::date IS NULL OR d.decided_on <= $7)
       AND (cardinality($8::text[]) = 0 OR EXISTS (
             SELECT 1 FROM mirror.decision_chunk c2 WHERE c2.decision_id = d.id AND c2.ident_keys && $8::text[]))
     ORDER BY b.score DESC, d.decided_on DESC NULLS LAST
     LIMIT $9`,
    [tsquery, keys, input.source ?? null, input.court ?? null, input.type ?? null, input.from ?? null, input.to ?? null, caseKeys, limit],
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

export async function searchDecisions(db: Queryable, input: SearchInput): Promise<SearchResult> {
  const p = plan(input);
  const keys = [...new Set([...p.keys, ...p.caseKeys])];
  if (!p.tsAnd && keys.length === 0) return { hits: [], channel: null, terms: [], identKeys: [] };
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
    `SELECT d.source, d.source_id, d.case_number, d.case_numbers, d.court, d.decision_type, d.decided_on::text AS decided_on,
            d.published_on::text AS published_on, d.ecli, d.legal_sentence, d.url, d.first_seen_at, d.last_changed_at, d.gone_at,
            t.body, t.text_source,
            coalesce((SELECT json_agg(json_build_object('ord', x.ord, 'charStart', x.char_start, 'charEnd', x.char_end,
                                                        'heading', x.heading) ORDER BY x.ord)
                      FROM mirror.decision_dissent x WHERE x.decision_id = d.id), '[]'::json) AS dissents,
            coalesce((SELECT json_agg(json_build_object('ord', i.ord, 'charAt', i.char_at, 'mime', i.mime, 'width', i.width,
                                                        'height', i.height, 'bytes', length(i.bytes)) ORDER BY i.ord)
                      FROM mirror.decision_image i WHERE i.decision_id = d.id), '[]'::json) AS images
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
    `SELECT i.mime, i.bytes, i.sha256 FROM mirror.decision_image i JOIN mirror.decision d ON d.id = i.decision_id
     WHERE d.source = $1 AND d.source_id = $2 AND i.ord = $3`,
    [source, id, ord],
  );
  return rows[0] ?? null;
}

/** All pictures with their bytes (for the HTML rendering, which inlines them). */
export async function getImages(db: Queryable, source: MirrorSource, id: string) {
  const { rows } = await db.query<{ ord: number; char_at: number; mime: string; width: number | null; height: number | null; bytes: Uint8Array }>(
    `SELECT i.ord, i.char_at, i.mime, i.width, i.height, i.bytes FROM mirror.decision_image i
     JOIN mirror.decision d ON d.id = i.decision_id WHERE d.source = $1 AND d.source_id = $2 ORDER BY i.ord`,
    [source, id],
  );
  return rows;
}
