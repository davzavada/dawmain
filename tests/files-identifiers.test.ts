import { describe, expect, it } from "vitest";
import { ACT_ABBREVIATIONS, actName, resolveAct } from "@/src/files/index/acts";
import {
  canonicalCaseNumber,
  extractIdentKeys,
  findIdentSpans,
  fullYear,
  isbn10to13,
  MAX_IDENT_KEYS,
  normalizeIsbn,
  queryIdentKeys,
  stripIdentifiers,
} from "@/src/files/index/identifiers";

const NBSP = " ";

describe("acts", () => {
  it.each([
    ["§ 2913 o. z.", "zak:89/2012"],
    ["podle o.z.", "zak:89/2012"],
    ["OZ", "zak:89/2012"],
    ["NOZ", "zak:89/2012"],
    ["ObčZ", "zak:89/2012"],
    ["občanského zákoníku", "zak:89/2012"],
    ["OBČANSKÝ ZÁKONÍK", "zak:89/2012"],
    ["§ 157 o. s. ř.", "zak:99/1963"],
    ["OSŘ", "zak:99/1963"],
    ["občanského soudního řádu", "zak:99/1963"],
    ["ZOK", "zak:90/2012"],
    ["z. o. k.", "zak:90/2012"],
    ["zákona o obchodních korporacích", "zak:90/2012"],
    ["ZP", "zak:262/2006"],
    ["zák. práce", "zak:262/2006"],
    ["zákoníku práce", "zak:262/2006"],
    ["s. ř. s.", "zak:150/2002"],
    ["SŘS", "zak:150/2002"],
    ["soudního řádu správního", "zak:150/2002"],
    ["tr. zák.", "zak:40/2009"],
    ["TZ", "zak:40/2009"],
    ["TrZ", "zak:40/2009"],
    ["trestního zákoníku", "zak:40/2009"],
    ["tr. ř.", "zak:141/1961"],
    ["TŘ", "zak:141/1961"],
    ["trestního řádu", "zak:141/1961"],
    ["InsZ", "zak:182/2006"],
    ["IZ", "zak:182/2006"],
    ["insolvenčního zákona", "zak:182/2006"],
    ["správní řád", "zak:500/2004"],
    ["SŘ", "zak:500/2004"],
    ["ZOSŘ", "zak:292/2013"],
    ["z. ř. s.", "zak:292/2013"],
    ["Ústava", "zak:1/1993"],
    ["čl. 2 Ústavy", "zak:1/1993"],
    ["Listiny základních práv a svobod", "zak:2/1993"],
    ["čl. 36 Listiny", "zak:2/1993"],
    ["LZPS", "zak:2/1993"],
    ["zákon o advokacii", "zak:85/1996"],
    ["autorského zákona", "zak:121/2000"],
    ["AZ", "zak:121/2000"],
    ["čl. 6 GDPR", "eu:32016R0679"],
    ["nařízení Řím I", "eu:32008R0593"],
    ["nařízení Řím II", "eu:32007R0864"],
    ["Brusel I bis", "eu:32012R1215"],
    ["zákona č. 89/2012 Sb., občanský zákoník", "zak:89/2012"],
    ["89/2012 Sb.", "zak:89/2012"],
    ["zák. č. 262/2006 Sb.", "zak:262/2006"],
    ["zákona č. 0089/2012", "zak:89/2012"],
    ["vyhláška 123/2020 Sb", "zak:123/2020"],
  ])("resolveAct(%s) → %s", (text, act) => {
    expect(resolveAct(text)?.act).toBe(act);
  });

  it.each([
    "ODPOVĚDNOST ZA ŠKODU", // "ZA" is not the advokacie act
    "az a oz", // abbreviations are case-sensitive
    "ústav a ústavní soud",
    "Ústavní soud",
    "Listina základních práv Evropské unie",
    "1234/2007 Sb. NSS",
    "č. 12/2001 Sb. m. s.",
    "SbNU 45/2019",
    "DOZ",
  ])("resolveAct(%s) → null", (text) => {
    expect(resolveAct(text)).toBeNull();
  });

  it("takes the earliest act; the longest on a tie", () => {
    expect(resolveAct("podle OSŘ a o. z.")?.act).toBe("zak:99/1963");
    expect(resolveAct("zákona č. 89/2012 Sb. a ZOK")?.act).toBe("zak:89/2012");
    expect(resolveAct("Listina základních práv a svobod")).toEqual({ act: "zak:2/1993", name: "Listina základních práv a svobod" });
  });

  it("names unknown Sbírka numbers generically", () => {
    expect(resolveAct("zákon č. 7/2099 Sb.")).toEqual({ act: "zak:7/2099", name: "zákon č. 7/2099 Sb." });
  });

  it("actName", () => {
    expect(actName("zak:89/2012")).toBe("občanský zákoník");
    expect(actName("89/2012")).toBe("občanský zákoník");
    expect(actName("zak:089/2012")).toBe("občanský zákoník");
    expect(actName("eu:32016R0679")).toMatch(/GDPR/);
    expect(actName("zak:1/2099")).toBeNull();
    expect(actName("")).toBeNull();
  });

  it("every act id fits the documents.commented_act CHECK", () => {
    for (const entry of ACT_ABBREVIATIONS) expect(entry.act).toMatch(/^(zak:[0-9]{1,4}\/[0-9]{4}|eu:[0-9]{5}[A-Z][0-9]{4})$/);
  });
});

describe("extractIdentKeys — case numbers", () => {
  it.each([
    ["25 Cdo 1234/2019", "sz:25cdo1234-2019"],
    ["sp. zn. 25 Cdo 1234/19", "sz:25cdo1234-2019"],
    [`25${NBSP}Cdo${NBSP}1234/2019`, "sz:25cdo1234-2019"],
    ["25 Cdo 1234 / 2019", "sz:25cdo1234-2019"],
    ["25Cdo1234/2019", "sz:25cdo1234-2019"],
    ["21 Cdo 05/99", "sz:21cdo5-1999"],
    ["II. ÚS 1234/20", "sz:2us1234-2020"],
    ["II.ÚS 1234/20", "sz:2us1234-2020"],
    ["IV. ÚS 12/05", "sz:4us12-2005"],
    ["IV. US 12/05", "sz:4us12-2005"],
    ["Pl. ÚS 5/20", "sz:plus5-2020"],
    ["Pl. ÚS-st. 1/05", "sz:plusst1-2005"],
    ["I. ÚS 3/1999", "sz:1us3-1999"],
    ["4 As 12/2019-45", "sz:4as12-2019"],
    ["4 As 12/2019 - 45", "sz:4as12-2019"],
    ["Cpjn 1/2020", "sz:cpjn1-2020"],
    ["31 Cdo 4231/2017", "sz:31cdo4231-2017"],
    ["29 NSČR 12/2019", "sz:29nscr12-2019"],
    ["29 ICdo 45/2020", "sz:29icdo45-2020"],
    ["12 C 123/2019", "sz:12c123-2019"],
    ["3 Tdo 1070/2014", "sz:3tdo1070-2014"],
    ["Konf 12/2019", "sz:konf12-2019"],
    ["C-123/20", "sz:c-123-2020"],
    ["T‑12/19 P", "sz:t-12-2019"],
    ["C – 26/89", "sz:c-26-1989"],
  ])("%s → %s", (text, key) => {
    expect(extractIdentKeys(text)).toContain(key);
  });

  it.each(["Cdo 1234/2019", "§ 12/2019", "č. 89/2012", "12 Sb 12/2020", "strana 12/2019", "25 Cdo 1234/1800"])("no sz: key in %s", (text) => {
    expect(extractIdentKeys(text).filter((k) => k.startsWith("sz:"))).toEqual([]);
  });

  it("R, Sb. NSS, SbNU", () => {
    expect(extractIdentKeys("publikováno pod R 51/2011")).toContain("r:51/2011");
    expect(extractIdentKeys("Rc 51/11")).toContain("r:51/2011");
    expect(extractIdentKeys("č. 1234/2007 Sb. NSS")).toEqual(["sbnss:1234/2007"]);
    expect(extractIdentKeys("1234/2007 Sb. NSS")).toEqual(["sbnss:1234/2007"]);
    expect(extractIdentKeys("Sb. NSS č. 1234/2007")).toEqual(["sbnss:1234/2007"]);
    expect(extractIdentKeys("N 45/37 SbNU 123")).toEqual(["sbnu:n45/37"]);
  });

  it("ECLI, lowercased, trailing dot dropped", () => {
    expect(extractIdentKeys("ECLI:CZ:NS:2020:21.CDO.1234.2020.1.")).toEqual(["ecli:cz:ns:2020:21.cdo.1234.2020.1"]);
    expect(extractIdentKeys("(ecli:EU:C:2019:123)")).toEqual(["ecli:eu:c:2019:123"]);
  });
});

describe("extractIdentKeys — §, acts, ISBN, DOI", () => {
  it("§ with letter and odstavec", () => {
    expect(extractIdentKeys("§ 2913")).toEqual(["par:2913"]);
    expect(extractIdentKeys("§ 2913a")).toEqual(["par:2913a"]);
    expect(extractIdentKeys("§2913 odst. 2")).toEqual(["par:2913", "par:2913/2"]);
    expect(extractIdentKeys(`§${NBSP}2913 odst.${NBSP}2 písm. b)`)).toEqual(["par:2913", "par:2913/2"]);
    expect(extractIdentKeys("§ 2913 odst. 1 a 2")).toEqual(["par:2913", "par:2913/1", "par:2913/2"]);
  });
  it("lists and ranges of §§ (endpoints only)", () => {
    expect(extractIdentKeys("§§ 2910 a 2913")).toEqual(["par:2910", "par:2913"]);
    expect(extractIdentKeys("§ 2910, 2913 nebo 2915")).toEqual(["par:2910", "par:2913", "par:2915"]);
    expect(extractIdentKeys("§§ 2894–2971")).toEqual(["par:2894", "par:2971"]);
    expect(extractIdentKeys("§ 12 a násl.")).toEqual(["par:12"]);
    expect(extractIdentKeys("§ 12 a § 13")).toEqual(["par:12", "par:13"]);
  });
  it("parz when an act follows within 40 chars", () => {
    expect(extractIdentKeys("§ 2913 o. z.")).toEqual(["par:2913", "parz:89/2012/2913"]);
    expect(extractIdentKeys("§ 2913 odst. 2 zákona č. 89/2012 Sb.")).toEqual([
      "par:2913",
      "par:2913/2",
      "parz:89/2012/2913",
      "zak:89/2012",
    ]);
    expect(extractIdentKeys("§§ 2910 a 2913 OZ")).toEqual(["par:2910", "parz:89/2012/2910", "par:2913", "parz:89/2012/2913"]);
    // Too far, or another § in between: no compound key.
    expect(extractIdentKeys("§ 2913 a to i v případech, které jsou upraveny jinde, OZ")).toEqual(["par:2913"]);
    expect(extractIdentKeys("§ 5 a § 2913 OZ")).toEqual(["par:5", "par:2913", "parz:89/2012/2913"]);
    // EU acts have no §.
    expect(extractIdentKeys("§ 5 GDPR")).toEqual(["par:5"]);
  });
  it("parz from the commented act of a commentary, explicit act wins", () => {
    expect(extractIdentKeys("viz § 2910", { commentedAct: "zak:89/2012" })).toEqual(["par:2910", "parz:89/2012/2910"]);
    expect(extractIdentKeys("viz § 157 o. s. ř.", { commentedAct: "zak:89/2012" })).toEqual(["par:157", "parz:99/1963/157"]);
    expect(extractIdentKeys("viz § 2910", { commentedAct: "eu:32016R0679" })).toEqual(["par:2910"]);
    expect(extractIdentKeys("viz § 2910", { commentedAct: null })).toEqual(["par:2910"]);
  });
  it("zak: from Sbírka numbers", () => {
    expect(extractIdentKeys("zákon č. 89/2012 Sb., občanský zákoník")).toEqual(["zak:89/2012"]);
    expect(extractIdentKeys("ve znění zákona č. 303/2013 Sb. a 460/2016 Sb")).toEqual(["zak:303/2013", "zak:460/2016"]);
    expect(extractIdentKeys("č. 12/2001 Sb. m. s.")).toEqual([]);
  });
  it("ISBN-13 and ISBN-10 with checksum", () => {
    expect(extractIdentKeys("ISBN 978-80-7400-587-9")).toEqual(["isbn:9788074005879"]);
    expect(extractIdentKeys("ISBN: 978 80 7400 587 9 (váz.)")).toEqual(["isbn:9788074005879"]);
    expect(extractIdentKeys("ISBN 80-7179-890-8")).toEqual(["isbn:9788071798903"]);
    expect(extractIdentKeys("ISBN 0-8044-2957-X")).toEqual(["isbn:9780804429573"]);
    expect(extractIdentKeys("bez štítku 9788074005879.")).toEqual(["isbn:9788074005879"]);
    expect(extractIdentKeys("ISBN 978-80-7400-587-1")).toEqual([]); // bad checksum
    expect(extractIdentKeys("tel. 9788074005871")).toEqual([]);
  });
  it("DOI, lowercased, trailing punctuation dropped", () => {
    expect(extractIdentKeys("doi:10.1000/XYZ123.")).toEqual(["doi:10.1000/xyz123"]);
    expect(extractIdentKeys("(https://doi.org/10.5817/MUJLT2020-1-2)")).toEqual(["doi:10.5817/mujlt2020-1-2"]);
    expect(extractIdentKeys("10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0")).toEqual([
      "doi:10.1002/(sici)1097-4571(199806)49:8",
    ]);
  });
  it("dedupes, keeps first-seen order, caps at 200", () => {
    expect(extractIdentKeys("§ 5, § 5 a § 5")).toEqual(["par:5"]);
    const many = Array.from({ length: 300 }, (_, i) => `§ ${i + 1}`).join("; ");
    const keys = extractIdentKeys(many);
    expect(keys).toHaveLength(MAX_IDENT_KEYS);
    expect(keys[0]).toBe("par:1");
  });
  it("survives adversarial input", () => {
    expect(extractIdentKeys("")).toEqual([]);
    expect(extractIdentKeys("§".repeat(10_000))).toEqual([]);
    const start = Date.now();
    extractIdentKeys("1/".repeat(20_000) + "ISBN " + "9-".repeat(5_000) + "10.1234/" + "a".repeat(50_000));
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("findIdentSpans", () => {
  it("returns spans that cover the identifier text", () => {
    const text = "Viz 25 Cdo 1234/19 a § 2913 odst. 2 o. z.";
    const spans = findIdentSpans(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["25 Cdo 1234/19", "§ 2913 odst. 2"]);
    expect(spans[1].keys).toEqual(["par:2913", "par:2913/2", "parz:89/2012/2913"]);
  });
});

describe("queryIdentKeys", () => {
  it("§ with an act abbreviation", () => {
    expect(queryIdentKeys("§ 2913 OZ")).toEqual({ keys: ["par:2913", "parz:89/2012/2913"], act: "zak:89/2012", sections: ["par:2913"] });
  });
  it("act anywhere in the query applies to its §§", () => {
    expect(queryIdentKeys("OZ § 2913 odst. 2")).toEqual({
      keys: ["par:2913", "parz:89/2012/2913", "par:2913/2"],
      act: "zak:89/2012",
      sections: ["par:2913"],
    });
  });
  it("§ without an act; articles as sections", () => {
    expect(queryIdentKeys("náhrada škody § 2913")).toEqual({ keys: ["par:2913"], act: null, sections: ["par:2913"] });
    expect(queryIdentKeys("čl. 6 GDPR")).toEqual({ keys: [], act: "eu:32016R0679", sections: ["cl:6"] });
    expect(queryIdentKeys("článku III smlouvy").sections).toEqual(["cl:III"]);
  });
  it("case numbers, same normalization as the index", () => {
    expect(queryIdentKeys("odpovědnost 25 Cdo 1234/19")).toEqual({ keys: ["sz:25cdo1234-2019"], act: null, sections: [] });
  });
  it("nothing in plain words", () => {
    expect(queryIdentKeys("náhrada škody")).toEqual({ keys: [], act: null, sections: [] });
  });
});

describe("stripIdentifiers", () => {
  it("removes identifiers and act abbreviations, keeps words and act names", () => {
    expect(stripIdentifiers("odpovědnost 25 Cdo 1234/2019")).toBe("odpovědnost");
    expect(stripIdentifiers("náhrada škody § 2913 odst. 2 OZ")).toBe("náhrada škody");
    expect(stripIdentifiers("výpověď zákoník práce")).toBe("výpověď zákoník práce");
    expect(stripIdentifiers("§ 2913 o. z.")).toBe("");
  });
});

describe("canonicalCaseNumber", () => {
  it.each([
    ["25 Cdo 1234/19", "25 Cdo 1234/2019", "NS"],
    ["sz:25cdo1234-2019", "25 Cdo 1234/2019", "NS"],
    ["31 Cdo 4231/2017", "31 Cdo 4231/2017", "NS"],
    ["3 Tdo 1070/2014", "3 Tdo 1070/2014", "NS"],
    ["Cpjn 1/2020", "Cpjn 1/2020", "NS"],
    ["29 NSČR 12/2019", "29 NSČR 12/2019", "NS"],
    ["sz:29nscr12-2019", "29 NSČR 12/2019", "NS"],
    ["29 ICdo 45/2020", "29 ICdo 45/2020", "NS"],
    ["4 As 12/2019-45", "4 As 12/2019", "NSS"],
    ["8 Afs 64/2011", "8 Afs 64/2011", "NSS"],
    ["Konf 12/2019", "Konf 12/2019", "NSS"],
    ["II. ÚS 1234/20", "II. ÚS 1234/20", "US"],
    ["sz:2us1234-2020", "II. ÚS 1234/20", "US"],
    ["Pl. ÚS 5/20", "Pl. ÚS 5/20", "US"],
    ["sz:plusst1-2005", "Pl. ÚS-st. 1/05", "US"],
    ["C-123/20", "C-123/20", "SDEU"],
    ["sz:t-12-2019", "T-12/19", "SDEU"],
    ["12 Co 123/2019", "12 Co 123/2019", null],
  ])("%s → %s (%s)", (raw, display, court) => {
    expect(canonicalCaseNumber(raw)).toEqual({ display, court });
  });

  it("takes the earliest case number in free text", () => {
    expect(canonicalCaseNumber("viz 25 Cdo 1/2019 a II. ÚS 5/20")?.display).toBe("25 Cdo 1/2019");
  });

  it("null without a case number", () => {
    expect(canonicalCaseNumber("")).toBeNull();
    expect(canonicalCaseNumber("§ 2913")).toBeNull();
    expect(canonicalCaseNumber("sz:")).toBeNull();
  });
});

describe("helpers", () => {
  it("fullYear", () => {
    expect(fullYear("19")).toBe("2019");
    expect(fullYear("40")).toBe("2040");
    expect(fullYear("41")).toBe("1941");
    expect(fullYear("99")).toBe("1999");
    expect(fullYear("2005")).toBe("2005");
  });
  it("ISBN normalization", () => {
    expect(isbn10to13("8071798908")).toBe("9788071798903");
    expect(normalizeIsbn("80-7179-890-8")).toBe("9788071798903");
    expect(normalizeIsbn("978-80-7400-587-9")).toBe("9788074005879");
    expect(normalizeIsbn("1234567890")).toBeNull();
    expect(normalizeIsbn("")).toBeNull();
  });
});
