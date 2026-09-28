import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import {
  ensureLibrary,
  forgetPages,
  getLibraries,
  globalUsage,
  listAllLibraries,
  markLibraryForPurge,
  purgeLibraryContent,
  releasePages,
  reservePages,
  settlePages,
} from "@/src/files/db/libraries";
import { createTestDb, type TestDb } from "./helpers/pglite";

/** Library rows and page accounting on PGlite, as dawmain_app with RLS. */

let t: TestDb;
const scoped = <T>(libs: string[], fn: (db: Queryable) => Promise<T>) => withScope(libs, fn);
let seq = 0;

async function seedDocs(lib: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const sha = (++seq).toString(16).padStart(64, "0");
    const { rows } = await t.owner.query<{ id: string }>(
      `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter,
         rights, billable_pages, char_count, page_label_source)
       VALUES ($1, 'ready', 'user_u1', 'pdf', 'f.pdf', $2, $2, 'pdf@1', 'vlastni', 1, 100, 'physical') RETURNING id`,
      [lib, sha],
    );
    await t.owner.query(
      "INSERT INTO chunks (doc_id, library_id, ord, char_start, char_end, tsv) VALUES ($1, $2, 0, 0, 10, 'x')",
      [rows[0].id, lib],
    );
  }
}

const counters = async (id: string) =>
  (
    await t.owner.query<{ page_count: number; pages_reserved: number; doc_count: number }>(
      "SELECT page_count, pages_reserved, doc_count FROM libraries WHERE id = $1",
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});

describe("ensureLibrary / getLibraries", () => {
  it("creates on first use, refreshes the name, keeps it when called with null", async () => {
    await scoped(["user_a"], (db) => ensureLibrary(db, "user_a", "Anna"));
    await scoped(["org_b"], (db) => ensureLibrary(db, "org_b", "Tým B"));
    await scoped(["user_a"], (db) => ensureLibrary(db, "user_a", "Anna Nová"));
    await scoped(["user_a"], (db) => ensureLibrary(db, "user_a", null));
    const [a] = await scoped(["user_a"], (db) => getLibraries(db, ["user_a"]));
    expect(a).toEqual({
      id: "user_a",
      kind: "user",
      display_name: "Anna Nová",
      settings: {},
      page_count: 0,
      pages_reserved: 0,
      doc_count: 0,
      pro_revoked_at: null,
      purge_after: null,
    });
    const [b] = await scoped(["org_b"], (db) => getLibraries(db, ["org_b"]));
    expect(b.kind).toBe("org");
  });

  it("caps an overlong display name", async () => {
    await scoped(["user_long"], (db) => ensureLibrary(db, "user_long", "x".repeat(1000)));
    const [l] = await scoped(["user_long"], (db) => getLibraries(db, ["user_long"]));
    expect(l.display_name).toHaveLength(200);
  });

  it("isolation: a foreign library is invisible and cannot be created or renamed", async () => {
    expect(await scoped(["user_a"], (db) => getLibraries(db, ["org_b"]))).toEqual([]);
    expect((await scoped(["user_a", "org_b"], (db) => getLibraries(db, ["user_a"]))).map((l) => l.id)).toEqual(["user_a"]);
    expect((await scoped(["user_a", "org_b"], (db) => getLibraries(db, ["user_a", "org_b"]))).map((l) => l.id)).toEqual(["org_b", "user_a"]);
    await expect(scoped(["user_a"], (db) => ensureLibrary(db, "org_b", "Ukradeno"))).rejects.toThrow(/row-level security/);
    await expect(scoped(["user_a"], (db) => ensureLibrary(db, "org_new", "X"))).rejects.toThrow(/row-level security/);
    const [b] = await scoped(["org_b"], (db) => getLibraries(db, ["org_b"]));
    expect(b.display_name).toBe("Tým B");
    expect(await scoped(["user_a"], (db) => getLibraries(db, []))).toEqual([]);
  });
});

describe("page accounting", () => {
  it("reserve → settle → forget; reserve → release; floors at zero", async () => {
    const lib = "user_pages";
    await scoped([lib], (db) => ensureLibrary(db, lib, null));
    expect(await scoped([lib], (db) => reservePages(db, lib, 10, 100, 1_000_000))).toBe("ok");
    expect(await counters(lib)).toEqual({ page_count: 0, pages_reserved: 10, doc_count: 0 });
    await scoped([lib], (db) => settlePages(db, lib, 10, 9));
    expect(await counters(lib)).toEqual({ page_count: 9, pages_reserved: 0, doc_count: 1 });
    expect(await scoped([lib], (db) => reservePages(db, lib, 5, 100, 1_000_000))).toBe("ok");
    await scoped([lib], (db) => releasePages(db, lib, 5));
    await scoped([lib], (db) => releasePages(db, lib, 5)); // double release floors at 0
    expect(await counters(lib)).toEqual({ page_count: 9, pages_reserved: 0, doc_count: 1 });
    await scoped([lib], (db) => forgetPages(db, lib, 9));
    await scoped([lib], (db) => forgetPages(db, lib, 9));
    expect(await counters(lib)).toEqual({ page_count: 0, pages_reserved: 0, doc_count: 0 });
  });

  it("reservePages answers library / global when a cap would be exceeded", async () => {
    const lib = "user_caps";
    await scoped([lib], (db) => ensureLibrary(db, lib, null));
    expect(await scoped([lib], (db) => reservePages(db, lib, 8, 10, 1_000_000))).toBe("ok");
    expect(await scoped([lib], (db) => reservePages(db, lib, 3, 10, 1_000_000))).toBe("library");
    expect(await scoped([lib], (db) => reservePages(db, lib, 1, 1_000, 5))).toBe("global");
    expect((await counters(lib)).pages_reserved).toBe(8);
  });

  it("rejects non-positive or fractional page counts before touching the DB", async () => {
    const lib = "user_caps";
    await expect(scoped([lib], (db) => reservePages(db, lib, 0, 10, 10))).rejects.toThrow(RangeError);
    await expect(scoped([lib], (db) => reservePages(db, lib, 1.5, 10, 10))).rejects.toThrow(RangeError);
    await expect(scoped([lib], (db) => settlePages(db, lib, -1, 1))).rejects.toThrow(RangeError);
    await expect(scoped([lib], (db) => releasePages(db, lib, Number.NaN))).rejects.toThrow(RangeError);
    await expect(scoped([lib], (db) => forgetPages(db, lib, -3))).rejects.toThrow(RangeError);
  });

  it("isolation: counters of a foreign library cannot be touched", async () => {
    const before = await counters("org_b");
    await expect(scoped(["user_a"], (db) => reservePages(db, "org_b", 1, 100, 1_000_000))).rejects.toThrow(/outside scope/);
    await scoped(["user_a"], async (db) => {
      await settlePages(db, "org_b", 0, 50);
      await releasePages(db, "org_b", 1);
      await forgetPages(db, "org_b", 1);
    });
    expect(await counters("org_b")).toEqual(before);
  });
});

describe("globalUsage / listAllLibraries", () => {
  it("aggregates over every library from any scope (system functions), content-free", async () => {
    const usage = await scoped([], (db) => globalUsage(db));
    const total = await t.owner.query<{ p: number; r: number; n: number }>(
      "SELECT sum(page_count)::int AS p, sum(pages_reserved)::int AS r, count(*)::int AS n FROM libraries WHERE purged_at IS NULL",
    );
    expect(usage.totalPages).toBe(total.rows[0].p);
    expect(usage.reservedPages).toBe(total.rows[0].r);
    expect(usage.libraries).toBe(total.rows[0].n);
    expect(typeof usage.documents).toBe("number");
    expect(usage.dbBytes).toBeGreaterThan(0);

    const all = await scoped([], (db) => listAllLibraries(db));
    expect(all.map((l) => l.id)).toContain("org_b");
    const b = all.find((l) => l.id === "org_b")!;
    expect(b).toMatchObject({ kind: "org", display_name: "Tým B", settings: {} });
    expect(b.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("markLibraryForPurge / purgeLibraryContent", () => {
  it("marks once — a later mark never postpones the date", async () => {
    const lib = "org_purge";
    await scoped([lib], (db) => ensureLibrary(db, lib, "Kancelář"));
    const soon = new Date("2026-10-04T00:00:00Z");
    await scoped([lib], (db) => markLibraryForPurge(db, lib, soon));
    await scoped([lib], (db) => markLibraryForPurge(db, lib, new Date("2027-01-01T00:00:00Z")));
    expect((await scoped([lib], (db) => getLibraries(db, [lib])))[0].purge_after).toBe(soon.toISOString());
    const sooner = new Date("2026-10-01T00:00:00Z");
    await scoped([lib], (db) => markLibraryForPurge(db, lib, sooner));
    expect((await scoped([lib], (db) => getLibraries(db, [lib])))[0].purge_after).toBe(sooner.toISOString());
  });

  it("purges every document in batches, zeroes counters, drops the name, sets purged_at", async () => {
    const lib = "org_purge";
    await seedDocs(lib, 45);
    await seedDocs("user_a", 2);
    expect(await scoped([lib], (db) => reservePages(db, lib, 3, 100, 1_000_000))).toBe("ok");
    // Not marked, or marked for later: nothing happens.
    expect(await scoped([lib], (db) => purgeLibraryContent(db, lib))).toBe(0);
    await scoped([lib], (db) => markLibraryForPurge(db, lib, new Date(Date.now() + 86_400_000)));
    expect(await scoped([lib], (db) => purgeLibraryContent(db, lib))).toBe(0);
    await t.owner.query("UPDATE libraries SET purge_after = now() - interval '1 minute' WHERE id = $1", [lib]);
    expect(await scoped([lib], (db) => purgeLibraryContent(db, lib))).toBe(45);
    const left = await t.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM chunks WHERE library_id = $1", [lib]);
    expect(left.rows[0].n).toBe(0);
    const row = await t.owner.query("SELECT display_name, page_count, pages_reserved, doc_count, purged_at FROM libraries WHERE id = $1", [lib]);
    expect(row.rows[0]).toMatchObject({ display_name: null, page_count: 0, pages_reserved: 0, doc_count: 0 });
    expect((row.rows[0] as { purged_at: unknown }).purged_at).not.toBeNull();
    // A purged library is out of the system listing and its mark is frozen.
    expect((await scoped([], (db) => listAllLibraries(db))).map((l) => l.id)).not.toContain(lib);
    expect(await scoped([lib], (db) => purgeLibraryContent(db, lib))).toBe(0);
  });

  it("isolation: a foreign library can be neither marked nor purged", async () => {
    await scoped(["user_a"], (db) => markLibraryForPurge(db, "org_b", new Date()));
    expect((await scoped(["org_b"], (db) => getLibraries(db, ["org_b"])))[0].purge_after).toBeNull();
    expect(await scoped(["org_b"], (db) => purgeLibraryContent(db, "user_a"))).toBe(0);
    const a = await t.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE library_id = 'user_a'");
    expect(a.rows[0].n).toBe(2);
    const name = await t.owner.query<{ display_name: string }>("SELECT display_name FROM libraries WHERE id = 'user_a'");
    expect(name.rows[0].display_name).toBe("Anna Nová");
  });
});
