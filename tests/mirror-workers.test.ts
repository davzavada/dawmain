import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/src/mirror/db/client";
import { COOL_DOWN_AFTER, COOL_DOWN_MS, GIVE_UP_AFTER_COOL_DOWNS, SourceUnreachable, fetchAndStore } from "@/src/mirror/crawl/workers";
import { Pacer, SourceStopped } from "@/src/mirror/http";
import type { DecisionRecord } from "@/src/mirror/types";
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

const record = (id: string): DecisionRecord => ({
  source: "ns",
  sourceId: id,
  url: `https://example.test/${id}`,
  court: "Nejvyšší soud",
  caseNumber: null,
  caseNumbers: [],
  decisionType: "rozsudek",
  decidedOn: null,
  legalSentence: null,
  ecli: null,
  publishedOn: null,
  parserVersion: 1,
  text: { body: `Text ${id}.`, source: "ns:webprint" },
});

function ctx(sleeps: number[]) {
  return {
    db,
    pacer: new Pacer(0),
    log: () => undefined,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

/** A context whose pauses pass at once: only the clock moves (the workers compare Date.now() with the pause's end). */
function ctxWithClock(sleeps: number[]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  return {
    ...ctx(sleeps),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      vi.setSystemTime(Date.now() + ms);
    },
  };
}

describe("fetchAndStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues failures and pauses after a run of them instead of queueing everything", async () => {
    const sleeps: number[] = [];
    const items = Array.from({ length: COOL_DOWN_AFTER + 3 }, (_, i) => `F${i}`);
    const counts = { fetched: 0, changed: 0, failed: 0 };
    let calls = 0;
    await fetchAndStore(
      ctx(sleeps),
      {
        source: "ns",
        parserVersion: 1,
        items,
        id: (x) => x,
        // The server is down for the first COOL_DOWN_AFTER requests, then back.
        fetch: async (x) => {
          if (++calls <= COOL_DOWN_AFTER) throw new Error("HTTP 500");
          return record(x);
        },
        concurrency: 1,
      },
      counts,
    );
    expect(counts).toEqual({ fetched: 3, changed: 3, failed: COOL_DOWN_AFTER });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(COOL_DOWN_MS - 1000);
    const queued = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mirror.fetch_queue WHERE source = 'ns'");
    expect(queued.rows[0].n).toBe(COOL_DOWN_AFTER);
  });

  it("gives up on a source that stays down through every pause, leaving the rest unasked", async () => {
    const sleeps: number[] = [];
    const asked = COOL_DOWN_AFTER * (GIVE_UP_AFTER_COOL_DOWNS + 1);
    const items = Array.from({ length: asked + 40 }, (_, i) => `D${i}`);
    const counts = { fetched: 0, changed: 0, failed: 0 };
    let calls = 0;
    const run = fetchAndStore(
      ctxWithClock(sleeps),
      {
        source: "ns",
        parserVersion: 1,
        items,
        id: (x) => x,
        fetch: async () => {
          calls++;
          throw new Error("fetch failed");
        },
        concurrency: 1,
      },
      counts,
    );
    await expect(run).rejects.toBeInstanceOf(SourceUnreachable);
    expect(sleeps).toHaveLength(GIVE_UP_AFTER_COOL_DOWNS);
    expect(calls).toBe(asked);
    expect(counts).toEqual({ fetched: 0, changed: 0, failed: asked });
    const queued = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mirror.fetch_queue WHERE source = 'ns' AND source_id LIKE 'D%'");
    expect(queued.rows[0].n).toBe(asked); // the 40 never asked were not charged a failed attempt
  });

  it("a stored decision between pauses starts the count again", async () => {
    const sleeps: number[] = [];
    const rounds = GIVE_UP_AFTER_COOL_DOWNS + 2;
    // Each round: COOL_DOWN_AFTER failures (a pause), then one decision that comes through.
    const items = Array.from({ length: rounds * (COOL_DOWN_AFTER + 1) }, (_, i) => `R${i}`);
    const counts = { fetched: 0, changed: 0, failed: 0 };
    let calls = 0;
    await fetchAndStore(
      ctxWithClock(sleeps),
      {
        source: "ns",
        parserVersion: 1,
        items,
        id: (x) => x,
        fetch: async (x) => {
          if (++calls % (COOL_DOWN_AFTER + 1) !== 0) throw new Error("HTTP 500");
          return record(x);
        },
        concurrency: 1,
      },
      counts,
    );
    expect(counts.fetched).toBe(rounds);
    expect(sleeps).toHaveLength(rounds);
  });

  it("stores a record without text as not done and queues it", async () => {
    const counts = { fetched: 0, changed: 0, failed: 0 };
    await fetchAndStore(
      ctx([]),
      { source: "ns", parserVersion: 1, items: ["T1"], id: (x) => x, fetch: async (x) => ({ ...record(x), text: null }), concurrency: 1 },
      counts,
    );
    expect(counts).toMatchObject({ fetched: 1, failed: 0 }); // the source has no text: queued, not a failure
    const q = await pg.query<{ kind: string }>("SELECT kind FROM mirror.fetch_queue WHERE source_id = 'T1'");
    expect(q.rows).toEqual([{ kind: "text" }]);
  });

  it("does not queue a record whose text the source does not have (textAbsent)", async () => {
    const counts = { fetched: 0, changed: 0, failed: 0 };
    await fetchAndStore(
      ctx([]),
      { source: "ns", parserVersion: 1, items: ["A1"], id: (x) => x, fetch: async (x) => ({ ...record(x), text: null, textAbsent: "česká verze neexistuje" }), concurrency: 1 },
      counts,
    );
    expect(counts).toMatchObject({ fetched: 1, failed: 0 });
    expect((await pg.query("SELECT 1 FROM mirror.fetch_queue WHERE source_id = 'A1'")).rows).toHaveLength(0);
  });

  it("skips what is stored, and a 429/403 stops every worker", async () => {
    const counts = { fetched: 0, changed: 0, failed: 0 };
    const fetched: string[] = [];
    const run = fetchAndStore(
      ctx([]),
      {
        source: "ns",
        parserVersion: 1,
        items: ["F5", "S1", "S2", "S3", "S4"],
        id: (x) => x,
        fetch: async (x) => {
          fetched.push(x);
          if (x === "S2") throw new SourceStopped(429, "https://example.test");
          return record(x);
        },
        concurrency: 1,
      },
      counts,
    );
    await expect(run).rejects.toBeInstanceOf(SourceStopped);
    expect(fetched).toEqual(["S1", "S2"]); // F5 was stored by the first test; S3, S4 never asked
  });
});
