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

  it("reads the forms found in review round 1 (27. 10.)", () => {
    // abbreviations without their last dot or without dots, AT, NV
    expect(keys("§142 odst. 1 osř.")).toEqual(["zak:99/1963 par:142/o1"]);
    expect(keys("[§ 241a odst. 2 písm. a) o. s. ř]")).toEqual(["zak:99/1963 par:241a/o2/pa"]);
    expect(keys("§ 7 bod 5, § 11 odst. 1 a), d) AT")).toEqual(["zak:177/1996 par:7/b5", "zak:177/1996 par:11/o1/pa"]);
    expect(keys("§ 2 NV č. 351/2013 Sb.")).toEqual(["zak:351/2013 par:2"]);
    // what stands between: "bod 1.", the issuer, "zákona ČNR", parts of sentences
    expect(keys("§ 14b odst. 1 bod 1. vyhl. č. 177/1996 Sb.")).toEqual(["zak:177/1996 par:14b/o1/b1"]);
    expect(keys("§ 2a vyhlášky Ministerstva financí České republiky č. 205/1999 Sb.")).toEqual(["zak:205/1999 par:2a"]);
    expect(keys("§ 31 odst. 9 zákona ČNR č. 337/1992 Sb.")).toEqual(["zak:337/1992 par:31/o9"]);
    expect(keys("§ 243b odst. 2, část věty za středníkem, o. s. ř.")).toEqual(["zak:99/1963 par:243b/o2/vza"]);
    expect(keys("§ 79 odst. 1, věty první a druhé, o. s. ř.")).toEqual(["zak:99/1963 par:79/o1/v1"]);
    expect(keys("§ 257 odst. 1, poslední věta, celního zákona", 2005)).toEqual(["zak:13/1993 par:257/o1/vposl"]);
    // but never across an amendment
    expect(keys("§ 5 zákona, který byl změněn zákonem č. 100/2000 Sb.")).toEqual(["? par:5"]);
    // chains
    expect(keys("§ 51 odst. 1 písm. e), resp. § 56 odst. 4 zákona č. 235/2004 Sb.")[0]).toBe("zak:235/2004 par:51/o1/pe");
    expect(keys("§ 75 odst. 1 a contrario; § 30 odst. 1 zákona o Ústavním soudu")[0]).toBe("zak:182/1993 par:75/o1");
    expect(keys("čl. 2 odst. 2 a dále na čl. 2 odst. 3 a v čl. 4 odst. 1 Listiny")[0]).toBe("zak:2/1993 cl:2/o2");
    // parsing
    expect(keys("§ 43 odst. 1 písmeno e) zákona č. 182/1993 Sb.")).toEqual(["zak:182/1993 par:43/o1/pe"]);
    expect(extractProvisions("§ 14b odst. 1 písm. a), b, c) zákona č. 1/2000 Sb.")[0].keys).toContain("par:14b/o1/pc");
    expect(keys("§ 75 odst. 2 lit. a) zákona č. 182/1993 Sb.")).toEqual(["zak:182/1993 par:75/o2/pa"]);
    expect(keys("§ 73 odst. 2 až 4. Podle")).toEqual(["? par:73/o2"]);
    expect(keys("§ l42 odst. l o.s.ř.")).toEqual(["zak:99/1963 par:142/o1"]);
    expect(keys("§ 1811/2 a 1820/1 zákona č. 89/2012 Sb.")).toEqual(["zak:89/2012 par:1811/o2", "zak:89/2012 par:1820/o1"]);
    // a list of články is one reference each, not repeated for every "čl." inside it
    expect(keys("čl. 7 odst. 1, čl. 10 odst. 1 a čl. 13 Listiny")).toEqual(["zak:2/1993 cl:7/o1", "zak:2/1993 cl:10/o1", "zak:2/1993 cl:13"]);
  });

  it("gives a reference inside the paraphrase of a provision that provision's act", () => {
    const text = "Podle § 1824 o. z. sjednává-li se smlouva prostřednictvím prostředku komunikace na dálku, sdělí podnikatel spotřebiteli údaje uvedené v § 1811 odst. 2 a § 1820 odst. 1.";
    expect(keys(text)).toEqual(["zak:89/2012 par:1824", "zak:89/2012 par:1811/o2", "zak:89/2012 par:1820/o1"]);
    // not when the reference names its own (unknown) act, nor across a judgment
    expect(keys("Podle § 1824 o. z. platí, že dle § 4 zákona se postupuje …").at(-1)).toBe("? par:4");
    expect(keys("§ 6 o. s. ř.; rozsudek ESLP ve věci Lüdi, § 51").at(-1)).toBe("? par:51");
  });

  it("fixes what the precision review of round 1 found", () => {
    // a decision's own definition of a name holds; "daňový řád" before 2011 is 337/1992
    expect(keys("§ 55b zákona č. 337/1992 Sb., o správě daní a poplatků (dále jen „daňový řád“). Podle § 4 daňového řádu …", 2010).at(-1)).toBe("zak:337/1992 par:4");
    expect(keys("§ 50 odst. 3 daňového řádu", 2009)).toEqual(["zak:337/1992 par:50/o3"]);
    expect(keys("§ 50 odst. 3 daňového řádu", 2015)).toEqual(["zak:280/2009 par:50/o3"]);
    // "trestního zákona" in 2003 is the old code
    expect(keys("§ 248 odst. 1 trestního zákona", 2003)).toEqual(["zak:140/1961 par:248/o1"]);
    // a back reference skips the amendment
    expect(keys("§ 72 odst. 2 zákona č. 182/1993 Sb., o Ústavním soudu, ve znění zákona č. 77/1998 Sb.; § 75 odst. 2 téhož zákona").at(-1)).toBe("zak:182/1993 par:75/o2");
    // levels: the last odstavec of a list takes the písmeno; both parts of a sentence
    expect(extractProvisions("§ 265a odst. 1, 2 písm. h) tr. ř.")[0].keys).toEqual(["par:265a", "par:265a/o1", "par:265a/o2", "par:265a/o2/ph"]);
    expect(keys("§ 160 odst. 1 věta prvá před středníkem o. s. ř.")).toEqual(["zak:99/1963 par:160/o1/v1/vpred"]);
    expect(keys("§ 241 a odst. 3 o. s. ř.")).toEqual(["zak:99/1963 par:241a/o3"]);
    // "§" of an act with články only
    expect(keys("§ 89 odst. 2 Ústavy")).toEqual(["zak:1/1993 cl:89/o2"]);
    // not citations
    expect(keys("na čl. 23 spisu; Občanský zákoník I. § 1 až 654. Komentář")).toEqual([]);
    // a paraphrase stays in its sentence and never gives a § act to a článek of a contract
    expect(keys("Podle § 86 odst. 1 o. s. ř. je smlouva neplatná. Žalobkyni bylo podle § 1879 prokázáno postoupení.").at(-1)).toBe("? par:1879");
    expect(keys("podle § 536 obch. zák. ve smlouvě v jejím článku IX").at(-1)).toBe("? cl:ix");
    // the same name means the act the decision named; a § of an amending act is a § of the act it amends
    expect(keys("§ 36a zákona č. 367/1990 Sb., o obcích. … § 45 zákona o obcích", 2005, buildActLookup([
      { alias: "zákon o obcích", act_id: "zak:128/2000", year: 2000 },
      { alias: "zákon o obcích", act_id: "zak:367/1990", year: 1990 },
    ])).at(-1)).toBe("zak:367/1990 par:45");
    const amending = buildActLookup([], [], [{ id: "zak:297/2009", title: "Zákon, kterým se mění zákon č. 185/2001 Sb., o odpadech" }]);
    expect(keys("§ 37e zák. č. 297/2009 Sb.", 2015, amending)).toEqual(["zak:185/2001 par:37e"]);
    // round 2: two-digit years, case-law abbreviations
    expect(keys("§ 4 zákona č. 168/99 Sb.")).toEqual(["zak:168/1999 par:4"]);
    expect(keys("§ 31a odst. 3 písm. e) OdpŠk")).toEqual(["zak:82/1998 par:31a/o3/pe"]);
  });

  it("aggregates mentions per provision with every level of the key", () => {
    const rows = aggregateProvisions(extractProvisions("§ 2913 odst. 1 zákona č. 89/2012 Sb. a znovu § 2913 odst. 1 zákona č. 89/2012 Sb.", LOOKUP, 2020));
    const row = rows.find((r) => r.provision === "par:2913/o1");
    expect(row?.mentions).toBe(2);
    expect(rows.some((r) => r.provision === "par:2913")).toBe(true);
  });
});
