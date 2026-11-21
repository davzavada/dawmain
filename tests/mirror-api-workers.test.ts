import { describe, expect, it } from "vitest";
import { apiWorkerCount } from "@/src/mirror/api/workers";

describe("apiWorkerCount", () => {
  it("defaults to one process", () => {
    expect(apiWorkerCount(undefined, 4)).toBe(1);
    expect(apiWorkerCount("  ", 4)).toBe(1);
  });
  it("takes a whole number, capped at the cores", () => {
    expect(apiWorkerCount("3", 4)).toBe(3);
    expect(apiWorkerCount(" 3 ", 4)).toBe(3);
    expect(apiWorkerCount("8", 4)).toBe(4);
  });
  it("refuses anything else rather than guessing", () => {
    for (const bad of ["0", "-1", "2.5", "nine", "9"]) expect(() => apiWorkerCount(bad, 4)).toThrow(/MIRROR_API_WORKERS/);
  });
});
