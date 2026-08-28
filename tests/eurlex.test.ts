import { describe, expect, it } from "vitest";
import {
  buildContainsExpression,
  buildEurlexSparql,
  parseEurlexResults,
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
