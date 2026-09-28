import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/db-migrate.mjs against PGlite. The script's core takes any client
 * with pg's query(text, params) shape; the adapter below runs parameterless
 * text through exec() so multi-statement files work as with pg's simple
 * query protocol.
 */

interface Migrator {
  MIGRATIONS_DIR: string;
  sha256(text: string): string;
  readMigrations(dir?: string): Array<{ filename: string; sha256: string; sql: string }>;
  plan(
    files: Array<{ filename: string; sha256: string; sql: string }>,
    applied: Array<{ filename: string; sha256: string }>,
  ): { pending: Array<{ filename: string }>; missing: string[] };
  migrate(
    client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
    options?: { dir?: string; dryRun?: boolean; log?: (line: string) => void },
  ): Promise<{ applied: string[]; pending: string[] }>;
}

let m: Migrator;
const SCRIPT = path.resolve(__dirname, "..", "scripts", "db-migrate.mjs");
const dirs: string[] = [];
const dbs: PGlite[] = [];

beforeAll(async () => {
  m = (await import(/* @vite-ignore */ SCRIPT)) as Migrator;
});
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const db of dbs.splice(0)) await db.close();
});

async function freshClient() {
  const db = await PGlite.create();
  dbs.push(db);
  const client = {
    async query(text: string, params?: unknown[]) {
      if (params) return (await db.query(text, params)) as { rows: Record<string, unknown>[] };
      const results = await db.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
    },
  };
  return { db, client };
}

function copyMigrations(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dawmain-migrate-"));
  dirs.push(dir);
  cpSync(m.MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

describe("plan", () => {
  const f = (filename: string, body: string) => ({ filename, sha256: m.sha256(body), sql: body });

  it("lists pending files in order and applied files missing locally", () => {
    const files = [f("0001_a.sql", "a"), f("0002_b.sql", "b"), f("0003_c.sql", "c")];
    const res = m.plan(files, [
      { filename: "0001_a.sql", sha256: m.sha256("a") },
      { filename: "0000_gone.sql", sha256: "x" },
    ]);
    expect(res.pending.map((p) => p.filename)).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(res.missing).toEqual(["0000_gone.sql"]);
  });

  it("refuses when an applied file changed", () => {
    expect(() => m.plan([f("0001_a.sql", "a2")], [{ filename: "0001_a.sql", sha256: m.sha256("a") }])).toThrow(/changed since they ran: 0001_a\.sql/);
  });

  it("reads only .sql files, sorted", () => {
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "README.txt"), "not a migration");
    const names = m.readMigrations(dir).map((x) => x.filename);
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => n.endsWith(".sql"))).toBe(true);
    expect(names).toContain("0001_init.sql");
  });
});

describe("runbook", () => {
  it("docs/development.md names every migration file, so a deploy note never misses one", () => {
    const runbook = readFileSync(path.resolve(__dirname, "..", "docs", "development.md"), "utf8");
    const names = m.readMigrations().map((x) => x.filename);
    expect(names).toEqual(expect.arrayContaining(["0003_ops.sql", "0004_search.sql"]));
    for (const name of names) expect(runbook).toContain(`\`${name}\``);
  });
});

// Each test boots its own PGlite and applies every migration (~2–3 s alone): the 5 s default
// is too tight when the whole suite runs in parallel on a loaded machine.
describe("migrate", { timeout: 30_000 }, () => {
  it("applies every file once, records checksums, and is a no-op the second time", async () => {
    const { db, client } = await freshClient();
    const log: string[] = [];
    const first = await m.migrate(client, { log: (l) => log.push(l) });
    const files = m.readMigrations();
    expect(first.applied).toEqual(files.map((x) => x.filename));
    expect(log.filter((l) => l.startsWith("applied"))).toHaveLength(files.length);
    const recorded = await db.query<{ filename: string; sha256: string }>("SELECT filename, sha256 FROM schema_migrations ORDER BY filename");
    expect(recorded.rows).toEqual(files.map((x) => ({ filename: x.filename, sha256: x.sha256 })));
    // The schema is really there, including the app role.
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'dawmain_app'");
    expect(role.rows).toHaveLength(1);

    const again: string[] = [];
    expect((await m.migrate(client, { log: (l) => again.push(l) })).applied).toEqual([]);
    expect(again).toContain("up to date — nothing to apply");
  });

  it("--dry-run lists pending files and changes nothing", async () => {
    const { db, client } = await freshClient();
    const log: string[] = [];
    const res = await m.migrate(client, { dryRun: true, log: (l) => log.push(l) });
    expect(res.pending).toEqual(m.readMigrations().map((x) => x.filename));
    expect(log.every((l) => l.startsWith("pending"))).toBe(true);
    const table = await db.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
    expect(table.rows[0].t).toBeNull();
    const docs = await db.query<{ t: string | null }>("SELECT to_regclass('public.documents')::text AS t");
    expect(docs.rows[0].t).toBeNull();
  });

  it("refuses to continue when an applied file was edited — and applies nothing new", async () => {
    const dir = copyMigrations();
    const { db, client } = await freshClient();
    await m.migrate(client, { dir, log: () => undefined });
    writeFileSync(path.join(dir, "0001_init.sql"), m.readMigrations(dir)[0].sql + "\n-- edited\n");
    writeFileSync(path.join(dir, "0099_new.sql"), "CREATE TABLE should_not_exist (x int);");
    await expect(m.migrate(client, { dir, log: () => undefined })).rejects.toThrow(/0001_init\.sql/);
    const t = await db.query<{ t: string | null }>("SELECT to_regclass('public.should_not_exist')::text AS t");
    expect(t.rows[0].t).toBeNull();
  });

  it("rolls a failing file back completely and stops there", async () => {
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0098_bad.sql"), "CREATE TABLE half_done (x int);\nSELECT 1/0;");
    writeFileSync(path.join(dir, "0099_after.sql"), "CREATE TABLE after_bad (x int);");
    const { db, client } = await freshClient();
    await expect(m.migrate(client, { dir, log: () => undefined })).rejects.toThrow(/0098_bad\.sql failed and was rolled back/);
    const t = await db.query<{ a: string | null; b: string | null }>(
      "SELECT to_regclass('public.half_done')::text AS a, to_regclass('public.after_bad')::text AS b",
    );
    expect(t.rows[0]).toEqual({ a: null, b: null });
    const recorded = await db.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(recorded.rows.map((r) => r.filename)).toEqual(m.readMigrations().map((x) => x.filename));
    // The advisory lock was released: a fixed run proceeds.
    writeFileSync(path.join(dir, "0098_bad.sql"), "CREATE TABLE half_done (x int);");
    expect((await m.migrate(client, { dir, log: () => undefined })).applied).toEqual(["0098_bad.sql", "0099_after.sql"]);
  });

  it("refuses a role that does not bypass row-level security, before changing anything", async () => {
    const { db, client } = await freshClient();
    await db.exec("CREATE ROLE plain_role NOLOGIN NOBYPASSRLS; GRANT ALL ON SCHEMA public TO plain_role; SET ROLE plain_role");
    await expect(m.migrate(client, { dir: copyMigrations(), log: () => undefined })).rejects.toThrow(/does not bypass row-level security/);
    await db.exec("RESET ROLE");
    const { rows } = await db.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    expect(rows[0].present).toBe(false);
  });

  it("warns about applied files that are missing locally", async () => {
    const dir = copyMigrations();
    writeFileSync(path.join(dir, "0099_extra.sql"), "SELECT 1;");
    const { client } = await freshClient();
    await m.migrate(client, { dir, log: () => undefined });
    rmSync(path.join(dir, "0099_extra.sql"));
    const log: string[] = [];
    await m.migrate(client, { dir, log: (l) => log.push(l) });
    expect(log).toContain("warning: 0099_extra.sql is recorded as applied but missing locally");
  });
});
