import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DB_PATH ?? path.resolve(here, '../../data/crm.sqlite');
const MIGRATIONS_DIR = path.resolve(here, '../migrations');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Applies migrations/NNN_*.sql files with NNN greater than the database's
 * current PRAGMA user_version, each inside a transaction. Runs at startup;
 * adding a migration file and restarting is the whole migration story.
 */
export function migrate(): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let current = row.user_version;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= current) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    current = version;
  }
}

export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function touchPerson(id: number): void {
  db.prepare(`UPDATE people SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function touchPublication(id: number): void {
  db.prepare(`UPDATE publications SET updated_at = datetime('now') WHERE id = ?`).run(id);
}
