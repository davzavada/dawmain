import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/src/mirror/db/client";

/** A PGlite database with the mirror migrations applied by the real runner, as a mirror Db. */

interface Migrator {
  migrate(
    client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
    options?: { dir?: string; rlsCheck?: boolean; log?: (line: string) => void },
  ): Promise<unknown>;
}

export async function createMirrorTestDb(): Promise<{ pg: PGlite; db: Db; close(): Promise<void> }> {
  const pg = await PGlite.create();
  const root = path.dirname(path.dirname(__dirname));
  const m = (await import(/* @vite-ignore */ path.join(root, "scripts", "db-migrate.mjs"))) as Migrator;
  await m.migrate(
    {
      async query(text, params) {
        if (params) return (await pg.query(text, params)) as { rows: Record<string, unknown>[] };
        const results = await pg.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      },
    },
    { dir: path.join(root, "src", "mirror", "db", "migrations"), rlsCheck: false, log: () => undefined },
  );
  const db: Db = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  return { pg, db, close: () => pg.close() };
}
