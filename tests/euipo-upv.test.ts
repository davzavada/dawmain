import { describe, expect, it } from "vitest";
import { euipoDateToIso, filterEuipoClw, parseEuipoClw } from "@/src/sources/euipo-clw";
import { parseGuidelinesSection, parseGuidelinesToc } from "@/src/sources/euipo-guidelines";
import { isUpvMaintenance, parseUpvLinks } from "@/src/sources/upv";
import { SourceError } from "@/src/sources/shared/errors";

describe("euipoDateToIso", () => {
  it("converts DD/MM/YYYY", () => {
    expect(euipoDateToIso("19/03/2026")).toBe("2026-03-19");
    expect(euipoDateToIso(undefined)).toBeUndefined();
    expect(euipoDateToIso("2026-03-19")).toBeUndefined();
  });
});

describe("parseEuipoClw", () => {
  // Synthetic — field names verbatim from worldwidelaw's captured samples.
  const payload = {
    numFound: 342_000,
    results: [
      {
        uniqueSolrKey: "OPP_20260319_003250868_W01861857",
        caseNumber: "B 3 250 868",
        type: "OPPOSITION",
        typeLabel: "Opposition",
        ipRight: "EUTM",
        entityName: "(Trade mark without text)",
        entityNumber: "018123456",
        entityType: "Figurative",
        date: "19/03/2026",
        outcome: "Reject opposition: opposition not admissible",
        norms: ["Article 8(1)(b) EUTMR"],
        appealed: "No",
        languagesOriginal: [{ code: "en", pdfUrl: "https://euipo.europa.eu/copla/x.pdf" }],
      },
    ],
  };

  it("maps results and normalizes the date", () => {
    const page = parseEuipoClw(payload);
    expect(page.numFound).toBe(342_000);
    expect(page.items[0].uniqueSolrKey).toBe("OPP_20260319_003250868_W01861857");
    expect(page.items[0].date).toBe("2026-03-19");
    expect(page.items[0].pdfUrl).toContain("copla");
    expect(page.items[0].viewUrl).toContain("#key/trademark/OPP_");
  });

  it("throws UPSTREAM_ERROR on errorLabel and PARSE_DRIFT on shape drift", () => {
    try {
      parseEuipoClw({ errorLabel: "boom" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("UPSTREAM_ERROR");
    }
    try {
      parseEuipoClw({ different: 1 });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
  });
});

describe("filterEuipoClw", () => {
  const items = parseEuipoClw({
    numFound: 2,
    results: [
      { caseNumber: "R 1933/2016-4", type: "APPEAL", ipRight: "EUTM", entityName: "ALPHA", norms: ["Article 7(1)(c) EUTMR"] },
      { caseNumber: "B 3 250 868", type: "OPPOSITION", ipRight: "RCD", entityName: "BETA", norms: ["Article 8(1)(b) EUTMR"] },
    ],
  }).items;

  it("matches substrings case-insensitively across fields", () => {
    expect(filterEuipoClw(items, { caseNumber: "r 1933" })).toHaveLength(1);
    expect(filterEuipoClw(items, { type: "opposition" })[0].entityName).toBe("BETA");
    expect(filterEuipoClw(items, { norm: "8(1)(b)" })).toHaveLength(1);
    expect(filterEuipoClw(items, {})).toHaveLength(2);
  });
});

describe("parseGuidelinesToc", () => {
  const html = `
    <html><body><nav>
      <a href="/2319054/2445755/trade-mark-guidelines/1-introduction">1 Introduction</a>
      <a href="https://guidelines.euipo.europa.eu/2319054/2445760/trade-mark-guidelines/2-searches">2 Searches</a>
      <a href="/2319054/2445755/trade-mark-guidelines/1-introduction">1 Introduction (duplicate)</a>
      <a href="/9999999/1111111/other-publication">Other publication</a>
      <a href="/binary/2319054/2008000000">PDF</a>
    </nav></body></html>`;

  it("keeps only same-publication topic links, deduplicated", () => {
    const topics = parseGuidelinesToc(html, "2319054");
    expect(topics).toHaveLength(2);
    expect(topics[0]).toEqual({
      topicId: "2445755",
      title: "1 Introduction",
      url: "https://guidelines.euipo.europa.eu/2319054/2445755",
    });
  });
});

describe("parseGuidelinesSection", () => {
  it("prefers the main container and drops chrome", () => {
    const text = parseGuidelinesSection(`
      <html><body>
      <nav>Navigation junk</nav>
      <main><h1>Priority</h1><p>${"Substantive requirements for priority claims. ".repeat(10)}</p></main>
      <footer>Footer junk</footer>
      </body></html>`);
    expect(text).toContain("Priority");
    expect(text).toContain("Substantive requirements");
    expect(text).not.toContain("Navigation junk");
  });
});

describe("parseUpvLinks", () => {
  const html = `
    <html><body>
      <a href="rozhodnuti.prochazet?p_kat=OZ">ochranné známky</a>
      <a href="/webapp/rozhodnuti.SeznamRozhodnuti?p_kat=PT1">zrušení patentu</a>
      <a href="rozhodnuti.showDocP?p_id=LXDatkyH">O-123/2020 zamítnutí</a>
      <a href="https://example.com/unrelated">jinam</a>
    </body></html>`;

  it("extracts app links and decision tokens", () => {
    const links = parseUpvLinks(html);
    expect(links).toHaveLength(3);
    const decision = links.find((link) => link.pId);
    expect(decision?.pId).toBe("LXDatkyH");
    expect(links[0].href).toContain("isdv.upv.gov.cz/webapp/rozhodnuti.prochazet");
  });
});

describe("isUpvMaintenance", () => {
  it("detects the maintenance page but not long content pages", () => {
    expect(isUpvMaintenance("<html>Probíhá odstávka systému</html>")).toBe(true);
    expect(isUpvMaintenance(`<html>${"rozhodnutí ".repeat(3000)}odstávka</html>`)).toBe(false);
    expect(isUpvMaintenance("<html>běžná stránka</html>")).toBe(false);
  });
});
