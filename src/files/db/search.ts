import "server-only";
import type { DocType } from "../types";
import { DOC_TYPES } from "../types";
import type { Queryable } from "./client";
import { num, numOrNull } from "./codec";
import { isUuid } from "./documents";

/**
 * Retrieval over the chunks of 'ready', enabled documents. Four channels,
 * sent as ONE SQL statement (UNION ALL, each channel's rank from WITH
 * ORDINALITY) and fused in TS with weighted reciprocal-rank fusion:
 *
 *   and   every query term (prefix) in one chunk          weight 1.0
 *   or    any query term                                   weight 0.5
 *   idn   identifier keys (sp. zn., ECLI, §, act, ISBN…)   weight 1.5
 *   meta  document-level meta_tsv (title, authors, outline)
 *         or the document's own isbn: / doi: keys          weight 0.8
 *
 * One statement, not one per channel: node-postgres sends one query per
 * round trip, and the channels are independent (statement_timeout now
 * bounds them together — each costs ≤ ~0.8 s on 50k chunks, 0004).
 *
 * Crowding: a 3,000-page commentary can have hundreds of matching chunks.
 * Each chunk channel therefore caps hits PER DOCUMENT inside SQL, before the
 * LIMIT (row_number() OVER (PARTITION BY doc_id) <= perDoc), and reports the
 * uncapped count (count(*) OVER (PARTITION BY doc_id)) for "další shody: N".
 * The filters that narrow passages — case_number (`require`) and section —
 * apply before that cap, inside SQL (0005_search_filters.sql).
 *
 * The statements live in SECURITY DEFINER functions (files_search_chunks,
 * files_search_meta — 0004_search.sql, the overloads of 0005): under FORCE
 * RLS the planner cannot use the GIN indexes for `@@` / `&&` (not
 * leakproof), so as dawmain_app a search read every chunk in scope. The
 * functions run as the owner and so reach the indexes; they return ids,
 * ordinals and counts only.
 *
 * Isolation: the functions filter chunks AND documents to the libraries in
 * both files_scope() — the policy's own scope, taken from the transaction —
 * and $1 (the caller's filter). The tsquery strings come from
 * buildTsQuery (sanitized lexemes only) and travel as parameters; a string
 * that builder could not have produced is refused (isWellFormedTsQuery), so
 * a bug upstream cannot abort the transaction with a tsquery syntax error.
 */

export interface SearchParams {
  libraryIds: string[];
  tsAnd: string | null;
  tsOr: string | null;
  identKeys: string[];
  /**
   * The meta channel's query. Unweighted: in meta_tsv the weights mean title
   * (A), authors (B), keywords (C) and outline (D), not body and footnotes,
   * so the chunk channels' in_footnotes weights must not reach it. null
   * skips the channel (unless metaKeys); omitted: tsAnd without its weights.
   */
  tsMeta?: string | null;
  /** isbn: / doi: keys the meta channel matches against the documents' own keys. */
  metaKeys?: string[];
  /** A chunk must carry one of these keys (case_number: the decision's keys). Before the per-document cap. */
  require?: string[];
  /** "par:2913" / "cl:III": only chunks inside that § / článek (ancestors included). Before the per-document cap. */
  section?: string | null;
  docTypes?: DocType[] | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  /** "zak:89/2012" / "eu:32016R0679" — commentaries on it, or chunks citing it (see actFilter). */
  act?: string | null;
  docId?: string | null;
  /** Hits per document and channel (default 3, at most 200). */
  perDoc: number;
  /** Channel depth (default 60, at most 200). */
  limit: number;
}

export type Channel = "and" | "or" | "idn" | "meta";

export interface ChannelHit {
  channel: Channel;
  docId: string;
  /** The document's library (the functions return it with the id). */
  libraryId?: string;
  /** null for the document-level meta channel. */
  chunkOrd: number | null;
  /** 1-based position in the channel's result list. */
  rank: number;
  /** Matching chunks of this document in this channel before the per-doc cap (1 for meta). */
  perDocTotal: number;
  /** meta only: matched by an isbn: / doi: key of the document, not by its words. */
  byKey?: boolean;
}

export const CHANNEL_WEIGHTS: Record<Channel, number> = { and: 1.0, or: 0.5, idn: 1.5, meta: 0.8 };
const CHANNEL_ORDER: Channel[] = ["and", "or", "idn", "meta"];
export const RRF_K = 60;

const MAX_TSQUERY_CHARS = 4_000;
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);
const ACT_RE = /^(zak:[0-9]{1,4}\/[0-9]{4}|eu:[0-9]{5}[A-Z][0-9]{4})$/;
/** A section key as sectionKeyOf writes it for a § / článek. */
const SECTION_RE = /^(par|cl):[0-9A-Za-z]{1,12}$/;
const MAX_KEYS = 100;
/** The metadata keys a query can match documents by (sz: / ecli: there mix with the keys of every citing document). */
const META_KEY_RE = /^(isbn|doi):/;

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

/**
 * The act filter as the search functions take it (0004_search.sql): a
 * commentary on the act always passes; otherwise a chunk passes when it
 * cites the act. With a § of the act in the query ("§ 2913 OZ") that means
 * citing THAT § (its parz: keys); without one, citing any § of the act
 * (the "parz:89/2012/" prefix) or the act by number ("zak:89/2012").
 */
function actFilter(act: string | null | undefined, identKeys: string[]): { act: string | null; keys: string[]; prefix: string | null } {
  if (!act) return { act: null, keys: [], prefix: null };
  const parz = parzKeysFor(act, identKeys);
  if (parz.length > 0) return { act, keys: parz, prefix: null };
  return { act, keys: [act], prefix: act.startsWith("zak:") ? `parz:${act.slice(4)}/` : null };
}

/** Keys as the functions take them: strings of sane length, deduplicated, capped. */
function cleanKeys(keys: readonly string[] | null | undefined): string[] {
  return [...new Set((keys ?? []).filter((k) => typeof k === "string" && k.length > 0 && k.length <= 200))].slice(0, MAX_KEYS);
}

/** The tsquery minus its weights ('x':*D → 'x':*, 'x':AB → 'x'), for the meta channel. */
function unweighted(q: string | null): string | null {
  return q ? q.replace(/:\*[A-D]+/g, ":*").replace(/'(:[A-D]+)/g, "'").replace(/([a-z0-9]):[A-D]+/g, "$1") : null;
}

/**
 * Run the channels that have input in ONE statement in the caller's
 * transaction: and needs tsAnd, or tsOr, idn identKeys, meta tsMeta or
 * metaKeys. Returns the hits of all channels, each channel's in its own
 * rank order (fuse() combines them). Invalid filters (a malformed docId,
 * act or section) match nothing rather than failing.
 */
export async function searchChannels(db: Queryable, p: SearchParams): Promise<ChannelHit[]> {
  if (p.libraryIds.length === 0) return [];
  if (p.docId && !isUuid(p.docId)) return [];
  if (p.act && !ACT_RE.test(p.act)) return [];
  if (p.section && !SECTION_RE.test(p.section)) return [];
  const identKeys = cleanKeys(p.identKeys);
  const tsAnd = safeTsQuery(p.tsAnd);
  const tsOr = safeTsQuery(p.tsOr);
  const tsMeta = p.tsMeta === undefined ? safeTsQuery(unweighted(tsAnd)) : safeTsQuery(p.tsMeta);
  const metaKeys = cleanKeys(p.metaKeys).filter((k) => META_KEY_RE.test(k));

  const docTypes = p.docTypes && p.docTypes.length > 0 ? p.docTypes.filter((t) => DOC_TYPE_SET.has(t)) : null;
  const year = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);
  const act = actFilter(p.act, identKeys);
  // Positional parameters, each typed where it is used; one the branches share (scope,
  // filters) is sent once. Only what a branch uses is sent: an unreferenced parameter
  // has no type Postgres could infer.
  const params: unknown[] = [];
  const arg = (v: unknown, type: string) => {
    params.push(v);
    return `$${params.length}::${type}`;
  };
  const slots = new Map<string, string>();
  const shared = (name: string, v: unknown, type: string) => {
    let slot = slots.get(name);
    if (!slot) {
      slot = arg(v, type);
      slots.set(name, slot);
    }
    return slot;
  };
  const filters = () =>
    [
      shared("types", docTypes, "text[]"),
      shared("from", year(p.yearFrom), "int"),
      shared("to", year(p.yearTo), "int"),
      shared("doc", p.docId ?? null, "uuid"),
      shared("act", act.act, "text"),
      shared("actKeys", act.keys, "text[]"),
      shared("actPrefix", act.prefix, "text"),
    ].join(", ");
  const libs = () => shared("libs", p.libraryIds, "text[]");
  const limit = () => shared("limit", clampInt(p.limit, 1, 200, 60), "int");
  const chunks = (channel: Channel, query: string, keys: string, secKeys: string) =>
    `SELECT '${channel}'::text AS ch, r.doc_id, r.library_id, r.ord, r.per_doc_total, r.n, NULL::boolean AS by_key
       FROM files_search_chunks(${libs()}, ${query}, ${keys}, ${secKeys}, ${filters()},
                                ${shared("require", cleanKeys(p.require), "text[]")}, ${shared("section", p.section ?? null, "text")},
                                ${shared("perDoc", clampInt(p.perDoc, 1, 200, 3), "int")}, ${limit()})
            WITH ORDINALITY AS r(doc_id, library_id, ord, per_doc_total, n)`;
  const branches: string[] = [];
  if (tsAnd) branches.push(chunks("and", arg(tsAnd, "text"), "'{}'::text[]", "'{}'::text[]"));
  if (tsOr) branches.push(chunks("or", arg(tsOr, "text"), "'{}'::text[]", "'{}'::text[]"));
  if (identKeys.length > 0) branches.push(chunks("idn", "NULL::text", arg(identKeys, "text[]"), arg(sectionKeysFor(identKeys), "text[]")));
  if (tsMeta || metaKeys.length > 0) {
    branches.push(
      `SELECT 'meta'::text AS ch, r.doc_id, r.library_id, NULL::int AS ord, 1::bigint AS per_doc_total, r.n, r.by_key
         FROM files_search_meta(${libs()}, ${arg(tsMeta, "text")}, ${arg(metaKeys, "text[]")}, ${filters()}, ${limit()})
              WITH ORDINALITY AS r(doc_id, library_id, by_key, n)`,
    );
  }
  if (branches.length === 0) return [];
  const { rows } = await db.query(branches.join("\nUNION ALL\n"), params);
  // Regrouped by channel, in each channel's own order (UNION ALL promises no order across branches).
  const hits = rows.map((r) => ({
    channel: String(r.ch) as Channel,
    docId: String(r.doc_id),
    libraryId: String(r.library_id),
    chunkOrd: numOrNull(r.ord),
    rank: num(r.n),
    perDocTotal: num(r.per_doc_total),
    ...(r.ch === "meta" ? { byKey: r.by_key === true } : {}),
  }));
  return CHANNEL_ORDER.flatMap((c) => hits.filter((h) => h.channel === c).sort((a, b) => a.rank - b.rank));
}

export interface FusedChunk {
  ord: number;
  score: number;
  /** Channels that returned THIS chunk, in the order and, or, idn. */
  matchedBy: string[];
}

export interface FusedDoc {
  docId: string;
  /** The document's library, when the hits carried it. */
  libraryId: string | null;
  score: number;
  /** Best chunks, by fused chunk score (ties: earlier chunk first). */
  chunks: FusedChunk[];
  /** Channels that hit the document, in the order and, or, idn, meta. */
  matchedBy: string[];
  /** Further matching chunks not shown ("další shody: N"). */
  moreInDoc: number;
  /** The meta channel matched the document by an isbn: / doi: key of its metadata. */
  metaByKey: boolean;
}

/**
 * Weighted reciprocal-rank fusion (k = 60). A chunk scores the sum of
 * weight / (k + rank) over the channels that returned it; a document scores
 * its best chunk plus its meta-channel contribution — so many mediocre
 * chunks of one long document do not outscore one good chunk elsewhere.
 * Keeps the best `perDoc` (default 2; at most 600 = three chunk channels
 * × 200, so a search inside one document keeps all) chunks per document,
 * each with the channels that found it (a passage the or-fallback alone
 * found is no "and" match, whatever else hit its document). Sorted by
 * score, then docId for determinism. Pure.
 */
export function fuse(hits: ChannelHit[], opts?: { perDoc?: number }): FusedDoc[] {
  const perDoc = clampInt(opts?.perDoc ?? 2, 1, 600, 2);
  const docs = new Map<
    string,
    {
      libraryId: string | null;
      meta: number;
      metaByKey: boolean;
      chunks: Map<number, { score: number; channels: Set<Channel> }>;
      channels: Set<Channel>;
      maxTotal: number;
    }
  >();
  for (const h of hits) {
    if (!Object.hasOwn(CHANNEL_WEIGHTS, h.channel) || !(h.rank >= 1)) continue;
    const weight = CHANNEL_WEIGHTS[h.channel];
    let d = docs.get(h.docId);
    if (!d) {
      d = { libraryId: null, meta: 0, metaByKey: false, chunks: new Map(), channels: new Set(), maxTotal: 0 };
      docs.set(h.docId, d);
    }
    if (d.libraryId === null && typeof h.libraryId === "string") d.libraryId = h.libraryId;
    const contribution = weight / (RRF_K + h.rank);
    d.channels.add(h.channel);
    if (h.chunkOrd === null) {
      d.meta += contribution;
      if (h.byKey === true) d.metaByKey = true;
    } else {
      const c = d.chunks.get(h.chunkOrd) ?? { score: 0, channels: new Set<Channel>() };
      c.score += contribution;
      c.channels.add(h.channel);
      d.chunks.set(h.chunkOrd, c);
      d.maxTotal = Math.max(d.maxTotal, h.perDocTotal);
    }
  }
  const out: FusedDoc[] = [];
  for (const [docId, d] of docs) {
    const ranked = [...d.chunks]
      .map(([ord, c]) => ({ ord, score: c.score, matchedBy: CHANNEL_ORDER.filter((ch) => c.channels.has(ch)) }))
      .sort((a, b) => b.score - a.score || a.ord - b.ord);
    const shown = ranked.slice(0, perDoc);
    const known = Math.max(d.maxTotal, ranked.length);
    out.push({
      docId,
      libraryId: d.libraryId,
      score: (ranked[0]?.score ?? 0) + d.meta,
      chunks: shown,
      matchedBy: CHANNEL_ORDER.filter((c) => d.channels.has(c)),
      moreInDoc: Math.max(0, known - shown.length),
      metaByKey: d.metaByKey,
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
