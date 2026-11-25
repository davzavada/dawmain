import { queryIdentKeys } from "@/src/files/index/identifiers";
import type { Queryable } from "../db/client";
import type { DecisionType, MirrorSource } from "../types";

/**
 * The filters of the courts' own search forms that the BM25 index does not
 * carry (it holds the text, the court's source, the decision date, the form
 * and the NS category): the senate or kind of court, the docket registry, the
 * NSS subject area, the day a decision was put on the web, a provision it
 * cites, its own spisová značka. All of them are in `mirror.decision` (and
 * its source_meta, verbatim from the court) or in decision_provision /
 * decision_key.
 *
 * The mirror used to hand every call with one of these to the live court.
 * Here they become predicates over `mirror.decision`, and a search applies
 * them in one of two ways (resolveMetaIds):
 *
 *   selective  — the decisions that pass are few (≤ META_EXACT_MAX): their
 *                ids go INTO the BM25 query as a term set, so the ranking is
 *                exact within the filter (measured on production: 15 000 ids,
 *                80–215 ms);
 *   broad      — too many to list: the predicates are checked on the BM25
 *                candidates instead (as the court-name filter always was) —
 *                a broad filter passes most candidates, so few are lost.
 *
 * Every value is a bound parameter; the only interpolated text is the alias.
 */

export type CourtClass = "nss" | "rozsireny" | "krajske" | "karne";

export interface MetaFilters {
  /** NSS index: the NSS itself, its rozšířený senát, the krajské soudy, the kárné senáty. */
  courtClass?: CourtClass;
  /** Docket registry as the spisová značka carries it: "Afs", "Cdo", "Azs". */
  registry?: string;
  /** NSS "Oblast úpravy", a substring. */
  area?: string;
  /** The day the court put the decision on the web. */
  publishedFrom?: string;
  publishedTo?: string;
  /** A cited act (its id: "zak:89/2012", "eu:32016R0679") and optionally one provision key ("par:2291"). */
  act?: string;
  provision?: string;
  /** The decision's OWN spisová značka or ECLI — not the decisions citing it. */
  ownCase?: string;
  /** ÚS: only decisions published in the Sbírka nálezů a usnesení or the Sbírka zákonů (NALUS names the reference in its citation). */
  inCollection?: boolean;
}

/** Most decisions a filter may pass for their ids to go into the BM25 query. */
export const META_EXACT_MAX = 20_000;

/** A registry is letters only — it goes into a pattern. */
export const REGISTRY_RE = /^\p{L}{1,10}$/u;

export function hasMeta(f: MetaFilters): boolean {
  return Boolean(f.courtClass || f.registry || f.area || f.publishedFrom || f.publishedTo || f.act || f.ownCase || f.inCollection);
}

const nssOwn = (d: string): string => `${d}.court ILIKE 'Nejvyšší správní soud%'`;
const nssRozsireny = (d: string): string => `(${d}.court ILIKE '%RS NSS%' OR ${d}.court ILIKE '%rozšířen%')`;
const nssKarne = (d: string): string => `${d}.court ILIKE 'kárný senát%'`;
const nssZvlastni = (d: string): string => `${d}.court ILIKE 'zvláštní senát%'`;

/** LIKE's own wildcards in a reader's substring are letters to find, not wildcards. */
function likeEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** The filters as SQL conditions over the decision aliased `d`; values pushed onto `params`. Pure. */
export function metaPredicates(f: MetaFilters, d: string, params: unknown[]): string[] {
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const out: string[] = [];
  if (f.courtClass) {
    const cls =
      f.courtClass === "rozsireny"
        ? nssRozsireny(d)
        : f.courtClass === "karne"
          ? nssKarne(d)
          : f.courtClass === "nss"
            ? nssOwn(d)
            : `(${d}.court IS NOT NULL AND NOT (${nssOwn(d)} OR ${nssKarne(d)} OR ${nssZvlastni(d)}))`;
    out.push(`(${d}.source = 'nss' AND ${cls})`);
  }
  if (f.registry) {
    // "1 Afs 25/2024", "Pst 1/2019": the registry is the letters before number/year.
    const pattern = "(^|[[:space:]])" + f.registry + "[[:space:]]+[0-9]+/";
    out.push(`${d}.case_number ~ ${bind(pattern)}::text`);
  }
  if (f.area) out.push(`${d}.source_meta->>'Oblast úpravy' ILIKE ${bind("%" + likeEscape(f.area) + "%")}::text`);
  if (f.publishedFrom) out.push(`${d}.published_on >= ${bind(f.publishedFrom)}::date`);
  if (f.publishedTo) out.push(`${d}.published_on <= ${bind(f.publishedTo)}::date`);
  if (f.act) {
    const act = bind(f.act);
    const provision = f.provision ? ` AND p.provision = ${bind(f.provision)}::text` : "";
    out.push(`EXISTS (SELECT 1 FROM mirror.decision_provision p WHERE p.decision_id = ${d}.id AND p.act_id = ${act}::text${provision})`);
  }
  // "nález sp. zn. Pl. ÚS 24/10 ze dne … (N 52/60 SbNU 625; 94/2011 Sb.)" — the bracket is the collection reference.
  if (f.inCollection) out.push(`(${d}.source = 'us' AND ${d}.source_meta->>'citation' ~ ${bind("[(][^()]*(SbNU|Sb[.])[^()]*[)]")}::text)`);
  if (f.ownCase) {
    const keys = queryIdentKeys(f.ownCase).keys.filter((key) => key.startsWith("sz:") || key.startsWith("ecli:"));
    // A značka that yields no key matches nothing — never "no filter".
    out.push(keys.length ? `${d}.id IN (SELECT k.decision_id FROM mirror.decision_key k WHERE k.key = ANY(${bind(keys)}::text[]))` : "false");
  }
  return out;
}

/** What narrows the set beside the meta filters (the same values the search applies in the index). */
export interface BaseFilters {
  sources?: MirrorSource[];
  types?: DecisionType[];
  from?: string;
  to?: string;
  categories?: string[];
}

/** The base filters as conditions over `d`. Pure. */
export function basePredicates(f: BaseFilters, d: string, params: unknown[]): string[] {
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const out: string[] = [];
  if (f.sources?.length) out.push(`${d}.source = ANY(${bind(f.sources)}::text[])`);
  if (f.types?.length) out.push(`${d}.decision_type = ANY(${bind(f.types)}::text[])`);
  if (f.from) out.push(`${d}.decided_on >= ${bind(f.from)}::date`);
  if (f.to) out.push(`${d}.decided_on <= ${bind(f.to)}::date`);
  if (f.categories?.length) out.push(`${d}.category = ANY(${bind(f.categories)}::text[])`);
  return out;
}

/**
 * The ids of the decisions passing the meta filters (with the base filters),
 * when they are few enough to be put into the BM25 query; null when there are
 * more than META_EXACT_MAX — the caller then checks the predicates on its
 * candidates. No meta filter → null without a query.
 */
export async function resolveMetaIds(db: Queryable, meta: MetaFilters, base: BaseFilters): Promise<number[] | null> {
  if (!hasMeta(meta)) return null;
  const params: unknown[] = [];
  const where = [...basePredicates(base, "d", params), ...metaPredicates(meta, "d", params)];
  const { rows } = await db.query<{ id: string }>(
    `SELECT d.id::text AS id FROM mirror.decision d WHERE ${where.join(" AND ")} LIMIT ${META_EXACT_MAX + 1}`,
    params,
  );
  return rows.length > META_EXACT_MAX ? null : rows.map((r) => Number(r.id));
}
