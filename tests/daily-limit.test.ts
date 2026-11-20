import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { setScopeRunner, withScope } from "@/src/files/db/client";
import { getSystemState, setSystemState, userCallsToday } from "@/src/files/db/usage";
import { __resetGuardsForTests } from "@/src/files/guards";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * The daily limit of tool calls per account (src/mcp/daily-limit.ts): where
 * it is enforced (textOnly in src/mcp/tools/index.ts), who and what it
 * leaves alone, the admin's setting (src/admin/daily-limit.ts and its
 * Server Function) and the seed from usage_daily, against a real Postgres.
 */

type Handler = (...args: unknown[]) => Promise<Record<string, unknown>>;
type Register = (name: string, config: Record<string, unknown>, handler: Handler) => void;

const state = vi.hoisted(() => ({ admin: null as string | null, ran: 0 }));
vi.mock("@/src/admin/server", () => ({ requireAdmin: async () => state.admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// Two stand-ins that reach nothing: a limited tool and an exempt one, registered through the real textOnly().
vi.mock("@/src/mcp/tools/ns", () => ({
  registerNs: (server: { registerTool: Register }) =>
    server.registerTool("ns_search", { description: "x", inputSchema: {} }, async () => {
      state.ran++;
      return { content: [{ type: "text", text: "ok" }] };
    }),
}));
vi.mock("@/src/mcp/tools/ping", () => ({
  registerPing: (server: { registerTool: Register }) =>
    server.registerTool("dawmain_ping", { description: "x", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] })),
}));

const { registerAllTools } = await import("@/src/mcp/tools");
const limit = await import("@/src/mcp/daily-limit");
const { loadDailyLimit, saveDailyLimit } = await import("@/src/admin/daily-limit");
const { setDailyLimitAction } = await import("@/app/sprava/actions");
const { limitTextToValue } = await import("@/app/sprava/system/limit-field");

const { admitToolCall, DAILY_LIMIT_MESSAGE, DAILY_CALL_LIMIT_KEY, DEFAULT_DAILY_CALL_LIMIT } = limit;

const ctxOf = (userId: string) => ({ http: { authInfo: { token: "t", clientId: "client_1", scopes: [], extra: { userId } } } });
const SHARED_CTX = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { method: "token" } } } };

const tools = new Map<string, Handler>();
registerAllTools({ registerTool: (name: string, _config: unknown, handler: Handler) => void tools.set(name, handler) } as unknown as McpServer, {
  zotero: false,
});
const call = (name: string, ctx: unknown) => tools.get(name)!({}, ctx);
const text = (result: Record<string, unknown>) => (result.content as Array<{ text: string }>).map((c) => c.text).join("\n");

async function admitMany(userId: string, n: number, now?: number): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < n; i++) if (await admitToolCall("ns_search", ctxOf(userId), now)) admitted++;
  return admitted;
}

const ENV = { url: process.env.FILES_DATABASE_URL, mode: process.env.FILES_MODE };
function restoreEnv() {
  if (ENV.url === undefined) delete process.env.FILES_DATABASE_URL;
  else process.env.FILES_DATABASE_URL = ENV.url;
  if (ENV.mode === undefined) delete process.env.FILES_MODE;
  else process.env.FILES_MODE = ENV.mode;
}

beforeEach(() => {
  limit.__resetDailyLimitForTests();
  __resetGuardsForTests();
  state.admin = null;
  state.ran = 0;
});

describe("the daily call limit without a database", () => {
  beforeEach(() => {
    delete process.env.FILES_DATABASE_URL;
    delete process.env.FILES_MODE;
  });
  afterAll(restoreEnv);

  it("lets 2000 calls of an account through and refuses the 2001st — without the figure, without running the tool", async () => {
    expect(DEFAULT_DAILY_CALL_LIMIT).toBe(2000);
    for (let i = 0; i < 2000; i++) {
      const result = await call("ns_search", ctxOf("user_limitA"));
      if (result.isError) throw new Error(`call ${i + 1} was refused`);
    }
    expect(state.ran).toBe(2000);
    const refused = await call("ns_search", ctxOf("user_limitA"));
    expect(refused).toEqual({ isError: true, content: [{ type: "text", text: "Daily call limit reached for this account — try again tomorrow." }] });
    expect(text(refused)).toBe(DAILY_LIMIT_MESSAGE);
    expect(text(refused)).not.toMatch(/\d/);
    expect(state.ran).toBe(2000);
    // Another account is not touched by it.
    expect((await call("ns_search", ctxOf("user_limitB"))).isError).toBeUndefined();
  });

  it("dawmain_ping and dawmain_guide stay open over the limit and are not counted", async () => {
    for (let i = 0; i < 50; i++) expect(await admitToolCall("dawmain_ping", ctxOf("user_limitC"))).toBe(true);
    expect(await admitMany("user_limitC", 2001)).toBe(2000);
    expect(await admitToolCall("dawmain_guide", ctxOf("user_limitC"))).toBe(true);
    const ping = await call("dawmain_ping", ctxOf("user_limitC"));
    expect(ping.isError).toBeUndefined();
    expect(text(ping)).toBe("pong");
    expect((await call("ns_search", ctxOf("user_limitC"))).isError).toBe(true);
  });

  it("does not limit the shared access code or a caller without an identity", async () => {
    for (const ctx of [SHARED_CTX, undefined, {}]) {
      for (let i = 0; i < 2100; i++) if (!(await admitToolCall("ns_search", ctx))) throw new Error("refused");
    }
    expect((await call("ns_search", SHARED_CTX)).isError).toBeUndefined();
    expect(limit.__dailyLimitAccountsForTests()).toBe(0);
  });

  it("starts again with the next UTC day", async () => {
    const day1 = Date.UTC(2026, 10, 20, 23, 59, 0);
    expect(await admitMany("user_limitD", 2001, day1)).toBe(2000);
    expect(await admitToolCall("ns_search", ctxOf("user_limitD"), day1 + 30_000)).toBe(false);
    expect(await admitToolCall("ns_search", ctxOf("user_limitD"), day1 + 61_000)).toBe(true);
  });

  it("holds a bounded number of accounts, the least recently used going first", async () => {
    for (let i = 0; i < 5001; i++) await admitToolCall("ns_search", ctxOf(`user_lru${i}`));
    expect(limit.__dailyLimitAccountsForTests()).toBe(5000);
  });

  it("the admin's setting is unavailable, and nothing is saved", async () => {
    expect(await loadDailyLimit()).toEqual({ own: null, available: false });
    expect((await saveDailyLimit(5)).ok).toBe(false);
  });
});

describe("the daily call limit with the files database", () => {
  let t: TestDb;
  const sumToday = async (userId: string) => withScope([], (db) => userCallsToday(db, userId));

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    process.env.FILES_DATABASE_URL = "postgres://test";
    process.env.FILES_MODE = "on";
    setScopeRunner(t.runner);
    await t.owner.query("DELETE FROM usage_daily");
    await t.owner.query("DELETE FROM system_state WHERE key = $1", [DAILY_CALL_LIMIT_KEY]);
  });
  afterEach(() => setScopeRunner(null));
  afterAll(async () => {
    restoreEnv();
    await t.close();
  });

  it("only an admin sets it, only to a whole number in bounds", async () => {
    expect(await setDailyLimitAction(5)).toEqual({ ok: false, error: "Nemáš oprávnění správce." });
    state.admin = "user_admin1";
    for (const bad of [0, -1, 1.5, 1_000_001, NaN, "5", undefined, {}]) {
      expect((await setDailyLimitAction(bad as never)).ok).toBe(false);
    }
    expect(await withScope([], (db) => getSystemState(db, DAILY_CALL_LIMIT_KEY))).toBeNull();
    expect(await setDailyLimitAction(1_000_000)).toEqual({ ok: true, own: 1_000_000 });
    expect(await setDailyLimitAction(5)).toEqual({ ok: true, own: 5 });
    expect(await withScope([], (db) => getSystemState(db, DAILY_CALL_LIMIT_KEY))).toBe(5);
    expect(await loadDailyLimit()).toEqual({ own: 5, available: true });
    // Back to the default: null, or the default itself typed in.
    expect(await setDailyLimitAction(null)).toEqual({ ok: true, own: null });
    expect(await setDailyLimitAction(5)).toEqual({ ok: true, own: 5 });
    expect(await setDailyLimitAction(2000)).toEqual({ ok: true, own: null });
    expect(await loadDailyLimit()).toEqual({ own: null, available: true });
  });

  it("the value the admin set is the one enforced — at once in this process, and from the database after a restart", async () => {
    state.admin = "user_admin1";
    await setDailyLimitAction(3);
    for (let i = 0; i < 3; i++) expect((await call("ns_search", ctxOf("user_setA"))).isError).toBeUndefined();
    expect(text(await call("ns_search", ctxOf("user_setA")))).toBe(DAILY_LIMIT_MESSAGE);
    // What ran was counted in usage_daily; the refusal was not.
    await vi.waitFor(async () => expect(await sumToday("user_setA")).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await sumToday("user_setA")).toBe(3);

    // A new process: nothing in memory, the limit and the day's count both come from the database.
    limit.__resetDailyLimitForTests();
    expect(await admitToolCall("ns_search", ctxOf("user_setA"))).toBe(false);
    expect(await admitMany("user_setB", 5)).toBe(3);
  });

  it("is seeded once from today's counters of the account, across its tools", async () => {
    await t.owner.query(
      `INSERT INTO usage_daily (day, scope, tool_calls) VALUES
         ((now() AT TIME ZONE 'UTC')::date, 'calls:user_seedA:ns_search', 1200),
         ((now() AT TIME ZONE 'UTC')::date, 'calls:user_seedA:esbirka_search', 790),
         ((now() AT TIME ZONE 'UTC')::date, 'calls:user_seedA:dawmain_ping', 500),
         ((now() AT TIME ZONE 'UTC')::date - 1, 'calls:user_seedA:ns_search', 5000),
         ((now() AT TIME ZONE 'UTC')::date, 'calls:user_seedAB:ns_search', 900),
         ((now() AT TIME ZONE 'UTC')::date, 'calls:shared:ns_search', 9000)`,
    );
    expect(await withScope([], (db) => userCallsToday(db, "user_seedA"))).toBe(2490);
    expect(await withScope([], (db) => userCallsToday(db, "user_seedA", limit.EXEMPT_TOOLS))).toBe(1990);
    expect(await withScope([], (db) => userCallsToday(db, "calls:"))).toBe(0);

    let reads = 0;
    setScopeRunner((libs, fn, options) => {
      reads++;
      return t.runner(libs, fn, options);
    });
    // 1990 already today: ten more, then no further.
    expect(await admitMany("user_seedA", 25)).toBe(10);
    // One read for the seed and one for the limit — not one per call.
    expect(reads).toBe(2);
    expect(await admitMany("user_seedB", 25)).toBe(25);
    expect(reads).toBe(3);
  });

  it("a database that fails never blocks a call; the count in memory still holds", async () => {
    setScopeRunner(async () => {
      throw new Error("database unreachable");
    });
    expect((await call("ns_search", ctxOf("user_failA"))).isError).toBeUndefined();
    expect(await admitMany("user_failA", 2000)).toBe(1999);
    expect(await admitToolCall("ns_search", ctxOf("user_failA"))).toBe(false);
  });

  it("reads the configured limit at most once a minute, refreshing in the background", async () => {
    const t0 = Date.UTC(2026, 10, 20, 12, 0, 0);
    await withScope([], (db) => setSystemState(db, DAILY_CALL_LIMIT_KEY, 2));
    expect(await admitMany("user_cacheA", 5, t0)).toBe(2);
    await withScope([], (db) => setSystemState(db, DAILY_CALL_LIMIT_KEY, 4));
    // Within the minute the cached value stands.
    expect(await admitToolCall("ns_search", ctxOf("user_cacheA"), t0 + 59_000)).toBe(false);
    // After it, the stale value answers this call and the new one is fetched for the next.
    expect(await admitToolCall("ns_search", ctxOf("user_cacheA"), t0 + 61_000)).toBe(false);
    await vi.waitFor(async () => expect(await admitToolCall("ns_search", ctxOf("user_cacheA"), t0 + 62_000)).toBe(true));
    expect(await admitMany("user_cacheA", 5, t0 + 63_000)).toBe(1);
    // Something that is not a limit in the store means the default.
    await withScope([], (db) => setSystemState(db, DAILY_CALL_LIMIT_KEY, { limit: "many" }));
    limit.__resetDailyLimitForTests();
    expect(await admitMany("user_cacheB", 2001, t0)).toBe(2000);
  });
});

describe("the limit field of Správa", () => {
  it("reads a whole number, spaces allowed; empty or 0 is the default; anything else is invalid", () => {
    expect(limitTextToValue("2000")).toBe(2000);
    expect(limitTextToValue(" 12 500 ")).toBe(12500);
    expect(limitTextToValue("1000000")).toBe(1_000_000);
    expect(limitTextToValue("")).toBeNull();
    expect(limitTextToValue("0")).toBeNull();
    for (const bad of ["abc", "-5", "1,5", "1.5", "1000001", "99999999", "2e3"]) expect(limitTextToValue(bad)).toBeNaN();
  });
});
