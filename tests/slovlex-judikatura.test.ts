import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SK_DECISION_FORMS,
  SK_DECISION_NATURES,
  SK_LAW_AREAS,
  buildJudikatyFilterRequest,
  buildVseobecneFilterUrl,
  compactCaseNumber,
  formatPredpisReference,
  judikatText,
  matchCourts,
  parseDecisionId,
  parseJudikatDetail,
  parseJudikatySearch,
  parseVseobecneDetail,
  parseVseobecneSearch,
  predpisReference,
  resolveCourt,
} from "@/src/sources/slovlex-judikatura";
import { setDocumentConverters } from "@/src/sources/shared/documents";
import { pdfText } from "@/src/zotero/pdf-text";
import { registerSkJudikatura, skDecisionHeader, skJudikaturaSearchText } from "@/src/mcp/tools/sk-judikatura";

/**
 * Fixtures in tests/fixtures/slovlex/ are live captures (2026-11-17):
 * vseobecne-filter-text.json (a full-text search, 5 rows), vseobecne-detail.json
 * + vseobecne-doc.pdf (decision 30Ek/2848/2026 and its file),
 * vseobecne-sud.json (the court list for query "najvy"), judikaty-filter-text.json
 * and judikat-detail.json (3Obdo/27/2018).
 */

const dir = path.join(__dirname, "fixtures", "slovlex");
const json = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as unknown;
const VSEOBECNE_FILTER = json("vseobecne-filter-text.json");
const VSEOBECNE_DETAIL = json("vseobecne-detail.json");
const VSEOBECNE_SUD = json("vseobecne-sud.json");
const JUDIKATY_FILTER = json("judikaty-filter-text.json");
const JUDIKAT_DETAIL = json("judikat-detail.json");
const PDF_BYTES = readFileSync(path.join(dir, "vseobecne-doc.pdf"));

const GUID = "42830f29-e07f-4769-9de3-b79f1dcd670f:14d33479-2681-4bdb-a0c8-650b57975714";
const JUDIKAT = "75cbdca1-7851-4437-859a-66510dba6b0d";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools: Record<string, Handler> = {};
registerSkJudikatura({ registerTool: (name: string, _config: unknown, handler: Handler) => void (tools[name] = handler) } as never);

/** Defaults the schema would fill in. */
const search = (args: Record<string, unknown>) => tools.sk_judikatura_search({ database: "sudy", limit: 20, page: 1, ...args });
const getDecision = (args: Record<string, unknown>) => tools.sk_judikatura_get_decision({ page: 1, ...args });
const errorKind = (result: Result) => (result.structuredContent as { error?: { kind?: string } } | undefined)?.error?.kind;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pdfResponse = () => new Response(new Uint8Array(PDF_BYTES), { status: 200, headers: { "content-type": "application/octet-stream" } });

afterEach(() => {
  vi.unstubAllGlobals();
  setDocumentConverters();
});

describe("vseobecne/filter request", () => {
  it("always carries the five Spring-required parameters and the date sort", () => {
    const url = buildVseobecneFilterUrl({}, 1, 20);
    expect(url).toContain("/internal/sudne-rozhodnutia/vseobecne/filter?");
    expect(url).toContain("query=&povahaRozhodnutiaFacetFilter=&ecli=&spisovaZnacka=&cisloSpisu=");
    expect(url).toContain("sortBy=datum_vydania_rozhodnutia&sortDirection=DESC");
    expect(url).toContain("page=1&size=20");
    expect(buildVseobecneFilterUrl({ court: "sud_100" }, 1, 1)).toContain("query=&povahaRozhodnutiaFacetFilter=&ecli=&spisovaZnacka=&cisloSpisu=&guidSud=sud_100");
  });

  it("maps every filter onto its upstream parameter", () => {
    const url = new URL(
      buildVseobecneFilterUrl(
        {
          query: '"nájomná zmluva"',
          caseNumber: "30 Ek 2848/2026",
          ecli: "ECLI:SK:OSBB:2026:6126457003.1",
          court: "ns",
          dateFrom: "2025-01-01",
          dateTo: "2025-12-31",
          form: "Rozsudok",
          nature: "Zmeňujúce",
          area: "Občianske právo",
          appliesAct: "40/1964 Zb.",
          appliesSection: "§ 420 ods. 1",
        },
        3,
        10,
      ),
    );
    const p = url.searchParams;
    expect(p.get("query")).toBe('"nájomná zmluva"');
    expect(p.get("spisovaZnacka")).toBe("30Ek/2848/2026");
    expect(p.get("ecli")).toBe("ECLI:SK:OSBB:2026:6126457003.1");
    expect(p.get("guidSud")).toBe("sud_100");
    expect(p.get("vydaniaOd")).toBe("2025-01-01");
    expect(p.get("vydaniaDo")).toBe("2025-12-31");
    expect(p.get("formaRozhodnutiaFacetFilter")).toBe("Rozsudok");
    expect(p.get("povahaRozhodnutiaFacetFilter")).toBe("Zmeňujúce");
    expect(p.get("oblastPravnejUpravyFacetFilter")).toBe("Občianske právo");
    expect(p.get("odkazovanePredpisy")).toBe("/SK/ZZ/1964/40/#paragraf-420.odsek-1");
    // The # must travel encoded, or it ends the URL (live: raw # → 0 hits).
    expect(url.search).toContain("odkazovanePredpisy=%2FSK%2FZZ%2F1964%2F40%2F%23paragraf-420.odsek-1");
    expect(p.get("page")).toBe("3");
    expect(p.get("size")).toBe("10");
    expect(new URL(buildVseobecneFilterUrl({ court: "nss" }, 1, 1)).searchParams.get("guidSud")).toBe("sud_175");
  });

  it("builds odkazovanePredpisy for an act, a §, an odsek, a písmeno and a článok", () => {
    expect(predpisReference("40/1964")).toBe("/SK/ZZ/1964/40");
    expect(predpisReference("/SK/ZZ/2015/160")).toBe("/SK/ZZ/2015/160");
    expect(predpisReference("40/1964", "§ 420")).toBe("/SK/ZZ/1964/40/#paragraf-420");
    expect(predpisReference("40/1964", "§ 420A")).toBe("/SK/ZZ/1964/40/#paragraf-420a");
    expect(predpisReference("233/1995 Z. z.", "§ 53 ods. 3 písm. b)")).toBe("/SK/ZZ/1995/233/#paragraf-53.odsek-3.pismeno-b");
    expect(predpisReference("460/1992", "čl. 46")).toBe("/SK/ZZ/1992/460/#paragraf-46");
    expect(() => predpisReference("občiansky zákonník")).toThrow(/not an act reference/);
    expect(() => predpisReference("40/1964", "odsek 3 niečoho")).toThrow(/not a section label/);
  });

  it("compacts a spisová značka into the form the sudy index stores", () => {
    expect(compactCaseNumber("30 Ek 2848/2026")).toBe("30Ek/2848/2026");
    expect(compactCaseNumber("30Ek/2848/2026")).toBe("30Ek/2848/2026");
    expect(compactCaseNumber("6 Cdo 138/2016")).toBe("6Cdo/138/2016");
    expect(compactCaseNumber("12OpNSS/1/2026")).toBe("12OpNSS/1/2026");
    expect(compactCaseNumber("II. ÚS 307/2014")).toBe("II. ÚS 307/2014");
  });

  it("refuses a court name that was not resolved and ÚS SR in sudy", () => {
    expect(() => buildVseobecneFilterUrl({ court: "Krajský súd v Bratislave" }, 1, 1)).toThrow(/resolved/);
    expect(() => buildVseobecneFilterUrl({ court: "us" }, 1, 1)).toThrow(/not in database "sudy"/);
  });
});

describe("judikaty/filter request", () => {
  it("sends only the fields that are set, sorted by decision date", () => {
    expect(buildJudikatyFilterRequest({ database: "judikaty" }, 1, 10)).toEqual({
      url: "https://api-gateway.slov-lex.sk/internal/sudne-rozhodnutia/judikaty/filter?page=1&size=10&sortBy=datumRozhodnutia&sortDirection=DESC",
      body: {},
    });
    expect(
      buildJudikatyFilterRequest(
        { database: "judikaty", query: "nájom", caseNumber: "3Obdo/27/2018", court: "ns", dateFrom: "2017-01-01", dateTo: "2018-12-31" },
        2,
        5,
      ).body,
    ).toEqual({ hladanyVyraz: "nájom", spisovaZnacka: "3Obdo/27/2018", sud: "NSSR", datumRozhodnutiaOd: "2017-01-01", datumRozhodnutiaDo: "2018-12-31" });
    expect(buildJudikatyFilterRequest({ court: "us" }, 1, 5).body).toEqual({ sud: "USSR" });
    expect(() => buildJudikatyFilterRequest({ court: "nss" }, 1, 5)).toThrow(/not in database "judikaty"/);
  });
});

describe("search parsers", () => {
  it("parses a vseobecne page with ISO dates and the composite id", () => {
    const page = parseVseobecneSearch(VSEOBECNE_FILTER, 1, 5);
    expect(page.total).toBe(840841);
    expect(page.totalPages).toBe(168169);
    expect(page.hits).toHaveLength(5);
    expect(page.hits[0]).toEqual({
      id: "6d2d9f0d-fbdf-4a50-80a5-c06f2ea19be8:c90209ae-6127-4694-b5d6-aaa60a41017f",
      case_number: "0T/55/2026",
      court: "Okresný súd Nové Zámky",
      judge: "JUDr. Vladimír Tamaškovič",
      decided: "2026-11-15",
      url: "https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/6d2d9f0d-fbdf-4a50-80a5-c06f2ea19be8:c90209ae-6127-4694-b5d6-aaa60a41017f",
    });
  });

  it("converts 16.11.2026 to ISO", () => {
    const page = parseVseobecneSearch({ page: { totalElements: 1, rozhodnutieList: [{ guid: GUID, datumVydania: "16.11.2026", sud: { id: "sud_139", nazov: "Okresný súd Banská Bystrica" } }] } }, 1, 20);
    expect(page.hits[0].decided).toBe("2026-11-16");
    expect(page.hits[0].court).toBe("Okresný súd Banská Bystrica");
  });

  it("parses a judikaty page with type, title and court", () => {
    const page = parseJudikatySearch(JUDIKATY_FILTER, 1, 5);
    expect(page.total).toBe(100);
    expect(page.totalPages).toBe(20);
    expect(page.hits[0]).toMatchObject({
      id: "4101b2c1-f344-4929-8ac6-203614459c07",
      case_number: "1Obo/10/2017",
      court: "Najvyšší súd SR",
      type: "Rozsudok",
      decided: "2018-05-15",
      url: "https://www.slov-lex.sk/sudne-rozhodnutia/judikaty/4101b2c1-f344-4929-8ac6-203614459c07",
    });
    expect(page.hits[0].title).toMatch(/^NS SR Rozsudok/);
    const us = parseJudikatySearch(
      { totalElements: 1, judikatList: [{ uuid: "f8e646d5-8113-40f3-9142-9c8bf7a02a2f", spisovaZnacka: "II. ÚS 307/2014", typRozhodnutia: null, nazovRozhodnutia: "ÚS SR Nález Ústavného súdu Slovenskej republiky sp. zn. II. ÚS 307/2014", datumRozhodnutia: "2014-12-18" }] },
      1,
      5,
    );
    expect(us.hits[0]).toMatchObject({ court: "Ústavný súd SR", type: "Nález" });
  });

  it("empties a page past the end (upstream answers the last page instead)", () => {
    expect(parseVseobecneSearch(VSEOBECNE_FILTER, 200_000, 5).hits).toEqual([]);
    expect(parseJudikatySearch(JUDIKATY_FILTER, 21, 5).hits).toEqual([]);
  });

  it("reports drift when the list is missing", () => {
    expect(() => parseVseobecneSearch({ page: {} }, 1, 5)).toThrow(/rozhodnutieList/);
    expect(() => parseJudikatySearch({}, 1, 5)).toThrow(/judikatList/);
  });

  it("keeps the filter vocabularies in step with the captured fazetFilter", () => {
    const facets = (VSEOBECNE_FILTER as { fazetFilter: Record<string, string[]> }).fazetFilter;
    for (const value of facets.formaRozhodnutiaList) expect(SK_DECISION_FORMS).toContain(value);
    expect([...SK_DECISION_NATURES]).toEqual(facets.povahaRozhodnutiaList);
    expect([...SK_LAW_AREAS]).toEqual(facets.oblastList);
  });
});

describe("decision ids and details", () => {
  it("tells a všeobecný súd id from a judikát id, also inside a URL", () => {
    expect(parseDecisionId(GUID)).toEqual({ kind: "sudy", id: GUID });
    expect(parseDecisionId(` ${JUDIKAT} `)).toEqual({ kind: "judikat", id: JUDIKAT });
    expect(parseDecisionId(`https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/${GUID}`)).toEqual({ kind: "sudy", id: GUID });
    expect(parseDecisionId(`https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/${GUID.replace(":", "%3A")}`)).toEqual({ kind: "sudy", id: GUID });
    expect(parseDecisionId(`https://www.slov-lex.sk/sudne-rozhodnutia/judikaty/${JUDIKAT}`)).toEqual({ kind: "judikat", id: JUDIKAT });
    expect(() => parseDecisionId("3Obdo/27/2018")).toThrow(/not a Slov-Lex decision id/);
  });

  it("reads a judikát: no BOM, právna veta first, empty sudHtml sections skipped", () => {
    const detail = parseJudikatDetail(JUDIKAT_DETAIL, JUDIKAT);
    expect(detail.text).not.toContain("﻿");
    expect(detail.text.startsWith("NS SR Uznesenie Najvyššieho súdu")).toBe(true);
    expect(detail.text).toContain("Dovolací súd je pri posudzovaní prípustnosti dovolania podľa § 421 ods. 1");
    expect(detail).toMatchObject({ kind: "judikat", case_number: "3Obdo/27/2018", court: "Najvyšší súd SR", type: "Uznesenie", decided: "2018-08-21", area: "Občianske právo" });
    expect(detail.references).toEqual(["160/2015 Z. z.", "§ 447 písm. c) 160/2015 Z. z."]);
    // The title appears once, not again from sudHtml's heading.
    expect(detail.text.split("NS SR Uznesenie Najvyššieho súdu").length).toBe(2);
    expect(judikatText({ secHtml: "﻿<p>veta</p>", sudHtml: "﻿<h2>T</h2>", nazovRozhodnutia: "T" })).toBe("T\n\nveta");
  });

  it("builds the header from a všeobecný súd detail", () => {
    const meta = parseVseobecneDetail(VSEOBECNE_DETAIL, GUID);
    expect(meta.references).toEqual(["233/1995 Z. z.", "§ 53 ods. 3 písm. b) 233/1995 Z. z."]);
    expect(skDecisionHeader(meta)).toEqual([
      "30Ek/2848/2026 — Okresný súd Banská Bystrica — Uznesenie — 2026-11-16",
      "Sudca: Mgr. Robert Schmidt",
      "Povaha: Iná povaha rozhodnutia",
      "Oblasť: Iné",
      "ECLI: ECLI:SK:OSBB:2026:6126457003.1",
      "Odkazované predpisy: 233/1995 Z. z.; § 53 ods. 3 písm. b) 233/1995 Z. z.",
      "Dokument: Uznesenie_30Ek-2848-2026.pdf — https://obcan.justice.sk/content/public/item/14d33479-2681-4bdb-a0c8-650b57975714",
      `https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/${GUID}`,
    ]);
  });

  it("formats references, the Ústava by článok", () => {
    expect(formatPredpisReference("/SK/ZZ/1964/40/#paragraf-420.odsek-1")).toBe("§ 420 ods. 1 40/1964 Zb.");
    expect(formatPredpisReference("/SK/ZZ/1992/460/#paragraf-46.odsek-1")).toBe("čl. 46 ods. 1 460/1992 Zb.");
    expect(formatPredpisReference("něco jiného")).toBe("něco jiného");
  });
});

describe("courts", () => {
  const courts = [
    ...(VSEOBECNE_SUD as Array<{ id: string; nazov: string }>),
    { id: "sud_101", nazov: "Krajský súd v Bratislave" },
    { id: "sud_102", nazov: "Mestský súd Bratislava I" },
    { id: "sud_103", nazov: "Mestský súd Bratislava II" },
    { id: "sud_130", nazov: "Krajský súd v Žiline" },
  ].map((c) => ({ id: c.id, name: c.nazov }));

  it("matches names by word stems, diacritics-insensitive", () => {
    expect(matchCourts(courts, "Krajský súd Bratislava").map((c) => c.id)).toEqual(["sud_101"]);
    expect(matchCourts(courts, "krajsky sud zilina").map((c) => c.id)).toEqual(["sud_130"]);
    expect(matchCourts(courts, "Mestský súd Bratislava I").map((c) => c.id)).toEqual(["sud_102"]);
    expect(matchCourts(courts, "Najvyšší súd").map((c) => c.id)).toEqual(["sud_175", "sud_100"]);
    expect(matchCourts(courts, "Najvyšší súd Slovenskej republiky").map((c) => c.id)).toEqual(["sud_100"]);
  });

  it("resolves aliases without a request and names through the court list", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(courts.map((c) => ({ id: c.id, nazov: c.name }))));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveCourt("ns")).toBe("sud_100");
    expect(await resolveCourt("NSS")).toBe("sud_175");
    expect(await resolveCourt("sud_139")).toBe("sud_139");
    expect(await resolveCourt("ns", "judikaty")).toBe("NSSR");
    expect(await resolveCourt("ÚS", "judikaty")).toBe("USSR");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await resolveCourt("Krajský súd v Žiline")).toBe("sud_130");
    expect(String(fetchMock.mock.calls[0]).includes("/vseobecne/sud?query=&limit=100")).toBe(true);
    await expect(resolveCourt("Bratislava")).rejects.toThrow(/matches 3 courts/);
    await expect(resolveCourt("Okresný súd Atlantída")).rejects.toThrow(/No Slovak court matches/);
  });
});

describe("sk_judikatura_search", () => {
  it("answers a sudy search with hits that name the next call", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(VSEOBECNE_FILTER));
    vi.stubGlobal("fetch", fetchMock);
    const result = await search({ query: "unikátny dotaz 1", limit: 5 });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/^840841 decisions \(všeobecné súdy SR\) by decision date, newest first — hits 1–5 \(page: 1 of 168169\):/);
    expect(text).toContain("1. 0T/55/2026 — Okresný súd Nové Zámky 2026-11-15");
    expect(text).toContain('→ sk_judikatura_get_decision {id: "6d2d9f0d-fbdf-4a50-80a5-c06f2ea19be8:c90209ae-6127-4694-b5d6-aaa60a41017f"}');
    expect(text).toContain("More: page: 2 (same arguments).");
    expect(result.structuredContent).toMatchObject({ total: 840841, count: 5, page: 1, total_pages: 168169, has_more: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("query=unik%C3%A1tny+dotaz+1&povahaRozhodnutiaFacetFilter=&ecli=&spisovaZnacka=&cisloSpisu=");
  });

  it("answers a judikaty search through the POST filter", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(JUDIKATY_FILTER));
    vi.stubGlobal("fetch", fetchMock);
    const result = await search({ database: "judikaty", query: "unikátny dotaz 2", court: "ns", limit: 5 });
    expect(result.content[0].text).toContain("100 decisions (Zbierka stanovísk a rozhodnutí (judikáty))");
    expect(result.content[0].text).toContain("1. 1Obo/10/2017 — Najvyšší súd SR (Rozsudok) 2018-05-15");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/judikaty/filter?page=1&size=5&sortBy=datumRozhodnutia&sortDirection=DESC");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ hladanyVyraz: "unikátny dotaz 2", sud: "NSSR" });
  });

  it("tries the other spelling of a judikát mark when the first finds nothing", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { spisovaZnacka?: string };
      bodies.push(body);
      return jsonResponse(body.spisovaZnacka === "6 Cdo 138/2016" ? { totalElements: 1, judikatList: [(JUDIKATY_FILTER as { judikatList: unknown[] }).judikatList[1]] } : { totalElements: 0, judikatList: [] });
    });
    const result = await search({ database: "judikaty", case_number: "6Cdo/138/2016" });
    expect(bodies.map((b) => (b as { spisovaZnacka: string }).spisovaZnacka)).toEqual(["6Cdo/138/2016", "6 Cdo 138/2016"]);
    expect(result.content[0].text).toContain("6 Cdo 138/2016");
  });

  it("says when a page is past the end and when nothing matched", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ page: { totalElements: 1, number: 1, size: 20, rozhodnutieList: [{ guid: GUID, spisovaZnacka: "30Ek/2848/2026", datumVydania: "16.11.2026" }] } }));
    const past = await search({ case_number: "30Ek/2848/2026", page: 5 });
    expect(past.content[0].text).toBe("Page 5 is past the end: 1 decisions fill pages 1–1 at limit 20. Call page: 1 or lower (same arguments).");
    expect(past.structuredContent).toMatchObject({ count: 0, has_more: false });

    vi.stubGlobal("fetch", async () => jsonResponse({ page: { totalElements: 0, rozhodnutieList: [] } }));
    const none = await search({ query: "neexistujúce slovo xyz" });
    expect(none.isError).toBeFalsy();
    expect(none.content[0].text).toMatch(/^No decisions matched/);
    expect(skJudikaturaSearchText({ database: "judikaty", total: 0, page: 1, totalPages: 1, hits: [] }, { page: 1, limit: 20 })).toContain('database: "sudy"');
  });

  it("refuses sudy-only filters on judikaty, before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await search({ database: "judikaty", applies_act: "40/1964", area: "Občianske právo" });
    expect(result.isError).toBe(true);
    expect(errorKind(result)).toBe("INPUT_INVALID");
    expect(result.content[0].text).toMatch(/area, applies_act/);
    expect(errorKind(await search({ applies_section: "§ 420" }))).toBe("INPUT_INVALID");
    expect(errorKind(await search({ date_from: "2026-01-01", date_to: "2025-01-01" }))).toBe("INPUT_INVALID");
    expect(errorKind(await search({ database: "judikaty", court: "nss" }))).toBe("INPUT_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("notes that applies_section is matched exactly", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ page: { totalElements: 0, rozhodnutieList: [] } }));
    const result = await search({ applies_act: "40/1964", applies_section: "§ 421" });
    expect(result.content[0].text).toMatch(/^applies_section matches references to exactly "§ 421"/);
  });

  it("reads a 401 as request drift and a filter 404 as drift too", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    expect(errorKind(await search({ query: "drift 401" }))).toBe("PARSE_DRIFT");
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(errorKind(await search({ query: "drift 404" }))).toBe("PARSE_DRIFT");
  });
});

describe("sk_judikatura_get_decision", () => {
  it("reads a všeobecný súd decision: detail, then its PDF through the converter", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("/vseobecne/")) return jsonResponse(VSEOBECNE_DETAIL);
      if (url.startsWith("https://obcan.justice.sk/")) return pdfResponse();
      return new Response("", { status: 500 });
    });
    const long = Array.from({ length: 12 }, (_, i) => `⟦s. ${i + 1}⟧\n${"Odôvodnenie súdu. ".repeat(300)}${i === 7 ? "exekútor poverený vykonaním exekúcie" : ""}`).join("\n\n");
    const pdf = vi.fn(async (_bytes: ArrayBuffer, range: [number, number]) => ({ text: long, pages: 70, range: [range[0], Math.min(range[1], 70)] as [number, number], warnings: [] }));
    setDocumentConverters({ pdf, docx: async () => "" });

    const first = await getDecision({ id: GUID });
    expect(first.isError).toBeFalsy();
    const text = first.content[0].text;
    expect(text.startsWith("30Ek/2848/2026 — Okresný súd Banská Bystrica — Uznesenie — 2026-11-16\nSudca: Mgr. Robert Schmidt")).toBe(true);
    expect(text).toContain("PDF: pages 1–60 of 70 converted.");
    expect(text).toContain("(page 1/2 — continue without asking the user: page: 2.");
    expect(first.structuredContent).toMatchObject({ id: GUID, kind: "sudy", format: "pdf", page: 1, total_pages: 2, has_more: true, pdf: { pages: 70, range: [1, 60] } });
    expect(calls[0]).toBe(`https://api-gateway.slov-lex.sk/internal/sudne-rozhodnutia/vseobecne/${GUID}`);

    const second = await getDecision({ id: GUID, page: 2 });
    expect(second.content[0].text).toContain('(continue without asking the user: pdf_pages: "61-70")');
    expect(pdf).toHaveBeenCalledTimes(1); // the converted text is cached

    const found = await getDecision({ id: GUID, find: "exekútor" });
    expect(found.structuredContent).toMatchObject({ matches: 1 });
    expect(found.content[0].text).toContain("exekútor poverený vykonaním exekúcie");

    await getDecision({ id: GUID, pdf_pages: "61-200" });
    expect(pdf).toHaveBeenLastCalledWith(expect.anything(), [61, 120]);
  });

  it("turns a scanned PDF into an error with the link", async () => {
    vi.stubGlobal("fetch", async (url: string) => (url.includes("/vseobecne/") ? jsonResponse(VSEOBECNE_DETAIL) : pdfResponse()));
    setDocumentConverters({ pdf: async () => ({ unavailable: "scan" }), docx: async () => "" });
    const result = await getDecision({ id: GUID, pdf_pages: "2-3" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scan without a text layer/);
    expect(result.content[0].text).toContain("https://obcan.justice.sk/content/public/item/14d33479-2681-4bdb-a0c8-650b57975714");
  });

  it("reports a decision without a file as NOT_FOUND with the web link", async () => {
    const other = "11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000";
    vi.stubGlobal("fetch", async () => jsonResponse({ ...(VSEOBECNE_DETAIL as object), guid: other, dokument: null }));
    const result = await getDecision({ id: other });
    expect(errorKind(result)).toBe("NOT_FOUND");
    expect(result.content[0].text).toContain(`vseobecne-sudy-sr/${other}`);
  });

  it("reads a judikát from its HTML, paged and with find", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(JUDIKAT_DETAIL));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDecision({ id: JUDIKAT, pdf_pages: "1-2" });
    const text = result.content[0].text;
    expect(text.startsWith("3Obdo/27/2018 — Najvyšší súd SR — Uznesenie — 2018-08-21")).toBe(true);
    expect(text).toContain("Odkazované predpisy: 160/2015 Z. z.; § 447 písm. c) 160/2015 Z. z.");
    expect(text).toContain("(pdf_pages ignored: a judikát is HTML, not a PDF.)");
    expect(text).toContain("Dovolací súd je pri posudzovaní prípustnosti dovolania");
    expect(text).not.toContain("﻿");
    expect(result.structuredContent).toMatchObject({ kind: "judikat", format: "html", url: `https://www.slov-lex.sk/sudne-rozhodnutia/judikaty/${JUDIKAT}` });
    const found = await getDecision({ id: JUDIKAT, find: "dovolania" });
    expect((found.structuredContent as { matches: number }).matches).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that is neither shape", async () => {
    expect(errorKind(await getDecision({ id: "3Obdo/27/2018" }))).toBe("INPUT_INVALID");
  });
});

describe("the captured decision PDF", () => {
  it("converts through the real pdf.js converter (not unavailable)", async () => {
    const bytes = PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset, PDF_BYTES.byteOffset + PDF_BYTES.byteLength) as ArrayBuffer;
    const result = await pdfText(bytes, { pageRange: [1, 60] });
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    expect(result.pages).toBeGreaterThan(0);
    expect(result.text).toMatch(/Okresný súd Banská Bystrica/i);
    expect(result.text).toContain("30Ek/2848/2026");
  }, 30_000);
});
