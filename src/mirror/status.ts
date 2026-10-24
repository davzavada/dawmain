import type { Queryable } from "./db/client";
import type { MirrorSource } from "./types";

/**
 * Per-source state of the mirror: what `mirror status` prints and
 * `GET /v1/status` returns. "Short" texts (< 500 characters) are suspicious:
 * a parser that took a header instead of the body shows up here first.
 */

export const SHORT_TEXT_CHARS = 500;

export interface SourceStatus {
  source: MirrorSource;
  decisions: number;
  withText: number;
  withoutText: number;
  shortText: number;
  withLegalSentence: number;
  chunks: number;
  queued: number;
  newestDecidedOn: string | null;
  lastRun: {
    mode: string;
    startedAt: string;
    finishedAt: string | null;
    fetched: number;
    changed: number;
    failed: number;
    error: string | null;
  } | null;
}

export async function mirrorStatus(db: Queryable): Promise<{ sources: SourceStatus[]; databaseBytes: number }> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT s.source,
       (SELECT count(*) FROM mirror.decision d WHERE d.source = s.source) AS decisions,
       (SELECT count(*) FROM mirror.decision d WHERE d.source = s.source AND d.text_sha256 IS NOT NULL) AS with_text,
       (SELECT count(*) FROM mirror.decision d JOIN mirror.decision_text t ON t.decision_id = d.id
         WHERE d.source = s.source AND t.char_count < $1) AS short_text,
       (SELECT count(*) FROM mirror.decision d WHERE d.source = s.source AND d.legal_sentence IS NOT NULL) AS with_legal_sentence,
       (SELECT count(*) FROM mirror.decision_chunk c WHERE c.source = s.source) AS chunks,
       (SELECT count(*) FROM mirror.fetch_queue q WHERE q.source = s.source) AS queued,
       (SELECT max(decided_on)::text FROM mirror.decision d WHERE d.source = s.source) AS newest,
       (SELECT row_to_json(r) FROM (
          SELECT mode, started_at, finished_at, fetched, changed, failed, error FROM mirror.sync_run
          WHERE source = s.source ORDER BY started_at DESC LIMIT 1) r) AS last_run
     FROM unnest(ARRAY['us','ns','nss','justice']) AS s(source)`,
    [SHORT_TEXT_CHARS],
  );
  const size = await db.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  const sources = rows.map((r): SourceStatus => {
    const run = r.last_run as Record<string, unknown> | null;
    const decisions = Number(r.decisions);
    const withText = Number(r.with_text);
    return {
      source: r.source as MirrorSource,
      decisions,
      withText,
      withoutText: decisions - withText,
      shortText: Number(r.short_text),
      withLegalSentence: Number(r.with_legal_sentence),
      chunks: Number(r.chunks),
      queued: Number(r.queued),
      newestDecidedOn: (r.newest as string | null) ?? null,
      lastRun: run
        ? {
            mode: String(run.mode),
            startedAt: String(run.started_at),
            finishedAt: run.finished_at ? String(run.finished_at) : null,
            fetched: Number(run.fetched),
            changed: Number(run.changed),
            failed: Number(run.failed),
            error: (run.error as string | null) ?? null,
          }
        : null,
    };
  });
  return { sources, databaseBytes: Number(size.rows[0].bytes) };
}

/** Plain-text table for the CLI. */
export function formatStatus(status: { sources: SourceStatus[]; databaseBytes: number }): string {
  const head = ["zdroj", "rozhodnutí", "s textem", "bez textu", "krátké", "práv. věta", "chunky", "fronta", "nejnovější"];
  const lines = status.sources.map((s) => [
    s.source,
    s.decisions,
    s.withText,
    s.withoutText,
    s.shortText,
    s.withLegalSentence,
    s.chunks,
    s.queued,
    s.newestDecidedOn ?? "–",
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const out = [row(head), ...lines.map(row)];
  for (const s of status.sources) {
    if (!s.lastRun) continue;
    const r = s.lastRun;
    out.push(
      `${s.source}: poslední běh ${r.mode} ${r.startedAt.slice(0, 19)} → ${r.finishedAt?.slice(0, 19) ?? "běží"}: ` +
        `staženo ${r.fetched}, změněno ${r.changed}, chyb ${r.failed}${r.error ? `, zastaveno: ${r.error}` : ""}`,
    );
  }
  out.push(`databáze: ${(status.databaseBytes / 1024 / 1024).toFixed(1)} MB`);
  return out.join("\n");
}
