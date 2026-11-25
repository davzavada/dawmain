import type { Queryable } from "../db/client";
import { extractProvisions, type ActLookup } from "../legal/provisions";
import type { DecisionType, MirrorSource } from "../types";
import { citedCount } from "./citations";

/**
 * Search by cited provision (decision_provision, migration 0008): which
 * decisions cite § 2913 odst. 1 OZ, and what a decision cites. A key is
 * stored at every level, so "par:2913" finds a decision citing only
 * "par:2913/o1/pb".
 */

export interface ProvisionQuery {
  act: string;
  provision: string;
  /** Any of these courts; none = all. */
  sources?: MirrorSource[];
  categories?: string[];
  from?: string;
  to?: string;
  /** newest (default) or the decisions cited most first — see CITED_SORT_MAX. */
  sort?: "newest" | "cited";
  limit: number;
  offset: number;
}

/**
 * Most decisions a provision may have for "cited" order: the count of citing
 * decisions is worked out for every one of them before the first is shown.
 * § 237 o. s. ř. is cited by a six-figure number of decisions; past the cap
 * the list comes newest first and says so (sortedBy).
 */
export const CITED_SORT_MAX = 3000;

export interface ProvisionHit {
  source: MirrorSource;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: DecisionType | null;
  category: string | null;
  date: string | null;
  url: string;
  mentions: number;
  /** The text around the first citation. */
  excerpt: string;
  /** How many mirrored decisions cite this one. */
  citedBy: number;
  /** Length of its text; null = no text. */
  chars: number | null;
}

const EXCERPT_BEFORE = 150;
const EXCERPT_CHARS = 450;

/** "89/2012", "zak:89/2012", "32016R0679", "eu:32016R0679", "sm:12/2005" → an act id, or null. */
export function normalizeAct(value: string): string | null {
  const v = value.trim().replace(/\s+/g, "");
  if (/^(?:zak|sm):\d{1,4}\/\d{4}$/.test(v)) return v.replace(/:0+(\d)/, ":$1");
  if (/^\d{1,4}\/\d{4}$/.test(v)) return `zak:${Number(v.split("/")[0])}/${v.split("/")[1]}`;
  if (/^(?:eu:)?\d{5}[A-Z]{1,2}\d{4}$/.test(v)) return v.startsWith("eu:") ? v : `eu:${v}`;
  if (/^eu:\d{5}[A-Z]\/TXT$/.test(v)) return v;
  return null;
}

/** "par:2913/o1", or a citation's provision ("§ 2913 odst. 1 písm. b)") → the key, or null. */
export function normalizeProvision(value: string): string | null {
  const v = value.trim();
  if (/^(?:par|cl):[0-9a-z]+(?:\/(?:o\d+|p[a-z]{1,2}|b\d+|v(?:\d|posl|pred|za)))*$/.test(v)) return v;
  return extractProvisions(v)[0]?.provision ?? null;
}

/** A whole citation ("§ 2913 odst. 1 zákona č. 89/2012 Sb.", "čl. 6 GDPR") → act and key of its first reference. */
export function parseCitation(cite: string, lookup: ActLookup | null): { act: string; provision: string } | null {
  const first = extractProvisions(cite, lookup, null)[0];
  return first ? { act: first.act, provision: first.provision } : null;
}

export async function decisionsByProvision(
  db: Queryable,
  q: ProvisionQuery,
): Promise<{ total: number; sortedBy: "newest" | "cited"; hits: ProvisionHit[] }> {
  const where = ["p.act_id = $1", "p.provision = $2"];
  const params: unknown[] = [q.act, q.provision];
  if (q.sources?.length) where.push(`d.source = ANY($${params.push(q.sources)}::text[])`);
  if (q.categories?.length) where.push(`d.category = ANY($${params.push(q.categories)}::text[])`);
  if (q.from) where.push(`d.decided_on >= $${params.push(q.from)}`);
  if (q.to) where.push(`d.decided_on <= $${params.push(q.to)}`);
  const filter = where.join(" AND ");
  const { rows: count } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM mirror.decision_provision p JOIN mirror.decision d ON d.id = p.decision_id WHERE ${filter}`,
    params,
  );
  const total = Number(count[0]?.n ?? 0);
  const sortedBy = q.sort === "cited" && total <= CITED_SORT_MAX ? "cited" : "newest";
  const limit = `LIMIT $${params.push(q.limit)} OFFSET $${params.push(q.offset)}`;
  // Newest: the page is cut first and only its rows are counted; cited: every match is counted, then cut.
  const page =
    sortedBy === "cited"
      ? `SELECT m.* FROM (
           SELECT d.id, d.decided_on, p.mentions, p.first_at, ${citedCount("d.id")} AS cited
           FROM mirror.decision_provision p JOIN mirror.decision d ON d.id = p.decision_id WHERE ${filter}
         ) m ORDER BY m.cited DESC, m.decided_on DESC NULLS LAST, m.id DESC ${limit}`
      : `SELECT m.*, ${citedCount("m.id")} AS cited FROM (
           SELECT d.id, d.decided_on, p.mentions, p.first_at
           FROM mirror.decision_provision p JOIN mirror.decision d ON d.id = p.decision_id WHERE ${filter}
           ORDER BY d.decided_on DESC NULLS LAST, d.id DESC ${limit}
         ) m`;
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH page AS (${page})
     SELECT d.source, d.source_id, d.case_number, d.court, d.decision_type, d.category, d.decided_on::text AS decided_on, d.url, page.mentions, page.cited,
            length(t.body) AS chars,
            substr(t.body, greatest(1, page.first_at + 1 - ${EXCERPT_BEFORE}), ${EXCERPT_CHARS}) AS excerpt
     FROM page JOIN mirror.decision d ON d.id = page.id
     LEFT JOIN mirror.decision_text t ON t.decision_id = d.id
     ORDER BY ${sortedBy === "cited" ? "page.cited DESC, " : ""}d.decided_on DESC NULLS LAST, d.id DESC`,
    params,
  );
  return {
    total,
    sortedBy,
    hits: rows.map((r) => ({
      source: r.source as MirrorSource,
      id: String(r.source_id),
      caseNumber: (r.case_number as string | null) ?? null,
      court: (r.court as string | null) ?? null,
      form: (r.decision_type as DecisionType | null) ?? null,
      category: (r.category as string | null) ?? null,
      date: (r.decided_on as string | null) ?? null,
      url: String(r.url),
      mentions: Number(r.mentions),
      excerpt: String(r.excerpt ?? "").replace(/\s+/g, " ").trim(),
      citedBy: Number(r.cited ?? 0),
      chars: r.chars === null || r.chars === undefined ? null : Number(r.chars),
    })),
  };
}

export interface CitedProvision {
  act: string;
  actTitle: string | null;
  provision: string;
  mentions: number;
  firstAt: number;
}

/** What one decision cites, deepest keys only (every level is stored; the leaves say it all). */
export async function provisionsOfDecision(db: Queryable, source: MirrorSource, id: string): Promise<CitedProvision[] | null> {
  const { rows: found } = await db.query<{ id: string }>("SELECT id FROM mirror.decision WHERE source = $1 AND source_id = $2", [source, id]);
  if (!found[0]) return null;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT p.act_id, a.title, p.provision, p.mentions, p.first_at
     FROM mirror.decision_provision p LEFT JOIN mirror.act a ON a.id = p.act_id
     WHERE p.decision_id = $1
       AND NOT EXISTS (SELECT 1 FROM mirror.decision_provision q
                       WHERE q.decision_id = p.decision_id AND q.act_id = p.act_id AND q.provision LIKE p.provision || '/%')
     ORDER BY p.first_at`,
    [found[0].id],
  );
  return rows.map((r) => ({
    act: String(r.act_id),
    actTitle: (r.title as string | null) ?? null,
    provision: String(r.provision),
    mentions: Number(r.mentions),
    firstAt: Number(r.first_at),
  }));
}
