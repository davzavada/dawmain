import { describe, expect, it } from "vitest";
import { czEcliToCaseNumber, routeCaseIdentifier } from "@/src/mcp/tools/cz-caselaw-get";

/**
 * The court router behind cz_caselaw_get: an identifier the user cites must
 * land at the right database WITHOUT a model round trip to guess the court.
 * Misrouting is worse than not routing (null falls back to a NS+NSS fan-out),
 * so the negative cases matter as much as the positive ones.
 */
describe("routeCaseIdentifier", () => {
  it("routes NS rejstříkové značky to the Nejvyšší soud", () => {
    expect(routeCaseIdentifier("23 Cdo 116/2017")).toEqual({ court: "ns", caseNumber: "23 Cdo 116/2017" });
    expect(routeCaseIdentifier("8 Tdo 123/2020")).toEqual({ court: "ns", caseNumber: "8 Tdo 123/2020" });
    expect(routeCaseIdentifier("Cpjn 202/2015")).toEqual({ court: "ns", caseNumber: "Cpjn 202/2015" });
    // Insolvenční značka carries a diacritic — folded before the lookup.
    expect(routeCaseIdentifier("29 NSČR 30/2019")).toEqual({ court: "ns", caseNumber: "29 NSČR 30/2019" });
  });

  it("routes NSS značky to the Nejvyšší správní soud, čj page suffix included", () => {
    expect(routeCaseIdentifier("1 Afs 25/2024")).toEqual({ court: "nss", caseNumber: "1 Afs 25/2024" });
    expect(routeCaseIdentifier("1 Afs 25/2024-30")).toEqual({ court: "nss", caseNumber: "1 Afs 25/2024-30" });
    expect(routeCaseIdentifier("8 As 12/2020")).toEqual({ court: "nss", caseNumber: "8 As 12/2020" });
    expect(routeCaseIdentifier("2 Azs 8/2021")).toEqual({ court: "nss", caseNumber: "2 Azs 8/2021" });
  });

  it("routes Ústavní soud citace in every common spelling", () => {
    expect(routeCaseIdentifier("I. ÚS 1169/26")?.court).toBe("nalus");
    expect(routeCaseIdentifier("IV.ÚS 23/05")?.court).toBe("nalus");
    expect(routeCaseIdentifier("Pl. ÚS 24/10")?.court).toBe("nalus");
    expect(routeCaseIdentifier("Pl. US 24/10")?.court).toBe("nalus"); // no diacritics
    expect(routeCaseIdentifier("Pl. ÚS-st. 27/09")?.court).toBe("nalus");
  });

  it("does NOT mistake the NSS 'As' registry for ÚS", () => {
    expect(routeCaseIdentifier("1 As 25/2020")?.court).toBe("nss");
    expect(routeCaseIdentifier("3 Azs 240/2014")?.court).toBe("nss");
  });

  it("routes CJEU case numbers and ECLIs to curia", () => {
    expect(routeCaseIdentifier("C-311/18")).toEqual({ court: "curia", caseNumber: "C-311/18" });
    expect(routeCaseIdentifier("T-655/17")).toEqual({ court: "curia", caseNumber: "T-655/17" });
    expect(routeCaseIdentifier("c-131/12")).toEqual({ court: "curia", caseNumber: "C-131/12" });
    expect(routeCaseIdentifier("ECLI:EU:C:2020:559")).toEqual({ court: "curia", ecli: "ECLI:EU:C:2020:559" });
  });

  it("derives the NALUS sz from an Ústavní soud ECLI", () => {
    expect(routeCaseIdentifier("ECLI:CZ:US:2026:1.US.1169.26.1")).toEqual({ court: "nalus", sz: "1-1169-26_1" });
  });

  it("derives the spisová značka from NS and NSS ECLIs (NSS checked before its NS prefix)", () => {
    expect(routeCaseIdentifier("ECLI:CZ:NS:2017:23.CDO.116.2017.1")).toEqual({
      court: "ns",
      caseNumber: "23 Cdo 116/2017",
    });
    expect(routeCaseIdentifier("ECLI:CZ:NSS:2020:1.AFS.25.2020.45")).toEqual({
      court: "nss",
      caseNumber: "1 Afs 25/2020",
    });
  });

  it("returns null for what it cannot classify — the tool then fans out", () => {
    expect(routeCaseIdentifier("Rv I 123/28")).toBeNull(); // prvorepublikový rejstřík
    expect(routeCaseIdentifier("nájemné z bytu")).toBeNull(); // a topic, not a značka
    expect(routeCaseIdentifier("ECLI:SK:NSSR:2020:1.2.3")).toBeNull(); // foreign ECLI
    expect(routeCaseIdentifier("")).toBeNull();
  });
});

describe("czEcliToCaseNumber", () => {
  it("handles senate, senate-less and NSS forms", () => {
    expect(czEcliToCaseNumber("ECLI:CZ:NS:2017:23.CDO.116.2017.1")).toBe("23 Cdo 116/2017");
    expect(czEcliToCaseNumber("ECLI:CZ:NS:2015:CPJN.202.2015.1")).toBe("Cpjn 202/2015");
    // The NSS trailing segment is the čj page number, not part of the značka.
    expect(czEcliToCaseNumber("ECLI:CZ:NSS:2020:1.AFS.25.2020.45")).toBe("1 Afs 25/2020");
  });

  it("rejects malformed ECLIs instead of guessing", () => {
    expect(czEcliToCaseNumber("ECLI:CZ:NS:2017:23.CDO")).toBeNull();
    expect(czEcliToCaseNumber("ECLI:EU:C:2020:559")).toBeNull();
  });
});
