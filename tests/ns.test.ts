import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildNsQuery,
  nsFetchCount,
  nsFullText,
  nsRelevanceCount,
  parseSpisovaZnacka,
  sanitizeNsFullText,
  withHighlight,
  nsBodyMissing,
  parseNsDecision,
  parseNsSearch,
  usToIso,
} from "@/src/sources/ns";
import { SourceError } from "@/src/sources/shared/errors";

const UNID_OF = (html: string) => /WebSearch\/([0-9A-Fa-f]{32})\?openDocument/.exec(html)![1];

describe("buildNsQuery", () => {
  it("splits a case number into the four indexed fields", () => {
    expect(buildNsQuery({ caseNumber: "23 Cdo 116/2017" })).toBe(
      "[spzn1]=23 AND [spzn2]=cdo AND [spzn3]=116 AND [spzn4]=2017",
    );
  });
  it("handles a značka without a senate, and ignores trailing decorations", () => {
    expect(buildNsQuery({ caseNumber: "Cpjn 202/2018" })).toBe(
      "[spzn2]=cpjn AND [spzn3]=202 AND [spzn4]=2018",
    );
    expect(buildNsQuery({ caseNumber: "26 Cdo 2316/2020- II." })).toBe(
      "[spzn1]=26 AND [spzn2]=cdo AND [spzn3]=2316 AND [spzn4]=2020",
    );
  });
  it("quotes the court name for the [SoudCreate] field", () => {
    expect(buildNsQuery({ query: "nájem", court: 'Vrchní soud v Praze"' })).toBe(
      '[SoudCreate]="Vrchní soud v Praze" AND ([ARozhodnutiRT]=(nájem))',
    );
  });
  it("falls back to a phrase for unparsable case numbers", () => {
    expect(buildNsQuery({ caseNumber: "Pl. ÚS-st 1/93" })).toBe('"Pl. ÚS-st 1/93"');
    // A malformed year is not a značka either.
    expect(buildNsQuery({ caseNumber: "20 Cdo 2018/985" })).toBe('"20 Cdo 2018/985"');
  });
  it("matches 1990s značky with a two-digit year field by field, as NS indexes them", () => {
    // Live: this four-field query found exactly 20 Cdo 2018/98 [A]; the phrase
    // fallback listed 251 decisions citing it, without it on page 1.
    expect(buildNsQuery({ caseNumber: "20 Cdo 2018/98" })).toBe(
      "[spzn1]=20 AND [spzn2]=cdo AND [spzn3]=2018 AND [spzn4]=98",
    );
    expect(buildNsQuery({ caseNumber: "2 Cdon 1435/96" })).toBe(
      "[spzn1]=2 AND [spzn2]=cdon AND [spzn3]=1435 AND [spzn4]=96",
    );
  });
  it("drops a leading 'sp. zn.' or 'č. j.' — the decision's own fields never carry it", () => {
    expect(buildNsQuery({ caseNumber: "sp. zn. 23 Cdo 116/2017" })).toBe(
      "[spzn1]=23 AND [spzn2]=cdo AND [spzn3]=116 AND [spzn4]=2017",
    );
    expect(buildNsQuery({ caseNumber: "Sp.zn. 23 Cdo 116/2017" })).toBe(
      "[spzn1]=23 AND [spzn2]=cdo AND [spzn3]=116 AND [spzn4]=2017",
    );
    expect(buildNsQuery({ caseNumber: "č. j. 23 Cdo 116/2017-123" })).toBe(
      "[spzn1]=23 AND [spzn2]=cdo AND [spzn3]=116 AND [spzn4]=2017",
    );
  });
  it("filters by type and by decision date, publication date separately", () => {
    expect(
      buildNsQuery({
        query: "nájem",
        type: "Rozsudek",
        dateFrom: "2025-01-01",
        publishedTo: "2026-01-01",
      }),
    ).toBe(
      "[TypRozhodnuti]=Rozsudek AND [datum_rozhodnuti]>=01.01.2025" +
        " AND [datum_predani_na_web]<=01.01.2026 AND ([ARozhodnutiRT]=(nájem))",
    );
  });

  it("sanitizes the fallback phrase — no breaking out into Domino operators", () => {
    const query = buildNsQuery({
      caseNumber: 'x" OR [kategorie_rozhodnuti1]=A OR [ARozhodnutiRT]=((*))',
      query: "smlouva",
    });
    // Exactly two quotes: the ones we put around the sanitized phrase.
    expect(query.match(/"/g)).toHaveLength(2);
    expect(query).not.toContain("[kategorie_rozhodnuti1]");
    expect(query).toContain("([ARozhodnutiRT]=(smlouva))");
  });
  it("wraps full text and appends date bounds in Czech format", () => {
    expect(
      buildNsQuery({ query: "náhrada škody", dateFrom: "2025-02-24", dateTo: "2025-03-01" }),
    ).toBe(
      "[datum_rozhodnuti]>=24.02.2025 AND [datum_rozhodnuti]<=01.03.2025" +
        " AND ([ARozhodnutiRT]=(náhrada AND škody))",
    );
  });
  it("rejects empty criteria", () => {
    expect(() => buildNsQuery({})).toThrowError(SourceError);
  });
  it("keeps the operators a caller may legitimately use", () => {
    expect(buildNsQuery({ query: 'nájem* AND ("dobré mravy" OR ekvita) NOT výpověď' })).toBe(
      '([ARozhodnutiRT]=(nájem* AND ("dobré mravy" OR ekvita) NOT výpověď))',
    );
  });
  it("strips braces, and delimiters left unbalanced", () => {
    expect(buildNsQuery({ query: 'pojem "dobré mravy {test}' })).toBe(
      "([ARozhodnutiRT]=(pojem AND dobré AND mravy AND test))",
    );
    expect(buildNsQuery({ query: "nájem AND (výpověď" })).toBe(
      "([ARozhodnutiRT]=(nájem AND výpověď))",
    );
  });
  it("never lets a query name a Domino field", () => {
    const query = buildNsQuery({ query: "x)) OR [kategorie_rozhodnuti1]=A OR ((y" });
    expect(query).not.toContain("[kategorie_rozhodnuti1]");
    expect(query).toBe("([ARozhodnutiRT]=(x OR kategorie_rozhodnuti1 =A OR y))");
  });
});

describe("nsFullText", () => {
  it("requires every plain word — Domino reads bare words as one exact phrase", () => {
    expect(nsFullText("nájemce výpověď")).toBe("nájemce AND výpověď");
    expect(nsFullText("výpověď z nájmu bez výpovědní doby")).toBe(
      "výpověď AND nájmu AND bez AND výpovědní AND doby",
    );
  });
  it("keeps a single word as it is", () => {
    expect(nsFullText("nájem*")).toBe("nájem*");
  });
  it("keeps a spisová značka together as a phrase", () => {
    expect(nsFullText("31 Cdo 1945/2010")).toBe('"31 Cdo 1945/2010"');
    expect(nsFullText("rozhodčí doložka 31 Cdo 1945/2010")).toBe(
      '"31 Cdo 1945/2010" AND rozhodčí AND doložka',
    );
    expect(nsFullText("Pl. ÚS 24/10 soukromí")).toBe('"Pl. ÚS 24/10" AND soukromí');
    expect(nsFullText("29 ICdo 41/2014")).toBe('"29 ICdo 41/2014"');
  });
  it("does not freeze an act citation into a phrase no decision contains", () => {
    expect(nsFullText("zákon 89/2012")).toBe('zákon AND "89/2012"');
  });
  it("drops one-character words and stray punctuation", () => {
    expect(nsFullText("nájem a výpověď , § 2291")).toBe("nájem AND výpověď AND 2291");
  });
  it("requires a quoted phrase AND the plain words next to it", () => {
    // Sent as written, Domino read the whole line as one phrase: live,
    // '"dobré mravy" nájem' 0 decisions, '"dobré mravy" AND nájem' 119.
    expect(nsFullText('"zvlášť závažné porušení" nájemce')).toBe('"zvlášť závažné porušení" AND nájemce');
    expect(nsFullText('"dobré mravy" nájem výpověď')).toBe('"dobré mravy" AND nájem AND výpověď');
    expect(nsFullText('nájem "dobré mravy" "dobré mravy"')).toBe('"dobré mravy" AND nájem');
    // One-character words stay inside a phrase; a značka keeps its phrase.
    expect(nsFullText('"výpověď z nájmu" a byt')).toBe('"výpověď z nájmu" AND byt');
    expect(nsFullText('"náhrada škody" 25 Cdo 1234/2019')).toBe('"náhrada škody" AND "25 Cdo 1234/2019"');
    // An operator word inside a phrase is part of the phrase.
    expect(nsFullText('"not guilty" plea')).toBe('"not guilty" AND plea');
    expect(buildNsQuery({ query: '"dobré mravy" nájem' })).toBe('([ARozhodnutiRT]=("dobré mravy" AND nájem))');
  });
  it("reads Czech typographic quotes as a phrase", () => {
    expect(nsFullText("„dobré mravy“ nájem")).toBe('"dobré mravy" AND nájem');
  });
  it("drops §, also from an expression sent as written — Domino never indexes it", () => {
    expect(nsFullText('"náhrada nemajetkové újmy" § 2958')).toBe('"náhrada nemajetkové újmy" AND 2958');
    expect(nsFullText("nájem OR § 2291")).toBe("nájem OR 2291");
    expect(nsFullText('"§ 2958" OR náhrada')).toBe('"2958" OR náhrada');
    expect(nsFullText('"§" nájem')).toBe("nájem");
  });
  it("asks a word ending in '?' both ways — question mark and one-letter wildcard", () => {
    // Live: "je výpověď z nájmu platná?" 0 decisions, without the "?" 255,
    // and "(platná OR platná?)" 255; "výpověď nájm?" ≥ 1 000, "výpověď nájm" 0.
    expect(nsFullText("je výpověď z nájmu platná?")).toBe(
      "je AND výpověď AND nájmu AND (platná OR platná?)",
    );
    expect(nsFullText("výpověď nájm?")).toBe("výpověď AND (nájm OR nájm?)");
    expect(nsFullText("n?jem")).toBe("n?jem");
    expect(nsFullText("zákon 89/2012?")).toBe('zákon AND "89/2012"');
  });
  it("leaves a composed expression exactly as written", () => {
    expect(nsFullText('"dobré mravy" OR nájem')).toBe('"dobré mravy" OR nájem');
    expect(nsFullText("nájem OR pacht")).toBe("nájem OR pacht");
    expect(nsFullText("nájem or pacht")).toBe("nájem or pacht");
    expect(nsFullText("nájem NEAR výpověď")).toBe("nájem NEAR výpověď");
    expect(nsFullText("(nájem pacht) výpověď")).toBe("(nájem pacht) výpověď");
  });
});

describe("nsRelevanceCount", () => {
  it("reads rows 0–99 from the first block and anything deeper from the whole 900 window", () => {
    expect(nsRelevanceCount(0, 20)).toBe(100);
    expect(nsRelevanceCount(80, 20)).toBe(100);
    // Not 200: the ranking depends on Count, so blocks growing by 100 are
    // not slices of one list.
    expect(nsRelevanceCount(90, 20)).toBe(900);
    expect(nsRelevanceCount(100, 20)).toBe(900);
    expect(nsRelevanceCount(880, 100)).toBe(900);
  });
});

describe("parseSpisovaZnacka", () => {
  it("returns null for a string that is not a značka", () => {
    expect(parseSpisovaZnacka("náhrada škody")).toBeNull();
    expect(parseSpisovaZnacka("116/2017")).toBeNull();
  });
});

describe("sanitizeNsFullText", () => {
  it("collapses whitespace and keeps balanced quotes", () => {
    expect(sanitizeNsFullText('  "dobré   mravy"  ')).toBe('"dobré mravy"');
  });
  it("drops § and never leaves an empty phrase", () => {
    expect(sanitizeNsFullText('"§ 22" AND "§"')).toBe('"22" AND');
  });
});

describe("withHighlight", () => {
  const url = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/ABC?openDocument";

  it("appends the query terms so the document opens at the passage", () => {
    expect(withHighlight(url, ["dobré mravy"])).toBe(`${url}&Highlight=0,dobr%C3%A9,mravy`);
  });
  it("drops operators, short words and duplicates", () => {
    expect(withHighlight(url, ["nájem AND nájem", "a NEAR výpověď"])).toBe(
      `${url}&Highlight=0,n%C3%A1jem,v%C3%BDpov%C4%9B%C4%8F`,
    );
  });
  it("leaves the url alone when there is nothing to highlight", () => {
    expect(withHighlight(url, [undefined, "a"])).toBe(url);
  });
});


// Synthetic — assembled from the verbatim markup in docs/research/cz-sources.json
// (a.odk anchor regex, count banners, resultData rows have no tbody).
const RESULTS_HTML = `
<html><body>
<p>V&yacute;sledky 1 - 2 z 2 zobrazovan&yacute;ch dokument&#367;.</p>
<table id="tabl">
<tr><td class="icons"><a href="/Judikatura/judikatura_ns.nsf/WebSearch/0123456789ABCDEF0123456789ABCDEF?openDocument" class="odk">27 Cdo 1525/2025</a></td></tr>
<tr><td><a class="odk" href="/Judikatura/judikatura_ns.nsf/WebSearch/FEDCBA9876543210FEDCBA9876543210?openDocument">23 Cdo 100/2024<br />23 ICdo 5/2024</a></td></tr>
</table>
</body></html>`;

const TRUNCATED_HTML = `
<html><body>
<p>(Podm&iacute;nce vyhovuje: 50 454 )</p>
<p>V&yacute;sledky 1 - 20 z 900 zobrazovan&yacute;ch dokument&#367;.</p>
<a class="odk" href="/x/WebSearch/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?openDocument">30 Cdo 1/2010</a>
</body></html>`;

describe("parseNsSearch", () => {
  it("extracts UNIDs and stacked case numbers", () => {
    const page = parseNsSearch(RESULTS_HTML);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
    expect(page.hits).toHaveLength(2);
    expect(page.hits[0].unid).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(page.hits[1].caseNumbers).toEqual(["23 Cdo 100/2024", "23 ICdo 5/2024"]);
  });

  it("detects the 900-document window truncation", () => {
    const page = parseNsSearch(TRUNCATED_HTML);
    expect(page.matched).toBe(50454);
    expect(page.truncated).toBe(true);
  });

  it("reads court and category from the live row markup, one hit per document", () => {
    const page = parseNsSearch(
      readFileSync(path.join(__dirname, "fixtures", "ns-search-results.html"), "utf8"),
    );
    expect(page.hits.map((hit) => hit.caseNumbers[0])).toEqual([
      "30 Cdo 2192/2026",
      "28 Cdo 1677/2025",
      "21 Cdo 1215/2025",
      "3 Cmo 100/2019",
      "5 Tdo 407/2026",
    ]);
    expect(page.hits.map((hit) => hit.category)).toEqual(["E", "C", "B", "A", "C"]);
    expect(page.hits[0].court).toBe("Nejvyšší soud");
    expect(page.hits[3].court).toBe("Vrchní soud v Praze");
    expect(page.matched).toBe(1000);
    expect(page.total).toBe(900);
    expect(page.truncated).toBe(true);
  });

  it("recognizes the empty marker", () => {
    const page = parseNsSearch("<p>Nebyly nalezeny žádné výsledky vyhledávání</p>");
    expect(page.empty).toBe(true);
    expect(page.hits).toHaveLength(0);
  });

  it("reads the single-result banner as one match (live: 'Byl nalezen jeden výsledek')", () => {
    const page = parseNsSearch(
      readFileSync(path.join(__dirname, "fixtures", "ns-search-single.html"), "utf8"),
    );
    expect(page.total).toBe(1);
    expect(page.matched).toBeNull();
    expect(page.empty).toBe(false);
    expect(page.hits.map((hit) => hit.caseNumbers)).toEqual([["23 Cdo 116/2017"]]);
  });

  it("does not take the page size for the total when the banner is unknown", () => {
    // A drifted banner must stay visible as an unknown count, not become "20".
    const html = `<p>Nový banner</p>${RESULTS_HTML.replace(/<p>V&yacute;sledky[^<]*<\/p>/, "")}`;
    expect(parseNsSearch(html).total).toBeNull();
  });

  it("parses the DOM once and keeps htmlToText's reading of the rows", () => {
    // <font>-wrapped značky split by <br>, an &nbsp; inside a značka, and a
    // script that happens to hold the empty marker.
    const html = `<html><head><script>var msg = "Nebyly nalezeny žádné výsledky";</script></head><body>
<p>V&yacute;sledky 1 - 1 z 1</p>
<a class="odk" href="/x/WebSearch/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB?openDocument"><font>23 Cdo&nbsp;1/2024</font><br><font>23 Cdo 2/2024</font></a>
</body></html>`;
    const page = parseNsSearch(html);
    expect(page.empty).toBe(false);
    expect(page.hits[0].caseNumbers).toEqual(["23 Cdo 1/2024", "23 Cdo 2/2024"]);
    expect(parseNsSearch("<p>Nebyly&nbsp;nalezeny  žádné výsledky</p>").empty).toBe(true);
  });

  it("reads a 900-row page — one row per document, značka, court and category each", () => {
    const live = readFileSync(path.join(__dirname, "fixtures", "ns-search-results.html"), "utf8");
    // The live row of the first hit, from its <tr> to its </tr>.
    const anchor = live.indexOf('class="odk"');
    const rowHtml = live.slice(live.lastIndexOf("<tr", anchor), live.indexOf("</tr>", anchor) + 5);
    const unid = UNID_OF(rowHtml);
    const rows = Array.from({ length: 900 }, (_, i) =>
      rowHtml.replaceAll(unid, i.toString(16).toUpperCase().padStart(32, "0")),
    ).join("\n");
    const page = parseNsSearch(`<p>V&yacute;sledky 1 - 900 z 900</p><table>${rows}</table>`);
    expect(page.hits).toHaveLength(900);
    expect(page.total).toBe(900);
    const first = parseNsSearch(live).hits[0];
    expect(page.hits[899]).toMatchObject({ caseNumbers: first.caseNumbers, court: first.court, category: first.category });
  });

  it("throws PARSE_DRIFT on an unrecognizable page", () => {
    expect(() => parseNsSearch("<html><body>Maintenance</body></html>")).toThrowError(SourceError);
  });
});

// Synthetic — td.left-part/right-part metadata rows + Times New Roman body.
const DETAIL_HTML = `
<html><body>
<table id="box-table-a">
<tr><td class="left-part">Spisová značka:</td><td class="right-part">27 Cdo 1525/2025</td></tr>
<tr><td class="left-part">ECLI:</td><td class="right-part">ECLI:CZ:NS:2026:27.CDO.1525.2025.1</td></tr>
<tr><td class="left-part">Datum rozhodnutí:</td><td class="right-part">05/20/2026</td></tr>
<tr><td class="left-part">Kategorie rozhodnutí:</td><td class="right-part">C</td></tr>
</table>
<font face="Times New Roman">Nejvyšší soud rozhodl v senátu složeném z předsedy…</font>
<font face="Times New Roman">Odůvodnění: text rozhodnutí pokračuje.</font>
<font face="Times New Roman">Citace rozhodnutí Nejvyššího soudu</font>
</body></html>`;

describe("parseNsDecision", () => {
  it("extracts metadata and normalizes the US-format WebPrint date", () => {
    const decision = parseNsDecision(DETAIL_HTML, "0123456789ABCDEF0123456789ABCDEF");
    expect(decision.metadata["Spisová značka"]).toBe("27 Cdo 1525/2025");
    expect(decision.metadata["ECLI"]).toContain("ECLI:CZ:NS:2026");
    expect(decision.metadata["Datum rozhodnutí"]).toBe("2026-05-20");
  });

  it("clips the body between the opening and the citation note", () => {
    const decision = parseNsDecision(DETAIL_HTML, "0123456789ABCDEF0123456789ABCDEF");
    expect(decision.text).toMatch(/^Nejvyšší soud rozhodl/);
    expect(decision.text).not.toContain("Citace rozhodnutí");
    expect(decision.text).toContain("Odůvodnění");
  });

  // Live captures of 23 Cdo 3375/2011 — 2013-era markup where the body sits
  // in <tt><font size="4"> WITHOUT a face attribute (Times New Roman marks
  // only the metadata table), which defeated the old face-based extractor.
  const LEGACY_WEBPRINT = readFileSync(
    path.join(__dirname, "fixtures", "ns-webprint-legacy.html"),
    "utf8",
  );
  const LEGACY_WEBSEARCH = readFileSync(
    path.join(__dirname, "fixtures", "ns-websearch-legacy.html"),
    "utf8",
  );

  it("extracts the face-less legacy body from WebPrint (23 Cdo 3375/2011)", () => {
    const decision = parseNsDecision(LEGACY_WEBPRINT, "5019E1CBD0C332A2C1257C470065C6CD");
    expect(decision.metadata["Spisová značka"]).toBe("23 Cdo 3375/2011");
    expect(decision.metadata["ECLI"]).toBe("ECLI:CZ:NS:2013:23.CDO.3375.2011.1");
    expect(decision.metadata["Datum rozhodnutí"]).toBe("2013-12-11");
    expect(decision.text).toMatch(/^Nejvyšší soud České republiky rozhodl/);
    expect(decision.text).toContain("APETITO");
    expect(decision.text).toContain("Dovolání");
    // The metadata table must not leak into the body.
    expect(decision.text).not.toContain("Kategorie rozhodnutí");
    expect(nsBodyMissing(decision.text)).toBe(false);
  });

  it("extracts the legacy body from WebSearch and skips the citace-links row", () => {
    const decision = parseNsDecision(LEGACY_WEBSEARCH, "5019E1CBD0C332A2C1257C470065C6CD");
    expect(decision.metadata["23 Cdo 3375/2011"]).toBeUndefined();
    expect(decision.metadata["Datum rozhodnutí"]).toBe("2013-12-11");
    expect(decision.text).toMatch(/^Nejvyšší soud České republiky rozhodl/);
    expect(decision.text).toContain("APETITO");
    // The citation-format note precedes the body here — it must not truncate it.
    expect(decision.text).not.toContain("by měla obsahovat");
  });

  it("lifts the ústavní stížnost outcome into metadata from both renditions", () => {
    for (const html of [LEGACY_WEBPRINT, LEGACY_WEBSEARCH]) {
      const decision = parseNsDecision(html, "5019E1CBD0C332A2C1257C470065C6CD");
      expect(decision.metadata["Ústavní stížnost"]).toContain("II.ÚS 754/14");
      expect(decision.metadata["Ústavní stížnost"]).toContain("odmítnuto");
      // ISO like Datum rozhodnutí, never WebPrint's US 02/26/2014 — and each
      // date says which one it is (filed vs decided by ÚS).
      expect(decision.metadata["Ústavní stížnost"]).toContain("2014-02-26");
      expect(decision.metadata["Ústavní stížnost"]).toContain("2015-03-24");
      expect(decision.metadata["Ústavní stížnost"]).not.toMatch(/\d{1,2}[./]\s*\d{1,2}[./]\s*\d{4}/);
    }
  });

  // Live capture of 4 Tdo 466/2026: "Nejvyšší soud projednal … a rozhodl
  // takto:" — the old start-of-body search cut at point 16 of the reasoning
  // and the tool then claimed NS had published no body.
  it("keeps the výrok of a decision that opens 'Nejvyšší soud projednal' (4 Tdo 466/2026)", () => {
    const decision = parseNsDecision(
      readFileSync(path.join(__dirname, "fixtures", "ns-webprint-projednal.html"), "utf8"),
      "BC526E28EAAF986CC1258E3B004D3D2A",
    );
    expect(decision.text).toMatch(/^Nejvyšší soud projednal v neveřejném zasedání/);
    expect(decision.text).toContain("a rozhodl takto");
    expect(decision.text).toContain("se dovolání obviněného P. Š. odmítá");
    expect(decision.text).toContain("Dosavadní průběh řízení");
    expect(decision.text).toContain("16. Nejvyšší soud jako soud dovolací");
    expect(decision.text).not.toContain("Kategorie rozhodnutí");
    expect(nsBodyMissing(decision.text)).toBe(false);
    expect(decision.metadata["Datum rozhodnutí"]).toBe("2026-06-17");
  });

  it("finds an opening other than 'rozhodl' at the head — 'v senátě složeném'", () => {
    const html = `<html><body><table id="box-table-a"><tr><td class="left-part">Spisová značka:</td><td class="right-part">7 Tdo 53/2026</td></tr></table>
<p>7 Tdo 53/2026-120</p><p>USNESENÍ</p>
<p>Nejvyšší soud v senátě složeném z předsedy JUDr. A. B. a soudců rozhodl v neveřejném zasedání takto:</p>
<p>Dovolání se odmítá.</p><p>Odůvodnění:</p><p>${"Soudy rozhodly. ".repeat(20)}</p>
<p>9. Nejvyšší soud jako soud dovolací zkoumal přípustnost.</p></body></html>`;
    const decision = parseNsDecision(html, "A".repeat(32));
    expect(decision.text).toMatch(/^Nejvyšší soud v senátě složeném/);
    expect(decision.text).toContain("Dovolání se odmítá");
  });

  it("never cuts a lower court's body that quotes 'Nejvyšší soud jako soud dovolací' in its reasoning", () => {
    const html = `<html><body><table id="box-table-a"><tr><td class="left-part">Soud:</td><td class="right-part">Vrchní soud v Praze</td></tr></table>
<p>3 Cmo 100/2019</p><p>Vrchní soud v Praze rozhodl v senátě složeném z předsedy takto:</p>
<p>Rozsudek soudu prvního stupně se potvrzuje.</p><p>Odůvodnění:</p>
<p>${"Odvolací soud přezkoumal napadený rozsudek a dospěl k závěru, že odvolání není důvodné. ".repeat(30)}</p>
<p>Nejvyšší soud jako soud dovolací v obdobné věci vyslovil, že …</p></body></html>`;
    const decision = parseNsDecision(html, "A".repeat(32));
    expect(decision.text).toMatch(/^3 Cmo 100\/2019\nVrchní soud v Praze rozhodl/);
    expect(decision.text).toContain("se potvrzuje");
  });

  it("never cuts a SHORT lower-court body either — its výrok precedes the quoted 'Nejvyšší soud'", () => {
    // Within the head this time: the výrok ("… takto:") before the match
    // says the match is reasoning, not the opening.
    const html = `<html><body><table id="box-table-a"><tr><td class="left-part">Soud:</td><td class="right-part">Krajský soud v Brně</td></tr></table>
<p>15 Co 12/2020</p><p>Krajský soud v Brně rozhodl takto:</p><p>Rozsudek soudu prvního stupně se potvrzuje.</p><p>Odůvodnění:</p>
<p>Nejvyšší soud jako soud dovolací v obdobné věci vyslovil, že žaloba není důvodná.</p></body></html>`;
    const decision = parseNsDecision(html, "A".repeat(32));
    expect(decision.text).toMatch(/^15 Co 12\/2020\nKrajský soud v Brně rozhodl takto:/);
    expect(decision.text).toContain("se potvrzuje");
  });
});

describe("nsBodyMissing", () => {
  it("flags the WebPrint metadata echo of a body-less rendition", () => {
    // What htmlToText yields when WebPrint renders only the metadata table
    // (observed on older decisions, e.g. 23 Cdo 3375/2011).
    const echo = `Spisová značka: 23 Cdo 3375/2011 ECLI: ECLI:CZ:NS:2013:23.CDO.3375.2011.1
      Typ rozhodnutí: ROZSUDEK Heslo: Smlouva o dílo Dotčené předpisy: § 536 obch. zák.
      Kategorie rozhodnutí: C Datum rozhodnutí: 03/26/2013 ${"Další pole a hodnoty. ".repeat(10)}`;
    expect(nsBodyMissing(echo)).toBe(true);
  });

  it("accepts real bodies, including short usnesení and spaced odůvodnění", () => {
    expect(
      nsBodyMissing(
        `Nejvyšší soud České republiky rozhodl v senátě takto: dovolání se odmítá. O d ů v o d n ě n í : ${"soud uvádí. ".repeat(30)}`,
      ),
    ).toBe(false);
  });

  it("treats near-empty text as missing", () => {
    expect(nsBodyMissing("")).toBe(true);
    expect(nsBodyMissing("Nejvyšší soud rozhodl.")).toBe(true); // under the floor
  });
});

describe("usToIso", () => {
  it("converts MM/DD/YYYY", () => {
    expect(usToIso("05/20/2026")).toBe("2026-05-20");
    expect(usToIso("20. 5. 2026")).toBeNull();
  });
});

describe("nsFetchCount", () => {
  it("never asks Domino for a small page — it answers 500 to those", () => {
    expect(nsFetchCount(1)).toBe(20);
    expect(nsFetchCount(3)).toBe(20);
    expect(nsFetchCount(20)).toBe(20);
    expect(nsFetchCount(100)).toBe(100);
  });
});
