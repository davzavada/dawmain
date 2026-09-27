import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import {
  acceptTerms,
  audit,
  bumpUsage,
  computeHoursEstimate,
  getSystemState,
  hasAcceptedTerms,
  setSystemState,
  usageSum,
} from "@/src/files/db/usage";
import { createTestDb, type TestDb } from "./helpers/pglite";

/** Counters, system state, terms and audit on PGlite, as dawmain_app. */

let t: TestDb;
const scoped = <T>(libs: string[], fn: (db: Queryable) => Promise<T>) => withScope(libs, fn);

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});

describe("bumpUsage / usageSum", () => {
  it("upserts today's UTC row and adds up", async () => {
    await scoped([], (db) => bumpUsage(db, "user_a", { uploads: 1, pages: 120 }));
    await scoped([], (db) => bumpUsage(db, "user_a", { uploads: 1, ai_microusd: 1234.6 }));
    const today = await t.owner.query("SELECT day::text AS day, uploads, pages, ai_microusd FROM usage_daily WHERE scope = 'user_a'");
    expect(today.rows).toHaveLength(1);
    expect(Number((today.rows[0] as { ai_microusd: unknown }).ai_microusd)).toBe(1235);
    const utc = new Date().toISOString().slice(0, 10);
    expect(today.rows[0]).toMatchObject({ day: utc, uploads: 2, pages: 120 });
    expect(await scoped([], (db) => usageSum(db, "user_a", "uploads", 1))).toBe(2);
  });

  it("sums a window of days including today; older rows fall out", async () => {
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, reads) VALUES
         ((now() AT TIME ZONE 'UTC')::date - 1, 'global', 5),
         ((now() AT TIME ZONE 'UTC')::date - 29, 'global', 7),
         ((now() AT TIME ZONE 'UTC')::date - 30, 'global', 100)`,
    );
    await scoped([], (db) => bumpUsage(db, "global", { reads: 1 }));
    expect(await scoped([], (db) => usageSum(db, "global", "reads", 1))).toBe(1);
    expect(await scoped([], (db) => usageSum(db, "global", "reads", 2))).toBe(6);
    expect(await scoped([], (db) => usageSum(db, "global", "reads", 30))).toBe(13);
    expect(await scoped([], (db) => usageSum(db, "global", "reads", 0))).toBe(1);
    expect(await scoped([], (db) => usageSum(db, "nobody", "reads", 30))).toBe(0);
  });

  it("ignores unknown fields and non-positive / non-finite amounts; never interpolates them", async () => {
    await scoped([], (db) =>
      bumpUsage(db, "user_x", {
        uploads: 0,
        pages: -5,
        reads: Number.NaN,
        cpu_ms: Number.POSITIVE_INFINITY,
        ["uploads = 999, scope" as never]: 1,
      }),
    );
    const rows = await t.owner.query("SELECT * FROM usage_daily WHERE scope = 'user_x'");
    expect(rows.rows).toEqual([]);
    await expect(scoped([], (db) => usageSum(db, "user_x", "pages; DROP TABLE usage_daily" as never, 1))).rejects.toThrow(/unknown usage field/);
  });
});

describe("computeHoursEstimate", () => {
  it("is the union of [minute, minute + 5 min] since monthStart, in hours × 0.25 CU", async () => {
    const monthStart = new Date("2026-09-01T00:00:00Z");
    await t.owner.query(
      `INSERT INTO db_activity (minute) VALUES
         ('2026-08-31T23:59:00Z'),
         ('2026-09-02T10:00:00Z'), ('2026-09-02T10:01:00Z'), ('2026-09-02T10:03:00Z'),
         ('2026-09-02T10:20:00Z'), ('2026-09-02T10:25:00Z')`,
    );
    // Islands: 10:00–10:08 (8 min) and 10:20–10:30 (10 min; a 5-minute gap still merges).
    const cu = await scoped([], (db) => computeHoursEstimate(db, monthStart));
    expect(cu).toBeCloseTo((18 / 60) * 0.25, 10);
    expect(await scoped([], (db) => computeHoursEstimate(db, new Date("2030-01-01T00:00:00Z")))).toBe(0);
  });
});

describe("system state", () => {
  it("stores and replaces JSON values, including arrays and null", async () => {
    expect(await scoped([], (db) => getSystemState(db, "mode_override"))).toBeNull();
    await scoped([], (db) => setSystemState(db, "mode_override", { mode: "readonly", by: "user_op" }));
    expect(await scoped([], (db) => getSystemState<{ mode: string }>(db, "mode_override"))).toEqual({ mode: "readonly", by: "user_op" });
    await scoped([], (db) => setSystemState(db, "mode_override", ["a", 1]));
    expect(await scoped([], (db) => getSystemState(db, "mode_override"))).toEqual(["a", 1]);
    await scoped([], (db) => setSystemState(db, "mode_override", undefined));
    expect(await scoped([], (db) => getSystemState(db, "mode_override"))).toBeNull();
    await scoped([], (db) => setSystemState(db, "db_bytes", 12345));
    expect(await scoped([], (db) => getSystemState<number>(db, "db_bytes"))).toBe(12345);
  });
});

describe("terms", () => {
  it("records acceptance per user and version, idempotently", async () => {
    expect(await scoped([], (db) => hasAcceptedTerms(db, "user_a", "2026-10"))).toBe(false);
    await scoped([], (db) => acceptTerms(db, "user_a", "2026-10"));
    await scoped([], (db) => acceptTerms(db, "user_a", "2026-10"));
    expect(await scoped([], (db) => hasAcceptedTerms(db, "user_a", "2026-10"))).toBe(true);
    expect(await scoped([], (db) => hasAcceptedTerms(db, "user_a", "2027-01"))).toBe(false);
    expect(await scoped([], (db) => hasAcceptedTerms(db, "user_b", "2026-10"))).toBe(false);
  });

  it("rejects malformed user ids", async () => {
    expect(await scoped([], (db) => hasAcceptedTerms(db, "org_x", "2026-10"))).toBe(false);
    await expect(scoped([], (db) => acceptTerms(db, "user_a'--", "2026-10"))).rejects.toThrow(/invalid user id/);
  });
});

describe("audit", () => {
  it("appends entries with JSON detail; a malformed doc id becomes null", async () => {
    await scoped(["org_b"], (db) =>
      audit(db, { libraryId: "org_b", actor: "user_a", action: "delete", docId: "00000000-0000-4000-8000-000000000001", detail: { pages: 3 } }),
    );
    await scoped(["org_b"], (db) => audit(db, { libraryId: "org_b", actor: "user_a", action: "replace", docId: "nope", detail: ["x"] }));
    await scoped(["org_b"], (db) => audit(db, { libraryId: "org_b", actor: "user_a", action: "confirm" }));
    const rows = await t.owner.query("SELECT action, doc_id, detail FROM audit_log ORDER BY id");
    expect(rows.rows).toEqual([
      { action: "delete", doc_id: "00000000-0000-4000-8000-000000000001", detail: { pages: 3 } },
      { action: "replace", doc_id: null, detail: ["x"] },
      { action: "confirm", doc_id: null, detail: null },
    ]);
  });

  it("the app role may not rewrite history", async () => {
    await expect(scoped([], (db) => db.query("DELETE FROM audit_log"))).rejects.toThrow(/permission denied/);
  });
});
