import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/src/mirror/db/client";
import { saveDecision } from "@/src/mirror/db/store";
import { Pacer, SourceStopped } from "@/src/mirror/http";
import { fetchRawMissing } from "@/src/mirror/raw";
import type { DecisionRecord } from "@/src/mirror/types";
import { createMirrorTestDb } from "./helpers/mirror-db";

/** `mirror raw` over the real schema, the courts answered by a stubbed fetch. */

let pg: PGlite;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ pg, db, close } = await createMirrorTestDb());
  for (const id of ["NSS-1", "NSS-2", "NSS-3"]) await saveDecision(db, record(id));
});
afterAll(async () => {
  await close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function record(id: string): DecisionRecord {
  return {
    source: "nss",
    sourceId: id,
    url: `https://vyhledavac.nssoud.cz/DokumentOriginal/Html/${id}`,
    court: "Nejvyšší správní soud",
    caseNumber: null,
    caseNumbers: [],
    decisionType: "rozsudek",
    decidedOn: null,
    legalSentence: null,
    ecli: null,
    publishedOn: null,
    parserVersion: 1,
    text: { body: `Text ${id}.`, source: "nss:text" },
  };
}

const ctx = () => ({ db, pacer: new Pacer(0), log: () => undefined });
const counts = () => ({ fetched: 0, changed: 0, failed: 0 });
const rows = async () =>
  (await pg.query<{ source_id: string; status: number; url: string; gz: Uint8Array }>(
    `SELECT d.source_id, r.status, r.url, r.gz FROM mirror.decision_raw r JOIN mirror.decision d ON d.id = r.decision_id ORDER BY 1`,
  )).rows;

describe("fetchRawMissing", () => {
  it("keeps each decision's HTML, a 404 as such, leaves a failure for the next run, and asks nothing twice", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (url.endsWith("/NSS-2")) return new Response("", { status: 404 });
      if (url.endsWith("/NSS-3")) return new Response("chyba", { status: 500 });
      return new Response("<p><b>Rozsudek</b></p>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const c = counts();
    await fetchRawMissing(ctx(), "nss", {}, c);
    expect(c).toMatchObject({ fetched: 2, changed: 1, failed: 1 });
    const kept = await rows();
    expect(kept.map((r) => [r.source_id, r.status])).toEqual([["NSS-1", 200], ["NSS-2", 404]]);
    expect(kept[0].url).toBe("https://vyhledavac.nssoud.cz/DokumentOriginal/Html/NSS-1");
    expect(new TextDecoder().decode(gunzipSync(kept[0].gz))).toBe("<p><b>Rozsudek</b></p>");
    // The next run asks only for the one that failed.
    asked.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response("<p>ok</p>", { status: 200 });
    });
    await fetchRawMissing(ctx(), "nss", {}, counts());
    expect(asked.map((u) => u.split("/").pop())).toEqual(["NSS-3"]);
    expect((await rows()).length).toBe(3);
  });

  it("stops the source on 403", async () => {
    await pg.query("DELETE FROM mirror.decision_raw");
    vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
    await expect(fetchRawMissing(ctx(), "nss", { limit: 2 }, counts())).rejects.toBeInstanceOf(SourceStopped);
    expect((await rows()).length).toBe(0);
  });
});
