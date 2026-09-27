import "server-only";
import type { DocType } from "../types";
import { DOC_TYPES } from "../types";
import type { Queryable } from "./client";
import { num, numOrNull } from "./codec";
import { isUuid } from "./documents";

/**
 * Retrieval over the chunks of 'ready', enabled documents. Four channels,
 * one SQL statement each, fused in TS with weighted reciprocal-rank fusion:
 *
 *   and   every query term (prefix) in one chunk          weight 1.0
 *   or    any query term                                   weight 0.5
 *   idn   identifier keys (sp. zn., ECLI, §, act, ISBN…)   weight 1.5
 *   meta  document-level meta_tsv (title, authors, outline) weight 0.8
 *
 * Crowding: a 3,000-page commentary can have hundreds of matching chunks.
 * Each chunk channel therefore caps hits PER DOCUMENT inside SQL, before the
 * LIMIT (row_number() OVER (PARTITION BY doc_id) <= perDoc), and reports the
 * uncapped count (count(*) OVER (PARTITION BY doc_id)) for "další shody: N".
 *
 * Isolation: every statement filters library_id = ANY($1) on chunks AND on
 * documents; RLS is the backstop. The tsquery strings come from
 * buildTsQuery (sanitized lexemes only) and travel as parameters; a string
 * that builder could not have produced is refused (isWellFormedTsQuery), so
 * a bug upstream cannot abort the transaction with a tsquery syntax error.
 */

export interface SearchParams {
  libraryIds: string[];
  tsAnd: string | null;
  tsOr: string | null;
  identKeys: string[];
  docTypes?: DocType[] | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  /** "zak:89/2012" / "eu:32016R0679" — commentaries on it, or chunks citing a § of it (parz: keys). */
  act?: string | null;
  docId?: string | null;
  /** Hits per document and channel (default 3). */
  perDoc: number;
  /** Channel depth (default 60). */
  limit: number;
}

export type Channel = "and" | "or" | "idn" | "meta";

export interface ChannelHit {
  channel: Channel;
  docId: string;
  /** null for the document-level meta channel. */
  chunkOrd: number | null;
  /** 1-based position in the channel's result list. */
  rank: number;
  /** Matching chunks of this document in this channel before the per-doc cap (1 for meta). */
  perDocTotal: number;
}

export const CHANNEL_WEIGHTS: Record<Channel, number> = { and: 1.0, or: 0.5, idn: 1.5, meta: 0.8 };
export const RRF_K = 60;

/** ts_rank_cd weights {D, C, B, A}: footnotes, body, parent heading, own heading. */
const RANK_WEIGHTS = "'{0.05,0.12,0.2,1.0}'::float4[]";

const MAX_TSQUERY_CHARS = 4_000;
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);
const ACT_RE = /^(zak:[0-9]{1,4}\/[0-9]{4}|eu:[0-9]{5}[A-Z][0-9]{4})$/;
const MAX_KEYS = 100;

function safeTsQuery(q: string | null): string | null {
  return q && isWellFormedTsQuery(q) ? q : null;
}

/** Tokens of the tsquery subset buildTsQuery emits. */
const TSQ_TOKEN = /\s*(?:('[a-z0-9]+'|[a-z0-9]+)(?::\*?[ABCD]*)?|(<->|<[0-9]{1,4}>|[&|!()]))/y;

/**
 * True when `q` is a well-formed tsquery built ONLY from what buildTsQuery
 * emits: [a-z0-9] lexemes (optionally quoted) with an optional `:*` prefix
 * marker and A–D weights, `!`, `&`, `|`, `<->` / `<N>` and balanced
 * parentheses. Anything else is refused before it reaches to_tsquery, whose
 * syntax errors would abort the caller's transaction. Pure.
 */
export function isWellFormedTsQuery(q: string): boolean {
  const text = q.trim();
  if (text.length === 0 || q.length > MAX_TSQUERY_CHARS) return false;
  const tokens: string[] = [];
  let at = 0;
  while (at < text.length) {
    TSQ_TOKEN.lastIndex = at;
    const m = TSQ_TOKEN.exec(text);
    if (!m) return false;
    tokens.push(m[1] !== undefined ? "L" : m[2]);
    at = TSQ_TOKEN.lastIndex;
  }
  // Grammar: expr := unary (binop unary)*; unary := "!" unary | "(" expr ")" | L.
  let i = 0;
  const unary = (): boolean => {
    const tok = tokens[i];
    if (tok === "!") {
      i++;
      return unary();
    }
    if (tok === "(") {
      i++;
      if (!expr() || tokens[i] !== ")") return false;
      i++;
      return true;
    }
    if (tok === "L") {
      i++;
      return true;
    }
    return false;
  };
  const isBinary = (tok: string | undefined) => tok === "&" || tok === "|" || (tok !== undefined && tok.startsWith("<"));
  const expr = (): boolean => {
    if (!unary()) return false;
    while (isBinary(tokens[i])) {
      i++;
      if (!unary()) return false;
    }
    return true;
  };
  return tokens.length > 0 && expr() && i === tokens.length;
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
}

/** "par:2913" / "par:2913/2" → "sec:par:2913": chunks INSIDE § 2913 rank above chunks citing it. */
export function sectionKeysFor(identKeys: string[]): string[] {
  const out = new Set<string>();
  for (const k of identKeys) {
    const m = /^par:([0-9]+[a-z]?)(?:\/|$)/.exec(k);
    if (m) out.add(`sec:par:${m[1]}`);
  }
  return [...out];
}

/** The query's parz: keys of `act` ("zak:89/2012" → keys starting "parz:89/2012/"). */
function parzKeysFor(act: string, identKeys: string[]): string[] {
  const prefix = `parz:${act.replace(/^zak:/, "")}/`;
  return identKeys.filter((k) => k.startsWith(prefix));
}

interface Filters {
  params: unknown[];
  /** SQL conditions on documents `d` (and, for chunk channels, chunks `c`). */
  where: string[];
}

/** Library, status, enabled and the optional filters. $1 is always the library list. */
function filters(p: SearchParams, chunkLevel: boolean): Filters {
  const params: unknown[] = [p.libraryIds];
  const where = ["d.library_id = ANY($1::text[])", "d.status = 'ready'", "d.enabled"];
  if (chunkLevel) where.unshift("c.library_id = ANY($1::text[])");
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (p.docTypes && p.docTypes.length > 0) {
    where.push(`d.doc_type = ANY(${add(p.docTypes.filter((t) => DOC_TYPE_SET.has(t)))}::text[])`);
  }
  if (typeof p.yearFrom === "number" && Number.isFinite(p.yearFrom)) where.push(`d.year >= ${add(Math.floor(p.yearFrom))}::int`);
  if (typeof p.yearTo === "number" && Number.isFinite(p.yearTo)) where.push(`d.year <= ${add(Math.floor(p.yearTo))}::int`);
  if (p.docId) where.push(`d.id = ${add(p.docId)}::uuid`);
  if (p.act) {
    const act = add(p.act);
    const parz = parzKeysFor(p.act, p.identKeys);
    if (parz.length === 0) where.push(`d.commented_act = ${act}`);
    else {
      const keys = add(parz);
      where.push(`(d.commented_act = ${act} OR ${chunkLevel ? "c" : "d"}.ident_keys && ${keys}::text[])`);
    }
  }
  return { params, where };
}

async function chunkChannel(
  db: Queryable,
  p: SearchParams,
  channel: Channel,
  score: (add: (v: unknown) => string) => { score: string; match: string },
): Promise<ChannelHit[]> {
  const f = filters(p, true);
  const add = (value: unknown) => {
    f.params.push(value);
    return `$${f.params.length}`;
  };
  const s = score(add);
  const perDoc = add(clampInt(p.perDoc, 1, 20, 3));
  const limit = add(clampInt(p.limit, 1, 200, 60));
  const { rows } = await db.query(
    `WITH hits AS (
       SELECT c.doc_id, c.ord, ${s.score} AS score
         FROM chunks c JOIN documents d ON d.id = c.doc_id AND d.library_id = c.library_id
        WHERE ${[...f.where, s.match].join(" AND ")}
     ), capped AS (
       SELECT doc_id, ord, score,
              row_number() OVER (PARTITION BY doc_id ORDER BY score DESC, ord) AS rn,
              count(*) OVER (PARTITION BY doc_id) AS per_doc_total
         FROM hits
     )
     SELECT doc_id, ord, per_doc_total FROM capped
      WHERE rn <= ${perDoc}::int
      ORDER BY score DESC, doc_id, ord
      LIMIT ${limit}::int`,
    f.params,
  );
  return rows.map((r, i) => ({
    channel,
    docId: String(r.doc_id),
    chunkOrd: numOrNull(r.ord),
    rank: i + 1,
    perDocTotal: num(r.per_doc_total),
  }));
}

function lexChannel(db: Queryable, p: SearchParams, channel: "and" | "or", q: string): Promise<ChannelHit[]> {
  return chunkChannel(db, p, channel, (add) => {
    const tq = `to_tsquery('simple', ${add(q)})`;
    return { score: `ts_rank_cd(${RANK_WEIGHTS}, c.tsv, ${tq})`, match: `c.tsv @@ ${tq}` };
  });
}

function idnChannel(db: Queryable, p: SearchParams, keys: string[]): Promise<ChannelHit[]> {
  const sec = sectionKeysFor(keys);
  return chunkChannel(db, p, "idn", (add) => {
    const k = add(keys);
    const s = add(sec);
    const all = add([...new Set([...keys, ...sec])]);
    return {
      // One point per matching key, three per section key: the § itself before chunks that cite it.
      score:
        `((SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY(${k}::text[]))` +
        ` + 3 * (SELECT count(*) FROM unnest(c.ident_keys) x WHERE x = ANY(${s}::text[])))::float8`,
      match: `c.ident_keys && ${all}::text[]`,
    };
  });
}

async function metaChannel(db: Queryable, p: SearchParams, q: string): Promise<ChannelHit[]> {
  const f = filters(p, false);
  f.params.push(q);
  const tq = `to_tsquery('simple', $${f.params.length})`;
  f.params.push(clampInt(p.limit, 1, 200, 60));
  const { rows } = await db.query(
    `SELECT d.id AS doc_id, ts_rank_cd(${RANK_WEIGHTS}, d.meta_tsv, ${tq}) AS score
       FROM documents d
      WHERE ${f.where.join(" AND ")} AND d.meta_tsv @@ ${tq}
      ORDER BY score DESC, d.id
      LIMIT $${f.params.length}::int`,
    f.params,
  );
  return rows.map((r, i) => ({ channel: "meta" as const, docId: String(r.doc_id), chunkOrd: null, rank: i + 1, perDocTotal: 1 }));
}

/**
 * Run the channels that have input, sequentially in the caller's
 * transaction: and/meta need tsAnd, or needs tsOr, idn needs identKeys.
 * Returns the hits of all channels (fuse() combines them). Invalid filters
 * (a malformed docId or act) match nothing rather than failing.
 */
export async function searchChannels(db: Queryable, p: SearchParams): Promise<ChannelHit[]> {
  if (p.libraryIds.length === 0) return [];
  if (p.docId && !isUuid(p.docId)) return [];
  if (p.act && !ACT_RE.test(p.act)) return [];
  const identKeys = [...new Set(p.identKeys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 200))].slice(0, MAX_KEYS);
  const params = { ...p, identKeys };
  const tsAnd = safeTsQuery(p.tsAnd);
  const tsOr = safeTsQuery(p.tsOr);
  const hits: ChannelHit[] = [];
  if (tsAnd) hits.push(...(await lexChannel(db, params, "and", tsAnd)));
  if (tsOr) hits.push(...(await lexChannel(db, params, "or", tsOr)));
  if (identKeys.length > 0) hits.push(...(await idnChannel(db, params, identKeys)));
  if (tsAnd) hits.push(...(await metaChannel(db, params, tsAnd)));
  return hits;
}

export interface FusedDoc {
  docId: string;
  score: number;
  /** Best chunks, by fused chunk score (ties: earlier chunk first). */
  chunks: Array<{ ord: number; score: number }>;
  /** Channels that hit the document, in the order and, or, idn, meta. */
  matchedBy: string[];
  /** Further matching chunks not shown ("další shody: N"). */
  moreInDoc: number;
}

const CHANNEL_ORDER: Channel[] = ["and", "or", "idn", "meta"];

/**
 * Weighted reciprocal-rank fusion (k = 60). A chunk scores the sum of
 * weight / (k + rank) over the channels that returned it; a document scores
 * its best chunk plus its meta-channel contribution — so many mediocre
 * chunks of one long document do not outscore one good chunk elsewhere.
 * Keeps the best `perDoc` (default 2) chunks per document. Sorted by score,
 * then docId for determinism. Pure.
 */
export function fuse(hits: ChannelHit[], opts?: { perDoc?: number }): FusedDoc[] {
  const perDoc = clampInt(opts?.perDoc ?? 2, 1, 50, 2);
  const docs = new Map<
    string,
    { meta: number; chunks: Map<number, number>; channels: Set<Channel>; maxTotal: number }
  >();
  for (const h of hits) {
    if (!Object.hasOwn(CHANNEL_WEIGHTS, h.channel) || !(h.rank >= 1)) continue;
    const weight = CHANNEL_WEIGHTS[h.channel];
    let d = docs.get(h.docId);
    if (!d) {
      d = { meta: 0, chunks: new Map(), channels: new Set(), maxTotal: 0 };
      docs.set(h.docId, d);
    }
    const contribution = weight / (RRF_K + h.rank);
    d.channels.add(h.channel);
    if (h.chunkOrd === null) {
      d.meta += contribution;
    } else {
      d.chunks.set(h.chunkOrd, (d.chunks.get(h.chunkOrd) ?? 0) + contribution);
      d.maxTotal = Math.max(d.maxTotal, h.perDocTotal);
    }
  }
  const out: FusedDoc[] = [];
  for (const [docId, d] of docs) {
    const ranked = [...d.chunks].map(([ord, score]) => ({ ord, score })).sort((a, b) => b.score - a.score || a.ord - b.ord);
    const shown = ranked.slice(0, perDoc);
    const known = Math.max(d.maxTotal, ranked.length);
    out.push({
      docId,
      score: (ranked[0]?.score ?? 0) + d.meta,
      chunks: shown,
      matchedBy: CHANNEL_ORDER.filter((c) => d.channels.has(c)),
      moreInDoc: Math.max(0, known - shown.length),
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
}

/** Offsets and position data of the given chunks (only those in `libraryIds`), in request order. */
export async function loadChunks(
  db: Queryable,
  libraryIds: string[],
  keys: Array<{ docId: string; ord: number }>,
): Promise<
  Array<{
    docId: string;
    ord: number;
    start: number;
    end: number;
    pageFrom: number | null;
    pageTo: number | null;
    sectionOrd: number | null;
    anchorFrom: string | null;
    anchorTo: string | null;
  }>
> {
  const valid = keys.filter((k) => isUuid(k.docId) && Number.isInteger(k.ord)).slice(0, 500);
  if (valid.length === 0 || libraryIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT c.doc_id, c.ord, c.char_start, c.char_end, c.page_from, c.page_to, c.section_ord, c.anchor_from, c.anchor_to
       FROM unnest($2::uuid[], $3::int[]) WITH ORDINALITY AS k(doc_id, ord, n)
       JOIN chunks c ON c.doc_id = k.doc_id AND c.ord = k.ord
      WHERE c.library_id = ANY($1::text[])
      ORDER BY k.n`,
    [libraryIds, valid.map((k) => k.docId.toLowerCase()), valid.map((k) => k.ord)],
  );
  return rows.map((r) => ({
    docId: String(r.doc_id),
    ord: num(r.ord),
    start: num(r.char_start),
    end: num(r.char_end),
    pageFrom: numOrNull(r.page_from),
    pageTo: numOrNull(r.page_to),
    sectionOrd: numOrNull(r.section_ord),
    anchorFrom: (r.anchor_from as string | null) ?? null,
    anchorTo: (r.anchor_to as string | null) ?? null,
  }));
}
