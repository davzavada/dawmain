import { describe, expect, it } from "vitest";
import {
  buildCitationsMotif,
  buildCuriaBody,
  caseNumberToCelex,
  parseCuriaSearch,
  refineCuriaHits,
} from "@/src/sources/curia";
import {
  buildJusticeQuery,
  formatCaseNumber,
  parseJusticeDecision,
  parseJusticeSearch,
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

  it("builds advanced filters the way the SPA's createFilterWs does", () => {
    const body = buildCuriaBody({ query: "x", docType: "judgment" }, 0, 10) as {
      advancedFiltersValue: unknown[];
    };
    // valuesWithFullHierarchy mirrors values; isMatchAll only when meaningful.
    expect(body.advancedFiltersValue).toContainEqual({
      field: "typeDoc",
      values: ["ARRET", "INF", "ARRET_EXT"],
      valuesWithFullHierarchy: ["ARRET", "INF", "ARRET_EXT"],
    });
    const any = buildCuriaBody({ query: "x", docType: "any" }, 0, 10) as {
      advancedFiltersValue: unknown[];
    };
    expect(any.advancedFiltersValue).toHaveLength(0);
  });

  it("maps referring states, cited law and dates to their advanced filters", () => {
    const body = buildCuriaBody(
      {
        referredFrom: ["CZ", "sk"],
        citesCelex: "32004L0048",
        citesArticle: "1",
        dateFrom: "2021-01-01",
        dateTo: "2025-01-01",
      },
      0,
      10,
    ) as { advancedFiltersValue: Array<{ field: string; values: string[] }> };
    expect(body.advancedFiltersValue).toContainEqual({
      field: "oqp",
      values: ["NAT_CZ", "NAT_SK"],
      valuesWithFullHierarchy: ["NAT_CZ", "NAT_SK"],
    });
    expect(body.advancedFiltersValue).toContainEqual({
      field: "citationsMotif",
      values: ["32004L0048*A01*"],
      valuesWithFullHierarchy: ["32004L0048*A01*"],
      isMatchAll: true,
    });
    // Two separate values, hierarchy mirrored, no isMatchAll — the captured
    // payload; the earlier "from,to" single value drew HTTP 500.
    expect(body.advancedFiltersValue).toContainEqual({
      field: "docDate",
      values: ["2021-01-01", "2025-01-01"],
      valuesWithFullHierarchy: ["2021-01-01", "2025-01-01"],
    });
    const half = buildCuriaBody({ query: "x", dateFrom: "2023-06-01" }, 0, 10) as {
      advancedFiltersValue: Array<{ field: string; values: string[] }>;
    };
    expect(half.advancedFiltersValue.find((f) => f.field === "docDate")?.values).toEqual([
      "2023-06-01",
      "2099-12-31",
    ]);
  });

  it("moves the criteria into the filters once any constraint is active", () => {
    // Next to advanced filters the backend silently ignores searchTerm
    // (verified live: "Telia Finland" + a 2023 window returned the whole
    // 2023 slice) — so the criteria must travel as filters, like the form.
    const body = buildCuriaBody(
      { parties: "Telia Finland", dateFrom: "2023-01-01", dateTo: "2023-12-31" },
      0,
      10,
    ) as Record<string, unknown> & { advancedFiltersValue: Array<{ field: string; values: string[] }> };
    expect(body.searchTerm).toBe("");
    expect(body.usualName).toBe("");
    expect(body.isSearchExact).toBe(true);
    expect(body.advancedFiltersValue[0]).toEqual({
      field: "affair",
      values: ["Telia Finland"],
      valuesWithFullHierarchy: ["Telia Finland"],
    });
    expect(body.advancedFiltersValue.some((f) => f.field === "docDate")).toBe(true);
    // allLang widens only the text criterion — a name search doesn't need it.
    expect(body.advancedFiltersValue.some((f) => f.field === "allLang")).toBe(false);

    const withQuery = buildCuriaBody({ query: "dobré mravy", docType: "judgment" }, 0, 10) as {
      advancedFiltersValue: Array<{ field: string; values: string[] }>;
      searchTerm: string;
    };
    expect(withQuery.searchTerm).toBe("");
    expect(withQuery.advancedFiltersValue[0].field).toBe("text");
    // The text criterion alone searches only the chosen language version —
    // allLang keeps the advanced route as multilingual as the searchTerm one.
    expect(withQuery.advancedFiltersValue).toContainEqual({
      field: "allLang",
      values: ["true"],
      valuesWithFullHierarchy: ["true"],
    });
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

  it("links each document to its curia.europa.eu page in the search language", () => {
    const page = parseCuriaSearch(payload, "cs");
    expect(page.hits[0].url).toBe(
      "https://curia.europa.eu/juris/document/document.jsf?text=&docid=C2020559&doclang=CS",
    );
    // Without a logicDocId the ECLI falls back to EUR-Lex in the same language.
    const noId = parseCuriaSearch(
      {
        totalHits: 1,
        searchHits: [
          { innerHits: { document: { searchHits: [{ document: { ecli: "ECLI:EU:C:2020:559" } }] } } },
        ],
      },
      "cs",
    );
    expect(noId.hits[0].url).toBe(
      "https://eur-lex.europa.eu/legal-content/CS/TXT/?uri=ecli:ECLI%3AEU%3AC%3A2020%3A559",
    );
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

  it("surfaces the affair itself when a keyword-less search scores no documents", () => {
    const page = parseCuriaSearch(
      {
        totalHits: 143,
        searchHits: [
          {
            content: {
              publishedId: "C-57/21",
              affairStateCode: "CLOTPUB",
              usualNameML: [{ en: "RegioJet" }],
            },
            innerHits: { document: { searchHits: [] } },
          },
        ],
      },
      "cs",
    );
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0].caseNumber).toBe("C-57/21");
    expect(page.hits[0].caseName).toBe("RegioJet");
    expect(page.hits[0].docType).toBeUndefined();
    expect(page.hits[0].url).toBe("https://curia.europa.eu/juris/liste.jsf?num=C-57%2F21&language=cs");
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

/**
 * Shapes verbatim from live /api/finaldoc responses (captured 2026-09 through
 * the deployment's own probe). The endpoint is the SPA's, not the documented
 * open-data one, so the parser is written against what it actually returns.
 */
describe("justice.cz search", () => {
  const live = {
    items: [
      {
        uuid: "0de9a948-38d8-4d00-8010-cf5a2e086f73",
        metadata: {
          type: "JUDGEMENT",
          ecli: "ECLI:CZ:KSOS:2025:8.Co.60.2025.1",
          publishedAt: "2025-07-23",
          decisionAt: "2025-06-02",
          caseNumber: { senate: 8, registry: "Co", index: 60, year: 2025, pageNumber: 174 },
          solver: {
            titlesBefore: "JUDr.",
            firstName: "Šárka",
            lastName: "Neuwirthová",
            titlesAfter: "",
            function: "předsedkyně senátu",
          },
          courtCode: "KSOS",
          caseSubject: "o zaplacení 94.401,99 Kč s příslušenstvím",
          affectedDocs: [
            {
              caseNumber: { senate: 12, registry: "C", index: 2, year: 2024, pageNumber: 144 },
              affectedDate: "2024-11-08",
              courtCode: "OSNJ",
              affectedTypes: ["CHANGE"],
              url: null,
            },
          ],
        },
        verdictText: "I. Rozsudek okresního soudu se v napadené části mění tak, že…",
        searchMatches: null,
      },
    ],
    numberOfItems: 1,
    pageSize: 1,
    pageNumber: 0,
    totalPages: 8,
    totalElements: 8,
  };

  it("parses a live hit, including what it did to the lower court's ruling", () => {
    const page = parseJusticeSearch(live);
    expect(page.total).toBe(8);
    expect(page.totalPages).toBe(8);
    const [hit] = page.hits;
    expect(hit.caseNumber).toBe("8 Co 60/2025-174");
    expect(hit.court).toBe("KSOS");
    expect(hit.decidedAt).toBe("2025-06-02");
    expect(hit.judge).toBe("JUDr. Šárka Neuwirthová");
    expect(hit.affects).toEqual([
      { caseNumber: "12 C 2/2024-144", court: "OSNJ", date: "2024-11-08", types: ["CHANGE"] },
    ]);
    expect(hit.url).toContain(hit.uuid);
  });

  it("drops rows without a uuid — it is the only handle the next tool takes", () => {
    const page = parseJusticeSearch({ items: [{ metadata: { ecli: "X" } }], totalElements: 1 });
    expect(page.hits).toHaveLength(0);
  });

  it("throws PARSE_DRIFT without items", () => {
    expect(() => parseJusticeSearch({})).toThrowError(SourceError);
  });

  it("formats a case number, and gives up when the index or year is missing", () => {
    expect(formatCaseNumber({ senate: 30, registry: "C", index: 87, year: 2023 })).toBe("30 C 87/2023");
    expect(formatCaseNumber({ registry: "C", index: 87, year: 2023 })).toBe("C 87/2023");
    expect(formatCaseNumber({ senate: 30, registry: "C" })).toBeUndefined();
    expect(formatCaseNumber(undefined)).toBeUndefined();
  });

  it("builds the query the SPA sends", () => {
    const params = buildJusticeQuery(
      {
        query: "nájem bytu",
        match: "phrase",
        caseNumber: "8 Co 60/2025",
        courtCodes: ["ksos"],
        types: ["JUDGEMENT"],
        decidedFrom: "2025-01-01",
        publishedTo: "2026-01-01",
        appliesAct: "89/2012 Sb.",
        appliesSection: "§ 2201",
        sort: "decided",
      },
      2,
      10,
    );
    expect(params.get("searchText")).toBe("nájem bytu");
    expect(params.get("searchMode")).toBe("EXACT");
    expect(params.get("caseNumberSenate")).toBe("8");
    expect(params.get("caseNumberRegistry")).toBe("Co");
    expect(params.get("caseNumberIndex")).toBe("60");
    expect(params.get("caseNumberYear")).toBe("2025");
    expect(params.getAll("courtCodes")).toEqual(["KSOS"]);
    expect(params.getAll("type")).toEqual(["JUDGEMENT"]);
    expect(params.get("issuedFrom")).toBe("2025-01-01");
    expect(params.get("publishedTo")).toBe("2026-01-01");
    expect(params.get("regulationNumber")).toBe("89");
    expect(params.get("regulationYear")).toBe("2012");
    expect(params.get("regulationParagraph")).toBe("2201");
    expect(params.get("sortBy")).toBe("DECISION_AT");
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("10");
  });

  it("omits searchMode when there is nothing to search for", () => {
    const params = buildJusticeQuery({ appliesAct: "99/1963" }, 0, 20);
    expect(params.has("searchText")).toBe(false);
    expect(params.has("searchMode")).toBe(false);
    expect(params.get("sortBy")).toBe("PUBLISHED_AT");
  });

  it("refuses an unknown court code with the menu, not zero hits", () => {
    // The API accepts any string here and answers an unknown one with an empty
    // result — indistinguishable from "no such case law exists".
    expect(() => buildJusticeQuery({ courtCodes: ["OSXX"] }, 0, 20)).toThrowError(/not a justice\.cz court code/);
  });

  it("rejects a section with no act, and inputs it cannot map", () => {
    expect(() => buildJusticeQuery({ appliesSection: "§ 2201" }, 0, 20)).toThrowError(SourceError);
    expect(() => buildJusticeQuery({ appliesAct: "obcansky zakonik" }, 0, 20)).toThrowError(SourceError);
    expect(() => buildJusticeQuery({ caseNumber: "nesmysl" }, 0, 20)).toThrowError(SourceError);
  });
});
