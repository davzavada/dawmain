import type { Queryable } from "../db/client";
import { resolveAct } from "@/src/files/index/acts";

/**
 * The act registry for a picker (a suggest box: type "občanský", "OSŘ",
 * "89/2012", "GDPR", get the acts): which act a provision search is about.
 * Groups as a lawyer sorts them:
 *
 *   cz    Sbírka zákonů (collection sb)
 *   eu    EU regulations, directives, decisions and the primary law (eu)
 *   intl  international treaties: the Sbírka mezinárodních smluv (sm), and
 *         before it (until 1999) the sdělení of the Sbírka zákonů that
 *         proclaimed a treaty ("Sdělení … o sjednání Úmluvy …", EÚLP is
 *         209/1992 Sb.)
 *
 * Every word of the query must appear in the title, the short title or an
 * alias (case-insensitive); a number ("89/2012"), a CELEX number or an exact
 * alias ("OSŘ", "GDPR", and the abbreviations of the act table in
 * src/files/index/acts.ts: "o. s. ř.", "ZOK") ranks first. Then, when the
 * citation counts are known, the acts most decisions cite (the code before its
 * amendments); then laws before implementing acts, newer before older.
 */

export type ActGroup = "cz" | "eu" | "intl";
export const ACT_GROUPS: readonly ActGroup[] = ["cz", "eu", "intl"];

export interface ActSuggestion {
  id: string;
  collection: "sb" | "sm" | "eu";
  kind: string | null;
  number: string | null;
  year: number | null;
  title: string;
  shortTitle: string | null;
  /** The most used abbreviation ("OSŘ", "GDPR"), if any. */
  abbreviation: string | null;
}

export const ACTS_MAX_LIMIT = 30;
const TREATY = "(a.collection = 'sm' OR (a.collection = 'sb' AND a.kind = 'sdělení' AND a.title ~* '(úmluv|smlouv|dohod|protokol|pakt)'))";

/** Decisions citing each act (a scan of decision_provision: a minute on the full mirror — cache it). */
export async function actCitations(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ act_id: string; n: number }>(
    `SELECT act_id, count(DISTINCT decision_id)::int AS n FROM mirror.decision_provision WHERE act_id <> '' GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.act_id, Number(r.n)]));
}

/** With citation counts, this many candidates are ranked by them before the limit. */
const CANDIDATES = 200;

export async function suggestActs(
  db: Queryable,
  input: { q: string; group?: ActGroup; limit?: number; cited?: Map<string, number> },
): Promise<ActSuggestion[]> {
  const q = input.q.trim().replace(/\s+/g, " ").slice(0, 200);
  const words = (q.toLowerCase().match(/[\p{L}\p{N}/.]+/gu) ?? []).slice(0, 8);
  if (words.length === 0) return [];
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 12)), ACTS_MAX_LIMIT);
  const group =
    input.group === "cz" ? "a.collection = 'sb'" : input.group === "eu" ? "a.collection = 'eu'" : input.group === "intl" ? TREATY : "true";
  const number = /^(\d{1,4})\s*\/\s*(\d{4})$/.exec(q);
  const celex = /^(?:eu:)?(\d{5}[A-Z]{1,2}\d{4})$/i.exec(q.replace(/\s+/g, ""))?.[1]?.toUpperCase() ?? null;
  // An act the act table recognises in the query: its abbreviation ("OSŘ", "o. s. ř.") or name ("zákoník práce").
  const known = resolveAct(q)?.act ?? null;
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH alias AS (
       SELECT act_id, string_agg(lower(alias), ' ') AS names,
              (array_agg(alias ORDER BY seen DESC, length(alias)) FILTER (WHERE kind = 'abbreviation'))[1] AS abbreviation,
              bool_or(alias = $1 OR (length($1) > 3 AND lower(alias) = lower($1))) AS exact
       FROM mirror.act_alias GROUP BY act_id
     )
     SELECT a.id, a.collection, a.kind, a.number, a.year, a.title, a.short_title, al.abbreviation,
            CASE WHEN ($2::text IS NOT NULL AND a.number = $2 AND a.year = $3::int) OR a.id = 'eu:' || $4 THEN 0
                 WHEN coalesce(al.exact, false) OR a.id = $7 THEN 1
                 WHEN lower(coalesce(a.short_title, '')) LIKE lower($1) || '%' THEN 2
                 ELSE 3 END AS rank
     FROM mirror.act a LEFT JOIN alias al ON al.act_id = a.id
     WHERE ${group}
       AND (($2::text IS NOT NULL AND a.number = $2 AND a.year = $3::int)
            OR a.id = 'eu:' || $4
            OR a.id = $7
            OR NOT EXISTS (
              SELECT 1 FROM unnest($5::text[]) w
              WHERE strpos(lower(a.title || ' ' || coalesce(a.short_title, '') || ' ' || coalesce(al.names, '')), w) = 0))
     ORDER BY rank,
              CASE WHEN a.kind IN ('ústavní zákon', 'zákon', 'nařízení', 'směrnice', 'smlouva', 'listina', 'sdělení') THEN 0 ELSE 1 END,
              a.year DESC NULLS LAST, length(a.title)
     LIMIT $6`,
    [q, number ? String(Number(number[1])) : null, number ? Number(number[2]) : null, celex, words, input.cited ? CANDIDATES : limit, known],
  );
  const cited = input.cited;
  const ordered = cited
    ? rows
        .map((r, i) => ({ r, i, n: cited.get(String(r.id)) ?? 0 }))
        .sort((a, b) => Number(a.r.rank) - Number(b.r.rank) || b.n - a.n || a.i - b.i)
        .map((x) => x.r)
    : rows;
  return ordered.slice(0, limit).map((r) => ({
    id: String(r.id),
    collection: r.collection as ActSuggestion["collection"],
    kind: (r.kind as string | null) ?? null,
    number: (r.number as string | null) ?? null,
    year: r.year === null || r.year === undefined ? null : Number(r.year),
    title: String(r.title),
    shortTitle: (r.short_title as string | null) ?? null,
    abbreviation: (r.abbreviation as string | null) ?? (r.id === known && q.length <= 12 ? q : null),
  }));
}
