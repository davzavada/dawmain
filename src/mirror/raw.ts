import type { Db } from "./db/client";
import { writeRaw, type RunCounts } from "./db/store";
import { SourceStopped, keepRaw, pacedFetch, type Pacer } from "./http";
import { justiceRawUrl } from "./crawl/justice";
import { nsRawUrl } from "./crawl/ns";
import { nssRawUrl } from "./crawl/nss";
import { usRawUrl } from "./crawl/us";
import type { CrawlContext } from "./crawl/workers";
import type { MirrorSource } from "./types";

/**
 * `mirror raw`: the source's own document for decisions stored before
 * migration 0014 — one request per decision (no metadata, text or
 * pictures), kept in decision_raw. The decisions without one are the
 * cursor: a stopped run carries on where it was. A 404 / 410 is kept as
 * such (not asked again); another failure is logged and left for the next
 * run. A 429 / 403 stops the source (SourceStopped), as in a backfill.
 */

export type RawSource = Exclude<MirrorSource, "sdeu">;

export const RAW_SOURCES: Record<RawSource, { label: string; url: (sourceId: string) => string; accept?: string }> = {
  ns: { label: "Nejvyšší soud – mirror", url: nsRawUrl },
  us: { label: "Ústavní soud (NALUS) – mirror", url: usRawUrl },
  nss: { label: "Nejvyšší správní soud – mirror", url: nssRawUrl },
  justice: { label: "rozhodnuti.justice.cz – mirror", url: justiceRawUrl, accept: "application/json" },
};

const BATCH = 1_000;

export interface RawOptions {
  /** Pilot: at most this many decisions, a random sample. */
  limit?: number;
  concurrency?: number;
}

export async function fetchRawMissing(ctx: CrawlContext & { db: Db; pacer: Pacer }, source: RawSource, options: RawOptions, counts: RunCounts): Promise<void> {
  const spec = RAW_SOURCES[source];
  const failed: number[] = [];
  let left = options.limit ?? Infinity;
  while (left > 0 && !ctx.shouldStop?.()) {
    const { rows } = await ctx.db.query<{ id: string; source_id: string }>(
      `SELECT d.id::text, d.source_id FROM mirror.decision d
       WHERE d.source = $1 AND NOT EXISTS (SELECT 1 FROM mirror.decision_raw r WHERE r.decision_id = d.id)
         AND NOT (d.id = ANY($2::bigint[]))
       ORDER BY ${options.limit ? "random()" : "d.id"} LIMIT $3`,
      [source, failed, Math.min(BATCH, left)],
    );
    if (rows.length === 0) return;
    left -= rows.length;
    let next = 0;
    let stopped: SourceStopped | null = null;
    const worker = async () => {
      while (stopped === null && next < rows.length && !ctx.shouldStop?.()) {
        const row = rows[next++];
        const url = spec.url(row.source_id);
        try {
          const response = await pacedFetch(spec.label, ctx.pacer, url, spec.accept ? { headers: { accept: spec.accept } } : undefined);
          if (response.ok || response.status === 404 || response.status === 410) {
            const { raw } = await keepRaw(response, url);
            await writeRaw(ctx.db, Number(row.id), raw);
            counts.fetched++;
            if (response.ok) counts.changed++;
            else ctx.log(`${source}: ${row.source_id}: zdroj už dokument nemá (HTTP ${response.status})`);
          } else {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (error) {
          if (error instanceof SourceStopped) {
            stopped = error;
            return;
          }
          counts.failed++;
          failed.push(Number(row.id));
          ctx.log(`${source}: ${row.source_id}: originál nestažen (${error instanceof Error ? error.message : String(error)})`);
        }
        await ctx.progress?.(counts);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
    if (stopped) throw stopped;
  }
}
