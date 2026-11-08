import { gunzipSync } from "node:zlib";
import type { Db, Queryable } from "./db/client";
import type { RunCounts } from "./db/store";
import { structureOf, verdictText, type Structure } from "./structure";
import type { MirrorSource } from "./types";

/** Replace the structure and the výrok's text of decision `id`. */
export async function writeStructure(tx: Queryable, id: number, body: string, structure: Structure): Promise<void> {
  await tx.query(
    `INSERT INTO mirror.decision_structure (decision_id, sections, paragraphs, headings, written_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (decision_id) DO UPDATE SET sections = EXCLUDED.sections, paragraphs = EXCLUDED.paragraphs,
       headings = EXCLUDED.headings, written_at = now()`,
    [id, JSON.stringify(structure.sections), JSON.stringify(structure.paragraphs), JSON.stringify(structure.headings)],
  );
  const verdict = verdictText(body, structure);
  if (verdict === null) await tx.query("DELETE FROM mirror.decision_verdict WHERE decision_id = $1", [id]);
  else
    await tx.query(
      `INSERT INTO mirror.decision_verdict (decision_id, body) VALUES ($1, $2)
       ON CONFLICT (decision_id) DO UPDATE SET body = EXCLUDED.body WHERE mirror.decision_verdict.body IS DISTINCT FROM EXCLUDED.body`,
      [id, verdict],
    );
}

const BATCH = 500;

/**
 * `mirror structure --source X`: the structure of the decisions stored with a text, from that text (and
 * for justice the finaldoc kept in decision_raw). Batches by id, one transaction a batch; it can stop and
 * run again.
 */
export async function backfillStructure(
  ctx: { db: Db; log: (line: string) => void; progress?: (counts: RunCounts) => Promise<void>; shouldStop?: () => boolean },
  source: MirrorSource,
  counts: RunCounts,
  batch = BATCH,
): Promise<void> {
  let lastId = 0;
  for (;;) {
    if (ctx.shouldStop?.()) return;
    const { rows } = await ctx.db.query<{ id: string; body: string; gz: Uint8Array | null }>(
      `SELECT d.id, t.body, ${source === "justice" ? "r.gz" : "NULL::bytea AS gz"}
       FROM mirror.decision d JOIN mirror.decision_text t ON t.decision_id = d.id
       ${source === "justice" ? "LEFT JOIN mirror.decision_raw r ON r.decision_id = d.id AND r.status BETWEEN 200 AND 299" : ""}
       WHERE d.source = $1 AND d.id > $2 ORDER BY d.id LIMIT $3`,
      [source, lastId, batch],
    );
    if (rows.length === 0) return;
    lastId = Number(rows[rows.length - 1].id);
    await ctx.db.transaction(async (tx) => {
      for (const r of rows) {
        const raw = r.gz?.length ? gunzipSync(r.gz) : null;
        await writeStructure(tx, Number(r.id), r.body, structureOf(source, r.body, raw));
      }
    });
    counts.fetched += rows.length;
    counts.changed += rows.length;
    await ctx.progress?.(counts);
    ctx.log(`${source}: struktura — ${counts.fetched} rozhodnutí`);
  }
}
