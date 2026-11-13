import { canonicalCaseNumber } from "@/src/files/index/identifiers";
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

export interface DecisionLinks {
  cites: CitedKey[];
  citedBy: { total: number; hits: Array<LinkedDecision & { mentions: number }> };
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
  options: { limit?: number; offset?: number; citedBySource?: MirrorSource[] } = {},
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
  const citedBy = await db.query<Record<string, unknown>>(
    `WITH citing AS (
       SELECT c.citing_id, sum(c.mentions)::int AS mentions
       FROM mirror.decision_key own JOIN mirror.decision_citation c ON c.key = own.key
       WHERE own.decision_id = $1 AND c.citing_id <> $1
       GROUP BY c.citing_id
     )
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.decided_on::text AS decided_on, citing.mentions,
            count(*) OVER () AS total
     FROM citing JOIN mirror.decision d ON d.id = citing.citing_id
     WHERE ($4::text[] IS NULL OR d.source = ANY($4))
     ORDER BY d.decided_on DESC NULLS LAST, d.id DESC
     LIMIT $2 OFFSET $3`,
    [decisionId, limit, offset, sources],
  );

  return {
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
      total: citedBy.rows.length ? Number(citedBy.rows[0].total) : 0,
      hits: citedBy.rows.map((r) => ({ ...linked(r), mentions: Number(r.mentions) })),
    },
  };
}
