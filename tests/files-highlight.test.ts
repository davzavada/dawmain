import { describe, expect, it } from "vitest";
import { bestWindow, findMatches } from "@/src/files/index/highlight";
import { queryIdentKeys } from "@/src/files/index/identifiers";
import { buildTsQuery } from "@/src/files/text/analyze";

/** What the search tool does: terms from the query builder, keys from the identifier parser. */
function q(query: string) {
  return { terms: buildTsQuery(query).terms, identKeys: queryIdentKeys(query).keys };
}
const texts = (text: string, spans: Array<{ start: number; end: number }>) => spans.map((s) => text.slice(s.start, s.end));

describe("findMatches", () => {
  it("finds inflected forms: „náhradu škody“ highlights „náhrada škody“", () => {
    const text = "Náhrada škody se poskytuje v penězích. Škodu nahradí škůdce.";
    // The verb "nahradí" shares the stem — a prefix match, as in Postgres.
    expect(texts(text, findMatches(text, q("náhradu škody")))).toEqual(["Náhrada", "škody", "Škodu", "nahradí"]);
  });

  it("matches queries typed without diacritics", () => {
    const text = "Zaměstnavatel odpovídá za škodu; zaměstnavatelé ji hradí ve smlouvách.";
    expect(texts(text, findMatches(text, q("zamestnavatelum smlouvami")))).toEqual(["Zaměstnavatel", "zaměstnavatelé", "smlouvách"]);
  });

  it("matches alternatives the stemmer is inconsistent about (soudce / soudců)", () => {
    const text = "Soudci rozhodli. Počet soudců je lichý.";
    expect(texts(text, findMatches(text, q("soudců")))).toEqual(["Soudci", "soudců"]);
  });

  it("digits match whole tokens only", () => {
    const text = "§ 2913 a § 29 a 291";
    expect(texts(text, findMatches(text, { terms: ["29"], identKeys: [] }))).toEqual(["29"]);
  });

  it("highlights identifiers by key, whatever their spelling", () => {
    const text = "Srov. rozsudek sp. zn. 25 Cdo 1234/19 a § 2913 odst. 2 o. z.";
    const spans = findMatches(text, { terms: [], identKeys: ["sz:25cdo1234-2019", "parz:89/2012/2913"] });
    expect(texts(text, spans)).toEqual(["25 Cdo 1234/19", "§ 2913 odst. 2"]);
  });

  it("a sec: key matches the bare § reference", () => {
    const text = "podle § 2913 je";
    expect(texts(text, findMatches(text, { terms: [], identKeys: ["sec:par:2913"] }))).toEqual(["§ 2913"]);
  });

  it("merges overlapping term and identifier spans, sorted", () => {
    const text = "sp. zn. 25 Cdo 1234/2019, Cdo";
    const spans = findMatches(text, { terms: ["cdo", "1234"], identKeys: ["sz:25cdo1234-2019"] });
    expect(texts(text, spans)).toEqual(["25 Cdo 1234/2019", "Cdo"]);
  });

  it("returns nothing for an empty query or text", () => {
    expect(findMatches("text", { terms: [], identKeys: [] })).toEqual([]);
    expect(findMatches("", q("škoda"))).toEqual([]);
    expect(findMatches("text", { terms: [""], identKeys: [] })).toEqual([]);
  });
});

describe("bestWindow", () => {
  const filler = (n: number) => "slovo ".repeat(n).trim();

  it("null without matches", () => {
    expect(bestWindow("text", [])).toBeNull();
    expect(bestWindow("text", [{ start: 10, end: 12 }])).toBeNull(); // out of range
  });

  it("returns the whole short paragraph without ellipses", () => {
    const text = "Náhrada škody se poskytuje v penězích.";
    const w = bestWindow(text, findMatches(text, q("škoda")))!;
    expect(w).toEqual({ start: 0, end: text.length, matchAt: 8, excerpt: text });
  });

  it("starts at the paragraph start when it is within 300 chars", () => {
    const text = `${filler(100)}\n[m. č. 14] ${filler(20)} náhrada škody ${filler(200)}`;
    const w = bestWindow(text, findMatches(text, q("náhrada")))!;
    expect(text.slice(w.start, w.start + 10)).toBe("[m. č. 14]");
    expect(w.excerpt.startsWith("[m. č. 14]")).toBe(true);
    expect(w.excerpt.endsWith("…")).toBe(true);
    expect(w.end - w.start).toBeLessThanOrEqual(600);
    expect(w.matchAt).toBe(text.indexOf("náhrada"));
  });

  it("centres a far match, snapped to words, with ellipses on both cuts", () => {
    const text = `${filler(200)} náhrada ${filler(200)}`;
    const w = bestWindow(text, findMatches(text, q("náhrada")), 120)!;
    expect(w.end - w.start).toBeLessThanOrEqual(120);
    expect(w.start).toBeLessThanOrEqual(w.matchAt);
    expect(w.end).toBeGreaterThanOrEqual(w.matchAt + "náhrada".length);
    expect(w.excerpt).toMatch(/^…slovo .* slovo…$/); // whole words at both ends
    expect(w.excerpt).toContain("náhrada");
  });

  it("picks the densest cluster", () => {
    const text = `škoda ${filler(300)} škoda náhrada škoda ${filler(300)}`;
    const w = bestWindow(text, findMatches(text, q("škoda náhrada")), 200)!;
    expect(w.matchAt).toBe(text.indexOf("škoda náhrada"));
  });

  it("uses the room before the cluster at the end of the text", () => {
    const text = `${filler(200)} škoda`;
    const w = bestWindow(text, findMatches(text, q("škoda")), 100)!;
    expect(w.end).toBe(text.length);
    expect(w.end - w.start).toBeGreaterThan(90);
    expect(w.excerpt.startsWith("…")).toBe(true);
    expect(w.excerpt.endsWith("…")).toBe(false);
  });

  it("does not add an ellipsis at a paragraph break", () => {
    const text = `Úvod.\nNáhrada škody.\n${filler(300)}`;
    const w = bestWindow(text, findMatches(text, q("náhrada")), 40)!;
    expect(w.excerpt.startsWith("Náhrada")).toBe(true);
  });

  it("never splits a surrogate pair at the end", () => {
    const text = `škoda ${"😀".repeat(100)}`;
    const w = bestWindow(text, [{ start: 0, end: 5 }], 20)!;
    expect(w.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("keeps a match longer than the window visible", () => {
    const text = `a ${"x".repeat(1000)} b`;
    const w = bestWindow(text, [{ start: 2, end: 1002 }], 100)!;
    expect(w.matchAt).toBe(2);
    expect(w.start).toBeLessThanOrEqual(2);
  });
});
