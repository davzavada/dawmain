// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { htmlToDmd } from "@/src/files/convert/docx";
import { layoutToDmd } from "@/src/files/convert/pdf/layout";
import { convertText, escapeLineStart, wrapLongLine } from "@/src/files/convert/text";
import { DEFAULT_CONVERT_OPTIONS } from "@/src/files/convert/types";
import { parseDmd } from "@/src/files/dmd/parse";
import { PAGE_FLAGS } from "@/src/files/dmd/types";
import { filler, para, synDoc, synPage, type SynLine } from "./fixtures/files/pdf/synthetic";

/**
 * Regression tests of the converters for the review findings of the core
 * area: a body line opening with a note reference and ":" (core:F5), and a
 * PDF page holding nothing but the continuation of a note (core:F6).
 */

const ref = (id: number, n: number) => `<sup><a href="#dmd-footnote-${id}" id="dmd-footnote-ref-${id}">[${n}]</a></sup>`;
const body = (id: number, text: string) => `<li id="dmd-footnote-${id}"><p>${text} <a href="#dmd-footnote-ref-${id}">↑</a></p></li>`;
const html = (s: string) => new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${s}</body></html>`, "text/html").body;

describe("a line opening with a note reference and ':' stays body text (core:F5)", () => {
  it("DOCX: a line break right before the reference", () => {
    const out = htmlToDmd(html(`<p>Text<br/>${ref(1, 1)}: po zalomení</p><ol>${body(1, "Pozn")}</ol>`));
    const parsed = parseDmd(out.dmd);
    expect(parsed.problems).toEqual([]);
    expect(parsed.footnotes).toHaveLength(1);
    expect(parsed.footnotes[0].refAt).not.toBeNull();
    const def = parsed.text.slice(parsed.footnotes[0].defStart, parsed.footnotes[0].defEnd);
    expect(def).toContain("Pozn");
    expect(def).not.toContain("po zalomení");
    expect(parsed.text).toContain("po zalomení");
  });

  it("DOCX: the reference opening a paragraph", () => {
    const parsed = parseDmd(htmlToDmd(html(`<p>${ref(1, 1)}: úvodem</p><ol>${body(1, "Pozn")}</ol>`)).dmd);
    expect(parsed.problems).toEqual([]);
    expect(parsed.footnotes[0].refAt).not.toBeNull();
  });

  it("escapeLineStart and wrapLongLine continuations guard the definition shape", () => {
    expect(escapeLineStart("[^12]: text")).toBe("[^12] : text");
    expect(escapeLineStart("[^12] text")).toBe("[^12] text");
    const long = `${"slovo ".repeat(40)}[^1]: dál`;
    const pieces = wrapLongLine(long, 243);
    expect(pieces[1]).toMatch(/^\[\^1\] :/);
  });

  it("TXT: a wrapped continuation never turns into a definition", () => {
    // 3,333 × "slovo " ends at a space just before the 20,000-char cut: the continuation opens with the reference.
    const text = `${"slovo ".repeat(3_333)}[^1]: pokračování\n\n[^1]: Poznámka.`;
    const parsed = parseDmd(convertText(text, "md").dmd);
    expect(parsed.problems).toEqual([]);
    expect(parsed.footnotes).toHaveLength(1);
  });
});

describe("PDF: a page holding only a note's continuation (core:F6)", () => {
  const note = (y: number, text: string): SynLine => ({ y, text, size: 8 });
  const pages = () => [
    synPage(1, [
      ...filler(100, 20),
      ...para(400, ["Odstavec s odkazem{1} na poznámku, který pokračuje přes zlom strany dál a"], { last: "full" }),
      note(740, "{1} Začátek dlouhé poznámky, která pokračuje"),
    ]),
    synPage(2, [note(740, "na další straně a zde končí bez tečky"), note(750, "a ještě jeden řádek poznámky.")]),
    synPage(3, [...para(100, ["tady končí odstavec z první strany."]), ...filler(150, 20, 1)]),
  ];

  it("the lines join the open note, and the running paragraph is not split", () => {
    const r = layoutToDmd(synDoc(pages()), DEFAULT_CONVERT_OPTIONS);
    const parsed = parseDmd(r.dmd);
    expect(parsed.problems).toEqual([]);
    expect(parsed.footnotes).toHaveLength(1);
    const def = parsed.text.slice(parsed.footnotes[0].defStart, parsed.footnotes[0].defEnd);
    expect(def).toContain("Začátek dlouhé poznámky, která pokračuje na další straně");
    expect(def).toContain("ještě jeden řádek poznámky.");
    // The body keeps running across both page breaks.
    expect(r.dmd).toContain("přes zlom strany dál a [s. 2] [s. 3] tady končí odstavec z první strany.");
    expect(parsed.pages.map((p) => p.label)).toEqual(["1", "2", "3"]);
    // The guess is marked for review.
    expect(r.pageFlags[1] & PAGE_FLAGS.FN_UNSURE).toBe(PAGE_FLAGS.FN_UNSURE);
    expect(r.pageFlags[1] & PAGE_FLAGS.BLANK).toBe(0);
    expect(r.warnings.some((w) => w.startsWith("Strana 2 obsahovala jen drobné písmo"))).toBe(true);
    // Final review: the page word once ("Strana s. 2" read "page p. 2").
    expect(r.warnings.some((w) => w.includes("Strana s."))).toBe(false);
    expect(r.warnings.some((w) => w.includes("nebyly poznámky pod čarou spolehlivě rozpoznány"))).toBe(false);
  });

  // Skeptic follow-up: a note ending "…, s. 45" stays "open", but whole pages of small-type body text
  // (a petit excursus, a bibliography) must not be swallowed into it — let alone page after page.
  const petit = (y0: number, n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => note(y0 + i * 11, `${tag} drobným písmem řádek ${i} jako exkurz nebo seznam literatury`));
  const citing = () =>
    synPage(1, [
      ...filler(100, 20),
      ...para(400, ["Odstavec s odkazem{1} na poznámku končí tečkou."]),
      note(740, "{1} Srov. Novák, J. Občanský zákoník. Praha: C. H. Beck, 2019, s. 45"),
    ]);
  const bodyPages = (from: number) => Array.from({ length: 6 }, (_, i) => synPage(from + i, filler(100, 40, i)));

  it.each([10, 30])("whole small-type pages (%i lines) after an open note stay body text on their pages", (n) => {
    const r = layoutToDmd(synDoc([citing(), synPage(2, petit(80, n, "EXKURZ2")), synPage(3, petit(80, n, "EXKURZ3")), ...bodyPages(4)]), DEFAULT_CONVERT_OPTIONS);
    const parsed = parseDmd(r.dmd);
    expect(parsed.footnotes).toHaveLength(1);
    const def = parsed.text.slice(parsed.footnotes[0].defStart, parsed.footnotes[0].defEnd);
    expect(def).not.toContain("EXKURZ");
    const page2 = parsed.pages.find((p) => p.label === "2")!;
    const page3 = parsed.pages.find((p) => p.label === "3")!;
    expect(parsed.text.slice(page2.start, page2.end)).toContain("EXKURZ2 drobným písmem řádek 0");
    expect(parsed.text.slice(page3.start, page3.end)).toContain("EXKURZ3 drobným písmem řádek 0");
    expect(r.pageFlags[1] & PAGE_FLAGS.BLANK).toBe(0);
    expect(r.warnings.some((w) => w.includes("připojen k poznámce"))).toBe(false);
  });

  it("a continuation page never chains: the next small-type page stays on its own page", () => {
    const open2 = synPage(2, [note(740, "na další straně a zde končí bez tečky"), note(750, "a ještě jeden řádek poznámky bez tečky")]);
    const r = layoutToDmd(synDoc([pages()[0], open2, synPage(3, [note(740, "tohle je drobný text další strany bez tečky"), note(750, "a jeho druhý řádek")]), ...bodyPages(4)]), DEFAULT_CONVERT_OPTIONS);
    const parsed = parseDmd(r.dmd);
    const def = parsed.text.slice(parsed.footnotes[0].defStart, parsed.footnotes[0].defEnd);
    expect(def).toContain("ještě jeden řádek poznámky bez tečky");
    expect(def).not.toContain("drobný text další strany");
    const page3 = parsed.pages.find((p) => p.label === "3")!;
    expect(parsed.text.slice(page3.start, page3.end)).toContain("drobný text další strany");
  });

  it("after a finished note, small type alone on a page stays body text", () => {
    const r = layoutToDmd(
      synDoc([
        synPage(1, [...filler(100, 20), ...para(400, ["Odstavec s odkazem{1} končí tečkou."]), note(740, "{1} Poznámka, která končí tečkou.")]),
        synPage(2, [note(740, "Drobný text bez poznámky nad ním, jen drobným písmem."), note(750, "Druhý řádek téhož drobného textu na straně.")]),
        synPage(3, [...para(100, ["Další strana začíná novým odstavcem."]), ...filler(150, 20, 1)]),
      ]),
      DEFAULT_CONVERT_OPTIONS,
    );
    expect(r.dmd).toContain("Drobný text bez poznámky nad ním, jen drobným písmem.");
    const parsed = parseDmd(r.dmd);
    expect(parsed.footnotes).toHaveLength(1);
    expect(parsed.text.slice(parsed.footnotes[0].defStart, parsed.footnotes[0].defEnd)).not.toContain("Drobný");
  });
});
