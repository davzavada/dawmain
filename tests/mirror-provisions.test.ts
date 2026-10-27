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
  { alias: "zákon o azylu", act_id: "zak:325/1999", year: 1999 },
  { alias: "zákon o mezinárodní justiční spolupráci ve věcech trestních", act_id: "zak:104/2013", year: 2013 },
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

  it("binds a definition to the act right before it; a known abbreviation only to its own act", () => {
    const oz =
      "podle § 3 zákona č. 168/1999 Sb., o pojištění, a podle § 2758 odst. 1 zákona č. 89/2012 Sb., občanského zákoníku, (dále jen „o. z.“). Dle § 2783 o. z. …";
    expect(keys(oz).at(-1)).toBe("zak:89/2012 par:2783");
    const slip = "podle § 1 zákona č. 89/2012 Sb. (dále jen „o. s. ř.“). Podle § 151 odst. 3 o. s. ř. …";
    expect(keys(slip).at(-1)).toBe("zak:99/1963 par:151/o3");
  });

  it("looks back for an act of the kind the reference names", () => {
    expect(keys("§ 7 vyhlášky č. 177/1996 Sb. a § 142 o. s. ř.; podle § 2 odst. 3 uvedené vyhlášky …").at(-1)).toBe("zak:177/1996 par:2/o3");
    expect(keys("§ 142 o. s. ř. a § 7 vyhlášky č. 177/1996 Sb.; podle § 151 téhož zákona …").at(-1)).toBe("zak:99/1963 par:151");
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

  it("takes one-word names, and shortened names only when three words or more say which act", () => {
    expect(keys("§ 27 odst. 2 zákona o azylu")).toEqual(["zak:325/1999 par:27/o2"]);
    expect(keys("§ 205 zákona o mezinárodní justiční spolupráci")).toEqual(["zak:104/2013 par:205"]);
    expect(keys("§ 205 zákona o mezinárodní spolupráci")).toEqual(["? par:205"]);
  });

  it("gives references joined to the next one its act", () => {
    expect(keys("§ 107 a § 361 tr. zákoníku")).toEqual(["zak:40/2009 par:107", "zak:40/2009 par:361"]);
    expect(keys("§ 8 odst. 1 ve spojení s § 7 vyhlášky č. 177/1996 Sb.")).toEqual(["zak:177/1996 par:8/o1", "zak:177/1996 par:7"]);
    expect(keys("§ 236 a násl. o. s. ř.")).toEqual(["zak:99/1963 par:236"]);
    expect(keys("§ 13 advokátního tarifu a čl. 3 Úmluvy o právech dítěte")).toEqual(["zak:177/1996 par:13", "zak:104/1991 cl:3"]);
  });

  it("reads odstavce in a row, each with its own písmena", () => {
    const [p] = extractProvisions("§ 283 odst. 1, odst. 2 písm. a), odst. 3 písm. b), c) zákona č. 40/2009 Sb.", LOOKUP, 2020);
    expect(p.keys).toEqual(["par:283", "par:283/o1", "par:283/o2", "par:283/o2/pa", "par:283/o3", "par:283/o3/pb", "par:283/o3/pc"]);
  });

  it("aggregates mentions per provision with every level of the key", () => {
    const rows = aggregateProvisions(extractProvisions("§ 2913 odst. 1 zákona č. 89/2012 Sb. a znovu § 2913 odst. 1 zákona č. 89/2012 Sb.", LOOKUP, 2020));
    const row = rows.find((r) => r.provision === "par:2913/o1");
    expect(row?.mentions).toBe(2);
    expect(rows.some((r) => r.provision === "par:2913")).toBe(true);
  });
});
