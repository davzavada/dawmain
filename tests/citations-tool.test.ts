import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCitations, registerCitations } from "@/src/mcp/tools/citations";
import { resetMirrorBreaker, type MirrorCitations } from "@/src/sources/mirror";

const LINKS: MirrorCitations = {
  cites: [
    { key: "sz:4us296-2024", display: "IV. ÚS 296/24", mentions: 2, firstAt: 100, decisions: [{ source: "us", id: "4-296-24_1", caseNumber: "IV. ÚS 296/24", court: "Ústavní soud", form: "nalez", date: "2024-05-02" }] },
    { key: "sz:19c264-2021", display: "19 C 264/2021", mentions: 1, firstAt: 300, decisions: [
      { source: "justice", id: "a", caseNumber: "19 C 264/2021", court: "Okresní soud v Teplicích", form: "rozsudek", date: "2025-04-10" },
      { source: "justice", id: "b", caseNumber: "19 C 264/2021", court: "Okresní soud v Kolíně", form: "rozsudek", date: "2022-01-11" },
    ] },
    { key: "sz:c-311-18", display: "C-311/18", mentions: 1, firstAt: 900, decisions: [] },
  ],
  citedBy: {
    total: 3,
    hits: [
      { source: "ns", id: "AB12", caseNumber: "31 Cdo 1/2024", court: "Nejvyšší soud", form: "rozsudek", date: "2024-03-01", mentions: 4 },
      { source: "justice", id: "u-1", caseNumber: "8 Co 60/2025", court: "Krajský soud v Brně", form: "usneseni", date: "2025-02-02", mentions: 1 },
    ],
  },
};

describe("formatCitations", () => {
  it("cited_by: the total, the page, each hit with its *_get_* call, and the continuation", () => {
    const text = formatCitations(LINKS, { source: "ns", id: "X1", direction: "cited_by", limit: 2, offset: 0 });
    expect(text).toContain("Cited by 3 decisions.");
    expect(text).toContain("1–2 — newest first");
    // The lane's own court goes without saying; an obecný soud is named.
    expect(text).toContain("1. [NS] 31 Cdo 1/2024 (rozsudek, 2024-03-01) → caselaw_get_decision source: ns, id: AB12 · names it 4×");
    expect(text).toContain("2. [JUSTICE] 8 Co 60/2025 (usnesení, 2025-02-02) — Krajský soud v Brně → caselaw_get_decision source: justice, id: u-1");
    expect(text).toContain("More: offset: 2 (same arguments).");
    expect(text).not.toContain("Cites ");
    expect(text).toContain("not proof that nobody cites it");
  });

  it("cites: one line per cited key — the decision, several carrying one značka, or not in the mirror", () => {
    const text = formatCitations(LINKS, { source: "ns", id: "X1", direction: "cites", limit: 20, offset: 0 });
    expect(text).toContain("Cites 3 decisions");
    expect(text).toContain("1. IV. ÚS 296/24 · 2× — [US] IV. ÚS 296/24 (nález, 2024-05-02) → caselaw_get_decision source: us, id: 4-296-24_1");
    expect(text).toContain("2. 19 C 264/2021 — 2 decisions carry this značka:");
    expect(text).toContain("3. C-311/18 — not in the mirror");
    expect(text).not.toContain("Cited by");
  });

  it("cited_by from the current API: counts by court, the binding ones named, the order, and each citing passage", () => {
    const links: MirrorCitations = {
      cites: [],
      citedBy: {
        total: 37,
        bySource: { justice: 32, ns: 4, us: 1 },
        top: 1,
        order: "courts",
        hits: [
          { source: "ns", id: "AB12", caseNumber: "31 Cdo 1/2024", court: "Nejvyšší soud", form: "rozsudek", date: "2024-03-01", mentions: 2, excerpt: "  jak dovodil\nNejvyšší soud v rozsudku sp. zn. 26 Cdo 4848/2016, nezaplacení nájemného  " },
        ],
      },
    };
    const text = formatCitations(links, { source: "ns", id: "X1", direction: "cited_by", limit: 1, offset: 0 });
    expect(text).toContain("Cited by 37 decisions (ÚS 1, NS 4, obecné soudy 32; 1 of them a stanovisko, the plenum of the ÚS, a velký senát of the NS or a rozšířený senát of the NSS).");
    expect(text).toContain("1–1 — stanoviska, plénum and velký / rozšířený senát first");
    expect(text).toContain("   …jak dovodil Nejvyšší soud v rozsudku sp. zn. 26 Cdo 4848/2016, nezaplacení nájemného");
    expect(text).toContain("More: offset: 1 (same arguments).");
  });

  it("says so when nobody cites it, naming the court filter", () => {
    const text = formatCitations({ cites: [], citedBy: { total: 0, hits: [] } }, { source: "us", id: "s", direction: "both", limit: 20, offset: 0, citedBySources: ["us"] });
    expect(text).toContain("Cited by: no mirrored decision from US names it.");
    expect(text).toContain("Cites: no decision recognised in its text.");
  });
});

describe("caselaw_citations", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  let handler: Handler;
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const args = (extra: Record<string, unknown>) => ({ direction: "cited_by", limit: 20, offset: 0, ...extra });

  beforeEach(() => {
    vi.stubEnv("MIRROR_API_URL", "https://mirror.test");
    vi.stubEnv("MIRROR_API_TOKEN", "t0ken");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetMirrorBreaker();
    registerCitations({ registerTool: (_name: string, _config: unknown, h: Handler) => void (handler = h) } as never);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("by id: one request to the citations route, with the court filter and the page", async () => {
    fetchMock.mockResolvedValueOnce(json(LINKS));
    const out = await handler(args({ source: "ns", id: "X1", cited_by_sources: ["us"], limit: 5, offset: 10 }));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/decisions/ns/X1/citations");
    expect([url.searchParams.get("limit"), url.searchParams.get("offset"), url.searchParams.getAll("source")]).toEqual(["5", "10", ["us"]]);
    expect(out.content[0].text).toContain("Cited by 3 decisions from US");
  });

  it("by case_number: resolved through the exact lookup, never the full-text search", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ decisions: [{ source: "ns", id: "X1", caseNumber: "31 Cdo 1945/2010", court: "Nejvyšší soud", form: "usneseni", date: "2011-05-11" }] }))
      .mockResolvedValueOnce(json(LINKS));
    const out = await handler(args({ source: "ns", case_number: "31 Cdo 1945/2010" }));
    const lookup = new URL(String(fetchMock.mock.calls[0][0]));
    expect(lookup.pathname).toBe("/v1/by-case");
    expect(lookup.searchParams.get("case")).toBe("31 Cdo 1945/2010");
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toBe("/v1/decisions/ns/X1/citations");
    expect(out.content[0].text).toContain("Cited by 3 decisions");
  });

  it("several decisions under one značka come back as a list to choose from; none says so", async () => {
    fetchMock.mockResolvedValueOnce(json({ decisions: [
      { source: "justice", id: "a", caseNumber: "19 C 264/2021", court: "Okresní soud v Teplicích", form: "rozsudek", date: "2025-04-10" },
      { source: "justice", id: "b", caseNumber: "19 C 264/2021", court: "Okresní soud v Kolíně", form: "rozsudek", date: "2022-01-11" },
    ] }));
    const many = await handler(args({ source: "justice", case_number: "19 C 264/2021" }));
    expect(many.content[0].text).toContain("2 decisions carry");
    expect(many.content[0].text).toContain("Okresní soud v Kolíně → caselaw_citations source: justice, id: b");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json({ decisions: [] }));
    const none = await handler(args({ source: "ns", case_number: "1 Cdo 1/1999" }));
    expect(none.content[0].text).toContain("No NS decision with spisová značka");
  });

  it("a decision the mirror does not hold, a missing identifier, and no mirror at all", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "not found" }, 404));
    expect((await handler(args({ source: "nss", id: "999" }))).content[0].text).toContain("does not hold NSS decision 999");

    const missing = await handler(args({ source: "ns" }));
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Neither id nor case_number");

    vi.stubEnv("MIRROR_API_URL", "");
    const off = await handler(args({ source: "ns", id: "X1" }));
    expect(off.isError).toBe(true);
    expect(off.content[0].text).toContain("need the case-law mirror");
  });
});
