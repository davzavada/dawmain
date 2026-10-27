import { describe, expect, it } from "vitest";
import { buildActLookup } from "@/src/mirror/legal/lookup";
import { aggregateProvisions, extractProvisions } from "@/src/mirror/legal/provisions";

const keys = (text: string, year: number | null = 2020, lookup = LOOKUP) =>
  extractProvisions(text, lookup, year).map((p) => `${p.act || "?"} ${p.provision}`);

const LOOKUP = buildActLookup([
  { alias: "zákon o obchodních korporacích", act_id: "zak:90/2012", year: 2012 },
  { alias: "zákon o daních z příjmů", act_id: "zak:586/1992", year: 1992 },
  { alias: "zákon o trestním řízení soudním", act_id: "zak:141/1961", year: 1961 },
  { alias: "zákon o trestním řízení soudním", act_id: "zak:64/1956", year: 1956 },
]);

describe("provision references in decision texts", () => {
  it("reads every level of a reference to a numbered act", () => {
    expect(keys("podle § 2913 odst. 1 písm. b) zákona č. 89/2012 Sb.")).toEqual(["zak:89/2012 par:2913/o1/pb"]);
  });

  it("binds an abbreviation the decision defines to the main act, not its amendment", () => {
    const text =
      "zákona č. 99/1963 Sb., občanský soudní řád, ve znění zákona č. 296/2017 Sb. (dále jen „o. s. ř.“). Podle § 243c odst. 3 věty první o. s. ř. …";
    expect(keys(text)).toContain("zak:99/1963 par:243c/o3/v1");
  });

  it("expands letter ranges of EU articles and names primary law", () => {
    const [gdpr] = extractProvisions("čl. 6 odst. 1 písm. a) až c) nařízení (EU) 2016/679", LOOKUP, 2020);
    expect(gdpr.act).toBe("eu:32016R0679");
    expect(gdpr.keys).toEqual(["cl:6", "cl:6/o1", "cl:6/o1/pa", "cl:6/o1/pb", "cl:6/o1/pc"]);
    expect(keys("čl. 36 odst. 1 Listiny")).toEqual(["zak:2/1993 cl:36/o1"]);
    expect(keys("čl. 267 SFEU")).toEqual(["eu:12016E/TXT cl:267"]);
  });

  it("expands § ranges and picks the civil code by the decision's year", () => {
    expect(keys("§§ 2910 až 2913 obč. zák.")).toHaveLength(4);
    expect(keys("§ 420 obč. zák.", 2010)).toEqual(["zak:40/1964 par:420"]);
  });

  it("finds acts by their names and the version in force by the year", () => {
    expect(keys("podle § 52 odst. 1 zákona o obchodních korporacích a § 24 zákona o daních z příjmů.")).toEqual([
      "zak:90/2012 par:52/o1",
      "zak:586/1992 par:24",
    ]);
    expect(keys("§ 2 zákona o trestním řízení soudním", 1958)).toEqual(["zak:64/1956 par:2"]);
    expect(keys("§ 2 zákona o trestním řízení soudním", 2000)).toEqual(["zak:141/1961 par:2"]);
  });

  it("aggregates mentions per provision with every level of the key", () => {
    const rows = aggregateProvisions(extractProvisions("§ 2913 odst. 1 zákona č. 89/2012 Sb. a znovu § 2913 odst. 1 zákona č. 89/2012 Sb.", LOOKUP, 2020));
    const row = rows.find((r) => r.provision === "par:2913/o1");
    expect(row?.mentions).toBe(2);
    expect(rows.some((r) => r.provision === "par:2913")).toBe(true);
  });
});
