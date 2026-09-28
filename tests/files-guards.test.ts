import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/src/files/config";
import { FilesUnavailableError, setScopeRunner } from "@/src/files/db/client";
import { DmdLimitError } from "@/src/files/dmd/types";
import { clerkStatus, errorCode, filesError, filesJson, FilesUserError, logFilesError, MESSAGES, userMessage } from "@/src/files/errors";
import {
  __resetGuardsForTests,
  allowToolCall,
  autoMode,
  effectiveMode,
  envOnlyMode,
  MODE_OVERRIDE_KEY,
  monthStartUtc,
  nextMonthStartUtc,
  parseOverride,
  NEON_STORAGE_BYTES,
  PHYSICAL_BACKSTOP,
  sameOrigin,
  stricter,
} from "@/src/files/guards";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * Free-tier guards (src/files/guards.ts) and the error helpers
 * (src/files/errors.ts). effectiveMode runs against PGlite with the real
 * migrations (system_state, db_activity, files_global_usage).
 */

let t: TestDb;
const ENV = { ...process.env };

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});
beforeEach(() => {
  __resetGuardsForTests();
  setScopeRunner(t.runner);
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
});
afterEach(async () => {
  process.env = { ...ENV };
  vi.useRealTimers();
  await t.owner.query("DELETE FROM system_state");
  await t.owner.query("DELETE FROM db_activity");
  await t.owner.query("DELETE FROM libraries");
});

describe("envOnlyMode", () => {
  it("reads only the environment — never the database", () => {
    const runner = vi.fn();
    setScopeRunner(runner as never);
    delete process.env.FILES_DATABASE_URL;
    expect(envOnlyMode()).toBe("unconfigured");
    process.env.FILES_DATABASE_URL = "postgres://x";
    delete process.env.FILES_MODE;
    expect(envOnlyMode()).toBe("off");
    for (const [raw, mode] of [["on", "on"], [" READONLY ", "readonly"], ["off", "off"], ["yes", "off"], ["", "off"]] as const) {
      process.env.FILES_MODE = raw;
      expect(envOnlyMode()).toBe(mode);
    }
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("stricter / parseOverride / monthStartUtc", () => {
  it("the more restrictive mode wins", () => {
    expect(stricter("on", "readonly")).toBe("readonly");
    expect(stricter("off", "readonly")).toBe("off");
    expect(stricter("on", "on")).toBe("on");
    expect(stricter("unconfigured", "on")).toBe("unconfigured");
  });

  it("override: a mode string or { mode }, anything else is no override", () => {
    expect(parseOverride("readonly")).toBe("readonly");
    expect(parseOverride({ mode: "off" })).toBe("off");
    expect(parseOverride("on")).toBe("on");
    for (const v of [null, undefined, "unconfigured", "OFF", 1, { mode: "x" }, ["off"]]) expect(parseOverride(v)).toBeNull();
  });

  it("month start in UTC", () => {
    expect(monthStartUtc(new Date("2026-09-27T23:30:00-05:00")).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(monthStartUtc(new Date("2026-10-01T00:30:00+02:00")).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("autoMode", () => {
  const base = { dbBytes: 0, totalPages: 0, reservedPages: 0, computeHours: 0 };
  it("on below every threshold", () => {
    expect(autoMode(base)).toMatchObject({ mode: "on", reasons: [] });
  });
  it("DB size ≥ 80 % → readonly", () => {
    expect(autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * 0.79 }).mode).toBe("on");
    expect(autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * 0.8 }).mode).toBe("readonly");
  });
  it("the DB guard reads the live data: deleting documents lifts it though the files keep their size", () => {
    const tripped = autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * 0.85, liveBytes: LIMITS.dbBytesCap * 0.85 });
    expect(tripped.mode).toBe("readonly");
    const freed = autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * 0.85, liveBytes: LIMITS.dbBytesCap * 0.5 });
    expect(freed).toMatchObject({ mode: "on", dbShare: 0.5, physicalShare: 0.85, reasons: [] });
    // The estimate never exceeds the physical size.
    expect(autoMode({ ...base, dbBytes: 100, liveBytes: 200 }).liveBytes).toBe(100);
  });
  it("…but past the physical backstop the files themselves turn it read-only (VACUUM FULL frees them)", () => {
    const full = autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * PHYSICAL_BACKSTOP, liveBytes: LIMITS.dbBytesCap * 0.3 });
    expect(full.mode).toBe("readonly");
    expect(full.reasons.join()).toContain("VACUUM FULL");
    // The backstop is the owner's cap itself (plan: "Globálně DB ≤ 400 MB"), not a margin above it.
    expect(PHYSICAL_BACKSTOP * LIMITS.dbBytesCap).toBeLessThanOrEqual(LIMITS.dbBytesCap);
    expect(PHYSICAL_BACKSTOP * LIMITS.dbBytesCap).toBeLessThan(NEON_STORAGE_BYTES * 0.85);
    expect(autoMode({ ...base, dbBytes: LIMITS.dbBytesCap * 0.99, liveBytes: LIMITS.dbBytesCap * 0.3 }).mode).toBe("on");
  });
  it("stored + reserved pages ≥ 80 % of the global cap → readonly", () => {
    expect(autoMode({ ...base, totalPages: LIMITS.globalPages * 0.7, reservedPages: LIMITS.globalPages * 0.1 }).mode).toBe("readonly");
    expect(autoMode({ ...base, totalPages: LIMITS.globalPages * 0.7 }).mode).toBe("on");
  });
  it("compute hours ≥ 70 % → readonly, ≥ 90 % → off", () => {
    expect(autoMode({ ...base, computeHours: 69.9 }).mode).toBe("on");
    expect(autoMode({ ...base, computeHours: 70 }).mode).toBe("readonly");
    const off = autoMode({ ...base, computeHours: 90, dbBytes: LIMITS.dbBytesCap });
    expect(off.mode).toBe("off");
    expect(off.reasons).toHaveLength(2);
  });
});

describe("effectiveMode", () => {
  it("env off / unconfigured answers without I/O", async () => {
    const runner = vi.fn();
    setScopeRunner(runner as never);
    process.env.FILES_MODE = "off";
    expect(await effectiveMode()).toBe("off");
    delete process.env.FILES_DATABASE_URL;
    expect(await effectiveMode()).toBe("unconfigured");
    expect(runner).not.toHaveBeenCalled();
  });

  it("on when nothing restricts it", async () => {
    expect(await effectiveMode()).toBe("on");
  });

  it("the operator override restricts (string or { mode }), but never lifts env readonly", async () => {
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, $2::jsonb)", [MODE_OVERRIDE_KEY, JSON.stringify("readonly")]);
    expect(await effectiveMode()).toBe("readonly");
    __resetGuardsForTests();
    await t.owner.query("UPDATE system_state SET value = $2::jsonb WHERE key = $1", [MODE_OVERRIDE_KEY, JSON.stringify({ mode: "off" })]);
    expect(await effectiveMode()).toBe("off");
    __resetGuardsForTests();
    await t.owner.query("UPDATE system_state SET value = $2::jsonb WHERE key = $1", [MODE_OVERRIDE_KEY, JSON.stringify("on")]);
    process.env.FILES_MODE = "readonly";
    expect(await effectiveMode()).toBe("readonly");
  });

  it("the page guard: ≥ 80 % of the global pages → readonly", async () => {
    await t.owner.query("INSERT INTO libraries (id, page_count, pages_reserved) VALUES ('user_big', $1, $2)", [
      Math.ceil(LIMITS.globalPages * 0.75),
      Math.ceil(LIMITS.globalPages * 0.05),
    ]);
    expect(await effectiveMode()).toBe("readonly");
  });

  it("the compute guard from db_activity: ≥ 70 % → readonly, ≥ 90 % → off", async () => {
    const start = monthStartUtc();
    // One active minute every 5 minutes = continuously awake; 0.25 CU per hour.
    const insertHours = (hours: number) =>
      t.owner.query(
        `INSERT INTO db_activity (minute) SELECT $1::timestamptz + make_interval(mins => g * 5)
           FROM generate_series(0, $2::int) g ON CONFLICT DO NOTHING`,
        [start, Math.floor((hours * 60) / 5) - 1],
      );
    await insertHours((LIMITS.computeHoursPerMonth / LIMITS.computeUnits) * 0.72);
    expect(await effectiveMode()).toBe("readonly");
    __resetGuardsForTests();
    await insertHours((LIMITS.computeHoursPerMonth / LIMITS.computeUnits) * 0.92);
    expect(await effectiveMode()).toBe("off");
  });

  it("is cached for 30 s per instance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
    expect(await effectiveMode()).toBe("on");
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, $2::jsonb)", [MODE_OVERRIDE_KEY, JSON.stringify("off")]);
    vi.setSystemTime(new Date("2026-09-27T10:00:29Z"));
    expect(await effectiveMode()).toBe("on");
    vi.setSystemTime(new Date("2026-09-27T10:00:31Z"));
    expect(await effectiveMode()).toBe("off");
  });

  it("off for compute hours is kept until the month rolls over — no DB wake to learn it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-09-27T10:00:00Z");
    vi.setSystemTime(now);
    expect(nextMonthStartUtc(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    await t.owner.query(
      `INSERT INTO db_activity (minute) SELECT $1::timestamptz + make_interval(mins => g * 5)
         FROM generate_series(0, $2::int) g ON CONFLICT DO NOTHING`,
      [monthStartUtc(now), Math.floor(((LIMITS.computeHoursPerMonth / LIMITS.computeUnits) * 0.92 * 60) / 5) - 1],
    );
    expect(await effectiveMode()).toBe("off");
    const runner = vi.fn(t.runner);
    setScopeRunner(runner as never);
    await t.owner.query("DELETE FROM db_activity");
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    expect(await effectiveMode()).toBe("off");
    expect(runner).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-10-01T00:00:01Z"));
    expect(await effectiveMode()).toBe("on");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("an operator's off (not compute hours) is still re-read every 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, $2::jsonb)", [MODE_OVERRIDE_KEY, JSON.stringify("off")]);
    expect(await effectiveMode()).toBe("off");
    await t.owner.query("DELETE FROM system_state");
    vi.setSystemTime(new Date("2026-09-27T10:00:31Z"));
    expect(await effectiveMode()).toBe("on");
  });

  it("a failing measurement falls back to the env mode, uncached", async () => {
    setScopeRunner((() => Promise.reject(new FilesUnavailableError("down", "unreachable"))) as never);
    process.env.FILES_MODE = "readonly";
    expect(await effectiveMode()).toBe("readonly");
    setScopeRunner(t.runner);
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, $2::jsonb)", [MODE_OVERRIDE_KEY, JSON.stringify("off")]);
    expect(await effectiveMode()).toBe("off");
  });
});

describe("allowToolCall", () => {
  it("LIMITS.toolCallsPerHour per user, refilled continuously", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMITS.toolCallsPerHour; i++) expect(allowToolCall("user_a", now)).toBe(true);
    expect(allowToolCall("user_a", now)).toBe(false);
    expect(allowToolCall("user_b", now)).toBe(true);
    const perToken = 3_600_000 / LIMITS.toolCallsPerHour;
    expect(allowToolCall("user_a", now + perToken * 0.5)).toBe(false);
    expect(allowToolCall("user_a", now + perToken * 1.6)).toBe(true);
    expect(allowToolCall("user_a", now + perToken * 1.6)).toBe(false);
    // A full hour later the bucket is full again, never more.
    const later = now + 10 * 3_600_000;
    for (let i = 0; i < LIMITS.toolCallsPerHour; i++) expect(allowToolCall("user_a", later)).toBe(true);
    expect(allowToolCall("user_a", later)).toBe(false);
  });

  it("a clock going backwards does not mint tokens", () => {
    for (let i = 0; i < LIMITS.toolCallsPerHour; i++) allowToolCall("user_c", 5_000_000);
    expect(allowToolCall("user_c", 1_000)).toBe(false);
  });
});

describe("sameOrigin", () => {
  const req = (headers: Record<string, string>, url = "https://dawmain.cz/api/files/documents") =>
    new Request(url, { method: "POST", headers });

  it("accepts the site's own origin (host or x-forwarded-host)", () => {
    expect(sameOrigin(req({ origin: "https://dawmain.cz", host: "dawmain.cz" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://dawmain.cz", host: "internal:3000", "x-forwarded-host": "dawmain.cz" }))).toBe(true);
    expect(sameOrigin(req({ origin: "http://localhost:3000", host: "localhost:3000", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://dawmain.cz" }))).toBe(true); // host from the URL
  });

  it("rejects a missing, null, foreign or look-alike origin and cross-site fetches", () => {
    expect(sameOrigin(req({ host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "null", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://evil.example", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://dawmain.cz.evil.example", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://dawmain.cz:8443", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "javascript:alert(1)", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "not a url", host: "dawmain.cz" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://dawmain.cz", host: "dawmain.cz", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://dawmain.cz", host: "dawmain.cz", "sec-fetch-site": "same-site" }))).toBe(false);
  });
});

describe("errors", () => {
  it("errorCode is opaque — never the message", () => {
    const pg = Object.assign(new Error('duplicate key (library_id)=(user_secret)'), { code: "23505" });
    expect(errorCode(pg)).toBe("pg:23505");
    expect(errorCode(Object.assign(new Error("x"), { code: "api_response_error", status: 404 }))).toBe("clerk:404");
    expect(errorCode(new DmdLimitError("maxPages", "…"))).toBe("dmd:maxPages");
    expect(errorCode(new FilesUnavailableError("host db.internal refused", "unreachable"))).toBe("db:unreachable");
    expect(errorCode(new FilesUserError(413, "velké"))).toBe("user:413");
    expect(errorCode(new TypeError("secret"))).toBe("TypeError");
    expect(errorCode("string")).toBe("unknown");
    expect(errorCode(null)).toBe("unknown");
    expect(errorCode({ name: "has spaces and user@mail.cz" })).toBe("unknown");
  });

  it("clerkStatus only for Clerk API errors", () => {
    expect(clerkStatus({ code: "api_response_error", status: 404 })).toBe(404);
    expect(clerkStatus({ status: 404 })).toBeNull();
    expect(clerkStatus(undefined)).toBeNull();
  });

  it("logs without content", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logFilesError("upload", Object.assign(new Error("Key (email)=(jana@firma.cz)"), { code: "23505" }));
    expect(spy).toHaveBeenCalledWith("files: upload failed (pg:23505)");
    spy.mockRestore();
  });

  it("users see a FilesUserError's text, else the fixed message", () => {
    expect(userMessage(new FilesUserError(403, "Ne."))).toBe("Ne.");
    expect(userMessage(new Error("password=hunter2"))).toBe(MESSAGES.unavailable);
  });

  it("JSON responses are never cached", async () => {
    const r = filesJson({ a: 1 }, 201);
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await filesError(404, "Nenalezeno.").json()).toEqual({ error: "Nenalezeno." });
  });
});
