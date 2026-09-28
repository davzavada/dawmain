import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * Row-level security is the backstop behind every WHERE library_id: these
 * run the real migrations on PGlite and act as dawmain_app, the runtime role.
 */

let t: TestDb;

const SHA = (c: string) => c.repeat(64);

async function seedDoc(lib: string, sha: string): Promise<string> {
  await t.owner.query("INSERT INTO libraries (id) VALUES ($1) ON CONFLICT DO NOTHING", [lib]);
  const { rows } = await t.owner.query<{ id: string }>(
    `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256,
       converter, rights, billable_pages, char_count, page_label_source, title)
     VALUES ($1, 'ready', 'user_u1', 'pdf', 'a.pdf', $2, $2, 'pdf@1', 'verejne', 3, 9000, 'physical', 'T')
     RETURNING id`,
    [lib, sha],
  );
  return rows[0].id;
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDoc("user_a", SHA("a"));
  await seedDoc("org_b", SHA("b"));
});
afterAll(async () => t.close());

describe("RLS on the files schema", () => {
  it("shows only rows of the scoped libraries", async () => {
    const rows = await t.runner(["user_a"], (db) => db.query<{ library_id: string }>("SELECT library_id FROM documents"));
    expect(rows.rows.map((r) => r.library_id)).toEqual(["user_a"]);
  });

  it("an empty scope sees nothing — fails closed", async () => {
    const rows = await t.runner([], (db) => db.query("SELECT id FROM documents"));
    expect(rows.rows).toEqual([]);
    const libs = await t.runner([], (db) => db.query("SELECT id FROM libraries"));
    expect(libs.rows).toEqual([]);
  });

  it("cannot insert into, or move a row to, a library outside the scope", async () => {
    await expect(
      t.runner(["user_a"], (db) =>
        db.query(
          `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256,
             converter, rights, billable_pages, char_count, page_label_source)
           VALUES ('org_b', 'queued', 'user_u1', 'pdf', 'x.pdf', $1, $1, 'pdf@1', 'verejne', 1, 10, 'physical')`,
          [SHA("c")],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      t.runner(["user_a", "org_b"], (db) => db.query("UPDATE documents SET library_id = 'org_b' WHERE library_id = 'user_a'")),
    ).rejects.toThrow(/immutable/);
  });

  it("runs as a role without RLS bypass", async () => {
    const rows = await t.runner([], (db) =>
      db.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(rows.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("reserves pages atomically against the library and the global cap, only inside the scope", async () => {
    const reserve = (lib: string, n: number, libCap: number, globalCap: number, scope = [lib]) =>
      t.runner(scope, async (db) => {
        const { rows } = await db.query<{ r: string }>("SELECT files_reserve_pages($1, $2, $3, $4) AS r", [lib, n, libCap, globalCap]);
        return rows[0].r;
      });
    expect(await reserve("user_a", 5, 10, 100)).toBe("ok");
    expect(await reserve("user_a", 6, 10, 100)).toBe("library");
    expect(await reserve("user_a", 1, 100, 5)).toBe("global");
    await expect(reserve("org_b", 1, 10, 100, ["user_a"])).rejects.toThrow(/outside scope/);
    const usage = await t.runner([], (db) => db.query<{ reserved_pages: string }>("SELECT * FROM files_global_usage()"));
    expect(Number(usage.rows[0].reserved_pages)).toBe(5);
  });
});

describe("child rows cannot point across libraries", () => {
  it("the composite (doc_id, library_id) FK rejects a chunk claiming another library's document, even with both in scope", async () => {
    const { rows } = await t.owner.query<{ id: string }>("SELECT id FROM documents WHERE library_id = 'org_b'");
    await expect(
      t.runner(["user_a", "org_b"], (db) =>
        db.query("INSERT INTO chunks (doc_id, library_id, ord, char_start, char_end, tsv) VALUES ($1, 'user_a', 0, 0, 1, 'x')", [rows[0].id]),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
