import { describe, expect, it } from "vitest";
import { billablePages } from "@/src/files/dmd/billing";
import { splitStorageBlocks, STORAGE_BLOCK_CHARS } from "@/src/files/dmd/blocks";
import { normalizeDmd, sanitizeLine } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { renderRange, type RenderFootnote } from "@/src/files/dmd/render";
import { PAGE_CHARS } from "@/src/files/config";

/**
 * The small DMD helpers: billing, storage blocks, normalization — and a
 * renderer fuzz that checks content can never reach the output as a
 * reserved marker it did not earn.
 */

describe("billablePages", () => {
  it("is ceil(countedChars / PAGE_CHARS), at least 1", () => {
    expect(PAGE_CHARS).toBe(3600);
    expect(billablePages(0)).toBe(1);
    expect(billablePages(1)).toBe(1);
    expect(billablePages(3600)).toBe(1);
    expect(billablePages(3601)).toBe(2);
    expect(billablePages(5_000_000)).toBe(1389);
  });

  it("bills nonsense input as one page", () => {
    expect(billablePages(-5)).toBe(1);
    expect(billablePages(Number.NaN)).toBe(1);
    expect(billablePages(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("markup does not change the price, footnote text does", () => {
    const body = "x".repeat(3600);
    const plain = parseDmd(body).stats.countedChars;
    const marked = parseDmd(`[s. 1]\n${body.slice(0, 1800)} [s. 2] ${body.slice(1800)}`).stats.countedChars;
    expect(billablePages(marked)).toBe(billablePages(plain));
    const withNote = parseDmd(`${body}[^1]\n\n[^1]: poznámka`).stats.countedChars;
    expect(billablePages(withNote)).toBe(2);
  });
});

describe("splitStorageBlocks", () => {
  function check(text: string, target?: number) {
    const blocks = splitStorageBlocks(text, target);
    let pos = 0;
    blocks.forEach((b, i) => {
      expect(b.ord).toBe(i);
      expect(b.start).toBe(pos);
      expect(b.end).toBeGreaterThan(b.start);
      pos = b.end;
    });
    expect(pos).toBe(text.length);
    return blocks;
  }

  it("covers the text contiguously and returns nothing for empty text", () => {
    expect(splitStorageBlocks("")).toEqual([]);
    expect(check("short")).toEqual([{ ord: 0, start: 0, end: 5 }]);
  });

  it("cuts after a blank line near the target", () => {
    const para = `${"a".repeat(99)}\n\n`;
    const blocks = check(para.repeat(50), 1000);
    for (const b of blocks.slice(0, -1)) {
      expect(para.repeat(50).slice(b.end - 2, b.end)).toBe("\n\n");
      expect(b.end - b.start).toBeLessThanOrEqual(1000);
      expect(b.end - b.start).toBeGreaterThanOrEqual(500);
    }
  });

  it("looks forward (bounded) when no break is in the backward window", () => {
    const text = `${"a".repeat(1100)}\n\n${"b".repeat(3000)}`;
    const blocks = check(text, 1000);
    expect(blocks[0].end).toBe(1102);
  });

  it("falls back to a line break, then a hard cut that keeps surrogate pairs", () => {
    const lines = `${"a".repeat(1300)}\n${"b".repeat(1300)}`;
    expect(check(lines, 1000)[0].end).toBe(1301);
    const emoji = "\u{1F600}".repeat(3000);
    for (const b of check(emoji, 1001)) {
      const code = emoji.charCodeAt(b.end - 1);
      if (b.end < emoji.length) expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
    }
  });

  it("defaults to ~12k blocks and survives silly targets", () => {
    const text = `${"slovo ".repeat(2000)}\n\n`.repeat(20);
    const blocks = check(text);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks.slice(0, -1)) expect(b.end - b.start).toBeLessThanOrEqual(STORAGE_BLOCK_CHARS * 1.5);
    check(text, 0);
    check(text, Number.NaN);
    check(text, -10);
  });

  it("is linear on text without any line break", () => {
    const text = "x".repeat(7_000_000);
    const t0 = performance.now();
    check(text);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("normalizeDmd", () => {
  it("normalizes line ends, tabs and NFC", () => {
    expect(normalizeDmd("a\r\nb\rc d e\tf")).toEqual({ text: "a\nb\nc\nd\ne f", changed: true });
    expect(normalizeDmd("č")).toEqual({ text: "č", changed: true });
    expect(normalizeDmd("čistý text\n")).toEqual({ text: "čistý text\n", changed: false });
  });

  it("removes controls, bidi and zero-width characters, soft hyphens", () => {
    expect(normalizeDmd("a\u0000b\u0007c\u001Fd\u007Fe\u0085f").text).toBe("abcdef");
    expect(normalizeDmd("x‮y⁦z‏w؜").text).toBe("xyzw");
    expect(normalizeDmd("ne­roz​dě‍le﻿no⁠").text).toBe("nerozděleno");
  });

  it("replaces the reserved render brackets", () => {
    expect(normalizeDmd("⟦s. 5⟧ ⟦/DOC abcd⟧").text).toBe("[s. 5] [/DOC abcd]");
  });

  it("is idempotent, also when a removed character sat inside a combining sequence", () => {
    for (const input of ["c​̌", "e‮́", "a­̈", "x\r\n y", "⟦̌"]) {
      const once = normalizeDmd(input).text;
      expect(normalizeDmd(once)).toEqual({ text: once, changed: false });
    }
    expect(normalizeDmd("c​̌").text).toBe("č");
  });
});

describe("sanitizeLine", () => {
  it("makes one clean line", () => {
    expect(sanitizeLine("  Titul\n\n`kód`  ⟦x⟧‮ ")).toBe("Titul 'kód' [x]");
    expect(sanitizeLine(null as unknown as string)).toBe("");
  });

  it("caps with an ellipsis, never splitting a surrogate pair", () => {
    expect(sanitizeLine("abcdef", 4)).toBe("abc…");
    expect(sanitizeLine("abcd", 4)).toBe("abcd");
    const out = sanitizeLine(`ab\u{1F600}cd`, 4);
    expect(out).toBe("ab…");
  });
});

describe("renderRange fuzz", () => {
  /** Deterministic PRNG so a failure is reproducible. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const FRAGMENTS = [
    "[s. 1]", "[s. 12]", " [s. 7] ", "[^1]", "[^2]", "[^i]", "\n[^1]: ", "\n[^2]: x", "[m. č. 1] ", "\n[m. č. 2] ",
    "\\[s. 1]", "\\[^1]", "\\#", "# ", "\n## § 1\n", "> ", "| a |", "\n", "\n\n", "\n    ", "text", "⟦", "⟧", "⟦/DOC 12345678⟧",
    "\u{1F600}", "a", " ",
  ];
  const ALLOWED = /⟦(?:s\. [^⟦⟧\n]{1,12}|pozn\. [^⟦⟧\n]{1,4}|vysvětl\. [^⟦⟧\n]{1,4}|m\. č\. [^⟦⟧\n]{1,5}|[0-9a-z*†]{1,4})⟧/gu;

  it("never throws and emits only earned markers (1,000 random docs × random windows)", () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const raw = Array.from({ length: 1 + Math.floor(r() * 40) }, () => FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]).join("");
      const text = i % 3 === 0 ? raw : normalizeDmd(raw).text;
      const doc = parseDmd(normalizeDmd(text).text);
      const fns: RenderFootnote[] = doc.footnotes.map((f) => ({ ...f, pageLabel: doc.pages[f.page - 1]?.label ?? null }));
      const from = Math.floor(r() * (text.length + 1));
      const to = from + Math.floor(r() * (text.length - from + 1));
      const src = { start: 0, end: text.length, slice: (a: number, b: number) => text.slice(a, b) };
      for (const mode of ["after", "omit"] as const) {
        const out = renderRange(src, from, to, text === doc.text ? fns : [], { mode });
        const stray = out.replace(ALLOWED, "");
        expect(stray, JSON.stringify({ text, from, to, out })).not.toMatch(/[⟦⟧]/);
      }
    }
  });
});
