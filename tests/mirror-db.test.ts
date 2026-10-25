import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The mirror schema (src/mirror/db/migrations) applied by the same runner as
 * on the server (scripts/db-migrate.mjs, rlsCheck off), then checked for the
 * guarantees the crawler and the API rely on: identity per source, text
 * cascade, chunk partitions, and the writer / reader split.
 */

interface Migrator {
  migrate(
    client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
    options?: { dir?: string; dryRun?: boolean; rlsCheck?: boolean; log?: (line: string) => void },
  ): Promise<{ applied: string[]; pending: string[] }>;
}

const SCRIPT = path.resolve(__dirname, "..", "scripts", "db-migrate.mjs");
const DIR = path.resolve(__dirname, "..", "src", "mirror", "db", "migrations");

let db: PGlite;
let m: Migrator;

const client = {
  async query(text: string, params?: unknown[]) {
    if (params) return (await db.query(text, params)) as { rows: Record<string, unknown>[] };
    const results = await db.exec(text);
    return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
  },
};

async function insertDecision(source: string, sourceId: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO mirror.decision (source, source_id, url, parser_version)
     VALUES ($1, $2, 'https://example.test/' || $2, 1) RETURNING id`,
    [source, sourceId],
  );
  return Number(rows[0].id);
}

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}

beforeAll(async () => {
  m = (await import(/* @vite-ignore */ SCRIPT)) as Migrator;
  db = await PGlite.create();
  await m.migrate(client, { dir: DIR, rlsCheck: false, log: () => undefined });
});
afterAll(async () => {
  await db.close();
});

describe("mirror schema", () => {
  it("creates the tables and one chunk partition per source", async () => {
    const { rows } = await db.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'mirror' ORDER BY 1",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "decision",
      "decision_chunk",
      "decision_chunk_justice",
      "decision_chunk_ns",
      "decision_chunk_nss",
      "decision_chunk_sdeu",
      "decision_chunk_us",
      "decision_dissent",
      "decision_image",
      "decision_text",
      "fetch_queue",
      "image_blob",
      "sync_cursor",
      "sync_run",
    ]);
    const parted = await db.query("SELECT 1 FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = 'decision_chunk'");
    expect(parted.rows).toHaveLength(1);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const lines: string[] = [];
    const result = await m.migrate(client, { dir: DIR, rlsCheck: false, log: (l) => lines.push(l) });
    expect(result.applied).toEqual([]);
    expect(lines).toContain("up to date — nothing to apply");
  });

  it("identifies a decision by (source, source_id), not by case number", async () => {
    await insertDecision("ns", "UNID-A");
    await insertDecision("nss", "UNID-A");
    await expect(insertDecision("ns", "UNID-A")).rejects.toThrow(/duplicate key/);
    await expect(insertDecision("nalus", "x")).rejects.toThrow(/check constraint/);
  });

  it("deletes text and chunks with the decision", async () => {
    const id = await insertDecision("us", "IV.ÚS 1/24");
    await db.query("INSERT INTO mirror.decision_text (decision_id, body, char_count, text_source) VALUES ($1, 'text', 4, 'us:gettext')", [id]);
    await db.query(
      "INSERT INTO mirror.decision_chunk (source, decision_id, ord, char_start, char_end, tsv, ident_keys) VALUES ('us', $1, 0, 0, 4, to_tsvector('simple', 'text'), '{}')",
      [id],
    );
    const routed = await db.query("SELECT 1 FROM mirror.decision_chunk_us WHERE decision_id = $1", [id]);
    expect(routed.rows).toHaveLength(1);
    await db.query("DELETE FROM mirror.decision WHERE id = $1", [id]);
    const left = await db.query(
      "SELECT (SELECT count(*) FROM mirror.decision_text WHERE decision_id = $1) + (SELECT count(*) FROM mirror.decision_chunk WHERE decision_id = $1) AS n",
      [id],
    );
    expect(Number((left.rows[0] as { n: unknown }).n)).toBe(0);
  });

  it("rejects a chunk whose source has no partition", async () => {
    const id = await insertDecision("ns", "UNID-B");
    await expect(
      db.query(
        "INSERT INTO mirror.decision_chunk (source, decision_id, ord, char_start, char_end, tsv) VALUES ('other', $1, 0, 0, 1, ''::tsvector)",
        [id],
      ),
    ).rejects.toThrow(/no partition/);
  });

  it("lets the writer write and the reader only read", async () => {
    await asRole("mirror_writer", async () => {
      await insertDecision("justice", "uuid-1");
      await db.query("INSERT INTO mirror.sync_run (source, mode) VALUES ('justice', 'backfill')");
    });
    await asRole("mirror_reader", async () => {
      const { rows } = await db.query("SELECT count(*) AS n FROM mirror.decision WHERE source = 'justice'");
      expect(Number((rows[0] as { n: unknown }).n)).toBe(1);
      await expect(insertDecision("justice", "uuid-2")).rejects.toThrow(/permission denied/);
    });
  });
});
