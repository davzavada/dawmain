import { ACT_ABBREVIATIONS } from "@/src/files/index/acts";
import type { Queryable } from "../db/client";
import { MANUAL_ACTS, type ActRow, type AliasRow } from "./registry";

/**
 * Writes of the act registry (mirror.act, mirror.act_alias) — idempotent
 * upserts in batches, so `mirror acts import` can run again after e-Sbírka
 * or Cellar grow.
 */

const BATCH = 2_000;

export async function upsertActs(db: Queryable, acts: ActRow[]): Promise<number> {
  for (let i = 0; i < acts.length; i += BATCH) {
    const batch = acts.slice(i, i + BATCH).map((a) => ({
      id: a.id,
      collection: a.collection,
      kind: a.kind,
      number: a.number,
      year: a.year,
      title: a.title,
      short_title: a.shortTitle,
      origin: a.collection === "eu" ? (a.kind === "smlouva" || a.kind === "listina" ? "manual" : "cellar") : "esbirka",
    }));
    await db.query(
      `INSERT INTO mirror.act (id, collection, kind, number, year, title, short_title, origin)
       SELECT x.id, x.collection, x.kind, x.number, x.year, x.title, x.short_title, x.origin
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, collection text, kind text, number text, year smallint, title text, short_title text, origin text)
       ON CONFLICT (id) DO UPDATE SET collection = EXCLUDED.collection, kind = EXCLUDED.kind, number = EXCLUDED.number,
         year = EXCLUDED.year, title = EXCLUDED.title, short_title = EXCLUDED.short_title, origin = EXCLUDED.origin, imported_at = now()`,
      [JSON.stringify(batch)],
    );
  }
  return acts.length;
}

/** Aliases of acts that exist in the registry (others are dropped); `seen` only ever grows. */
export async function upsertAliases(db: Queryable, aliases: AliasRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < aliases.length; i += BATCH) {
    const batch = aliases.slice(i, i + BATCH).map((a) => ({ alias: a.alias, act_id: a.actId, kind: a.kind, origin: a.origin, seen: a.seen }));
    const { rows } = await db.query<{ n: string | number }>(
      `WITH ins AS (
         INSERT INTO mirror.act_alias (alias, act_id, kind, origin, seen)
         SELECT x.alias, x.act_id, x.kind, x.origin, x.seen
         FROM jsonb_to_recordset($1::jsonb) AS x(alias text, act_id text, kind text, origin text, seen int)
         WHERE EXISTS (SELECT 1 FROM mirror.act a WHERE a.id = x.act_id)
         ON CONFLICT (alias, act_id) DO UPDATE SET seen = greatest(mirror.act_alias.seen, EXCLUDED.seen)
         RETURNING 1)
       SELECT count(*) AS n FROM ins`,
      [JSON.stringify(batch)],
    );
    written += Number(rows[0]?.n ?? 0);
  }
  return written;
}

/** The hand-kept part: primary EU law, and the canonical names of the act table (acts.ts). */
export function manualRegistry(): { acts: ActRow[]; aliases: AliasRow[] } {
  const acts = MANUAL_ACTS.map((m) => m.act);
  const aliases: AliasRow[] = [];
  for (const m of MANUAL_ACTS) {
    for (const n of m.names) aliases.push({ alias: n, actId: m.act.id, kind: "name", origin: "manual", seen: 0 });
    for (const a of m.abbreviations) aliases.push({ alias: a, actId: m.act.id, kind: "abbreviation", origin: "manual", seen: 0 });
  }
  for (const entry of ACT_ABBREVIATIONS) {
    if (!entry.abbreviation) aliases.push({ alias: entry.name.toLowerCase(), actId: entry.act, kind: "name", origin: "table", seen: 0 });
  }
  return { acts, aliases };
}
