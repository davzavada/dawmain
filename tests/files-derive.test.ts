import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import type { DmdSection, ParsedDoc } from "@/src/files/dmd/types";
import {
  buildMetaTsv,
  CHUNK_MAX,
  CHUNK_MIN,
  CHUNK_TARGET,
  deriveIndex,
  keyDesignator,
  MAX_DOC_IDENT_KEYS,
  MAX_GLUE,
  META_HEADING_CHARS,
  metaIdentKeys,
  sectionRangeOf,
} from "@/src/files/index/derive";
import type { Derived, DerivedChunk } from "@/src/files/index/types";
import { buildTsQuery } from "@/src/files/text/analyze";
import type { DocType } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * deriveIndex / buildMetaTsv / metaIdentKeys. Besides targeted cases for
 * every chunking rule, a structural invariant check runs over every derived
 * document (ordered, non-overlapping chunks inside one section; every indexed
 * body character covered; every footnote definition inside the chunk of its
 * reference; pages consistent) and every tsvector literal goes through a
 * real Postgres (PGlite) at the end.
 */

// ─────────────────────────────────────────────────────────────── helpers

interface Derivation {
  parsed: ParsedDoc;
  derived: Derived;
}

/** Every derivation of this file, so the Postgres test can check all tsv literals. */
const produced: Derivation[] = [];

function derive(dmd: string, docType: DocType | null = "kniha", commentedAct: string | null = null): Derivation {
  const parsed = parseDmd(normalizeDmd(dmd).text);
  const derived = deriveIndex(parsed, { docType, commentedAct });
  checkInvariants(parsed, derived);
  const out = { parsed, derived };
  produced.push(out);
  return out;
}

const textOf = (d: Derivation, c: DerivedChunk) => d.parsed.text.slice(c.start, c.end);

/** Lexeme → weights of its positions ("C" for `1C`, "D" for a bare `1`). */
function weights(tsv: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of tsv.matchAll(/'((?:[^']|'')*)':([0-9A-D,]+)/g)) {
    out.set(
      m[1],
      m[2].split(",").map((p) => /[ABC]$/.exec(p)?.[0] ?? "D"),
    );
  }
  return out;
}
const weightsOf = (tsv: string, lexeme: string) => [...new Set(weights(tsv).get(lexeme) ?? [])].sort().join("");

/** Body characters of a chunk: para / quote / table text it covers. */
function bodyOf(p: ParsedDoc, c: DerivedChunk): number {
  let n = 0;
  for (const b of p.blocks) {
    if (b.kind !== "para" && b.kind !== "quote" && b.kind !== "table") continue;
    n += Math.max(0, Math.min(b.end, c.end) - Math.max(b.start, c.start));
  }
  return n;
}

const chunkAt = (d: Derived, offset: number) => d.chunks.find((c) => c.start <= offset && offset < c.end);

function pageOf(p: ParsedDoc, offset: number): number | null {
  if (!p.paged) return null;
  let ord = p.pages[0].ord;
  for (const page of p.pages) if (page.start <= offset) ord = page.ord;
  return ord;
}

/** True when a heading block lies strictly between `a` and `b`. */
function headingBetween(p: ParsedDoc, a: number, b: number): boolean {
  return p.blocks.some((blk) => blk.kind === "heading" && blk.start > a && blk.start <= b);
}

function checkInvariants(p: ParsedDoc, d: Derived): void {
  const { text } = p;
  d.chunks.forEach((c, i) => {
    expect(c.ord).toBe(i);
    expect(c.end).toBeGreaterThan(c.start);
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.end).toBeLessThanOrEqual(text.length);
    if (i > 0) expect(c.start).toBeGreaterThanOrEqual(d.chunks[i - 1].end);
    // Never across a heading: a heading may only open the chunk.
    for (const b of p.blocks) if (b.kind === "heading") expect(b.start > c.start && b.start < c.end).toBe(false);
    // Inside its section (the innermost one), which is indexed.
    if (c.section !== null) {
      const s = p.sections[c.section];
      expect(s.indexed).toBe(true);
      expect(c.start).toBeGreaterThanOrEqual(s.start);
      expect(c.end).toBeLessThanOrEqual(s.end);
    } else {
      const first = p.blocks.find((b) => b.kind === "heading");
      if (first) expect(c.end).toBeLessThanOrEqual(first.start);
    }
    // Never a chunk that starts with footnote definitions (they belong to the text before them),
    // except text before the first heading that opens with them; never one that ends on a page marker.
    if (!(i === 0 && c.section === null)) expect(/^\[\^[^\]]+\]:/.test(text.slice(c.start, c.end))).toBe(false);
    const lastLine = text.slice(text.lastIndexOf("\n", c.end - 1) + 1, c.end);
    expect(/^\[s\. [^\]]+\]$/.test(lastLine)).toBe(false);
    // No split inside a surrogate pair.
    const first = text.charCodeAt(c.start);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    // Pages.
    expect(c.pageFrom).toBe(pageOf(p, c.start));
    expect(c.pageTo).toBe(pageOf(p, c.end - 1));
  });
  // Every indexed body character is covered (gaps between chunks are whitespace only).
  for (const b of p.blocks) {
    if (b.kind !== "para" && b.kind !== "quote" && b.kind !== "table" && b.kind !== "fndefs") continue;
    const indexed = b.section < 0 || p.sections[b.section].indexed;
    const overlapping = d.chunks.filter((c) => c.start < b.end && c.end > b.start);
    if (!indexed) {
      expect(overlapping).toEqual([]);
      continue;
    }
    let at = b.start;
    for (const c of overlapping) {
      expect(text.slice(at, Math.max(at, c.start)).trim()).toBe("");
      at = Math.max(at, c.end);
    }
    expect(text.slice(at, Math.max(at, b.end)).trim()).toBe("");
  }
  // Every definition sits in the chunk of its reference (when kept together by the rules).
  for (const fn of p.footnotes) {
    if (fn.refAt === null || fn.defStart - fn.refAt > MAX_GLUE || headingBetween(p, fn.refAt, fn.defStart)) continue;
    const c = chunkAt(d, fn.refAt);
    if (!c) continue; // reference in a non-indexed section
    expect(fn.defStart).toBeGreaterThanOrEqual(c.start);
    expect(fn.defEnd).toBeLessThanOrEqual(c.end);
  }
}

/** Deterministic PRNG (mulberry32). */
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

const WORDS = [
  "odpovědnost", "škoda", "smlouva", "povinnost", "soud", "dlužník", "věřitel", "náhrada", "porušení", "újma",
  "vznik", "zavinění", "předpoklad", "ustanovení", "judikatura", "výklad", "zákon", "právní", "jednání", "plnění",
];

/** A sentence of `words` words: capital first letter, a period at the end. */
function sentence(r: () => number, words = 12): string {
  const ws = Array.from({ length: words }, () => WORDS[Math.floor(r() * WORDS.length)]);
  ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
  return `${ws.join(" ")}.`;
}

function paragraph(r: () => number, chars: number): string {
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const s = sentence(r, 6 + Math.floor(r() * 12));
    out.push(s);
    n += s.length + 1;
  }
  return out.join(" ");
}

/**
 * A synthetic commentary: parts, §§ with statute wording, subsections with
 * m. č. paragraphs, footnotes (definitions after the citing paragraph, also
 * across a page-marker line), inline page breaks and a few oversized
 * paragraphs.
 */
function syntheticCommentary(seed: number, sections = 12): string {
  const r = rng(seed);
  const lines: string[] = [];
  let page = 100;
  let chars = 0;
  let fn = 0;
  const pageLine = () => {
    lines.push(`[s. ${++page}]`, "");
    chars = 0;
  };
  pageLine();
  lines.push("# ČÁST ČTVRTÁ", "", "## HLAVA III", "");
  for (let s = 0; s < sections; s++) {
    lines.push(`### § ${2900 + s} [Nadpis ${s}]`, "", `> (1) ${sentence(r)}`, "");
    let mn = 0;
    for (let sub = 0; sub < 1 + Math.floor(r() * 3); sub++) {
      lines.push(`#### ${["I", "II", "III"][sub]}. Oddíl`, "");
      for (let p = 0; p < 2 + Math.floor(r() * 6); p++) {
        const big = r() < 0.08;
        let text = paragraph(r, big ? 3000 + Math.floor(r() * 4000) : 200 + Math.floor(r() * 1100));
        const withMn = r() < 0.6;
        const refs: number[] = [];
        if (r() < 0.5) {
          const at = text.indexOf(" ", Math.floor(text.length * r()));
          if (at > 0) {
            refs.push(++fn);
            text = `${text.slice(0, at)}[^${fn}]${text.slice(at)}`;
          }
        }
        if (!big && r() < 0.15) {
          // Inline page break inside the paragraph.
          const at = text.indexOf(" ", Math.floor(text.length / 2));
          if (at > 0) text = `${text.slice(0, at)} [s. ${++page}]${text.slice(at)}`;
        }
        lines.push(`${withMn ? `[m. č. ${++mn}] ` : ""}${text}`, "");
        chars += text.length;
        if (refs.length && r() < 0.3) {
          // The paragraph runs on over a page-marker line; its definitions follow the continuation.
          pageLine();
          lines.push(paragraph(r, 300), "");
        }
        for (const n of refs) lines.push(`[^${n}]: Srov. rozsudek NS sp. zn. ${20 + n} Cdo ${1000 + n}/2019, ${sentence(r, 5)}`);
        if (refs.length) lines.push("");
        if (chars > 3200) pageLine();
      }
    }
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────── fixtures

const COMMENTARY = [
  "[s. 1245]",
  "",
  "# ČÁST ČTVRTÁ",
  "",
  "## § 2913 [Porušení smluvní povinnosti]",
  "",
  "> (1) Poruší-li strana povinnost ze smlouvy, nahradí škodu z toho vzniklou druhé straně.",
  "",
  "### I. Předpoklady odpovědnosti",
  "",
  "[m. č. 1] Ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti[^1] a odkazuje na § 2910.",
  "",
  "[^1]: Srov. rozsudek Nejvyššího soudu ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019.",
  "",
  "[m. č. 2] Druhý odstavec rozebírá liberaci [s. 1246] a vyšší moc.",
  "",
  "## § 2914",
  "",
  "[m. č. 1] Jiný paragraf cituje § 2913 OSŘ.",
].join("\n");

// ─────────────────────────────────────────────────────────────── deriveIndex

describe("deriveIndex — sections, weights and keys", () => {
  const d = derive(COMMENTARY, "komentar", "zak:89/2012");
  const { chunks } = d.derived;
  const sec = (key: string) => d.parsed.sections.findIndex((s) => s.key === key || s.heading.startsWith(key));

  it("gives every section with text its own chunks, and a heading-only section one chunk", () => {
    expect(chunks.map((c) => d.parsed.sections[c.section!].heading)).toEqual([
      "ČÁST ČTVRTÁ",
      "§ 2913 [Porušení smluvní povinnosti]",
      "I. Předpoklady odpovědnosti",
      "§ 2914",
    ]);
    expect(textOf(d, chunks[0])).toBe("# ČÁST ČTVRTÁ");
    expect(textOf(d, chunks[1]).startsWith("## § 2913")).toBe(true);
    expect(textOf(d, chunks[2]).endsWith("vyšší moc.")).toBe(true);
  });

  it("weights: own heading A, parent heading B, body C, footnotes and commentary quotes D", () => {
    const sub = chunks[2].tsv;
    expect(weightsOf(sub, "predpoklad")).toBe("A"); // own heading
    expect(weightsOf(sub, "porusen")).toBe("BC"); // parent heading + body ("porušením")
    expect(weightsOf(sub, "2913")).toBe("AB"); // "§ 2913" of the enclosing § at A, parent heading B
    expect(weightsOf(sub, "ustanoven")).toBe("C");
    expect(weightsOf(sub, "cdo")).toBe("D");
    expect(weightsOf(sub, "1234")).toBe("D");
    const par = chunks[1].tsv;
    expect(weightsOf(par, "2913")).toBe("A");
    expect(weightsOf(par, "cast")).toBe("B");
    expect(weightsOf(par, "vznikl")).toBe("D"); // statute wording in a commentary
  });

  it("indexes a quote as body outside a commentary", () => {
    const book = derive(COMMENTARY, "kniha");
    expect(weightsOf(book.derived.chunks[1].tsv, "vznikl")).toBe("C");
  });

  it("does not index markup: refs, page markers and m. č. prefixes leave no lexemes", () => {
    const lexemes = weights(chunks[2].tsv);
    expect(lexemes.has("1246")).toBe(false); // [s. 1246]
    expect(lexemes.has("1")).toBe(false); // [^1] and [m. č. 1]
    expect(lexemes.has("m")).toBe(false);
  });

  it("ident keys: sec: of the enclosing § first, then the text's keys with the commented act", () => {
    expect(chunks[0].identKeys).toEqual([]); // ČÁST: no § around it
    expect(chunks[1].identKeys).toEqual(["sec:par:2913", "par:2913", "parz:89/2012/2913"]);
    expect(chunks[2].identKeys[0]).toBe("sec:par:2913");
    expect(chunks[2].identKeys).toEqual(expect.arrayContaining(["par:2910", "parz:89/2012/2910", "sz:25cdo1234-2019"]));
    // An act named after the § wins over the commented act.
    expect(chunks[3].identKeys).toEqual(["sec:par:2914", "par:2914", "parz:89/2012/2914", "par:2913", "parz:99/1963/2913"]);
  });

  it("without a commented act a bare § gets no parz: key", () => {
    const plain = derive(COMMENTARY, "komentar", null);
    expect(plain.derived.chunks[2].identKeys).toContain("par:2910");
    expect(plain.derived.chunks[2].identKeys.some((k) => k.startsWith("parz:89/2012/"))).toBe(false);
  });

  it("anchors, pages and section indexes", () => {
    expect(chunks[0]).toMatchObject({ anchorFrom: null, anchorTo: null, pageFrom: 1, pageTo: 1, section: sec("ČÁST") });
    expect(chunks[2]).toMatchObject({ anchorFrom: "1", anchorTo: "2", pageFrom: 1, pageTo: 2, section: sec("I. Před") });
    expect(chunks[3]).toMatchObject({ anchorFrom: "1", anchorTo: "1", pageFrom: 2, pageTo: 2, section: sec("par:2914") });
  });

  it("document keys and the § range of a commentary", () => {
    expect(d.derived.sectionRange).toBe("§ 2913–2914");
    expect(d.derived.docIdentKeys).toEqual(expect.arrayContaining(["sz:25cdo1234-2019", "sec:par:2913", "sec:par:2914"]));
    // Keys in two chunks (§ 2913 is cited in § 2914) rank first; sec: keys come last.
    expect(d.derived.docIdentKeys.slice(0, 2)).toEqual(["par:2913", "parz:89/2012/2913"]);
    expect(d.derived.docIdentKeys.slice(-2)).toEqual(["sec:par:2913", "sec:par:2914"]);
  });

  it("outside a commentary: no sec: keys at document level and no § range", () => {
    const book = derive(COMMENTARY, "kniha").derived;
    expect(book.sectionRange).toBeNull();
    expect(book.docIdentKeys.some((k) => k.startsWith("sec:"))).toBe(false);
    expect(book.chunks[2].identKeys[0]).toBe("sec:par:2913"); // chunk-level sec: keys stay
    expect(deriveIndex(d.parsed, { docType: null }).sectionRange).toBeNull();
  });

  it("is deterministic", () => {
    expect(deriveIndex(d.parsed, { docType: "komentar", commentedAct: "zak:89/2012" })).toEqual(d.derived);
  });
});

describe("deriveIndex — section kinds", () => {
  it("skips toc and index sections, subsections included", () => {
    const d = derive(
      [
        "# Obsah",
        "",
        "§ 2913 Porušení smluvní povinnosti ........ 1245",
        "",
        "## Část první",
        "",
        "Řádek obsahu.",
        "",
        "# Kapitola 1",
        "",
        "Text kapitoly o náhradě škody.",
        "",
        "# Věcný rejstřík",
        "",
        "škoda 12, 45",
      ].join("\n"),
    );
    expect(d.derived.chunks).toHaveLength(1);
    expect(textOf(d, d.derived.chunks[0])).toBe("# Kapitola 1\n\nText kapitoly o náhradě škody.");
  });

  it("indexes abbreviation and bibliography sections (and their subsections) at weight D only", () => {
    const d = derive(
      [
        "# Seznam zkratek",
        "",
        "o. z. zákon č. 89/2012 Sb., občanský zákoník",
        "",
        "# Literatura",
        "",
        "## Monografie",
        "",
        "MELZER, F. Odpovědnost za škodu. Praha: C. H. Beck, 2019.",
        "",
        "# Kapitola 1",
        "",
        "Odpovědnost.",
      ].join("\n"),
    );
    const [abbrev, biblio, mono, body] = d.derived.chunks;
    for (const c of [abbrev, biblio, mono]) expect(new Set([...weights(c.tsv).values()].flat())).toEqual(new Set(["D"]));
    expect(abbrev.identKeys).toContain("zak:89/2012");
    expect(weightsOf(mono.tsv, "odpovednost")).toBe("D");
    expect(weightsOf(body.tsv, "odpovednost")).toBe("C");
    expect(weightsOf(body.tsv, "kapitol")).toBe("A");
  });

  it("text before the first heading is its own section-less chunk without heading weights", () => {
    const d = derive("Úvodní text bez nadpisu.\n\n# Kapitola 1\n\nText.");
    const [front, ch] = d.derived.chunks;
    expect(front).toMatchObject({ section: null, identKeys: [] });
    expect(weightsOf(front.tsv, "uvodn")).toBe("C");
    expect(ch.section).toBe(0);
  });

  it("článek sections give sec:cl: keys and the § key text of subsections", () => {
    const d = derive("# Čl. III\n\n## Odstavec 2\n\nKupující zaplatí [●] Kč.", "vzor");
    expect(d.derived.chunks.map((c) => c.identKeys[0])).toEqual(["sec:cl:III", "sec:cl:III"]);
    expect(weightsOf(d.derived.chunks[1].tsv, "iii")).toBe("AB");
  });

  it("unpaged documents have null pages", () => {
    const d = derive("# § 1\n\nText.\n\n# § 2\n\nDalší.", "komentar");
    expect(d.derived.chunks.every((c) => c.pageFrom === null && c.pageTo === null)).toBe(true);
    expect(d.derived.sectionRange).toBe("§ 1–2");
  });

  it("empty and marker-only documents have no chunks", () => {
    for (const dmd of ["", "\n\n", "[s. 1]\n\n[s. 2]\n"]) {
      const d = derive(dmd, "komentar");
      expect(d.derived).toEqual({ chunks: [], docIdentKeys: [], sectionRange: null });
    }
  });
});

describe("deriveIndex — chunk sizes and split points", () => {
  const para = (seed: number, chars: number) => paragraph(rng(seed), chars);

  it("keeps a section whose body fits in the max in one chunk", () => {
    const body = [para(1, 1100), para(2, 1100)];
    const d = derive(`# Kapitola\n\n${body.join("\n\n")}`);
    expect(d.derived.chunks).toHaveLength(1);
  });

  it("prefers to split before an m. č. paragraph", () => {
    const sizes = [500, 500, 500, 500, 500, 500];
    const withMn = sizes.map((n, i) => `${i === 2 || i === 5 ? `[m. č. ${i}] ` : ""}${para(10 + i, n)}`);
    const d = derive(`# § 1\n\n${withMn.join("\n\n")}`);
    expect(d.derived.chunks.length).toBeGreaterThan(1);
    expect(textOf(d, d.derived.chunks[1]).startsWith("[m. č. 2]")).toBe(true);
    // Without the m. č. the same text splits nearer the target.
    const plain = derive(`# § 1\n\n${sizes.map((n, i) => para(10 + i, n)).join("\n\n")}`);
    expect(textOf(plain, plain.derived.chunks[1]).startsWith(para(13, 500))).toBe(true);
  });

  it("splits at paragraph ends near the target, within [min, max] body chars", () => {
    const paras = Array.from({ length: 12 }, (_, i) => para(100 + i, 300 + ((i * 137) % 700)));
    const d = derive(`# Kapitola\n\n${paras.join("\n\n")}`);
    const ends = new Set(d.parsed.blocks.map((b) => b.end));
    for (const c of d.derived.chunks) {
      expect(ends.has(c.end)).toBe(true);
      expect(bodyOf(d.parsed, c)).toBeLessThanOrEqual(CHUNK_MAX);
    }
    for (const c of d.derived.chunks.slice(0, -1)) expect(bodyOf(d.parsed, c)).toBeGreaterThanOrEqual(CHUNK_MIN);
    const avg = d.derived.chunks.reduce((s, c) => s + bodyOf(d.parsed, c), 0) / d.derived.chunks.length;
    expect(Math.abs(avg - CHUNK_TARGET)).toBeLessThan(600);
  });

  it("splits an oversized paragraph at sentence ends", () => {
    const d = derive(`# Kapitola\n\n${para(7, 7000)}`);
    const { chunks } = d.derived;
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(bodyOf(d.parsed, c)).toBeLessThanOrEqual(CHUNK_MAX);
    for (const c of chunks.slice(0, -1)) expect(textOf(d, c).endsWith(".")).toBe(true);
    for (const c of chunks.slice(1)) expect(/^\p{Lu}/u.test(textOf(d, c))).toBe(true);
  });

  it("never splits after an abbreviation, an initial, a Roman numeral or an ordinal", () => {
    const traps = [
      "Podle § 2913 odst. 2 písm. a) o. z. Soud rozhodl.",
      "Jde o zákon č. 89/2012 Sb. Platí dále.",
      "Viz nález sp. zn. II. ÚS 1234/20 a usnesení IV. ÚS 12/05.",
      "Rozsudek ze dne 12. 3. 2019 Soud potvrdil.",
      "Srov. J. Novák, tzv. Liberace atd. Konec.",
    ].join(" ");
    const text = Array.from({ length: 40 }, () => traps).join(" ");
    const d = derive(`# Kapitola\n\n${text}`);
    expect(d.derived.chunks.length).toBeGreaterThan(1);
    for (const c of d.derived.chunks.slice(0, -1)) {
      const tail = textOf(d, c).slice(-12);
      expect(/(?:odst|písm|z|Sb|II|IV|12|3|J|tzv|atd|Srov)\.$/u.test(tail), tail).toBe(false);
    }
  });

  it("falls back to spaces, then to hard cuts, without splitting surrogate pairs", () => {
    const words = derive(`# K\n\n${"slovo ".repeat(1500).trim()}`);
    for (const c of words.derived.chunks) {
      expect(bodyOf(words.parsed, c)).toBeLessThanOrEqual(CHUNK_MAX);
      expect(textOf(words, c).startsWith(" ")).toBe(false);
    }
    const blob = derive(`# K\n\n${"x".repeat(9000)}`);
    expect(blob.derived.chunks.length).toBe(4);
    const emoji = derive(`# K\n\n${"😀".repeat(4000)}`);
    expect(emoji.derived.chunks.length).toBeGreaterThan(3); // invariants check the surrogate pairs
  });

  it("does not cut inside a bracketed marker when falling back to spaces", () => {
    const text = Array.from({ length: 700 }, (_, i) => `slovo [s. ${i + 2}] dal`).join(" ");
    const d = derive(`[s. 1]\n\n# K\n\n${text}`);
    for (const c of d.derived.chunks) {
      expect(/^\d+\]/.test(textOf(d, c))).toBe(false);
      expect(/\[s\.$/.test(textOf(d, c))).toBe(false);
    }
  });
});

describe("deriveIndex — footnotes stay with their paragraph", () => {
  it("never splits between a reference and its definition, even across a page marker", () => {
    const r = rng(3);
    const a = `${paragraph(r, 1300)} konec[^1] věty.`;
    const b = paragraph(r, 1300);
    const d = derive(`[s. 10]\n\n# K\n\n${a}\n\n[s. 11]\n\n${b}\n\n[^1]: Srov. 25 Cdo 1234/2019.`);
    expect(d.derived.chunks).toHaveLength(1);
    expect(d.derived.chunks[0]).toMatchObject({ pageFrom: 1, pageTo: 2 });
    expect(d.derived.chunks[0].identKeys).toContain("sz:25cdo1234-2019");
  });

  it("keeps the definitions block with the paragraph before it, not the next chunk", () => {
    const r = rng(4);
    const paras = Array.from({ length: 6 }, (_, i) => `${paragraph(r, 700)}[^${i + 1}]`);
    const dmd = paras.map((p, i) => `${p}\n\n[^${i + 1}]: Poznámka číslo ${i + 1}.`).join("\n\n");
    const d = derive(`# K\n\n${dmd}`);
    expect(d.derived.chunks.length).toBeGreaterThan(1);
    for (const c of d.derived.chunks) expect(textOf(d, c).startsWith("[^")).toBe(false);
    // Sizes count the body only: the notes do not push chunks apart.
    expect(d.derived.chunks.length).toBe(3);
  });

  it("does not glue a mis-bound definition that lies far from its reference", () => {
    const r = rng(5);
    const paras = Array.from({ length: 14 }, () => paragraph(r, 900));
    paras[0] += "[^7]";
    const d = derive(`# K\n\n${paras.join("\n\n")}\n\n[^7]: Pozdní poznámka.`);
    expect(d.derived.chunks.length).toBeGreaterThan(3);
    const fn = d.parsed.footnotes[0];
    expect(fn.defStart - fn.refAt!).toBeGreaterThan(MAX_GLUE);
    expect(chunkAt(d.derived, fn.refAt!)).not.toBe(chunkAt(d.derived, fn.defStart));
  });

  it("keeps a sentence-split paragraph's notes with the piece holding the reference", () => {
    const r = rng(6);
    const long = `${paragraph(r, 2000)} Tady je odkaz[^1] uprostřed. ${paragraph(r, 2000)}`;
    const d = derive(`# K\n\n${long}\n\n[^1]: Srov. 25 Cdo 1234/2019.`);
    const c = chunkAt(d.derived, d.parsed.footnotes[0].refAt!)!;
    expect(c.identKeys).toContain("sz:25cdo1234-2019");
  });

  it("indexes a dangling definition with the paragraph before it", () => {
    const d = derive("# K\n\nText bez odkazu.\n\n[^9]: Osiřelá poznámka 25 Cdo 1/2019.");
    expect(d.derived.chunks).toHaveLength(1);
    expect(weightsOf(d.derived.chunks[0].tsv, "osirel")).toBe("D");
  });

  it("a heading with a footnote reference keeps its definition in its first chunk", () => {
    const d = derive("# Kapitola[^1]\n\n[^1]: Poznámka k nadpisu.\n\nText kapitoly.");
    expect(d.derived.chunks).toHaveLength(1);
    expect(weightsOf(d.derived.chunks[0].tsv, "poznamk")).toBe("D");
  });
});

describe("deriveIndex — a synthetic commentary", () => {
  it.each([1, 2, 3, 4])("seed %i: invariants hold and chunks stay bounded", (seed) => {
    const d = derive(syntheticCommentary(seed, 15), "komentar", "zak:89/2012");
    const { chunks } = d.derived;
    expect(chunks.length).toBeGreaterThan(20);
    for (const c of chunks) {
      // Oversized only when a reference glues two paragraphs (≤ 2 × max here).
      expect(bodyOf(d.parsed, c)).toBeLessThanOrEqual(2 * CHUNK_MAX);
      const s = d.parsed.sections[c.section!];
      if (s.kind === "par" || s.parent !== null) {
        const enclosing = s.kind === "par" ? s : d.parsed.sections[s.parent!];
        if (enclosing.kind === "par") expect(c.identKeys[0]).toBe(`sec:${enclosing.key}`);
      }
    }
    const within = chunks.filter((c) => bodyOf(d.parsed, c) <= CHUNK_MAX).length;
    expect(within / chunks.length).toBeGreaterThan(0.9);
    expect(d.derived.sectionRange).toBe("§ 2900–2914");
    expect(d.derived.docIdentKeys.filter((k) => k.startsWith("sec:"))).toHaveLength(15);
  });

  it("caps document keys from chunks at MAX_DOC_IDENT_KEYS, most frequent first", () => {
    const paras = Array.from({ length: 700 }, (_, i) => `Rozhodnutí ${i % 90} Cdo ${i + 1}/2019 a 99 Cdo 1/2020.`);
    const d = derive(`# K\n\n${paras.join("\n\n")}`);
    expect(d.derived.docIdentKeys).toHaveLength(MAX_DOC_IDENT_KEYS);
    expect(d.derived.docIdentKeys[0]).toBe("sz:99cdo1-2020");
  });
});

describe("keyDesignator / sectionRangeOf", () => {
  it("formats § and článek keys", () => {
    expect(keyDesignator("par:2913a")).toBe("§ 2913a");
    expect(keyDesignator("cl:III")).toBe("čl. III");
    expect(keyDesignator("part:hlava-iii")).toBeNull();
    expect(keyDesignator("")).toBeNull();
  });

  it("uses key numbers, ignores non-indexed and non-§ sections", () => {
    const s = (key: string, keyNum: number | null, indexed = true, kind: DmdSection["kind"] = "par"): DmdSection => ({
      ord: 0, parent: null, level: 2, kind, key, keyNum, heading: key, author: null, start: 0, end: 1, pageFrom: 0, pageTo: 0, indexed,
    });
    expect(sectionRangeOf([s("par:2913a", 2913.01), s("par:2894", 2894), s("par:2913", 2913)])).toBe("§ 2894–2913a");
    expect(sectionRangeOf([s("par:5", 5), s("par:1", 1, false), s("cl:9", 9, true, "cl")])).toBe("§ 5");
    expect(sectionRangeOf([])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────── metadata

describe("buildMetaTsv", () => {
  const sections = parseDmd("# Obsah\n\nx\n\n# Část první\n\n## Hlava I Odpovědnost\n\n### § 2913 Detail\n\ntext").sections;

  it("weights the metadata fields and indexes the outline (levels ≤ 2, indexed) at D", () => {
    const tsv = buildMetaTsv(
      {
        title: "Občanský zákoník",
        subtitle: "Komentář",
        authors: ["Petrov, Jan"],
        editors: ["Beran, Karel"],
        court: "Nejvyšší soud",
        case_number: "25 Cdo 1234/2019",
        container_title: "Právní rozhledy",
        keywords: ["náhrada škody"],
        summary: "Výklad",
        publisher: "C. H. Beck",
      },
      sections,
    );
    expect(weightsOf(tsv, "obcansk")).toBe("A");
    expect(weightsOf(tsv, "komentar")).toBe("A");
    expect(weightsOf(tsv, "petr")).toBe("B");
    expect(weightsOf(tsv, "beran")).toBe("B");
    expect(weightsOf(tsv, "cdo")).toBe("B");
    expect(weightsOf(tsv, "rozhled")).toBe("B");
    expect(weightsOf(tsv, "nahrad")).toBe("C");
    expect(weightsOf(tsv, "beck")).toBe("C");
    expect(weightsOf(tsv, "hlav")).toBe("D");
    expect(weightsOf(tsv, "obsah")).toBe(""); // toc not indexed
    expect(weightsOf(tsv, "detail")).toBe(""); // level 3
  });

  it("caps the outline at META_HEADING_CHARS whole headings", () => {
    const many = parseDmd(Array.from({ length: 400 }, (_, i) => `# Kapitola ${i} slovo${i}`).join("\n\n")).sections;
    const tsv = buildMetaTsv({ title: "T" }, many);
    const kept = [...weights(tsv).keys()].filter((l) => l.startsWith("slov")).length;
    const size = (n: number) => many.slice(0, n).reduce((sum, s) => sum + s.heading.length + 1, 0);
    expect(kept).toBeGreaterThan(100);
    expect(size(kept)).toBeLessThanOrEqual(META_HEADING_CHARS + 1);
    expect(size(kept + 1)).toBeGreaterThan(META_HEADING_CHARS);
    expect(weights(tsv).has(`slovo${kept - 1}`)).toBe(true);
  });

  it("tolerates missing and malformed fields", () => {
    expect(buildMetaTsv({}, [])).toBe("");
    expect(buildMetaTsv({ authors: null as never, keywords: [1 as never, "a b"] }, [])).toBe("'a':1C 'b':2C");
  });
});

describe("metaIdentKeys", () => {
  it("normalizes identifiers like the text extractor does", () => {
    expect(
      metaIdentKeys({
        isbn: ["978-80-7400-785-9", "0-306-40615-2", "978-80-7400-785-0"],
        doi: "10.1000/XYZ.123",
        ecli: "ECLI:CZ:NS:2020:25.CDO.1234.2019.1",
        case_number: "25 Cdo 1234/19",
        commented_act: "zak:89/2012",
      }),
    ).toEqual([
      "isbn:9788074007859",
      "isbn:9780306406157",
      "doi:10.1000/xyz.123",
      "ecli:cz:ns:2020:25.cdo.1234.2019.1",
      "sz:25cdo1234-2019",
      "zak:89/2012",
    ]);
  });

  it("drops EU acts, malformed values and empty metadata", () => {
    expect(metaIdentKeys({})).toEqual([]);
    expect(metaIdentKeys({ commented_act: "eu:32016R0679", doi: "  ", ecli: "nic", case_number: "bez čísla", isbn: [7 as never] })).toEqual([]);
    expect(metaIdentKeys({ commented_act: "zak:89/2012'); DROP TABLE x;--" })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── Postgres

describe("tsvector literals on Postgres (PGlite)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  const matches = async (tsv: string, q: string) =>
    (await t.owner.query<{ v: boolean }>("SELECT $1::tsvector @@ to_tsquery('simple', $2) AS v", [tsv, q])).rows[0].v;

  it("adversarial text still yields valid literals", () => {
    derive(
      [
        "# O'Neil \\ \"uvozovky\" ' '' \\\\ ;--",
        "",
        "Robert'); DROP TABLE chunks;-- a \\[s. 5] \\[^1] \\# ‘’ `x` :* & | ! <-> 'a':1A",
        "",
        `${"ž".repeat(3000)} Text${Array.from({ length: 10 }, (_, i) => `[^${i + 1}]`).join(" ")}.`,
        "",
        // 10 definitions of ~4,500 tokens: one chunk far beyond 16,383 positions.
        ...Array.from({ length: 10 }, (_, i) => `[^${i + 1}]: ${Array.from({ length: 4500 }, (_, j) => `x${j % 700}`).join(" ").slice(0, 9990)}`),
      ].join("\n"),
    );
  });

  it("every literal derived in this file parses and round-trips", async () => {
    const all = produced.flatMap((p) => p.derived.chunks.map((c) => c.tsv));
    all.push(buildMetaTsv({ title: "O'Neil \\ x" }, []));
    expect(all.length).toBeGreaterThan(100);
    for (const tsv of all) {
      // Same number of lexemes after Postgres parsed it: nothing merged, split or dropped.
      const { rows } = await t.owner.query<{ n: number }>("SELECT length($1::tsvector) AS n", [tsv]);
      expect(rows[0].n).toBe(weights(tsv).size);
    }
    // The capped positions really are at the limit.
    const huge = all.reduce((a, b) => (b.length > a.length ? b : a));
    expect((await t.owner.query<{ v: boolean }>("SELECT $1::tsvector::text LIKE '%16383%' AS v", [huge])).rows[0].v).toBe(true);
  });

  it("weight-restricted queries separate body, footnotes and headings", async () => {
    const d = derive(COMMENTARY, "komentar", "zak:89/2012");
    const sub = d.derived.chunks[2].tsv;
    const q = (s: string, weights?: string) => buildTsQuery(s, { weights }).and!;
    expect(await matches(sub, q("odpovědnost 25 Cdo 1234/2019"))).toBe(true); // body + footnote, one chunk
    expect(await matches(sub, q("Cdo", "D"))).toBe(true);
    expect(await matches(sub, q("Cdo", "ABC"))).toBe(false);
    expect(await matches(sub, q("odpovednost", "D"))).toBe(false); // body word ("odpovědnosti" in the heading is A)
    expect(await matches(sub, q("predpoklady", "A"))).toBe(true);
    expect(await matches(d.derived.chunks[1].tsv, q("vzniklou", "C"))).toBe(false); // quote in a commentary is D
  });
});
