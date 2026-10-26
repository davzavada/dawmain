import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/src/mirror/db/client";
import { writeCursor } from "@/src/mirror/db/store";
import { Pacer } from "@/src/mirror/http";
import { daysAgo, nssBackfillDone, SYNC_DAYS } from "@/src/mirror/sync";
import { sdeuCelexQuery, sdeuRecentQuery } from "@/src/mirror/crawl/sdeu";
import { mapUs, usTextExtras } from "@/src/mirror/map/us";
import { parseNalusDecision } from "@/src/sources/nalus";
import { createMirrorTestDb } from "./helpers/mirror-db";

let pg: PGlite;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ pg, db, close } = await createMirrorTestDb());
});
afterAll(async () => {
  await close();
});

describe("sync windows", () => {
  it("counts days back from now; justice looks twice as far (v1-plan: 14 days)", () => {
    expect(daysAgo(7, new Date("2026-10-26T03:30:00Z"))).toBe("2026-10-19");
    expect(daysAgo(1, new Date("2026-03-01T01:00:00Z"))).toBe("2026-02-28");
    expect(SYNC_DAYS).toEqual({ us: 7, ns: 7, nss: 7, justice: 14, sdeu: 7 });
  });

  it("syncs NSS only once its backfill has passed the current month", async () => {
    const ctx = { db, pacer: new Pacer(0), log: () => undefined };
    const now = new Date("2026-10-26T03:30:00Z");
    expect(await nssBackfillDone(ctx, now)).toBe(false); // no cursor yet
    await writeCursor(db, "nss", { next: "2008-06" });
    expect(await nssBackfillDone(ctx, now)).toBe(false);
    await writeCursor(db, "nss", { next: "2026-11" });
    expect(await nssBackfillDone(ctx, now)).toBe(true);
    await pg.query("DELETE FROM mirror.sync_cursor WHERE source = 'nss'");
  });
});

describe("SDEU sync and retry queries", () => {
  it("asks for case law received since a date", () => {
    const q = sdeuRecentQuery("2026-10-19");
    expect(q).toContain('?w cdm:work_datetime_transmission ?since');
    expect(q).toContain('FILTER(?since >= "2026-10-19T00:00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>)');
    expect(() => sdeuRecentQuery("2026-10-19'); DROP")).toThrow();
  });

  it("asks for given CELEX numbers only, and only valid ones", () => {
    const q = sdeuCelexQuery(["62019CJ0311", "nonsense\" }", "62010TJ0063"]);
    expect(q).toContain('VALUES ?celex { "62019CJ0311"^^<http://www.w3.org/2001/XMLSchema#string> "62010TJ0063"^^<http://www.w3.org/2001/XMLSchema#string> }');
    expect(q).not.toContain("nonsense");
    expect(() => sdeuCelexQuery(["x"])).toThrow();
  });
});

describe("ÚS retry without a stored row", () => {
  it("takes case number and date from the page's registry sign", () => {
    const html = readFileSync(path.join(__dirname, "fixtures", "mirror", "us-gettext-1-1169-26_1.html"), "utf8");
    const record = mapUs({ sz: "1-1169-26_1", caseNumber: "", url: null }, parseNalusDecision(html, "1-1169-26_1"), null, usTextExtras(html));
    expect(record).toMatchObject({ caseNumber: "I. ÚS 1169/26", caseNumbers: ["I. ÚS 1169/26"], decidedOn: "2026-07-07" });
  });
});
