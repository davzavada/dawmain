import { extractIdentKeys } from "@/src/files/index/identifiers";
import type { Db, Queryable } from "./db/client";
import type { RunCounts } from "./db/store";
import type { DecisionRecord, MirrorSource } from "./types";

/**
 * Links between decisions: who cites whom, by spisová značka or ECLI. Each
 * decision's own keys go to decision_key, the keys its text mentions (the
 * chunks' identifier keys, less its own) to decision_citation; a link is the
 * two joined on the key. A key is a sp. zn., not a č. j.: where several
 * decisions share one (an usnesení and a rozsudek of one case), a citation
 * of it points to all of them. Derived from the text alone — nothing is
 * fetched. Pure apart from the writes.
 */

/** Only these identify a decision; § and act keys are provisions (decision_provision). */
export const isDecisionKey = (key: string) => key.startsWith("sz:") || key.startsWith("ecli:");

/** The decision's own keys: its sp. zn. (all of them) and ECLI. */
export function ownKeys(record: Pick<DecisionRecord, "caseNumbers" | "ecli">): string[] {
  return extractIdentKeys([...record.caseNumbers, record.ecli ?? ""].join("\n")).filter(isDecisionKey);
}

export interface Citation {
  key: string;
  /** In how many chunks it is mentioned. */
  mentions: number;
  /** Where it is first mentioned (char offset of that chunk). */
  firstAt: number;
}

/** The keys the chunks mention, less the decision's own (the first chunk carries those on purpose). */
export function citationsOf(chunks: Array<{ start: number; identKeys: string[] }>, own: string[]): Citation[] {
  const skip = new Set(own);
  const found = new Map<string, Citation>();
  for (const chunk of chunks) {
    for (const key of new Set(chunk.identKeys)) {
      if (!isDecisionKey(key) || skip.has(key)) continue;
      const seen = found.get(key);
      if (seen) {
        seen.mentions++;
        seen.firstAt = Math.min(seen.firstAt, chunk.start);
      } else found.set(key, { key, mentions: 1, firstAt: chunk.start });
    }
  }
  return [...found.values()].sort((a, b) => a.firstAt - b.firstAt || a.key.localeCompare(b.key));
}

/** Replace the own keys of decision `id`. */
export async function writeKeys(tx: Queryable, id: number, keys: string[]): Promise<void> {
  await tx.query("DELETE FROM mirror.decision_key WHERE decision_id = $1", [id]);
  if (keys.length) await tx.query("INSERT INTO mirror.decision_key (key, decision_id) SELECT unnest($2::text[]), $1 ON CONFLICT DO NOTHING", [id, keys]);
}

/** Replace what decision `id` cites. */
export async function writeCitations(tx: Queryable, id: number, citations: Citation[]): Promise<void> {
  await tx.query("DELETE FROM mirror.decision_citation WHERE citing_id = $1", [id]);
  if (citations.length === 0) return;
  await tx.query(
    `INSERT INTO mirror.decision_citation (citing_id, key, mentions, first_at)
     SELECT $1, c.key, c.mentions, c.first_at FROM jsonb_to_recordset($2::jsonb) AS c(key text, mentions int, first_at int)`,
    [id, JSON.stringify(citations.map((c) => ({ key: c.key, mentions: c.mentions, first_at: c.firstAt })))],
  );
}

const BATCH = 2000;

/**
 * `mirror citations --source X`: the keys and citations of the decisions stored before they existed,
 * from the stored chunks — the own keys computed here, the citations by SQL over the chunks of each
 * batch. Batches by id; it can stop and run again (each batch is replaced whole).
 */
export async function backfillCitations(
  ctx: { db: Db; log: (line: string) => void; progress?: (counts: RunCounts) => Promise<void>; shouldStop?: () => boolean },
  source: MirrorSource,
  counts: RunCounts,
): Promise<void> {
  let lastId = 0;
  for (;;) {
    if (ctx.shouldStop?.()) return;
    const { rows } = await ctx.db.query<{ id: string; case_numbers: string[] | null; ecli: string | null }>(
      "SELECT id::text, case_numbers, ecli FROM mirror.decision WHERE source = $1 AND id > $2 ORDER BY id LIMIT $3",
      [source, lastId, BATCH],
    );
    if (rows.length === 0) return;
    const ids = rows.map((r) => Number(r.id));
    lastId = ids[ids.length - 1];
    const keys = rows.flatMap((r) => ownKeys({ caseNumbers: r.case_numbers ?? [], ecli: r.ecli }).map((key) => ({ key, id: Number(r.id) })));
    await ctx.db.transaction(async (tx) => {
      await tx.query("DELETE FROM mirror.decision_key WHERE decision_id = ANY($1::bigint[])", [ids]);
      await tx.query(
        `INSERT INTO mirror.decision_key (key, decision_id)
         SELECT k.key, k.id FROM jsonb_to_recordset($1::jsonb) AS k(key text, id bigint) ON CONFLICT DO NOTHING`,
        [JSON.stringify(keys)],
      );
      await tx.query("DELETE FROM mirror.decision_citation WHERE citing_id = ANY($1::bigint[])", [ids]);
      await tx.query(
        `INSERT INTO mirror.decision_citation (citing_id, key, mentions, first_at)
         SELECT c.decision_id, k, count(*), min(c.char_start)
         FROM mirror.decision_chunk c, unnest(c.ident_keys) AS k
         WHERE c.source = $1 AND c.decision_id = ANY($2::bigint[]) AND (k LIKE 'sz:%' OR k LIKE 'ecli:%')
           AND NOT EXISTS (SELECT 1 FROM mirror.decision_key o WHERE o.decision_id = c.decision_id AND o.key = k)
         GROUP BY c.decision_id, k`,
        [source, ids],
      );
    });
    counts.fetched += ids.length;
    counts.changed += ids.length;
    await ctx.progress?.(counts);
    ctx.log(`${source}: citace — ${counts.fetched} rozhodnutí`);
  }
}
