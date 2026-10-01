import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interleave } from "@/src/sources/shared/text";

/**
 * The NALUS search and reading flows against a scripted server: which
 * requests go upstream (form GET, criteria POST, Results GET), on which
 * session, how many — and what us_search / us_get_decision print. Every test
 * loads fresh modules, so the module-scope caches start cold.
 */

const FORM = readFileSync(path.join(__dirname, "fixtures", "nalus", "search-form.html"), "utf8");
const ZERO_HITS = `${FORM}<span id="ctl00_MainContent_lbError">Nebyly nalezeny žádné záznamy</span>`;

/** Each variant's hits: numbers base+0 … base+total-1, as I.ÚS n/26 #1. */
interface Variant {
  base: number;
  total: number;
}

interface Call {
  method: string;
  url: URL;
  cookie: string;
  body: URLSearchParams | null;
}

let calls: Call[];
let sessions: Map<string, { variant: Variant; pageSize: number } | null>;
let nextSession: number;
/** What the server answers for each full-text value (absent = 30 hits). */
let catalog: Record<string, Variant>;
/** Kept sessions the server has forgotten (expiry). */
let expired: Set<string>;
/** Override of the banner total a Results GET reports, once. */
let bannerOverride: number | null;
/** The next Results GET serves page 0 whatever ?page= asks for, once. */
let ignorePageOnce: boolean;
/** Fake-clock offset, for the time-budget tests. */
let clockOffset: number;
let onRequest: (call: Call) => void | Promise<void>;

const hitRow = (n: number, i: number) => `
<tr class='resultData0'>
<td class='resultData0'><input type='checkbox' /></td>
<td class='resultData0'><a href='ResultDetail.aspx?id=${n}&pos=${i + 1}' class='resultData0'>I.ÚS ${n}/26 #1</a><br />ECLI:CZ:US:2026:1.US.${n}.26.1<br />Zpravodaj ${n}</td>
<td class='resultData0' rowspan='2'><b>1. 1. 2026</b></td>
<td class='resultData0' rowspan='2'>Usnesení<br />4</td>
</tr>
<tr class='resultData0' valign="top">
<td class='resultActions'><img onclick='javascript:ShowLink("usnesení sp. zn. I. ÚS ${n}/26 ze dne 1. 1. 2026", "Citace", "x");' >
<img onclick='javascript:ShowLink("https://nalus.usoud.cz:443/Search/GetText.aspx?sz=1-${n}-26_1", "Odkaz", "x");' ></td>
</tr>`;

function resultsPage(variant: Variant, page: number, pageSize: number, banner = variant.total): string {
  const from = page * pageSize;
  const to = Math.min(variant.total, from + pageSize);
  const rows = Array.from({ length: Math.max(0, to - from) }, (_, k) => hitRow(variant.base + from + k, from + k));
  return `<html><body><table><tr class="resultHeaderCount"><td>Výsledky ${from + 1} - ${to} z celkem ${banner};</td></tr>${rows.join("")}</table></body></html>`;
}

const DOC = (sz: string) =>
  `<html><body>${"<!-- pad -->".repeat(700)}<span id="lblRegistrySign">I.ÚS ${sz} ze dne 1. 1. 2026</span><input type="hidden" id="docContentHidden" value="Ústavní soud rozhodl o svobodě projevu takto:\\par Stížnost se odmítá." /></body></html>`;
const ABSTRACT = `<table class="legalSentenceContent"><tr><td>Právní věta k věci.</td></tr></table><table class="abstractContent"><tr><td>Abstrakt není k dispozici.</td></tr></table>`;

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  sessions = new Map();
  nextSession = 0;
  catalog = {};
  expired = new Set();
  bannerOverride = null;
  ignorePageOnce = false;
  clockOffset = 0;
  onRequest = () => undefined;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  vi.stubGlobal("fetch", async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      url,
      cookie: headers.cookie ?? "",
      body: typeof init.body === "string" ? new URLSearchParams(init.body) : null,
    };
    calls.push(call);
    await onRequest(call);
    if (init.signal?.aborted) throw init.signal.reason;
    const sessionId = /ASP\.NET_SessionId=([^;]+)/.exec(call.cookie)?.[1];
    if (url.pathname.endsWith("/Search.aspx") && call.method === "GET") {
      const id = `s${nextSession++}`;
      sessions.set(id, null);
      return html(FORM, { headers: { "set-cookie": `ASP.NET_SessionId=${id}; path=/` } });
    }
    if (url.pathname.endsWith("/Search.aspx") && call.method === "POST") {
      const text = call.body?.get("ctl00$MainContent$text") ?? "";
      const variant = catalog[text] ?? { base: 1000, total: 30 };
      if (!variant.total) return html(ZERO_HITS);
      sessions.set(sessionId as string, { variant, pageSize: Number(call.body?.get("ctl00$MainContent$resultsPageSize")) });
      return new Response(null, { status: 302, headers: { location: "/Search/Results.aspx" } });
    }
    if (url.pathname.endsWith("/Results.aspx")) {
      const state = sessionId ? sessions.get(sessionId) : null;
      if (!state || expired.has(sessionId as string)) {
        return new Response(null, { status: 302, headers: { location: "/Search/Search.aspx" } });
      }
      const page = ignorePageOnce ? 0 : Number(url.searchParams.get("page") ?? 0);
      ignorePageOnce = false;
      const banner = bannerOverride ?? state.variant.total;
      bannerOverride = null;
      return html(resultsPage(state.variant, page, state.pageSize, banner));
    }
    if (url.pathname.endsWith("/GetText.aspx")) return html(DOC(url.searchParams.get("sz") as string));
    if (url.pathname.endsWith("/GetAbstract.aspx")) return html(ABSTRACT);
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

async function loadTools(): Promise<Record<string, Handler>> {
  const { registerNalus } = await import("@/src/mcp/tools/nalus");
  const tools: Record<string, Handler> = {};
  registerNalus({
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools[name] = handler;
    },
  } as never);
  return tools;
}

/** The handler's arguments after zod defaults. */
const args = (extra: Record<string, unknown>) => ({
  only_published: false,
  include_dissents: false,
  sort: "date",
  page: 0,
  read_top: 0,
  ...extra,
});

const kinds = () => calls.map((call) => `${call.method} ${call.url.pathname.split("/").pop()}${call.url.search}`);

describe("us_search refuses the číselník pickers NALUS ignores", () => {
  it("judge with a date window: INPUT_INVALID naming the filter, and not one request", async () => {
    const tools = await loadTools();
    const result = await tools.us_search(
      args({ judge: "Wagnerová", types: ["nález"], date_from: "2010-01-01", date_to: "2010-03-31" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("judge");
    expect(result.content[0].text).toContain("UNFILTERED");
    expect(result.content[0].text).toContain("contested_act_number");
    expect(calls).toEqual([]);
  });

  it("dissenting_judge alone (once PARSE_DRIFT) and the codebook filters never reach the network", async () => {
    const tools = await loadTools();
    for (const extra of [
      { dissenting_judge: "Fiala" },
      { query: "svoboda projevu", outcome: ["zamítnuto"] },
      { query: "x", petitioner: ["SKUPINA POSLANCŮ"], contested_act_kind: ["zákon"] },
      { query: "x", contested_organ_type: ["SOUD"] },
    ]) {
      const result = await tools.us_search(args(extra));
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      expect(result.content[0].text).not.toContain("dawmain_probe_sources");
    }
    expect(calls).toEqual([]);
  });
});

describe("paging rides the search's own session", () => {
  it("page 0 then page 1 of the same search: 4 requests, page 1 on page 0's cookie", async () => {
    const tools = await loadTools();
    const first = await tools.us_search(args({ query: "svoboda projevu" }));
    expect(first.content[0].text).toContain("30 decisions:");
    const second = await tools.us_search(args({ query: "svoboda projevu", page: 1 }));
    expect(kinds()).toEqual(["GET Search.aspx", "POST Search.aspx", "GET Results.aspx", "GET Results.aspx?page=1"]);
    expect(calls[3].cookie).toBe("ASP.NET_SessionId=s0");
    expect(calls[2].cookie).toBe("ASP.NET_SessionId=s0");
    const text = second.content[0].text;
    expect(text).toContain("21. usnesení sp. zn. I. ÚS 1020/26 ze dne 1. 1. 2026 — sz 1-1020-26_1 · zpravodaj Zpravodaj 1020");
    expect(text).toContain("30. usnesení sp. zn. I. ÚS 1029/26");
    expect(text).toContain("Last page.");
    expect(first.content[0].text).toContain("More: page 1.");
  });

  it("a session NALUS forgot (Results answers a redirect) falls back to the full dance", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ query: "svoboda projevu" }));
    expired.add("s0");
    const second = await tools.us_search(args({ query: "svoboda projevu", page: 1 }));
    expect(kinds()).toEqual([
      "GET Search.aspx",
      "POST Search.aspx",
      "GET Results.aspx",
      "GET Results.aspx?page=1",
      "GET Search.aspx",
      "POST Search.aspx",
      "GET Results.aspx?page=1",
    ]);
    expect(calls[6].cookie).toContain("s1");
    expect(second.content[0].text).toContain("21. usnesení sp. zn. I. ÚS 1020/26");
  });

  it("a kept session whose banner total changed is not trusted", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ query: "svoboda projevu" }));
    bannerOverride = 31;
    await tools.us_search(args({ query: "svoboda projevu", page: 1 }));
    expect(kinds().slice(3)).toEqual(["GET Results.aspx?page=1", "GET Search.aspx", "POST Search.aspx", "GET Results.aspx?page=1"]);
  });

  it("a kept session serving another page's rows (same total, hits present) is not trusted", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ query: "svoboda projevu" }));
    ignorePageOnce = true;
    const second = await tools.us_search(args({ query: "svoboda projevu", page: 1 }));
    expect(kinds().slice(3)).toEqual(["GET Results.aspx?page=1", "GET Search.aspx", "POST Search.aspx", "GET Results.aspx?page=1"]);
    expect(second.content[0].text).toContain("21. usnesení sp. zn. I. ÚS 1020/26");
    expect(second.content[0].text).not.toContain("1. usnesení sp. zn. I. ÚS 1000/26");
  });

  it("different criteria never share a session", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ query: "alfa" }));
    await tools.us_search(args({ query: "beta", page: 1 }));
    expect(kinds()).toEqual([
      "GET Search.aspx",
      "POST Search.aspx",
      "GET Results.aspx",
      "GET Search.aspx",
      "POST Search.aspx",
      "GET Results.aspx?page=1",
    ]);
    expect(calls[5].cookie).not.toBe(calls[2].cookie);
  });
});

describe("multi-variant paging", () => {
  beforeEach(() => {
    catalog = {
      "alfa beta": { base: 1000, total: 150 },
      "gama delta": { base: 2000, total: 150 },
      "epsilon zeta": { base: 3000, total: 150 },
      nula: { base: 0, total: 0 },
      malo: { base: 4000, total: 15 },
    };
  });

  /** The page the old 3×20-row reading produced, from the scripted rankings. */
  const expectedPage = (names: string[], page: number) => {
    const lists = names.map((name) => {
      const { base, total } = catalog[name];
      return Array.from({ length: Math.min(total, (page + 1) * 20) }, (_, k) => `1-${base + k}-26_1`);
    });
    return interleave(lists, (sz) => sz).slice(page * 20, page * 20 + 20);
  };

  it("page 2 of 3 variants costs 9 requests (was 27), page 3 next costs none — same hits as the 20-row pages", async () => {
    const tools = await loadTools();
    const queries = ["alfa beta", "gama delta", "epsilon zeta"];
    const page2 = await tools.us_search(args({ queries, page: 2 }));
    expect(calls).toHaveLength(9);
    expect(calls.filter((call) => call.method === "POST").every((call) => call.body?.get("ctl00$MainContent$resultsPageSize") === "80")).toBe(true);
    const items = (page2.structuredContent?.items as Array<{ sz: string }>).map((hit) => hit.sz);
    expect(items).toEqual(expectedPage(queries, 2));

    const page3 = await tools.us_search(args({ queries, page: 3 }));
    expect(calls).toHaveLength(9);
    expect((page3.structuredContent?.items as Array<{ sz: string }>).map((hit) => hit.sz)).toEqual(expectedPage(queries, 3));
  });

  it("deep pages read their 80-row pages all at once", async () => {
    const tools = await loadTools();
    let inFlight = 0;
    let peak = 0;
    onRequest = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    };
    const page5 = await tools.us_search(args({ queries: ["alfa beta", "gama delta"], page: 5 }));
    // 120 rows per variant = two 80-row pages each, all four dances in parallel.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(4);
    expect(peak).toBe(4);
    expect((page5.structuredContent?.items as Array<{ sz: string }>).map((hit) => hit.sz)).toEqual(
      expectedPage(["alfa beta", "gama delta"], 5),
    );
  });

  it("a zero-hit variant costs 2 requests once, then nothing; a 15-hit one is not re-read for page 1", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ queries: ["alfa beta", "nula", "malo"] }));
    expect(calls).toHaveLength(3 + 2 + 3);
    const page1 = await tools.us_search(args({ queries: ["alfa beta", "nula", "malo"], page: 1 }));
    // Only "alfa beta" is read again (40 rows); "nula" and "malo" are known.
    const fresh = calls.slice(8);
    expect(fresh).toHaveLength(3);
    expect(fresh[1].body?.get("ctl00$MainContent$text")).toBe("alfa beta");
    expect(page1.content[0].text).toContain('Variants: "alfa beta" 150 · "nula" 0 · "malo" 15');
  });

  it("a page past the merged end says so and names the last page", async () => {
    catalog = { aa: { base: 1000, total: 5 }, bb: { base: 2000, total: 5 } };
    const tools = await loadTools();
    const result = await tools.us_search(args({ queries: ["aa", "bb"], page: 1 }));
    const text = result.content[0].text;
    expect(text).toContain("Page 1 is past the end — the merged variants hold 10 decisions, on page 0. Ask for page 0 or earlier.");
    expect(text).not.toContain("Full text:");
  });
});

describe("past the end, single search", () => {
  it("a banner with no rows is not presented as an empty list", async () => {
    catalog = { "svoboda projevu": { base: 1000, total: 11 } };
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "svoboda projevu", page: 1 }));
    expect(result.content[0].text).toBe("Page 1 is past the end — 11 decisions, on page 0. Ask for page 0 or earlier.");
  });
});

describe("one cache entry per effective search", () => {
  it("caselaw_search's ÚS lane, then us_search sort=relevance on the same query: no new request", async () => {
    const { searchNalus } = await import("@/src/sources/nalus");
    await searchNalus({ query: "svoboda projevu", dateFrom: undefined, dateTo: undefined, sort: "relevance" }, 0, 20);
    expect(calls).toHaveLength(3);
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "svoboda projevu ", sort: "relevance" }));
    expect(calls).toHaveLength(3);
    expect(result.content[0].text).toContain("30 decisions:");
  });

  it("'§' never reaches NALUS's full-text field", async () => {
    const tools = await loadTools();
    await tools.us_search(args({ query: "náhrada nemajetkové újmy § 2958" }));
    expect(calls[1].body?.get("ctl00$MainContent$text")).toBe("náhrada nemajetkové újmy 2958");
  });

  it("variants that differ only in '§' are one search, not two", async () => {
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "§ 2958 újma", queries: ["2958 újma"] }));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(result.content[0].text).toContain("30 decisions:");
  });
});

describe("the 60 s route limit", () => {
  it("a NALUS that eats the search budget ends in a named timeout, not a killed call", async () => {
    // The form GET "takes" 44 s: the POST has under 2 s left and is never sent.
    onRequest = (call) => {
      if (call.method === "GET" && call.url.pathname.endsWith("/Search.aspx")) clockOffset += 44_000;
    };
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "svoboda projevu" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/time budget \(timed out\)/);
    expect(kinds()).toEqual(["GET Search.aspx"]);
  });

  it("each request is cut to the time left, and no retry starts that cannot finish", async () => {
    const { searchNalus } = await import("@/src/sources/nalus");
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (raw: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url: new URL(raw), cookie: "", body: null });
      signal = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const started = Date.now();
    await expect(searchNalus({ query: "pomalé" }, 0, 20, { deadlineAt: Date.now() + 2_300 })).rejects.toMatchObject({
      kind: "UPSTREAM_UNREACHABLE",
    });
    expect(Date.now() - started).toBeLessThan(2_000 + 2_300);
    expect(signal?.aborted).toBe(true);
    // One attempt: a retry (attempt + back-off + attempt) would not have fit.
    expect(calls).toHaveLength(1);
  });

  it("read_top previews are skipped, not started, once the call is nearly over", async () => {
    onRequest = (call) => {
      if (call.url.pathname.endsWith("/Results.aspx")) clockOffset += 53_500;
    };
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "svoboda projevu", read_top: 2 }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("read_top previews skipped");
    expect(calls.some((call) => call.url.pathname.endsWith("/GetText.aspx"))).toBe(false);
  });
});

describe("read_top", () => {
  it("with a query: excerpts around it", async () => {
    const tools = await loadTools();
    const result = await tools.us_search(args({ query: "svobodě projevu", read_top: 1 }));
    expect(result.content[0].text).toContain("— PREVIEW I.ÚS 1000/26 #1");
  });

  it("without a query: the právní věta, never 'the query terms do not occur'", async () => {
    const tools = await loadTools();
    const result = await tools.us_search(args({ case_number: "I. ÚS 1000/26", read_top: 1 }));
    const text = result.content[0].text;
    expect(text).toContain("— PRÁVNÍ VĚTA I.ÚS 1000/26 #1 (no query to excerpt around):\nPrávní věta k věci.");
    expect(text).not.toContain("query terms do not occur");
  });
});

describe("a GetAbstract that does not answer", () => {
  beforeEach(() => {
    onRequest = (call) => {
      if (call.url.pathname.endsWith("/GetAbstract.aspx")) throw new TypeError("fetch failed");
    };
  });

  it("is no 'NALUS has neither a právní věta nor an abstrakt' preview", async () => {
    const tools = await loadTools();
    const result = await tools.us_search(args({ case_number: "I. ÚS 1000/26", read_top: 1 }));
    expect(result.content[0].text).not.toContain("NO PREVIEW");
    expect(result.content[0].text).not.toContain("neither a právní věta");
  });

  it("is said in us_get_decision, and the decision is not cached without its právní věta", async () => {
    const tools = await loadTools();
    const first = await tools.us_get_decision({ sz: "1-1169-26_1", page: 1 });
    expect(first.content[0].text).toContain("could not be loaded");
    expect(first.content[0].text).toContain("Stížnost se odmítá.");
    onRequest = () => undefined;
    const second = await tools.us_get_decision({ sz: "1-1169-26_1", page: 1 });
    expect(second.content[0].text).toContain("Právní věta:\n> Právní věta k věci.");
    expect(calls.filter((call) => call.url.pathname.endsWith("/GetText.aspx"))).toHaveLength(2);
  });
});

describe("us_get_decision", () => {
  it("prints the ECLI, no placeholder právní věta, and a text without RTF residue", async () => {
    const tools = await loadTools();
    const result = await tools.us_get_decision({ sz: "1-1169-26_1", page: 1 });
    const text = result.content[0].text;
    expect(text).toContain("ECLI:CZ:US:2026:1.US.1169.26.1");
    expect(text).toContain("Právní věta:\n> Právní věta k věci.");
    expect(text).not.toContain("Abstrakt");
    expect(text).toContain("takto:\nStížnost se odmítá.");
  });
});
