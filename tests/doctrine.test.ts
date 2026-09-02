import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PEACE_PALACE_DATABASES,
  accessLinkUrl,
  buildWorldcatQuery,
  buildWorldcatUrl,
  mapWorldcatRecord,
  parseWorldcatSearch,
} from "@/src/sources/worldcat";
import {
  PRIMO_VID,
  buildPrimoQuery,
  buildPrimoUrl,
  mapPrimoDoc,
  parsePrimoSearch,
  primoLinkUrl,
  stripPrimoMarkers,
} from "@/src/sources/primo";
import { bibKey, formatAuthors, pageWindow, sliceWindow, type BibHit } from "@/src/sources/shared/bib";
import { SourceError } from "@/src/sources/shared/errors";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", name), "utf8")) as unknown;

// ---------- Peace Palace Library / WorldCat Discovery ----------

describe("buildWorldcatQuery", () => {
  it("composes the advanced form's index syntax, criteria ANDed", () => {
    expect(buildWorldcatQuery({ query: "genocide", title: "Rome Statute", author: "Schabas" })).toBe(
      "kw:(genocide) AND ti:(Rome Statute) AND au:(Schabas)",
    );
    expect(buildWorldcatQuery({ subject: "International agencies", language: "ENG" })).toBe(
      "su:(International agencies) AND la:eng",
    );
  });
  it("keeps phrase quotes but never lets a value unbalance the grouping", () => {
    expect(buildWorldcatQuery({ query: '"safe harbour" (data)' })).toBe('kw:("safe harbour" data)');
  });
  it("is empty without a criterion", () => {
    expect(buildWorldcatQuery({ language: "eng" })).toBe("la:eng");
    expect(buildWorldcatQuery({})).toBe("");
  });
});

describe("buildWorldcatUrl", () => {
  it("mirrors the captured parameter set, page absent on page 1", () => {
    const url = new URL(buildWorldcatUrl({ query: "genocide" }, 1));
    expect(url.origin + url.pathname).toBe("https://peacepalace.on.worldcat.org/api/search");
    expect(url.searchParams.get("queryString")).toBe("kw:(genocide)");
    expect(url.searchParams.get("databaseList")).toBe(PEACE_PALACE_DATABASES);
    expect(url.searchParams.get("sortKey")).toBe("BEST_MATCH");
    expect(url.searchParams.get("clusterResults")).toBe("true");
    expect(url.searchParams.get("groupVariantRecords")).toBe("false");
    expect(url.searchParams.get("bookReviews")).toBe("off");
    expect(url.searchParams.get("idDetect")).toBe("true");
    expect(url.searchParams.get("citeDetect")).toBe("true");
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.has("year")).toBe(false);
    expect(url.searchParams.has("content")).toBe(false);
  });
  it("adds the year facet, the full-text facet and the page number", () => {
    const url = new URL(buildWorldcatUrl({ query: "x", yearFrom: 2021, yearTo: 2025, fullTextOnly: true }, 2));
    expect(url.searchParams.get("year")).toBe("2021..2025");
    expect(url.searchParams.get("content")).toBe("fullText");
    expect(url.searchParams.get("page")).toBe("2");
  });
  it("opens a one-sided year range at a sensible bound", () => {
    expect(new URL(buildWorldcatUrl({ query: "x", yearFrom: 2020 }, 1)).searchParams.get("year")).toMatch(/^2020\.\.\d{4}$/);
    expect(new URL(buildWorldcatUrl({ query: "x", yearTo: 1999 }, 1)).searchParams.get("year")).toBe("1800..1999");
  });
});

describe("parseWorldcatSearch (verbatim capture)", () => {
  const page1 = parseWorldcatSearch(fixture("worldcat/search-page-1.json"));
  const page2 = parseWorldcatSearch(fixture("worldcat/search-page-2.json"));

  it("reads the total and every record", () => {
    expect(page1.total).toBe(12279);
    expect(page1.hits).toHaveLength(3);
    expect(page1.partial).toBe(false);
    expect(page2.total).toBe(12279);
    expect(page2.hits[0].title).toBe("Analytical heat transfer");
  });

  it("maps a book record field by field", () => {
    const hit = page1.hits[0];
    expect(hit.source).toBe("peacepalace");
    expect(hit.id).toBe("1525268154");
    expect(hit.title).toBe("International Institutional Law : Seventh Revised Edition");
    expect(hit.authors).toEqual(["Henry G Schermers", "Niels M Blokker"]);
    expect(hit.year).toBe("2025");
    expect(hit.publisher).toBe("Leiden ; Boston : Brill | Nijhoff, 2025.");
    expect(hit.type).toBe("eBook");
    expect(hit.language).toBe("eng");
    expect(hit.isbn).toEqual(["9789004724822", "9004724826"]);
    expect(hit.doi).toEqual(["10.1163/9789004724822"]);
    expect(hit.subjects).toContain("International agencies");
    expect(hit.abstract).toMatch(/^This seventh, revised edition/);
    expect(hit.abstract!.length).toBeLessThanOrEqual(401);
    expect(hit.contents).toMatch(/^Preface xxv/);
    expect(hit.open_access).toBe(false);
    expect(hit.url).toBe("https://peacepalace.on.worldcat.org/oclc/1525268154");
  });

  it("collects access links and the LCSH display form of subjects", () => {
    const hit = page1.hits[1];
    expect(hit.id).toBe("1507695297");
    expect(hit.links).toContain("https://public.ebookcentral.proquest.com/choice/PublicFullRecord.aspx?p=31946553");
    expect(hit.subjects).toContain("Constitutional law—United States");
  });

  it("keeps only real access links — cover images and excerpts are not the work", () => {
    // Page 2's Taylor & Francis record carries the book link AND its jacket image.
    const tandf = page2.hits.find((hit) => hit.id === "1553844722");
    expect(tandf?.links).toEqual(["https://www.taylorfrancis.com/books/9781003705338"]);
    expect(accessLinkUrl({ url: "https://x.test/a", relationship: "0" })).toBe("https://x.test/a");
    expect(accessLinkUrl({ url: "https://x.test/b", relationship: "1" })).toBe("https://x.test/b");
    expect(accessLinkUrl({ url: "https://x.test/c", relationship: "2", label: "cloudLibrary" })).toBeUndefined();
    expect(accessLinkUrl({ url: "https://samples.overdrive.com/?crid=1", relationship: " ", label: "Excerpt" })).toBeUndefined();
    expect(accessLinkUrl({ url: "https://images.yourcloudlibrary.com/delivery/img?type=DOCUMENTIMAGE&documentID=a", relationship: "0" })).toBeUndefined();
    expect(accessLinkUrl({ url: "https://x.test/jacket.jpg", relationship: "0" })).toBeUndefined();
    expect(accessLinkUrl({ url: "https://x.test/d", relationship: "0", label: "Front cover" })).toBeUndefined();
  });

  it("falls back to the SPA's own opac link when a record has no OCLC number", () => {
    const hit = mapWorldcatRecord({
      titleObject: { data: "Nameless" },
      opacLink: "http://peacepalace.on.worldcat.org/search?queryString=ib%3A123",
    });
    expect(hit.id).toBe("");
    expect(hit.url).toBe("http://peacepalace.on.worldcat.org/search?queryString=ib%3A123");
    expect(hit.authors).toEqual([]);
    expect(hit.abstract).toBeUndefined();
  });

  it("throws PARSE_DRIFT when the envelope is gone", () => {
    expect(() => parseWorldcatSearch({ records: [] })).toThrowError(SourceError);
    expect(() => parseWorldcatSearch({ numberOfRecords: 1 })).toThrow(/numberOfRecords\/records/);
    expect(() => parseWorldcatSearch("<html>")).toThrowError(SourceError);
  });
});

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

describe("parsePrimoSearch", () => {
  it("reads the verbatim zero-hit envelope of the capture", () => {
    const page = parsePrimoSearch(fixture("primo/search-empty.json"));
    expect(page).toEqual({ total: 0, totalLocal: 0, totalCentral: 0, hits: [] });
  });

  // Synthetic — the capture holds no records (the recorded query matched
  // nothing); layout per Primo's documented PNX sections.
  const doc = {
    context: "PC",
    adaptor: "Primo Central",
    "@id": "https://cuni.primo.exlibrisgroup.com/primaws/rest/pub/pnxs/PC/cdi_proquest_journals_123",
    pnx: {
      control: { recordid: ["cdi_proquest_journals_123"], sourceid: ["proquest"] },
      display: {
        type: ["article"],
        title: ["Genocide and the Rome Statute$$QGenocide and the Rome Statute"],
        creator: ["Schabas, William A.$$QSchabas, William A."],
        contributor: ["Novák, Jan"],
        creationdate: ["[2019]"],
        publisher: ["Oxford : OUP"],
        language: ["eng"],
        ispartof: ["Journal of International Criminal Justice, 2019, Vol.17 (2), p.1-20"],
        subject: ["Genocide ; International criminal law"],
        description: ["A study of the crime of genocide under Article 6."],
      },
      addata: { doi: ["10.1093/jicj/mqz001"], issn: ["1478-1387"], jtitle: ["Journal of International Criminal Justice"] },
      links: { linktorsrc: ["$$Uhttps://www.proquest.com/docview/123$$DView record in ProQuest"] },
    },
    delivery: { link: [{ linkType: "http://purl.org/pnx/linkType/thumbnail", linkURL: "https://img.example/x.jpg" }], availability: ["fulltext"] },
  };

  it("maps a synthetic Central Discovery Index article", () => {
    const page = parsePrimoSearch({ info: { total: 1, totalResultsLocal: 0, totalResultsPC: 1 }, docs: [doc] });
    expect(page.total).toBe(1);
    expect(page.totalCentral).toBe(1);
    const hit = page.hits[0];
    expect(hit.source).toBe("cuni");
    expect(hit.id).toBe("cdi_proquest_journals_123");
    expect(hit.title).toBe("Genocide and the Rome Statute");
    expect(hit.authors).toEqual(["Schabas, William A.", "Novák, Jan"]);
    expect(hit.year).toBe("2019");
    expect(hit.type).toBe("article");
    expect(hit.language).toBe("eng");
    expect(hit.container).toBe("Journal of International Criminal Justice, 2019, Vol.17 (2), p.1-20");
    expect(hit.subjects).toEqual(["Genocide", "International criminal law"]);
    expect(hit.doi).toEqual(["10.1093/jicj/mqz001"]);
    expect(hit.issn).toEqual(["1478-1387"]);
    expect(hit.abstract).toBe("A study of the crime of genocide under Article 6.");
    expect(hit.links).toEqual(["https://www.proquest.com/docview/123", "https://img.example/x.jpg"]);
    expect(hit.url).toBe(
      "https://cuni.primo.exlibrisgroup.com/discovery/fulldisplay?docid=cdi_proquest_journals_123&vid=420CKIS_INST%3AUKAZ&lang=cs&context=PC",
    );
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
  it("prefers the record id, then DOI, then title + year — per source", () => {
    expect(bibKey({ ...base, id: "x1" })).toBe("cuni:x1");
    expect(bibKey({ ...base, doi: ["10.1/ABC"] })).toBe("cuni:doi:10.1/abc");
    expect(bibKey({ ...base, year: "2020" })).toBe("cuni:a title|2020");
    expect(bibKey({ ...base, source: "peacepalace", id: "x1" })).not.toBe(bibKey({ ...base, id: "x1" }));
  });
  it("shortens long author lists", () => {
    expect(formatAuthors([])).toBe("");
    expect(formatAuthors(["A", "B"])).toBe("A, B");
    expect(formatAuthors(["A", "B", "C", "D"])).toBe("A, B, C et al.");
  });
});

// ---------- the tool end to end, upstream stubbed with the fixtures ----------

import { afterEach, vi } from "vitest";
import { registerDoctrine } from "@/src/mcp/tools/doctrine";

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

const worldcatPage = (n: number) =>
  readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", "worldcat", `search-page-${n}.json`), "utf8");
const primoEmpty = readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", "primo", "search-empty.json"), "utf8");

describe("doctrine_search (stubbed upstreams)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Serve the captured pages: WorldCat page 1/2 by its `page` parameter,
   * Primo the verbatim zero-hit envelope; anything else is a 404. */
  function stubCatalogues(primoStatus = 200) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.hostname === "peacepalace.on.worldcat.org") {
        const page = Number(u.searchParams.get("page") ?? "1");
        return page <= 2
          ? new Response(worldcatPage(page), { status: 200, headers: { "content-type": "application/json" } })
          : new Response('{"numberOfRecords":12279,"records":[]}', { status: 200 });
      }
      if (u.hostname === "cuni.primo.exlibrisgroup.com") {
        return new Response(primoStatus === 200 ? primoEmpty : "nope", { status: primoStatus });
      }
      return new Response("not found", { status: 404 });
    });
    return urls;
  }

  it("fetches one catalogue page per source and renders both blocks", async () => {
    const urls = stubCatalogues();
    const result = await doctrineHandler()({ query: "institutional law A", per_source_limit: 10, page: 1, full_text_only: false });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { statuses: Array<Record<string, unknown>>; items: BibHit[] };
    expect(out.statuses).toEqual([
      { source: "peacepalace", ok: true, total: 12279, has_more: true },
      { source: "cuni", ok: true, total: 0, has_more: false, note: "0 in the UK catalogue, 0 in the Central Discovery Index" },
    ]);
    expect(out.items.map((h) => h.source)).toEqual(["peacepalace", "peacepalace", "peacepalace"]);
    expect(urls.filter((u) => u.includes("worldcat"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("primo"))).toHaveLength(1);
    const text = result.content[0].text;
    expect(text).toContain("✓ Peace Palace Library (WorldCat): 12279 records; showing 1–3 (more: page 2)");
    expect(text).toContain("1. Henry G Schermers, Niels M Blokker (2025). International Institutional Law : Seventh Revised Edition. Leiden ; Boston : Brill | Nijhoff, 2025. [eBook, eng] ISBN 9789004724822 · DOI 10.1163/9789004724822");
    expect(text).toContain("https://peacepalace.on.worldcat.org/oclc/1525268154");
    expect(text).toContain("✓ UKAŽ (Univerzita Karlova): 0 records");
    expect(text).toContain("no records on this page");
  });

  it("pulls several catalogue pages for a bigger limit and numbers hits across them", async () => {
    const urls = stubCatalogues();
    const result = await doctrineHandler()({ query: "institutional law B", per_source_limit: 13, page: 1, full_text_only: false });
    const out = result.structuredContent as { items: BibHit[] };
    // Two catalogue pages (10 + 10 would cover 13), each fixture holds 3 records.
    expect(urls.filter((u) => u.includes("worldcat")).map((u) => new URL(u).searchParams.get("page"))).toEqual([null, "2"]);
    expect(out.items.map((h) => h.title)).toEqual([
      "International Institutional Law : Seventh Revised Edition",
      "A companion to the United States Constitution and its amendments : America's continuing revolution",
      "Family law in America",
      "Analytical heat transfer",
      "The art of staying neutral : the Netherlands in the First World War, 1914-1918",
      "The occupation of justice : Supreme Court of Israel and the Occupied Territories",
    ]);
    expect(result.content[0].text).toContain("6. ");
    // Above FULL_DETAIL_LIMIT per source the records come brief — in the text
    // and in the structured items alike — so the page stays inside the budget.
    expect(result.content[0].text).toContain("Brief records (per_source_limit above 10)");
    expect(result.content[0].text).not.toContain("Abstract:");
    expect(out.items.every((hit) => hit.abstract === undefined && hit.contents === undefined)).toBe(true);
    expect(out.items[0].isbn).toEqual(["9789004724822", "9004724826"]);
  });

  it("keeps abstract and contents on a full-detail page", async () => {
    stubCatalogues();
    const result = await doctrineHandler()({ query: "institutional law E", per_source_limit: 10, page: 1, full_text_only: false });
    const out = result.structuredContent as { items: BibHit[] };
    expect(out.items[0].abstract).toMatch(/^This seventh, revised edition/);
    expect(out.items[0].contents).toMatch(/^Preface xxv/);
    expect(result.content[0].text).toContain("   Abstract: This seventh");
    expect(result.content[0].text).not.toContain("Brief records");
  });

  it("walks to a later page by asking the catalogue for the covering pages", async () => {
    const urls = stubCatalogues();
    const result = await doctrineHandler()({ query: "institutional law C", per_source_limit: 10, page: 2, sources: ["peacepalace"], full_text_only: false });
    expect(urls.filter((u) => u.includes("worldcat")).map((u) => new URL(u).searchParams.get("page"))).toEqual(["2"]);
    expect(urls.filter((u) => u.includes("primo"))).toHaveLength(0);
    const out = result.structuredContent as { items: BibHit[]; statuses: Array<{ has_more: boolean }> };
    expect(out.items[0].title).toBe("Analytical heat transfer");
    expect(result.content[0].text).toContain("showing 11–13 (more: page 3)");
    expect(out.statuses[0].has_more).toBe(true);
  });

  it("reports one catalogue's failure without sinking the other", async () => {
    stubCatalogues(500);
    const result = await doctrineHandler()({ query: "institutional law D", per_source_limit: 10, page: 1, full_text_only: false });
    const out = result.structuredContent as { statuses: Array<Record<string, unknown>>; items: BibHit[] };
    expect(out.statuses[0]).toMatchObject({ source: "peacepalace", ok: true, total: 12279 });
    expect(out.statuses[1]).toMatchObject({ source: "cuni", ok: false, total: null, has_more: false });
    expect(String(out.statuses[1].error)).toMatch(/HTTP 500/);
    expect(out.items).toHaveLength(3);
    expect(result.content[0].text).toContain("✗ UKAŽ (Univerzita Karlova): ");
  });

  it("refuses a call without any search criterion, before touching the network", async () => {
    const urls = stubCatalogues();
    const result = await doctrineHandler()({ language: "cze", year_from: 2020, per_source_limit: 10, page: 1, full_text_only: false });
    expect(result.isError).toBe(true);
    expect(urls).toHaveLength(0);
    const swapped = await doctrineHandler()({ query: "x y", year_from: 2025, year_to: 2020, per_source_limit: 10, page: 1, full_text_only: false });
    expect(swapped.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });
});
