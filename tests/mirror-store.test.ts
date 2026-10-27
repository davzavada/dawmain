import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/src/mirror/db/client";
import { dequeue, enqueue, finishRun, idsWithText, saveDecision, startRun } from "@/src/mirror/db/store";
import { mirrorStatus } from "@/src/mirror/status";
import { reindexSource } from "@/src/mirror/reindex";
import type { DecisionRecord } from "@/src/mirror/types";

/** The crawler's writes against the real schema (PGlite). */

interface Migrator {
  migrate(
    client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
    options?: { dir?: string; rlsCheck?: boolean; log?: (line: string) => void },
  ): Promise<unknown>;
}

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = await PGlite.create();
  const m = (await import(/* @vite-ignore */ path.resolve(__dirname, "..", "scripts", "db-migrate.mjs"))) as Migrator;
  await m.migrate(
    {
      async query(text, params) {
        if (params) return (await pg.query(text, params)) as { rows: Record<string, unknown>[] };
        const results = await pg.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      },
    },
    { dir: path.resolve(__dirname, "..", "src", "mirror", "db", "migrations"), rlsCheck: false, log: () => undefined },
  );
  db = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
});
afterAll(async () => {
  await pg.close();
});

const body = "Ústavní soud rozhodl. ".repeat(200) + "Odkaz na sp. zn. Pl. ÚS 24/10.";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    source: "us",
    sourceId: "1-1169-26_1",
    url: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1169-26_1",
    court: "Ústavní soud – I. senát",
    caseNumber: "I. ÚS 1169/26",
    caseNumbers: ["I. ÚS 1169/26"],
    decisionType: "usneseni",
    decidedOn: "2026-07-07",
    legalSentence: null,
    ecli: "ECLI:CZ:US:2026:1.US.1169.26.1",
    publishedOn: "2026-07-27",
    parserVersion: 1,
    text: { body, source: "us:gettext-hidden" },
    ...overrides,
  };
}

async function row(sourceId = "1-1169-26_1") {
  const { rows } = await pg.query<Record<string, unknown>>(
    `SELECT d.*, t.char_count, t.text_source, (SELECT min(x.char_start) FROM mirror.decision_dissent x WHERE x.decision_id = d.id) AS dissent_at, (SELECT count(*) FROM mirror.decision_chunk c WHERE c.decision_id = d.id) AS chunks
     FROM mirror.decision d LEFT JOIN mirror.decision_text t ON t.decision_id = d.id WHERE d.source = 'us' AND d.source_id = $1`,
    [sourceId],
  );
  return rows[0];
}

describe("saveDecision", () => {
  it("inserts the decision with its text and chunks", async () => {
    const saved = await saveDecision(db, record());
    expect(saved).toMatchObject({ inserted: true, textChanged: true });
    const r = await row();
    expect(r.char_count).toBe(body.length);
    expect(Number(r.chunks)).toBeGreaterThan(1);
    expect(r.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    const hit = await pg.query("SELECT 1 FROM mirror.decision_chunk WHERE ident_keys && ARRAY['sz:plus24-2010']");
    expect(hit.rows).toHaveLength(1);
  });

  it("is idempotent: the same record changes nothing, last_changed_at stays", async () => {
    const before = await row();
    const saved = await saveDecision(db, record());
    expect(saved).toMatchObject({ inserted: false, textChanged: false });
    const after = await row();
    expect(after.last_changed_at).toEqual(before.last_changed_at);
    expect(after.chunks).toEqual(before.chunks);
  });

  it("rewrites text and chunks when the text changes, and keeps the text when a record comes without one", async () => {
    const before = await row();
    expect((await saveDecision(db, record({ text: { body: "Nové znění.", source: "us:gettext-hidden" } }))).textChanged).toBe(true);
    const changed = await row();
    expect(changed.text_sha256).not.toEqual(before.text_sha256);
    expect(Number(changed.chunks)).toBe(1);
    expect((changed.last_changed_at as Date) >= (before.last_changed_at as Date)).toBe(true);

    await saveDecision(db, record({ text: null, legalSentence: "Právní věta." }));
    const kept = await row();
    expect(kept.text_sha256).toEqual(changed.text_sha256);
    expect(kept.char_count).toBe("Nové znění.".length);
    expect(kept.legal_sentence).toBe("Právní věta.");
  });

  it("stores the source's metadata verbatim, without NUL, and keeps it when a record comes without", async () => {
    const own = { sourceId: "meta-1", caseNumber: "I. ÚS 9/99", caseNumbers: ["I. ÚS 9/99"] };
    await saveDecision(db, record({ ...own, sourceMeta: { Heslo: "Náhrada\u0000 škody", "Ústavní stížnost": "IV. ÚS 1/24 | vyhověno" } }));
    const meta = async () => (await db.query<{ m: unknown }>("SELECT source_meta AS m FROM mirror.decision WHERE source_id = 'meta-1'")).rows[0].m;
    expect(await meta()).toEqual({ Heslo: "Náhrada škody", "Ústavní stížnost": "IV. ÚS 1/24 | vyhověno" });
    await saveDecision(db, record({ ...own, sourceMeta: null }));
    expect(await meta()).toEqual({ Heslo: "Náhrada škody", "Ústavní stížnost": "IV. ÚS 1/24 | vyhověno" });
    await db.query("DELETE FROM mirror.decision WHERE source_id = 'meta-1'");
  });

  it("lists done ids: with text, or without it and not queued; a queued one is fetched again", async () => {
    await saveDecision(db, record({ sourceId: "2-1-26_1", text: null }));
    await saveDecision(db, record({ sourceId: "2-2-26_1", text: null }));
    await enqueue(db, "us", "2-2-26_1", "text", "no text yet");
    const done = await idsWithText(db, "us", ["1-1169-26_1", "2-1-26_1", "2-2-26_1", "3-9-26_1"], 1);
    expect([...done].sort()).toEqual(["1-1169-26_1", "2-1-26_1"]);
    expect((await idsWithText(db, "us", ["1-1169-26_1"], 2)).size).toBe(0); // a newer parser fetches it again
    await dequeue(db, "us", "2-2-26_1");
    await pg.query("DELETE FROM mirror.decision WHERE source_id = '2-2-26_1'");
  });
});

describe("search fields on the text", () => {
  it("copies court, date, type and category onto the text, and follows the decision's changes", async () => {
    const own = { sourceId: "BM25-1", decidedOn: "2024-05-06", decisionType: "nalez" as const, text: { body: "Text pro hledání.", source: "us:gettext-hidden" } };
    await saveDecision(db, record(own));
    const meta = async () =>
      (await pg.query<Record<string, unknown>>(
        `SELECT t.source, t.decided_on::text AS decided_on, t.decision_type, t.category FROM mirror.decision_text t
         JOIN mirror.decision d ON d.id = t.decision_id WHERE d.source_id = 'BM25-1'`,
      )).rows[0];
    expect(await meta()).toEqual({ source: "us", decided_on: "2024-05-06", decision_type: "nalez", category: null });
    await pg.query(`UPDATE mirror.decision SET category = 'B', decided_on = '2024-05-07' WHERE source_id = 'BM25-1'`);
    expect(await meta()).toMatchObject({ decided_on: "2024-05-07", category: "B" });
    await saveDecision(db, record({ ...own, text: { body: "Nový text pro hledání.", source: "us:gettext-hidden" } }));
    expect(await meta()).toMatchObject({ decided_on: "2024-05-06", decision_type: "nalez" });
    await pg.query(`DELETE FROM mirror.decision WHERE source_id = 'BM25-1'`);
  });
});

describe("type, dissent and pictures", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dissentBody = "Ústavní soud rozhodl takto. ".repeat(30) + "\npředseda senátu\n\nOdlišné stanovisko\n\nNesouhlasím.";

  it("stores the type, the dissent offset and the pictures; a newer parser rewrites them", async () => {
    const base = record({ sourceId: "4-296-24_1", decisionType: "nalez", text: { body: dissentBody, source: "us:gettext-hidden" } });
    await saveDecision(db, { ...base, images: [{ charAt: dissentBody.indexOf("\n\nOdlišné"), mime: "image/png", width: 609, height: 1, bytes: png }] });
    const r = await row("4-296-24_1");
    expect(r.decision_type).toBe("nalez");
    expect(r.dissent_at).toBe(dissentBody.indexOf("Odlišné stanovisko"));
    const img = await pg.query<{ ord: number; mime: string; width: number; bytes: Uint8Array; sha256: string }>(
      "SELECT i.ord, i.mime, i.width, b.bytes, i.sha256 FROM mirror.decision_image i JOIN mirror.image_blob b ON b.sha256 = i.sha256 JOIN mirror.decision d ON d.id = i.decision_id WHERE d.source_id = '4-296-24_1'",
    );
    expect(img.rows).toHaveLength(1);
    expect(img.rows[0]).toMatchObject({ ord: 0, mime: "image/png", width: 609 });
    expect(Buffer.from(img.rows[0].bytes).toString("hex")).toBe("89504e470d0a1a0a");

    // Same text, same parser: nothing is rewritten, the picture stays.
    await saveDecision(db, { ...base, images: [] });
    expect((await pg.query("SELECT 1 FROM mirror.decision_image")).rows).toHaveLength(1);
    // A newer parser rewrites the pictures it read.
    await saveDecision(db, { ...base, parserVersion: 2, images: [] });
    expect((await pg.query("SELECT 1 FROM mirror.decision_image")).rows).toHaveLength(0);
  });
});

describe("NUL characters", () => {
  it("drops U+0000 from the text and the fields instead of failing the insert", async () => {
    await saveDecision(db, record({ sourceId: "NUL-1", caseNumbers: ["I. ÚS 1/26\u0000"], text: { body: "Text\u0000 s nulou.", source: "us:gettext-hidden" } }));
    const r = await row("NUL-1");
    expect(r.case_numbers).toEqual(["I. ÚS 1/26"]);
    const t = await pg.query<{ body: string }>("SELECT t.body FROM mirror.decision_text t JOIN mirror.decision d ON d.id = t.decision_id WHERE d.source_id = 'NUL-1'");
    expect(t.rows[0].body).toBe("Text s nulou.");
    await pg.query("DELETE FROM mirror.decision WHERE source_id = 'NUL-1'");
  });
});

describe("image blobs", () => {
  it("stores the same picture once, however many decisions carry it", async () => {
    const emblem = Uint8Array.from(Buffer.from("47494638396169007700", "hex"));
    const img = { charAt: 0, mime: "image/gif" as const, width: 105, height: 119, bytes: emblem, sourceUrl: "https://example.test/emblem" };
    for (const sid of ["NS-A", "NS-B", "NS-C"]) {
      await saveDecision(db, record({ sourceId: sid, text: { body: `Rozsudek ${sid}.`, source: "ns:webprint" }, images: [img] }));
    }
    const sha = (await pg.query<{ sha256: string }>("SELECT DISTINCT sha256 FROM mirror.decision_image WHERE mime = 'image/gif'")).rows;
    expect(sha).toHaveLength(1);
    expect((await pg.query("SELECT 1 FROM mirror.image_blob WHERE sha256 = $1", [sha[0].sha256])).rows).toHaveLength(1);
    expect((await pg.query("SELECT 1 FROM mirror.decision_image WHERE sha256 = $1", [sha[0].sha256])).rows).toHaveLength(3);
    await pg.query("DELETE FROM mirror.decision WHERE source_id IN ('NS-A', 'NS-B', 'NS-C')");
  });
});

describe("reindex", () => {
  it("rebuilds chunks and every dissent from the stored text and pictures, without the source", async () => {
    const text = "Nález. ".repeat(100) + "\nV Brně\n\n1. S T A N O V I S K O\nsoudce X\n" + "Důvody. ".repeat(80) + "\n\nOdlišné stanovisko soudce Y\n\nNesouhlasím.";
    const rule = (at: number) => ({ charAt: at, mime: "image/png" as const, width: 609, height: 1, bytes: Uint8Array.from([0x89, 0x50]) });
    await saveDecision(db, record({ sourceId: "Pl-36-93", decisionType: "nalez", text: { body: text, source: "us:gettext-hidden" }, images: [rule(text.indexOf("\n\n1. S")), rule(text.indexOf("\n\nOdlišné"))] }));
    const id = (await pg.query<{ id: number }>("SELECT id FROM mirror.decision WHERE source_id = 'Pl-36-93'")).rows[0].id;
    const dissents = async () =>
      (await pg.query<{ heading: string }>("SELECT heading FROM mirror.decision_dissent WHERE decision_id = $1 ORDER BY ord", [id])).rows.map((r) => r.heading);
    expect(await dissents()).toEqual(["1. S T A N O V I S K O", "Odlišné stanovisko soudce Y"]);

    await pg.query("DELETE FROM mirror.decision_chunk WHERE decision_id = $1", [id]);
    await pg.query("DELETE FROM mirror.decision_dissent WHERE decision_id = $1", [id]);
    const counts = { fetched: 0, changed: 0, failed: 0 };
    await reindexSource({ db, log: () => undefined }, "us", counts);
    expect(counts.failed).toBe(0);
    expect(counts.fetched).toBe(Number((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mirror.decision_text")).rows[0].n));
    expect(await dissents()).toEqual(["1. S T A N O V I S K O", "Odlišné stanovisko soudce Y"]);
    expect((await pg.query("SELECT 1 FROM mirror.decision_chunk WHERE decision_id = $1", [id])).rows.length).toBeGreaterThan(0);
  });
});

describe("fetch_queue and runs", () => {
  it("backs off on repeated failures and clears on success", async () => {
    await enqueue(db, "us", "3-9-26_1", "decision", "HTTP 500");
    await enqueue(db, "us", "3-9-26_1", "decision", "HTTP 502");
    const { rows } = await pg.query<{ attempts: number; last_error: string; wait: number }>(
      "SELECT attempts, last_error, extract(epoch FROM next_try_at - now())::int AS wait FROM mirror.fetch_queue",
    );
    expect(rows[0]).toMatchObject({ attempts: 2, last_error: "HTTP 502" });
    expect(rows[0].wait).toBeGreaterThan(3600);
    await dequeue(db, "us", "3-9-26_1");
    expect((await pg.query("SELECT 1 FROM mirror.fetch_queue")).rows).toHaveLength(0);
  });

  it("reports per-source status with the last run", async () => {
    await enqueue(db, "us", "3-9-26_1", "text", "empty body");
    const id = await startRun(db, "us", "backfill");
    await finishRun(db, id, { fetched: 3, changed: 2, failed: 1 }, null);
    const status = await mirrorStatus(db);
    const us = status.sources.find((s) => s.source === "us")!;
    expect(us).toMatchObject({ decisions: 4, withText: 3, withoutText: 1, shortText: 1, withLegalSentence: 1, withDissent: 2, dissents: 3, images: 2, queued: 1 });
    expect(us.types).toEqual({ usneseni: 2, nalez: 2 });
    expect(us.lastRun).toMatchObject({ mode: "backfill", fetched: 3, changed: 2, failed: 1, error: null });
    expect(status.sources.find((s) => s.source === "ns")).toMatchObject({ decisions: 0, lastRun: null });
  });
});
