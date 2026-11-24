import { describe, expect, it } from "vitest";
import { readDecision, readParagraphs } from "@/src/mcp/tools/reading";
import { pageOrExcerpt } from "@/src/sources/shared/text";

const body = (n: number, text = "Soud dospěl k závěru, že kasační stížnost není důvodná.") => `${n}. ${text}`;
const DECISION = ["ROZSUDEK", "takto:", "Kasační stížnost se zamítá.", "Odůvodnění:", ...Array.from({ length: 12 }, (_, i) => body(i + 1, `Bod číslo ${i + 1} o věci samé.`))].join("\n\n");

describe("readParagraphs", () => {
  it("returns the numbered paragraphs asked for, and nothing else", () => {
    const view = readParagraphs(DECISION, "4-6");
    expect(view.mode).toBe("excerpt");
    expect(view.text.startsWith("4. Bod číslo 4")).toBe(true);
    expect(view.text).toContain("6. Bod číslo 6 o věci samé.");
    expect(view.text).not.toContain("7. Bod");
    expect(view.text).not.toContain("3. Bod");
    expect(view.text).toContain("(Body 4–6 of 1–12 — a part of the decision; the whole text: page 1.)");
    expect(readParagraphs(DECISION, "12").text).toContain("(Bod 12 of 1–12");
    expect(view.has_more).toBe(false);
  });

  it("a range past the end stops at the last bod; a bod that is not there says how far they run", () => {
    expect(readParagraphs(DECISION, "11-40").text).toContain("(Body 11–12 of 1–12");
    expect(readParagraphs(DECISION, "40").text).toBe("No bod 40 in this decision: its numbered paragraphs run 1–12.");
  });

  it("a decision without numbering points at find and the pages", () => {
    expect(readParagraphs("Nejvyšší soud rozhodl takto:\n\nDovolání se odmítá.\n\nOdůvodnění:\n\nDovolání není přípustné.", "3").text).toMatch(/no numbered paragraphs/);
  });

  it("a range longer than a page stops on a whole paragraph and names the rest", () => {
    const long = ["takto:", "Zamítá se.", "Odůvodnění:", ...Array.from({ length: 30 }, (_, i) => body(i + 1, "slovo ".repeat(500)))].join("\n\n");
    const view = readParagraphs(long, "1-30");
    expect(view.text.length).toBeLessThan(46_000);
    const shown = /\(Body 1–(\d+) of 1–30/.exec(view.text)?.[1];
    expect(Number(shown)).toBeGreaterThan(5);
    expect(view.text).toContain(`continue with paragraphs: "${Number(shown) + 1}-30"`);
  });

  it("readDecision: paragraphs before find before the page", () => {
    expect(readDecision(DECISION, { page: 1, find: "věci", paragraphs: "2" }).text.startsWith("2. Bod číslo 2")).toBe(true);
    expect(readDecision(DECISION, { page: 1 }).mode).toBe("page");
  });
});

describe("find on a short text", () => {
  it("answers with the whole text once the excerpts would be most of it", () => {
    const para = `${"Soud prvního stupně zjistil, že ".repeat(8)}nájemce nezaplatil nájemné. ${"Odvolací soud se s tím ztotožnil. ".repeat(8)}`;
    const text = Array.from({ length: 6 }, (_, i) => `${i + 1}. ${para}`).join("\n");
    const view = pageOrExcerpt(text, 1, "nájemné");
    expect(view.mode).toBe("page");
    expect(view.matches).toBe(6);
    expect(view.text.startsWith(text)).toBe(true);
    expect(view.text).toContain("(The whole text, not excerpts:");
    expect(view.has_more).toBe(false);
  });

  it("keeps excerpts when they are a small part, or the text runs over a page", () => {
    const filler = "Obecná úvaha soudu o procesních otázkách bez vztahu k věci. ".repeat(100);
    expect(pageOrExcerpt(`${filler}\nNájemné nebylo zaplaceno.\n${filler}`, 1, "nájemné").mode).toBe("excerpt");
    const long = Array.from({ length: 700 }, () => "Nájemce nezaplatil nájemné za tři měsíce, a proto dostal výpověď.").join("\n");
    expect(pageOrExcerpt(long, 1, "nájemné").mode).toBe("excerpt");
  });
});
