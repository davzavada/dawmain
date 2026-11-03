import type { Db } from "./db/client";
import { writeChunks, writeDissents, type RunCounts } from "./db/store";
import type { DecisionRecord, DecisionType, MirrorSource } from "./types";

/**
 * `mirror reindex`: rebuild the derived layer — chunks (tsvector, identifier
 * keys) and dissents — of every stored decision of a source from its stored
 * text and pictures. No request leaves the server (v1-plan, krok 7). Batches
 * by id, one transaction per decision, so it can stop and run again.
 */

const BATCH = 200;

export interface ReindexContext {
  db: Db;
  log: (line: string) => void;
  progress?: (counts: RunCounts) => Promise<void>;
  shouldStop?: () => boolean;
}

export async function reindexSource(ctx: ReindexContext, source: MirrorSource, counts: RunCounts): Promise<void> {
  let lastId = 0;
  for (;;) {
    if (ctx.shouldStop?.()) return;
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      `SELECT d.id, d.source_id, d.url, d.court, d.case_number, d.case_numbers, d.decision_type, d.source_flags, d.decided_on::text AS decided_on,
              d.legal_sentence, d.ecli, d.published_on::text AS published_on, d.parser_version, t.body, t.text_source
       FROM mirror.decision d JOIN mirror.decision_text t ON t.decision_id = d.id
       WHERE d.source = $1 AND d.id > $2 ORDER BY d.id LIMIT $3`,
      [source, lastId, BATCH],
    );
    if (rows.length === 0) return;
    for (const r of rows) {
      if (ctx.shouldStop?.()) return;
      const id = Number(r.id);
      lastId = id;
      const record: DecisionRecord = {
        source,
        sourceId: String(r.source_id),
        url: String(r.url),
        court: (r.court as string | null) ?? null,
        caseNumber: (r.case_number as string | null) ?? null,
        caseNumbers: (r.case_numbers as string[]) ?? [],
        decisionType: (r.decision_type as DecisionType | null) ?? null,
        sourceFlags: (r.source_flags as string[]) ?? [],
        decidedOn: (r.decided_on as string | null) ?? null,
        legalSentence: (r.legal_sentence as string | null) ?? null,
        ecli: (r.ecli as string | null) ?? null,
        publishedOn: (r.published_on as string | null) ?? null,
        parserVersion: Number(r.parser_version),
        text: { body: String(r.body), source: String(r.text_source) },
        // images stay undefined: writeDissents reads the stored ones
      };
      try {
        await ctx.db.transaction(async (tx) => {
          await writeChunks(tx, record, id);
          await writeDissents(tx, record, id);
        });
        counts.fetched++;
        counts.changed++;
      } catch (error) {
        counts.failed++;
        ctx.log(`${source}: reindex ${record.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await ctx.progress?.(counts);
    }
    ctx.log(`${source}: reindex — ${counts.fetched} rozhodnutí`);
  }
}
