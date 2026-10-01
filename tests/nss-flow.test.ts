import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The NSS search and reading flows against a scripted fetch: which requests
 * go upstream, in what order, with which timeout — and what the tools print.
 * Every test loads fresh modules, so the module-scope session and caches
 * start cold.
 */

const FORM_HTML = readFileSync(path.join(__dirname, "fixtures", "nss-search-form.html"), "utf8");
/** The live pagination script (a soudsenat + case-number search). */
const LIVE_SCRIPT = /var moreRowsUrl[\s\S]*?var currSort = '[^']*';/.exec(FORM_HTML)![0];
const MISSING_PAGE = readFileSync(path.join(__dirname, "fixtures", "nss-missing-document.html"), "utf8");

const citation = (n: number) =>
  `rozsudek Nejvyššího správního soudu ze dne 10. 6. 2026, čj. ${n} As ${n}/2026&#160;-&#160;30`;
const row = (index: number, id: string, cite = citation(index + 1)) =>
  `<tbody><tr><td><input type="hidden" name="ZobrazeneVysledky[${index}].ID" value="${id}" /></td>` +
  `<td>10.06.2026</td><td><a title="Citace: ${cite}" href="/DokumentDetail/Index/${id}">x</a></td></tr></tbody>`;
const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => row(from + i, String(900000 + from + i))).join("\n");
/** A page-1 answer of POST /Home/Index. */
const resultsPage = (total: number, body: string) =>
  `<html><body><h6>Počet nalezených záznamů: ${total}</h6><table>${body}</table>` +
  `<script type="text/javascript">${LIVE_SCRIPT}</script></body></html>`;

interface Call {
  method: string;
  path: string;
  body: string;
  cookie?: string;
  timeoutMs?: number;
}

let calls: Call[];
let lastTimeout: number | undefined;
let sessions: number;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);

const count = (method: string, pathname: string) =>
  calls.filter((call) => call.method === method && call.path === pathname).length;

/** GET / answers the live form with a numbered session cookie (unless `landing` says otherwise); the rest goes to `handler`. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>, landing?: () => Response | undefined) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      path: new URL(url).pathname,
      body: typeof init.body === "string" ? init.body : "",
      cookie: headers.cookie,
      timeoutMs: lastTimeout,
    };
    calls.push(call);
    if (call.method === "GET" && call.path === "/") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return landing?.() ?? new Response(FORM_HTML, { headers: { "set-cookie": `sid=${++sessions}; path=/` } });
    }
    return handler(call);
  });
}

const loadSource = () => import("@/src/sources/nss");

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
  sessions = 0;
  lastTimeout = undefined;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    lastTimeout = ms;
    return realTimeout(ms);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchNss — handshake", () => {
  it("concurrent cold searches share one handshake", async () => {
    stubFetch(() => new Response(resultsPage(1, rows(0, 1))));
    const { searchNss } = await loadSource();
    await Promise.all(["a", "b", "c"].map((query) => searchNss({ query, court: "nss" }, 1)));
    expect(count("GET", "/")).toBe(1);
    expect(count("POST", "/Home/Index")).toBe(3);
  });

  it("a failed handshake fails its waiters together and is not kept", async () => {
    let broken = true;
    stubFetch(
      () => new Response(resultsPage(1, rows(0, 1))),
      () => (broken ? new Response("<html><body>Údržba</body></html>") : undefined),
    );
    const { searchNss } = await loadSource();
    const kinds = await Promise.all(["a", "b"].map((query) => kindOf(searchNss({ query }, 1))));
    expect(kinds).toEqual(["PARSE_DRIFT", "PARSE_DRIFT"]);
    expect(count("GET", "/")).toBe(1);
    broken = false;
    expect((await searchNss({ query: "a" }, 1)).total).toBe(1);
    expect(count("GET", "/")).toBe(2);
  });

  it("a blank form seen by two searches costs ONE re-handshake, and both then answer", async () => {
    stubFetch((call) =>
      call.cookie?.includes("sid=1")
        ? new Response(`<html><form><input name="__RequestVerificationToken" value="t"/></form></html>`)
        : new Response(resultsPage(2, rows(0, 2))),
    );
    const { searchNss } = await loadSource();
    const [a, b] = await Promise.all([searchNss({ query: "a" }, 1), searchNss({ query: "b" }, 1)]);
    expect(a.total).toBe(2);
    expect(b.total).toBe(2);
    expect(count("GET", "/")).toBe(2);
    expect(count("POST", "/Home/Index")).toBe(4);
  });

  it("an HTTP 400/403 from the search gets the same single re-handshake, then fails loudly and uncached", async () => {
    stubFetch(() => new Response("<html><body>Forbidden</body></html>", { status: 403 }));
    const { searchNss } = await loadSource();
    const error = await searchNss({ query: "a" }, 1).catch((caught: unknown) => caught);
    expect((error as { kind: string }).kind).toBe("UPSTREAM_ERROR");
    expect((error as Error).message).toContain("HTTP 403");
    expect(count("GET", "/")).toBe(2);
    expect(count("POST", "/Home/Index")).toBe(2);
    // Not cached: the next call asks again (with its own single retry).
    await searchNss({ query: "a" }, 1).catch(() => {});
    expect(count("POST", "/Home/Index")).toBe(4);
    expect(count("GET", "/")).toBe(3);
  });

  it("recovers when the re-handshake answers a stale-session 400", async () => {
    stubFetch((call) =>
      call.cookie?.includes("sid=1") ? new Response("", { status: 400 }) : new Response(resultsPage(1, rows(0, 1))),
    );
    const { searchNss } = await loadSource();
    expect((await searchNss({ query: "a" }, 1)).total).toBe(1);
  });
});

describe("searchNss — what is not a results page", () => {
  it("a 200 page with no count, no rows and no form is drift, not 'no matches'", async () => {
    stubFetch(() => new Response("<html><body><h1>Chyba</h1></body></html>"));
    const { searchNss } = await loadSource();
    expect(await kindOf(searchNss({ query: "a" }, 1))).toBe("PARSE_DRIFT");
    await searchNss({ query: "a" }, 1).catch(() => {});
    expect(count("POST", "/Home/Index")).toBe(2); // not cached
  });

  it("a count without readable rows is drift", async () => {
    stubFetch(() => new Response(resultsPage(12, "<tbody><tr><td>nic</td></tr></tbody>")));
    const { searchNss } = await loadSource();
    expect(await kindOf(searchNss({ query: "a" }, 1))).toBe("PARSE_DRIFT");
  });

  it("a genuine zero result stays a zero result", async () => {
    stubFetch(() => new Response(resultsPage(0, "")));
    const { searchNss } = await loadSource();
    const result = await searchNss({ query: "xqzvwkjhplm" }, 1);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it("an impossible date is refused before any request", async () => {
    stubFetch(() => new Response(resultsPage(1, rows(0, 1))));
    const { searchNss } = await loadSource();
    expect(await kindOf(searchNss({ query: "a", dateFrom: "2026-02-30" }, 1))).toBe("INPUT_INVALID");
    expect(await kindOf(searchNss({ query: "a", publishedTo: "2026-04-31" }, 2))).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("a query of nothing but '§' is no criterion", async () => {
    stubFetch(() => new Response(resultsPage(1, rows(0, 1))));
    const { searchNss } = await loadSource();
    expect(await kindOf(searchNss({ query: " § " }, 1))).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("searchNss — paging", () => {
  const fragmentFor = (call: Call) => {
    const pageNum = Number(new URLSearchParams(call.body).get("pageNum"));
    return new Response(rows(40 + (pageNum - 1) * 20, 20));
  };
  const handler = (total: number) => (call: Call) =>
    call.path === "/Home/Index" ? new Response(resultsPage(total, rows(0, 40))) : fragmentFor(call);

  it("page 2 after page 1 costs one row fragment, not the full-text search again", async () => {
    stubFetch(handler(1939));
    const { searchNss } = await loadSource();
    await searchNss({ query: '"dobré mravy"', court: "nss" }, 1);
    const second = await searchNss({ query: '"dobré mravy"', court: "nss" }, 2);
    expect(count("GET", "/")).toBe(1);
    expect(count("POST", "/Home/Index")).toBe(1);
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(1);
    // A cached page 1 leaves the fragment the full 25 s the Index POST gets.
    const fragment = calls.find((call) => call.path === "/Home/MyResTRowsCont")!;
    expect(fragment.timeoutMs).toBe(25_000);
    // The posted conditions are the JSON the page carried, codebook titles included.
    const posted = new URLSearchParams(fragment.body);
    expect(posted.get("pageNum")).toBe("1");
    const conditions = JSON.parse(posted.get("vyhledavaciPodminky")!) as unknown[];
    expect(conditions.length).toBeGreaterThan(0);
    expect(posted.get("vyhledavaciPodminky")).toContain('title:\\"kárné soudy\\"');
    // Fragment rows keep their citation data.
    expect(second.total).toBe(1939);
    expect(second.page).toBe(2);
    expect(second.hits).toHaveLength(20);
    expect(second.hits[0]).toMatchObject({ id: "900040", caseNumber: "41 As 41/2026 - 30", date: "2026-06-10", form: "rozsudek" });
  });

  it("page 2 run cold runs page 1 itself and budgets the fragment against it", async () => {
    stubFetch(handler(1939));
    const { searchNss } = await loadSource();
    const result = await searchNss({ query: "a" }, 2);
    expect(result.hits).toHaveLength(20);
    expect(count("POST", "/Home/Index")).toBe(1);
    const fragment = calls.find((call) => call.path === "/Home/MyResTRowsCont")!;
    expect(fragment.timeoutMs).toBeGreaterThan(24_000);
    expect(fragment.timeoutMs).toBeLessThanOrEqual(25_000);
    // A caller whose page 1 already took 35 s leaves the fragment the floor.
    await searchNss({ query: "a" }, 3, { since: Date.now() - 35_000 });
    expect(calls.filter((call) => call.path === "/Home/MyResTRowsCont")[1].timeoutMs).toBe(10_000);
    await searchNss({ query: "a" }, 4, { since: Date.now() - 20_000 });
    const budgeted = calls.filter((call) => call.path === "/Home/MyResTRowsCont")[2].timeoutMs!;
    expect(budgeted).toBeGreaterThan(19_900);
    expect(budgeted).toBeLessThanOrEqual(20_000);
  });

  it("a page past the page-1 total asks NSS for nothing", async () => {
    stubFetch(handler(45));
    const { searchNss } = await loadSource();
    const third = await searchNss({ query: "a" }, 3);
    expect(third).toMatchObject({ total: 45, hits: [], page: 3 });
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(0);
  });

  it("an empty fragment below the total is drift, and not cached", async () => {
    stubFetch((call) => (call.path === "/Home/Index" ? new Response(resultsPage(719, rows(0, 40))) : new Response("")));
    const { searchNss } = await loadSource();
    const error = await searchNss({ query: "a", court: "nss" }, 2).catch((caught: unknown) => caught);
    expect((error as { kind: string }).kind).toBe("PARSE_DRIFT");
    expect((error as Error).message).toContain("719");
    await searchNss({ query: "a", court: "nss" }, 2).catch(() => {});
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(2);
    expect(count("POST", "/Home/Index")).toBe(1);
  });

  it("a refused fragment is an upstream error", async () => {
    stubFetch((call) =>
      call.path === "/Home/Index" ? new Response(resultsPage(719, rows(0, 40))) : new Response("nope", { status: 404 }),
    );
    const { searchNss } = await loadSource();
    const error = await searchNss({ query: "a" }, 2).catch((caught: unknown) => caught);
    expect((error as { kind: string }).kind).toBe("UPSTREAM_ERROR");
    expect((error as Error).message).toContain("HTTP 404");
  });

  it("a failed page 1 is not reused by a later page", async () => {
    let refuse = true;
    stubFetch((call) => {
      if (call.path === "/Home/Index") {
        return refuse ? new Response("", { status: 404 }) : new Response(resultsPage(719, rows(0, 40)));
      }
      return fragmentFor(call);
    });
    const { searchNss } = await loadSource();
    expect(await kindOf(searchNss({ query: "a" }, 1))).toBe("UPSTREAM_ERROR");
    refuse = false;
    expect((await searchNss({ query: "a" }, 2)).hits).toHaveLength(20);
    expect(count("POST", "/Home/Index")).toBe(2);
  });
});

// ---------- tools ----------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

async function loadTools(): Promise<Record<string, Handler>> {
  const { registerNss } = await import("@/src/mcp/tools/nss");
  const tools: Record<string, Handler> = {};
  registerNss({
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools[name] = handler;
    },
  } as never);
  return tools;
}

describe("nss_search", () => {
  it("marks a hit whose citation names no court instead of passing it off as NSS", async () => {
    stubFetch(() =>
      new Response(
        resultsPage(2, [row(0, "784720", "rozsudek  ze dne 7. 8. 2026, čj. 1 Ds 1/2026-83"), row(1, "784721")].join("")),
      ),
    );
    const tools = await loadTools();
    const text = (await tools.nss_search({ court: "karne", page: 1, read_top: 0 })).content[0].text;
    expect(text).toContain("1. 1 Ds 1/2026-83 (rozsudek) 2026-08-07 — court not named in the citation");
    expect(text).toMatch(/2\. 2 As 2\/2026 - 30 \(rozsudek\) 2026-06-10 — id 784721/);
  });

  it("past the last page it says where the results end", async () => {
    stubFetch(() => new Response(resultsPage(45, rows(0, 40))));
    const tools = await loadTools();
    const result = await tools.nss_search({ query: "a", page: 3, read_top: 0 });
    expect(result.content[0].text).toBe("No hits on page 3: the 45 decisions end on page 2.");
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(0);
  });

  it("an empty later page under an unstated total does not read as 'no match'", async () => {
    stubFetch((call) =>
      call.path === "/Home/Index"
        ? new Response(resultsPage(0, rows(0, 40)).replace(/<h6>[^<]*<\/h6>/, ""))
        : new Response(""),
    );
    const tools = await loadTools();
    const text = (await tools.nss_search({ query: "a", page: 2, read_top: 0 })).content[0].text;
    expect(text).toBe("No hits on page 2, and NSS stated no total — the results end before it.");
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(1);
  });

  it("a multi-variant zero still says what each variant found", async () => {
    stubFetch(() => new Response(resultsPage(0, "")));
    const tools = await loadTools();
    const text = (await tools.nss_search({ queries: ["dobré mravy", "dobrých mravů"], court: "rozsireny-senat", page: 1, read_top: 0 })).content[0].text;
    expect(text).toBe(
      'No NSS decisions matched. Broaden the query or the date range.\nVariants: "dobré mravy" 0 · "dobrých mravů" 0 (merged round-robin)',
    );
  });

  it("multi-variant page 2 runs each variant's full-text search once", async () => {
    stubFetch((call) => {
      if (call.path === "/Home/MyResTRowsCont") {
        return new Response(rows(40, 20));
      }
      const query = [...new URLSearchParams(call.body).values()].includes("b") ? "b" : "a";
      return new Response(resultsPage(query === "a" ? 100 : 30, rows(query === "a" ? 0 : 500, query === "a" ? 40 : 30)));
    });
    const tools = await loadTools();
    const result = await tools.nss_search({ queries: ["a", "b"], page: 2, read_top: 0 });
    expect(result.isError).toBeUndefined();
    expect(count("GET", "/")).toBe(1);
    expect(count("POST", "/Home/Index")).toBe(2);
    // Variant "b" (30 hits) ends on page 1 — only "a" needs a fragment.
    expect(count("POST", "/Home/MyResTRowsCont")).toBe(1);
    expect(result.content[0].text).toContain('Variants: "a" 100 · "b" 30');
  });
});

// ---------- decisions ----------

const utf16 = (text: string, bom = false) => Buffer.from(`${bom ? "\ufeff" : ""}${text}`, "utf16le");
const DETAIL_HTML = readFileSync(path.join(__dirname, "fixtures", "nss-detail-784744.html"), "utf8");
const DECISION = "ROZSUDEK JMÉNEM REPUBLIKY Nejvyšší správní soud rozhodl … Žalobkyně se kasační stížností domáhá zrušení. " + "Odůvodnění. ".repeat(30);

describe("getNssDecision", () => {
  it.each([false, true])("the UTF-16 N/A page on both renditions is NOT_FOUND (BOM: %s), and not cached", async (bom) => {
    stubFetch((call) => {
      if (call.path.startsWith("/DokumentDetail/")) return new Response("", { status: 404 });
      if (call.path.startsWith("/DokumentOriginal/Text/")) {
        return new Response(utf16(MISSING_PAGE, bom), { headers: { "content-type": "text/html; charset=utf-16" } });
      }
      return new Response(utf16(MISSING_PAGE, bom), { headers: { "content-type": "text/html" } });
    });
    const { getNssDecision } = await loadSource();
    const error = await getNssDecision("999999996").catch((caught: unknown) => caught);
    expect((error as { kind: string }).kind).toBe("NOT_FOUND");
    expect((error as { hint: string }).hint).toContain("re-run nss_search");
    await getNssDecision("999999996").catch(() => {});
    expect(calls.filter((call) => call.path.startsWith("/DokumentOriginal/Html/"))).toHaveLength(2);
  });

  it("Text N/A with a real UTF-16 Html rendition (no charset, no BOM) decodes the Czech text", async () => {
    stubFetch((call) => {
      if (call.path.startsWith("/DokumentDetail/")) return new Response(DETAIL_HTML);
      if (call.path.startsWith("/DokumentOriginal/Text/")) return new Response(utf16(MISSING_PAGE, true));
      return new Response(utf16(`<html><body><p>${DECISION}</p></body></html>`), { headers: { "content-type": "text/html" } });
    });
    const { getNssDecision } = await loadSource();
    const decision = await getNssDecision("784744");
    expect(decision.text).toContain("ROZSUDEK JMÉNEM REPUBLIKY");
    expect(decision.text).toContain("Žalobkyně");
    expect(decision.text).not.toContain("<p>");
    expect(decision.metadata["Spisová značka"]).toBe("1 As 59/2026-106");
  });

  it("a non-ok Text rendition falls back to the Html rendition instead of becoming the text", async () => {
    stubFetch((call) => {
      if (call.path.startsWith("/DokumentDetail/")) return new Response(DETAIL_HTML);
      if (call.path.startsWith("/DokumentOriginal/Text/")) return new Response("<html><body>Not Found</body></html>", { status: 404 });
      return new Response(`<html><body><p>${DECISION}</p></body></html>`, {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    });
    const { getNssDecision } = await loadSource();
    const decision = await getNssDecision("784744");
    expect(decision.text).toContain("Žalobkyně");
    expect(decision.text).not.toContain("Not Found");
  });

  it("a refused Html rendition is an upstream error, not a missing document", async () => {
    stubFetch((call) =>
      call.path.startsWith("/DokumentOriginal/Text/")
        ? new Response(utf16(MISSING_PAGE, true))
        : new Response("", { status: 403 }),
    );
    const { getNssDecision } = await loadSource();
    expect(await kindOf(getNssDecision("784744"))).toBe("UPSTREAM_ERROR");
  });

  it("a failed detail page is flagged, not cached — the retry fetches only the detail", async () => {
    let detailOk = false;
    stubFetch((call) => {
      if (call.path.startsWith("/DokumentDetail/")) {
        return detailOk ? new Response(DETAIL_HTML) : new Response("", { status: 403 });
      }
      return new Response(utf16(DECISION, true), { headers: { "content-type": "text/plain; charset=utf-16" } });
    });
    const { getNssDecision } = await loadSource();
    const first = await getNssDecision("784744");
    expect(first.metadata).toEqual({});
    expect(first.metadataUnavailable).toBe(true);
    expect(first.text).toContain("Žalobkyně");
    detailOk = true;
    const second = await getNssDecision("784744");
    expect(second.metadataUnavailable).toBeUndefined();
    expect(second.metadata.ECLI).toBe("ECLI:CZ:NSS:2026:1.As.59.2026.106");
    expect(calls.filter((call) => call.path.startsWith("/DokumentOriginal/Text/"))).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith("/DokumentDetail/"))).toHaveLength(2);
    // Read once, the metadata is served from the cache with the text.
    await getNssDecision("784744");
    expect(calls).toHaveLength(3);
  });

  it("a definitive 404 detail is an answer, cached as no metadata", async () => {
    stubFetch((call) =>
      call.path.startsWith("/DokumentDetail/")
        ? new Response("", { status: 404 })
        : new Response(utf16(DECISION, true)),
    );
    const { getNssDecision } = await loadSource();
    const first = await getNssDecision("784744");
    expect(first.metadata).toEqual({});
    expect(first.metadataUnavailable).toBeUndefined();
    await getNssDecision("784744");
    expect(calls.filter((call) => call.path.startsWith("/DokumentDetail/"))).toHaveLength(1);
  });

  it("the text accessor does not wait on the detail page, and warms it for the follow-up read", async () => {
    let releaseDetail: (response: Response) => void = () => {};
    stubFetch((call) => {
      if (call.path.startsWith("/DokumentDetail/")) {
        return new Promise<Response>((resolve) => {
          releaseDetail = resolve;
        });
      }
      return new Response(utf16(DECISION, true));
    });
    const { getNssDecision, getNssDecisionText } = await loadSource();
    const text = await getNssDecisionText("784744");
    expect(text).toContain("Žalobkyně");
    releaseDetail(new Response(DETAIL_HTML));
    await new Promise((resolve) => setTimeout(resolve, 20)); // the warm-up lands in the cache
    const decision = await getNssDecision("784744");
    expect(decision.metadata["Spisová značka"]).toBe("1 As 59/2026-106");
    expect(calls).toHaveLength(2); // one Text, one detail — both reused
  });

  it("nss_get_decision says when the metadata is missing for this answer only", async () => {
    stubFetch((call) =>
      call.path.startsWith("/DokumentDetail/")
        ? new Response("", { status: 403 })
        : new Response(utf16(DECISION, true)),
    );
    const tools = await loadTools();
    const text = (await tools.nss_get_decision({ document_id: "784744", page: 1 })).content[0].text;
    expect(text).toMatch(/^\(The NSS metadata page did not answer — ECLI, spisová značka and soud are missing/);
    expect(text).toContain("call nss_get_decision again");
    expect(text).toContain("https://vyhledavac.nssoud.cz/DokumentDetail/Index/784744");
  });
});
