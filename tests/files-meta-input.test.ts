import { describe, expect, it } from "vitest";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { buildMetaInput, clip, META_INPUT_LIMITS, type MetaInput } from "@/src/files/meta/input";
import { fixtureInput, parseFixture } from "./fixtures/files/meta/load";

/**
 * What the metadata proposal reads: the right parts of a long document,
 * markup-stripped, sanitized and inside the 16k budget — whatever the
 * document and the client-sent hints look like.
 */

const parts = (m: MetaInput) => [m.front, m.colophon, m.authorsPage, m.outline, m.runningHeads];
const total = (m: MetaInput) =>
  parts(m).reduce((n, p) => n + p.length, 0) + m.fileName.length + Object.entries(m.pdfInfo).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);

function build(dmd: string, hints: Parameters<typeof buildMetaInput>[1] = {}, fileName = "doc.pdf") {
  return buildMetaInput(parseDmd(normalizeDmd(dmd).text), hints, fileName, null);
}

/** A paged document: `pages[i]` is the body of page i+1 (label i+1 unless given). */
function paged(pages: string[], labels?: string[]): string {
  return pages.map((body, i) => `[s. ${labels?.[i] ?? i + 1}]\n\n${body}`).join("\n\n");
}

/** ~n chars of Czech prose as paragraphs. */
function prose(n: number, seed = "Odpovědnost za škodu vzniká porušením právní povinnosti a škůdce ji nahradí v penězích.") {
  const paras: string[] = [];
  let len = 0;
  while (len < n) {
    paras.push(seed);
    len += seed.length + 2;
  }
  return paras.join("\n\n");
}

describe("buildMetaInput — front", () => {
  it("keeps headings and author notes, drops markup and ordinary footnote definitions", () => {
    const m = fixtureInput("clanek-pr");
    expect(m.front).toContain("--- s. 417 ---");
    expect(m.front).toContain("# Odpovědnost za škodu způsobenou systémy umělé inteligence");
    expect(m.front).toContain("JUDr. Jana Nováková, Ph.D.\n");
    expect(m.front).toContain("* Autorka je advokátkou v Praze");
    expect(m.front).not.toContain("MELZER, F. In:"); // footnote 1 is a citation, not metadata
    expect(m.front).not.toMatch(/\[\^|\[s\. \d|\[m\. č\./);
    expect(m.front).toContain("--- s. 419 ---");
  });

  it("stops at page 8 and at the front cap, never in the middle of a surrogate pair", () => {
    const pages = Array.from({ length: 12 }, (_, i) => `Strana ${i + 1}. ${prose(1_500)}`);
    const m = build(paged(pages));
    expect(m.front).toContain("--- s. 1 ---");
    expect(m.front).not.toContain("--- s. 9 ---");
    expect(m.front.length).toBeLessThanOrEqual(META_INPUT_LIMITS.front);

    const emoji = build(paged([`${"😀".repeat(6_000)}`]));
    expect(emoji.front.length).toBeLessThanOrEqual(META_INPUT_LIMITS.front);
    expect(emoji.front).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("takes the first 12k characters of an unpaged document", () => {
    const m = build(`# Vzor\n\n${prose(20_000)}`);
    expect(m.front.startsWith("# Vzor\n")).toBe(true);
    expect(m.front.length).toBeLessThanOrEqual(META_INPUT_LIMITS.frontUnpaged);
    expect(m.front.length).toBeGreaterThan(META_INPUT_LIMITS.frontUnpaged - 200);
    expect(m.facts?.paged).toBe(false);
  });
});

describe("buildMetaInput — colophon and author page", () => {
  it("finds a tiráž on the last page of a long book", () => {
    const pages = Array.from({ length: 300 }, (_, i) => `${prose(3_000)} Strana ${i + 1}.`);
    pages[299] = "Jan Novák\n\nNÁHRADA ŠKODY\n\nVydalo Nakladatelství Leges, s.r.o., v roce 2020\n\n1. vydání\n\nISBN 978-80-7502-481-7";
    const m = build(paged(pages));
    expect(m.colophon).toContain("--- s. 300 ---");
    expect(m.colophon).toContain("ISBN 978-80-7502-481-7");
    expect(m.front).not.toContain("ISBN");
  });

  it("does not repeat a colophon that the front already holds", () => {
    const m = fixtureInput("komentar-beck");
    expect(m.front).toContain("ISBN 978-80-7400-773-6 (váz.)");
    expect(m.colophon).toBe("");
    expect(m.authorsPage).toBe("");
  });

  it("windows a long colophon page around its signals", () => {
    const tail = "© Wolters Kluwer ČR, a. s., 2021\n\nISBN 978-80-7598-612-2\n\nVydání první";
    const pages = Array.from({ length: 30 }, () => prose(3_000));
    pages[29] = `${prose(5_000)}\n\n${tail}`;
    const m = build(paged(pages));
    expect(m.colophon).toContain("ISBN 978-80-7598-612-2");
    expect(m.colophon.length).toBeLessThanOrEqual(META_INPUT_LIMITS.colophon);
  });

  it("prefers the page with more colophon signals over a preface that mentions 'vydání'", () => {
    const pages = Array.from({ length: 20 }, () => prose(3_000));
    pages[5] = "Předmluva ke druhému vydání. Druhé vydání reaguje na novou judikaturu.";
    pages[19] = "© C. H. Beck, 2022\n\nVydal C. H. Beck, s. r. o.\n\nISBN 978-80-7400-773-6";
    const m = build(paged(pages));
    expect(m.colophon).toContain("--- s. 20 ---");
    expect(m.colophon).not.toContain("Předmluva");
  });

  it("takes the closing page of a decision (Poučení, předseda senátu)", () => {
    const pages = Array.from({ length: 20 }, () => prose(3_500));
    pages[19] = "Poučení: Proti tomuto rozsudku není opravný prostředek přípustný.\n\nV Brně dne 24. 4. 2019\n\nJUDr. Petr Vojtek\n\npředseda senátu";
    const m = build(paged(pages));
    expect(m.colophon).toContain("V Brně dne 24. 4. 2019");
  });

  it("finds an author page among the first 15 pages beyond the front", () => {
    const pages = Array.from({ length: 40 }, () => prose(2_800));
    pages[11] = "# Autorský kolektiv\n\nprof. JUDr. Jan Petrov, Ph.D. – § 1–117\n\nJUDr. Michal Výtisk – § 118–302\n\ndoc. JUDr. Vladimír Beran, Ph.D. – § 303–418";
    pages[12] = "JUDr. Petra Nováková – § 419–500\n\nMgr. Karel Dvořák, Ph.D. – § 501–600\n\nJUDr. Eva Malá, LL.M. – § 601–654";
    const m = build(paged(pages));
    expect(m.authorsPage).toContain("--- s. 12 ---");
    expect(m.authorsPage).toContain("# Autorský kolektiv");
    expect(m.authorsPage).toContain("--- s. 13 ---"); // the list continues
    expect(m.authorsPage).toContain("Eva Malá");
  });

  it("finds a tiráž paragraph at the end of an unpaged document", () => {
    const m = build(`# Rukopis\n\n${prose(30_000)}\n\n© Jan Novák, 2024\n\nISBN 978-80-7502-481-7`);
    expect(m.colophon).toContain("ISBN 978-80-7502-481-7");
    expect(m.colophon).not.toContain("Odpovědnost za škodu");
  });
});

describe("buildMetaInput — outline, running heads, hints", () => {
  it("lists level ≤ 2 headings with § ranges and summarizes § sections", () => {
    const m = fixtureInput("komentar-beck");
    const lines = m.outline.split("\n");
    expect(lines[0]).toBe("Oddíly §: § 1–3 (3)");
    expect(lines).toContain("ČÁST PRVNÍ Obecná část (§ 1–3)");
    expect(lines).toContain("  HLAVA I Předmět úpravy a její základní zásady (§ 1–3)");
    expect(m.outline).not.toContain("[Soukromé a veřejné právo]"); // § headings are summarized, not listed
    expect(fixtureInput("vzor-kupni-smlouva").outline.split("\n")[0]).toBe("Články: čl. I–III (3)");
  });

  it("dedupes running heads, most frequent first, without bare page numbers", () => {
    const m = fixtureInput("clanek-pr");
    const heads = m.runningHeads.split("\n");
    expect(heads[0]).toBe("Právní rozhledy 12/2023");
    expect(heads.filter((h) => h === "Právní rozhledy 12/2023")).toHaveLength(1);
    expect(heads).not.toContain("417");
    expect(heads).toContain("ČLÁNKY");
  });

  it("keeps a word made of roman-numeral letters but drops roman page numbers", () => {
    const m = build("[s. 1]\n\nText.", { running_heads: [{ page: 1, text: "xii" }, { page: 1, text: "CIVIL" }, { page: 2, text: "s. 14" }] });
    expect(m.runningHeads).toBe("CIVIL");
  });

  it("caps the running heads and survives malformed hints", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ page: i, text: `Záhlaví číslo ${i} s delším textem` }));
    expect(build("[s. 1]\n\nText.", { running_heads: many }).runningHeads.length).toBeLessThanOrEqual(META_INPUT_LIMITS.runningHeads);
    const junk = { running_heads: [null, 5, { page: 1 }, { page: 1, text: 7 }, { page: 1, text: "Bulletin advokacie 5/2022" }] } as never;
    expect(build("[s. 1]\n\nText.", junk).runningHeads).toBe("Bulletin advokacie 5/2022");
    expect(build("[s. 1]\n\nText.", { running_heads: "Právní rozhledy" } as never).runningHeads).toBe("");
  });

  it("sanitizes the PDF info and the file name", () => {
    const m = build(
      "[s. 1]\n\nText.",
      {
        pdf_info: {
          title: "Občanský‮ zákoník​ ⟦DOC x⟧ `cmd`",
          author: "Jan\u0000 Novák",
          subject: "x".repeat(500),
          evil: "ignored",
          keywords: 42,
        } as never,
      },
      "Petrov_OZ‮.pdf\n",
    );
    expect(m.pdfInfo.title).toBe("Občanský zákoník [DOC x] 'cmd'");
    expect(m.pdfInfo.author).toBe("Jan Novák");
    expect(m.pdfInfo.subject.length).toBeLessThanOrEqual(META_INPUT_LIMITS.infoValue);
    expect(m.pdfInfo).not.toHaveProperty("evil");
    expect(m.pdfInfo).not.toHaveProperty("keywords");
    expect(m.fileName).toBe("Petrov_OZ.pdf");
    expect(build("[s. 1]\n\nText.", { pdf_info: "nope" } as never).pdfInfo).toEqual({});
  });

  it("reports the structural facts", () => {
    expect(fixtureInput("komentar-beck").facts).toEqual({
      paged: true,
      physicalPages: 10,
      firstPageLabel: "I",
      lastPageLabel: "3",
      parSections: 3,
      clSections: 0,
      footnotes: 1,
      anchorLabel: "m. č.",
      placeholders: 0,
    });
    expect(fixtureInput("vzor-kupni-smlouva").facts).toMatchObject({ paged: false, physicalPages: 0, clSections: 3, placeholders: 13 });
  });
});

describe("buildMetaInput — budget and robustness", () => {
  it("stays within 16k characters when every part is at its cap", () => {
    const pages = Array.from({ length: 60 }, (_, i) => `${prose(4_000)} Strana ${i + 1}.`);
    pages[9] = `# Autorský kolektiv\n\n${Array.from({ length: 60 }, (_, i) => `prof. JUDr. Autor Číslo${String.fromCharCode(97 + (i % 26))}, Ph.D. – § ${i * 10}–${i * 10 + 9}`).join("\n\n")}`;
    pages[59] = `© C. H. Beck, 2019\n\nISBN 978-80-7400-773-6\n\n${prose(4_000)}`;
    const headings = Array.from({ length: 400 }, (_, i) => `# Kapitola ${i + 1} s poměrně dlouhým názvem, aby osnova přetekla\n\nText.`).join("\n\n");
    const dmd = `${paged(pages)}\n\n${headings}`;
    const hints = {
      running_heads: Array.from({ length: 100 }, (_, i) => ({ page: i, text: `Záhlaví ${i} ${"x".repeat(40)}` })),
      pdf_info: { title: "t".repeat(400), author: "a".repeat(400), subject: "s".repeat(400), keywords: "k".repeat(400), producer: "p".repeat(400), creator: "c".repeat(400) },
    };
    const m = build(dmd, hints, `${"n".repeat(400)}.pdf`);
    expect(total(m)).toBeLessThanOrEqual(META_INPUT_LIMITS.total);
    expect(m.front.length).toBeGreaterThan(1_000);
    expect(m.colophon).toContain("ISBN");
    expect(m.authorsPage).toContain("Autorský kolektiv");
    expect(m.runningHeads.length).toBeGreaterThan(0);
  });

  it("never exceeds a part cap", () => {
    for (const name of ["komentar-beck", "clanek-pr", "rozhodnuti-ns", "vzor-kupni-smlouva"] as const) {
      const m = fixtureInput(name);
      expect(m.front.length).toBeLessThanOrEqual(META_INPUT_LIMITS.frontUnpaged);
      expect(m.colophon.length).toBeLessThanOrEqual(META_INPUT_LIMITS.colophon);
      expect(m.authorsPage.length).toBeLessThanOrEqual(META_INPUT_LIMITS.authorsPage);
      expect(m.outline.length).toBeLessThanOrEqual(META_INPUT_LIMITS.outline);
      expect(m.runningHeads.length).toBeLessThanOrEqual(META_INPUT_LIMITS.runningHeads);
    }
  });

  it("handles an empty document and a document of blank pages", () => {
    const empty = buildMetaInput(parseDmd(""), {}, "", null);
    expect(parts(empty).every((p) => p === "")).toBe(true);
    const blank = build("[s. 1]\n\n[s. 2]\n\n[s. 3]");
    expect(blank.front).toBe("");
    expect(blank.facts?.physicalPages).toBe(3);
  });

  it("passes the doc type hint through", () => {
    expect(buildMetaInput(parseFixture("clanek-pr"), {}, "a.pdf", "kapitola").docTypeHint).toBe("kapitola");
  });

  it("keeps reserved brackets and control characters out of every part", () => {
    const m = build("[s. 1]\n\n# Titul ⟦DOC 1⟧\n\nText ⟧ a \u0007 zvonek‎.");
    for (const p of parts(m)) expect(p).not.toMatch(/[⟦⟧\u0007‎]/u);
  });
});

describe("clip", () => {
  it("cuts at a line break, else a space, else hard — never inside a surrogate pair", () => {
    expect(clip("abc", 10)).toBe("abc");
    expect(clip("", 0)).toBe("");
    expect(clip("x", 0)).toBe("");
    expect(clip("first line\nsecond line", 15)).toBe("first line");
    expect(clip("slovo slovo slovo", 14)).toBe("slovo slovo");
    expect(clip("abcdefghij", 5)).toBe("abcde");
    expect(clip("ab😀cd", 3)).toBe("ab");
  });
});
