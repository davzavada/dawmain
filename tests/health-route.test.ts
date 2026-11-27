import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/files/db/client", () => ({ withScope: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })) }));
vi.mock("@/src/sources/mirror", () => ({ mirrorConfigured: vi.fn(() => true), mirrorApiStatus: vi.fn() }));

import { withScope } from "@/src/files/db/client";
import { mirrorApiStatus, mirrorConfigured } from "@/src/sources/mirror";
import { GET } from "@/app/api/status/health/route";
import { SYNC_MAX_AGE_HOURS, checkHealth, resetHealthCache } from "@/src/mcp/health";

/**
 * GET /api/status/health — what an uptime monitor asks. The nightly mirror
 * sync failed and nobody knew (pre-release audit, 11/2026): /api/status only
 * reports the courts' own sites.
 */

const NOW = Date.parse("2026-11-25T10:00:00Z");
const run = (hoursAgo: number, error: string | null = null) => ({ mode: "daily", finishedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(), error });
const status = (sources: Array<{ source: string; lastRun: unknown }>) => ({ asOf: new Date(NOW).toISOString(), sources });

beforeEach(() => {
  // GET reads the clock itself: without a fixed one, the "last night" runs above age past
  // SYNC_MAX_AGE_HOURS a day and a half after NOW and the route answers 503.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  resetHealthCache();
  vi.mocked(withScope).mockResolvedValue({ rows: [] } as never);
  vi.mocked(mirrorConfigured).mockReturnValue(true);
  vi.mocked(mirrorApiStatus).mockResolvedValue(status([{ source: "ns", lastRun: run(7) }, { source: "nss", lastRun: run(7) }]) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GET /api/status/health", () => {
  it("is 200 with ok: true when the database answers and every court synced last night without an error", async () => {
    const health = await checkHealth(NOW);
    expect(health).toMatchObject({ ok: true, database: "ok", mirror: "ok", failing: [] });
    expect(health.sync.ns).toEqual({ ageHours: 7, failed: false, stale: false });
    expect((await GET()).status).toBe(200);
  });

  it("is 503 naming the court whose last run failed or which has not synced for a day and a half — and no error text", async () => {
    vi.mocked(mirrorApiStatus).mockResolvedValue(
      status([
        { source: "ns", lastRun: run(7) },
        { source: "nss", lastRun: run(7, "interval out of range") },
        { source: "us", lastRun: run(SYNC_MAX_AGE_HOURS + 12) },
        { source: "justice", lastRun: null },
      ]) as never,
    );
    const health = await checkHealth(NOW);
    expect(health.ok).toBe(false);
    expect(health.failing).toEqual(["sync:nss", "sync:us", "sync:justice"]);
    expect(health.sync.nss).toEqual({ ageHours: 7, failed: true, stale: false });
    expect(health.sync.us.stale).toBe(true);
    expect(JSON.stringify(health)).not.toContain("interval out of range");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("names the database and the mirror when they do not answer; a deployment without a mirror is not failing", async () => {
    vi.mocked(withScope).mockRejectedValue(new Error("ECONNREFUSED 10.10.10.2:5432"));
    vi.mocked(mirrorApiStatus).mockRejectedValue(new Error("timeout"));
    const down = await checkHealth(NOW);
    expect(down).toMatchObject({ ok: false, database: "down", mirror: "down", failing: ["database", "mirror"] });
    expect(JSON.stringify(down)).not.toContain("10.10.10.2");
    vi.mocked(withScope).mockResolvedValue({ rows: [] } as never);
    vi.mocked(mirrorConfigured).mockReturnValue(false);
    expect(await checkHealth(NOW)).toMatchObject({ ok: true, mirror: "off", sync: {} });
  });

  it("one real check a minute: polling it does not query the database each time", async () => {
    await GET();
    await GET();
    await GET();
    expect(withScope).toHaveBeenCalledTimes(1);
  });
});
