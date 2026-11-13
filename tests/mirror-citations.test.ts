import { describe, expect, it } from "vitest";
import { citationsOf, isDecisionKey, ownKeys } from "@/src/mirror/citations";

describe("citations from the chunks' identifier keys", () => {
  const own = ownKeys({ caseNumbers: ["21 Cdo 1124/2022"], ecli: "ECLI:CZ:NS:2023:21.CDO.1124.2022.1" });

  it("knows the decision's own sp. zn. and ECLI", () => {
    expect(own).toEqual(expect.arrayContaining(["sz:21cdo1124-2022", "ecli:cz:ns:2023:21.cdo.1124.2022.1"]));
    expect(own.every(isDecisionKey)).toBe(true);
  });

  it("counts the cited keys, without the own ones and the provisions", () => {
    const chunks = [
      { start: 0, identKeys: [...own, "sz:25cdo2202-2018"] },
      { start: 1500, identKeys: ["sz:25cdo2202-2018", "sz:4us296-2024", "zak:89/2012#2959"] },
      { start: 3000, identKeys: ["sz:4us296-2024", "sz:4us296-2024"] },
    ];
    expect(citationsOf(chunks, own)).toEqual([
      { key: "sz:25cdo2202-2018", mentions: 2, firstAt: 0 },
      { key: "sz:4us296-2024", mentions: 2, firstAt: 1500 },
    ]);
  });
});
