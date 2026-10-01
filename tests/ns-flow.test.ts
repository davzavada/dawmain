import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The NS search and reading flows against a scripted fetch: which requests
 * go upstream (Start, Count), how many, how the gate and the call's deadline
 * bound them — and what the tools print. Every test loads fresh modules, so
 * the module-scope gate and caches start cold.
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const SINGLE_PAGE = fixture("ns-search-single.html");
const PROJEDNAL = fixture("ns-webprint-projednal.html");
const PROJEDNAL_UNID = "BC526E28EAAF986CC1258E3B004D3D2A";

const unidOf = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");
/** A result page listing the given document numbers, under a "1 - N z total" banner. */
const resultsPage = (ids: number[], total = ids.length) =>
  `<html><body><p>V&yacute;sledky 1 - ${ids.length} z ${total}</p><table>${ids
    .map(
      (id) =>
        `<tr><td><a class="odk" href="/Judikatura/judikatura_ns.nsf/WebSearch/${unidOf(id)}?openDocument">${id} Cdo ${id}/2024</a></td></tr>`,
    )
    .join("")}</table></body></html>`;

/** A WebPrint page that carries only the metadata table (no judgment body). */
const METADATA_ONLY = `<html><body><table id="box-table-a">
<tr><td class="left-part">Spisová značka:</td><td class="right-part">23 Cdo 1/2010</td></tr>
<tr><td class="left-part">Datum rozhodnutí:</td><td class="right-part">05/20/2010</td></tr>
</table></body></html>`;

interface Call {
  url: URL;
  at: number;
}

let calls: Call[];
let inFlight: number;
let maxInFlight: number;

function stubFetch(handler: (url: URL) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw);
    calls.push({ url, at: Date.now() });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await handler(url);
    } finally {
      inFlight -= 1;
    }
  });
}

const param = (call: Call, name: string) => call.url.searchParams.get(name);
const searches = () => calls.filter((call) => call.url.pathname.endsWith("$$WebSearch1"));
const later = <T>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));

const loadSource = () => import("@/src/sources/ns");

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

async function loadTools(): Promise<Record<string, Handler>> {
  const { registerNs } = await import("@/src/mcp/tools/ns");
  const tools: Record<string, Handler> = {};
  registerNs({
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools[name] = handler;
    },
  } as never);
  return tools;
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { kind?: string }).kind ?? String(error);
  }
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchNs — paging", () => {
  it("pages a field-only listing with Domino's 1-based Start; relevance reads from the top", async () => {
    stubFetch(() => new Response(resultsPage([1, 2, 3], 66)));
    const { searchNs } = await loadSource();
    await searchNs({ dateFrom: "2025-06-02" }, 0, 20);
    await searchNs({ dateFrom: "2025-06-02" }, 20, 20);
    await searchNs({ query: "nájem" }, 20, 20);
    expect(calls.map((call) => [param(call, "SearchOrder"), param(call, "Start"), param(call, "Count")])).toEqual([
      ["4", "1", "20"],
      ["4", "21", "20"],
      ["1", "0", "100"],
    ]);
  });

  it("pages past row 100 without repeating or skipping hits, whatever Count does to the ranking", async () => {
    // Domino's relevance order depends on Count (live: rows 96–100 differed
    // between Count=100 and Count=200). Here Count=900 swaps rows 90–99 with
    // 100–109 of the Count=100 ranking.
    const ranking = (count: number) => {
      const ids = Array.from({ length: count }, (_, i) => i);
      if (count === 900) for (let i = 90; i < 100; i++) [ids[i], ids[i + 10]] = [ids[i + 10], ids[i]];
      return ids;
    };
    stubFetch((url) => new Response(resultsPage(ranking(Number(url.searchParams.get("Count"))), 900)));
    const { searchNs } = await loadSource();
    const shown: string[] = [];
    for (let offset = 0; offset < 200; offset += 20) {
      shown.push(...(await searchNs({ query: "výpověď z nájmu" }, offset, 20)).hits.map((hit) => hit.unid));
    }
    expect(new Set(shown).size).toBe(200);
    expect(shown).toEqual(Array.from({ length: 200 }, (_, i) => unidOf(i)));
    // One request per tier, each cached for every page it serves.
    expect(searches().map((call) => param(call, "Count"))).toEqual(["100", "900"]);
  });

  it("does not fetch the deep block when the first one already holds the whole result", async () => {
    stubFetch(() => new Response(resultsPage([1, 2, 3])));
    const { searchNs } = await loadSource();
    const page = await searchNs({ query: "vzácný" }, 0, 900);
    expect(page.hits).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});

describe("searchNs — refusals", () => {
  it("reports a 4xx answer as a request error, not as a layout change", async () => {
    stubFetch(() => new Response("<html>URI too long</html>", { status: 414 }));
    const { searchNs } = await loadSource();
    const error = await searchNs({ query: "unikátní dotaz" }, 0, 20).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "INPUT_INVALID" });
    expect((error as { hint: string }).hint).toMatch(/Shorten the query/);
    expect(calls).toHaveLength(1); // a 4xx is not retried
  });

  it("reports a 403 as an upstream error", async () => {
    stubFetch(() => new Response("<html>Forbidden</html>", { status: 403 }));
    const { searchNs } = await loadSource();
    expect(await kindOf(searchNs({ query: "jiný dotaz" }, 0, 20))).toBe("UPSTREAM_ERROR");
  });
});

describe("NS gate and the call's deadline", () => {
  it("never sends a queued request the call can no longer wait for", async () => {
    vi.useFakeTimers();
    // NS takes 18 s to answer 500; the call has 20 s.
    stubFetch(() => later(18_000, () => new Response("busy", { status: 500 })));
    const { searchNs } = await loadSource();
    const deadlineAt = Date.now() + 20_000;
    const settled = Promise.all(
      ["a1", "b2", "c3"].map((query) => kindOf(searchNs({ query }, 0, 20, { deadlineAt }))),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const kinds = await settled;
    // Two went out and failed (no time left for a retry); the third waited
    // for a slot until 3 s before the deadline and was never sent.
    expect(calls).toHaveLength(2);
    expect(kinds).toEqual(["UPSTREAM_ERROR", "UPSTREAM_ERROR", "UPSTREAM_UNREACHABLE"]);
    expect(maxInFlight).toBe(2);
  });

  it("ns_search with three slow-failing variants answers before the platform's 60 s", async () => {
    vi.useFakeTimers();
    stubFetch(() => later(14_000, () => new Response("busy", { status: 500 })));
    const tools = await loadTools();
    const start = Date.now();
    let doneAt = 0;
    const pending = tools
      .ns_search({ queries: ["nájem byt", "pacht pozemek", "výpověď"], limit: 20, offset: 0, read_top: 1 })
      .then((result) => {
        doneAt = Date.now();
        return result;
      });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(doneAt - start).toBeLessThanOrEqual(46_000);
    expect(result.isError).toBe(true);
    expect(maxInFlight).toBe(2);
    // Nothing went out in the last 3 s before the 45 s search budget.
    expect(calls.every((call) => call.at - start <= 42_000)).toBe(true);
  });

  it("does not hold a slot through the retry back-off", async () => {
    vi.useFakeTimers();
    let first = true;
    stubFetch((url) => {
      if (url.searchParams.get("Query")?.includes("refused") && first) {
        first = false;
        return new Response("busy", { status: 500 });
      }
      return later(5_000, () => new Response(resultsPage([1])));
    });
    const { searchNs } = await loadSource();
    const order: string[] = [];
    const run = (query: string) => searchNs({ query }, 0, 20).then(() => order.push(query));
    const all = Promise.all([run("refused"), run("busy one"), run("queued")]);
    await vi.advanceTimersByTimeAsync(1_000);
    // "refused" failed at once and sleeps its back-off: "queued" took its slot.
    expect(calls.map((call) => call.url.searchParams.get("Query"))).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    expect(calls).toHaveLength(4);
    expect(maxInFlight).toBe(2);
  });
});

describe("getNsDecision", () => {
  it("reads a 'Nejvyšší soud projednal' decision with one request — no WebSearch fallback", async () => {
    stubFetch(() => new Response(PROJEDNAL));
    const { getNsDecision } = await loadSource();
    const decision = await getNsDecision(PROJEDNAL_UNID);
    expect(decision.text).toContain("a rozhodl takto");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toContain("/WebPrint/");
  });

  it("does not cache 'no body' when the WebSearch rendition could not be read", async () => {
    vi.useFakeTimers();
    let webSearchUp = false;
    stubFetch((url) => {
      if (url.pathname.includes("/WebPrint/")) return new Response(METADATA_ONLY);
      return webSearchUp ? new Response(PROJEDNAL) : new Response("down", { status: 503 });
    });
    const tools = await loadTools();
    const firstCall = tools.ns_get_decision({ unid: PROJEDNAL_UNID, page: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const first = (await firstCall).content[0].text;
    expect(first).toContain("could not be read just now");
    expect(first).not.toContain("neither the WebPrint nor the WebSearch rendition carries it");

    webSearchUp = true;
    const before = calls.length;
    const second = (await tools.ns_get_decision({ unid: PROJEDNAL_UNID, page: 1 })).content[0].text;
    expect(calls.length).toBeGreaterThan(before);
    expect(second).toContain("a rozhodl takto");
  });

  it("asserts 'no body' only when both renditions were read", async () => {
    stubFetch(() => new Response(METADATA_ONLY));
    const tools = await loadTools();
    const text = (await tools.ns_get_decision({ unid: PROJEDNAL_UNID, page: 1 })).content[0].text;
    expect(text).toContain("neither the WebPrint nor the WebSearch rendition carries it");
    expect(calls).toHaveLength(2);
  });

  it("takes a WebSearch page that was read but carries nothing as confirmation, not as 'could not be read'", async () => {
    stubFetch((url) =>
      url.pathname.includes("/WebPrint/") ? new Response(METADATA_ONLY) : new Response("<html><body></body></html>"),
    );
    const tools = await loadTools();
    const text = (await tools.ns_get_decision({ unid: PROJEDNAL_UNID, page: 1 })).content[0].text;
    expect(text).toContain("neither the WebPrint nor the WebSearch rendition carries it");
    expect(text).not.toContain("could not be read just now");
    // Confirmed, so cached: the second call asks NS nothing.
    await tools.ns_get_decision({ unid: PROJEDNAL_UNID, page: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe("ns_search tool", () => {
  it("prints a single-result lookup as one decision, not '?'", async () => {
    stubFetch(() => new Response(SINGLE_PAGE));
    const tools = await loadTools();
    const result = await tools.ns_search({ case_number: "23 Cdo 116/2017", limit: 20, offset: 0, read_top: 0 });
    expect(result.content[0].text).toMatch(/^1 decision:\n1\. 23 Cdo 116\/2017 \[E\]/);
    expect(result.structuredContent?.total).toBe(1);
  });

  it("marks only a failed variant with ✗ — a count NS did not print is '?'", async () => {
    stubFetch((url) => {
      const query = url.searchParams.get("Query") ?? "";
      if (query.includes("selhani")) return new Response("busy", { status: 500 });
      if (query.includes("neznamy")) return new Response(resultsPage([7]).replace(/<p>V&yacute;sledky[^<]*<\/p>/, ""));
      return new Response(resultsPage([1, 2]));
    });
    vi.useFakeTimers();
    const tools = await loadTools();
    const pending = tools.ns_search({ queries: ["znamy", "neznamy", "selhani"], limit: 20, offset: 0, read_top: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    const text = (await pending).content[0].text;
    expect(text).toContain('Variants: "znamy" 2 · "neznamy" ? · "selhani" ✗');
  });

  it("previews the výrok of a query-less lookup instead of 'query terms do not occur'", async () => {
    stubFetch((url) => new Response(url.pathname.includes("/WebPrint/") ? PROJEDNAL : SINGLE_PAGE));
    const tools = await loadTools();
    const text = (await tools.ns_search({ case_number: "23 Cdo 116/2017", limit: 20, offset: 0, read_top: 1 }))
      .content[0].text;
    expect(text).not.toContain("query terms do not occur");
    expect(text).toContain("— VÝROK 23 Cdo 116/2017");
    expect(text).toContain("se dovolání obviněného P. Š. odmítá");
    expect(text).not.toContain("Dosavadní průběh řízení");
  });
});

describe("ns_get_decision tool", () => {
  it("labels a link as opening at the passage only when it carries a highlight", async () => {
    stubFetch(() => new Response(PROJEDNAL));
    const tools = await loadTools();
    // "P. Š." matches the text, but every word is under 3 characters — no Highlight.
    const short = (await tools.ns_get_decision({ unid: PROJEDNAL_UNID, find: "P. Š.", page: 1 })).content[0].text;
    expect(short).not.toContain("opens at the found passage");
    expect(short).not.toContain("Highlight=");
    const long = (await tools.ns_get_decision({ unid: PROJEDNAL_UNID, find: "dovolání", page: 1 })).content[0].text;
    expect(long).toMatch(/&Highlight=0,dovol%C3%A1n%C3%AD \(opens at the found passage\)/);
  });
});
