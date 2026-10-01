import { describe, expect, it } from "vitest";
import {
  EURLEX_TYPES,
  buildContainsExpression,
  buildEurlexSparql,
  buildLegislativeHistorySparql,
  normalizeProcedureReference,
  parseEurlexPage,
  parseEurlexResults,
  parseLegislativeHistoryResults,
  virtuosoFailure,
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
    // Punctuation separates: "1=1" is two one-digit tokens, both too short.
    expect(buildContainsExpression(`x') OR 1=1 --`)).toBe("'OR'");
    expect(buildContainsExpression(`data'"; DROP`)).toBe("'data' AND 'DROP'");
    expect(buildContainsExpression(`;;; '' ""`)).toBeNull();
    for (const hostile of [`a\\' OR 'b`, `x" . } DROP`, `'; DELETE {`, `ab\\\\"cd`]) {
      for (const term of buildContainsExpression(hostile)?.split(" AND ") ?? []) {
        expect(term, hostile).toMatch(/^'[0-9A-Za-zÀ-žƀ-ɏ*-]+'$/u);
      }
    }
  });
  it("splits act and case numbers at the slash instead of gluing them", () => {
    // Glued, '2016679' and 'C-31118' matched no title: live "No EUR-Lex documents matched".
    expect(buildContainsExpression("Regulation 2016/679")).toBe("'Regulation' AND '2016' AND '679'");
    expect(buildContainsExpression("C-311/18")).toBe("'C-311' AND '18'");
    expect(buildContainsExpression("Member State's rights")).toBe("'Member' AND 'State' AND 'rights'");
  });
  it("NFC-normalises decomposed input instead of dropping its diacritics", () => {
    expect(buildContainsExpression("údajů".normalize("NFD"))).toBe("'údajů'");
  });
  it("keeps a trailing wildcard only on a stem Virtuoso accepts", () => {
    expect(buildContainsExpression("da* protect* *x")).toBe("'da' AND 'protect*'");
    expect(buildContainsExpression("dat* data*")).toBe("'dat' AND 'data*'");
    expect(buildContainsExpression("pro*tect")).toBe("'pro' AND 'tect'");
    expect(buildContainsExpression("C-311*")).toBe("'C-311'");
  });
  it("caps the terms at 8", () => {
    expect(buildContainsExpression("a1 b2 c3 d4 e5 f6 g7 h8 i9")?.split(" AND ")).toHaveLength(8);
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
    expect(sparql).toContain("language/ENG");
  });

  it("groups rows by work and asks one beyond the page, with a deterministic order", () => {
    const sparql = buildEurlexSparql({ query: "data protection" }, 10, 20);
    expect(sparql).toContain("GROUP BY ?celex");
    expect(sparql).toContain("ORDER BY DESC(?d) ?celex");
    expect(sparql).toContain("LIMIT 11 OFFSET 20");
    expect(sparql).toContain("(SAMPLE(?title) AS ?t)");
  });

  it("supports CELEX/ECLI lookups and Czech titles", () => {
    const sparql = buildEurlexSparql({ celex: "32016R0679", language: "cs" }, 5, 0);
    expect(sparql).toContain('FILTER(STR(?celex) = "32016R0679")');
    expect(sparql).toContain("language/CES");
  });

  it("sanitizes quotes out of identifiers", () => {
    const sparql = buildEurlexSparql({ celex: '3"malicious' }, 5, 0);
    expect(sparql).not.toContain('""');
    expect(sparql).toContain('FILTER(STR(?celex) = "3MALICIOUS")');
  });

  it("normalises the CELEX: prefix, spaces and case, and the ECLI", () => {
    expect(buildEurlexSparql({ celex: " CELEX:32016r0679 " }, 5, 0)).toContain('FILTER(STR(?celex) = "32016R0679")');
    const byEcli = buildEurlexSparql({ ecli: " ecli:eu:c:2020:559" }, 5, 0);
    expect(byEcli).toContain('FILTER(STR(?ecli) = "ECLI:EU:C:2020:559")');
    // A required ECLI is matched, not left OPTIONAL.
    expect(byEcli).toContain("?work cdm:case-law_ecli ?ecli .");
    expect(byEcli).not.toContain("OPTIONAL { ?work cdm:case-law_ecli");
  });

  it("finds an identifier without a title in the requested language", () => {
    const sparql = buildEurlexSparql({ celex: "31983R1983", language: "cs" }, 5, 0);
    expect(sparql).toMatch(/OPTIONAL \{ \?expr [^}]*language\/CES[^}]*\?titleLang \. \}/);
    expect(sparql).toMatch(/OPTIONAL \{ \?exprEn [^}]*language\/ENG/);
    expect(sparql).toContain("(SAMPLE(COALESCE(?titleLang, ?titleEn, ?titleAny)) AS ?t)");
    expect(sparql).not.toContain("bif:contains");
    // No BIND wrapping the pattern; the identifier filter comes before the title OPTIONALs.
    expect(sparql).not.toContain("BIND(");
    expect(sparql.indexOf('FILTER(STR(?celex) = "31983R1983")')).toBeLessThan(sparql.indexOf("OPTIONAL { ?expr "));
    // English requested: no duplicate English fallback.
    expect(buildEurlexSparql({ celex: "31983R1983" }, 5, 0)).toContain("(SAMPLE(COALESCE(?titleLang, ?titleAny)) AS ?t)");
  });

  it("keeps the mandatory title join for a title search", () => {
    const sparql = buildEurlexSparql({ query: "data", celex: "32016R0679", language: "cs" }, 5, 0);
    expect(sparql).toMatch(/^ {2}\?expr cdm:expression_belongs_to_work \?work ; [^\n]*language\/CES[^\n]*\?title \.$/m);
    expect(sparql).not.toContain("COALESCE");
    expect(sparql).toContain('?title bif:contains "\'data\'"');
  });

  it("includes implementing and delegated acts in regulation/directive/decision", () => {
    const sparql = buildEurlexSparql({ query: "x1", types: ["regulation", "directive", "decision"] }, 10, 0);
    for (const code of ["REG", "REG_IMPL", "REG_DEL", "DIR", "DIR_IMPL", "DIR_DEL", "DEC", "DEC_IMPL", "DEC_DEL", "DEC_FRAMW"]) {
      expect(sparql).toContain(`resource-type/${code}>`);
    }
    const narrow = buildEurlexSparql({ query: "x1", types: ["implementing_act"] }, 10, 0);
    expect(narrow).toContain("resource-type/REG_IMPL>");
    expect(narrow).toContain("resource-type/DEC_IMPL>");
    expect(narrow).not.toContain("resource-type/REG>");
    // Overlapping groups list a code once.
    const both = buildEurlexSparql({ query: "x1", types: ["regulation", "implementing_act"] }, 10, 0);
    expect(both.match(/resource-type\/REG_IMPL>/g)).toHaveLength(1);
  });

  it("ignores type names that are not own keys of the table", () => {
    const sparql = buildEurlexSparql({ query: "x1", types: ["constructor", "__proto__", "toString"] }, 10, 0);
    expect(sparql).not.toContain("FILTER(?type IN");
    expect(Object.hasOwn(EURLEX_TYPES, "constructor")).toBe(false);
  });

  it("rejects an impossible calendar date and an inverted range", () => {
    for (const [dateFrom, dateTo] of [["2024-02-30", undefined], [undefined, "2025-06-31"], ["2024-13-01", undefined]]) {
      expect(() => buildEurlexSparql({ query: "data", dateFrom, dateTo }, 10, 0)).toThrowError(
        expect.objectContaining({ kind: "INPUT_INVALID", message: expect.stringContaining("not a real calendar date") }),
      );
    }
    expect(buildEurlexSparql({ query: "data", dateFrom: "2024-02-29" }, 10, 0)).toContain('"2024-02-29"^^xsd:date');
    expect(() => buildEurlexSparql({ query: "data", dateFrom: "2024-05-01", dateTo: "2024-01-01" }, 10, 0)).toThrowError(
      expect.objectContaining({ kind: "INPUT_INVALID", hint: expect.stringContaining("inverted") }),
    );
  });

  it("resolves language aliases and refuses unknown codes instead of searching English", () => {
    for (const language of ["cz", "cze", "ces", "CS", "cs-CZ"]) {
      expect(buildEurlexSparql({ query: "data", language }, 5, 0), language).toContain("language/CES");
    }
    expect(buildEurlexSparql({ query: "data", language: "nl" }, 5, 0)).toContain("language/NLD");
    expect(buildEurlexSparql({ query: "data", language: "hu" }, 5, 0)).toContain("language/HUN");
    for (const language of ["xx", "constructor", "__proto__"]) {
      expect(() => buildEurlexSparql({ query: "data", language }, 5, 0), language).toThrowError(
        expect.objectContaining({ kind: "INPUT_INVALID" }),
      );
    }
  });

  it("needs a criterion (a blank identifier is none)", () => {
    expect(() => buildEurlexSparql({ celex: "  " }, 5, 0)).toThrowError(
      expect.objectContaining({ kind: "INPUT_INVALID" }),
    );
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

  it("keeps distinct works that share an ECLI — the judgment is not collapsed into its abstract", () => {
    const ecli = { value: "ECLI:EU:C:2026:600" };
    const hits = parseEurlexResults({
      results: {
        bindings: [
          { celex: { value: "62024CJ0474_RES" }, e: ecli, t: { value: "Judgment" }, d: { value: "2026-07-14" } },
          { celex: { value: "62024CJ0474" }, e: ecli, t: { value: "Judgment" }, d: { value: "2026-07-14" } },
        ],
      },
    });
    expect(hits.map((hit) => hit.celex)).toEqual(["62024CJ0474_RES", "62024CJ0474"]);
    expect(hits[1]).toMatchObject({ ecli: ecli.value, date: "2026-07-14", title: "Judgment" });
  });

  it("reads the grouped columns of the search query", () => {
    const [hit] = parseEurlexResults({
      results: {
        bindings: [
          {
            celex: { value: "32024R3193" },
            d: { value: "2024-12-19" },
            t: { value: "Commission Implementing Regulation (EU) 2024/3193" },
            ty: { value: "http://publications.europa.eu/resource/authority/resource-type/REG_IMPL" },
          },
        ],
      },
    });
    expect(hit).toEqual({
      celex: "32024R3193",
      date: "2024-12-19",
      title: "Commission Implementing Regulation (EU) 2024/3193",
      type: "REG_IMPL",
      url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R3193",
    });
  });

  it("throws PARSE_DRIFT without bindings (HTML rate-limit page)", () => {
    expect(() => parseEurlexResults({ error: "x" })).toThrowError(SourceError);
  });
});

describe("parseEurlexPage", () => {
  const rows = (n: number) => ({
    results: { bindings: Array.from({ length: n }, (_, i) => ({ celex: { value: `3202${i}R0001` }, t: { value: "t" } })) },
  });
  it("shows limit hits and says more exist when the extra row came back", () => {
    const page = parseEurlexPage(rows(11), 10);
    expect(page.hits).toHaveLength(10);
    expect(page.hasMore).toBe(true);
  });
  it("says nothing more on an exactly full or short page", () => {
    expect(parseEurlexPage(rows(10), 10)).toMatchObject({ hasMore: false });
    expect(parseEurlexPage(rows(3), 10).hits).toHaveLength(3);
  });
});

describe("virtuosoFailure", () => {
  it("passes a clean answer", () => {
    expect(virtuosoFailure(200, '{"results":{"bindings":[]}}')).toBeNull();
  });
  it("names a refused query as the caller's to rephrase", () => {
    const error = virtuosoFailure(200, "Virtuoso 22023 Error FT370: Wildcard word needs at least 4 leading characters");
    expect(error).toMatchObject({ kind: "INPUT_INVALID" });
    expect(error?.message).toContain("FT370: Wildcard word needs at least 4 leading characters");
    expect(error?.hint).toContain("protect*");
    expect(virtuosoFailure(400, "Virtuoso 37000 Error SP030: SPARQL compiler, line 3: syntax error")).toMatchObject({
      kind: "INPUT_INVALID",
    });
  });
  it("sends a run-time limit to a narrower query", () => {
    const error = virtuosoFailure(200, "Virtuoso 42000 Error The estimated execution time 812 (sec) exceeds the limit of 400 (sec).");
    expect(error).toMatchObject({ kind: "UPSTREAM_ERROR" });
    expect(error?.hint).toContain("narrow the date range");
  });
  it("keeps any other rejection an upstream error", () => {
    expect(virtuosoFailure(403, "<html>Forbidden</html>")).toMatchObject({
      kind: "UPSTREAM_ERROR",
      message: expect.stringContaining("HTTP 403"),
    });
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
    expect(sparql).toContain('"3MALICIOUS"^^xsd:string');
  });

  it("strips the CELEX: prefix", () => {
    expect(buildLegislativeHistorySparql({ celex: "CELEX:32016R0679" })).toContain(
      'cdm:resource_legal_id_celex "32016R0679"^^xsd:string',
    );
  });

  it("refuses unknown and prototype-key languages instead of answering in English", () => {
    for (const language of ["xx", "constructor", "__proto__"]) {
      expect(() => buildLegislativeHistorySparql({ celex: "32016R0679", language }), language).toThrowError(
        expect.objectContaining({ kind: "INPUT_INVALID" }),
      );
    }
  });

  it("filters dossier titles on the resolved 2-letter tag, whatever the spelling", () => {
    for (const language of ["cz", "cze", "ces", "cs-CZ"]) {
      const sparql = buildLegislativeHistorySparql({ celex: "32016R0679", language });
      expect(sparql, language).toContain("language/CES");
      expect(sparql, language).toContain('LCASE(LANG(?dossierTitle)) = "cs"');
    }
    const dutch = buildLegislativeHistorySparql({ celex: "32016R0679", language: "nl" });
    expect(dutch).toContain("language/NLD");
    expect(dutch).toContain('LCASE(LANG(?dossierTitle)) = "nl"');
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
