import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIRROR_TOOLS } from "@/src/mcp/tools/mirror-route";
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

describe("per-account switch (Správa: features.mirror)", () => {
  it("only an account with features.mirror === true reads the mirror; banned, others and Clerk failures stay live", async () => {
    const { __setAccessLoaderForTests, buildAccess } = await import("@/src/files/access");
    const { caselawBackend } = await import("@/src/mcp/backend");
    const meta: Record<string, unknown> = {
      user_on: { features: { mirror: true } },
      user_str: { features: { mirror: "true" } },
      user_off: {},
    };
    __setAccessLoaderForTests(async (id) => {
      if (id === "user_down") throw new Error("clerk down");
      return buildAccess({ id, banned: id === "user_banned", publicMetadata: meta[id] ?? { features: { mirror: true } } });
    });
    try {
      expect(await caselawBackend("user_on")).toBe("mirror");
      expect(await caselawBackend("user_str")).toBe("live");
      expect(await caselawBackend("user_off")).toBe("live");
      expect(await caselawBackend("user_banned")).toBe("live");
      expect(await caselawBackend("user_down")).toBe("live");
      expect(await caselawBackend(null)).toBe("live");
    } finally {
      __setAccessLoaderForTests(null);
    }
  });
});
