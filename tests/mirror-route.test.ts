import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIRROR_TOOLS } from "@/src/mcp/tools/mirror-route";
import { JUSTICE_COURT_CODES } from "@/src/sources/justice";
import { markedExcerpt, mirrorConfig, resetMirrorBreaker, searchMirror } from "@/src/sources/mirror";

const HIT = {
  source: "ns",
  id: "CD001AB3CD24B0BFC12582390057DA50",
  caseNumber: "7 Tdo 1517/2017",
  court: "Nejvyšší soud",
  form: "usneseni",
  category: "C",
  date: "2017-12-13",
  published: null,
  ecli: null,
  url: "https://rozhodnuti.nsoud.cz/x",
  score: 1,
  excerpt: "o náhradě újmy",
  highlights: [[2, 9]],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("MIRROR_API_URL", "https://mirror.test/");
  vi.stubEnv("MIRROR_API_TOKEN", "t0ken");
  vi.stubEnv("MIRROR_CF_ACCESS_CLIENT_ID", "id");
  vi.stubEnv("MIRROR_CF_ACCESS_CLIENT_SECRET", "secret");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  resetMirrorBreaker();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function textOf(answer: unknown): string {
  expect(answer).not.toHaveProperty("fallback");
  return (answer as { content: Array<{ text: string }> }).content[0].text;
}

describe("mirror client", () => {
  it("needs both URL and token; sends the Access pair only when complete", () => {
    expect(mirrorConfig({ MIRROR_API_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(mirrorConfig({ MIRROR_API_URL: "https://x/", MIRROR_API_TOKEN: "t", MIRROR_CF_ACCESS_CLIENT_ID: "a" } as unknown as NodeJS.ProcessEnv)).toEqual({
      url: "https://x",
      token: "t",
    });
  });

  it("briefExcerpt: one line around the first match, cut at words", async () => {
    const { briefExcerpt } = await import("@/src/mcp/tools/mirror-route");
    expect(briefExcerpt({ excerpt: "o náhradě újmy", highlights: [[2, 9]] })).toBe("o «náhradě» újmy");
    const long = `${"úvodní slova ".repeat(40)}výpověď z nájmu bytu ${"další text ".repeat(40)}`;
    const at = long.indexOf("výpověď");
    const brief = briefExcerpt({ excerpt: long, highlights: [[at, at + 7]] });
    expect(brief.length).toBeLessThanOrEqual(222);
    expect(brief).toContain("«výpověď» z nájmu bytu");
    expect(brief.startsWith("…")).toBe(true);
    expect(brief.endsWith("…")).toBe(true);
  });

  it("marks highlights", () => {
    expect(markedExcerpt({ excerpt: "o náhradě újmy", highlights: [[2, 9]] })).toBe("o «náhradě» újmy");
  });
});

describe("mirror routing", () => {
  it("caselaw_search: one request per court and variant, Access headers on each, ids in the live get_* form", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ queries: ["újma", "náhrada újmy"], per_source_limit: 2, read_top: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://mirror.test/v1/search?")).toBe(true);
    expect(init.headers).toMatchObject({ authorization: "Bearer t0ken", "cf-access-client-id": "id", "cf-access-client-secret": "secret" });
    expect(out).toContain("ns_get_decision unid: CD001AB3CD24B0BFC12582390057DA50");
    expect(out).toContain("«náhradě»");
  });

  it("caselaw_search notes the CJEU instead of dropping it silently; CJEU alone goes live", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [], channel: null, terms: [] }));
    expect(textOf(await MIRROR_TOOLS.caselaw_search({ query: "újma", include_eu: true }))).toContain("sdeu_search");
    expect(await MIRROR_TOOLS.caselaw_search({ query: "újma", sources: ["sdeu"] })).toHaveProperty("fallback");
  });

  it("falls back on what the mirror cannot do, before any request", async () => {
    expect(await MIRROR_TOOLS.ns_search({ query: "x", offset: 20 })).toEqual({ fallback: "the mirror answers the first page only" });
    expect(await MIRROR_TOOLS.nss_search({ query: "x", court: "krajske" })).toHaveProperty("fallback");
    expect(await MIRROR_TOOLS.us_search({ query: "x", judge: "Šimíček" })).toEqual({ fallback: 'the mirror has no "judge" filter' });
    expect(await MIRROR_TOOLS.justice_search({ query: "x", match: "phrase" })).toHaveProperty("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("case_number finds THAT decision (by-case), never the ones citing it", async () => {
    fetchMock.mockImplementation(async () =>
      json({ decisions: [{ source: "ns", id: "BD87C5D0B5398F19C12580FF00256234", caseNumber: "26 Cdo 4249/2016", court: "Nejvyšší soud", form: "rozsudek", date: "2017-01-18" }] }),
    );
    const out = textOf(await MIRROR_TOOLS.ns_search({ case_number: "26 Cdo 4249/2016", limit: 20, offset: 0, read_top: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/by-case");
    expect(url.searchParams.get("case")).toBe("26 Cdo 4249/2016");
    expect(url.searchParams.getAll("source")).toEqual(["ns"]);
    expect(out).toContain("1. 26 Cdo 4249/2016 (rozsudek, 2017-01-18) — Nejvyšší soud → ns_get_decision unid: BD87C5D0B5398F19C12580FF00256234");
  });

  it("an ÚS ecli is looked up the same way; a značka the mirror lacks, or one with other filters, goes to the court", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [{ source: "us", id: "Pl-24-10_1", caseNumber: "Pl. ÚS 24/10", court: null, form: "nalez", date: "2011-03-22" }] }));
    expect(textOf(await MIRROR_TOOLS.us_search({ ecli: "ECLI:CZ:US:2011:Pl.US.24.10.1", page: 0 }))).toContain("us_get_decision sz: Pl-24-10_1");
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe("/v1/by-case");
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ decisions: [] }));
    expect(await MIRROR_TOOLS.nss_search({ case_number: "1 As 113/2012", page: 1 })).toEqual({ fallback: 'the mirror holds no NSS decision with the spisová značka "1 As 113/2012"' });
    fetchMock.mockClear();
    expect(await MIRROR_TOOLS.justice_search({ case_number: "8 Co 60/2025", query: "sazebník", page: 0 })).toEqual({
      fallback: "the mirror looks a spisová značka up on its own, without other filters",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("justice_search: court_codes go to the mirror, with the other filters", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [{ ...HIT, source: "justice", id: "d2965a2d-ec0d-476b-983f-75e716972829", court: "Krajský soud v Brně" }], channel: "and", terms: [] }));
    const out = textOf(
      await MIRROR_TOOLS.justice_search({ query: "sazebník", match: "all_words", court_codes: ["ksbr", "KSBRJI", "KSBR"], date_from: "2025-01-01", date_to: "2025-06-30", page: 0 }),
    );
    expect(out).toContain("justice_get_decision uuid: d2965a2d-ec0d-476b-983f-75e716972829");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const qs = new URL(fetchMock.mock.calls[0][0] as string).searchParams;
    expect(qs.get("court_code")).toBe("KSBR,KSBRJI");
    expect(qs.getAll("source")).toEqual(["justice"]);
    expect(qs.get("q")).toBe("sazebník");
    expect(qs.get("case")).toBeNull();
    expect(qs.get("from")).toBe("2025-01-01");
    expect(qs.get("to")).toBe("2025-06-30");
    // No codes, no parameter.
    await MIRROR_TOOLS.justice_search({ query: "sazebník", court_codes: [] });
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.has("court_code")).toBe(false);
  });

  it("justice_search: an unknown court code answers with the whole list, as live — no request, no fallback", async () => {
    const answer = (await MIRROR_TOOLS.justice_search({ query: "sazebník", court_codes: ["KSBR", "KSBRNO"] })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(answer).not.toHaveProperty("fallback");
    expect(answer.isError).toBe(true);
    expect(answer.content[0].text).toContain('"KSBRNO" is not a justice.cz court code.');
    expect(answer.content[0].text).toContain(`Valid codes: ${JUSTICE_COURT_CODES.join(", ")}.`);
    expect(fetchMock).not.toHaveBeenCalled();
    // Filters the mirror lacks still go live, where the same check runs.
    expect(await MIRROR_TOOLS.justice_search({ query: "x", court_codes: ["KSBR"], applies_act: "89/2012" })).toEqual({ fallback: 'the mirror has no "applies_act" filter' });
  });

  it("schema defaults do not count as filters", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [], channel: null, terms: [] }));
    const answer = await MIRROR_TOOLS.us_search({ query: "x", only_published: false, include_dissents: false, sort: "date", page: 0, read_top: 0 });
    expect(answer).not.toHaveProperty("fallback");
  });

  it("get_decision: joins the pages; a decision the mirror lacks goes live", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/decisions/nss/1")) {
        const page = url.includes("page=2") ? 2 : 1;
        return json({
          source: "nss",
          id: "1",
          caseNumber: "1 As 1/2020",
          caseNumbers: ["1 As 1/2020"],
          court: "Nejvyšší správní soud",
          form: "rozsudek",
          category: null,
          date: "2020-01-01",
          published: null,
          ecli: null,
          legalSentence: null,
          url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/1",
          goneAt: null,
          text: { text: page === 1 ? "první " : "druhá", page, total_pages: 2 },
        });
      }
      return json({ error: "not found" }, 404);
    });
    const out = textOf(await MIRROR_TOOLS.nss_get_decision({ document_id: "1", page: 1 }));
    expect(out).toContain("první druhá");
    expect(await MIRROR_TOOLS.nss_get_decision({ document_id: "2", page: 1 })).toEqual({
      fallback: "the mirror does not hold this decision (yet)",
    });
  });

  it("an Access refusal reads as such and goes live", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>login</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const answer = await MIRROR_TOOLS.ns_search({ query: "x" });
    expect((answer as { fallback: string }).fallback).toContain("Cloudflare Access");
  });
});

describe("breaker", () => {
  it("after a failure the mirror is skipped (no request) until the pause ends", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>login</html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(searchMirror({ q: "x" })).rejects.toThrow("Cloudflare Access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const answer = await MIRROR_TOOLS.ns_search({ query: "x" });
    expect((answer as { fallback: string }).fallback).toContain("paused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("every caller reads the mirror (no per-account switch)", () => {
  async function nsSearch(): Promise<(args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>> {
    const { registerAllTools } = await import("@/src/mcp/tools");
    let handler: ((args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAllTools(
      {
        registerTool(name: string, _config: unknown, h: typeof handler) {
          if (name === "ns_search") handler = h;
        },
      } as never,
      { zotero: false },
    );
    return handler!;
  }

  it("a call with no signed-in user at all is answered from the mirror, not the court", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      expect(String(url)).toContain("mirror.test");
      return json({ total: 1, hits: [HIT] });
    });
    const result = await (await nsSearch())({ query: "náhrada újmy" }, {});
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("Dawmain case-law mirror");
    expect(text).toContain("7 Tdo 1517/2017");
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("mirror.test"))).toBe(true);
  });

  it("without MIRROR_API_URL the live tool answers and the mirror is never asked", async () => {
    vi.stubEnv("MIRROR_API_URL", "");
    fetchMock.mockImplementation(async () => new Response("<html></html>", { status: 200 }));
    await (await nsSearch())({ query: "náhrada újmy" }, {});
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("mirror.test"))).toBe(false);
  });
});
