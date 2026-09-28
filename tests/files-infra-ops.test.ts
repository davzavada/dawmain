import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operations (migration 0003_ops.sql and its callers): the re-derivation
 * budget, the live database size, the guards on the operator's batch,
 * retention, notice-and-takedown across libraries and the nightly recount.
 * Clerk, after() and the model call are mocked; the database is PGlite with
 * the real migrations, as dawmain_app under RLS.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  after: [] as Array<() => unknown>,
  revalidatePath: vi.fn(),
  propose: vi.fn(),
  dbShare: null as number | null,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => {
    throw new Error("Clerk must not be called in these tests");
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    mocks.after.push(fn);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: mocks.propose }));
// The DB cannot be filled to 60 % of 400 MB here: let a test pretend it is.
vi.mock("@/src/files/guards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/src/files/guards")>();
  return {
    ...real,
    measureGuards: async (...args: Parameters<typeof real.measureGuards>) => {
      const g = await real.measureGuards(...args);
      return mocks.dbShare === null ? g : { ...g, dbShare: mocks.dbShare };
    },
  };
});

import { GET as cronGET } from "@/app/api/cron/files/route";
import { POST as uploadPOST } from "@/app/api/files/documents/route";
import { renderToStaticMarkup } from "react-dom/server";
import { takedownAction } from "@/app/vlastni-zdroje/provoz/actions";
import OperatorPage from "@/app/vlastni-zdroje/provoz/page";
import { __setAccessLoaderForTests, __setOwnerLookupForTests, buildAccess } from "@/src/files/access";
import { ANALYZER_VERSION, LIMITS, TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { acceptTerms, audit, dbUsage, pruneUsage, tableUsage } from "@/src/files/db/usage";
import { __resetGuardsForTests, measureGuards, NEON_STORAGE_BYTES } from "@/src/files/guards";
import { VACUUM_TABLE_MIN_BYTES, vacuumPlan } from "@/src/files/operator";
import { UPLOAD_GUARDS } from "@/src/files/upload";
import { batchAllowance, REINDEX_BATCH_TIGHT, reindexBatch, reindexDocument, REINDEXES_PER_LIBRARY_DAY } from "@/src/files/reindex";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

const ORIGIN = { origin: "https://dawmain.cz", host: "dawmain.cz" };
const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCE = "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti.";

function dmd(salt: string): string {
  return ["[s. 1]", "", "# Úvod", "", "## § 2913 [Porušení povinnosti]", "", `${SENTENCE} ${salt}`, "", "[s. 2]", "", "## § 2914", "", `${SENTENCE} ${salt}`, ""].join("\n");
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function uploadRequest(lib: string, text: string): Request {
  const meta: UploadMeta = {
    library_id: lib,
    file: { name: "a.pdf", bytes: 1_000, sha256: "b".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 2, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
  };
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("dmd", new Blob([new Uint8Array(gzipSync(Buffer.from(text))) as Uint8Array<ArrayBuffer>]), "d.gz");
  return new Request("https://dawmain.cz/api/files/documents", { method: "POST", body: form, headers: ORIGIN });
}

let t: TestDb;
const ENV = { ...process.env };

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  __setOwnerLookupForTests(null);
  await t.close();
});
beforeEach(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  process.env.FILES_OPERATOR_IDS = "user_op";
  process.env.CRON_SECRET = "cron-secret-value";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  __setAccessLoaderForTests(async (userId) => buildAccess({ id: userId, publicMetadata: { pro: true } }, []));
  __setOwnerLookupForTests(async () => "pro");
  mocks.auth.mockReset();
  mocks.after.length = 0;
  mocks.revalidatePath.mockReset();
  mocks.propose.mockReset();
  mocks.propose.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
  mocks.dbShare = null;
  for (const user of ["user_a", "user_b"]) await t.runner([], (db) => acceptTerms(db, user, TERMS_VERSION));
});
afterEach(async () => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
  for (const table of ["documents", "libraries", "usage_daily", "audit_log", "system_state", "terms_acceptance", "db_activity", "blocked_content"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

const signedIn = (userId: string | null) => mocks.auth.mockResolvedValue({ userId });

async function uploaded(user: string, salt: string): Promise<string> {
  signedIn(user);
  const res = await uploadPOST(uploadRequest(user, dmd(salt)));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  // The review step (a library with autoConfirm: false) — what these tests exercise.
  await t.owner.query(`UPDATE libraries SET settings = settings || '{"autoConfirm": false}'::jsonb WHERE id = $1`, [user]);
  for (const fn of mocks.after.splice(0)) await fn();
  return id;
}

const cron = async () =>
  (await cronGET(new Request("https://dawmain.cz/api/cron/files", { headers: { authorization: "Bearer cron-secret-value" } }))).json();

const doc = async (id: string) =>
  (
    await t.owner.query<{ status: string; analyzer_version: number | null; reindex_requested_at: Date | null; section_range: string | null }>(
      "SELECT status, analyzer_version, reindex_requested_at, section_range FROM documents WHERE id = $1",
      [id],
    )
  ).rows[0];

const usage = async (scope: string) =>
  (await t.owner.query<{ reindexes: number; cpu_ms: string }>("SELECT reindexes, cpu_ms FROM usage_daily WHERE scope = $1", [scope])).rows[0];

// ---------------------------------------------------------------------------

describe("migration 0003_ops", () => {
  it("applies again without error (idempotent)", async () => {
    const sql = readFileSync(path.join(__dirname, "..", "src", "files", "db", "migrations", "0003_ops.sql"), "utf8");
    await t.db.exec(sql);
    const cols = await t.owner.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'usage_daily' AND column_name = 'reindexes'");
    expect(cols.rows).toHaveLength(1);
  });
});

describe("database size for the guards (files_db_usage)", () => {
  it("deleting documents lowers the live figure, although the files keep their size", async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ('user_a')");
    const ids: string[] = [];
    for (let d = 0; d < 10; d++) {
      const { rows } = await t.owner.query<{ id: string }>(
        `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter, rights,
           billable_pages, char_count, page_label_source) VALUES ('user_a', 'ready', 'user_a', 'pdf', 'a.pdf', $1, $1, 'pdf@1', 'vlastni', 5, 10, 'none')
         RETURNING id`,
        [sha256(`doc${d}`)],
      );
      ids.push(rows[0].id);
      await t.owner.query(
        `INSERT INTO chunks (doc_id, library_id, ord, char_start, char_end, tsv)
         SELECT $1::uuid, 'user_a', g, 0, 1, to_tsvector('simple', repeat(md5(g::text || $1::text) || ' ', 40)) FROM generate_series(1, 800) g`,
        [ids[d]],
      );
      await t.owner.query(
        `INSERT INTO doc_blocks (doc_id, library_id, ord, char_start, char_end, body)
         SELECT $1::uuid, 'user_a', g, 0, 1, decode(repeat(md5(g::text || $1::text), 200), 'hex') FROM generate_series(1, 40) g`,
        [ids[d]],
      );
    }
    await t.db.exec("VACUUM ANALYZE");
    const full = await t.runner([], (db) => dbUsage(db));
    expect(full.liveBytes).toBeGreaterThan(full.dbBytes * 0.9);

    await t.owner.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [ids.slice(0, 7)]);
    await t.db.exec("VACUUM ANALYZE");
    const after = await t.runner([], (db) => dbUsage(db));
    // pg_database_size keeps (nearly) all of it; the live estimate drops by most of what was deleted.
    expect(after.dbBytes).toBeGreaterThan(full.dbBytes * 0.95);
    expect(full.liveBytes - after.liveBytes).toBeGreaterThan((full.dbBytes - 8_500_000) * 0.4);
    const g = await t.runner([], (db) => measureGuards(db));
    expect(g.liveBytes).toBe(after.liveBytes);
    // files_db_usage is built on the per-table figures the VACUUM FULL plan uses.
    const tables = await t.runner([], (db) => tableUsage(db));
    const freed = tables.reduce((sum, x) => sum + x.totalBytes - x.liveBytes, 0);
    expect(after.dbBytes - after.liveBytes).toBe(freed);
    const chunks = tables.find((x) => x.table === "chunks");
    expect(chunks && chunks.totalBytes - chunks.liveBytes).toBeGreaterThan(0);
    expect(g.dbShare).toBeLessThan(g.physicalShare);
  });
});

describe("re-derivation budget (metadata saves)", () => {
  it("a run clears the request, counts against the library's day and books its CPU", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET doc_type = 'komentar', commented_act = 'zak:89/2012' WHERE id = $1", [id]);
    vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 7_000, system: 0 });
    expect(await reindexDocument(id, "user_a")).toBe("done");
    expect((await doc(id)).reindex_requested_at).toBeNull();
    expect((await doc(id)).section_range).toBe("§ 2913–2914");
    expect(await usage("user_a")).toMatchObject({ reindexes: 1 });
    expect(Number((await usage("user_a")).cpu_ms)).toBeGreaterThanOrEqual(7);
    expect(await usage("global")).toMatchObject({ reindexes: 1 });
  });

  it("a save while a re-derivation is pending coalesces into it — nothing more runs or counts", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '1 minute' WHERE id = $1", [id]);
    for (let i = 0; i < 5; i++) expect(await reindexDocument(id, "user_a")).toBe("skipped");
    expect(await usage("user_a")).toMatchObject({ reindexes: 0 });
    // A request whose run died (older than 10 minutes) is taken over by the next save.
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    expect(await reindexDocument(id, "user_a")).toBe("done");
  });

  it("over the library's daily budget a save is deferred, not dropped: the cron re-derives it", async () => {
    const id = await uploaded("user_a", "x");
    const other = await uploaded("user_b", "y");
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, reindexes) VALUES ((now() AT TIME ZONE 'UTC')::date, 'user_a', $1)
       ON CONFLICT (day, scope) DO UPDATE SET reindexes = EXCLUDED.reindexes`,
      [REINDEXES_PER_LIBRARY_DAY],
    );
    await t.owner.query("UPDATE documents SET doc_type = 'komentar', commented_act = 'zak:89/2012' WHERE id = $1", [id]);
    expect(await reindexDocument(id, "user_a")).toBe("deferred");
    expect((await doc(id)).reindex_requested_at).toBeInstanceOf(Date);
    expect((await doc(id)).section_range).toBeNull();
    // Another library's budget is its own.
    expect(await reindexDocument(other, "user_b")).toBe("done");

    // The cron picks up requests older than the coalescing window.
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    const summary = await cron();
    expect(summary).toMatchObject({ ok: true, reindexed: 1 });
    expect(await doc(id)).toMatchObject({ reindex_requested_at: null, section_range: "§ 2913–2914" });
  });

  it("the cron leaves deferred requests alone unless the mode is on, and gives up on a broken document", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query(
      "UPDATE documents SET reindex_requested_at = now() - interval '1 hour', char_count = char_count + 50000 WHERE id = $1",
      [id],
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.FILES_MODE = "readonly";
    expect(await cron()).toMatchObject({ reindexed: 0 });
    expect((await doc(id)).reindex_requested_at).toBeInstanceOf(Date);
    process.env.FILES_MODE = "on";
    __resetGuardsForTests();
    expect(await cron()).toMatchObject({ reindexed: 0 });
    expect(await doc(id)).toMatchObject({ status: "review", reindex_requested_at: null });
  });
});

describe("re-derivation and the shared CPU allowance", () => {
  const spendCpu = (ms: number) =>
    t.owner.query(
      `INSERT INTO usage_daily (day, scope, cpu_ms) VALUES ((now() AT TIME ZONE 'UTC')::date, 'global', $1)
       ON CONFLICT (day, scope) DO UPDATE SET cpu_ms = EXCLUDED.cpu_ms`,
      [ms],
    );

  it("a save is deferred while today's or the 30-day CPU allowance is spent, and the cron waits too", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET doc_type = 'komentar', commented_act = 'zak:89/2012' WHERE id = $1", [id]);
    await spendCpu(UPLOAD_GUARDS.globalCpuMsPerDay);
    expect(await reindexDocument(id, "user_a")).toBe("deferred");
    expect(await doc(id)).toMatchObject({ section_range: null, reindex_requested_at: expect.any(Date) });
    expect(await usage("user_a")).toMatchObject({ reindexes: 0 });

    // Spent over 30 days, not today: still deferred.
    await t.owner.query("UPDATE usage_daily SET day = day - 3 WHERE scope = 'global'");
    await spendCpu(0);
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, cpu_ms) VALUES ((now() AT TIME ZONE 'UTC')::date - 3, 'global', $1)
       ON CONFLICT (day, scope) DO UPDATE SET cpu_ms = EXCLUDED.cpu_ms`,
      [UPLOAD_GUARDS.globalCpuMs30Days],
    );
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    expect(await reindexDocument(id, "user_a")).toBe("deferred");
    // The cron's catch-up waits as well; the mark stays.
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    expect(await cron()).toMatchObject({ ok: true, reindexed: 0 });
    expect((await doc(id)).reindex_requested_at).toBeInstanceOf(Date);

    // Room again: the cron catches up.
    await t.owner.query("DELETE FROM usage_daily WHERE scope = 'global'");
    __resetGuardsForTests();
    expect(await cron()).toMatchObject({ ok: true, reindexed: 1 });
    expect(await doc(id)).toMatchObject({ reindex_requested_at: null, section_range: "§ 2913–2914" });
  });

  it("the library budget is bumped before it is read, and a refused save gives its bump back", async () => {
    const id = await uploaded("user_a", "x");
    const statements: string[] = [];
    setScopeRunner((libraryIds, fn, options) =>
      t.runner(
        libraryIds,
        (db) =>
          fn({
            query: (sql: string, params?: unknown[]) => {
              statements.push(sql.replace(/\s+/g, " "));
              return db.query(sql, params);
            },
          } as typeof db),
        options,
      ),
    );
    expect(await reindexDocument(id, "user_a")).toBe("done");
    const bump = statements.findIndex((q) => q.startsWith("INSERT INTO usage_daily") && q.includes("reindexes"));
    const read = statements.findIndex((q) => q.includes("sum(reindexes)"));
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(bump);

    // At the cap: deferred, and the counter stays at the cap (the refused save did not start anything).
    await t.owner.query("UPDATE usage_daily SET reindexes = $1 WHERE scope = 'user_a'", [REINDEXES_PER_LIBRARY_DAY]);
    await t.owner.query("UPDATE documents SET reindex_requested_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    expect(await reindexDocument(id, "user_a")).toBe("deferred");
    expect(await usage("user_a")).toMatchObject({ reindexes: REINDEXES_PER_LIBRARY_DAY });
    expect(await usage("global")).toMatchObject({ reindexes: 1 });
  });
});

describe("VACUUM FULL plan (operator page)", () => {
  const MB = 1024 * 1024;
  const table = (name: string, total: number, live: number) => ({ table: name, totalBytes: total * MB, liveBytes: live * MB });

  it("runs the tables that fit the room first, and counts what each frees as room for the next", () => {
    // 470 MB of files: 30 MB free under the limit. chunks needs 150 MB (frees more), doc_blocks 25 MB.
    const plan = vacuumPlan(
      [table("chunks", 300, 120), table("doc_blocks", 150, 20), table("doc_pages", 20, 19), table("audit_log", 2, 1)],
      470 * MB,
      470 * MB + 30 * MB,
    );
    expect(plan.steps.map((s) => s.table)).toEqual(["doc_blocks", "chunks"]);
    expect(plan.steps[0]).toMatchObject({ reclaimBytes: 130 * MB, needBytes: 25 * MB });
    expect(plan.blocked).toEqual([]);
  });

  it("a table that never fits is reported, not recommended", () => {
    const plan = vacuumPlan([table("chunks", 460, 300)], 470 * MB, NEON_STORAGE_BYTES);
    expect(plan.steps).toEqual([]);
    expect(plan.blocked.map((s) => s.table)).toEqual(["chunks"]);
    // Tables with little to free are left out altogether.
    expect(vacuumPlan([table("x", 10, 10 - VACUUM_TABLE_MIN_BYTES / MB / 2)], 0, NEON_STORAGE_BYTES)).toEqual({ steps: [], blocked: [] });
  });
});

describe("operator batch under the guards", () => {
  it("batchAllowance: none unless on; at most a handful above 60 % of the DB cap", () => {
    expect(batchAllowance("on", 0.3)).toEqual({ max: 200, reason: null });
    expect(batchAllowance("on", 0.6)).toMatchObject({ max: REINDEX_BATCH_TIGHT, reason: expect.stringContaining("60 %") });
    expect(batchAllowance("readonly", 0.1).max).toBe(0);
    expect(batchAllowance("off", 0.1).max).toBe(0);
  });

  it("read-only: nothing is rewritten, and the report says why", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET analyzer_version = 0 WHERE id = $1", [id]);
    process.env.FILES_MODE = "readonly";
    const report = await reindexBatch();
    expect(report).toMatchObject({ done: 0, skipped: 0, failed: 0, remaining: 1, limited: expect.stringContaining("počká") });
    expect((await doc(id)).analyzer_version).toBe(0);
  });

  it("above 60 % a click re-derives at most REINDEX_BATCH_TIGHT documents", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= REINDEX_BATCH_TIGHT; i++) ids.push(await uploaded("user_a", `doc ${i}`));
    await t.owner.query("UPDATE documents SET analyzer_version = 0");
    mocks.dbShare = 0.65;
    const report = await reindexBatch();
    expect(report).toMatchObject({ done: REINDEX_BATCH_TIGHT, remaining: 1, limited: expect.stringContaining("65 %") });
    const left = await t.owner.query("SELECT count(*)::int AS n FROM documents WHERE analyzer_version IS DISTINCT FROM $1", [ANALYZER_VERSION]);
    expect(left.rows[0]).toEqual({ n: 1 });
  });
});

describe("operator batch and the shared CPU allowance", () => {
  it("stops before re-deriving once the day's CPU allowance is spent, and says so", async () => {
    const id = await uploaded("user_a", "cpu");
    await t.owner.query("UPDATE documents SET analyzer_version = 0 WHERE id = $1", [id]);
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, cpu_ms) VALUES ((now() AT TIME ZONE 'UTC')::date, 'global', $1)
       ON CONFLICT (day, scope) DO UPDATE SET cpu_ms = EXCLUDED.cpu_ms`,
      [LIMITS.globalCpuMsPerDay],
    );
    const report = await reindexBatch();
    expect(report).toMatchObject({ done: 0, remaining: 1, limited: expect.stringContaining("rozpočet CPU") });
    expect((await doc(id)).analyzer_version).toBe(0);
  });
});

describe("operator page", () => {
  it("shows the physical and the live size, why the batch is disabled, and the takedown form", async () => {
    process.env.FILES_MODE = "readonly";
    signedIn("user_op");
    const html = renderToStaticMarkup(await OperatorPage());
    expect(html).toContain("živá data odhadem");
    expect(html).toContain("přeindexování počká");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Přeindexovat dávku/);
    expect(html).toContain("Zablokovat a smazat kopie");
  });
});

describe("retention (/soukromi)", () => {
  it("usage after 12 months, read counters after 2 days (today and yesterday), activity after 62 days", async () => {
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, uploads, reads) VALUES
         ((now() AT TIME ZONE 'UTC')::date - 366, 'global', 1, 0),
         ((now() AT TIME ZONE 'UTC')::date - 364, 'global', 1, 0),
         ((now() AT TIME ZONE 'UTC')::date - 3, 'read:user_a:00000000-0000-4000-8000-000000000001', 0, 4),
         ((now() AT TIME ZONE 'UTC')::date - 2, 'read:user_a:00000000-0000-4000-8000-000000000001', 0, 3),
         ((now() AT TIME ZONE 'UTC')::date - 2, 'global', 1, 0),
         ((now() AT TIME ZONE 'UTC')::date - 1, 'read:user_a:00000000-0000-4000-8000-000000000001', 0, 2),
         ((now() AT TIME ZONE 'UTC')::date, 'read:user_a:00000000-0000-4000-8000-000000000001', 0, 1)`,
    );
    await t.owner.query("INSERT INTO db_activity (minute) VALUES (date_trunc('minute', now() - interval '70 days')), (date_trunc('minute', now()))");
    // Final review: the day before yesterday's read counter goes too (3 UTC days kept were more than "2 dny").
    expect(await t.runner([], (db) => pruneUsage(db))).toEqual({ usage: 3, activity: 1 });
    const left = await t.owner.query<{ scope: string; reads: number }>("SELECT scope, reads FROM usage_daily ORDER BY day, scope");
    expect(left.rows.map((r) => `${r.scope}:${r.reads}`)).toEqual([
      "global:0",
      "global:0",
      "read:user_a:00000000-0000-4000-8000-000000000001:2",
      "read:user_a:00000000-0000-4000-8000-000000000001:1",
    ]);
  });

  it("a purged library keeps no audit rows but the purge record; its own counters go too", async () => {
    await t.owner.query("INSERT INTO libraries (id, purge_after) VALUES ('org_gone', now() - interval '1 day'), ('org_live', NULL)");
    await t.runner([], async (db) => {
      await audit(db, { libraryId: "org_gone", actor: "user_x", action: "document.delete", detail: { pages: 3 } });
      await audit(db, { libraryId: "org_live", actor: "user_y", action: "document.delete" });
    });
    await t.owner.query("INSERT INTO usage_daily (day, scope, uploads) VALUES ((now() AT TIME ZONE 'UTC')::date, 'org_gone', 2)");
    const summary = await cron();
    expect(summary).toMatchObject({ purged: 1, auditForgotten: 1 });
    const rows = await t.owner.query<{ library_id: string; action: string }>("SELECT library_id, action FROM audit_log ORDER BY id");
    expect(rows.rows.filter((r) => r.library_id === "org_gone")).toEqual([{ library_id: "org_gone", action: "library.purged" }]);
    expect(rows.rows).toContainEqual({ library_id: "org_live", action: "document.delete" });
    expect((await t.owner.query("SELECT 1 FROM usage_daily WHERE scope = 'org_gone'")).rows).toHaveLength(0);
  });

  it("the app role still cannot delete from the audit log itself", async () => {
    await t.runner([], (db) => audit(db, { libraryId: "user_a", actor: "user_a", action: "document.delete" }));
    await expect(t.runner([], (db) => db.query("DELETE FROM audit_log"))).rejects.toThrow();
  });

  it("an owner found deleted (missed webhook): the terms acceptance and read counters go with the account", async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ('user_a')");
    await t.owner.query(
      "INSERT INTO usage_daily (day, scope, reads) VALUES ((now() AT TIME ZONE 'UTC')::date, 'read:user_a:00000000-0000-4000-8000-000000000001', 1), ((now() AT TIME ZONE 'UTC')::date, 'read:user_ab:00000000-0000-4000-8000-000000000001', 1)",
    );
    __setOwnerLookupForTests(async () => "gone");
    expect(await cron()).toMatchObject({ scheduledPurges: 1 });
    expect((await t.owner.query("SELECT 1 FROM terms_acceptance WHERE user_id = 'user_a'")).rows).toHaveLength(0);
    expect((await t.owner.query("SELECT 1 FROM terms_acceptance WHERE user_id = 'user_b'")).rows).toHaveLength(1);
    const reads = await t.owner.query<{ scope: string }>("SELECT scope FROM usage_daily WHERE starts_with(scope, 'read:')");
    expect(reads.rows.map((r) => r.scope)).toEqual(["read:user_ab:00000000-0000-4000-8000-000000000001"]);
  });
});

describe("notice-and-takedown", () => {
  const form = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.append(k, v);
    return f;
  };

  it("blocks the hash and deletes every copy in every library, with counters and audit", async () => {
    const a = await uploaded("user_a", "same");
    const b = await uploaded("user_b", "same");
    const keep = await uploaded("user_a", "different");
    // A third copy still waiting for ingest holds a reservation.
    signedIn("user_b");
    await t.owner.query("INSERT INTO libraries (id) VALUES ('org_c')");
    await t.owner.query(
      `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter, rights,
         billable_pages, char_count, page_label_source) SELECT 'org_c', 'queued', 'user_b', 'pdf', 'x.pdf', content_sha256, content_sha256,
         'pdf@1', 'vlastni', 2, 10, 'none' FROM documents WHERE id = $1`,
      [a],
    );
    await t.owner.query("UPDATE libraries SET pages_reserved = 2 WHERE id = 'org_c'");
    const before = await t.owner.query<{ id: string; page_count: number; doc_count: number }>("SELECT id, page_count, doc_count FROM libraries ORDER BY id");

    signedIn("user_a");
    await expect(takedownAction(form({ target: a, reason: "DSA-2026-1", confirm: "yes" }))).rejects.toThrow("Not allowed.");
    signedIn("user_op");
    await expect(takedownAction(form({ target: a, reason: "DSA-2026-1" }))).rejects.toThrow("Not confirmed.");
    await takedownAction(form({ target: a, reason: "DSA-2026-1", confirm: "yes" }));

    const docs = await t.owner.query<{ id: string }>("SELECT id FROM documents");
    expect(docs.rows.map((r) => r.id)).toEqual([keep]);
    expect(b).not.toBe(a);
    const libs = await t.owner.query<{ id: string; page_count: number; doc_count: number; pages_reserved: number }>(
      "SELECT id, page_count, doc_count, pages_reserved FROM libraries ORDER BY id",
    );
    const was = Object.fromEntries(before.rows.map((r) => [r.id, r]));
    expect(libs.rows.find((l) => l.id === "user_b")).toMatchObject({ page_count: 0, doc_count: 0 });
    expect(libs.rows.find((l) => l.id === "org_c")).toMatchObject({ pages_reserved: 0 });
    expect(libs.rows.find((l) => l.id === "user_a")!.doc_count).toBe(was.user_a.doc_count - 1);
    const blocked = await t.owner.query<{ reason: string }>("SELECT reason FROM blocked_content");
    expect(blocked.rows).toEqual([{ reason: "DSA-2026-1" }]);
    const logged = await t.owner.query<{ library_id: string; action: string }>(
      "SELECT library_id, action FROM audit_log WHERE action IN ('content.takedown', 'document.takedown') ORDER BY library_id",
    );
    expect(logged.rows).toEqual([
      { library_id: "org_c", action: "document.takedown" },
      { library_id: "system", action: "content.takedown" },
      { library_id: "user_a", action: "document.takedown" },
      { library_id: "user_b", action: "document.takedown" },
    ]);
    // The exact text cannot come back.
    signedIn("user_b");
    const again = await uploadPOST(uploadRequest("user_b", dmd("same")));
    expect(again.status).not.toBe(201);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/vlastni-zdroje/provoz");
  });

  it("the nightly recount repairs drifted counters", async () => {
    await uploaded("user_a", "x");
    const right = await t.owner.query<{ page_count: number; doc_count: number }>("SELECT page_count, doc_count FROM libraries WHERE id = 'user_a'");
    await t.owner.query("UPDATE libraries SET page_count = page_count + 40, doc_count = 7, pages_reserved = 3 WHERE id = 'user_a'");
    expect(await cron()).toMatchObject({ countersFixed: 1 });
    const now = await t.owner.query("SELECT page_count, doc_count, pages_reserved FROM libraries WHERE id = 'user_a'");
    expect(now.rows[0]).toEqual({ ...right.rows[0], pages_reserved: 0 });
    expect(await cron()).toMatchObject({ countersFixed: 0 });
  });
});
