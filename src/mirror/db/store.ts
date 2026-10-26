import { createHash } from "node:crypto";
import { deriveChunks, findDissents } from "../index";
import type { DecisionImage, DecisionRecord, MirrorSource } from "../types";
import type { Db, Queryable } from "./client";

/**
 * Writes of the crawler (role mirror_writer). Every write is an idempotent
 * upsert keyed by (source, source_id): a re-run of a backfill or a sync
 * changes nothing that did not change at the source.
 */

export function textSha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export interface SaveResult {
  id: number;
  inserted: boolean;
  /** The text is new or differs from the stored one (text and chunks were rewritten). */
  textChanged: boolean;
}

/**
 * Upsert one decision. Base fields are overwritten with what the source says
 * now; last_changed_at moves only when one of them (or the text) differs. A
 * record without text never erases a stored text. The text, its chunks and
 * the pictures are rewritten when the text changed or a newer parser read
 * it — or always with `reindex`; pictures only when the record carries them.
 */
/**
 * Postgres text cannot hold U+0000, and a source occasionally sends one
 * (justice.cz finaldoc, 26. 10.: "invalid byte sequence for encoding UTF8:
 * 0x00" kept 24 decisions in the queue). Dropped from every string.
 */
function withoutNul(record: DecisionRecord): DecisionRecord {
  const clean = (s: string | null) => (s === null ? null : s.replace(/\u0000/g, ""));
  return {
    ...record,
    court: clean(record.court),
    caseNumber: clean(record.caseNumber),
    caseNumbers: record.caseNumbers.map((c) => c.replace(/\u0000/g, "")),
    legalSentence: clean(record.legalSentence),
    ecli: clean(record.ecli),
    text: record.text ? { ...record.text, body: record.text.body.replace(/\u0000/g, "") } : null,
  };
}

export async function saveDecision(db: Db, input: DecisionRecord, options: { reindex?: boolean } = {}): Promise<SaveResult> {
  const record = withoutNul(input);
  const sha = record.text ? textSha256(record.text.body) : null;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string | number; prev_sha: string | null; prev_parser: number | null; inserted: boolean }>(
      `WITH prev AS (SELECT text_sha256, parser_version FROM mirror.decision WHERE source = $1 AND source_id = $2)
       INSERT INTO mirror.decision AS d
         (source, source_id, url, court, case_number, case_numbers, decided_on, legal_sentence, ecli, published_on, text_sha256, parser_version, decision_type, source_flags)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::date, $8, $9, $10::date, $11, $12, $13, $14::text[])
       ON CONFLICT (source, source_id) DO UPDATE SET
         url = EXCLUDED.url,
         court = EXCLUDED.court,
         case_number = EXCLUDED.case_number,
         case_numbers = EXCLUDED.case_numbers,
         decision_type = EXCLUDED.decision_type,
         source_flags = EXCLUDED.source_flags,
         decided_on = EXCLUDED.decided_on,
         legal_sentence = EXCLUDED.legal_sentence,
         ecli = EXCLUDED.ecli,
         published_on = EXCLUDED.published_on,
         text_sha256 = COALESCE(EXCLUDED.text_sha256, d.text_sha256),
         parser_version = EXCLUDED.parser_version,
         last_seen_at = now(),
         gone_at = NULL,
         last_changed_at = CASE
           WHEN (d.url, d.court, d.case_number, d.case_numbers, d.decision_type, d.source_flags, d.decided_on, d.legal_sentence,
                 d.ecli, d.published_on, d.text_sha256)
                IS DISTINCT FROM
                (EXCLUDED.url, EXCLUDED.court, EXCLUDED.case_number, EXCLUDED.case_numbers, EXCLUDED.decision_type, EXCLUDED.source_flags,
                 EXCLUDED.decided_on, EXCLUDED.legal_sentence, EXCLUDED.ecli, EXCLUDED.published_on,
                 COALESCE(EXCLUDED.text_sha256, d.text_sha256))
           THEN now() ELSE d.last_changed_at END
       RETURNING d.id, (SELECT text_sha256 FROM prev) AS prev_sha, (SELECT parser_version FROM prev) AS prev_parser,
                 NOT EXISTS (SELECT 1 FROM prev) AS inserted`,
      [
        record.source,
        record.sourceId,
        record.url,
        record.court,
        record.caseNumber,
        record.caseNumbers,
        record.decidedOn,
        record.legalSentence,
        record.ecli,
        record.publishedOn,
        sha,
        record.parserVersion,
        record.decisionType,
        record.sourceFlags ?? [],
      ],
    );
    const id = Number(rows[0].id);
    const inserted = rows[0].inserted;
    const textChanged = sha !== null && sha !== rows[0].prev_sha;
    const newerParser = rows[0].prev_parser !== null && rows[0].prev_parser < record.parserVersion;
    if (record.text && (textChanged || newerParser || options.reindex)) {
      await tx.query(
        `INSERT INTO mirror.decision_text (decision_id, body, char_count, text_source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (decision_id) DO UPDATE SET body = EXCLUDED.body, char_count = EXCLUDED.char_count,
           text_source = EXCLUDED.text_source`,
        [id, record.text.body, record.text.body.length, record.text.source],
      );
      await writeChunks(tx, record, id);
      if (record.images) await writeImages(tx, record.images, id);
      await writeDissents(tx, record, id);
    }
    return { id, inserted, textChanged };
  });
}

/**
 * Replace the dissents of decision `id`, found in the text and the pictures:
 * the record's, or (a reindex reads no pictures) the stored ones.
 */
export async function writeDissents(tx: Queryable, record: DecisionRecord, id: number): Promise<number> {
  let images: Array<{ charAt: number; width: number | null; height: number | null }> | undefined = record.images;
  if (!images) {
    const { rows } = await tx.query<{ char_at: number; width: number | null; height: number | null }>(
      "SELECT char_at, width, height FROM mirror.decision_image WHERE decision_id = $1",
      [id],
    );
    images = rows.map((r) => ({ charAt: r.char_at, width: r.width, height: r.height }));
  }
  const dissents = record.text ? findDissents(record.text.body, images) : [];
  await tx.query("DELETE FROM mirror.decision_dissent WHERE decision_id = $1", [id]);
  if (dissents.length) {
    await tx.query(
      `INSERT INTO mirror.decision_dissent (decision_id, ord, char_start, char_end, heading)
       SELECT $1, x.ord, x.char_start, x.char_end, x.heading
       FROM jsonb_to_recordset($2::jsonb) AS x(ord int, char_start int, char_end int, heading text)`,
      [id, JSON.stringify(dissents.map((d, ord) => ({ ord, char_start: d.start, char_end: d.end, heading: d.heading })))],
    );
  }
  return dissents.length;
}

/** Replace the pictures of decision `id`. */
export async function writeImages(tx: Queryable, images: DecisionImage[], id: number): Promise<void> {
  await tx.query("DELETE FROM mirror.decision_image WHERE decision_id = $1", [id]);
  for (const [ord, img] of images.entries()) {
    const bytes = Buffer.from(img.bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    // Stored once: the emblem of every NS decision is one row here.
    await tx.query("INSERT INTO mirror.image_blob (sha256, mime, bytes) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING", [
      sha,
      img.mime,
      bytes,
    ]);
    await tx.query(
      `INSERT INTO mirror.decision_image (decision_id, ord, char_at, mime, width, height, sha256, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ord, img.charAt, img.mime, img.width, img.height, sha, img.sourceUrl ?? null],
    );
  }
}

/** Replace the chunks of decision `id` with those derived from `record`. */
export async function writeChunks(tx: Queryable, record: DecisionRecord, id: number): Promise<number> {
  await tx.query("DELETE FROM mirror.decision_chunk WHERE source = $1 AND decision_id = $2", [record.source, id]);
  const chunks = deriveChunks(record);
  if (chunks.length === 0) return 0;
  await tx.query(
    `INSERT INTO mirror.decision_chunk (source, decision_id, ord, char_start, char_end, tsv, ident_keys)
     SELECT $1, $2, c.ord, c.char_start, c.char_end, c.tsv::tsvector, c.ident_keys
     FROM jsonb_to_recordset($3::jsonb) AS c(ord int, char_start int, char_end int, tsv text, ident_keys text[])`,
    [
      record.source,
      id,
      JSON.stringify(chunks.map((c) => ({ ord: c.ord, char_start: c.start, char_end: c.end, tsv: c.tsv, ident_keys: c.identKeys }))),
    ],
  );
  return chunks.length;
}

/**
 * Source ids (of `ids`) that are done: stored by parser `parserVersion` or
 * newer and not waiting in fetch_queue — with text, or without it when that
 * is the source's state (textAbsent: SDEU without a Czech version is never
 * queued). A resumed backfill skips them; an older parser's rows and queued
 * ones (failed, or no text yet) it fetches again.
 */
export async function idsWithText(db: Queryable, source: MirrorSource, ids: string[], parserVersion: number): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await db.query<{ source_id: string }>(
    `SELECT d.source_id FROM mirror.decision d
     WHERE d.source = $1 AND d.source_id = ANY($2::text[]) AND d.parser_version >= $3
       AND (d.text_sha256 IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM mirror.fetch_queue q WHERE q.source = d.source AND q.source_id = d.source_id))`,
    [source, ids, parserVersion],
  );
  return new Set(rows.map((r) => r.source_id));
}

// ---------- fetch_queue ----------

export type QueueKind = "decision" | "text";

/** Retry after 1 h, 2 h, 4 h … capped at 7 days. */
export async function enqueue(db: Queryable, source: MirrorSource, sourceId: string, kind: QueueKind, error: string): Promise<void> {
  await db.query(
    `INSERT INTO mirror.fetch_queue AS q (source, source_id, kind, attempts, next_try_at, last_error)
     VALUES ($1, $2, $3, 1, now() + interval '1 hour', $4)
     ON CONFLICT (source, source_id, kind) DO UPDATE SET
       attempts = q.attempts + 1,
       next_try_at = now() + least(interval '1 hour' * power(2, q.attempts), interval '7 days'),
       last_error = EXCLUDED.last_error`,
    [source, sourceId, kind, error.slice(0, 1000)],
  );
}

export async function dequeue(db: Queryable, source: MirrorSource, sourceId: string): Promise<void> {
  await db.query("DELETE FROM mirror.fetch_queue WHERE source = $1 AND source_id = $2", [source, sourceId]);
}

// ---------- sync_cursor / sync_run ----------

export async function readCursor<T>(db: Queryable, source: MirrorSource): Promise<T | null> {
  const { rows } = await db.query<{ cursor: T }>("SELECT cursor FROM mirror.sync_cursor WHERE source = $1", [source]);
  return rows[0]?.cursor ?? null;
}

export async function writeCursor(db: Queryable, source: MirrorSource, cursor: unknown): Promise<void> {
  await db.query(
    `INSERT INTO mirror.sync_cursor (source, cursor, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [source, JSON.stringify(cursor)],
  );
}

export interface RunCounts {
  fetched: number;
  changed: number;
  failed: number;
}

export type RunMode = "backfill" | "sync" | "reindex" | "retry";

export async function startRun(db: Queryable, source: MirrorSource, mode: RunMode): Promise<number> {
  const { rows } = await db.query<{ id: string | number }>(
    "INSERT INTO mirror.sync_run (source, mode) VALUES ($1, $2) RETURNING id",
    [source, mode],
  );
  return Number(rows[0].id);
}

/** Counts so far of a run still going — `mirror status` shows progress of a days-long backfill. */
export async function updateRun(db: Queryable, id: number, counts: RunCounts): Promise<void> {
  await db.query("UPDATE mirror.sync_run SET fetched = $2, changed = $3, failed = $4 WHERE id = $1", [
    id,
    counts.fetched,
    counts.changed,
    counts.failed,
  ]);
}

export async function finishRun(db: Queryable, id: number, counts: RunCounts, error: string | null): Promise<void> {
  await db.query(
    "UPDATE mirror.sync_run SET finished_at = now(), fetched = $2, changed = $3, failed = $4, error = $5 WHERE id = $1",
    [id, counts.fetched, counts.changed, counts.failed, error?.slice(0, 2000) ?? null],
  );
}
