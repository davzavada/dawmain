import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildNsQuery,
  isoDaysAgo,
  nsBodyMissing,
  parseNsDecision,
  parseNsSearch,
  usToIso,
  withDefaultWindow,
} from "@/src/sources/ns";
import { SourceError } from "@/src/sources/shared/errors";

describe("buildNsQuery", () => {
  it("splits a case number into senate + registry + phrase", () => {
    expect(buildNsQuery({ caseNumber: "23 Cdo 1234/2025" })).toBe(
      '[spzn1]=23 AND [spzn2]=cdo AND "1234/2025"',
    );
  });
  it("falls back to a phrase for unparsable case numbers", () => {
    expect(buildNsQuery({ caseNumber: "Pl. ÚS-st 1/93" })).toBe('"Pl. ÚS-st 1/93"');
  });

  it("sanitizes the fallback phrase — no breaking out into Domino operators", () => {
    const query = buildNsQuery({
      caseNumber: 'x" OR [kategorie_rozhodnuti1]=A OR [ARozhodnutiRT]=((*))',
      query: "smlouva",
    });
    // Exactly two quotes: the ones we put around the sanitized phrase.
    expect(query.match(/"/g)).toHaveLength(2);
    expect(query).not.toContain("[kategorie_rozhodnuti1]");
    expect(query).toContain("[ARozhodnutiRT]=((smlouva))");
  });
  it("wraps full text and appends date bounds in Czech format", () => {
    expect(
      buildNsQuery({ query: "náhrada škody", dateFrom: "2025-02-24", dateTo: "2025-03-01" }),
    ).toBe(
      "[ARozhodnutiRT]=((náhrada škody)) AND [datum_predani_na_web]>=24.2.2025 AND [datum_predani_na_web]<=1.3.2025",
    );
  });
  it("rejects empty criteria", () => {
    expect(() => buildNsQuery({})).toThrowError(SourceError);
  });
  it("strips quotes and braces that break Domino FT syntax", () => {
    expect(buildNsQuery({ query: 'pojem "dobré mravy" {test}' })).toBe(
      "[ARozhodnutiRT]=((pojem dobré mravy test))",
    );
  });
});

describe("default window", () => {
  const now = Date.UTC(2026, 7, 25); // 2026-08-25

  it("applies date_from when no dates are given", () => {
    const { input, appliedWindowFrom } = withDefaultWindow({ query: "x" }, 365, now);
    expect(appliedWindowFrom).toBe("2025-08-25");
    expect(input.dateFrom).toBe("2025-08-25");
  });

  it("never touches explicit dates", () => {
    const { input, appliedWindowFrom } = withDefaultWindow({ query: "x", dateTo: "2020-01-01" }, 365, now);
    expect(appliedWindowFrom).toBeNull();
    expect(input.dateTo).toBe("2020-01-01");
    expect(input.dateFrom).toBeUndefined();
  });

  it("isoDaysAgo computes ISO dates", () => {
    expect(isoDaysAgo(30, now)).toBe("2026-07-26");
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

  it("recognizes the empty marker", () => {
    const page = parseNsSearch("<p>Nebyly nalezeny žádné výsledky vyhledávání</p>");
    expect(page.empty).toBe(true);
    expect(page.hits).toHaveLength(0);
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
    }
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
