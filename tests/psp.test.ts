import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CURRENT_PERIOD,
  MAX_LISTING_PAGES,
  PDF_PAGES_PER_CALL,
  classifyDocument,
  getPspDocument,
  matchesQuery,
  parseListing,
  parseListingForm,
  parsePageLinks,
  parseTisk,
  parseTiskText,
  periodLabel,
  periodsForYear,
  queryStems,
  searchPsp,
  sniffDocument,
  tiskTextUrl,
  tiskUrl,
} from "@/src/sources/psp";
import { decodeHtmlBody, metaCharset } from "@/src/sources/shared/html";
import { parsePdfPages, registerPsp } from "@/src/mcp/tools/psp";

/**
 * psp.cz was not reachable from the development sandbox, so these fixtures
 * are SYNTHETIC: they follow the address patterns psp.cz has published for
 * years (historie.sqw?o=&t=, text/tiskt.sqw?O=&CT=&CT1=, text/orig2.sqw?idd=)
 * and a plausible markup, and they pin what the parsers may rely on — the
 * hrefs, never ids or table layout. To be replaced by live captures from
 * `dawmain_probe_sources {sources: ["psp"], include_raw: true}` and
 * `{discover: true}` (the tisky form dump) once a deployment reaches the site.
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "psp", name), "utf8");
const LISTING = fixture("listing.html");
const HISTORIE = fixture("historie.html");
const TISKT = fixture("tiskt.html");
const LISTING_URL = "https://www.psp.cz/sqw/tisky.sqw?o=9";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools: Record<string, Handler> = {};
registerPsp({ registerTool: (name: string, _config: unknown, handler: Handler) => void (tools[name] = handler) } as never);

afterEach(() => vi.unstubAllGlobals());

describe("periods", () => {
  it("maps a year to its period, two in an election year, none before 1993", () => {
    expect(periodsForYear(2011)).toEqual([6]);
    expect(periodsForYear(2013)).toEqual([6, 7]);
    expect(periodsForYear(2026)).toEqual([10]);
    expect(periodsForYear(1990)).toEqual([]);
    expect(CURRENT_PERIOD).toBe(10);
    expect(periodLabel(6)).toBe("6. volební období (2010–2013)");
    expect(periodLabel(10)).toBe("10. volební období (2025–dosud)");
  });

  it("builds the published address shapes", () => {
    expect(tiskUrl(6, 362)).toBe("https://www.psp.cz/sqw/historie.sqw?o=6&t=362");
    expect(tiskTextUrl(6, 362, 2)).toBe("https://www.psp.cz/sqw/text/tiskt.sqw?O=6&CT=362&CT1=2");
  });
});

describe("parseListing", () => {
  it("one hit per tisk from the historie anchors, title from the row, case-insensitive params", () => {
    const hits = parseListing(LISTING, LISTING_URL, 9);
    expect(hits.map((h) => h.number)).toEqual([999, 362, 363, 12]);
    const oz = hits.find((h) => h.number === 362)!;
    expect(oz.title).toBe("Vládní návrh občanského zákoníku");
    expect(oz.cells).toEqual(["Návrh zákona", "Schváleno, 89/2012 Sb."]);
    expect(oz.url).toBe("https://www.psp.cz/sqw/historie.sqw?o=9&t=362");
    expect(hits.find((h) => h.number === 12)!.title).toBe("Zpráva o činnosti Úřadu pro ochranu osobních údajů");
  });

  it("reads the page links the listing prints, never an assumed parameter", () => {
    const links = parsePageLinks(LISTING, LISTING_URL);
    expect([...links.entries()]).toEqual([
      [2, "https://www.psp.cz/sqw/tisky.sqw?o=9&str=2"],
      [3, "https://www.psp.cz/sqw/tisky.sqw?o=9&str=3"],
    ]);
  });

  it("finds the search form and its název/období/číslo fields by their labels", () => {
    const form = parseListingForm(LISTING, LISTING_URL);
    expect(form).toMatchObject({
      action: "https://www.psp.cz/sqw/tisky.sqw",
      method: "GET",
      nameField: "nazev",
      periodField: "o",
      numberField: "ct",
    });
    // Hidden inputs and the selected option travel along; the unchecked box and the submit button do not.
    expect(form!.fields).toEqual({ f: "N", o: "9", ct: "", nazev: "" });
  });

  it("falls back to the field names the site has used when labels are missing", () => {
    const html = '<form action="tisky.sqw"><input name="o" value="9"><input name="na"><input name="ct"></form>';
    expect(parseListingForm(html, LISTING_URL)).toMatchObject({ nameField: "na", periodField: "o", numberField: "ct" });
    expect(parseListingForm("<form><input name=\"q\"></form>", LISTING_URL)).toBeNull();
  });
});

describe("query matching", () => {
  it("stems: long words lose two letters, medium one, short none; * is a prefix", () => {
    expect(queryStems("Občanský zákoník daně x*")).toEqual(["obcans", "zakon", "dan", "x"]);
  });

  it("matches inflected titles, diacritics-insensitively", () => {
    const hit = { period: 9, number: 1, title: "Vládní návrh občanského zákoníku", cells: ["Návrh zákona"], url: "" };
    expect(matchesQuery(hit, queryStems("občanský zákoník"))).toBe(true);
    expect(matchesQuery(hit, queryStems("obcansky zakonik vladni"))).toBe(true);
    expect(matchesQuery(hit, queryStems("zákoník práce"))).toBe(false);
  });
});

describe("parseTisk", () => {
  it("title, the process text, and every document with the call that reads it", () => {
    const tisk = parseTisk(HISTORIE, tiskUrl(6, 362), 6, 362);
    expect(tisk.title).toBe("Sněmovní tisk 362");
    expect(tisk.text).toContain("1. čtení");
    expect(tisk.text).toContain("pod číslem 89/2012 Sb.");
    // Chrome is stripped: the content container is taken, not the nav or footer.
    expect(tisk.text).not.toContain("Kancelář Poslanecké sněmovny");
    const kinds = tisk.documents.map((d) => [d.kind, d.format, d.part?.part ?? d.documentId]);
    expect(kinds).toEqual([
      ["text tisku", "HTML", 0],
      ["návrh zákona", "soubor", 71122],
      ["návrh zákona", "PDF", 71122],
      ["důvodová zpráva", "soubor", 71123],
      ["rozdílová tabulka", "PDF", 71124],
      ["platné znění s vyznačením změn", "soubor", 71125],
      ["usnesení", "HTML", 2],
    ]);
    expect(tisk.documents[0].part).toEqual({ period: 6, number: 362, part: 0 });
    // A link that only says "PDF" is labelled by its line.
    expect(tisk.documents[4].label).toMatch(/^Rozdílová tabulka/);
  });

  it("refuses a page with neither document links nor the word tisk as drift", () => {
    expect(() => parseTisk("<html><body><h1>Chyba</h1><p>Stránka nenalezena.</p></body></html>", tiskUrl(9, 1), 9, 1)).toThrow(/PARSE_DRIFT|not a tisk page/);
  });

  it("classifies labels by their words", () => {
    expect(classifyDocument("RIA - závěrečná zpráva z hodnocení dopadů regulace")).toBe("RIA");
    expect(classifyDocument("Pozměňovací návrhy přednesené ve druhém čtení")).toBe("pozměňovací návrhy");
    expect(classifyDocument("Stanovisko vlády")).toBe("stanovisko");
    expect(classifyDocument("Příloha č. 3")).toBe("dokument");
  });
});

describe("parseTiskText", () => {
  it("returns the bill and its důvodová zpráva as text without the menu", () => {
    const text = parseTiskText(TISKT);
    expect(text).toContain("§ 1 (1) Ustanovení právního řádu");
    expect(text).toContain("DŮVODOVÁ ZPRÁVA");
    expect(text).toContain("K § 1: Ustanovení vymezuje předmět úpravy.");
    expect(text).not.toContain("Úvod");
  });
});

describe("charset", () => {
  it("reads the charset from <meta> when the header names none", async () => {
    expect(metaCharset('<meta http-equiv="Content-Type" content="text/html; charset=windows-1250">')).toBe("windows-1250");
    expect(metaCharset('<meta charset="UTF-8">')).toBe("utf-8");
    expect(metaCharset("<html><head></head>")).toBeNull();
    const cp1250 = new TextEncoder().encode("x"); // placeholder, replaced below
    void cp1250;
    // "Sněmovní" in windows-1250: ě = 0xEC, í = 0xED.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=windows-1250"><p>Sn'),
      0xec,
      ...new TextEncoder().encode("movn"),
      0xed,
      ...new TextEncoder().encode("</p>"),
    ]);
    const decoded = await decodeHtmlBody(new Response(bytes, { headers: { "content-type": "text/html" } }));
    expect(decoded).toContain("<p>Sněmovní</p>");
    // A header charset wins over the meta.
    const utf = await decodeHtmlBody(new Response(new TextEncoder().encode("<p>Sněmovní</p>"), { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(utf).toContain("Sněmovní");
  });
});

describe("sniffDocument", () => {
  it("tells PDF, DOCX, legacy DOC, RTF and HTML apart by their bytes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffDocument(enc("%PDF-1.7 …"))).toBe("pdf");
    expect(sniffDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("docx");
    expect(sniffDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("doc");
    expect(sniffDocument(enc("{\\rtf1\\ansi"))).toBe("rtf");
    expect(sniffDocument(enc("<!DOCTYPE html><html>…"))).toBe("html");
    expect(sniffDocument(enc("plain words"))).toBe("unknown");
  });
});

describe("searchPsp — the listing is scanned and filtered here, whatever the site did with the filter", () => {
  /** A listing whose rows are given; page links to `pages` pages. */
  const listing = (rows: Array<[number, string]>, page: number, pages: number, o = 9) =>
    `<html><body><div id="main"><form action="/sqw/tisky.sqw"><select name="o"><option value="${o}" selected>${o}</option></select><input name="nazev"></form>
     <table>${rows.map(([n, t]) => `<tr><td><a href="historie.sqw?o=${o}&t=${n}">${n}/0</a></td><td>${t}</td><td>Návrh zákona</td></tr>`).join("")}</table>
     <p>${Array.from({ length: pages }, (_, i) => (i + 1 === page ? `<b>${page}</b>` : `<a href="tisky.sqw?o=${o}&str=${i + 1}">${i + 1}</a>`)).join(" ")}</p></div></body></html>`;

  it("submits the site's own form, then reads further pages until the page has enough hits", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        const str = Number(new URL(url).searchParams.get("str") ?? "1");
        // The site ignores the filter: every page lists everything.
        const rows: Array<[number, string]> = [
          [100 * str + 1, `Vládní návrh zákona o dani z příjmů (${str})`],
          [100 * str + 2, `Návrh zákona, kterým se mění zákoník práce zzscan (${str})`],
        ];
        return new Response(listing(rows, str, 3), { headers: { "content-type": "text/html; charset=utf-8" } });
      }),
    );
    const result = await searchPsp({ query: "zákoník práce zzscan", period: 9 }, 5);
    // Home page first (for the form), then the form submitted with the title words in the název field.
    expect(urls[0]).toBe("https://www.psp.cz/sqw/tisky.sqw?o=9");
    expect(urls[1]).toBe("https://www.psp.cz/sqw/tisky.sqw?o=9&nazev=z%C3%A1kon%C3%ADk+pr%C3%A1ce+zzscan");
    // Only the matching row of every page; all three pages were needed for 5 hits and gave 3.
    expect(result.hits.map((h) => h.number)).toEqual([102, 202, 302]);
    expect(result.hits[0].title).toBe("Návrh zákona, kterým se mění zákoník práce zzscan (1)");
    expect(result.pagesScanned).toBe(3);
    expect(result.listingTruncated).toBe(false);
    expect(result.serverFilter).toBe("form");
  });

  it("stops at the page cap and says the listing went on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const str = Number(new URL(String(input)).searchParams.get("str") ?? "1");
        return new Response(listing([[str, `Jiný tisk ${str}`]], str, 40), { headers: { "content-type": "text/html" } });
      }),
    );
    const result = await searchPsp({ query: "nenajde se zzcap", period: 9 }, 5);
    expect(result.hits).toEqual([]);
    expect(result.pagesScanned).toBe(MAX_LISTING_PAGES);
    expect(result.listingTruncated).toBe(true);
  });

  it("psp_search text: hits with their calls, paging, the scan report; year → both periods of an election year", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const o = url.searchParams.get("o");
        const rows: Array<[number, string]> = o === "6" ? [[362, "Vládní návrh občanského zákoníku zzyear"]] : [[5, "Něco jiného"]];
        return new Response(listing(rows, 1, 1, Number(o)), { headers: { "content-type": "text/html" } });
      }),
    );
    const result = await tools.psp_search({ query: "občanský zákoník zzyear", year: 2013, limit: 10, page: 1 });
    const text = result.content[0].text;
    expect(text).toContain('1 sněmovní tisky with every word of "občanský zákoník zzyear" in the 6. volební období (2010–2013) — hits 1–1 (page 1; listing pages read: 1 (the whole listing)):');
    expect(text).toContain("1. Tisk 362 (6. období) — Vládní návrh občanského zákoníku zzyear · Návrh zákona\n   https://www.psp.cz/sqw/historie.sqw?o=6&t=362");
    expect(text).toContain("psp_get_tisk {period: 6, number: N}");
    expect(text).toContain("No sněmovní tisk in the 7. volební období (2013–2017) has every word");
    expect(text).not.toContain("More:");
    expect(result.structuredContent).toMatchObject({ periods: [{ period: 6, count: 1 }, { period: 7, count: 0 }] });
  });

  it("psp_search refuses a call with neither query nor number, and a year before 1993, without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await tools.psp_search({ limit: 10, page: 1 })).isError).toBe(true);
    const early = await tools.psp_search({ query: "x", year: 1990, limit: 10, page: 1 });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("1993");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("psp_get_tisk and psp_get_text", () => {
  it("lists the process and every document with its reading call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(HISTORIE, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const result = await tools.psp_get_tisk({ period: 6, number: 362, page: 1 });
    const text = result.content[0].text;
    expect(text).toMatch(/^Sněmovní tisk 362, 6\. volební období \(2010–2013\) — Sněmovní tisk 362\nhttps:\/\/www\.psp\.cz\/sqw\/historie\.sqw\?o=6&t=362\n/);
    expect(text).toContain("Zákon vyhlášen 22. 3. 2012");
    expect(text).toContain("Documents (7)");
    expect(text).toContain("1. [text tisku] Sněmovní tisk 362/0, část č. 1/12 (HTML) → psp_get_text {period: 6, number: 362, part: 0}");
    expect(text).toContain("5. [rozdílová tabulka] Rozdílová tabulka — PDF (PDF) → psp_get_text {document_id: 71124}");
    expect(result.structuredContent).toMatchObject({ number: 362, documents: expect.arrayContaining([expect.objectContaining({ document_id: 71124 })]) });
  });

  it("reads a part of the tisk as text, with find", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(TISKT, { headers: { "content-type": "text/html; charset=utf-8" } })));
    const whole = await tools.psp_get_text({ period: 6, number: 362, part: 0, page: 1 });
    expect(whole.content[0].text).toMatch(/^https:\/\/www\.psp\.cz\/sqw\/text\/tiskt\.sqw\?O=6&CT=362&CT1=0\n\n/);
    expect(whole.content[0].text).toContain("DŮVODOVÁ ZPRÁVA");
    const found = await tools.psp_get_text({ period: 6, number: 362, part: 0, page: 1, find: "predmet upravy" });
    expect(found.content[0].text).toContain("K § 1: Ustanovení vymezuje předmět úpravy.");
    expect(found.structuredContent).toMatchObject({ matches: 1 });
  });

  it("refuses a call with neither document_id nor number, and a number without its period", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await tools.psp_get_text({ part: 0, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("document_id");
    const noPeriod = await tools.psp_get_text({ number: 362, part: 0, page: 1 });
    expect(noPeriod.isError).toBe(true);
    expect(noPeriod.content[0].text).toContain("without period");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses pdf_pages, capped at the per-call page count", () => {
    expect(parsePdfPages(undefined)).toEqual([1, PDF_PAGES_PER_CALL]);
    expect(parsePdfPages("61-120")).toEqual([61, 120]);
    expect(parsePdfPages("61")).toEqual([61, 60 + PDF_PAGES_PER_CALL]);
    expect(parsePdfPages("1-500")).toEqual([1, PDF_PAGES_PER_CALL]);
    expect(parsePdfPages("0-3")).toEqual([1, 3]);
  });
});

describe("getPspDocument — attached files", () => {
  const converters = {
    pdf: vi.fn(async (_bytes: ArrayBuffer, range: [number, number]) => ({ text: `⟦s. ${range[0]}⟧ Rozdílová tabulka…`, pages: 130, range, warnings: [] })),
    docx: vi.fn(async () => "Důvodová zpráva\n\nObecná část"),
  };

  it("DOCX through mammoth, PDF through the converter with the page range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("idd=71123")) return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
        if (url.includes("idd=71124")) return new Response(new TextEncoder().encode("%PDF-1.4 fake"));
        return new Response("?", { status: 404 });
      }),
    );
    const docx = await getPspDocument(71123, undefined, converters);
    expect(docx).toMatchObject({ format: "docx", text: "Důvodová zpráva\n\nObecná část" });
    const pdf = await getPspDocument(71124, [61, 120], converters);
    expect(pdf).toMatchObject({ format: "pdf", pdf: { pages: 130, range: [61, 120] } });
    expect(converters.pdf).toHaveBeenCalledWith(expect.anything(), [61, 120]);
  });

  it("a legacy .doc is fetched again as the PDF rendition; without one the caller is sent to the file", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("idd=71122&pdf=1")) return new Response(new TextEncoder().encode("%PDF-1.4 rendition"));
        if (url.includes("idd=71129&pdf=1")) return new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
        return new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      }),
    );
    const doc = await getPspDocument(71122, undefined, converters);
    expect(doc.format).toBe("pdf");
    expect(urls.slice(0, 2)).toEqual(["https://www.psp.cz/sqw/text/orig2.sqw?idd=71122", "https://www.psp.cz/sqw/text/orig2.sqw?idd=71122&pdf=1"]);
    await expect(getPspDocument(71129, undefined, converters)).rejects.toThrow(/legacy Word \(\.doc\)/);
  });

  it("psp_get_text on a PDF says which pages it converted and how to go on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("%PDF-1.4 fake-two"))));
    // The default converters would load pdf.js; the fixture is no PDF, so an
    // unavailable verdict is what the real converter would give — the text
    // of that answer is what this checks.
    const result = await tools.psp_get_text({ document_id: 71130, part: 0, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Document 71130: the PDF (could not be parsed|is a scan without a text layer)\./);
    expect(result.content[0].text).toContain("Open it yourself: https://www.psp.cz/sqw/text/orig2.sqw?idd=71130");
  });
});
