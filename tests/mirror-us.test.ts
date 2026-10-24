import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNalusAbstract, parseNalusDecision, parseNalusResults } from "@/src/sources/nalus";
import { mapUs, parseUsPublishedDates, usCaseNumber, usCourt, usTextExtras, type UsHit } from "@/src/mirror/map/us";
import { nextQuarter, quarterRange, spread } from "@/src/mirror/crawl/us";
import { decisionType } from "@/src/mirror/types";

const fixture = (dir: string, name: string) => readFileSync(path.join(__dirname, "fixtures", dir, name), "utf8");

describe("ÚS results rows", () => {
  it("reads the date of publication (4th line of the date cell) for every row", () => {
    const html = fixture("nalus", "results-page-1.html");
    const hits = parseNalusResults(html).hits;
    const published = parseUsPublishedDates(html);
    expect(published.size).toBe(hits.length);
    expect(published.get("1-1169-26_1")).toBe("2026-07-27");
    for (const hit of hits) expect(published.get(hit.sz!)! >= hit.date!).toBe(true);
  });
});

describe("mapUs", () => {
  const html = fixture("mirror", "us-gettext-1-1169-26_1.html");
  const hit: UsHit = {
    sz: "1-1169-26_1",
    caseNumber: "I.ÚS 1169/26 #1",
    ecli: "ECLI:CZ:US:2026:1.US.1169.26.1",
    date: "2026-07-07",
    publishedOn: "2026-07-27",
    url: null,
  };

  it("maps the row, the text and the právní věta to the base record", () => {
    const decision = parseNalusDecision(html, hit.sz);
    const abstract = parseNalusAbstract(fixture("mirror", "us-getabstract-1-1169-26_1.html"));
    const record = mapUs(hit, decision, abstract, usTextExtras(html));
    expect(record).toMatchObject({
      source: "us",
      sourceId: "1-1169-26_1",
      url: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-1169-26_1",
      court: "Ústavní soud – I. senát",
      caseNumber: "I. ÚS 1169/26",
      caseNumbers: ["I. ÚS 1169/26"],
      decidedOn: "2026-07-07",
      ecli: "ECLI:CZ:US:2026:1.US.1169.26.1",
      publishedOn: "2026-07-27",
      parserVersion: 2,
      images: [],
    });
    expect(record.text?.source).toBe("us:gettext-hidden");
    expect(record.text!.body.length).toBeGreaterThan(1000);
    expect(record.text!.body).toMatch(/Ústavní soud/);
    expect(record.text!.body).not.toMatch(/\\par\b/);
    expect(record.legalSentence === null || record.legalSentence.length > 0).toBe(true);
  });

  it("rebuilds a missing ECLI from sz and the registry sign", () => {
    const record = mapUs({ ...hit, ecli: undefined }, parseNalusDecision(html, hit.sz), null, usTextExtras(html));
    expect(record.ecli).toBe("ECLI:CZ:US:2026:1.US.1169.26.1");
    expect(record.legalSentence).toBeNull();
  });

  it("keeps the decision's picture at its place in the text (live 4-296-24_1)", () => {
    const dissent = fixture("nalus", "gettext-dissent-4-296-24_1.html");
    const record = mapUs(
      { ...hit, sz: "4-296-24_1", caseNumber: "IV.ÚS 296/24 #1", form: "nález", ecli: undefined },
      parseNalusDecision(dissent, "4-296-24_1"),
      null,
      usTextExtras(dissent),
    );
    expect(record.decisionType).toBe("nalez");
    expect(record.images).toHaveLength(1);
    expect(record.images![0]).toMatchObject({ mime: "image/png", width: 609, height: 1 });
    expect(record.text!.body.slice(record.images![0].charAt)).toMatch(/^\n\nOdlišné stanovisko/);
  });

  it("folds the form of a decision to one vocabulary", () => {
    expect(["nález", "Usnesení", "ROZSUDEK", "stanovisko pléna", "opatření", undefined].map((f) => decisionType(f))).toEqual([
      "nalez",
      "usneseni",
      "rozsudek",
      "stanovisko",
      "jine",
      null,
    ]);
  });

  it("names the court and the case number", () => {
    expect(usCourt("Pl-24-10_1")).toBe("Ústavní soud – plénum");
    expect(usCourt("4-12-20_2")).toBe("Ústavní soud – IV. senát");
    expect(usCaseNumber("Pl.ÚS 24/10 #1")).toBe("Pl. ÚS 24/10");
    expect(usCaseNumber("III.ÚS 1623/26 #2")).toBe("III. ÚS 1623/26");
  });
});

describe("quarters and sampling", () => {
  it("walks quarters and their date ranges", () => {
    expect(quarterRange("2024Q1")).toEqual({ from: "2024-01-01", to: "2024-03-31" });
    expect(quarterRange("2024Q4")).toEqual({ from: "2024-10-01", to: "2024-12-31" });
    expect(nextQuarter("2024Q4")).toBe("2025Q1");
    expect(() => quarterRange("2024-1")).toThrow();
  });

  it("samples evenly across a list", () => {
    expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([0, 2, 4, 6, 8]);
    expect(spread([1, 2], 5)).toEqual([1, 2]);
  });
});
