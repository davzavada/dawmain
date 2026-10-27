import type { Queryable } from "./db/client";
import type { RunCounts } from "./db/store";
import { aggregateProvisions, extractProvisions, EXTRACTOR_VERSION, type ActLookup, type ProvisionRow } from "./legal/provisions";
import type { ReindexContext } from "./reindex";
import type { MirrorSource } from "./types";

/**
 * `mirror provisions`: decision_provision of every decision of a source
 * whose provision_state is missing, from another text or an older
 * extractor (migration 0009). No request leaves the server. One
 * transaction per decision, so it can stop and run again.
 */

const BATCH = 200;

/** Replace a decision's provisions and record what they came from. */
export async function writeProvisions(tx: Queryable, decisionId: number, textSha: string | null, rows: ProvisionRow[]): Promise<void> {
  await tx.query("DELETE FROM mirror.decision_provision WHERE decision_id = $1", [decisionId]);
  if (rows.length) {
    await tx.query(
      `INSERT INTO mirror.decision_provision (decision_id, act_id, provision, mentions, first_at)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::int[])`,
      [decisionId, rows.map((r) => r.act), rows.map((r) => r.provision), rows.map((r) => r.mentions), rows.map((r) => r.firstAt)],
    );
  }
  await tx.query(
    `INSERT INTO mirror.provision_state (decision_id, text_sha256, version) VALUES ($1, $2, $3)
     ON CONFLICT (decision_id) DO UPDATE SET text_sha256 = EXCLUDED.text_sha256, version = EXCLUDED.version, done_at = now()`,
    [decisionId, textSha, EXTRACTOR_VERSION],
  );
}

export async function provisionsSource(ctx: ReindexContext, source: MirrorSource, lookup: ActLookup, counts: RunCounts): Promise<void> {
  let lastId = 0;
  for (;;) {
    if (ctx.shouldStop?.()) return;
    const { rows } = await ctx.db.query<{ id: string; text_sha256: string | null; year: number | null; body: string }>(
      `SELECT d.id, d.text_sha256, extract(year FROM d.decided_on)::int AS year, t.body
       FROM mirror.decision d JOIN mirror.decision_text t ON t.decision_id = d.id
       LEFT JOIN mirror.provision_state s ON s.decision_id = d.id
       WHERE d.source = $1 AND d.id > $2
         AND (s.decision_id IS NULL OR s.version <> $3 OR s.text_sha256 IS DISTINCT FROM d.text_sha256)
       ORDER BY d.id LIMIT $4`,
      [source, lastId, EXTRACTOR_VERSION, BATCH],
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      if (ctx.shouldStop?.()) return;
      const id = Number(r.id);
      lastId = id;
      try {
        const provisions = aggregateProvisions(extractProvisions(r.body, lookup, r.year));
        await ctx.db.transaction((tx) => writeProvisions(tx, id, r.text_sha256, provisions));
        counts.fetched++;
        counts.changed++;
      } catch (error) {
        counts.failed++;
        ctx.log(`${source}: ustanovení ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await ctx.progress?.(counts);
    }
    ctx.log(`${source}: ustanovení — ${counts.fetched} rozhodnutí`);
  }
}
