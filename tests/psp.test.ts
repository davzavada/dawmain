import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CURRENT_PERIOD,
  PDF_PAGES_PER_CALL,
  PSP_TYPES,
  RESULTS_PER_PAGE,
  buildSearchUrl,
  classifyDocument,
  getPspDocument,
  mainDocument,
  parseActNumber,
  parseListing,
  parseListingForm,
  parsePageLinks,
  parseSearchResults,
  parseTisk,
  parseTiskText,
  periodLabel,
  periodsForYear,
  searchPsp,
  setDocumentConverters,
  sniffDocument,
  tiskTextUrl,
  tiskUrl,
} from "@/src/sources/psp";
import { decodeHtmlBody, metaCharset } from "@/src/sources/shared/html";
import { parsePdfPages, registerPsp } from "@/src/mcp/tools/psp";

/**
 * Every fixture in tests/fixtures/psp/ is a LIVE CAPTURE (HAR from the
 * user's browser, 2026-10): the search form page (sntisk-10.html), a
 * results page with one hit (tisky-search-sbirka.html), an empty one
 * (tisky-search-empty.html), page 2 of a 1 856-hit search
 * (tisky-search-page2.html), the historie.sqw page of tisk 50/10
 * (historie-10-50.html) and the tiskt.sqw pages of tisky 50/10, 362/6 and
 * 1110/4 (tiskt-*.html — none sets text inline; the text is the file).
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "psp", name), "utf8");
const SBIRKA = fixture("tisky-search-sbirka.html");
const EMPTY = fixture("tisky-search-empty.html");
const TISKT_1110 = fixture("tiskt-4-1110.html");
const TISKT_50 = fixture("tiskt-10-50.html");
const TISKT_362 = fixture("tiskt-6-362.html");
const HISTORIE_50 = fixture("historie-10-50.html");
const PAGE2 = fixture("tisky-search-page2.html");
const PAGE2_URL = "https://www.psp.cz/sqw/tisky.sqw?str=2&o=9&utq=1&tqq=1:2,27:1,28:1,29:1,30:1,31:1,32:1,33:1,34:1,35:1,62:1,63:1,64:1&na=zakon";
const SNTISK = fixture("sntisk-10.html");
const SBIRKA_URL =
  "https://www.psp.cz/sqw/tisky.sqw?tqb1=1&utq=2&o=9&tqb2=0&tqb3=15&tqb21=1&tqb7=1761&tqb23=1&tqb24=1&tqb8=1&tqb9=1&tqb10=1&tqb11=1&tqb12=1&tqb13=1&tqb14=1&tqb20=1&tqb22=1&tqb16=7&tqb18=221&tqb19=2006&ra=20";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools: Record<string, Handler> = {};
registerPsp({ registerTool: (name: string, _config: unknown, handler: Handler) => void (tools[name] = handler) } as never);

/** A fetch stub answering with a captured page as psp.cz serves it (Windows-1250 header; the fixtures are stored as UTF-8). */
const html = (body: string, status = 200) => new Response(new TextEncoder().encode(body), { status, headers: { "content-type": "text/html; charset=utf-8" } });

afterEach(() => {
  vi.unstubAllGlobals();
  setDocumentConverters();
});

describe("periods and addresses", () => {
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
    expect(tiskUrl(4, 1110)).toBe("https://www.psp.cz/sqw/historie.sqw?o=4&t=1110");
    expect(tiskTextUrl(4, 1110, 0)).toBe("https://www.psp.cz/sqw/text/tiskt.sqw?O=4&CT=1110&CT1=0");
  });
});

describe("buildSearchUrl — the form as the browser sends it (HAR 2026-10)", () => {
  it("title + number search: the Vše tab, every druh tisku on, ra rows", () => {
    const url = new URL(buildSearchUrl({ query: "text", number: 52, period: 9 }));
    expect(url.pathname).toBe("/sqw/tisky.sqw");
    const p = url.searchParams;
    expect([p.get("tqb1"), p.get("utq"), p.get("o"), p.get("na"), p.get("tqb25"), p.get("tqb26")]).toEqual(["2", "2", "9", "text", "52", ""]);
    for (const [name] of Object.values(PSP_TYPES)) expect(p.get(name)).toBe("on");
    expect(p.get("ra")).toBe(String(RESULTS_PER_PAGE));
    expect(p.get("tqa17")).toBeNull();
  });

  it("types narrow the checkboxes; only_pending ticks tqa17", () => {
    const p = new URL(buildSearchUrl({ query: "x", period: 9, types: ["bills", "amendments"], onlyPending: true })).searchParams;
    expect(p.get("tqa27")).toBe("on");
    expect(p.get("tqa34")).toBe("on");
    expect(p.get("tqa28")).toBeNull();
    expect(p.get("tqa17")).toBe("on");
  });

  it("the Sbírka lookup: the návrhy-zákonů tab with the captured defaults and tqb18/tqb19", () => {
    const url = buildSearchUrl({ act: "č. 221/2006 Sb.", period: 9 });
    const expected = new URL(SBIRKA_URL).searchParams;
    const got = new URL(url).searchParams;
    for (const [key, value] of expected) expect(got.get(key), key).toBe(key === "ra" ? String(RESULTS_PER_PAGE) : value);
    expect(parseActNumber("89/2012")).toEqual({ number: "89", year: "2012" });
    expect(() => parseActNumber("občanský zákoník")).toThrow(/not a Sbírka citation/);
  });
});

describe("parseSearchResults — captured pages", () => {
  it("reads the count line and the row: number from the historie anchor, title, druh, Sbírka number, the row's own period", () => {
    const page = parseSearchResults(SBIRKA, SBIRKA_URL, 9);
    expect(page.total).toBe(1);
    expect(page.hits).toEqual([
      {
        period: 4,
        number: 1110,
        part: 0,
        title: "Vl.n.z. o vymáhání práv z průmyslového vlastnictví - EU",
        cells: ["Vládní návrh zákona", "221/2006 Sb."],
        url: "https://www.psp.cz/sqw/historie.sqw?o=4&t=1110",
      },
    ]);
  });

  it("an empty answer is the site's own 'nebyl nalezen žádný tisk', not drift", () => {
    expect(parseSearchResults(EMPTY, SBIRKA_URL, 9)).toEqual({ total: 0, hits: [] });
  });

  it("a page with neither count nor form is drift", () => {
    expect(() => parseSearchResults("<html><body><p>Chyba serveru</p></body></html>", SBIRKA_URL, 9)).toThrow(/neither a result count nor the search form/);
  });

  it("reads the search form's fields as discover reports them (na, o, tqb25 by their labels)", () => {
    const form = parseListingForm(EMPTY, SBIRKA_URL);
    expect(form).toMatchObject({ action: "https://www.psp.cz/sqw/tisky.sqw", method: "GET", nameField: "na", periodField: "o", numberField: "tqb25" });
    expect(form!.fields).toMatchObject({ tqb1: "2", utq: "2", o: "9", na: "text", tqb25: "52", tqa27: "on", ra: "20" });
    expect(form!.fields).not.toHaveProperty("tqa17");
  });

  it("page 2 of a 1 856-hit search: the count, 20 rows with their parts (11/0 and the stanovisko vlády 11/1 apart), the page links as printed", () => {
    const page = parseSearchResults(PAGE2, PAGE2_URL, 9);
    expect(page.total).toBe(1856);
    expect(page.hits).toHaveLength(20);
    expect(page.hits.slice(0, 2)).toEqual([
      { period: 9, number: 11, part: 0, title: "Novela z. - občanský zákoník", cells: ["Poslanecký návrh zákona", "1. čtení"], url: "https://www.psp.cz/sqw/historie.sqw?o=9&t=11" },
      { period: 9, number: 11, part: 1, title: "Stanovisko vlády k tisku 11/0", cells: ["Návrh zákona", "Nesouhlas"], url: "https://www.psp.cz/sqw/historie.sqw?o=9&t=11" },
    ]);
    // Numeric anchors to the same script (str=1, 3–6); "<<", ">" and ">>" are not pages.
    const links = parsePageLinks(PAGE2, PAGE2_URL);
    expect([...links.keys()]).toEqual([1, 3, 4, 5, 6]);
    expect(links.get(3)).toBe("https://www.psp.cz/sqw/tisky.sqw?str=3&o=9&utq=1&tqq=1:2,27:1,28:1,29:1,30:1,31:1,32:1,33:1,34:1,35:1,62:1,63:1,64:1&na=zakon");
  });

  it("the search form page (sntisk.sqw) reads the same way, with every druh tisku on", () => {
    const form = parseListingForm(SNTISK, "https://www.psp.cz/sqw/sntisk.sqw?o=10");
    expect(form).toMatchObject({ action: "https://www.psp.cz/sqw/tisky.sqw", nameField: "na", periodField: "o", numberField: "tqb25" });
    expect(form!.fields).toMatchObject({ o: "10", tqa27: "on", tqa35: "on", ra: "20" });
  });

  it("parseListing tolerates a row whose number anchor has no title cell", () => {
    const hits = parseListing('<ul><li><a href="historie.sqw?o=9&t=5">Zpráva o stavu</a></li></ul>', "https://www.psp.cz/sqw/tisky.sqw", 9);
    expect(hits).toEqual([{ period: 9, number: 5, part: 0, title: "Zpráva o stavu", cells: [], url: "https://www.psp.cz/sqw/historie.sqw?o=9&t=5" }]);
  });
});

describe("parseTiskText — captured tiskt.sqw pages: the text is a file, never on the page", () => {
  it("tisk 50/10: the whole-tisk PDF and the files grouped under their headings; the DOCX of the first group is the text", () => {
    const result = parseTiskText(TISKT_50, tiskTextUrl(10, 50, 0), 10, 50);
    expect(result.title).toBe("Sněmovní tisk 50/0 — Novela z. o důchodovém pojištění");
    expect(result.text).toBe("");
    expect(result.documents.map((d) => [d.documentId, d.format, d.kind, d.label])).toEqual([
      [266807, "PDF", "celý tisk", "Celý sněmovní tisk (PDF, 1 MB)"],
      [266804, "PDF", "návrh zákona s důvodovou zprávou", "Návrh zákona včetně důvodové zprávy — t005000.pdf (Dokument PDF, 1 MB)"],
      [266803, "DOCX", "návrh zákona s důvodovou zprávou", "Návrh zákona včetně důvodové zprávy — t005000.docx (Dokument DOCX, 52 KB)"],
      [266806, "PDF", "platné znění s vyznačením změn", "Platné znění s vyznačením změn — t0050a0.pdf (Dokument PDF, 234 KB)"],
      [266805, "DOCX", "platné znění s vyznačením změn", "Platné znění s vyznačením změn — t0050a0.docx (Dokument DOCX, 28 KB)"],
    ]);
    expect(mainDocument(result.documents)?.documentId).toBe(266803);
  });

  it("tisk 362/6 (občanský zákoník): a PDF rendition and bare .doc files — the PDF rendition is the text", () => {
    const result = parseTiskText(TISKT_362, tiskTextUrl(6, 362, 0), 6, 362);
    expect(result.title).toBe("Sněmovní tisk 362/0 — Vl.n.z. - občanský zákoník - EU");
    expect(result.documents.map((d) => [d.documentId, d.format, d.kind, d.label])).toEqual([
      [71122, "PDF", "celý tisk", "Verze PDF (9.6 MB)"],
      [71122, "soubor", "dokument", "t036200.doc"],
      [71123, "soubor", "dokument", "t0362a0.doc"],
    ]);
    expect(mainDocument(result.documents)?.url).toBe("https://www.psp.cz/sqw/text/orig2.sqw?idd=71122&pdf=1");
  });

  it("tisk 1110/4: 'Originál dokumentu' with its size, 'Verze PDF', and the attachments by document_id", () => {
    const result = parseTiskText(TISKT_1110, tiskTextUrl(4, 1110, 0), 4, 1110);
    expect(result.title).toBe("Sněmovní tisk 1110/0, část č. 1/3 — Vl.n.z. o vymáhání práv z průmyslového vlastnictví - EU");
    expect(result.text).toBe("");
    expect(result.documents.map((d) => [d.documentId, d.format, d.label])).toEqual([
      [14683, "soubor", "Originál dokumentu (DOC, 171.5 KB)"],
      [14683, "PDF", "Verze PDF (393.2 KB)"],
      [14687, "soubor", "t1110a0.doc"],
      [14688, "soubor", "t1110b0.doc"],
    ]);
    expect(mainDocument(result.documents)?.documentId).toBe(14683);
  });

  it("a page with text set inline (none captured) keeps it, without the menu", () => {
    const inline = '<html><body><div id="menu"><a href="/sqw/hp.sqw">Úvod</a></div><div id="main-content"><h1>Sněmovní tisk 1/0</h1><p>§ 1 Text návrhu zákona, který je delší než osmdesát znaků, aby se počítal za obsah stránky.</p><h2>DŮVODOVÁ ZPRÁVA</h2><p>K § 1: Ustanovení vymezuje předmět úpravy.</p></div></body></html>';
    const result = parseTiskText(inline, tiskTextUrl(9, 1, 0), 9, 1);
    expect(result.text).toContain("K § 1: Ustanovení vymezuje předmět úpravy.");
    expect(result.text).not.toContain("Úvod");
    expect(result.documents).toEqual([]);
  });
});

describe("parseTisk — captured historie.sqw of tisk 50/10", () => {
  it("title, the date of the state, the stage line, the sections' text without the stage marks, the acts amended", () => {
    const tisk = parseTisk(HISTORIE_50, tiskUrl(10, 50), 10, 50);
    expect(tisk.title).toBe("Sněmovní tisk 50 — Novela z. o důchodovém pojištění");
    expect(tisk.asOf).toBe("Stav projednávání ke dni: 20. října 2026");
    expect(tisk.stages).toBe(
      "Předkladatel → PS: Předseda sněmovny ✓ → Vláda: Vláda ✓ → Poslanecká sněmovna: Organizační výbor ▶, 1. čtení, Výbory, 2. čtení, Garanční výbor, 3. čtení → Senát: Předseda Senátu, Organizační výbor, Výbory, Senát → Prezident: Prezident → Zákon",
    );
    expect(tisk.text).toContain("Předkladatel\nSkupina poslanců předložila sněmovně návrh zákona 5. 12. 2025.");
    expect(tisk.text).toContain("Stanovisko vlády rozesláno poslancům 17. 2. 2026 jako tisk 50/1 (nesouhlas).");
    expect(tisk.text).toContain("Organizační výbor projednání návrhu zákona doporučil 19. 2. 2026 (usnesení č. 31).");
    expect(tisk.text).not.toMatch(/\bPSNávrh|\bVL Návrh|\bO Organizační/);
    expect(tisk.text).not.toContain("Vysvětlení legislativního procesu");
    expect(tisk.amendedActsUrl).toBe("https://www.psp.cz/sqw/historie.sqw?o=10&t=50&snzp=1");
  });

  it("documents: the parts by the sentence that names them, the Parlamentní institut opinion, a committee resolution (v=ORGV) is no part", () => {
    const tisk = parseTisk(HISTORIE_50, tiskUrl(10, 50), 10, 50);
    expect(tisk.documents.map((d) => [d.kind, d.format, d.part?.part ?? d.documentId ?? null, d.label])).toEqual([
      ["návrh zákona", "HTML", 0, "tisk 50/0 — Návrh zákona rozeslán poslancům jako tisk 50/0 dne 16. 1. 2026."],
      ["stanovisko", "HTML", 268537, "Parlamentní institut vypracoval stanovisko ke kompatibilitě tisku s právem EU 0050."],
      ["stanovisko", "HTML", 1, "tisk 50/1 — Stanovisko vlády rozesláno poslancům 17. 2. 2026 jako tisk 50/1 (nesouhlas)."],
      ["usnesení", "HTML", null, "Organizační výbor projednání návrhu zákona doporučil 19. 2. 2026 (usnesení č. 31)."],
    ]);
    expect(tisk.documents[0].part).toEqual({ period: 10, number: 50, part: 0 });
    expect(tisk.documents[2].part).toEqual({ period: 10, number: 50, part: 1 });
    expect(tisk.documents[3].url).toBe("https://www.psp.cz/sqw/text/tiskt.sqw?o=10&v=ORGV&ct=31");
  });

  it("refuses a page with neither document links nor the word tisk as drift", () => {
    expect(() => parseTisk("<html><body><h1>Chyba</h1><p>Stránka nenalezena.</p></body></html>", tiskUrl(9, 1), 9, 1)).toThrow(/not a tisk page/);
  });

  it("classifies labels by their words", () => {
    expect(classifyDocument("RIA - závěrečná zpráva z hodnocení dopadů regulace")).toBe("RIA");
    expect(classifyDocument("Rozdílová tabulka — t0050b0.docx")).toBe("rozdílová tabulka");
    expect(classifyDocument("Pozměňovací návrhy přednesené ve druhém čtení")).toBe("pozměňovací návrhy");
    expect(classifyDocument("Stanovisko vlády")).toBe("stanovisko");
    expect(classifyDocument("Příloha č. 3")).toBe("dokument");
  });
});

describe("charset", () => {
  it("reads the charset from <meta> when the header names none; a header charset wins", async () => {
    expect(metaCharset('<meta http-equiv="Content-Type" content="text/html; charset=windows-1250">')).toBe("windows-1250");
    expect(metaCharset('<meta charset="UTF-8">')).toBe("utf-8");
    expect(metaCharset("<html><head></head>")).toBeNull();
    // "Sněmovní" in windows-1250: ě = 0xEC, í = 0xED.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=windows-1250"><p>Sn'),
      0xec,
      ...new TextEncoder().encode("movn"),
      0xed,
      ...new TextEncoder().encode("</p>"),
    ]);
    expect(await decodeHtmlBody(new Response(bytes, { headers: { "content-type": "text/html" } }))).toContain("<p>Sněmovní</p>");
    // psp.cz names Windows-1250 in the header (captured): the header decides.
    const headerBytes = new Uint8Array([...new TextEncoder().encode("<p>Sn"), 0xec, ...new TextEncoder().encode("movn"), 0xed, ...new TextEncoder().encode("</p>")]);
    expect(await decodeHtmlBody(new Response(headerBytes, { headers: { "content-type": "text/html; charset=Windows-1250" } }))).toContain("Sněmovní");
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

describe("searchPsp and psp_search", () => {
  /** A results page in the captured shape with the given rows, a count line and numeric page links. */
  const results = (rows: Array<[number, number, string]>, total: number, page: number, pages: number) =>
    `<html><body><div id="main-content"><form action="tisky.sqw" method="GET" id="form-press-search"><input type="hidden" name="o" value="9"><input type="text" name="na"></form>
     Celkem nalezeno ${total} tisků. <TABLE>${rows.map(([o, n, t]) => `<TR><TD><A HREF=historie.sqw?o=${o}&T=${n}>${n}</A>/0</TD><TD><A HREF="/sqw/text/tiskt.sqw?O=${o}&CT=${n}&CT1=0">${t}</A></TD><TD>Vládní návrh zákona</TD><td>1. čtení</td></TR>`).join("")}</TABLE>
     <p>${Array.from({ length: pages }, (_, i) => (i + 1 === page ? `<b>${page}</b>` : `<a href="tisky.sqw?o=9&str=${i + 1}">${i + 1}</a>`)).join(" ")}</p></div></body></html>`;

  it("the act lookup answers from the captured page: tisk 1110 of the 4th period, whatever period the form was opened in", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => (urls.push(String(input)), html(SBIRKA))));
    const result = await tools.psp_search({ act: "221/2006 Sb.", only_pending: false, limit: 10, page: 1 });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("tqb18")).toBe("221");
    const text = result.content[0].text;
    expect(text).toContain("1 sněmovní tisky with the bill of act 221/2006 Sb. — hits 1–1 (page 1):");
    expect(text).toContain("1. Tisk 1110/0 (4. období) — Vl.n.z. o vymáhání práv z průmyslového vlastnictví - EU · Vládní návrh zákona · 221/2006 Sb.\n   https://www.psp.cz/sqw/historie.sqw?o=4&t=1110");
    expect(text).toContain("psp_get_tisk {period, number}");
    expect(result.structuredContent).toMatchObject({ total: 1, count: 1, truncated: false, other_periods: 0 });
  });

  it("an empty answer says what was searched and how to re-aim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(EMPTY)));
    const result = await tools.psp_search({ query: "text", number: 52, period: 9, only_pending: false, limit: 10, page: 1 });
    expect(result.content[0].text).toMatch(/^No sněmovní tisk with title containing "text", number 52 in the 9\. volební období \(2021–2025\)\./);
    expect(result.content[0].text).toContain('act: "89/2012"');
  });

  it("a period filter keeps only that period's hits and counts the rest; year searches both periods of an election year", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        calls.push(String(input));
        return html(results([[6, 362, "Vládní návrh občanského zákoníku zzyear"], [7, 50, "Novela občanského zákoníku zzyear"]], 2, 1, 1));
      }),
    );
    const one = await tools.psp_search({ query: "občansk zzyear", period: 6, only_pending: false, limit: 10, page: 1 });
    expect(one.content[0].text).toContain("1 sněmovní tisky with title containing \"občansk zzyear\" in the 6. volební období (2010–2013) (+1 in other periods — call without period/year to see them)");
    expect(one.structuredContent).toMatchObject({ count: 1, other_periods: 1 });
    const both = await tools.psp_search({ query: "občansk zzyear", year: 2013, only_pending: false, limit: 10, page: 1 });
    // The o=6 page came from the per-URL cache of the first call; the 7th period's page was fetched anew.
    expect([...new Set(calls.filter((u) => u.includes("zzyear")).map((u) => new URL(u).searchParams.get("o")))]).toEqual(["6", "7"]);
    expect(both.content[0].text).toContain("in the 6. volební období (2010–2013) and 7. volební období (2013–2017)");
    expect(both.structuredContent).toMatchObject({ count: 2, other_periods: 0 });
  });

  it("follows the page links the results print when the site counts more, and reports what it could not reach", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const str = Number(new URL(String(input)).searchParams.get("str") ?? "1");
        return html(results([[9, 100 + str, `Tisk zzpaging ${str}`]], 30, str, 30));
      }),
    );
    const result = await searchPsp({ query: "zzpaging", period: 9 }, 25);
    expect(result.total).toBe(30);
    expect(result.hits.map((h) => h.number)).toEqual([101, 102, 103, 104, 105, 106]);
    expect(result.pagesScanned).toBe(6);
    expect(result.truncated).toBe(true);
    const text = (await tools.psp_search({ query: "zzpaging", period: 9, only_pending: false, limit: 25, page: 1 })).content[0].text;
    expect(text).toMatch(/^30 \(6 read\) sněmovní tisky .* — the site counts more than the 6 results page\(s\) read \(100 rows each\): narrow the criteria:/);
  });

  it("refuses a call with no criterion, and a year before 1993, without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await tools.psp_search({ only_pending: false, limit: 10, page: 1 })).isError).toBe(true);
    const early = await tools.psp_search({ query: "x", year: 1990, only_pending: false, limit: 10, page: 1 });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("1993");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("psp_get_tisk and psp_get_text", () => {
  const converters = {
    pdf: vi.fn(async (_bytes: ArrayBuffer, range: [number, number]) => ({ text: `⟦s. ${range[0]}⟧ ZÁKON … DŮVODOVÁ ZPRÁVA … K § 1`, pages: 130, range, warnings: [] })),
    docx: vi.fn(async () => "ZÁKON\n\n§ 1\n\nDŮVODOVÁ ZPRÁVA\n\nObecná část\n\nZvláštní část\n\nK § 1: Ustanovení vymezuje předmět úpravy."),
  };

  it("psp_get_tisk: the heading, the state, the stage line, the process and every document with its reading call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(HISTORIE_50)));
    const result = await tools.psp_get_tisk({ period: 10, number: 50, page: 1 });
    const text = result.content[0].text;
    expect(text).toMatch(/^Sněmovní tisk 50 — Novela z\. o důchodovém pojištění \(10\. volební období \(2025–dosud\)\)\nhttps:\/\/www\.psp\.cz\/sqw\/historie\.sqw\?o=10&t=50\nStav projednávání ke dni: 20\. října 2026\nFáze: Předkladatel → PS: Předseda sněmovny ✓/);
    expect(text).toContain("Stanovisko vlády rozesláno poslancům 17. 2. 2026 jako tisk 50/1 (nesouhlas).");
    expect(text).toContain("Documents (4)");
    expect(text).toContain("1. [návrh zákona] tisk 50/0 — Návrh zákona rozeslán poslancům jako tisk 50/0 dne 16. 1. 2026. (HTML) → psp_get_text {period: 10, number: 50, part: 0}");
    expect(text).toContain("2. [stanovisko] Parlamentní institut vypracoval stanovisko ke kompatibilitě tisku s právem EU 0050. (HTML) → psp_get_text {document_id: 268537}");
    expect(text).toContain("4. [usnesení] Organizační výbor projednání návrhu zákona doporučil 19. 2. 2026 (usnesení č. 31). (HTML) → (open the link — not readable here)");
    expect(text).toContain("Navržené změny předpisů (the acts this tisk amends): https://www.psp.cz/sqw/historie.sqw?o=10&t=50&snzp=1");
    expect(result.structuredContent).toMatchObject({ number: 50, as_of: "Stav projednávání ke dni: 20. října 2026", amended_acts_url: expect.stringContaining("snzp=1") });
  });

  it("psp_get_text on a part reads the part's main file (the DOCX of 'Návrh zákona včetně důvodové zprávy') and lists the other files", async () => {
    setDocumentConverters(converters);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("tiskt.sqw")) return html(TISKT_50);
        if (url.includes("idd=266803")) return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
        return new Response("?", { status: 404 });
      }),
    );
    const result = await tools.psp_get_text({ period: 10, number: 50, part: 0, page: 1 });
    const text = result.content[0].text;
    expect(urls).toEqual(["https://www.psp.cz/sqw/text/tiskt.sqw?O=10&CT=50&CT1=0", "https://www.psp.cz/sqw/text/orig2.sqw?idd=266803"]);
    expect(text).toMatch(/^https:\/\/www\.psp\.cz\/sqw\/text\/tiskt\.sqw\?O=10&CT=50&CT1=0\nSněmovní tisk 50\/0 — Novela z\. o důchodovém pojištění\nRead from: Návrh zákona včetně důvodové zprávy — t005000\.docx \(Dokument DOCX, 52 KB\) \(DOCX\) — https:\/\/www\.psp\.cz\/sqw\/text\/orig2\.sqw\?idd=266803\nFiles of this part:\n1\. \[celý tisk\] Celý sněmovní tisk \(PDF, 1 MB\) \(PDF\) → psp_get_text \{document_id: 266807\}/);
    expect(text).toContain("4. [platné znění s vyznačením změn] Platné znění s vyznačením změn — t0050a0.pdf (Dokument PDF, 234 KB) (PDF) → psp_get_text {document_id: 266806}");
    expect(text).toContain("K § 1: Ustanovení vymezuje předmět úpravy.");
    expect(result.structuredContent).toMatchObject({ format: "docx", url: "https://www.psp.cz/sqw/text/orig2.sqw?idd=266803", documents: expect.arrayContaining([expect.objectContaining({ document_id: 266806 })]) });
    // find works on the file's text.
    const found = await tools.psp_get_text({ period: 10, number: 50, part: 0, page: 1, find: "predmet upravy" });
    expect(found.structuredContent).toMatchObject({ matches: 1 });
  });

  it("psp_get_text on an older part (362/6) reads the PDF rendition in page windows and says how to go on", async () => {
    setDocumentConverters(converters);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("tiskt.sqw")) return html(TISKT_362);
        if (url.includes("idd=71122&pdf=1")) return new Response(new TextEncoder().encode("%PDF-1.4 oz"));
        // The original is a legacy .doc: the client asks for the PDF rendition.
        if (url.includes("idd=71122")) return new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
        return new Response("?", { status: 404 });
      }),
    );
    const result = await tools.psp_get_text({ period: 6, number: 362, part: 0, page: 1 });
    const text = result.content[0].text;
    expect(text).toContain("Read from: Verze PDF (9.6 MB) (PDF) — https://www.psp.cz/sqw/text/orig2.sqw?idd=71122&pdf=1");
    expect(text).toContain(`PDF: pages 1–${PDF_PAGES_PER_CALL} of 130 converted.`);
    expect(text).toContain(`(continue without asking the user: pdf_pages: "${PDF_PAGES_PER_CALL + 1}-${Math.min(2 * PDF_PAGES_PER_CALL, 130)}")`);
    expect(text).toContain("⟦s. 1⟧ ZÁKON");
    const next = await tools.psp_get_text({ period: 6, number: 362, part: 0, page: 1, pdf_pages: "61-120" });
    expect(next.content[0].text).toContain("PDF: pages 61–120 of 130 converted.");
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

  it("a legacy .doc is fetched again as the PDF rendition (psp.cz's 'Verze PDF', &pdf=1); without one the caller is sent to the file", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("idd=14683&pdf=1")) return new Response(new TextEncoder().encode("%PDF-1.4 rendition"));
        return new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      }),
    );
    const doc = await getPspDocument(14683, undefined, converters);
    expect(doc.format).toBe("pdf");
    expect(urls.slice(0, 2)).toEqual(["https://www.psp.cz/sqw/text/orig2.sqw?idd=14683", "https://www.psp.cz/sqw/text/orig2.sqw?idd=14683&pdf=1"]);
    await expect(getPspDocument(71129, undefined, converters)).rejects.toThrow(/legacy Word \(\.doc\)/);
  });

  it("psp_get_text on a PDF says which pages it converted and how to go on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("%PDF-1.4 fake-two"))));
    // The default converters would load pdf.js; the fixture is no PDF, so an
    // unavailable verdict is what the real converter gives — its text is what this checks.
    const result = await tools.psp_get_text({ document_id: 71130, part: 0, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Document 71130: the PDF (could not be parsed|is a scan without a text layer)\./);
    expect(result.content[0].text).toContain("Open it yourself: https://www.psp.cz/sqw/text/orig2.sqw?idd=71130");
  });
});
