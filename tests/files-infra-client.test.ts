import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * withScope against a fake node-postgres pool (the other tests swap the
 * runner for PGlite and never build the pool): what the pool is configured
 * with, and which statements run on the borrowed connection, in order.
 */

const pg = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  queries: [] as string[],
  params: [] as unknown[][],
  failOn: null as RegExp | null,
}));

vi.mock("pg", () => {
  class Pool {
    constructor(config: Record<string, unknown>) {
      pg.configs.push(config);
    }
    async connect() {
      return {
        query: async (text: string, params?: unknown[]) => {
          pg.queries.push(text);
          pg.params.push(params ?? []);
          if (pg.failOn?.test(text)) throw new Error("boom");
          if (text.includes("FROM pg_roles")) {
            return { rows: [{ rolsuper: false, rolbypassrls: false, neon_superuser: false, read_all: false }] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      };
    }
  }
  return { Pool };
});
vi.mock("@vercel/functions", () => ({ attachDatabasePool: () => undefined }));

import { __resetForTests, withScope } from "@/src/files/db/client";

const ENV = { ...process.env };

beforeEach(() => {
  __resetForTests();
  pg.configs.length = 0;
  pg.queries.length = 0;
  pg.params.length = 0;
  pg.failOn = null;
  process.env.FILES_DATABASE_URL = "postgres://dawmain_app:x@ep-test-pooler.eu-central-1.aws.neon.tech/neondb";
});
afterEach(() => {
  process.env = { ...ENV };
});

const ACTIVITY = /INSERT INTO db_activity/;

describe("withScope on the pooled connection", () => {
  it("sends no startup parameter the Neon pooler refuses; statement_timeout is transaction-local", async () => {
    await withScope(["user_a"], async () => "ok");
    expect(pg.configs).toHaveLength(1);
    const config = pg.configs[0];
    for (const key of ["statement_timeout", "options", "lock_timeout", "idle_in_transaction_session_timeout", "query_timeout"]) {
      expect(config).not.toHaveProperty(key);
    }
    const begin = pg.queries.indexOf("BEGIN");
    const timeout = pg.queries.findIndex((q) => q.includes("set_config('statement_timeout'"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeGreaterThan(begin);
    expect(pg.queries.some((q) => /^\s*SET\s/i.test(q))).toBe(false);
  });

  it("sets the scope and the timeout in ONE statement right after BEGIN, both transaction-local", async () => {
    await withScope(["user_a", "org_b"], async () => "ok");
    const begin = pg.queries.indexOf("BEGIN");
    const settings = pg.queries.filter((q) => q.includes("set_config("));
    expect(settings).toHaveLength(1);
    expect(pg.queries[begin + 1]).toBe(settings[0]);
    expect(settings[0]).toContain("set_config('app.library_ids', $1, true)");
    expect(settings[0]).toContain("set_config('statement_timeout', $2, true)");
    expect(pg.params[begin + 1]).toEqual(["user_a,org_b", "10000"]);
    // BEGIN, the settings, COMMIT: nothing else of our own around the work.
    expect(pg.queries.slice(begin)).toEqual(["BEGIN", settings[0], "COMMIT"]);
  });

  it("the default timeout is 10 s; a scope may ask for longer", async () => {
    await withScope([], async () => undefined);
    await withScope([], async () => undefined, { statementTimeoutMs: 60_000 });
    const timeouts = pg.queries.flatMap((q, i) => (q.includes("set_config('statement_timeout'") ? [pg.params[i][1]] : []));
    expect(timeouts).toEqual(["10000", "60000"]);
  });

  it("the activity minute is written before BEGIN, so a rolled-back transaction still counts it", async () => {
    await expect(
      withScope(["user_a"], async () => {
        throw new Error("404 inside the transaction");
      }),
    ).rejects.toThrow("404");
    const activity = pg.queries.findIndex((q) => ACTIVITY.test(q));
    expect(activity).toBeGreaterThanOrEqual(0);
    expect(activity).toBeLessThan(pg.queries.indexOf("BEGIN"));
    expect(pg.queries).toContain("ROLLBACK");
    // Within the minute the next scope does not write it again.
    pg.queries.length = 0;
    await withScope([], async () => undefined);
    expect(pg.queries.some((q) => ACTIVITY.test(q))).toBe(false);
  });

  it("a failed activity write neither fails the work nor suppresses the next attempt", async () => {
    pg.failOn = ACTIVITY;
    expect(await withScope([], async () => 7)).toBe(7);
    pg.failOn = null;
    pg.queries.length = 0;
    await withScope([], async () => undefined);
    expect(pg.queries.some((q) => ACTIVITY.test(q))).toBe(true);
  });
});
