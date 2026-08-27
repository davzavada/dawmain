import { describe, expect, it } from "vitest";
import {
  buildCitationsMotif,
  buildCuriaBody,
  caseNumberToCelex,
  parseCuriaSearch,
  refineCuriaHits,
} from "@/src/sources/curia";
import {
  enumerateDays,
  filterJusticeItems,
  parseJusticeDecision,
  parseJusticeListing,
} from "@/src/sources/justice";
import { SourceError } from "@/src/sources/shared/errors";

describe("caseNumberToCelex", () => {
  it("derives CELEX sector-6 numbers", () => {
    expect(caseNumberToCelex("C-311/18", "judgment")).toBe("62018CJ0311");
    expect(caseNumberToCelex("C-131/12", "judgment")).toBe("62012CJ0131");
    expect(caseNumberToCelex("C-73/24", "opinion")).toBe("62024CC0073");
    expect(caseNumberToCelex("T-655/17", "judgment")).toBe("62017TJ0655");
  });
  it("handles the century split of two-digit years", () => {
    expect(caseNumberToCelex("C-283/81", "judgment")).toBe("61981CJ0283"); // CILFIT
    expect(caseNumberToCelex("C-1/54", "judgment")).toBe("61954CJ0001");
  });
  it("rejects unparsable numbers", () => {
    expect(caseNumberToCelex("nonsense", "judgment")).toBeNull();
  });
});

describe("buildCuriaBody", () => {
  it("routes party names through full text and keeps usualName set", () => {
    const body = buildCuriaBody({ parties: "Telia Finland" }, 0, 10) as Record<string, unknown>;
    expect(body.searchTerm).toBe("Telia Finland");
    expect(body.usualName).toBe("Telia Finland");
    expect(body.isSearchExact).toBe(true);
  });

  it("maps case status to the affairState filter (closed=CLOTPUB, pending=ENC)", () => {
    const closed = buildCuriaBody({ query: "x", state: "closed" }, 0, 10) as {
      filtersValue: Array<{ field: string; values: string[] }>;
    };
    expect(closed.filtersValue).toContainEqual({
      field: "affairState",
      values: ["CLOTPUB"],
      valuesWithFullHierarchy: ["CLOTPUB"],
    });
    const pending = buildCuriaBody({ query: "x", state: "pending" }, 0, 10) as {
      filtersValue: Array<{ field: string; values: string[] }>;
    };
    expect(pending.filtersValue[0].values).toEqual(["ENC"]);
    const all = buildCuriaBody({ query: "x", state: "all" }, 0, 10) as { filtersValue: unknown[] };
    expect(all.filtersValue).toHaveLength(0);
  });

  it("keyword queries search non-exact; identifier searches stay exact", () => {
    expect((buildCuriaBody({ query: "data protection" }, 0, 10) as { isSearchExact: boolean }).isSearchExact).toBe(false);
    expect((buildCuriaBody({ caseNumber: "C-311/18" }, 0, 10) as { isSearchExact: boolean }).isSearchExact).toBe(true);
  });

  it("mirrors the verbatim SPA body with the criteria filled in", () => {
    const body = buildCuriaBody(
      { caseNumber: "C-311/18", court: "C", sort: "date" },
      0,
      10,
    ) as Record<string, unknown>;
    expect(body.publishedId).toBe("C-311/18");
    expect(body.searchTerm).toBe('"C-311/18"');
    expect(body.tabName).toBe("affair");
    expect(body.searchSources).toEqual(["document", "metadata"]);
    expect((body.sortTermList as Array<{ sortTerm: string }>)[0].sortTerm).toBe("INTRODUCTION_DATE");
    expect((body.filtersValue as Array<{ field: string }>)[0].field).toBe("jurisdiction");
    expect((body.pagination as { from: number; to: number }).from).toBe(1);
  });

  it("sends doc_type as the form's typeDoc codes in advancedFiltersValue", () => {
    const body = buildCuriaBody({ query: "x", docType: "judgment" }, 0, 10) as {
      advancedFiltersValue: unknown[];
    };
    expect(body.advancedFiltersValue).toContainEqual({
      field: "typeDoc",
      values: ["ARRET", "INF", "ARRET_EXT"],
      valuesWithFullHierarchy: [],
      isMatchAll: false,
    });
    const any = buildCuriaBody({ query: "x", docType: "any" }, 0, 10) as {
      advancedFiltersValue: unknown[];
    };
    expect(any.advancedFiltersValue).toHaveLength(0);
  });

  it("maps referring states to NAT_ codes and dates to one from,to value", () => {
    const body = buildCuriaBody(
      { referredFrom: ["CZ", "sk"], dateFrom: "2021-01-01", dateTo: "2025-01-01" },
      0,
      10,
    ) as { advancedFiltersValue: Array<{ field: string; values: string[] }> };
    expect(body.advancedFiltersValue).toContainEqual({
      field: "oqp",
      values: ["NAT_CZ", "NAT_SK"],
      valuesWithFullHierarchy: [],
      isMatchAll: false,
    });
    expect(body.advancedFiltersValue).toContainEqual({
      field: "docDate",
      values: ["2021-01-01,2025-01-01"],
      valuesWithFullHierarchy: [],
      isMatchAll: false,
    });
    const half = buildCuriaBody({ query: "x", dateFrom: "2023-06-01" }, 0, 10) as {
      advancedFiltersValue: Array<{ field: string; values: string[] }>;
    };
    expect(half.advancedFiltersValue.find((f) => f.field === "docDate")?.values).toEqual([
      "2023-06-01,2099-12-31",
    ]);
  });

  it("adds citations and all-language keys only when asked for", () => {
    const cited = buildCuriaBody(
      { citesCelex: "32004L0048", citesArticle: "1", allLanguages: true },
      0,
      10,
    ) as Record<string, unknown>;
    expect(cited.citationsMotif).toBe("32004L0048*A01*");
    expect(cited.selectionCitationMatch).toBe("all");
    expect(cited.allLang).toBe(true);
    const plain = buildCuriaBody({ query: "x" }, 0, 10) as Record<string, unknown>;
    expect("citationsMotif" in plain).toBe(false);
    expect("allLang" in plain).toBe(false);
  });
});

describe("buildCitationsMotif", () => {
  it("encodes CELEX + article the way the form's URL does", () => {
    expect(buildCitationsMotif("32004L0048", "1")).toBe("32004L0048*A01*");
    expect(buildCitationsMotif("32016R0679", "17")).toBe("32016R0679*A17*");
    expect(buildCitationsMotif("32016R0679", "17(2)")).toBe("32016R0679*A17P2*");
    expect(buildCitationsMotif("32016r0679", "a17p2")).toBe("32016R0679*A17P2*");
    expect(buildCitationsMotif("32004L0048")).toBe("32004L0048*");
  });
});

describe("parseCuriaSearch", () => {
  // Synthetic — nested innerHits shape verbatim from the research.
  const payload = {
    totalHits: 2,
    searchHits: [
      {
        affId: 123,
        innerHits: {
          document: {
            searchHits: [
              {
                document: {
                  logicDocId: "id_C2020559",
                  docTypeCode: "ARRET",
                  docDate: "2020-07-16",
                  parties: "Facebook Ireland a Schrems",
                  ecli: "ECLI:EU:C:2020:559",
                  docNoPart: "C-311/18",
                },
              },
            ],
          },
        },
      },
    ],
  };

  it("flattens innerHits into hits", () => {
    const page = parseCuriaSearch(payload);
    expect(page.total).toBe(2);
    expect(page.hits[0].ecli).toBe("ECLI:EU:C:2020:559");
    expect(page.hits[0].caseNumber).toBe("C-311/18");
    expect(page.hits[0].logicDocId).toBe("id_C2020559");
  });

  it("lifts affair-level case name, number and state code", () => {
    const page = parseCuriaSearch({
      totalHits: 1,
      searchHits: [
        {
          content: {
            publishedId: "C-201/22",
            affairStateCode: "CLOTPUB",
            usualNameML: [{ fr: "Telia Finlande" }, { en: "Telia Finland" }],
          },
          innerHits: {
            document: { searchHits: [{ document: { docTypeCode: "ARRET", docDate: "2023-11-23" } }] },
          },
        },
      ],
    });
    expect(page.hits[0].caseName).toBe("Telia Finland");
    expect(page.hits[0].caseNumber).toBe("C-201/22");
    expect(page.hits[0].stateCode).toBe("CLOTPUB");
  });

  it("throws PARSE_DRIFT on shape mismatch", () => {
    expect(() => parseCuriaSearch({ different: true })).toThrowError(SourceError);
  });
});

describe("refineCuriaHits", () => {
  const hits = parseCuriaSearch({
    totalHits: 1,
    searchHits: [
      {
        content: { publishedId: "C-201/22", affairStateCode: "CLOTPUB", usualNameML: [] },
        innerHits: {
          document: {
            searchHits: [
              { document: { docTypeCode: "ARRET", docDate: "2023-11-23" } },
              { document: { docTypeCode: "CONCL", docDate: "2023-05-11" } },
              { document: { docTypeCode: "DDP", docDate: "2022-03-15" } },
            ],
          },
        },
      },
    ],
  }).hits;

  it("filters by doc type prefix", () => {
    expect(refineCuriaHits(hits, { docType: "judgment" })).toHaveLength(1);
    expect(refineCuriaHits(hits, { docType: "opinion" })[0].docType).toBe("CONCL");
    expect(refineCuriaHits(hits, { docType: "any" })).toHaveLength(3);
  });

  it("keeps summaries out of orders and knows avis", () => {
    const extra = [
      { ...hits[0], docType: "RES" },
      { ...hits[0], docType: "ORD" },
      { ...hits[0], docType: "AVIS" },
    ];
    expect(refineCuriaHits(extra, { docType: "order" }).map((h) => h.docType)).toEqual(["ORD"]);
    expect(refineCuriaHits(extra, { docType: "avis" }).map((h) => h.docType)).toEqual(["AVIS"]);
  });

  it("filters by document dates and state guard", () => {
    expect(refineCuriaHits(hits, { dateFrom: "2023-01-01" })).toHaveLength(2);
    expect(refineCuriaHits(hits, { state: "pending" })).toHaveLength(0);
    expect(refineCuriaHits(hits, { state: "closed" })).toHaveLength(3);
  });
});

describe("enumerateDays", () => {
  it("lists inclusive day windows", () => {
    expect(enumerateDays("2026-08-01", "2026-08-03")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
  it("rejects reversed and oversized windows", () => {
    expect(() => enumerateDays("2026-08-03", "2026-08-01")).toThrowError(SourceError);
    expect(() => enumerateDays("2026-08-01", "2026-08-20")).toThrowError(SourceError);
  });
});

describe("parseJusticeListing", () => {
  // Synthetic — item fields verbatim from the ministry's OpenAPI + live probes.
  const payload = {
    items: [
      {
        jednaciCislo: "14 C 263/2020-19",
        soud: "Okresní soud v Mostě",
        autor: "JUDr. Jan Novák",
        ecli: "ECLI:CZ:OSMO:2020:14.C.263.2020.2",
        predmetRizeni: "o zaplacení 12 000 Kč",
        datumVydani: "2020-10-15",
        datumZverejneni: "2020-10-20",
        klicovaSlova: ["smlouva o úvěru"],
        zminenaUstanoveni: ["§ 142 z. č. 99/1963 Sb."],
        odkaz: "https://rozhodnuti.justice.cz/api/finaldoc/1d6380c9-0364-498a-b494-d162a90121cb",
      },
    ],
    totalPages: 4,
    pageNumber: 0,
  };

  it("extracts items and the uuid from the odkaz", () => {
    const listing = parseJusticeListing(payload);
    expect(listing.totalPages).toBe(4);
    expect(listing.items[0].uuid).toBe("1d6380c9-0364-498a-b494-d162a90121cb");
    expect(listing.items[0].soud).toBe("Okresní soud v Mostě");
  });

  it("throws PARSE_DRIFT without items", () => {
    expect(() => parseJusticeListing({})).toThrowError(SourceError);
  });
});

describe("filterJusticeItems", () => {
  const items = parseJusticeListing({
    items: [
      {
        jednaciCislo: "14 C 263/2020-19",
        soud: "Okresní soud v Mostě",
        predmetRizeni: "o zaplacení",
        klicovaSlova: ["úvěr"],
        odkaz: ".../11111111-2222-3333-4444-555555555555",
      },
      {
        jednaciCislo: "5 T 1/2021",
        soud: "Krajský soud v Brně",
        predmetRizeni: "podplácení",
        odkaz: ".../66666666-7777-8888-9999-aaaaaaaaaaaa",
      },
    ],
    totalPages: 1,
  }).items;

  it("filters by court substring and keyword", () => {
    expect(filterJusticeItems(items, { court: "mostě" })).toHaveLength(1);
    expect(filterJusticeItems(items, { keyword: "úvěr" })).toHaveLength(1);
    expect(filterJusticeItems(items, { keyword: "podplácení" })[0].soud).toContain("Brně");
    expect(filterJusticeItems(items, {})).toHaveLength(2);
  });
});

describe("parseJusticeDecision", () => {
  it("prefers verdictText + justificationText", () => {
    const decision = parseJusticeDecision(
      { verdictText: "Soud rozhodl takto.", justificationText: "Odůvodnění věci.", metadata: { type: "JUDGEMENT" } },
      "1d6380c9-0364-498a-b494-d162a90121cb",
    );
    expect(decision.text).toBe("Soud rozhodl takto.\n\nOdůvodnění věci.");
    expect(decision.url).toContain("?id=1d6380c9");
  });

  it("falls back to paragraph joining and tolerates drifted metadata", () => {
    const decision = parseJusticeDecision(
      {
        verdictText: null,
        verdict: [{ texts: [{ text: "Výrok " }, { text: "soudu." }] }],
        justification: [{ texts: [{ text: "Odůvodnění." }] }],
        metadata: { solver: { firstName: "Jan" }, caseResultType: ["X"] },
      },
      "1d6380c9-0364-498a-b494-d162a90121cb",
    );
    expect(decision.text).toBe("Výrok soudu.\n\nOdůvodnění.");
  });

  it("throws PARSE_DRIFT when no text is present", () => {
    expect(() => parseJusticeDecision({ metadata: {} }, "x")).toThrowError(SourceError);
  });
});
