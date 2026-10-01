import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * e-Sbírka's `start` is a PAGE index in pages of `pocet` rows (measured
 * 2026-09: start 1 + pocet 3 answered ranks 4–6). The stub serves a
 * synthetic ranking exactly that way.
 */

const RANKING = Array.from({ length: 50 }, (_, i) => ({ staleUrl: `/sb/2000/${i + 1}`, nazev: `Zákon ${i + 1}` }));

function serveRanking(total = RANKING.length): Array<{ start: number; pocet: number }> {
  const bodies: Array<{ start: number; pocet: number }> = [];
  vi.stubGlobal("fetch", async (_input: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { start: number; pocet: number };
    bodies.push({ start: body.start, pocet: body.pocet });
    const from = body.start * body.pocet;
    return new Response(JSON.stringify({ pocetCelkem: total, seznam: RANKING.slice(0, total).slice(from, from + body.pocet) }));
  });
  return bodies;
}

beforeEach(() => {
  delete process.env.ESBIRKA_API_KEY;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchActs translates a row offset into upstream pages (finding 0)", () => {
  it("offset 0 asks for page 0", async () => {
    const bodies = serveRanking();
    const { searchActs } = await import("@/src/sources/esbirka");
    const page = await searchActs("nájemce", 0, 10);
    expect(bodies).toEqual([{ start: 0, pocet: 10 }]);
    expect(page.items.map((item) => item.staleUrl)).toEqual(RANKING.slice(0, 10).map((item) => item.staleUrl));
  });

  it("offset 10 at limit 10 is upstream page 1 — one request, ranks 11–20", async () => {
    const bodies = serveRanking();
    const { searchActs } = await import("@/src/sources/esbirka");
    const page = await searchActs("nájemce", 10, 10);
    expect(bodies).toEqual([{ start: 1, pocet: 10 }]);
    expect(page.items.map((item) => item.nazev)).toEqual(RANKING.slice(10, 20).map((item) => item.nazev));
    expect(page.total).toBe(50);
  });

  it("an offset between pages reads both neighbours and cuts the window out", async () => {
    const bodies = serveRanking();
    const { searchActs } = await import("@/src/sources/esbirka");
    const page = await searchActs("nájemce", 15, 10);
    expect(bodies.sort((a, b) => a.start - b.start)).toEqual([
      { start: 1, pocet: 10 },
      { start: 2, pocet: 10 },
    ]);
    expect(page.items.map((item) => item.nazev)).toEqual(RANKING.slice(15, 25).map((item) => item.nazev));
  });

  it("the window at the end of the ranking is short, not padded", async () => {
    serveRanking();
    const { searchActs } = await import("@/src/sources/esbirka");
    const page = await searchActs("nájemce", 45, 10);
    expect(page.items.map((item) => item.nazev)).toEqual(RANKING.slice(45).map((item) => item.nazev));
  });

  it("caches each upstream page, so the neighbouring window reuses it", async () => {
    const bodies = serveRanking();
    const { searchActs } = await import("@/src/sources/esbirka");
    await searchActs("nájemce", 0, 10);
    await searchActs("nájemce", 5, 10);
    expect(bodies).toEqual([
      { start: 0, pocet: 10 },
      { start: 1, pocet: 10 },
    ]);
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

async function searchTool(): Promise<Handler> {
  const { registerEsbirka } = await import("@/src/mcp/tools/esbirka");
  let handler: Handler | undefined;
  registerEsbirka({
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === "esbirka_search") handler = callback;
    },
  } as never);
  if (!handler) throw new Error("esbirka_search did not register");
  return handler;
}

const args = { query: "zvlášť závažným způsobem nájemce", match: "all_words", limit: 3, offset: 0 };

describe("esbirka_search text", () => {
  it("numbers the hits by their real rank", async () => {
    serveRanking();
    const handler = await searchTool();
    const text = (await handler({ ...args, offset: 1 })).content[0].text;
    expect(text).toContain("Found 50 acts (showing 2–4)");
    expect(text).toContain("2. /sb/2000/2 — Zákon 2");
    expect(text).toContain("4. /sb/2000/4 — Zákon 4");
  });

  it("past the end of a query that matched, says so instead of 'no match' (finding 9)", async () => {
    serveRanking();
    const handler = await searchTool();
    const text = (await handler({ ...args, limit: 10, offset: 60 })).content[0].text;
    expect(text).toContain("matched 50");
    expect(text).toContain("offset 60 is past the last one");
    expect(text).not.toContain("No acts matched");
    expect(text).not.toContain("Try different Czech terms");
  });

  it("keeps the reformulation hint when nothing matched at all", async () => {
    serveRanking(0);
    const handler = await searchTool();
    const text = (await handler(args)).content[0].text;
    expect(text).toContain('No acts matched "zvlášť závažným způsobem nájemce". Try different Czech terms');
  });
});
