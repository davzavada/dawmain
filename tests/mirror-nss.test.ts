import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNssDetail } from "@/src/sources/nss";
import { mapNss, nssCaseNumbers, nssCourt } from "@/src/mirror/map/nss";
import { monthRange, nextMonth } from "@/src/mirror/crawl/nss";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("mapNss", () => {
  it("maps the detail page (live 784744) to the base record", () => {
    const metadata = parseNssDetail(fixture("nss-detail-784744.html"));
    const record = mapNss("784744", metadata, { body: "Rozsudek.", source: "nss:text" });
    expect(record).toMatchObject({
      source: "nss",
      sourceId: "784744",
      url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/784744",
      court: "Nejvyšší správní soud (tříčlenný senát NSS)",
      caseNumber: "1 As 59/2026",
      caseNumbers: ["1 As 59/2026", "1 As 59/2026-106"],
      decisionType: "rozsudek",
      decidedOn: "2026-08-20",
      publishedOn: "2026-08-20",
      ecli: "ECLI:CZ:NSS:2026:1.As.59.2026.106",
      legalSentence: null,
      images: [],
    });
  });

  it("keeps the č. j. and further marks after the sp. zn.", () => {
    expect(nssCaseNumbers("1 As 59/2026-106; Pej 1445/2026")).toEqual(["1 As 59/2026", "1 As 59/2026-106", "Pej 1445/2026"]);
    expect(nssCaseNumbers("1 As 59/2026- 106")).toEqual(["1 As 59/2026", "1 As 59/2026-106"]);
    expect(nssCaseNumbers("32 A 2/2026-41")).toEqual(["32 A 2/2026", "32 A 2/2026-41"]);
    expect(nssCaseNumbers(undefined)).toEqual([]);
  });

  it("names a krajský soud as itself and an NSS senate as NSS", () => {
    expect(nssCourt("Krajský soud v Brně")).toBe("Krajský soud v Brně");
    expect(nssCourt("rozšířený senát")).toBe("Nejvyšší správní soud (rozšířený senát)");
    expect(nssCourt(undefined)).toBeNull();
  });
});

describe("months", () => {
  it("walks months and their date ranges", () => {
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthRange("2023-12")).toEqual({ from: "2023-12-01", to: "2023-12-31" });
    expect(nextMonth("2023-12")).toBe("2024-01");
    expect(() => monthRange("2024-13")).toThrow();
  });
});
