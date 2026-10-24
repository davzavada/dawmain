import { describe, expect, it } from "vitest";
import { Pacer } from "@/src/mirror/http";
import { newUsPacer } from "@/src/mirror/crawl/us";

describe("Pacer", () => {
  it("spaces request starts by the interval, also for concurrent callers", async () => {
    const pacer = new Pacer(40);
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 5 }, async () => {
      await pacer.wait();
      starts.push(Date.now() - t0);
    }));
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(35);
    expect(starts.at(-1)!).toBeGreaterThanOrEqual(150);
  });

  it("refuses a rate outside (0, 10] requests per second", () => {
    expect(() => newUsPacer(0)).toThrow();
    expect(() => newUsPacer(20)).toThrow();
    expect(newUsPacer(4)).toBeInstanceOf(Pacer);
  });
});
