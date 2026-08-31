import { describe, expect, it } from "vitest";
import {
  buildContainsExpression,
  buildEurlexSparql,
  buildLegislativeHistorySparql,
  normalizeProcedureReference,
  parseEurlexResults,
  parseLegislativeHistoryResults,
} from "@/src/sources/eurlex";
import { SourceError } from "@/src/sources/shared/errors";

describe("buildContainsExpression", () => {
  it("quotes terms and joins with AND", () => {
    expect(buildContainsExpression("data protection")).toBe("'data' AND 'protection'");
    expect(buildContainsExpression("ochrana osobních údajů")).toBe(
      "'ochrana' AND 'osobních' AND 'údajů'",
    );
  });
  it("strips injection characters, bare punctuation and short tokens", () => {
    expect(buildContainsExpression(`x') OR 1=1 --`)).toBe("'OR' AND '11'");
    expect(buildContainsExpression(`data'"; DROP`)).toBe("'data' AND 'DROP'");
    expect(buildContainsExpression(`;;; '' ""`)).toBeNull();
  });
});

describe("buildEurlexSparql", () => {
  it("builds a title search with type and date filters", () => {
    const sparql = buildEurlexSparql(
      { query: "data protection", types: ["regulation", "directive"], dateFrom: "2015-01-01" },
      10,
      0,
    );
    expect(sparql).toContain('?title bif:contains "\'data\' AND \'protection\'"');
    expect(sparql).toContain("resource-type/REG");
    expect(sparql).toContain("resource-type/DIR");
    expect(sparql).toContain('"2015-01-01"^^xsd:date');
    expect(sparql).toContain("LIMIT 10 OFFSET 0");
    expect(sparql).toContain("language/ENG");
  });

  it("supports CELEX/ECLI lookups and Czech titles", () => {
    const sparql = buildEurlexSparql({ celex: "32016R0679", language: "cs" }, 5, 0);
    expect(sparql).toContain('FILTER(STR(?celex) = "32016R0679")');
    expect(sparql).toContain("language/CES");
  });

  it("sanitizes quotes out of identifiers", () => {
    const sparql = buildEurlexSparql({ celex: '3"malicious' }, 5, 0);
    expect(sparql).not.toContain('""');
    expect(sparql).toContain('FILTER(STR(?celex) = "3malicious")');
  });
});

describe("parseEurlexResults", () => {
  it("maps bindings and dedupes duplicate works", () => {
    const hits = parseEurlexResults({
      results: {
        bindings: [
          {
            celex: { value: "32016R0679" },
            title: { value: "Regulation (EU) 2016/679 … (GDPR)" },
            date: { value: "2016-04-27" },
            type: { value: "http://publications.europa.eu/resource/authority/resource-type/REG" },
          },
          {
            celex: { value: "32016R0679" },
            title: { value: "Regulation (EU) 2016/679 … (GDPR)" },
            date: { value: "2016-04-27" },
            type: { value: "http://publications.europa.eu/resource/authority/resource-type/REG" },
          },
          {
            celex: { value: "62018CJ0311" },
            ecli: { value: "ECLI:EU:C:2020:559" },
            title: { value: "Judgment — Schrems II" },
            date: { value: "2020-07-16" },
            type: { value: "http://publications.europa.eu/resource/authority/resource-type/JUDG" },
          },
        ],
      },
    });
    expect(hits).toHaveLength(2);
    expect(hits[0].type).toBe("REG");
    expect(hits[0].url).toContain("CELEX:32016R0679");
    expect(hits[1].ecli).toBe("ECLI:EU:C:2020:559");
  });

  it("throws PARSE_DRIFT without bindings (HTML rate-limit page)", () => {
    expect(() => parseEurlexResults({ error: "x" })).toThrowError(SourceError);
  });
});

describe("buildEurlexSparql — legislative materials", () => {
  it("expands grouped types into every authority code", () => {
    const sparql = buildEurlexSparql({ query: "data protection", types: ["proposal"] }, 10, 0);
    for (const code of ["PROP_REG", "PROP_DIR", "PROP_DEC"]) {
      expect(sparql).toContain(`resource-type/${code}`);
    }
  });

  it("mixes legislative and adopted-act types in one filter", () => {
    const sparql = buildEurlexSparql(
      { query: "data", types: ["regulation", "impact_assessment"] },
      10,
      0,
    );
    expect(sparql).toContain("resource-type/REG");
    expect(sparql).toContain("resource-type/IMPACT_ASSESS");
    expect(sparql).toContain("resource-type/IMPACT_ASSESS_SUM");
  });
});

describe("normalizeProcedureReference", () => {
  it("normalizes the common EUR-Lex spellings to Cellar's form", () => {
    expect(normalizeProcedureReference("2012/0011(COD)")).toEqual({ exact: "2012/0011/COD" });
    expect(normalizeProcedureReference("2012/0011/COD")).toEqual({ exact: "2012/0011/COD" });
    expect(normalizeProcedureReference("2012/11 cod")).toEqual({ exact: "2012/0011/COD" });
    expect(normalizeProcedureReference("2012_11_COD")).toEqual({ exact: "2012/0011/COD" });
  });
  it("falls back to a year/number prefix when the code is missing", () => {
    expect(normalizeProcedureReference("2012/0011")).toEqual({ prefix: "2012/0011/" });
  });
  it("accepts and drops the split-procedure letter suffix (Cellar stores none)", () => {
    expect(normalizeProcedureReference("2016/0062A(NLE)")).toEqual({ exact: "2016/0062/NLE" });
    expect(normalizeProcedureReference("2013/0255A(APP)")).toEqual({ exact: "2013/0255/APP" });
    expect(normalizeProcedureReference("2016/0062A")).toEqual({ prefix: "2016/0062/" });
  });
  it("rejects garbage", () => {
    expect(normalizeProcedureReference("GDPR")).toBeNull();
    expect(normalizeProcedureReference("")).toBeNull();
  });
});

describe("buildLegislativeHistorySparql", () => {
  it("anchors by celex and requests the language with English fallback", () => {
    const sparql = buildLegislativeHistorySparql({ celex: "32016R0679", language: "cs" });
    expect(sparql).toContain('cdm:resource_legal_id_celex "32016R0679"^^xsd:string');
    expect(sparql).toContain("cdm:dossier_contains_work ?work");
    expect(sparql).toContain("language/CES");
    expect(sparql).toContain("language/ENG");
    expect(sparql).toContain('LCASE(LANG(?dossierTitle)) = "cs"');
    expect(sparql).toContain("?dossierTitleEn");
  });

  it("skips the duplicate fallback when English is requested", () => {
    const sparql = buildLegislativeHistorySparql({ celex: "32016R0679" });
    expect(sparql).toContain("language/ENG");
    expect(sparql).not.toContain("?titleEn");
    expect(sparql).not.toContain("?dossierTitleEn");
  });

  it("anchors by normalized procedure reference", () => {
    const sparql = buildLegislativeHistorySparql({ procedure: "2012/0011(COD)" });
    expect(sparql).toContain(
      'cdm:procedure_code_interinstitutional_reference_procedure "2012/0011/COD"^^xsd:string',
    );
  });

  it("uses a prefix match when the procedure code is missing", () => {
    const sparql = buildLegislativeHistorySparql({ procedure: "2012/0011" });
    expect(sparql).toContain('STRSTARTS(STR(?procRef), "2012/0011/")');
  });

  it("sanitizes quotes out of the celex", () => {
    const sparql = buildLegislativeHistorySparql({ celex: '3"malicious' });
    expect(sparql).toContain('"3malicious"^^xsd:string');
  });

  it("collapses unknown and prototype-key languages to English", () => {
    for (const language of ["xx", "constructor", "__proto__"]) {
      const sparql = buildLegislativeHistorySparql({ celex: "32016R0679", language });
      expect(sparql).toContain("language/ENG");
      expect(sparql).not.toContain("?titleEn");
    }
  });

  it("throws INPUT_INVALID without an anchor or with a bad procedure", () => {
    expect(() => buildLegislativeHistorySparql({})).toThrowError(SourceError);
    expect(() => buildLegislativeHistorySparql({ procedure: "GDPR" })).toThrowError(SourceError);
  });
});

describe("parseLegislativeHistoryResults", () => {
  // Shapes captured live from the Cellar endpoint (GDPR dossier, abridged).
  const AUTH = "http://publications.europa.eu/resource/authority";
  const dossierFields = {
    dossier: { value: "http://publications.europa.eu/resource/cellar/9cd0a4b3" },
    identifier: { value: "procedure:2012_11" },
    procedure: { value: "2012/0011/COD" },
    procType: { value: `${AUTH}/procedure/OLP` },
    basis: { value: "TFUE/art 16 par 2, art 114 par 1" },
    adopted: { value: "1" },
    pending: { value: "0" },
    withdrawn: { value: "0" },
    dateAdopted: { value: "2016-05-04" },
    dossierTitle: { value: "Návrh NAŘÍZENÍ … (obecné nařízení o ochraně údajů)" },
  };
  const proposalRow = {
    ...dossierFields,
    member: { value: "http://publications.europa.eu/resource/celex/52012PC0011" },
    celex: { value: "52012PC0011" },
    date: { value: "2012-01-25" },
    type: { value: `${AUTH}/resource-type/PROP_REG` },
    titleEn: { value: "Proposal for a REGULATION … (General Data Protection Regulation)" },
  };

  it("regroups rows into one dossier with deduplicated, date-sorted documents", () => {
    const { dossiers, truncated } = parseLegislativeHistoryResults({
      results: {
        bindings: [
          proposalRow,
          proposalRow, // duplicate row — Cellar yields them
          {
            ...dossierFields,
            // Council working document: type + date, but no CELEX and no title.
            member: { value: "http://publications.europa.eu/resource/pegase/CSST_2016_7805" },
            date: { value: "2016-04-05" },
            type: { value: `${AUTH}/resource-type/NOTE` },
          },
          {
            ...dossierFields,
            // Bare OJ-edition work — no CELEX, type or title: dropped.
            member: { value: "http://publications.europa.eu/resource/oj/JOL_2016_119_R_0001_01" },
          },
          {
            ...dossierFields,
            member: { value: "http://publications.europa.eu/resource/celex/32016R0679" },
            celex: { value: "32016R0679" },
            date: { value: "2016-04-27" },
            type: { value: `${AUTH}/resource-type/REG` },
            title: { value: "Nařízení Evropského parlamentu a Rady (EU) 2016/679" },
          },
        ],
      },
    });

    expect(truncated).toBe(false);
    expect(dossiers).toHaveLength(1);
    const [dossier] = dossiers;
    expect(dossier.procedure).toBe("2012/0011/COD");
    expect(dossier.procedure_type).toBe("OLP");
    expect(dossier.legal_basis).toBe("TFUE/art 16 par 2, art 114 par 1");
    expect(dossier.status).toBe("adopted");
    expect(dossier.date_adopted).toBe("2016-05-04");
    expect(dossier.title).toContain("obecné nařízení");
    expect(dossier.url).toBe("https://eur-lex.europa.eu/procedure/EN/2012_11");

    expect(dossier.documents.map((doc) => doc.celex ?? doc.type)).toEqual([
      "52012PC0011",
      "NOTE",
      "32016R0679",
    ]);
    expect(dossier.documents[0].url).toBe(
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:52012PC0011",
    );
    expect(dossier.documents[0].title).toContain("Proposal");
    expect(dossier.documents[1].url).toBe(
      "http://publications.europa.eu/resource/pegase/CSST_2016_7805",
    );
  });

  it("marks a live procedure as pending", () => {
    const { dossiers } = parseLegislativeHistoryResults({
      results: {
        bindings: [
          {
            ...proposalRow,
            adopted: { value: "0" },
            pending: { value: "1" },
            dateAdopted: undefined,
          },
        ],
      },
    });
    expect(dossiers[0].status).toBe("pending");
  });

  it("flags truncation when the row cap is hit", () => {
    const { truncated } = parseLegislativeHistoryResults({
      results: { bindings: Array.from({ length: 500 }, () => proposalRow) },
    });
    expect(truncated).toBe(true);
  });

  it("throws PARSE_DRIFT without bindings", () => {
    expect(() => parseLegislativeHistoryResults({ error: "x" })).toThrowError(SourceError);
  });
});
