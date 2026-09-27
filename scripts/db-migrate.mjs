#!/usr/bin/env node
/**
 * Apply the Vlastní zdroje schema migrations (src/files/db/migrations/*.sql).
 *
 *   DATABASE_URL_UNPOOLED=postgres://owner@…/db node scripts/db-migrate.mjs
 *   DATABASE_URL_UNPOOLED=… node scripts/db-migrate.mjs --dry-run   # list pending, change nothing
 *
 * Runs with the OWNER connection (direct, not pooled — advisory locks and
 * DDL need a session), by hand before a deploy; never at build time and
 * never with FILES_DATABASE_URL (the app role must not own the schema).
 *
 * - Files apply in name order, each in its own transaction, recorded in
 *   schema_migrations(filename, sha256, applied_at).
 * - A session advisory lock serializes concurrent runs.
 * - An applied file whose content changed since is a hard stop: fix forward
 *   with a new file instead of editing history.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "files", "db", "migrations");

/** Arbitrary constant key of the advisory lock ("dawmain-migrate"). */
export const LOCK_KEY = 4_815_162_342;

/**
 * @typedef {{ query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }} Client
 *   pg's Client in production; tests pass a PGlite adapter. `query(text)`
 *   without params must accept several statements (pg's simple protocol does).
 * @typedef {{ filename: string, sha256: string, sql: string }} MigrationFile
 */

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @returns {MigrationFile[]} the .sql files of `dir`, sorted by name. */
export function readMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(path.join(dir, filename), "utf8");
      return { filename, sha256: sha256(sql), sql };
    });
}

/**
 * Compare local files with the applied ones. Throws on a changed checksum.
 * @param {MigrationFile[]} files
 * @param {Array<{ filename: string, sha256: string }>} applied
 * @returns {{ pending: MigrationFile[], missing: string[] }}
 */
export function plan(files, applied) {
  const local = new Map(files.map((f) => [f.filename, f]));
  const done = new Map(applied.map((a) => [a.filename, a.sha256]));
  const changed = applied.filter((a) => local.has(a.filename) && local.get(a.filename).sha256 !== a.sha256);
  if (changed.length > 0) {
    throw new Error(
      `applied migration(s) changed since they ran: ${changed.map((c) => c.filename).join(", ")} — ` +
        "restore the original file(s) and add a new migration instead",
    );
  }
  return {
    pending: files.filter((f) => !done.has(f.filename)),
    missing: applied.filter((a) => !local.has(a.filename)).map((a) => a.filename),
  };
}

async function appliedMigrations(client) {
  const { rows } = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
  if (!rows[0]?.present) return [];
  const res = await client.query("SELECT filename, sha256 FROM schema_migrations ORDER BY filename");
  return res.rows.map((r) => ({ filename: String(r.filename), sha256: String(r.sha256) }));
}

/**
 * Apply pending migrations through `client` (connected as the owner).
 * @param {Client} client
 * @param {{ dir?: string, dryRun?: boolean, log?: (line: string) => void }} [options]
 * @returns {Promise<{ applied: string[], pending: string[] }>}
 */
export async function migrate(client, options = {}) {
  const { dir = MIGRATIONS_DIR, dryRun = false, log = console.log } = options;
  const files = readMigrations(dir);
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    const { pending, missing } = plan(files, await appliedMigrations(client));
    for (const name of missing) log(`warning: ${name} is recorded as applied but missing locally`);
    if (dryRun) {
      if (pending.length === 0) log("nothing pending");
      for (const f of pending) log(`pending  ${f.filename}  ${f.sha256.slice(0, 12)}`);
      return { applied: [], pending: pending.map((f) => f.filename) };
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   text PRIMARY KEY,
         sha256     text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = [];
    for (const f of pending) {
      await client.query("BEGIN");
      try {
        await client.query(f.sql);
        await client.query("INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)", [f.filename, f.sha256]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`${f.filename} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
      }
      applied.push(f.filename);
      log(`applied  ${f.filename}  ${f.sha256.slice(0, 12)}`);
    }
    if (applied.length === 0) log("up to date — nothing to apply");
    return { applied, pending: [] };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!url) {
    console.error("DATABASE_URL_UNPOOLED is not set (the owner's direct connection string).");
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, { dryRun });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`db-migrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
