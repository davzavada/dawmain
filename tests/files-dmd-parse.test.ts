import { describe, expect, it } from "vitest";
import { classifyLine, parseDmd, romanValue, sectionKeyOf, stripMarkup, unescapeDmd, MAX_PROBLEMS } from "@/src/files/dmd/parse";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { DMD_LIMITS, DmdLimitError, PAGE_FLAGS, type ParsedDoc } from "@/src/files/dmd/types";

/**
 * The strict DMD parser: every other module (ingest, index, reading,
 * pinpoints, billing) consumes its output, so these pin the grammar, the
 * footnote binding, the section tree, the safety caps, linear time and the
 * never-throw-on-structure guarantee.
 */

const COMMENTARY = [
  "[s. 1245]",
  "",
  "## § 2913 [Porušení smluvní povinnosti]",
  "",
  "> (1) Poruší-li strana povinnost ze smlouvy, nahradí škodu z toho vzniklou.",
  "",
  "### I. Obecně",
  "",
  "Zpracoval: Filip Melzer",
  "",
  "[m. č. 1] Ustanovení upravuje odpovědnost[^1] a to i tehdy, je-li [s. 1246] škoda způsobena[^2] jinak.",
  "",
  "[^1]: Srov. rozsudek NS ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019.",
  "[^2]: MELZER, F. Tamtéž.",
  "",
  "[m. č. 2] Druhý odstavec.",
  "",
  "## § 2914",
  "",
  "[m. č. 1] Jiný paragraf.",
].join("\n");

function at(doc: ParsedDoc, needle: string, from = 0): number {
  const i = doc.text.indexOf(needle, from);
  if (i === -1) throw new Error(`missing ${needle}`);
  return i;
}

describe("classifyLine", () => {
  const cls = (line: string) => classifyLine(line, 0, line.length);

  it("recognises every line form of the grammar", () => {
    expect(cls("[s. 245]")).toMatchObject({ kind: "page", label: "245", contentStart: 8 });
    expect(cls("[s. xii]")).toMatchObject({ kind: "page", label: "xii" });
    expect(cls("## § 2913")).toMatchObject({ kind: "heading", level: 2, contentStart: 3 });
    expect(cls("[^12]: Text")).toMatchObject({ kind: "fndef", label: "12", contentStart: 7 });
    expect(cls("[^*]:")).toMatchObject({ kind: "fndef", label: "*", contentStart: 5 });
    expect(cls("> (1) Text")).toMatchObject({ kind: "quote", contentStart: 2 });
    expect(cls(">")).toMatchObject({ kind: "quote", contentStart: 1 });
    expect(cls("| a | b |")).toMatchObject({ kind: "table" });
    expect(cls("[m. č. 14] Text")).toMatchObject({ kind: "text", anchor: "14", contentStart: 11 });
    expect(cls("[m. č. 3a] Text")).toMatchObject({ anchor: "3a" });
    expect(cls("    pokračování")).toMatchObject({ kind: "text", indented: true, contentStart: 0 });
    expect(cls("   ")).toMatchObject({ kind: "blank" });
    expect(cls("")).toMatchObject({ kind: "blank" });
  });

  it("keeps near-misses as text", () => {
    expect(cls("[s. 245] text").kind).toBe("text"); // inline marker, not a page line
    expect(cls("[s. 12 345]").kind).toBe("text"); // label with a space
    expect(cls("[s. 1234567890123]").kind).toBe("text"); // label > 12 chars
    expect(cls("####### seven").kind).toBe("text");
    expect(cls("#hashtag").kind).toBe("text");
    expect(cls("# ").kind).toBe("text");
    expect(cls("[^12345]: too long label").kind).toBe("text");
    expect(cls("[^12]:x").kind).toBe("text");
    expect(cls(">>").kind).toBe("text");
    expect(cls(" ## indented").kind).toBe("text");
    expect(cls("[m. č. 14]Text").anchor).toBeNull();
  });

  it("treats a leading \\#, \\>, \\| as escaped text", () => {
    expect(cls("\\# not a heading")).toMatchObject({ kind: "text", contentStart: 1 });
    expect(cls("\\> not a quote")).toMatchObject({ kind: "text", contentStart: 1 });
    expect(cls("\\| not a table")).toMatchObject({ kind: "text", contentStart: 1 });
    expect(cls("\\x stays")).toMatchObject({ kind: "text", contentStart: 0 });
  });

  it("flags a heading over the length cap", () => {
    const line = `# ${"x".repeat(DMD_LIMITS.maxHeadingChars + 1)}`;
    expect(cls(line)).toMatchObject({ kind: "text", headingTooLong: true });
    expect(cls(`# ${"x".repeat(DMD_LIMITS.maxHeadingChars)}`).kind).toBe("heading");
  });
});

describe("sectionKeyOf", () => {
  it("derives § keys with sortable numbers", () => {
    expect(sectionKeyOf("§ 2913 [Porušení smluvní povinnosti]", 2)).toEqual({ kind: "par", key: "par:2913", keyNum: 2913 });
    expect(sectionKeyOf("§ 2913a", 2)).toEqual({ kind: "par", key: "par:2913a", keyNum: 2913.01 });
    expect(sectionKeyOf("§ 5B Něco", 3)).toEqual({ kind: "par", key: "par:5b", keyNum: 5.02 });
    expect(sectionKeyOf("§2913", 2).key).toBe("par:2913");
    expect(sectionKeyOf("§§ 2910 až 2912", 2).key).toBe("par:2910");
    expect(sectionKeyOf("§ 29134", 2).kind).toBe("sub"); // not a § designator
  });

  it("derives article keys (Roman upper-cased, Arabic as written)", () => {
    expect(sectionKeyOf("Čl. III", 2)).toEqual({ kind: "cl", key: "cl:III", keyNum: 3 });
    expect(sectionKeyOf("Článek 3", 2)).toEqual({ kind: "cl", key: "cl:3", keyNum: 3 });
    expect(sectionKeyOf("čl. iv.", 2)).toEqual({ kind: "cl", key: "cl:IV", keyNum: 4 });
    expect(sectionKeyOf("ČL. 10a Předmět", 2)).toEqual({ kind: "cl", key: "cl:10a", keyNum: 10.01 });
    expect(sectionKeyOf("Čl. mimo", 2).kind).toBe("sub");
  });

  it("derives part keys from ČÁST / HLAVA / DÍL / ODDÍL / Pododdíl", () => {
    expect(sectionKeyOf("ČÁST ČTVRTÁ Relativní majetková práva", 1)).toMatchObject({ kind: "part", key: "part:cast-ctvrta" });
    expect(sectionKeyOf("Hlava III Náhrada majetkové a nemajetkové újmy", 2)).toMatchObject({ kind: "part", key: "part:hlava-iii" });
    expect(sectionKeyOf("Díl 1.", 3).key).toBe("part:dil-1");
    expect(sectionKeyOf("Oddíl 2 Něco", 4).key).toBe("part:oddil-2");
    expect(sectionKeyOf("Pododdíl 1", 5).key).toBe("part:pododdil-1");
    expect(sectionKeyOf("HLAVA", 2).key).toBe("part:hlava");
    expect(sectionKeyOf("Hlavní zásady", 1).kind).toBe("chapter"); // not the word "hlava"
    expect(sectionKeyOf("Dílo a autor", 2).kind).toBe("sub");
  });

  it("collapses letter-spaced headings first", () => {
    expect(sectionKeyOf("Č Á S T  P R V N Í", 1).key).toBe("part:cast-prvni");
    expect(sectionKeyOf("H L A V A I I I", 2).key).toBe("part:hlava-iii");
    expect(sectionKeyOf("D Í L O", 2).kind).toBe("sub");
    expect(sectionKeyOf("O B S A H", 1).kind).toBe("toc");
  });

  it("derives chapters", () => {
    expect(sectionKeyOf("Kapitola 3", 1)).toEqual({ kind: "chapter", key: "ch:3", keyNum: null });
    expect(sectionKeyOf("Kapitola III. Odpovědnost", 1).key).toBe("ch:III");
    expect(sectionKeyOf("3. kapitola", 2).key).toBe("ch:3");
    expect(sectionKeyOf("Náhrada škody", 1)).toEqual({ kind: "chapter", key: null, keyNum: null });
    expect(sectionKeyOf("II. Předpoklady", 3)).toEqual({ kind: "sub", key: null, keyNum: null });
  });

  it("recognises the apparatus kinds without swallowing legal topics", () => {
    expect(sectionKeyOf("Obsah", 1).kind).toBe("toc");
    expect(sectionKeyOf("OBSAH", 2).kind).toBe("toc");
    expect(sectionKeyOf("Podrobný obsah", 1).kind).toBe("toc");
    expect(sectionKeyOf("Obsah smlouvy", 2).kind).toBe("sub");
    expect(sectionKeyOf("Věcný rejstřík", 1).kind).toBe("index");
    expect(sectionKeyOf("Rejstřík", 1).kind).toBe("index");
    expect(sectionKeyOf("Rejstřík trestů", 2).kind).toBe("sub");
    expect(sectionKeyOf("Seznam zkratek", 1).kind).toBe("abbrev");
    expect(sectionKeyOf("Seznam použitých zkratek", 1).kind).toBe("abbrev");
    expect(sectionKeyOf("Literatura", 3).kind).toBe("biblio");
    expect(sectionKeyOf("Literatura:", 3).kind).toBe("biblio");
    expect(sectionKeyOf("Seznam použité literatury", 1).kind).toBe("biblio");
    expect(sectionKeyOf("Bibliografie", 1).kind).toBe("biblio");
    expect(sectionKeyOf("Příloha č. 1", 2).kind).toBe("annex");
    expect(sectionKeyOf("Přílohy", 1).kind).toBe("annex");
    expect(sectionKeyOf("Předmluva k 2. vydání", 1).kind).toBe("front");
    expect(sectionKeyOf("Úvod k druhému vydání", 1).kind).toBe("front");
    expect(sectionKeyOf("Úvod", 1).kind).toBe("chapter");
  });

  it("ignores footnote refs and escapes in the heading", () => {
    expect(sectionKeyOf("§ 12[^1]", 2).key).toBe("par:12");
    expect(sectionKeyOf("Obsah [^a]", 1).kind).toBe("toc");
  });
});

describe("romanValue", () => {
  it("accepts only well-formed numerals", () => {
    expect(romanValue("XIV")).toBe(14);
    expect(romanValue("mcmxc")).toBe(1990);
    expect(romanValue("IIII")).toBeNull();
    expect(romanValue("IC")).toBeNull();
    expect(romanValue("abc")).toBeNull();
  });
});

describe("unescapeDmd", () => {
  it("removes exactly the grammar's escapes", () => {
    expect(unescapeDmd("a \\[s. 5] b \\[^1] c \\[m. č. 3] d")).toBe("a [s. 5] b [^1] c [m. č. 3] d");
    expect(unescapeDmd("\\# x\n\\> y\n\\| z")).toBe("# x\n> y\n| z");
    expect(unescapeDmd("a \\# b \\[x] c\\\\")).toBe("a \\# b \\[x] c\\\\");
  });
});

describe("parseDmd — pages", () => {
  it("builds pages from line markers and inline breaks", () => {
    const doc = parseDmd(COMMENTARY);
    expect(doc.paged).toBe(true);
    expect(doc.pages.map((p) => [p.ord, p.label])).toEqual([
      [1, "1245"],
      [2, "1246"],
    ]);
    expect(doc.pages[0].start).toBe(0);
    expect(doc.pages[1].start).toBe(at(doc, "[s. 1246]"));
    expect(doc.pages[0].end).toBe(doc.pages[1].start);
    expect(doc.pages[1].end).toBe(doc.text.length);
    expect(doc.stats.physicalPages).toBe(2);
  });

  it("an unpaged document has no pages and page 0 everywhere; markers are text + a problem", () => {
    const doc = parseDmd("Úvodní text [s. 5] dál.\n\n[s. 6]\n\n# Kapitola 1\n\nText[^1].\n\n[^1]: Pozn.");
    expect(doc.paged).toBe(false);
    expect(doc.pages).toEqual([]);
    expect(doc.blocks.every((b) => b.page === 0)).toBe(true);
    expect(doc.sections[0]).toMatchObject({ pageFrom: 0, pageTo: 0 });
    expect(doc.footnotes[0].page).toBe(0);
    expect(doc.problems.map((p) => p.code)).toContain("unpaged_start");
    expect(doc.blocks.find((b) => b.start === at(doc, "[s. 6]"))!.kind).toBe("para");
  });

  it("flags duplicate labels and bad labels but keeps going", () => {
    const doc = parseDmd("[s. 1]\n\nA\n\n[s. 1]\n\nB [s. 1/2] C\n\n[s. 3]\n\nD");
    expect(doc.pages.map((p) => p.label)).toEqual(["1", "1", "3"]);
    const codes = doc.problems.map((p) => p.code);
    expect(codes).toContain("duplicate_page_label");
    expect(codes).toContain("bad_page_label");
  });

  it("inline markers must stand between spaces", () => {
    const doc = parseDmd("[s. 1]\n\nslovo[s. 2] a slovo [s. 3]\n\nkonec [s. 4]");
    expect(doc.pages.map((p) => p.label)).toEqual(["1", "3", "4"]);
    expect(doc.problems.find((p) => p.code === "escaped_marker")?.at).toBe(at(doc, "[s. 2]"));
  });

  it("marks blank pages", () => {
    const doc = parseDmd("[s. 1]\n\nText\n\n[s. 2]\n\n[s. 3]\n\nText");
    expect(doc.pages.map((p) => p.flags & PAGE_FLAGS.BLANK)).toEqual([0, PAGE_FLAGS.BLANK, 0]);
  });

  it("a page that starts mid-paragraph has text", () => {
    const doc = parseDmd("[s. 1]\n\nA [s. 2] B");
    expect(doc.pages.map((p) => p.flags)).toEqual([0, 0]);
  });

  it("does not treat escaped or heading markers as page breaks", () => {
    const doc = parseDmd("[s. 1]\n\n\\[s. 2]\n\nx \\[s. 3] y\n\n# Nadpis [s. 4]");
    expect(doc.pages.map((p) => p.label)).toEqual(["1"]);
  });
});

describe("parseDmd — blocks", () => {
  it("splits blocks by kind with page, section and anchor", () => {
    const doc = parseDmd(COMMENTARY);
    const kinds = doc.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["page", "heading", "quote", "heading", "para", "para", "fndefs", "para", "heading", "para"]);
    const mn1 = doc.blocks[5];
    expect(mn1).toMatchObject({ kind: "para", anchor: "1", page: 1, section: 1 });
    expect(doc.blocks[6]).toMatchObject({ kind: "fndefs", page: 2 });
    expect(doc.blocks[7]).toMatchObject({ anchor: "2", page: 2 });
    expect(doc.blocks[1]).toMatchObject({ kind: "heading", level: 2, section: 0 });
    for (const b of doc.blocks) {
      expect(doc.text.slice(b.start, b.end)).not.toMatch(/^\n|\n$/);
    }
  });

  it("continues paragraphs, quotes and tables line by line; blank lines separate", () => {
    const doc = parseDmd("a\nb\n\nc\n> q1\n> q2\n| t |\n| u |\nd\n[m. č. 1] e\nf");
    const shape = doc.blocks.map((b) => [b.kind, doc.text.slice(b.start, b.end)]);
    expect(shape).toEqual([
      ["para", "a\nb"],
      ["para", "c"],
      ["quote", "> q1\n> q2"],
      ["table", "| t |\n| u |"],
      ["para", "d"],
      ["para", "[m. č. 1] e\nf"],
    ]);
  });

  it("keeps consecutive definitions (and their continuations) in one block", () => {
    const text = "Text[^1] a[^2].\n\n[^1]: Jedna\n    pokračuje.\n\n    Druhý odstavec poznámky.\n[^2]: Dvě\n\nDalší.";
    const doc = parseDmd(text);
    expect(doc.blocks.map((b) => b.kind)).toEqual(["para", "fndefs", "para"]);
    const [f1, f2] = doc.footnotes;
    expect(doc.text.slice(f1.defStart, f1.defEnd)).toBe("Jedna\n    pokračuje.\n\n    Druhý odstavec poznámky.");
    expect(doc.text.slice(f2.defStart, f2.defEnd)).toBe("Dvě");
  });

  it("an indented line without an open definition is ordinary text", () => {
    const doc = parseDmd("Text.\n\n    odsazený text");
    expect(doc.blocks.map((b) => b.kind)).toEqual(["para", "para"]);
    expect(doc.footnotes).toEqual([]);
  });
});

describe("parseDmd — footnotes", () => {
  it("binds definitions to their references", () => {
    const doc = parseDmd(COMMENTARY);
    expect(doc.footnotes).toHaveLength(2);
    const [f1, f2] = doc.footnotes;
    expect(f1).toMatchObject({ seq: 1, label: "1", kind: "f", page: 1, anchor: "1", section: 1 });
    expect(f1.refAt).toBe(at(doc, "[^1]"));
    expect(doc.text.slice(f1.defStart, f1.defEnd)).toBe("Srov. rozsudek NS ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019.");
    // the reference to note 2 sits after the inline page break
    expect(f2).toMatchObject({ seq: 2, page: 2, anchor: "1" });
    expect(doc.refs.map((r) => r.footnote)).toEqual([1, 2]);
    expect(doc.stats).toMatchObject({ footnotes: 2, danglingRefs: 0, danglingDefs: 0 });
  });

  it("binds restarting numbering to the nearest earlier unbound reference", () => {
    const text = [
      "[s. 1]",
      "",
      "A[^1] B[^2].",
      "",
      "[^1]: p1n1",
      "[^2]: p1n2",
      "",
      "[s. 2]",
      "",
      "C[^1] D[^1] E[^2].",
      "",
      "[^1]: p2n1a",
      "[^1]: p2n1b",
      "[^2]: p2n2",
    ].join("\n");
    const doc = parseDmd(text);
    const body = (i: number) => doc.text.slice(doc.footnotes[i].defStart, doc.footnotes[i].defEnd);
    const refText = (i: number) => doc.text.slice(doc.footnotes[i].refAt! - 1, doc.footnotes[i].refAt!);
    expect(doc.footnotes.map((f) => f.page)).toEqual([1, 1, 2, 2, 2]);
    expect([body(0), refText(0)]).toEqual(["p1n1", "A"]);
    expect([body(1), refText(1)]).toEqual(["p1n2", "B"]);
    // nearest earlier unbound "1" is D's, then C's
    expect([body(2), refText(2)]).toEqual(["p2n1a", "D"]);
    expect([body(3), refText(3)]).toEqual(["p2n1b", "C"]);
    expect([body(4), refText(4)]).toEqual(["p2n2", "E"]);
    expect(doc.stats.danglingRefs).toBe(0);
  });

  it("reports dangling references and definitions", () => {
    const doc = parseDmd("[s. 7]\n\nText[^3] a[^4].\n\n[^4]: čtyři\n[^9]: devět");
    expect(doc.stats).toMatchObject({ danglingRefs: 1, danglingDefs: 1 });
    const dangling = doc.footnotes.find((f) => f.label === "9")!;
    expect(dangling).toMatchObject({ refAt: null, page: 1, anchor: null });
    expect(doc.refs.find((r) => r.label === "3")!.footnote).toBeNull();
    const codes = doc.problems.map((p) => p.code);
    expect(codes).toContain("dangling_ref");
    expect(codes).toContain("dangling_def");
  });

  it("a definition never binds to a later reference", () => {
    const doc = parseDmd("[^1]: napřed\n\nText[^1].");
    expect(doc.footnotes[0].refAt).toBeNull();
    expect(doc.refs[0].footnote).toBeNull();
  });

  it("accepts every label form and ignores escaped refs", () => {
    const doc = parseDmd("a[^12] b[^ab] c[^***] d[^††] e\\[^5]\n\n[^12]: x\n[^ab]: y\n[^***]: z\n[^††]: w");
    expect(doc.refs.map((r) => r.label)).toEqual(["12", "ab", "***", "††"]);
    expect(doc.stats.danglingRefs).toBe(0);
  });

  it("recognises DOCX endnotes (Roman letter labels) as kind e", () => {
    const doc = parseDmd("A[^1] B[^i] C[^ii].\n\n[^1]: pozn.\n[^i]: vysv. 1\n[^ii]: vysv. 2");
    expect(doc.footnotes.map((f) => f.kind)).toEqual(["f", "e", "e"]);
    const letters = parseDmd("A[^a] B[^b] C[^i].\n\n[^a]: x\n[^b]: y\n[^i]: z");
    expect(letters.footnotes.map((f) => f.kind)).toEqual(["f", "f", "f"]);
  });

  it("title footnotes in headings bind to the heading's section", () => {
    const doc = parseDmd("# Článek o něčem[^*]\n\n[^*]: Autor je advokát.\n\nText.");
    expect(doc.sections[0].heading).toBe("Článek o něčem");
    expect(doc.footnotes[0]).toMatchObject({ label: "*", section: 0 });
    expect(doc.footnotes[0].refAt).toBe(at(doc, "[^*]"));
  });
});

describe("parseDmd — sections", () => {
  it("builds the section tree with kinds, keys, ranges and authors", () => {
    const doc = parseDmd(COMMENTARY);
    expect(doc.sections.map((s) => [s.ord, s.parent, s.level, s.kind, s.key, s.heading])).toEqual([
      [0, null, 2, "par", "par:2913", "§ 2913 [Porušení smluvní povinnosti]"],
      [1, 0, 3, "sub", null, "I. Obecně"],
      [2, null, 2, "par", "par:2914", "§ 2914"],
    ]);
    const [s0, s1, s2] = doc.sections;
    expect(s1.author).toBe("Filip Melzer");
    expect(s0.author).toBeNull();
    expect(s0.start).toBe(at(doc, "## § 2913"));
    // a section ends with its last content, before the next heading
    expect(s0.end).toBe(at(doc, "[m. č. 2] Druhý odstavec.") + "[m. č. 2] Druhý odstavec.".length);
    expect(s1.end).toBe(s0.end);
    expect(s2.end).toBe(doc.text.length);
    expect([s0.pageFrom, s0.pageTo, s1.pageFrom, s1.pageTo, s2.pageFrom]).toEqual([1, 2, 1, 2, 2]);
    expect(doc.sections.every((s) => s.indexed)).toBe(true);
    expect(doc.stats.headings).toBe(3);
  });

  it("closes sections at a heading of the same or a higher level", () => {
    const doc = parseDmd("# A\n\n## B\n\n### C\n\n## D\n\n# E\n\n### F");
    expect(doc.sections.map((s) => s.parent)).toEqual([null, 0, 1, 0, null, 4]);
    const [a, b, c, d] = doc.sections;
    expect(c.end).toBe(b.end);
    expect(d.end).toBe(a.end);
    expect(a.end).toBeLessThan(doc.sections[4].start);
  });

  it("keeps trailing page markers out of the closing section", () => {
    const doc = parseDmd("[s. 1]\n\n# A\n\nText\n\n[s. 2]\n\n# B\n\nText");
    const [a, b] = doc.sections;
    expect(doc.text.slice(a.start, a.end)).toBe("# A\n\nText");
    expect(a.pageTo).toBe(1);
    expect(b.pageFrom).toBe(2);
    const marker = doc.blocks.find((bl) => bl.kind === "page" && bl.page === 2)!;
    expect(marker.section).toBe(-1);
  });

  it("does not index toc / index sections nor their subsections", () => {
    const doc = parseDmd("# Obsah\n\n## § 1 ... 5\n\n# Kapitola 1\n\n# Věcný rejstřík\n\n## A");
    expect(doc.sections.map((s) => [s.kind, s.indexed])).toEqual([
      ["toc", false],
      ["par", false],
      ["chapter", true],
      ["index", false],
      ["sub", false],
    ]);
    expect(doc.problems.map((p) => p.code)).not.toContain("par_not_monotonic");
  });

  it("reports a decreasing § among siblings but keeps the section", () => {
    const doc = parseDmd("# Hlava I\n\n## § 10\n\n## § 12\n\n## § 11\n\n# Hlava II\n\n## § 1");
    expect(doc.sections.filter((s) => s.kind === "par").map((s) => s.key)).toEqual(["par:10", "par:12", "par:11", "par:1"]);
    const problems = doc.problems.filter((p) => p.code === "par_not_monotonic");
    expect(problems).toHaveLength(1);
    expect(problems[0].at).toBe(at(doc, "## § 11"));
  });

  it("an over-long heading is text and a problem", () => {
    const doc = parseDmd(`# ${"x".repeat(301)}\n\nText`);
    expect(doc.sections).toEqual([]);
    expect(doc.blocks[0].kind).toBe("para");
    expect(doc.problems[0].code).toBe("heading_too_long");
  });
});

describe("parseDmd — marginal numbers", () => {
  it("records anchors and checks the sequence per § section", () => {
    const doc = parseDmd("## § 1\n\n[m. č. 1] a\n\n[m. č. 2] b\n\n[m. č. 2] c\n\n## § 2\n\n[m. č. 1] d\n\n[m. č. 1a] e");
    expect(doc.blocks.filter((b) => b.anchor).map((b) => b.anchor)).toEqual(["1", "2", "2", "1", "1a"]);
    const seq = doc.problems.filter((p) => p.code === "mn_sequence");
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ at: at(doc, "[m. č. 2] c"), detail: "2" });
    expect(doc.stats.marginalNumbers).toBe(5);
    expect(doc.anchorLabel).toBe("m. č.");
  });

  it("numbering runs on across subsections of one §", () => {
    const doc = parseDmd("## § 1\n\n### I.\n\n[m. č. 1] a\n\n### II.\n\n[m. č. 2] b\n\n### III.\n\n[m. č. 1] c");
    expect(doc.problems.filter((p) => p.code === "mn_sequence")).toHaveLength(1);
  });

  it("anchorLabel comes from the options, else from the numbers found", () => {
    expect(parseDmd("[m. č. 1] a", { anchorLabel: "bod" }).anchorLabel).toBe("bod");
    expect(parseDmd("text").anchorLabel).toBeNull();
    expect(parseDmd("text", { anchorLabel: "marg. č." }).anchorLabel).toBe("marg. č.");
  });

  it("a mid-line [m. č.] is text", () => {
    const doc = parseDmd("viz [m. č. 5] výše");
    expect(doc.stats.marginalNumbers).toBe(0);
    expect(doc.problems[0].code).toBe("escaped_marker");
  });
});

describe("parseDmd — stats", () => {
  it("counts chars without markup, footnote text included", () => {
    const doc = parseDmd("[s. 1]\n\n## § 1\n\n> Znění\n\n[m. č. 1] Text[^1] a [s. 2] dál \\[^x]\n\n[^1]: Pozn.");
    const projected = "\n\n§ 1\n\nZnění\n\nText a dál [^x]\n\nPozn.";
    expect(doc.stats.countedChars).toBe(projected.length);
    expect(doc.stats.chars).toBe(doc.text.length);
  });

  it("countedChars equals the stripMarkup projection for a paged document", () => {
    const doc = parseDmd(COMMENTARY);
    expect(doc.stats.countedChars).toBe(stripMarkup(COMMENTARY).text.length);
  });

  it("parses the empty document", () => {
    const doc = parseDmd("");
    expect(doc).toMatchObject({ paged: false, pages: [], blocks: [], sections: [], footnotes: [], problems: [] });
    expect(doc.stats.countedChars).toBe(0);
  });
});

describe("parseDmd — safety caps", () => {
  const expectLimit = (fn: () => unknown, limit: string) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DmdLimitError);
      expect((err as DmdLimitError).limit).toBe(limit);
      return;
    }
    throw new Error(`expected DmdLimitError(${limit})`);
  };

  it("rejects too many chars", () => expectLimit(() => parseDmd("x".repeat(DMD_LIMITS.maxChars + 1)), "maxChars"));
  it("rejects a too long line", () => expectLimit(() => parseDmd(`a\n${"x".repeat(DMD_LIMITS.maxLineChars + 1)}`), "maxLineChars"));
  it("rejects too many pages", () =>
    expectLimit(() => parseDmd(Array.from({ length: DMD_LIMITS.maxPages + 1 }, (_, i) => `[s. ${i + 1}]\n\nx`).join("\n\n")), "maxPages"));
  it("counts inline page breaks toward the page cap", () =>
    expectLimit(() => parseDmd(`[s. 0]\n\n${Array.from({ length: DMD_LIMITS.maxPages }, (_, i) => `a [s. ${i + 1}] b`).join("\n")}`), "maxPages"));
  it("rejects too many headings", () => expectLimit(() => parseDmd("# h\n".repeat(DMD_LIMITS.maxHeadings + 1)), "maxHeadings"));
  it("rejects too many footnotes", () => expectLimit(() => parseDmd("[^1]: x\n".repeat(DMD_LIMITS.maxFootnotes + 1)), "maxFootnotes"));
  it("rejects too many references", () =>
    expectLimit(() => parseDmd(Array.from({ length: 1000 }, () => "[^1] ".repeat(61)).join("\n")), "maxFootnotes"));
  it("rejects a too long footnote, also through continuation lines", () => {
    expectLimit(() => parseDmd(`[^1]: ${"x".repeat(DMD_LIMITS.maxFootnoteChars + 1)}`), "maxFootnoteChars");
    const lines = Array.from({ length: 200 }, () => `    ${"y".repeat(60)}`).join("\n");
    expectLimit(() => parseDmd(`[^1]: start\n${lines}`), "maxFootnoteChars");
  });
  it("accepts exactly the caps", () => {
    expect(() => parseDmd(`[^1]: ${"x".repeat(DMD_LIMITS.maxFootnoteChars)}`)).not.toThrow();
    expect(() => parseDmd("x".repeat(DMD_LIMITS.maxLineChars))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────── performance

function syntheticBook(pages: number, footnotes: number, targetChars: number): string {
  const perPage = Math.ceil(footnotes / pages);
  const out: string[] = [];
  let fn = 0;
  let par = 0;
  const filler = "Odpovědnost za škodu vzniká porušením smluvní povinnosti, pokud škůdce neprokáže liberační důvod. ";
  const bodyPerPage = Math.floor(targetChars / pages);
  for (let p = 1; p <= pages; p++) {
    out.push(`[s. ${p}]`, "");
    if (p % 10 === 1) out.push(`## § ${p}`, "");
    let size = 0;
    const defs: string[] = [];
    let mn = 1;
    for (let k = 1; k <= perPage && fn < footnotes; k++, fn++) {
      const reps = Math.max(1, Math.floor(bodyPerPage / perPage / filler.length) - 1);
      const para = `[m. č. ${mn++}] ${filler.repeat(reps)}text[^${k}] konec.`;
      out.push(para, "");
      defs.push(`[^${k}]: Srov. rozsudek NS sp. zn. 25 Cdo ${par++}/2019.`);
      size += para.length;
    }
    while (size < bodyPerPage) {
      out.push(filler.repeat(10), "");
      size += filler.length * 10;
    }
    out.push(...defs, "");
  }
  return out.join("\n");
}

describe("parseDmd — linear time", () => {
  it("parses a 5-million-char book with 1,500 pages and 20k footnotes well under 5 s", () => {
    const book = syntheticBook(1500, 20_000, 4_900_000);
    expect(book.length).toBeGreaterThan(5_000_000);
    expect(book.length).toBeLessThan(DMD_LIMITS.maxChars);
    const t0 = performance.now();
    const doc = parseDmd(book);
    const ms = performance.now() - t0;
    expect(doc.pages).toHaveLength(1500);
    expect(doc.footnotes).toHaveLength(20_000);
    expect(doc.stats.danglingRefs).toBe(0);
    expect(ms).toBeLessThan(5000);
    const t1 = performance.now();
    stripMarkup(book);
    expect(performance.now() - t1).toBeLessThan(5000);
  }, 30_000);

  it("stays linear on adversarial input (many lines, sparse tokens)", () => {
    const text = `${"a\n".repeat(1_000_000)}[^1] x`;
    const t0 = performance.now();
    parseDmd(text);
    expect(performance.now() - t0).toBeLessThan(3000);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────── fuzz

/** Deterministic PRNG (mulberry32) so a failure is reproducible from the seed. */
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
  "[s. 1]", "[s. 12]", "[s. xii]", "[s. ", "]", "[s. 1 2]", " [s. 7] ", "[s. 99]\n",
  "[^1]", "[^2]", "[^ab]", "[^***]", "[^1]: ", "[^2]: ", "\n[^1]: ", "\n[^9]: x", "[^", "[^12345]",
  "[m. č. 1] ", "[m. č. 3a] ", "\n[m. č. 2] ", "[m. č. ", "\\[s. 1]", "\\[^1]", "\\[m. č. 1] ", "\\", "\\#", "\\>", "\\|",
  "# ", "## § 1", "### Čl. II", "\n# Obsah\n", "\n## § 2913a\n", "####### ", "#", "> ", ">", "| a |", "|",
  "\n", "\n\n", "\n    ", "    ", " ", "  ", "text", "Poruší-li", "škoda", "§ ", "Č Á S T", "č", "⟦", "⟧",
  "\u{1F600}", "a", "1", ".", ":", "†", "*", "Zpracoval: X",
];

function randomDoc(r: () => number, maxParts = 60): string {
  const parts: string[] = [];
  const count = 1 + Math.floor(r() * maxParts);
  for (let i = 0; i < count; i++) parts.push(FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]);
  return parts.join("");
}

function checkInvariants(doc: ParsedDoc): void {
  const n = doc.text.length;
  let prev = -1;
  for (const b of doc.blocks) {
    expect(b.start).toBeGreaterThan(prev);
    expect(b.end).toBeGreaterThanOrEqual(b.start);
    expect(b.end).toBeLessThanOrEqual(n);
    expect(b.section).toBeLessThan(doc.sections.length);
    if (!doc.paged) expect(b.page).toBe(0);
    prev = b.start;
  }
  doc.pages.forEach((p, i) => {
    expect(p.ord).toBe(i + 1);
    expect(p.end).toBeGreaterThanOrEqual(p.start);
    if (i) expect(p.start).toBe(doc.pages[i - 1].end);
  });
  if (doc.pages.length) expect(doc.pages[doc.pages.length - 1].end).toBe(n);
  doc.sections.forEach((s, i) => {
    expect(s.ord).toBe(i);
    expect(s.end).toBeGreaterThanOrEqual(s.start);
    expect(s.pageTo).toBeGreaterThanOrEqual(s.pageFrom);
    if (s.parent !== null) {
      expect(s.parent).toBeLessThan(i);
      const parent = doc.sections[s.parent];
      expect(parent.level).toBeLessThan(s.level);
      expect(s.end).toBeLessThanOrEqual(parent.end);
    }
  });
  doc.footnotes.forEach((f, i) => {
    expect(f.seq).toBe(i + 1);
    expect(f.defEnd).toBeGreaterThanOrEqual(f.defStart);
    if (f.refAt !== null) {
      expect(f.refAt).toBeLessThan(f.defStart);
      expect(doc.text.startsWith(`[^${f.label}]`, f.refAt)).toBe(true);
    }
  });
  for (const r of doc.refs) if (r.footnote !== null) expect(doc.footnotes[r.footnote - 1].refAt).toBe(r.at);
  expect(doc.problems.length).toBeLessThanOrEqual(MAX_PROBLEMS);
  expect(doc.stats.countedChars).toBeGreaterThanOrEqual(0);
  expect(doc.stats.countedChars).toBeLessThanOrEqual(n);
}

describe("parseDmd — fuzz", () => {
  it("never throws anything but DmdLimitError on 2,000 random DMD-ish strings, and keeps its invariants", () => {
    const r = rng(20260927);
    let parsed = 0;
    for (let i = 0; i < 2000; i++) {
      const raw = randomDoc(r);
      const text = i % 2 ? normalizeDmd(raw).text : raw;
      try {
        const doc = parseDmd(text);
        checkInvariants(doc);
        parsed++;
      } catch (err) {
        if (!(err instanceof DmdLimitError)) throw new Error(`seed doc #${i} ${JSON.stringify(text)}: ${String(err)}`);
      }
    }
    expect(parsed).toBe(2000);
  });
});

// ─────────────────────────────────────────────────────────────── stripMarkup

describe("stripMarkup", () => {
  it("projects the documented markup away", () => {
    const text = "[s. 1]\n## § 1[^1]\n> Znění\n[m. č. 3] A [s. 2] B\n[^1]: Pozn.\n\\# x \\[s. 5]";
    const { text: projected } = stripMarkup(text);
    expect(projected).toBe("\n§ 1\nZnění\nA B\nPozn.\n# x [s. 5]");
  });

  it("strips one space around an inline marker at either edge", () => {
    expect(stripMarkup("konec [s. 4]").text).toBe("konec");
    expect(stripMarkup("x\n[s. 4] začátek").text).toBe("x\nzačátek");
    expect(stripMarkup("a [s. 4] [s. 5] b").text).toBe("a b");
  });

  it("keeps glued, bad-label and heading markers as text", () => {
    expect(stripMarkup("slovo[s. 2] x").text).toBe("slovo[s. 2] x");
    expect(stripMarkup("a [s. 1/2] b").text).toBe("a [s. 1/2] b");
    expect(stripMarkup("# Nadpis [s. 3]").text).toBe("Nadpis [s. 3]");
    expect(stripMarkup("viz [m. č. 5] výše").text).toBe("viz [m. č. 5] výše");
  });

  it("maps projected offsets back into the original", () => {
    const text = "[m. č. 14] Náhrada[^1] škody [s. 2] vzniká";
    const { text: p, map } = stripMarkup(text);
    expect(p).toBe("Náhrada škody vzniká");
    const s = p.indexOf("škody vzniká");
    const e = s + "škody vzniká".length;
    expect(text.slice(map[s], map[e - 1] + 1)).toBe("škody [s. 2] vzniká");
  });

  /**
   * Property: documents assembled from pieces tagged as markup or text —
   * the projection is exactly the text pieces, and the map points each
   * projected char at its own source char, strictly increasing.
   */
  it("property: projection = text pieces, map strictly increasing (500 random docs)", () => {
    const r = rng(42);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const words = ["škoda", "Poruší-li", "odpovědnost", "§ 2913", "25 Cdo 1234/2019", "a", "(1)", "č.", "x-y", "\u{1F600}"];
    const phrase = () => Array.from({ length: 1 + Math.floor(r() * 5) }, () => pick(words)).join(" ");
    type Piece = [text: string, markup: boolean];
    const inlineRun = (): Piece[] => {
      const out: Piece[] = [[phrase(), false]];
      const k = Math.floor(r() * 4);
      for (let i = 0; i < k; i++) {
        const roll = r();
        if (roll < 0.35) out.push([`[^${1 + Math.floor(r() * 30)}]`, true]);
        else if (roll < 0.55) out.push([" ", false], [`[s. ${1 + Math.floor(r() * 900)}] `, true]);
        else if (roll < 0.75) out.push([" ", false], ["\\", true], ["[^7] ", false]);
        else out.push([" ", false], ["\\", true], ["[s. 3] ", false]);
        out.push([phrase(), false]);
      }
      return out;
    };
    const line = (): Piece[] => {
      const roll = r();
      if (roll < 0.1) return [[`[s. ${1 + Math.floor(r() * 900)}]`, true]];
      if (roll < 0.2) return [["#".repeat(1 + Math.floor(r() * 6)) + " ", true], [phrase(), false], ...(r() < 0.5 ? [[`[^${1 + Math.floor(r() * 9)}]`, true] as Piece] : [])];
      if (roll < 0.3) return [[`[^${1 + Math.floor(r() * 30)}]: `, true], ...inlineRun()];
      if (roll < 0.4) return [["> ", true], ...inlineRun()];
      if (roll < 0.5) return [[`[m. č. ${1 + Math.floor(r() * 99)}] `, true], ...inlineRun()];
      if (roll < 0.55) return [["\\", true], [pick(["# ", "> ", "| "]), false], [phrase(), false]];
      if (roll < 0.6) return [["    ", false], ...inlineRun()];
      if (roll < 0.65) return [["| ", false], [phrase(), false], [" |", false]];
      if (roll < 0.7) return [["", false]];
      return inlineRun();
    };
    for (let doc = 0; doc < 500; doc++) {
      const pieces: Piece[] = [];
      const lines = 1 + Math.floor(r() * 25);
      for (let i = 0; i < lines; i++) {
        if (i) pieces.push(["\n", false]);
        pieces.push(...line());
      }
      const original = pieces.map((p) => p[0]).join("");
      const expected = pieces.filter((p) => !p[1]).map((p) => p[0]).join("");
      const { text, map } = stripMarkup(original);
      expect(text, JSON.stringify(original)).toBe(expected);
      expect(map.length).toBe(text.length);
      let bad = -1;
      for (let i = 0; i < map.length && bad === -1; i++) {
        if (original[map[i]] !== text[i] || (i > 0 && map[i] <= map[i - 1])) bad = i;
      }
      expect(bad, JSON.stringify(original)).toBe(-1);
      // …and the parser's billing base agrees whenever the doc is paged.
      const parsed = parseDmd(original);
      if (parsed.paged) expect(parsed.stats.countedChars).toBe(text.length);
    }
  });
});
