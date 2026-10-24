import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/src/mirror/db/client";
import { dequeue, enqueue, finishRun, idsWithText, saveDecision, startRun } from "@/src/mirror/db/store";
import { mirrorStatus } from "@/src/mirror/status";
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
    `SELECT d.*, t.char_count, t.text_source, (SELECT count(*) FROM mirror.decision_chunk c WHERE c.decision_id = d.id) AS chunks
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

  it("lists ids stored with text", async () => {
    await saveDecision(db, record({ sourceId: "2-1-26_1", text: null }));
    expect([...(await idsWithText(db, "us", ["1-1169-26_1", "2-1-26_1", "3-9-26_1"]))]).toEqual(["1-1169-26_1"]);
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
    expect(us).toMatchObject({ decisions: 2, withText: 1, withoutText: 1, shortText: 1, withLegalSentence: 1, queued: 1 });
    expect(us.lastRun).toMatchObject({ mode: "backfill", fetched: 3, changed: 2, failed: 1, error: null });
    expect(status.sources.find((s) => s.source === "ns")).toMatchObject({ decisions: 0, lastRun: null });
  });
});
