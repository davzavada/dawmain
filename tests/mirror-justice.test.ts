import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJusticeDecision } from "@/src/sources/justice";
import { justiceCaseNumbers, justiceType, justiceUuid, mapJustice, type JusticeListItem } from "@/src/mirror/map/justice";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "mirror", name), "utf8"));

describe("mapJustice (live 2025-03-12, d2965a2d)", () => {
  const day = fixture("justice-day-2025-03-12.json") as { items: JusticeListItem[] };
  const item = day.items[0];
  const uuid = justiceUuid(item)!;

  it("takes the UUID from the listing's finaldoc link", () => {
    expect(uuid).toBe("d2965a2d-ec0d-476b-983f-75e716972829");
    expect(justiceUuid({ odkaz: "https://example.test/x" })).toBeNull();
  });

  it("maps listing and finaldoc to the base record", () => {
    const record = mapJustice(uuid, item, parseJusticeDecision(fixture("justice-finaldoc-d2965a2d.json"), uuid));
    expect(record).toMatchObject({
      source: "justice",
      sourceId: uuid,
      url: `https://rozhodnuti.justice.cz/rozhodnuti/?id=${uuid}`,
      court: "Okresní soud v Prostějově",
      caseNumber: "9 C 311/2024",
      caseNumbers: ["9 C 311/2024", "9 C 311/2024-50"],
      decisionType: "rozsudek",
      decidedOn: "2025-02-07",
      publishedOn: "2025-03-12",
      ecli: "ECLI:CZ:OSPV:2025:9.C.311.2024.1",
      legalSentence: null,
      sourceFlags: [],
      images: [],
    });
    expect(record.text?.source).toBe("justice:finaldoc");
    expect(record.text!.body.length).toBeGreaterThan(2000);
    expect(record.text!.body).toMatch(/Okresní soud v Prostějově/);
  });

  it("keeps the source's special types as flags (live 22 Co 33/2022: ESLP)", () => {
    const json = fixture("justice-finaldoc-d2965a2d.json");
    const flagged = { ...json, metadata: { ...json.metadata, specialType: ["ESLP"] } };
    expect(mapJustice(uuid, item, parseJusticeDecision(flagged, uuid)).sourceFlags).toEqual(["ESLP"]);
  });

  it("names the types and splits the č. j.", () => {
    expect(["JUDGEMENT", "RESOLUTION", "ORDER_T", undefined].map(justiceType)).toEqual(["rozsudek", "usneseni", "jine", null]);
    expect(justiceCaseNumbers("14 C 263/2020-19", undefined)).toEqual(["14 C 263/2020", "14 C 263/2020-19"]);
    expect(justiceCaseNumbers(undefined, { senate: 8, registry: "Co", index: 60, year: 2025, pageNumber: 174 })).toEqual(["8 Co 60/2025", "8 Co 60/2025-174"]);
    expect(justiceCaseNumbers(undefined, undefined)).toEqual([]);
  });
});
