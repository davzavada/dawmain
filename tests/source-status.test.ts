import { afterEach, describe, expect, it, vi } from "vitest";
import { allDatabaseStatuses, DATABASES } from "@/src/mcp/status";
import { revalidate } from "@/app/api/status/route";

/**
 * GET /api/status (app/api/status/route.ts): every listed database, one
 * canary each, regenerated at most once a day. Red only when the source
 * answered wrong; a request that died is "neověřeno" (ok: null).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("allDatabaseStatuses", () => {
  it("answers every listed database in order: green, red on HTTP error, unknown when the request dies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("nssoud.cz")) return new Response("down", { status: 503 });
        if (url.includes("usoud.cz")) throw new TypeError("fetch failed");
        // A body carrying every canary's marker.
        return new Response(
          'Výsledky lblRegistrySign "rok" totalHits "nazev" results "totalResultsLocal" __RequestVerificationToken',
        );
      }),
    );
    const statuses = await allDatabaseStatuses();
    expect(statuses.map((s) => s.id)).toEqual(DATABASES.map((d) => d.canaryId));
    const by = Object.fromEntries(statuses.map((s) => [s.id, s]));
    expect(by.ns).toMatchObject({ ok: true, via: "kontrola" });
    expect(by.nss).toMatchObject({ ok: false, detail: "HTTP 503" });
    expect(by.nalus).toMatchObject({ ok: null, at: null, via: null });
  });

  it("is regenerated at most once a day", () => {
    expect(revalidate).toBe(86400);
  });
});
