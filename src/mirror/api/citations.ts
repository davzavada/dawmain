import { canonicalCaseNumber, findIdentSpans, queryIdentKeys } from "@/src/files/index/identifiers";
import type { Queryable } from "../db/client";
import type { DecisionType, MirrorSource } from "../types";

/**
 * Reads of the links between decisions (src/mirror/citations.ts): what a
 * decision cites — each key with the mirrored decisions carrying it, none
 * when the court is not mirrored (SDEU, a krajský soud) — and who cites it.
 * A sp. zn. shared by several decisions of one case links to each of them.
 */

export const CITED_BY_MAX_LIMIT = 100;

export interface LinkedDecision {
  source: MirrorSource;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: DecisionType | null;
  date: string | null;
}

export interface CitedKey {
  key: string;
  /** "IV. ÚS 296/24", "ECLI:CZ:NS:2020:…"; the key itself when it cannot be read back. */
  display: string;
  mentions: number;
  firstAt: number;
  decisions: LinkedDecision[];
}

export type CitedByOrder = "newest" | "courts";

export interface CitingDecision extends LinkedDecision {
  mentions: number;
  /** The citing decision's text around its first mention of the cited one. */
  excerpt?: string;
}

/** How many decisions cite one, by court; `top` = those that bind the others (see TOP_RANK). */
export interface CitedBySummary {
  total: number;
  bySource: Partial<Record<MirrorSource, number>>;
  top: number;
}

export interface DecisionLinks {
  /**
   * Decisions of ANOTHER court carrying the same spisová značka: a citation by
   * značka alone may mean any of them (the first few, and how many there are).
   */
  sameCaseNumber?: { total: number; decisions: LinkedDecision[] };
  cites: CitedKey[];
  citedBy: CitedBySummary & { hits: CitingDecision[]; order: CitedByOrder };
}

/**
 * The decisions citing `id` (a SQL expression of a decision's id), each once:
 * a citing decision that names two of its keys (sp. zn. and ECLI) counts once.
 */
const citingOf = (id: string): string =>
  `SELECT c.citing_id, sum(c.mentions)::int AS mentions, min(c.first_at) AS first_at
   FROM mirror.decision_key own JOIN mirror.decision_citation c ON c.key = own.key
   ${NOT_EARLIER}
   WHERE own.decision_id = ${id} AND c.citing_id <> ${id} AND ${NOT_EARLIER_WHERE}
   GROUP BY c.citing_id`;

/**
 * A decision cannot cite one decided after it. A spisová značka is a key
 * without its court, and 95 000 of them are carried by decisions of more than
 * one court ("8 Co 60/2025" of two krajské soudy): the citation of one was
 * counted for all of them — 85 760 links in which the citing decision is the
 * older one (production, 11/2026). The dates rule those out; where one of the
 * two is unknown the link stays.
 */
const NOT_EARLIER = `JOIN mirror.decision cited ON cited.id = own.decision_id JOIN mirror.decision citing ON citing.id = c.citing_id`;
const NOT_EARLIER_WHERE = `(citing.decided_on IS NULL OR cited.decided_on IS NULL OR citing.decided_on >= cited.decided_on)`;

/** How many decisions cite the decision whose id the SQL expression `id` gives — a scalar subquery. */
export const citedCount = (id: string): string =>
  `(SELECT count(DISTINCT c.citing_id)::int FROM mirror.decision_key own JOIN mirror.decision_citation c ON c.key = own.key
    ${NOT_EARLIER}
    WHERE own.decision_id = ${id} AND c.citing_id <> ${id} AND ${NOT_EARLIER_WHERE})`;

/**
 * Whose citation settles more, as a rank (0 first): a stanovisko, the plenum of
 * the Ústavní soud, the velký senát of the Nejvyšší soud (31 Cdo, 15 Tdo) and
 * the rozšířený senát of the NSS; then nálezy; then the other decisions of the
 * three top courts; then everyone else (obecné soudy, the krajské soudy the NSS
 * index carries). Newest-first lists of a decision cited often open with a
 * page of okresní soudy, and whether a velký senát took the decision up is the
 * first thing the reader asks.
 */
const TOP_RANK = 0;
const citingRank = (d: string): string =>
  `(CASE WHEN ${d}.decision_type = 'stanovisko'
          OR (${d}.source = 'us' AND ${d}.case_number LIKE 'Pl.%')
          OR (${d}.source = 'ns' AND (${d}.case_number LIKE '31 Cdo %' OR ${d}.case_number LIKE '15 Tdo %'))
          OR (${d}.source = 'nss' AND (${d}.court ILIKE '%rozšířen%' OR ${d}.court ILIKE '%RS NSS%')) THEN ${TOP_RANK}
         WHEN ${d}.source = 'us' AND ${d}.decision_type = 'nalez' THEN 1
         WHEN ${d}.source IN ('ns', 'us') THEN 2
         WHEN ${d}.source = 'nss' AND coalesce(${d}.court, 'Nejvyšší správní soud') ILIKE 'Nejvyšší správní soud%' THEN 2
         ELSE 3 END)`;

/** Characters of a citing decision's text shown around the citation. */
const CITING_BEFORE = 120;
const CITING_CHARS = 360;
/**
 * decision_citation.first_at is where the CHUNK naming the decision starts,
 * not the citation: chunks run to 2 400 characters, and the passage cut at
 * the chunk's start showed the citation in a minority of cases (five test
 * researches, 11/2026). The whole chunk is read and the citation found in it.
 */
const CITING_CHUNK_CHARS = 2400 + CITING_CHARS;

/** The text around the first mention of one of `keys` in `window`; its head when none is found. Pure. */
export function passageAround(window: string, keys: ReadonlySet<string>): string {
  const span = findIdentSpans(window).find((s) => s.keys.some((key) => keys.has(key)));
  const start = span ? Math.max(0, span.start - CITING_BEFORE) : 0;
  return window.slice(start, start + CITING_CHARS).replace(/\s+/g, " ").trim();
}

function summaryOf(rows: Record<string, unknown>[]): CitedBySummary {
  const bySource: Partial<Record<MirrorSource, number>> = {};
  let total = 0;
  let top = 0;
  for (const r of rows) {
    bySource[r.source as MirrorSource] = Number(r.n);
    total += Number(r.n);
    top += Number(r.top);
  }
  return { total, bySource, top };
}

/** Who cites a decision, counted by court — for a line in the decision's header; null = not in the mirror. */
export async function citedBySummary(db: Queryable, source: MirrorSource, id: string): Promise<CitedBySummary | null> {
  const found = await db.query<{ id: string }>("SELECT id::text FROM mirror.decision WHERE source = $1 AND source_id = $2", [source, id]);
  const decisionId = found.rows[0]?.id;
  if (decisionId === undefined) return null;
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH citing AS (${citingOf("$1")})
     SELECT d.source, count(*)::int AS n, (count(*) FILTER (WHERE ${citingRank("d")} = ${TOP_RANK}))::int AS top
     FROM citing JOIN mirror.decision d ON d.id = citing.citing_id GROUP BY d.source`,
    [decisionId],
  );
  return summaryOf(rows);
}

/**
 * What a hit list says of each decision beside its match: how long the text is
 * (so every page can be asked for at once) and how many decisions cite it (so
 * the leading one stands out). Keyed "source:id"; a decision not found is absent.
 */
export async function factsOfDecisions(
  db: Queryable,
  refs: Array<{ source: MirrorSource; id: string }>,
): Promise<Map<string, { chars: number | null; citedBy: number }>> {
  const out = new Map<string, { chars: number | null; citedBy: number }>();
  if (!refs.length) return out;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT d.source, d.source_id, length(t.body) AS chars, ${citedCount("d.id")} AS cited
     FROM unnest($1::text[], $2::text[]) AS ref(source, source_id)
     JOIN mirror.decision d ON d.source = ref.source AND d.source_id = ref.source_id
     LEFT JOIN mirror.decision_text t ON t.decision_id = d.id`,
    [refs.map((r) => r.source), refs.map((r) => r.id)],
  );
  for (const r of rows) {
    out.set(`${String(r.source)}:${String(r.source_id)}`, { chars: r.chars === null || r.chars === undefined ? null : Number(r.chars), citedBy: Number(r.cited) });
  }
  return out;
}

function displayOf(key: string): string {
  if (key.startsWith("ecli:")) return `ECLI:${key.slice(5).toUpperCase()}`;
  return canonicalCaseNumber(key)?.display ?? key;
}

const linked = (r: Record<string, unknown>): LinkedDecision => ({
  source: r.source as MirrorSource,
  id: String(r.source_id),
  caseNumber: (r.case_number as string | null) ?? null,
  court: (r.court as string | null) ?? null,
  form: (r.decision_type as DecisionType | null) ?? null,
  date: (r.decided_on as string | null) ?? null,
});

export async function linksOfDecision(
  db: Queryable,
  source: MirrorSource,
  id: string,
  options: { limit?: number; offset?: number; citedBySource?: MirrorSource[]; order?: CitedByOrder } = {},
): Promise<DecisionLinks | null> {
  const found = await db.query<{ id: string }>("SELECT id::text FROM mirror.decision WHERE source = $1 AND source_id = $2", [source, id]);
  const decisionId = found.rows[0]?.id;
  if (decisionId === undefined) return null;

  const cites = await db.query<Record<string, unknown>>(
    `SELECT c.key, c.mentions, c.first_at,
            coalesce(json_agg(json_build_object('source', d.source, 'source_id', d.source_id, 'case_number', d.case_number,
                       'court', d.court, 'decision_type', d.decision_type, 'decided_on', d.decided_on)
                     ORDER BY d.decided_on DESC NULLS LAST) FILTER (WHERE d.id IS NOT NULL), '[]'::json) AS decisions
     FROM mirror.decision_citation c
     LEFT JOIN mirror.decision_key k ON k.key = c.key AND k.decision_id <> c.citing_id
     LEFT JOIN mirror.decision d ON d.id = k.decision_id
     WHERE c.citing_id = $1
     GROUP BY c.key, c.mentions, c.first_at
     ORDER BY c.first_at, c.key`,
    [decisionId],
  );

  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 20)), CITED_BY_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const sources = options.citedBySource?.length ? options.citedBySource : null;
  const order: CitedByOrder = options.order ?? "newest";
  // The page first, its texts after: the excerpt is cut from the citing decisions shown only.
  const citedBy = await db.query<Record<string, unknown>>(
    `WITH citing AS (${citingOf("$1")}),
     page AS (
       SELECT d.id, d.source, d.source_id, d.case_number, d.court, d.decision_type, d.decided_on, citing.mentions, citing.first_at,
              ${citingRank("d")} AS rank
       FROM citing JOIN mirror.decision d ON d.id = citing.citing_id
       WHERE ($4::text[] IS NULL OR d.source = ANY($4))
       ORDER BY ${order === "courts" ? "rank, " : ""}d.decided_on DESC NULLS LAST, d.id DESC
       LIMIT $2 OFFSET $3
     )
     SELECT page.source, page.source_id, page.case_number, page.court, page.decision_type, page.decided_on::text AS decided_on, page.mentions,
            substr(t.body, greatest(1, page.first_at + 1 - ${CITING_BEFORE}), ${CITING_CHUNK_CHARS}) AS excerpt
     FROM page LEFT JOIN mirror.decision_text t ON t.decision_id = page.id
     ORDER BY ${order === "courts" ? "page.rank, " : ""}page.decided_on DESC NULLS LAST, page.id DESC`,
    [decisionId, limit, offset, sources],
  );
  const counts = await db.query<Record<string, unknown>>(
    `WITH citing AS (${citingOf("$1")})
     SELECT d.source, count(*)::int AS n, (count(*) FILTER (WHERE ${citingRank("d")} = ${TOP_RANK}))::int AS top
     FROM citing JOIN mirror.decision d ON d.id = citing.citing_id
     WHERE ($2::text[] IS NULL OR d.source = ANY($2))
     GROUP BY d.source`,
    [decisionId, sources],
  );

  const own = await db.query<{ key: string }>("SELECT key FROM mirror.decision_key WHERE decision_id = $1", [decisionId]);
  const ownKeys = new Set(own.rows.map((r) => r.key));
  const same = await db.query<Record<string, unknown>>(
    `SELECT x.*, count(*) OVER ()::int AS total FROM (
       SELECT DISTINCT d.id, d.source, d.source_id, d.case_number, d.court, d.decision_type, d.decided_on::text AS decided_on
       FROM mirror.decision me
       JOIN mirror.decision_key own ON own.decision_id = me.id AND own.key LIKE 'sz:%'
       JOIN mirror.decision_key k ON k.key = own.key AND k.decision_id <> me.id
       JOIN mirror.decision d ON d.id = k.decision_id
       WHERE me.id = $1 AND (d.source <> me.source OR coalesce(d.court, '') <> coalesce(me.court, ''))
     ) x
     ORDER BY x.decided_on DESC NULLS LAST, x.id DESC LIMIT ${SAME_CASE_SHOWN}`,
    [decisionId],
  );

  return {
    ...(same.rows.length ? { sameCaseNumber: { total: Number(same.rows[0].total), decisions: same.rows.map(linked) } } : {}),
    cites: cites.rows.map((r) => {
      const decisions = (typeof r.decisions === "string" ? JSON.parse(r.decisions) : r.decisions) as Record<string, unknown>[];
      return {
        key: String(r.key),
        display: displayOf(String(r.key)),
        mentions: Number(r.mentions),
        firstAt: Number(r.first_at),
        decisions: decisions.map((d) => ({ ...linked(d), date: d.decided_on ? String(d.decided_on).slice(0, 10) : null })),
      };
    }),
    citedBy: {
      ...summaryOf(counts.rows),
      order,
      hits: citedBy.rows.map((r) => {
        const excerpt = passageAround(String(r.excerpt ?? ""), ownKeys);
        return { ...linked(r), mentions: Number(r.mentions), ...(excerpt ? { excerpt } : {}) };
      }),
    },
  };
}

export const BY_CASE_MAX = 20;
/** How many decisions sharing a značka the citator names. */
const SAME_CASE_SHOWN = 3;

/**
 * The decisions that CARRY a spisová značka or ECLI as their own (decision_key)
 * — not the ones whose text names it, which is what /v1/search?case= finds and
 * ranks first for any decision cited often. Newest first; none when the text
 * holds no sp. zn. / ECLI the mirror recognises.
 */
export async function decisionsByCaseNumber(db: Queryable, caseNumber: string, sources?: MirrorSource[]): Promise<LinkedDecision[]> {
  const keys = queryIdentKeys(caseNumber).keys.filter((key) => key.startsWith("sz:") || key.startsWith("ecli:"));
  if (!keys.length) return [];
  const found = await db.query<Record<string, unknown>>(
    `SELECT DISTINCT d.id, d.source, d.source_id, d.case_number, d.court, d.decision_type, d.decided_on::text AS decided_on
     FROM mirror.decision_key k JOIN mirror.decision d ON d.id = k.decision_id
     WHERE k.key = ANY($1::text[]) AND ($2::text[] IS NULL OR d.source = ANY($2))
     ORDER BY decided_on DESC NULLS LAST, d.id DESC
     LIMIT ${BY_CASE_MAX}`,
    [keys, sources?.length ? sources : null],
  );
  return found.rows.map(linked);
}
