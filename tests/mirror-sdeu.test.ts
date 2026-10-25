import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSdeuYear, sdeuYearQuery } from "@/src/mirror/crawl/sdeu";
import { celexCaseNumber, mapSdeu, NO_CZECH_FULL_TEXT, sdeuCaseNumbers, sdeuCourt, sdeuCzechKind, sdeuType } from "@/src/mirror/map/sdeu";

const year2019 = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "mirror", "sdeu-sparql-2019.json"), "utf8"));

describe("SDEU enumeration (Cellar SPARQL, live 2019 rows)", () => {
  const items = parseSdeuYear(year2019);

  it("groups rows per CELEX with the earliest dates and leaves out companions (_SUM)", () => {
    expect(items.map((i) => i.celex)).toEqual(["62019CC0084", "62019CC0311", "62019CJ0311", "62019CO0853", "62019TO0823"]);
    expect(items.find((i) => i.celex === "62019CJ0311")).toMatchObject({
      ecli: "ECLI:EU:C:2020:981",
      date: "2020-12-03",
      caseCs: "Věc C-311/19",
      partiesCs: "BONVER WIN, a. s. v. Ministerstvo financí ČR",
    });
    expect(items.find((i) => i.celex === "62019TO0823")?.caseCs).toBeUndefined(); // no Czech version listed
  });

  it("pages the query (Cellar caps a result at 10,000 rows)", () => {
    expect(sdeuYearQuery(2019, 5000)).toMatch(/ORDER BY \?celex[^]*LIMIT 5000 OFFSET 5000$/);
    expect(sdeuYearQuery(2019)).toContain('STRSTARTS(STR(?celex), "62019")');
  });
});

describe("mapSdeu", () => {
  it("maps a judgment with its Czech text", () => {
    const item = parseSdeuYear(year2019).find((i) => i.celex === "62019CJ0311")!;
    const record = mapSdeu(item, "ROZSUDEK SOUDNÍHO DVORA (čtvrtého senátu) 3. prosince 2020 … Z těchto důvodů Soudní dvůr (čtvrtý senát) rozhodl takto: …");
    expect(record).toMatchObject({
      source: "sdeu",
      sourceId: "62019CJ0311",
      url: "https://eur-lex.europa.eu/legal-content/CS/TXT/?uri=CELEX:62019CJ0311",
      court: "Soudní dvůr",
      caseNumber: "C-311/19",
      caseNumbers: ["C-311/19"],
      decisionType: "rozsudek",
      sourceFlags: ["CELEX:CJ"],
      decidedOn: "2020-12-03",
      publishedOn: "2020-12-03",
      ecli: "ECLI:EU:C:2020:981",
      text: { source: "sdeu:cellar-ces" },
    });
    expect(record.textAbsent).toBeUndefined();
  });

  it("marks an Advocate General's opinion and every joined case", () => {
    const item = parseSdeuYear(year2019).find((i) => i.celex === "62019CC0084")!;
    const record = mapSdeu(item, "STANOVISKO GENERÁLNÍHO ADVOKÁTA MACIEJE SZPUNARA přednesené dne 2. dubna 2020 …");
    expect(record).toMatchObject({ decisionType: "stanovisko", sourceFlags: ["CELEX:CC", "GA"], caseNumbers: ["C-84/19", "C-222/19", "C-252/19"] });
  });

  it("keeps a Czech summary but marks it: the full text is in another language", () => {
    const item = parseSdeuYear(year2019).find((i) => i.celex === "62019CO0853")!;
    const summary = "Usnesení Soudního dvora (desátého senátu) ze dne 2. července 2020 – IM v. Sting Reality\n(Věc C-853/19)\nPředmět … Rozhodnutí …";
    const record = mapSdeu(item, summary);
    expect(record.text?.source).toBe("sdeu:cellar-ces-souhrn");
    expect(record.sourceFlags).toEqual(["CELEX:CO", NO_CZECH_FULL_TEXT]);
    expect(record.textAbsent).toBeUndefined();
  });

  it("tells a Czech summary from the full text (live pilot texts)", () => {
    expect(sdeuCzechKind("ROZSUDEK SOUDU (druhého senátu) 9. listopadu 2004 … Úplný text ve francouzském jazyce … Předmět: … Rozhodnutí: Žaloba se zamítá.")).toBe("summary");
    expect(sdeuCzechKind("Rozsudek Soudního dvora (sedmého senátu) ze dne 11. ledna 2007 – Komise v. Řecko (Věc C‑269/05) … Předmět … 2) Řecké republice se ukládá náhrada nákladů řízení.")).toBe("summary");
    expect(sdeuCzechKind("… 45 Z těchto důvodů Soudní dvůr (pátý senát) rozhodl takto: …")).toBe("full");
    expect(sdeuCzechKind("… Z\u00a0těchto důvodů Soudní dvůr (druhý senát) usnesl takto:")).toBe("full");
    expect(sdeuCzechKind("STANOVISKO GENERÁLNÍ ADVOKÁTKY JULIANE KOKOTT přednesené dne …")).toBe("full");
    expect(sdeuCzechKind("NÁZOR GENERÁLNÍ ADVOKÁTKY ELEANOR SHARPSTON přednesený …")).toBe("full");
  });

  it("stores a document without a Czech version as such, not as a failure", () => {
    const item = parseSdeuYear(year2019).find((i) => i.celex === "62019TO0823")!;
    const record = mapSdeu(item, null);
    expect(record).toMatchObject({ text: null, textAbsent: "česká verze v Cellaru neexistuje", court: "Tribunál", decisionType: "usneseni", caseNumbers: ["T-823/19"] });
  });

  it("reads court, type and case number from CELEX", () => {
    expect(celexCaseNumber("62019CJ0311")).toBe("C-311/19");
    expect(celexCaseNumber("61994FJ0012")).toBe("F-12/94");
    expect(celexCaseNumber("62019CJ0311_SUM")).toBeNull();
    expect(sdeuCourt("62019TJ0001")).toBe("Tribunál");
    expect(sdeuType("62020CV0001")).toEqual({ type: "jine", flags: ["CELEX:CV"] });
    expect(sdeuCaseNumbers({ celex: "62019CC0311", caseCs: "Věc C-311/19." })).toEqual(["C-311/19"]);
  });
});
