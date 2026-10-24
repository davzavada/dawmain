import { describe, expect, it } from "vitest";
import { CHUNK_MAX, CHUNK_MIN, chunkText, deriveChunks } from "@/src/mirror/index";

const sentence = (i: number) => `Věta číslo ${i} o ústavní stížnosti a právu na spravedlivý proces. `;

function paragraphs(count: number, sentencesEach: number): string {
  let n = 0;
  return Array.from({ length: count }, () => Array.from({ length: sentencesEach }, () => sentence(n++)).join("").trim()).join("\n");
}

describe("chunkText", () => {
  it("keeps a short text whole", () => {
    expect(chunkText("  Krátký text.\n")).toEqual([{ start: 2, end: 14 }]);
    expect(chunkText("")).toEqual([]);
  });

  it("covers the text in order, within the size bounds, cutting at paragraph ends", () => {
    const text = paragraphs(40, 4);
    const spans = chunkText(text);
    expect(spans.length).toBeGreaterThan(5);
    let last = 0;
    for (const [i, s] of spans.entries()) {
      expect(s.start).toBeGreaterThanOrEqual(last);
      expect(text.slice(last, s.start).trim()).toBe(""); // nothing but whitespace is skipped
      expect(s.end - s.start).toBeLessThanOrEqual(CHUNK_MAX);
      if (i < spans.length - 1) {
        expect(s.end - s.start).toBeGreaterThanOrEqual(CHUNK_MIN);
        expect(text[s.end]).toBe("\n");
      }
      last = s.end;
    }
    expect(text.slice(last).trim()).toBe("");
  });

  it("splits one long paragraph at sentence ends, and text without spaces hard", () => {
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join("").trim();
    for (const s of chunkText(long).slice(0, -1)) expect(long.slice(s.start, s.end)).toMatch(/\.$/);
    const solid = "x".repeat(6000);
    expect(chunkText(solid).map((s) => s.end - s.start)).toEqual([CHUNK_MAX, CHUNK_MAX, 1200]);
  });
});

describe("deriveChunks", () => {
  const record = {
    caseNumbers: ["I. ÚS 1169/26"],
    legalSentence: "Právo na přístup k soudu.",
    ecli: "ECLI:CZ:US:2026:1.US.1169.26.1",
    text: { body: `${paragraphs(10, 4)}\nOdkazuje na nález sp. zn. Pl. ÚS 24/10 a § 2913 o. z.`, source: "us:gettext-hidden" },
  };

  it("puts the decision's own identifiers and heading terms into the first chunk only", () => {
    const chunks = deriveChunks(record);
    expect(chunks[0].identKeys).toEqual(expect.arrayContaining(["sz:1us1169-2026", "ecli:cz:us:2026:1.us.1169.26.1"]));
    expect(chunks[0].tsv).toMatch(/'1169':\d+A/);
    expect(chunks[0].tsv).toMatch(/:\d+B/);
    for (const c of chunks.slice(1)) expect(c.tsv).not.toMatch(/\d[AB]\b/);
    expect(chunks.at(-1)!.identKeys).toContain("sz:plus24-2010");
  });

  it("returns nothing without text", () => {
    expect(deriveChunks({ ...record, text: null })).toEqual([]);
  });
});
