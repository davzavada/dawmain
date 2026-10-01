import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcedurePaperwork, registerEurlex } from "@/src/mcp/tools/eurlex";
import { allSourceResults } from "@/src/sources/shared/health";

/**
 * What the eurlex_* tools put in their TEXT — the only half a client reads —
 * driven through the registered handlers with Cellar's HTTP answers mocked.
 * Each test searches its own terms: the caches are module-scope and keyed on
 * the SPARQL built.
 */

type Result = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function handlerOf(name: string): Handler {
  const handlers: Record<string, Handler> = {};
  registerEurlex({
    registerTool(toolName: string, _config: unknown, handler: Handler) {
      handlers[toolName] = handler;
    },
  } as never);
  return handlers[name];
}

const search = (args: Record<string, unknown>) =>
  handlerOf("eurlex_search")({ language: "en", limit: 10, offset: 0, ...args });

const AUTH = "http://publications.europa.eu/resource/authority";
const row = (celex: string, extra: Record<string, string> = {}) => ({
  celex: { value: celex },
  d: { value: extra.date ?? "2024-12-19" },
  t: { value: extra.title ?? `Title of ${celex}` },
  ty: { value: `${AUTH}/resource-type/${extra.type ?? "REG_IMPL"}` },
  ...(extra.ecli ? { e: { value: extra.ecli } } : {}),
});
const sparqlJson = (bindings: unknown[]) =>
  new Response(JSON.stringify({ results: { bindings } }), {
    status: 200,
    headers: { "content-type": "application/sparql-results+json" },
  });

/** fetch stub for the SPARQL endpoint; records each query sent. */
function stubSparql(answer: (query: string, n: number) => Response | Promise<Response>): string[] {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const query = new URLSearchParams(String(init.body)).get("query") ?? "";
    queries.push(query);
    return answer(query, queries.length);
  });
  return queries;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("eurlex_search — paging in the text", () => {
  it("shows the page and the offset that continues it when Cellar has more", async () => {
    const queries = stubSparql(() => sparqlJson(Array.from({ length: 11 }, (_, i) => row(`3202${i}R0001`))));
    const result = await search({ query: "paging more alpha" });
    const text = result.content[0].text;
    expect(queries[0]).toContain("LIMIT 11 OFFSET 0");
    expect(text).toContain("10. 32029R0001");
    // The extra row only signals more; it is the next page's first hit.
    expect(text).not.toContain("320210R0001");
    expect(text).toContain("More: offset: 10 (same arguments).");
    expect(result.structuredContent).toMatchObject({ count: 10, has_more: true });
  });

  it("says nothing more on the last page", async () => {
    stubSparql(() => sparqlJson(Array.from({ length: 10 }, (_, i) => row(`3203${i}R0001`))));
    const result = await search({ query: "paging last beta" });
    expect(result.content[0].text).not.toContain("More:");
    expect(result.structuredContent).toMatchObject({ has_more: false });
  });

  it("numbers a later page from its offset", async () => {
    const queries = stubSparql(() => sparqlJson([row("32024R0001"), row("32024R0002")]));
    const text = (await search({ query: "paging offset gamma", offset: 20 })).content[0].text;
    expect(queries[0]).toContain("LIMIT 11 OFFSET 20");
    expect(text).toMatch(/^21\. 32024R0001/);
  });

  it("tells a page past the end from a query that found nothing", async () => {
    stubSparql(() => sparqlJson([]));
    const past = (await search({ query: "paging past delta", offset: 30 })).content[0].text;
    expect(past).toContain("No more EUR-Lex documents: the matches end before offset 30");
    expect(past).not.toContain("TITLES only");
    const none = (await search({ query: "paging none delta" })).content[0].text;
    expect(none).toContain("TITLES only");
  });

  it("lists a judgment next to its abstract, the judgment first", async () => {
    const ecli = "ECLI:EU:C:2026:600";
    // As the grouped query orders them (ORDER BY DESC(?d) ?celex).
    stubSparql(() =>
      sparqlJson([
        row("62024CJ0474", { ecli, type: "JUDG", date: "2026-07-14" }),
        row("62024CJ0474_RES", { ecli, type: "ABSTRACT_JUR", date: "2026-07-14" }),
      ]),
    );
    const text = (await search({ query: "Datenschutzbehörde" })).content[0].text;
    expect(text).toContain("1. 62024CJ0474 [JUDG] 2026-07-14");
    expect(text).toContain("2. 62024CJ0474_RES [ABSTRACT_JUR]");
  });

  it("answers an identifier lookup with an identifier hint, not the title one", async () => {
    stubSparql(() => sparqlJson([]));
    const text = (await search({ celex: "CELEX:39999R9999", language: "cs" })).content[0].text;
    expect(text).toContain("No EUR-Lex document has this CELEX");
    expect(text).not.toContain("TITLES only");
  });

  it("finds 'Regulation 2016/679' by its number", async () => {
    const queries = stubSparql(() => sparqlJson([row("62023CJ0209", { type: "JUDG" })]));
    await search({ query: "Regulation 2016/679" });
    expect(queries[0]).toContain(`?title bif:contains "'Regulation' AND '2016' AND '679'"`);
  });
});

describe("eurlex_search — input and endpoint errors", () => {
  it("refuses an impossible date without asking Cellar", async () => {
    const queries = stubSparql(() => sparqlJson([]));
    const result = await search({ query: "data protection", date_from: "2024-02-30" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('date_from "2024-02-30" is not a real calendar date');
    expect(queries).toEqual([]);
  });

  it("refuses an unknown language instead of searching English titles", async () => {
    const queries = stubSparql(() => sparqlJson([]));
    const result = await search({ query: "ochrana údajů", language: "xx" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not an EU language code");
    expect(queries).toEqual([]);
  });

  it("does not send a timed-out query again, and asks for a narrower one", async () => {
    const queries = stubSparql(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await search({ query: "timeout epsilon" });
    expect(queries).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cellar SPARQL did not answer within");
    expect(result.content[0].text).toContain("Simplify the keywords or narrow the date range");
    expect(result.content[0].text).not.toContain("Try again in a minute");
  });

  it("reads a Virtuoso HTTP 500 body: a refused query is the caller's, never resent, not an outage", async () => {
    const queries = stubSparql(
      () => new Response("Virtuoso 22023 Error FT370: Wildcard word needs at least 4 leading characters", { status: 500 }),
    );
    const result = await search({ query: "refused zeta" });
    expect(queries).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cellar SPARQL refused the query: FT370");
    expect(result.content[0].text).toContain("protect*");
    expect(result.content[0].text).not.toContain("overloaded or down");
    expect(allSourceResults().find((h) => h.source === "EUR-Lex (Cellar)")).toMatchObject({ ok: true });
  });

  it("gives a run-time-limit 500 the narrowing hint without resending it", async () => {
    const queries = stubSparql(
      () => new Response("Virtuoso S1T00 Error SR171: Transaction timed out", { status: 500 }),
    );
    const result = await search({ query: "slow iota" });
    expect(queries).toHaveLength(1);
    expect(result.content[0].text).toContain("runs too long");
    expect(result.content[0].text).toContain("Simplify the keywords");
  });

  it("retries a bare Virtuoso 500 (a store-side failure) once", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queries = stubSparql((_q, n) =>
      n === 1 ? new Response("Virtuoso 40001 Error SR172: Transaction deadlocked", { status: 500 }) : sparqlJson([row("32024R0007")]),
    );
    const result = await search({ query: "deadlock kappa" });
    expect(queries).toHaveLength(2);
    expect(result.content[0].text).toContain("1. 32024R0007");
  });

  it("reports a bare 500 that persists as the endpoint's failure, after one retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queries = stubSparql(() => new Response("Internal Server Error", { status: 500 }));
    const result = await search({ query: "down lambda" });
    expect(queries).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cellar SPARQL answered HTTP 500.");
    expect(allSourceResults().find((h) => h.source === "EUR-Lex (Cellar)")).toMatchObject({ ok: false, detail: "HTTP 500" });
  });

  it("names a refused query read from the body as the caller's", async () => {
    stubSparql(() => new Response("Virtuoso 37000 Error XM029: Free-text expression, syntax error", { status: 200 }));
    const result = await search({ query: "refused eta" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cellar SPARQL refused the query: XM029");
    expect(result.content[0].text).toContain("protect*");
  });

  it("retries a passing 503 once", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queries = stubSparql((_query, n) => (n === 1 ? new Response("busy", { status: 503 }) : sparqlJson([row("32024R0003")])));
    const result = await search({ query: "retry theta" });
    expect(queries).toHaveLength(2);
    expect(result.content[0].text).toContain("1. 32024R0003");
  });
});

describe("eurlex_get_document", () => {
  const LONG = `<html><body><p>${"Article 1 Subject-matter and objectives. ".repeat(20)}</p></body></html>`;
  const getDocument = (args: Record<string, unknown>) =>
    handlerOf("eurlex_get_document")({ language: "en", page: 1, ...args });

  it("strips the CELEX: prefix, and says when the text is the English fallback", async () => {
    const calls: Array<{ url: string; lang: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const lang = (init.headers as Record<string, string>)["accept-language"];
      calls.push({ url, lang });
      return lang === "ces" ? new Response("not found", { status: 404 }) : new Response(LONG, { status: 200 });
    });
    const result = await getDocument({ celex: "CELEX:39999r0001", language: "cs" });
    const text = result.content[0].text;
    expect(calls[0].url).toBe("https://publications.europa.eu/resource/celex/39999R0001");
    expect(text).toMatch(/^https:\/\/eur-lex\.europa\.eu\/legal-content\/EN\/TXT\/\?uri=CELEX:39999R0001\n/);
    expect(text).toContain("this is the English version");
    expect(result.structuredContent).toMatchObject({ language: "en" });

    // The next page is served from cache — neither language asked again.
    await getDocument({ celex: "39999R0001", language: "cs", page: 1 });
    expect(calls.map((call) => call.lang)).toEqual(["ces", "eng"]);
  });

  it("does not start the ECLI path once the CELEX path spent the call's budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      // Each CELEX request takes 24 of the call's 50 s and finds nothing.
      vi.setSystemTime(Date.now() + 24_000);
      return new Response("not found", { status: 404 });
    });
    try {
      const result = await getDocument({ celex: "39999R0003", ecli: "ECLI:EU:C:2099:1", language: "cs" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("time budget ran out");
      expect(calls.some((url) => url.includes("/ecli/"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries no note when the requested language served", async () => {
    vi.stubGlobal("fetch", async () => new Response(LONG, { status: 200 }));
    const text = (await getDocument({ celex: "39999R0002" })).content[0].text;
    expect(text).not.toContain("English version");
  });
});

describe("eurlex_get_history — procedure paperwork", () => {
  it("hides Council/EP agendas like the other paperwork, and keeps the draft report", async () => {
    const dossier = {
      dossier: { value: "http://publications.europa.eu/resource/cellar/ai-act" },
      procedure: { value: "2021/0106/COD" },
    };
    const member = (id: string, type: string, title?: string) => ({
      ...dossier,
      member: { value: `http://publications.europa.eu/resource/cellar/${id}` },
      date: { value: "2022-12-02" },
      type: { value: `${AUTH}/resource-type/${type}` },
      ...(title ? { title: { value: title } } : {}),
    });
    stubSparql(() =>
      sparqlJson([
        member("m1", "AGENDA_DRAFT_CONSIL", "COUNCIL OF THE EUROPEAN UNION (Transport, Telecommunications and Energy)"),
        member("m2", "PLENARY_AGENDA_EP"),
        member("m3", "REPORT_DRAFT_EP_CMT", "DRAFT REPORT on the proposal"),
        member("m4", "PROP_REG", "Proposal for a Regulation laying down harmonised rules on artificial intelligence"),
      ]),
    );
    const history = handlerOf("eurlex_get_history");
    const text = (await history({ procedure: "2021/0106(COD)", language: "en", all: false })).content[0].text;
    expect(text).not.toContain("AGENDA_DRAFT_CONSIL");
    expect(text).not.toContain("PLENARY_AGENDA_EP");
    expect(text).toContain("[REPORT_DRAFT_EP_CMT]");
    expect(text).toContain("[PROP_REG]");
    expect(text).toContain("(+2 procedure paperwork — Council/EP agendas and agenda items");

    const all = (await history({ procedure: "2021/0106(COD)", language: "en", all: true })).content[0].text;
    expect(all).toContain("[AGENDA_DRAFT_CONSIL]");
    expect(all).toContain("[PLENARY_AGENDA_EP]");
  });

  it("classifies the agenda types as paperwork and the substantive materials as not", () => {
    for (const type of ["AGENDA_DRAFT_CONSIL", "PLENARY_AGENDA_EP", "ITEM_IA_NOTE", "NOTE_COVER"]) {
      expect(isProcedurePaperwork(type), type).toBe(true);
    }
    for (const type of ["REPORT_DRAFT_EP_CMT", "REPORT_EP", "OPIN_EP_CMT", "PLENARY_MINUTES_EP", "AGREE_PROV", "RES_LEGIS", "PROP_REG"]) {
      expect(isProcedurePaperwork(type), type).toBe(false);
    }
  });
});
