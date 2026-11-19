import { describe, expect, it } from "vitest";
import { gbTextToMb, mbToGbText } from "@/app/sprava/quota-field";

describe("quota in GB", () => {
  it("shows MB as GB with a decimal comma", () => {
    expect(mbToGbText(4096)).toBe("4");
    expect(mbToGbText(1024)).toBe("1");
    expect(mbToGbText(512)).toBe("0,5");
    expect(mbToGbText(1280)).toBe("1,25");
  });

  it("reads GB with a comma or a dot as whole MB; anything else is NaN", () => {
    expect(gbTextToMb("4")).toBe(4096);
    expect(gbTextToMb(" 0,5 ")).toBe(512);
    expect(gbTextToMb("1.25")).toBe(1280);
    for (const bad of ["", "abc", "-1", "1,2,3", "4 GB"]) expect(gbTextToMb(bad)).toBeNaN();
  });
});
