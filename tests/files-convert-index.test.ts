// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ConvertOptions } from "@/src/files/convert/types";

// The PDF converter is another module (and pulls in pdf.js): a stand-in that
// DETACHES the buffer the way pdf.js does, so the hash must come first.
const convertPdf = vi.fn(async (data: ArrayBuffer, opts: ConvertOptions, onProgress?: (done: number, total: number) => void) => {
  structuredClone(data, { transfer: [data] });
  void opts;
  onProgress?.(1, 1);
  return {
    kind: "pdf" as const,
    converter: "pdf@1",
    dmd: "[s. 1]\n\nText.",
    quality: { footnotes: "none" as const, linked_ratio: 0, columns_pages: 0, headings_from: "none", mn: 0, unsure_pages: [] },
    hints: {},
    labelSource: "physical" as const,
    physicalPages: 1,
    pageFlags: [0],
    pageLabels: ["1"],
    warnings: [],
  };
});
vi.mock("@/src/files/convert/pdf/index", () => ({ convertPdf }));

import { convertFile, detectKind, listZipEntries, MAX_FILE_BYTES, sha256Hex } from "@/src/files/convert/index";
import { scanDmdOutline, sliceDmd } from "@/src/files/convert/slice";
import { ConvertError, DEFAULT_CONVERT_OPTIONS } from "@/src/files/convert/types";
import { parseDmd } from "@/src/files/dmd/parse";

/**
 * convertFile (format sniffing, hashing before conversion, dispatch,
 * Czech rejections) and sliceDmd (page / section ranges that stay valid
 * DMD, with footnote definitions following their references).
 */

// ─────────────────────────────────────────────────────────── helpers

/** A minimal stored ZIP (no compression, CRC not checked by the sniffer). */
function makeZip(entries: Array<[string, string]>, opts: { centralDirectory?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  const u16 = (arr: number[], v: number) => arr.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (arr: number[], v: number) => arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const offset = chunks.length;
    u32(chunks, 0x04034b50);
    u16(chunks, 20); u16(chunks, 0); u16(chunks, 0); u16(chunks, 0); u16(chunks, 0);
    u32(chunks, 0); u32(chunks, data.length); u32(chunks, data.length);
    u16(chunks, nameBytes.length); u16(chunks, 0);
    chunks.push(...nameBytes, ...data);
    u32(central, 0x02014b50);
    u16(central, 20); u16(central, 20); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, data.length); u32(central, data.length);
    u16(central, nameBytes.length); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, offset);
    central.push(...nameBytes);
  }
  if (opts.centralDirectory === false) return new Uint8Array(chunks);
  const cdOffset = chunks.length;
  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0); u16(eocd, 0); u16(eocd, entries.length); u16(eocd, entries.length);
  u32(eocd, central.length); u32(eocd, cdOffset); u16(eocd, 0);
  return new Uint8Array([...chunks, ...central, ...eocd]);
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`tests/fixtures/files/docx/${name}`));
}

function file(content: Uint8Array | string, name: string): File {
  return new File([typeof content === "string" ? content : (content as BlobPart)], name);
}

function expectReject(fn: () => unknown, code: ConvertError["code"], message?: RegExp): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConvertError);
    expect((e as ConvertError).code).toBe(code);
    if (message) expect((e as ConvertError).message).toMatch(message);
    return;
  }
  throw new Error("expected a ConvertError");
}

// ─────────────────────────────────────────────────────────── sniffing

describe("listZipEntries", () => {
  it("reads names from the central directory", () => {
    expect(listZipEntries(makeZip([["[Content_Types].xml", "x"], ["word/document.xml", "<w/>"]]))).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
    ]);
    expect(listZipEntries(fixture("vzor-smlouva.docx"))).toContain("word/document.xml");
  });

  it("returns null without a readable directory, and caps the count", () => {
    expect(listZipEntries(makeZip([["a", "b"]], { centralDirectory: false }))).toBeNull();
    expect(listZipEntries(bytes("not a zip at all, long enough to scan"))).toBeNull();
    const many = makeZip(Array.from({ length: 20 }, (_, i) => [`f${i}`, ""] as [string, string]));
    expect(listZipEntries(many, 5)).toHaveLength(5);
  });
});

describe("detectKind", () => {
  it("finds PDF by magic bytes, also after junk and whatever the name", () => {
    expect(detectKind(bytes("%PDF-1.7\n…"), "x.pdf")).toBe("pdf");
    expect(detectKind(bytes("\n\n  junk %PDF-1.4"), "renamed.docx")).toBe("pdf");
  });

  it("finds DOCX in a ZIP with word/document.xml (also .docm/.dotx, and without a central directory)", () => {
    expect(detectKind(fixture("clanek-poznamky.docx"), "clanek.docx")).toBe("docx");
    expect(detectKind(makeZip([["word/document.xml", ""]]), "vzor.dotx")).toBe("docx");
    expect(detectKind(makeZip([["word/document.xml", ""]], { centralDirectory: false }), "x.bin")).toBe("docx");
  });

  it("rejects other ZIP formats with a Czech message", () => {
    expectReject(() => detectKind(makeZip([["mimetype", "application/vnd.oasis.opendocument.text"], ["content.xml", ""]]), "a.odt"), "unsupported", /ODT.*Uložte dokument jako PDF nebo DOCX\.$/);
    expectReject(() => detectKind(makeZip([["mimetype", "application/epub+zip"], ["META-INF/container.xml", ""]]), "a.epub"), "unsupported", /EPUB/);
    expectReject(() => detectKind(makeZip([["xl/workbook.xml", ""]]), "a.xlsx"), "unsupported", /Excel/);
    expectReject(() => detectKind(makeZip([["readme.txt", "hi"]]), "a.zip"), "unsupported", /ZIP/);
  });

  it("tells an encrypted .docx from an old .doc (both OLE2)", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    expectReject(() => detectKind(ole, "smlouva.docx"), "encrypted", /heslem/);
    expectReject(() => detectKind(ole, "smlouva.doc"), "unsupported", /DOC/);
  });

  it("rejects RTF, HTML, unknown and empty files", () => {
    expectReject(() => detectKind(bytes("{\\rtf1\\ansi"), "a.rtf"), "unsupported", /RTF/);
    expectReject(() => detectKind(bytes("<html></html>"), "a.html"), "unsupported", /HTML.*Uložte dokument jako PDF nebo DOCX\./);
    expectReject(() => detectKind(bytes("abc"), "a.csv"), "unsupported", /Tento typ souboru/);
    expectReject(() => detectKind(bytes("abc"), "bez-pripony"), "unsupported");
    expectReject(() => detectKind(new Uint8Array(0), "a.txt"), "broken", /prázdný/);
    expectReject(() => detectKind(bytes("abc"), "fake.docx"), "unsupported", /DOCX/);
    expectReject(() => detectKind(bytes("abc"), "fake.pdf"), "broken", /PDF/);
  });

  it("takes .txt / .md by extension", () => {
    expect(detectKind(bytes("text"), "Poznámky.TXT")).toBe("txt");
    expect(detectKind(bytes("# md"), "a.markdown")).toBe("md");
    expect(detectKind(bytes("# md"), "a.md")).toBe("md");
  });
});

describe("sha256Hex", () => {
  it("matches node's SHA-256", async () => {
    const data = bytes("Příliš žluťoučký kůň");
    expect(await sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
  });
});

// ─────────────────────────────────────────────────────────── convertFile

describe("convertFile", () => {
  it("converts a UTF-8 text file and reports hash, name, size and phases", async () => {
    const content = bytes("Odstavec[^1].\n\n[^1]: Poznámka.");
    const phases: string[] = [];
    const r = await convertFile(file(content, "poznamky.txt"), DEFAULT_CONVERT_OPTIONS, (p) => phases.push(p.phase));
    expect(r).toMatchObject({ kind: "txt", converter: "txt@1", fileName: "poznamky.txt", bytes: content.length });
    expect(r.fileSha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(r.dmd).toBe("Odstavec[^1].\n\n[^1]: Poznámka.");
    expect(phases).toEqual(["read", "read", "hash", "hash", "text", "text", "done"]);
    expect(r.warnings).toEqual([]);
  });

  it("decodes a windows-1250 file and warns", async () => {
    const cp1250 = new Uint8Array([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a, 0x20, 0x9e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd]);
    const r = await convertFile(file(cp1250, "stary.txt"), DEFAULT_CONVERT_OPTIONS);
    expect(r.dmd).toBe("Příliš žluťoučký");
    expect(r.warnings[0]).toMatch(/windows-1250/);
  });

  it("converts Markdown", async () => {
    const r = await convertFile(file("# Nadpis\n\ntext", "a.md"), DEFAULT_CONVERT_OPTIONS);
    expect(r.kind).toBe("md");
    expect(parseDmd(r.dmd).sections).toHaveLength(1);
  });

  it("rejects a binary file named .txt", async () => {
    await expect(convertFile(file(new Uint8Array([0x41, 0, 0x42, 0]), "a.txt"), DEFAULT_CONVERT_OPTIONS)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("converts a DOCX", async () => {
    const r = await convertFile(file(fixture("clanek-poznamky.docx"), "clanek.docx"), DEFAULT_CONVERT_OPTIONS);
    expect(r.kind).toBe("docx");
    expect(parseDmd(r.dmd).stats.footnotes).toBe(7);
    expect(r.fileSha256).toBe(createHash("sha256").update(fixture("clanek-poznamky.docx")).digest("hex"));
  });

  it("hashes a PDF before the converter detaches its buffer, and forwards progress", async () => {
    convertPdf.mockClear();
    const pdf = bytes("%PDF-1.7\nfake");
    const phases: string[] = [];
    const r = await convertFile(file(pdf, "kniha.pdf"), { ...DEFAULT_CONVERT_OPTIONS, plain: true }, (p) => phases.push(p.phase));
    expect(convertPdf).toHaveBeenCalledTimes(1);
    expect(convertPdf.mock.calls[0][1]).toMatchObject({ plain: true });
    expect(r.fileSha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(r).toMatchObject({ kind: "pdf", fileName: "kniha.pdf", bytes: pdf.length, physicalPages: 1 });
    expect(phases).toEqual(["read", "read", "hash", "hash", "pdf", "done"]);
  });

  it("rejects unsupported formats before hashing or converting", async () => {
    convertPdf.mockClear();
    await expect(convertFile(file("{\\rtf1", "a.rtf"), DEFAULT_CONVERT_OPTIONS)).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(/Uložte dokument jako PDF nebo DOCX\.$/),
    });
    expect(convertPdf).not.toHaveBeenCalled();
  });

  it("rejects files over 100 MB without reading them", async () => {
    const arrayBuffer = vi.fn();
    const huge = { name: "velka.pdf", size: MAX_FILE_BYTES + 1, arrayBuffer } as unknown as File;
    await expect(convertFile(huge, DEFAULT_CONVERT_OPTIONS)).rejects.toMatchObject({ code: "too_large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────── sliceDmd

const BOOK = [
  "[s. 10]",
  "",
  "# Kapitola 1",
  "",
  "Odstavec A[^1] pokračuje [s. 11] na další straně[^2].",
  "",
  "[^1]: Pozn. 1.",
  "[^2]: Pozn. 2.",
  "",
  "Odstavec B[^3].",
  "",
  "[^3]: Pozn. 3 [s. 12] přes zlom.",
  "",
  "## § 5 [Název][^4]",
  "",
  "[^4]: K nadpisu.",
  "",
  "Text C.",
  "",
  "[s. 13]",
  "",
  "# Kapitola 2",
  "",
  "Text D[^5].",
  "",
  "[^5]: Pozn. 5.",
].join("\n");

/** Parse a slice and assert it is valid, fully bound DMD. */
function valid(dmd: string, paged = true) {
  const parsed = parseDmd(dmd);
  expect(parsed.paged).toBe(paged);
  expect(parsed.stats.danglingRefs).toBe(0);
  expect(parsed.stats.danglingDefs).toBe(0);
  expect(parsed.problems.filter((p) => p.code !== "duplicate_page_label")).toEqual([]);
  return parsed;
}

describe("scanDmdOutline", () => {
  it("matches the parser's pages and sections", () => {
    const outline = scanDmdOutline(BOOK);
    const parsed = parseDmd(BOOK);
    expect(outline.paged).toBe(true);
    expect(outline.pages).toEqual(parsed.pages.map(({ ord, label, start, end }) => ({ ord, label, start, end })));
    expect(outline.sections).toEqual(
      parsed.sections.map((s) => ({ ord: s.ord, level: s.level, heading: s.heading, kind: s.kind, key: s.key, start: s.start, end: s.end, page: s.pageFrom })),
    );
    expect(outline.sections.map((s) => s.heading)).toEqual(["Kapitola 1", "§ 5 [Název]", "Kapitola 2"]);
  });

  it("works past the parser's safety caps", () => {
    const pages = Array.from({ length: 1600 }, (_, i) => `[s. ${i + 1}]\n\n# Kapitola ${i + 1}\n\nText.`).join("\n\n");
    expect(() => parseDmd(pages)).toThrow();
    const outline = scanDmdOutline(pages);
    expect(outline.pages).toHaveLength(1600);
    expect(outline.sections).toHaveLength(1600);
    const slice = sliceDmd(pages, { pages: [1500, 1502] });
    expect(valid(slice).pages.map((p) => p.label)).toEqual(["1500", "1501", "1502"]);
  });

  it("treats page lines of an unpaged text as text", () => {
    const outline = scanDmdOutline("Text.\n\n[s. 5]\n\n# Nadpis");
    expect(outline).toMatchObject({ paged: false, pages: [] });
    expect(outline.sections).toHaveLength(1);
  });
});

describe("sliceDmd — pages", () => {
  it("returns the text unchanged without a range", () => {
    expect(sliceDmd(BOOK, {})).toBe(BOOK);
    expect(sliceDmd(BOOK, { pages: null, sections: null })).toBe(BOOK);
  });

  it("cuts the paragraph running onto the next page and keeps the notes of its kept part", () => {
    const out = sliceDmd(BOOK, { pages: [1, 1] });
    expect(out).toBe("[s. 10]\n\n# Kapitola 1\n\nOdstavec A[^1] pokračuje\n\n[^1]: Pozn. 1.");
    valid(out);
  });

  it("opens at an inline break with a marker line and drops notes cited before the range", () => {
    const out = sliceDmd(BOOK, { pages: [2, 2] });
    expect(out).toBe(
      ["[s. 11]", "", "na další straně[^2].", "", "[^2]: Pozn. 2.", "", "Odstavec B[^3].", "", "[^3]: Pozn. 3 přes zlom."].join("\n"),
    );
    expect(valid(out).pages.map((p) => p.label)).toEqual(["11"]);
  });

  it("keeps the page of a removed note as a marker line", () => {
    const out = sliceDmd(BOOK, { pages: [3, 4] });
    expect(out).toBe(
      ["[s. 12]", "", "## § 5 [Název][^1]", "", "[^1]: K nadpisu.", "", "Text C.", "", "[s. 13]", "", "# Kapitola 2", "", "Text D[^5].", "", "[^5]: Pozn. 5."]
        .join("\n")
        .replace("[^1]", "[^4]")
        .replace("[^1]:", "[^4]:"),
    );
    expect(valid(out).pages.map((p) => p.label)).toEqual(["12", "13"]);
  });

  it("keeps a page break that sat inside a removed note", () => {
    const doc = ["[s. 1]", "", "Para X[^1] konec [s. 2] pokračování.", "[^1]: Pozn. jedna [s. 3] pokračuje.", "", "Para Y."].join("\n");
    const out = sliceDmd(doc, { pages: [2, 3] });
    expect(out).toBe("[s. 2]\n\npokračování.\n\n[s. 3]\n\nPara Y.");
    expect(valid(out).pages.map((p) => p.label)).toEqual(["2", "3"]);
  });

  it("clamps the end and rejects impossible ranges", () => {
    expect(sliceDmd(BOOK, { pages: [4, 99] })).toBe("[s. 13]\n\n# Kapitola 2\n\nText D[^5].\n\n[^5]: Pozn. 5.");
    expect(() => sliceDmd(BOOK, { pages: [5, 6] })).toThrow(RangeError);
    expect(() => sliceDmd(BOOK, { pages: [3, 2] })).toThrow(RangeError);
    expect(() => sliceDmd(BOOK, { pages: [1.5, 2] })).toThrow(RangeError);
    expect(() => sliceDmd("Text bez stran.", { pages: [1, 1] })).toThrow(RangeError);
    expect(sliceDmd(BOOK, { pages: [0, 1] })).toBe(sliceDmd(BOOK, { pages: [1, 1] }));
  });

  it("every page range of the book is valid DMD whose pages are exactly the range", () => {
    for (let a = 1; a <= 4; a++) {
      for (let b = a; b <= 4; b++) {
        const out = sliceDmd(BOOK, { pages: [a, b] });
        const labels = valid(out).pages.map((p) => p.label);
        expect(labels).toEqual(["10", "11", "12", "13"].slice(a - 1, b));
      }
    }
  });
});

describe("sliceDmd — sections", () => {
  it("keeps one section with the page it starts on", () => {
    const out = sliceDmd(BOOK, { sections: [1, 1] });
    expect(out).toBe("[s. 12]\n\n## § 5 [Název][^4]\n\n[^4]: K nadpisu.\n\nText C.");
    valid(out);
  });

  it("keeps a section with its subsections and page breaks", () => {
    const out = sliceDmd(BOOK, { sections: [0, 0] });
    const parsed = valid(out);
    expect(parsed.sections.map((s) => s.heading)).toEqual(["Kapitola 1", "§ 5 [Název]"]);
    expect(parsed.pages.map((p) => p.label)).toEqual(["10", "11", "12"]);
    expect(out.endsWith("Text C.")).toBe(true);
    expect(parsed.footnotes).toHaveLength(4);
  });

  it("spans a section range and intersects with a page range", () => {
    expect(valid(sliceDmd(BOOK, { sections: [1, 2] })).sections).toHaveLength(2);
    expect(sliceDmd(BOOK, { pages: [1, 3], sections: [2, 2] })).toBe("");
    const both = sliceDmd(BOOK, { pages: [1, 1], sections: [0, 2] });
    expect(both).toBe(sliceDmd(BOOK, { pages: [1, 1] }));
  });

  it("slices unpaged documents by section", () => {
    const doc = "# A\n\nText a[^1].\n\n[^1]: x\n\n# B\n\nText b[^2].\n\n[^2]: y";
    const out = sliceDmd(doc, { sections: [1, 5] });
    expect(out).toBe("# B\n\nText b[^2].\n\n[^2]: y");
    valid(out, false);
  });

  it("rejects missing sections", () => {
    expect(() => sliceDmd("Bez nadpisů.", { sections: [0, 0] })).toThrow(RangeError);
    expect(() => sliceDmd(BOOK, { sections: [3, 3] })).toThrow(RangeError);
    expect(() => sliceDmd(BOOK, { sections: [-1, 0] })).toThrow(RangeError);
  });

  it("every section range of the book is valid DMD", () => {
    for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) valid(sliceDmd(BOOK, { sections: [i, j] }));
  });

  it("slices converter output (DOCX fixture) by section", async () => {
    const r = await convertFile(file(fixture("clanek-poznamky.docx"), "clanek.docx"), DEFAULT_CONVERT_OPTIONS);
    const outline = scanDmdOutline(r.dmd);
    const judikatura = outline.sections.findIndex((s) => s.heading === "2. Judikatura");
    const out = sliceDmd(r.dmd, { sections: [judikatura, judikatura] });
    const parsed = valid(out, false);
    expect(parsed.sections.map((s) => s.heading)).toEqual(["2. Judikatura"]);
    expect(parsed.footnotes.map((f) => f.label)).toEqual(["3", "4", "ii"]);
  });
});
