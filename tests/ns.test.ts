import { describe, expect, it } from "vitest";
import { buildNsQuery, parseNsDecision, parseNsSearch, usToIso } from "@/src/sources/ns";
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
});

describe("usToIso", () => {
  it("converts MM/DD/YYYY", () => {
    expect(usToIso("05/20/2026")).toBe("2026-05-20");
    expect(usToIso("20. 5. 2026")).toBeNull();
  });
});
