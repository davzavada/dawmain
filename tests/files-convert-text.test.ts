import { describe, expect, it } from "vitest";
import {
  convertText,
  countPlaceholders,
  decodeText,
  definitionLines,
  endnoteLabel,
  escapeInline,
  escapeLineStart,
  escapeTextLine,
  footnoteLabel,
  formatCount,
  MAX_LINE_CHARS,
  normalizePlaceholders,
  plural,
  toRoman,
  unpagedResult,
  wrapLongLine,
} from "@/src/files/convert/text";
import { parseDmd, unescapeDmd } from "@/src/files/dmd/parse";
import { DMD_LIMITS } from "@/src/files/dmd/types";
import type { ConvertResult } from "@/src/files/convert/types";

/**
 * TXT/MD conversion and the DMD-writing helpers the DOCX converter shares:
 * every output must parse with the real parser, bind every footnote, and
 * never let document text pose as markup.
 */

/** Parse the converter output and assert the round-trip invariants. */
function roundTrip(result: ConvertResult) {
  const parsed = parseDmd(result.dmd);
  expect(parsed.stats.danglingRefs).toBe(0);
  expect(parsed.paged).toBe(false);
  expect(parsed.pages).toEqual([]);
  return parsed;
}

function defText(dmd: string, seq: number): string {
  const parsed = parseDmd(dmd);
  const fn = parsed.footnotes[seq - 1];
  return parsed.text.slice(fn.defStart, fn.defEnd);
}

describe("escaping", () => {
  it("escapes inline markers anywhere and markup at a line start", () => {
    expect(escapeInline("viz [s. 5] a [^1] a [m. č. 3] konec")).toBe("viz \\[s. 5] a \\[^1] a \\[m. č. 3] konec");
    expect(escapeInline("[a] [s.5] [m. c. 3] [^]")).toBe("[a] [s.5] [m. c. 3] \\[^]");
    expect(escapeLineStart("# x")).toBe("\\# x");
    expect(escapeLineStart("> x")).toBe("\\> x");
    expect(escapeLineStart("| x |")).toBe("\\| x |");
    expect(escapeLineStart("x # y")).toBe("x # y");
    expect(escapeTextLine("# [^1]")).toBe("\\# \\[^1]");
  });

  it("escaped text parses as plain text and unescapes to the original", () => {
    const original = "[s. 12] [^1]: [m. č. 4] text";
    const line = escapeTextLine(original);
    const parsed = parseDmd(`[s. 1]\n\n${line}`);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.refs).toHaveLength(0);
    expect(parsed.footnotes).toHaveLength(0);
    expect(parsed.stats.marginalNumbers).toBe(0);
    expect(unescapeDmd(line)).toBe(original);
  });
});

describe("placeholders", () => {
  it("normalizes fill lines and checkboxes, keeps [●]", () => {
    const { text, count } = normalizePlaceholders("Jméno: ________ dne ........ místo …… a . . . . . a [●] ☑ ☐ ☒ x   y");
    expect(text).toBe("Jméno: [____] dne [____] místo [____] a [____] a [●] ☒ ☐ ☒ x[____]y");
    expect(count).toBe(9);
  });

  it("leaves short runs and prose punctuation alone", () => {
    expect(normalizePlaceholders("a___b ... atd.… x_y").text).toBe("a___b ... atd.… x_y");
    expect(normalizePlaceholders("tečky . . . . . dál").text).toBe("tečky [____] dál");
  });

  it("maps the Word non-breaking hyphen to a hyphen", () => {
    expect(normalizePlaceholders("česko‑slovenský").text).toBe("česko-slovenský");
  });

  it("counts placeholders", () => {
    expect(countPlaceholders("[____] [●] ☐ ☒ [___] [o]")).toBe(4);
    expect(countPlaceholders("")).toBe(0);
  });
});

describe("wrapLongLine", () => {
  it("keeps short lines and splits long ones at spaces", () => {
    expect(wrapLongLine("abc")).toEqual(["abc"]);
    const words = Array.from({ length: 5000 }, (_, i) => `slovo${i}`).join(" ");
    const pieces = wrapLongLine(words, 1000);
    expect(pieces.length).toBeGreaterThan(30);
    expect(pieces.every((p) => p.length <= 1000)).toBe(true);
    expect(pieces.join(" ")).toBe(words);
  });

  it("hard-cuts a run without spaces, never inside a surrogate pair or an escape", () => {
    const emoji = "😀".repeat(600); // 1200 UTF-16 units
    const pieces = wrapLongLine(emoji, 501);
    expect(pieces.join("")).toBe(emoji);
    for (const p of pieces) expect(/^[\uDC00-\uDFFF]/.test(p)).toBe(false);

    const escaped = "a".repeat(495) + "\\[^1]" + "b".repeat(600);
    const cut = wrapLongLine(escaped, 500);
    expect(cut[1].startsWith("\\[^1]")).toBe(true);
    expect(cut.join("")).toBe(escaped);
  });

  it("escapes continuation pieces that would start markup", () => {
    const line = "x".repeat(10) + " # nadpis?";
    expect(wrapLongLine(line, 11)).toEqual(["x".repeat(10), "\\# nadpis?"]);
  });

  it("uses a default well under the parser's line cap", () => {
    expect(MAX_LINE_CHARS).toBeLessThan(DMD_LIMITS.maxLineChars);
  });
});

describe("definitionLines", () => {
  it("writes the head line and indented continuations", () => {
    expect(definitionLines("3", ["První.", "Druhý."])).toEqual({ lines: ["[^3]: První.", "    Druhý."], overflow: [] });
    expect(definitionLines("i", [])).toEqual({ lines: ["[^i]:"], overflow: [] });
  });

  it("splits a definition over the parser's cap into head + overflow text", () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" "); // ~16k chars
    const { lines, overflow } = definitionLines("1", [long, "tail"]);
    const body = lines.join("\n").slice("[^1]: ".length);
    expect(body.length).toBeLessThanOrEqual(DMD_LIMITS.maxFootnoteChars);
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow[overflow.length - 1]).toBe("tail");
    const all = [lines.join(" ").replace(/^\[\^1\]: /, "").replace(/\s+/g, " "), ...overflow].join(" ");
    expect(all).toBe(`${long} tail`);
    // …and the result parses.
    const dmd = `Text[^1]\n\n${lines.join("\n")}\n\n${overflow.join("\n")}`;
    expect(parseDmd(dmd).footnotes).toHaveLength(1);
  });
});

describe("labels", () => {
  it("numbers footnotes and wraps past 9999", () => {
    expect(footnoteLabel(1)).toBe("1");
    expect(footnoteLabel(9999)).toBe("9999");
    expect(footnoteLabel(10000)).toBe("1");
  });

  it("labels endnotes with Roman numerals up to xvii, else letters", () => {
    expect(toRoman(4)).toBe("iv");
    expect(toRoman(17)).toBe("xvii");
    expect(endnoteLabel(1, 3)).toBe("i");
    expect(endnoteLabel(17, 17)).toBe("xvii");
    expect(endnoteLabel(1, 18)).toBe("a");
    expect(endnoteLabel(26, 30)).toBe("z");
    expect(endnoteLabel(27, 30)).toBe("aa");
    // Every Roman label up to xvii fits the 4-letter label grammar.
    for (let i = 1; i <= 17; i++) expect(endnoteLabel(i, 17).length).toBeLessThanOrEqual(4);
  });
});

describe("small helpers", () => {
  it("formats counts and Czech plurals", () => {
    expect(formatCount(7000000)).toBe("7 000 000");
    expect(formatCount(999)).toBe("999");
    expect(plural(1, "a", "b", "c")).toBe("a");
    expect(plural(3, "a", "b", "c")).toBe("b");
    expect(plural(5, "a", "b", "c")).toBe("c");
    expect(plural(0, "a", "b", "c")).toBe("c");
  });

  it("builds unpaged results and warns about documents over the size cap", () => {
    const quality = { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "none", mn: 0, unsure_pages: [] } as const;
    const r = unpagedResult({ kind: "txt", converter: "txt@1", dmd: "a\r\nb", quality: { ...quality, unsure_pages: [] }, warnings: [] });
    expect(r).toMatchObject({ dmd: "a\nb", labelSource: "none", physicalPages: null, pageFlags: [], pageLabels: [], hints: {} });
    const big = unpagedResult({ kind: "txt", converter: "txt@1", dmd: "x".repeat(DMD_LIMITS.maxChars + 1), quality: { ...quality, unsure_pages: [] }, warnings: [] });
    expect(big.warnings[0]).toMatch(/nejvýš 7 000 000/);
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 (BOM stripped)", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Příliš žluťoučký")]);
    expect(decodeText(bytes)).toEqual({ text: "Příliš žluťoučký", encoding: "utf-8" });
  });

  it("falls back to windows-1250 when UTF-8 is invalid", () => {
    // "Příliš" in windows-1250: P 0xF8 í l i 0x9A
    const bytes = new Uint8Array([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a]);
    expect(decodeText(bytes)).toEqual({ text: "Příliš", encoding: "windows-1250" });
  });

  it("reads UTF-16 with a BOM", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x50, 0x00, 0x59, 0x01]); // "Př"
    expect(decodeText(le)).toEqual({ text: "Př", encoding: "utf-16le" });
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x50, 0x01, 0x59]);
    expect(decodeText(be)).toEqual({ text: "Př", encoding: "utf-16be" });
  });

  it("rejects binary content", () => {
    expect(() => decodeText(new Uint8Array([0x41, 0x00, 0x42]))).toThrow("binary");
  });
});

describe("convertText — TXT", () => {
  it("keeps paragraphs and escapes everything that looks like markup", () => {
    const r = convertText("# not a heading\n> not a quote\n| not a table\n\n[s. 5] a [m. č. 2] b", "txt");
    expect(r.dmd).toBe("\\# not a heading\n\\> not a quote\n\\| not a table\n\n\\[s. 5] a \\[m. č. 2] b");
    const parsed = roundTrip(r);
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.blocks.every((b) => b.kind === "para")).toBe(true);
    expect(parsed.problems).toEqual([]);
    expect(r).toMatchObject({ kind: "txt", converter: "txt@1", labelSource: "none", physicalPages: null });
    expect(r.quality).toMatchObject({ footnotes: "none", headings_from: "none" });
  });

  it("moves pandoc definitions after the citing paragraph and numbers them by first reference", () => {
    const src = [
      "[^b]: Druhá poznámka.",
      "",
      "Úvod s odkazem[^a] a dalším[^b].",
      "",
      "Jiný odstavec.",
      "",
      "[^a]: První poznámka",
      "  pokračuje líně.",
      "",
      "    Druhý odstavec poznámky.",
    ].join("\n");
    const r = convertText(src, "txt");
    expect(r.dmd).toBe(
      [
        "Úvod s odkazem[^1] a dalším[^2].",
        "",
        "[^1]: První poznámka pokračuje líně.",
        "    Druhý odstavec poznámky.",
        "[^2]: Druhá poznámka.",
        "",
        "Jiný odstavec.",
      ].join("\n"),
    );
    const parsed = roundTrip(r);
    expect(parsed.footnotes.map((f) => [f.label, f.refAt !== null])).toEqual([["1", true], ["2", true]]);
    expect(r.quality).toMatchObject({ footnotes: "linked", linked_ratio: 1 });
  });

  it("gives every repeated reference its own copy of the definition", () => {
    const r = convertText("A[^x] b.\n\nC[^x] d.\n\n[^x]: Tamtéž.", "txt");
    expect(r.dmd).toBe("A[^1] b.\n\n[^1]: Tamtéž.\n\nC[^1] d.\n\n[^1]: Tamtéž.");
    expect(roundTrip(r).footnotes.every((f) => f.refAt !== null)).toBe(true);
  });

  it("keeps references without definitions and unreferenced definitions as visible text", () => {
    const r = convertText("Text[^missing] a \\[^x] literal.\n\n[^orphan]: Nikdo necituje.", "txt");
    expect(r.dmd).toBe("Text\\[^missing] a \\\\[^x] literal.\n\n\\[^orphan]: Nikdo necituje.");
    const parsed = roundTrip(r);
    expect(parsed.footnotes).toHaveLength(0);
    expect(r.warnings.join(" ")).toMatch(/1 poznámka nemá odkaz/);
    expect(r.warnings.join(" ")).toMatch(/1 odkaz na poznámku bez jejího textu/);
    expect(r.quality.footnotes).toBe("none");
  });

  it("uses the first of duplicate definitions and keeps the second as text", () => {
    const r = convertText("A[^1].\n\n[^1]: první\n\n[^1]: druhá", "txt");
    expect(r.dmd).toBe("A[^1].\n\n[^1]: první\n\n\\[^1]: druhá");
    expect(roundTrip(r).footnotes).toHaveLength(1);
    expect(r.quality.footnotes).toBe("partial");
  });

  it("relabels pandoc labels the DMD grammar would reject", () => {
    const r = convertText("A[^poznámka-1] b[^LONG_label].\n\n[^poznámka-1]: x\n[^LONG_label]: y", "txt");
    expect(r.dmd).toBe("A[^1] b[^2].\n\n[^1]: x\n[^2]: y");
    roundTrip(r);
  });

  it("dedents lines so nothing after a definition reads as its continuation", () => {
    const r = convertText("A[^1].\n\n[^1]: pozn.\n\nText.\n\n        odsazený řádek", "txt");
    const parsed = roundTrip(r);
    expect(defText(r.dmd, 1)).toBe("pozn.");
    expect(parsed.blocks.filter((b) => b.kind === "para")).toHaveLength(3);
  });

  it("wraps very long lines so the parser accepts them", () => {
    const line = Array.from({ length: 8000 }, (_, i) => `slovo${i}`).join(" ");
    const r = convertText(line, "txt");
    expect(r.dmd.split("\n").every((l) => l.length <= MAX_LINE_CHARS)).toBe(true);
    const parsed = roundTrip(r);
    expect(parsed.blocks).toHaveLength(1);
  });

  it("splits an over-long definition and says so", () => {
    const note = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const r = convertText(`A[^1].\n\n[^1]: ${note}`, "txt");
    roundTrip(r);
    expect(r.warnings.join(" ")).toMatch(/delší než 10 000 znaků/);
  });

  it("normalizes input (CRLF, tabs, controls, reserved brackets) and placeholders", () => {
    const r = convertText("Jméno:\t________\r\nPodpis ⟦s. 3⟧\u0007", "txt");
    // The reserved brackets become [ ] — and then look like a page marker, so they are escaped.
    expect(r.dmd).toBe("Jméno: [____]\nPodpis \\[s. 3]");
    expect(roundTrip(r).problems).toEqual([]);
  });

  it("returns an empty document for empty input", () => {
    const r = convertText("", "txt");
    expect(r.dmd).toBe("");
    expect(parseDmd(r.dmd).blocks).toEqual([]);
  });
});

describe("convertText — Markdown", () => {
  it("keeps ATX and setext headings, quotes and table rows", () => {
    const src = [
      "# Kapitola 1 #",
      "Text pod nadpisem.",
      "",
      "Podnadpis",
      "---------",
      "",
      "> Citace ustanovení",
      ">",
      "> druhý řádek",
      "",
      "| a | b |",
      "|---|---|",
      "",
      "***",
      "",
      "## § 5 [Název][^n]",
      "",
      "[^n]: Pozn. k §.",
    ].join("\n");
    const r = convertText(src, "md");
    expect(r.dmd).toBe(
      [
        "# Kapitola 1",
        "",
        "Text pod nadpisem.",
        "",
        "## Podnadpis",
        "",
        "> Citace ustanovení",
        ">",
        "> druhý řádek",
        "",
        "| a | b |",
        "|---|---|",
        "",
        "## § 5 [Název][^1]",
        "",
        "[^1]: Pozn. k §.",
      ].join("\n"),
    );
    const parsed = roundTrip(r);
    expect(parsed.sections.map((s) => [s.level, s.kind, s.key])).toEqual([
      [1, "chapter", "ch:1"],
      [2, "sub", null],
      [2, "par", "par:5"],
    ]);
    expect(parsed.blocks.map((b) => b.kind)).toContain("quote");
    expect(parsed.blocks.map((b) => b.kind)).toContain("table");
    expect(r.quality.headings_from).toBe("markdown");
    expect(r.converter).toBe("md@1");
  });

  it("writes a heading's notes after the paragraph above it first", () => {
    const r = convertText("Text[^a]\n# Nadpis[^b]\n\n[^a]: A\n[^b]: B", "md");
    expect(r.dmd).toBe("Text[^1]\n\n[^1]: A\n\n# Nadpis[^2]\n\n[^2]: B");
    roundTrip(r);
  });

  it("treats fenced code as opaque text", () => {
    const r = convertText("```\n# komentář\n[^1]: není poznámka\n    odsazeno\n```\n\nText[^1].\n\n[^1]: skutečná", "md");
    const parsed = roundTrip(r);
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.footnotes).toHaveLength(1);
    expect(defText(r.dmd, 1)).toBe("skutečná");
    expect(r.dmd).toContain("\\# komentář\n\\[^1]: není poznámka\nodsazeno");
  });

  it("demotes a heading longer than the parser allows to a paragraph", () => {
    const r = convertText(`# ${"slovo ".repeat(80)}`, "md");
    const parsed = roundTrip(r);
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.problems).toEqual([]);
  });

  it("does not turn a lone --- into a heading and drops it as a thematic break", () => {
    const r = convertText("A\n\n---\n\nB", "md");
    expect(r.dmd).toBe("A\n\nB");
  });

  it("escapes markup-looking text that is not Markdown structure", () => {
    const r = convertText("Odkaz [s. 12] a [m. č. 3] zde.\n#hashtag", "md");
    expect(r.dmd).toBe("Odkaz \\[s. 12] a \\[m. č. 3] zde.\n\\#hashtag");
    expect(unescapeDmd(r.dmd)).toBe("Odkaz [s. 12] a [m. č. 3] zde.\n#hashtag");
    expect(roundTrip(r).problems).toEqual([]);
  });
});

describe("convertText — adversarial input", () => {
  // Deterministic PRNG so failures reproduce.
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const PIECES = ["[", "]", "^", "[^1]", "[^1]: ", "[^x]", "s. ", "[s. 4]", "m. č. ", "[m. č. 2] ", "#", "# ", "> ", "|", "\\", " ", "\n", "\n\n", "    ", "\t", "1", "a", "ř", "⟦", "⟧", "_____", ".....", "…", ":", "*", "```", "---", "===", "​", "‮"];

  it("always yields parseable DMD with every reference bound and no structural problems", () => {
    const next = rng(42);
    for (let round = 0; round < 400; round++) {
      let src = "";
      const len = 1 + Math.floor(next() * 40);
      for (let i = 0; i < len; i++) src += PIECES[Math.floor(next() * PIECES.length)];
      for (const kind of ["txt", "md"] as const) {
        const r = convertText(src, kind);
        const parsed = parseDmd(r.dmd);
        expect(parsed.stats.danglingRefs, `${kind}: ${JSON.stringify(src)}`).toBe(0);
        expect(parsed.stats.danglingDefs, `${kind}: ${JSON.stringify(src)}`).toBe(0);
        expect(parsed.problems, `${kind}: ${JSON.stringify(src)}`).toEqual([]);
        expect(parsed.pages).toEqual([]);
        expect(r.dmd).not.toMatch(/[⟦⟧​‮]/);
      }
    }
  });
});
