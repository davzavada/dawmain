import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_INFLATED_BLOCK_BYTES,
  bytes,
  capString,
  deflateText,
  inflateText,
  iso,
  isoOrNull,
  jsonParam,
  num,
  numOrNull,
} from "@/src/files/db/codec";
import { foldForFilter, likeContains, mapDocumentRow, metaValues, pageLabelKey } from "@/src/files/db/documents";
import { textSource } from "@/src/files/db/reading";
import { sectionKeysFor } from "@/src/files/db/search";

/** Pure helpers of the DB layer (no database). */

describe("deflateText / inflateText", () => {
  it("round-trips Czech text, empty text and astral characters", () => {
    for (const s of ["", "Náhrada škody [^12] — § 2913 odst. 1 o. z.\n\n[s. 245]\nText", "𝔘𝔫𝔦 ☒ ⟦x⟧".repeat(100)]) {
      expect(inflateText(deflateText(s))).toBe(s);
    }
  });

  it("compresses repetitive text well and accepts a plain Uint8Array (PGlite's bytea)", () => {
    const text = "Poruší-li škůdce povinnost stanovenou zákonem, nahradí škodu. ".repeat(200);
    const packed = deflateText(text);
    expect(packed.length).toBeLessThan(text.length / 10);
    const plain = new Uint8Array(packed); // a copy that is not a Buffer
    expect(Buffer.isBuffer(plain)).toBe(false);
    expect(inflateText(plain)).toBe(text);
  });

  it("accepts a Uint8Array view with an offset", () => {
    const packed = deflateText("abc čšž");
    const padded = new Uint8Array(packed.length + 7);
    padded.set(packed, 7);
    expect(inflateText(padded.subarray(7))).toBe("abc čšž");
  });

  it("throws on corrupt input", () => {
    expect(() => inflateText(new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x13]))).toThrow();
  });

  it("refuses a decompression bomb", () => {
    const bomb = deflateRawSync(Buffer.alloc(MAX_INFLATED_BLOCK_BYTES + 1024, 0x61));
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => inflateText(bomb)).toThrow();
  });
});

describe("row value helpers", () => {
  it("num/numOrNull handle pg strings, bigint and null", () => {
    expect(num("42")).toBe(42);
    expect(num(7)).toBe(7);
    expect(num(BigInt(9))).toBe(9);
    expect(num(null)).toBe(0);
    expect(num("")).toBe(0);
    expect(num("2913.01")).toBeCloseTo(2913.01);
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull("3")).toBe(3);
  });

  it("iso/isoOrNull turn Dates into ISO strings", () => {
    const d = new Date("2026-09-27T10:00:00Z");
    expect(iso(d)).toBe("2026-09-27T10:00:00.000Z");
    expect(isoOrNull(null)).toBeNull();
    expect(iso(null)).toBe("");
    expect(isoOrNull("2026-01-01")).toBe("2026-01-01");
  });

  it("bytes accepts Buffer and Uint8Array, rejects anything else", () => {
    expect(bytes(Buffer.from("x"))).toBeInstanceOf(Uint8Array);
    expect(bytes(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
    expect(() => bytes("\\x00")).toThrow(TypeError);
  });

  it("jsonParam always yields JSON text (arrays stay JSON arrays)", () => {
    expect(jsonParam([1, 2])).toBe("[1,2]");
    expect(jsonParam({ a: "b" })).toBe('{"a":"b"}');
    expect(jsonParam(undefined)).toBe("null");
    expect(jsonParam(null)).toBe("null");
  });

  it("capString never leaves a lone high surrogate", () => {
    expect(capString("abcdef", 3)).toBe("abc");
    expect(capString("ab", 3)).toBe("ab");
    const s = "a😀b"; // "a", high, low, "b"
    expect(capString(s, 2)).toBe("a");
    expect(capString(s, 3)).toBe("a😀");
  });
});

describe("textSource", () => {
  it("slices by absolute offsets and clamps to the loaded span", () => {
    const src = textSource(100, "abcdefghij");
    expect(src.start).toBe(100);
    expect(src.end).toBe(110);
    expect(src.slice(102, 105)).toBe("cde");
    expect(src.slice(90, 103)).toBe("abc");
    expect(src.slice(108, 500)).toBe("ij");
    expect(src.slice(0, 50)).toBe("");
    expect(src.slice(105, 102)).toBe("");
  });
});

describe("documents helpers", () => {
  it("pageLabelKey folds printed labels", () => {
    expect(pageLabelKey("XIV")).toBe("xiv");
    expect(pageLabelKey("Příl. 3")).toBe("pril.3");
    expect(pageLabelKey("12–13")).toBe("12-13");
    expect(pageLabelKey("245")).toBe("245");
  });

  it("foldForFilter folds Czech letters like the SQL translate()", () => {
    expect(foldForFilter("Náhrada ŠKODY – Úvod")).toBe("nahrada skody – uvod");
    expect(foldForFilter("Ďábel Ťuk Ňadra Ůl")).toBe("dabel tuk nadra ul");
  });

  it("likeContains escapes LIKE metacharacters", () => {
    expect(likeContains("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
    expect(likeContains("")).toBe("%%");
  });

  it("metaValues keeps the row inside the CHECK constraints", () => {
    const v = metaValues({
      doc_type: "podvrh" as never,
      title: "  ",
      year: 3000,
      commented_act: "zak:89/2012'; DROP TABLE documents; --",
      anchor_label: "xx" as never,
      template_kind: "smlouva",
      decided_on: "2020-13-45",
      authors: ["A", "A", " ", 5 as never, "B"],
      language: "",
    });
    const cols = [
      "doc_type", "title", "subtitle", "authors", "editors", "edition", "publisher", "place", "year", "series", "isbn",
      "issn", "doi", "container_title", "volume", "issue", "pages_range", "commented_act", "commented_act_name",
      "section_range", "anchor_label", "template_kind", "court", "case_number", "ecli", "decided_on", "keywords",
      "summary", "language",
    ];
    const byName = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    expect(v).toHaveLength(cols.length);
    expect(byName.doc_type).toBeNull();
    expect(byName.title).toBeNull();
    expect(byName.year).toBeNull();
    expect(byName.commented_act).toBeNull();
    expect(byName.anchor_label).toBeNull();
    expect(byName.template_kind).toBe("smlouva");
    expect(byName.decided_on).toBeNull();
    expect(byName.authors).toEqual(["A", "B"]);
    expect(byName.language).toBe("cs");
    expect(byName.isbn).toEqual([]);
  });

  it("metaValues passes valid values through", () => {
    const v = metaValues({ doc_type: "komentar", year: 2019, commented_act: "eu:32016R0679", decided_on: "2020-02-29", title: "x".repeat(600) });
    expect(v[0]).toBe("komentar");
    expect(v[8]).toBe(2019);
    expect(v[17]).toBe("eu:32016R0679");
    expect(v[25]).toBe("2020-02-29");
    expect((v[1] as string).length).toBe(500);
  });

  it("mapDocumentRow assembles BibMeta with fallbacks", () => {
    const row = mapDocumentRow({
      id: "x",
      library_id: "user_a",
      status: "review",
      file_name: "kniha.pdf",
      doc_type: null,
      title: null,
      authors: null,
      year: "2019",
      key_num: null,
      quality: null,
      hints: [],
      proposed_meta: null,
      enabled: null,
      uploaded_at: new Date(0),
    });
    expect(row.meta.doc_type).toBe("jine");
    expect(row.meta.title).toBe("kniha.pdf");
    expect(row.meta.authors).toEqual([]);
    expect(row.meta.year).toBe(2019);
    expect(row.meta.language).toBe("cs");
    expect(row.hints).toEqual({});
    expect(row.enabled).toBe(true);
    expect(row.uploaded_at).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("sectionKeysFor", () => {
  it("maps § keys (with or without odstavec) to section keys", () => {
    expect(sectionKeysFor(["par:2913", "par:2913/2", "par:14a", "sz:25cdo1234-2019", "parz:89/2012/2913"])).toEqual([
      "sec:par:2913",
      "sec:par:14a",
    ]);
    expect(sectionKeysFor([])).toEqual([]);
  });
});
