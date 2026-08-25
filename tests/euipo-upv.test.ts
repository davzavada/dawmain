import { describe, expect, it } from "vitest";
import { euipoDateToIso, filterEuipoClw, parseEuipoClw } from "@/src/sources/euipo-clw";
import {
  parsePage,
  parsePublications,
  parseToc,
  pickPublication,
} from "@/src/sources/euipo-guidelines";
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

describe("guidelines publications", () => {
  // Synthetic — SDL delivery API shapes (Id/Title casing tolerated).
  const listing = [
    { Id: "2302857", Title: "Trade mark Guidelines 2025" },
    { Id: "2319054", Title: "Trade mark Guidelines 2026" },
    { Id: "2319266", Title: "Linji gwida tat-trademarks" }, // Maltese, higher id
    { Id: "2231430", Title: "Designs Guidelines" },
  ];

  it("parses and picks the newest ENGLISH edition", () => {
    const publications = parsePublications(listing);
    expect(publications).toHaveLength(4);
    expect(pickPublication(publications, "trademark")?.id).toBe("2319054");
    expect(pickPublication(publications, "design")?.id).toBe("2231430");
  });

  it("prefers a language field when present", () => {
    const publications = parsePublications([
      { Id: "2", Title: "Trademark Guidelines", Language: "mt" },
      { Id: "1", Title: "Trademark Guidelines", Language: "en" },
    ]);
    expect(pickPublication(publications, "trademark")?.id).toBe("1");
  });

  it("throws PARSE_DRIFT on a non-list", () => {
    expect(() => parsePublications({ nonsense: 1 })).toThrowError(SourceError);
  });
});

describe("guidelines parseToc", () => {
  it("extracts numeric page ids from Urls and sitemap ids for drill-down", () => {
    const topics = parseToc(
      [
        { Id: "t1", Title: "Trade mark guidelines", HasChildNodes: true },
        { Id: "ish:123-1-512", Title: "1 Introduction", Url: "/2319054/2445755/trade-mark-guidelines/1-introduction", HasChildNodes: false },
      ],
      "2319054",
    );
    expect(topics).toHaveLength(2);
    expect(topics[0].topicId).toBeNull();
    expect(topics[0].sitemapId).toBe("t1");
    expect(topics[0].hasChildren).toBe(true);
    expect(topics[1]).toEqual({
      topicId: "2445755",
      sitemapId: "ish:123-1-512",
      title: "1 Introduction",
      hasChildren: false,
      url: "https://guidelines.euipo.europa.eu/2319054/2445755",
    });
  });
});

describe("guidelines parsePage", () => {
  it("finds the HTML payload at the live nesting depth", () => {
    // Live shape captured 2026-08 via probe fetch_url.
    const text = parsePage({
      Regions: [
        {
          Name: "Main",
          Entities: [
            {
              topicBody: {
                Fragments: [
                  { Html: `<h1>1 Introduction</h1><div><p>${"The Office's Guidelines are the main point of reference. ".repeat(5)}</p></div>` },
                ],
              },
              topicTitle: "1 Introduction",
            },
          ],
        },
      ],
      Meta: { description: "x" },
    });
    expect(text).toContain("1 Introduction");
    expect(text).toContain("main point of reference");
  });

  it("throws PARSE_DRIFT when no HTML is present", () => {
    expect(() => parsePage({ Title: "no html here" })).toThrowError(SourceError);
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
