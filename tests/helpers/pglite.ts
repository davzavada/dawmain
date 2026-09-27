import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Queryable, ScopeRunner } from "@/src/files/db/client";

/**
 * A real Postgres (PGlite, WASM) with the production migrations applied, and
 * a ScopeRunner that behaves like withScope: one transaction, SET LOCAL ROLE
 * dawmain_app (so RLS applies exactly as on Neon), transaction-local
 * app.library_ids. PGlite is a single connection, so transactions are
 * serialized through a promise chain.
 */

const MIGRATIONS = path.join(path.dirname(path.dirname(__dirname)), "src", "files", "db", "migrations");

export interface TestDb {
  db: PGlite;
  runner: ScopeRunner;
  /** Run as the owner (bypasses RLS) — for fixtures and assertions. */
  owner: Queryable;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
  const owner: Queryable = {
    query: async (text, params) => (await db.query(text, params)) as { rows: never[] },
  };
  let chain: Promise<unknown> = Promise.resolve();
  const runner: ScopeRunner = (libraryIds, fn, options) => {
    const run = async () => {
      await db.exec("BEGIN");
      try {
        await db.exec("SET LOCAL ROLE dawmain_app");
        await db.query("SELECT set_config('app.library_ids', $1, true)", [libraryIds.join(",")]);
        if (options?.statementTimeoutMs) {
          await db.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs)]);
        }
        const result = await fn(owner);
        await db.exec("COMMIT");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next as never;
  };
  return { db, runner, owner, close: () => db.close() };
}
