import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRIMO_VID,
  buildPrimoQuery,
  buildPrimoUrl,
  mapPrimoDoc,
  parsePrimoSearch,
  primoLinkUrl,
  searchPrimo,
  stripPrimoMarkers,
} from "@/src/sources/primo";
import { bibKey, formatAuthors, pageWindow, sliceWindow, type BibHit } from "@/src/sources/shared/bib";
import { SourceError } from "@/src/sources/shared/errors";
import { registerDoctrine } from "@/src/mcp/tools/doctrine";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", name), "utf8")) as unknown;

// ---------- UKAŽ / Primo VE ----------

describe("buildPrimoQuery", () => {
  it("writes one clause per criterion in Primo's field,operator,value,BOOL syntax", () => {
    expect(buildPrimoQuery({ query: "genocida", title: "Římský statut", author: "Šturma" })).toBe(
      "any,contains,genocida,AND;title,contains,Římský statut,AND;creator,contains,Šturma,AND",
    );
  });
  it("appends the language and date-range pre-filters the form sends", () => {
    expect(buildPrimoQuery({ subject: "trestní právo", language: "cze", yearFrom: 2025, yearTo: 2026 })).toBe(
      "sub,contains,trestní právo,AND;lang,exact,cze,AND;dr_s,exact,20250101,AND;dr_e,exact,20261231,AND",
    );
  });
  it("cannot be broken by the syntax's own separators inside a value", () => {
    expect(buildPrimoQuery({ query: "a, b; c" })).toBe("any,contains,a b c,AND");
  });
});

describe("buildPrimoUrl", () => {
  it("mirrors the captured parameter set with q/offset/limit filled in", () => {
    const url = new URL(buildPrimoUrl({ query: "genocida" }, 20, 10));
    expect(url.origin + url.pathname).toBe("https://cuni.primo.exlibrisgroup.com/primaws/rest/pub/pnxs");
    expect(url.searchParams.get("q")).toBe("any,contains,genocida,AND");
    expect(url.searchParams.get("offset")).toBe("20");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("vid")).toBe(PRIMO_VID);
    expect(url.searchParams.get("inst")).toBe("420CKIS_INST");
    expect(url.searchParams.get("scope")).toBe("MyInst_and_CI");
    expect(url.searchParams.get("tab")).toBe("Everything");
    expect(url.searchParams.get("mode")).toBe("advanced");
    expect(url.searchParams.get("sort")).toBe("rank");
    expect(url.searchParams.get("skipDelivery")).toBe("Y");
    expect(url.searchParams.get("pcAvailability")).toBe("false");
    expect(url.searchParams.get("lang")).toBe("cs");
  });
});

describe("searchPrimo guest token", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a refused guest token as a session problem and forgets the dead token", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push(url.includes("/jwt") ? "JWT" : headers.authorization ? "PNXS+bearer" : "PNXS");
      if (url.includes("/jwt")) return new Response('"eyJhbGciOiJIUzI1NiJ9.eyJndWVzdCI6dHJ1ZX0.c2ln"', { status: 200 });
      return new Response("unauthorized", { status: 401 });
    });
    await expect(searchPrimo({ query: "odmítnuto 1" }, 0, 10)).rejects.toMatchObject({ kind: "SESSION_EXPIRED" });
    await expect(searchPrimo({ query: "odmítnuto 2" }, 0, 10)).rejects.toMatchObject({ kind: "SESSION_EXPIRED" });
    // The dead token is evicted, so the second search handshakes again.
    expect(calls).toEqual(["PNXS", "JWT", "PNXS+bearer", "PNXS", "JWT", "PNXS+bearer"]);
  });
});

describe("parsePrimoSearch", () => {
  it("reads the verbatim zero-hit envelope of the capture", () => {
    const page = parsePrimoSearch(fixture("primo/search-empty.json"));
    expect(page).toEqual({ total: 0, totalLocal: 0, totalCentral: 0, hits: [] });
  });

  it("maps a verbatim Central Discovery Index article from the deployment's own answer", () => {
    const page = parsePrimoSearch(fixture("primo/search-cdi-article.json"));
    expect(page).toMatchObject({ total: 10789, totalLocal: 443, totalCentral: 10346 });
    const hit = page.hits[0];
    expect(hit.source).toBe("cuni");
    expect(hit.id).toBe("cdi_crossref_primary_10_18485_iipe_mp_2025_76_1194_1");
    expect(hit.title).toBe("Kako je Lemkinovo tumačenje genocida postalo instrument politike?");
    expect(hit.authors).toEqual(["Ćujić, Miodrag"]);
    expect(hit.year).toBe("2025");
    expect(hit.type).toBe("article");
    expect(hit.language).toBe("srp");
    expect(hit.container).toBe("Međunarodna politika, 2025, Vol.76 (1194), p.185-202");
    expect(hit.doi).toEqual(["10.18485/iipe_mp.2025.76.1194.1"]);
    expect(hit.issn).toEqual(["0543-3657"]);
    expect(hit.open_access).toBe(true);
    expect(hit.abstract).toMatch(/^The aim of the paper/);
    // The only delivery link is a cover thumbnail with a relative URL; the pnx links are templates — no access link.
    expect(hit.links).toBeUndefined();
    expect(hit.url).toBe(
      "https://cuni.primo.exlibrisgroup.com/discovery/fulldisplay?docid=cdi_crossref_primary_10_18485_iipe_mp_2025_76_1194_1&vid=420CKIS_INST%3AUKAZ&lang=cs&context=PC",
    );
  });

  it("maps a verbatim catalogue book with its table of contents and subjects", () => {
    const page = parsePrimoSearch(fixture("primo/search-local-book.json"));
    const hit = page.hits[0];
    expect(hit.id).toBe("alma990020025980106986");
    expect(hit.title).toBe("100 rokov ticha : Arménska genocída");
    expect(hit.authors).toEqual(["Chuguryan, Vahram, 1974-", "Univerzita Mateja Bela. Fakulta politických vied a medzinárodných vzťahov"]);
    expect(hit.year).toBe("2015");
    expect(hit.publisher).toBe("Banská Bystrica : Belianum");
    expect(hit.type).toBe("book");
    expect(hit.language).toBe("slo");
    expect(hit.isbn).toEqual(["978-80-557-0874-4"]);
    expect(hit.subjects).toEqual(["20. století", "Arméni", "arménská otázka", "arménská genocida (1915-1923)", "masakry", "etnické vztahy"]);
    expect(hit.contents).toMatch(/^01\/01 - Obsah \(FF\) STRUČNÝ HISTORICKÝ VÝVOJ REGIÓNU/);
    expect(hit.contents!.length).toBeLessThanOrEqual(251);
    expect(hit.url).toContain("context=L");
    // The record view keeps the whole table of contents.
    const full = mapPrimoDoc(fixture("primo/record-local-book.json") as Record<string, unknown>, true);
    expect(full.id).toBe("alma990020025980106986");
    expect(full.contents).toMatch(/Postoj Slovenskej republiky$/);
    expect(full.links).toBeUndefined();
  });

  it("reads identifiers off display.identifier when addata has none", () => {
    const hit = mapPrimoDoc({ pnx: { control: { recordid: ["alma1"] }, display: { title: ["T"], identifier: ["$$CISBN$$V978-80-1", "DOI: 10.5/x", "ISSN: 1234-5678"] } } });
    expect(hit.isbn).toEqual(["978-80-1"]);
    expect(hit.doi).toEqual(["10.5/x"]);
    expect(hit.issn).toEqual(["1234-5678"]);
  });

  it("keeps real delivery links and drops display-only ones", () => {
    const hit = mapPrimoDoc({
      context: "PC",
      pnx: {
        control: { recordid: ["cdi_x"] },
        display: { title: ["T"] },
        links: { linktorsrc: ["$$Uhttps://www.proquest.com/docview/123$$DView record in ProQuest"] },
      },
      delivery: {
        link: [
          { linkType: "http://purl.org/pnx/linkType/thumbnail", linkURL: "https://img.example/x.jpg" },
          { linkType: "thumbnail", linkURL: "https://cache.obalkyknih.cz/api/cover?x" },
          { linkType: "http://purl.org/pnx/linkType/linktorsrc", linkURL: "https://x.test/svc" },
        ],
      },
    });
    expect(hit.links).toEqual(["https://www.proquest.com/docview/123", "https://x.test/svc"]);
  });

  it("builds the container from OpenURL data when ispartof is absent", () => {
    const hit = mapPrimoDoc({
      context: "L",
      pnx: {
        control: { recordid: ["alma9910"] },
        display: { title: ["T"] },
        addata: { jtitle: ["Právník"], volume: ["162"], issue: ["3"], spage: ["201"] },
      },
    });
    expect(hit.container).toBe("Právník, vol. 162, no. 3, p. 201");
    expect(hit.url).toContain("docid=alma9910");
    expect(hit.url).toContain("context=L");
  });

  it("survives a doc with nothing in it", () => {
    const hit = mapPrimoDoc({});
    expect(hit.id).toBe("");
    expect(hit.title).toBe("(bez názvu)");
    expect(hit.url).toBeNull();
  });

  it("throws PARSE_DRIFT without the envelope", () => {
    expect(() => parsePrimoSearch({ docs: [] })).toThrowError(SourceError);
    expect(() => parsePrimoSearch({ info: { total: 3 } })).toThrow(/info\.total\/docs/);
  });

  it("strips PNX subfield markers and pulls URLs out of $$U links", () => {
    expect(stripPrimoMarkers("Novák, Jan$$QNovák, Jan")).toBe("Novák, Jan");
    expect(primoLinkUrl("$$Uhttps://x.test/a$$DLabel")).toBe("https://x.test/a");
    expect(primoLinkUrl("https://x.test/b")).toBe("https://x.test/b");
    expect(primoLinkUrl("$$DLabel only")).toBeUndefined();
  });
});

// ---------- shared: paging over fixed catalogue pages, dedupe, citation ----------

describe("pageWindow / sliceWindow", () => {
  it("maps a tool page onto the catalogue pages that cover it", () => {
    expect(pageWindow(1, 10, 10)).toEqual({ start: 0, end: 10, upstreamPages: [1], firstOffset: 0 });
    expect(pageWindow(2, 30, 10)).toEqual({ start: 30, end: 60, upstreamPages: [4, 5, 6], firstOffset: 30 });
    expect(pageWindow(2, 25, 10)).toEqual({ start: 25, end: 50, upstreamPages: [3, 4, 5], firstOffset: 20 });
    expect(pageWindow(3, 7, 10)).toEqual({ start: 14, end: 21, upstreamPages: [2, 3], firstOffset: 10 });
  });
  it("cuts the concatenated catalogue pages to exactly the requested hits", () => {
    const rows = Array.from({ length: 30 }, (_, i) => 20 + i); // catalogue pages 3–5 → hits 20..49
    expect(sliceWindow(rows, pageWindow(2, 25, 10))).toEqual(Array.from({ length: 25 }, (_, i) => 25 + i));
    expect(sliceWindow([20, 21], pageWindow(2, 25, 10))).toEqual([]); // short last page
  });
});

describe("bibKey / formatAuthors", () => {
  const base: BibHit = { source: "cuni", id: "", title: "A Title", authors: [], url: null };
  it("prefers the record id, then DOI, then title + year + first author", () => {
    expect(bibKey({ ...base, id: "x1" })).toBe("cuni:x1");
    expect(bibKey({ ...base, doi: ["10.1/ABC"] })).toBe("cuni:doi:10.1/abc");
    expect(bibKey({ ...base, year: "2020" })).toBe("cuni:a title|2020|");
    expect(bibKey({ ...base, year: "2020", authors: ["Novák"] })).toBe("cuni:a title|2020|novák");
  });
  it("shortens long author lists", () => {
    expect(formatAuthors([])).toBe("");
    expect(formatAuthors(["A", "B"])).toBe("A, B");
    expect(formatAuthors(["A", "B", "C", "D"])).toBe("A, B, C et al.");
  });
});

// ---------- the search tool end to end, upstream stubbed with the live records ----------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function doctrineHandler(): Handler {
  let handler: Handler | undefined;
  registerDoctrine({
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === "doctrine_search") handler = callback;
    },
  } as never);
  if (!handler) throw new Error("doctrine_search did not register");
  return handler;
}

const bookDoc = (fixture("primo/search-local-book.json") as { docs: Array<Record<string, unknown>> }).docs[0];
const articleDoc = (fixture("primo/search-cdi-article.json") as { docs: Array<Record<string, unknown>> }).docs[0];

/**
 * A catalogue answering `total` records: page `offset` holds `count` docs,
 * cloned from the two live records with ids that say where they sit, so a
 * test can read the paging back off the ids.
 */
function primoPage(offset: number, count: number, total = 10789, tag = ""): string {
  const docs = Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    const base = JSON.parse(JSON.stringify(n % 2 === 0 ? bookDoc : articleDoc)) as { pnx: { control: Record<string, unknown> } };
    base.pnx.control.recordid = [`${n % 2 === 0 ? "alma" : "cdi_"}${tag}${n}`];
    return base;
  });
  return JSON.stringify({ info: { totalResultsLocal: 443, totalResultsPC: total - 443, total, first: offset + 1, last: offset + count }, docs });
}

describe("doctrine_search (stubbed catalogue)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Serve `perPage` docs per catalogue page (10 = a full page), up to `pages` pages. */
  function stubCatalogue(perPage = 10, pages = 5, status = 200) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const q = u.searchParams.get("q") ?? "";
      if (status !== 200) return new Response("nope", { status });
      const page = offset / 10;
      return new Response(page < pages ? primoPage(offset, perPage, 10789, q.includes("varianta B") ? "b" : "") : primoPage(offset, 0), { status: 200 });
    });
    return urls;
  }

  it("fetches one catalogue page and renders the records with the catalogue split", async () => {
    const urls = stubCatalogue();
    const result = await doctrineHandler()({ query: "genocida A", limit: 10, page: 1 });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { total: number; total_local: number; total_central: number; has_more: boolean; items: BibHit[] };
    expect(out).toMatchObject({ total: 10789, total_local: 443, total_central: 10346, has_more: true });
    expect(out.items).toHaveLength(10);
    expect(out.items.map((h) => h.id)).toEqual(["alma0", "cdi_1", "alma2", "cdi_3", "alma4", "cdi_5", "alma6", "cdi_7", "alma8", "cdi_9"]);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("offset")).toBe("0");
    const text = result.content[0].text;
    expect(text).toContain("✓ UKAŽ (Univerzita Karlova): 10789 records — 443 in the UK catalogue, 10346 in the Central Discovery Index; showing 1–10 (more: page 2)");
    expect(text).toContain("1. Chuguryan, Vahram, 1974-, Univerzita Mateja Bela. Fakulta politických vied a medzinárodných vzťahov (2015). 100 rokov ticha : Arménska genocída. Banská Bystrica : Belianum [book, slo] ISBN 978-80-557-0874-4");
    expect(text).toContain("   Contents: 01/01 - Obsah");
    expect(text).toContain("the whole abstract and contents of a hit: doctrine_get_document {id}");
  });

  it("pulls two catalogue pages for a bigger limit, brief records above ten", async () => {
    const urls = stubCatalogue();
    const result = await doctrineHandler()({ query: "genocida B", limit: 13, page: 1 });
    const out = result.structuredContent as { items: BibHit[] };
    expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0", "10"]);
    expect(out.items).toHaveLength(13);
    expect(out.items[12].id).toBe("alma12");
    // Above FULL_DETAIL_LIMIT the records come brief — in the text and in the structured items alike.
    expect(result.content[0].text).toContain("Brief records (limit above 10)");
    expect(result.content[0].text).not.toContain("Abstract:");
    expect(out.items.every((hit) => hit.abstract === undefined && hit.contents === undefined)).toBe(true);
    expect(out.items[0].isbn).toEqual(["978-80-557-0874-4"]);
  });

  it("walks to a later page by asking the catalogue for the covering pages", async () => {
    const urls = stubCatalogue();
    const result = await doctrineHandler()({ query: "genocida C", limit: 10, page: 3 });
    expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["20"]);
    const out = result.structuredContent as { items: BibHit[]; has_more: boolean };
    expect(out.items[0].id).toBe("alma20");
    expect(result.content[0].text).toContain("showing 21–30 (more: page 4)");
    expect(out.has_more).toBe(true);
  });

  it("gives every keyword variant its share of the page, round-robin", async () => {
    const urls = stubCatalogue();
    const result = await doctrineHandler()({ queries: ["varianta A", "varianta B"], limit: 4, page: 1 });
    const out = result.structuredContent as { items: BibHit[] };
    // share = 2 per variant: A1, B1, A2, B2 — the second variant reaches the reader.
    expect(out.items.map((h) => h.id)).toEqual(["alma0", "almab0", "cdi_1", "cdi_b1"]);
    expect(urls).toHaveLength(2);
  });

  it("does not advertise a next page when the catalogue returned nothing for this one", async () => {
    stubCatalogue(10, 2);
    const result = await doctrineHandler()({ query: "genocida D", limit: 10, page: 900 });
    const out = result.structuredContent as { total: number; has_more: boolean; items: BibHit[] };
    expect(out).toMatchObject({ total: 10789, has_more: false });
    expect(out.items).toHaveLength(0);
    expect(result.content[0].text).toContain("no records on this page");
    expect(result.content[0].text).not.toContain("more: page 901");
  });

  it("reports the catalogue's failure as a tool error", async () => {
    stubCatalogue(10, 5, 500);
    const result = await doctrineHandler()({ query: "genocida E", limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 500/);
  });

  it("refuses a call without any search criterion, before touching the network", async () => {
    const urls = stubCatalogue();
    const result = await doctrineHandler()({ language: "cze", year_from: 2020, limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    const blank = await doctrineHandler()({ title: "   ", author: " ", limit: 10, page: 1 });
    expect(blank.isError).toBe(true);
    const swapped = await doctrineHandler()({ query: "x y", year_from: 2025, year_to: 2020, limit: 10, page: 1 });
    expect(swapped.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });
});

// ---------- the record tool: the abstract and contents stay readable, whole ----------

function documentHandler(): Handler {
  let handler: Handler | undefined;
  registerDoctrine({
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === "doctrine_get_document") handler = callback;
    },
  } as never);
  if (!handler) throw new Error("doctrine_get_document did not register");
  return handler;
}

describe("doctrine_get_document (stubbed full-display endpoint)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the live catalogue record whole — the entire table of contents, not the search snippet", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(fixture("primo/record-local-book.json")), { status: 200 });
    });
    const result = await documentHandler()({ id: "alma990020025980106986" });
    expect(result.isError).toBeUndefined();
    expect(urls).toEqual([
      "https://cuni.primo.exlibrisgroup.com/primaws/rest/pub/pnxs/L/alma990020025980106986?vid=420CKIS_INST%3AUKAZ&lang=cs&search_scope=MyInst_and_CI",
    ]);
    const out = result.structuredContent as { record: BibHit };
    expect(out.record.id).toBe("alma990020025980106986");
    expect(out.record.title).toBe("100 rokov ticha : Arménska genocída");
    // The search cuts the contents to a snippet; the record carries them to the last line.
    const snippet = mapPrimoDoc(fixture("primo/record-local-book.json") as Record<string, unknown>, false).contents ?? "";
    expect(snippet).toMatch(/…$/);
    expect(out.record.contents!.length).toBeGreaterThan(snippet.length);
    expect(out.record.contents).toMatch(/Postoj Slovenskej republiky$/);
    expect(out.record.subjects).toContain("arménská genocida (1915-1923)");
    const text = result.content[0].text;
    expect(text).toContain("RECORD [UKAŽ (Univerzita Karlova)]: Chuguryan, Vahram, 1974-");
    expect(text).toContain("Subjects: 20. století; Arméni;");
    expect(text).toContain("Abstract: (none in the record)");
    expect(text).toContain("Contents: 01/01 - Obsah (FF)");
    expect(text).toContain("Postoj Slovenskej republiky");
    expect(text).toContain("Record: https://cuni.primo.exlibrisgroup.com/discovery/fulldisplay?docid=alma990020025980106986");
    expect(text).toContain("This is the catalogue record, not the work");
  });

  it("returns the whole abstract of a Central Discovery Index article", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(articleDoc), { status: 200 }));
    const result = await documentHandler()({ id: "cdi_crossref_primary_10_18485_iipe_mp_2025_76_1194_1" });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { record: BibHit };
    const full = mapPrimoDoc(articleDoc, true).abstract ?? "";
    expect(full.length).toBeGreaterThan(0);
    expect(out.record.abstract).toBe(full);
    expect(out.record.abstract).not.toMatch(/…$/);
    expect(out.record.doi).toEqual(["10.18485/iipe_mp.2025.76.1194.1"]);
    expect(result.content[0].text).toContain(`Abstract: ${full}`);
  });

  it("reports a missing record as an error and refuses a malformed id before the network", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("not found", { status: 404 });
    });
    const missing = await documentHandler()({ id: "alma000000000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/no record/);
    expect(urls).toHaveLength(1);
    const malformed = await documentHandler()({ id: "!!" });
    expect(malformed.isError).toBe(true);
    expect(urls).toHaveLength(1);
  });
});
