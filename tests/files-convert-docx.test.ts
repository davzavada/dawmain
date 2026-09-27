// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertDocx,
  DOCX_ID_PREFIX,
  headingLevelForStyle,
  htmlToDmd,
  patternHeadingLevel,
} from "@/src/files/convert/docx";
import { ConvertError, DEFAULT_CONVERT_OPTIONS } from "@/src/files/convert/types";
import { parseDmd, unescapeDmd } from "@/src/files/dmd/parse";
import { DMD_LIMITS } from "@/src/files/dmd/types";

/**
 * DOCX → DMD: the HTML walker over synthetic mammoth-shaped HTML (every
 * construct in isolation) and the whole pipeline over the hand-written
 * fixtures from scripts/make-docx-fixtures.py. Every output must parse with
 * the real parser and bind every reference.
 */

const P = DOCX_ID_PREFIX;

function body(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, "text/html").body;
}

/** A mammoth note reference (footnotes and endnotes share mammoth's counter n). */
function ref(kind: "footnote" | "endnote", id: number, n: number): string {
  return `<sup><a href="#${P}${kind}-${id}" id="${P}${kind}-ref-${id}">[${n}]</a></sup>`;
}

function note(kind: "footnote" | "endnote", id: number, ...paragraphs: string[]): string {
  const ps = paragraphs.map((p, i) =>
    i === paragraphs.length - 1 ? `<p> ${p} <a href="#${P}${kind}-ref-${id}">↑</a></p>` : `<p> ${p}</p>`,
  );
  return `<li id="${P}${kind}-${id}">${ps.join("")}</li>`;
}

function convert(html: string) {
  const out = htmlToDmd(body(html));
  const parsed = parseDmd(out.dmd);
  expect(parsed.stats.danglingRefs).toBe(0);
  expect(parsed.stats.danglingDefs).toBe(0);
  return { ...out, parsed };
}

function load(name: string): ArrayBuffer {
  const b = readFileSync(`tests/fixtures/files/docx/${name}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("patternHeadingLevel", () => {
  it("recognises article, § and part designators", () => {
    expect(patternHeadingLevel("Čl. III")).toBe(2);
    expect(patternHeadingLevel("Článek 3 – Cena díla")).toBe(2);
    expect(patternHeadingLevel("článek I.")).toBe(2);
    expect(patternHeadingLevel("§ 12a")).toBe(2);
    expect(patternHeadingLevel("ČÁST PRVNÍ")).toBe(1);
    expect(patternHeadingLevel("Hlava II Obecná ustanovení")).toBe(1);
  });

  it("rejects sentences, long lines and other text", () => {
    expect(patternHeadingLevel("§ 5 zní takto:")).toBeNull();
    expect(patternHeadingLevel("Čl. 3 smlouvy se ruší.")).toBeNull();
    expect(patternHeadingLevel("Článek 3, odst. 2")).toBeNull();
    expect(patternHeadingLevel(`Čl. 1 ${"x".repeat(200)}`)).toBeNull();
    expect(patternHeadingLevel("Předmět smlouvy")).toBeNull();
    expect(patternHeadingLevel("§5a")).toBe(2);
    expect(patternHeadingLevel("§")).toBeNull();
    expect(patternHeadingLevel("")).toBeNull();
  });
});

describe("headingLevelForStyle", () => {
  it("maps Czech and English heading style names", () => {
    expect(headingLevelForStyle("Nadpis 1")).toBe(1);
    expect(headingLevelForStyle("nadpis3")).toBe(3);
    expect(headingLevelForStyle("Heading 2")).toBe(2);
    expect(headingLevelForStyle("Nadpis 2 – vlastní")).toBe(2);
    expect(headingLevelForStyle("Název")).toBe(1);
    expect(headingLevelForStyle("Title")).toBe(1);
    expect(headingLevelForStyle("Článek")).toBe(2);
    expect(headingLevelForStyle("Kapitola")).toBe(1);
  });

  it("leaves other styles alone", () => {
    expect(headingLevelForStyle("Nadpis obsahu")).toBeNull();
    expect(headingLevelForStyle("Nadpis 12")).toBeNull();
    expect(headingLevelForStyle("Normal")).toBeNull();
    expect(headingLevelForStyle("footnote text")).toBeNull();
    expect(headingLevelForStyle(null)).toBeNull();
    expect(headingLevelForStyle("")).toBeNull();
  });
});

describe("htmlToDmd — notes", () => {
  it("relabels footnotes 1..n and endnotes i, ii and places definitions after the citing block", () => {
    const html =
      `<p>A${ref("footnote", 7, 1)} b${ref("endnote", 2, 2)} c${ref("footnote", 3, 3)}.</p>` +
      `<p>Další${ref("endnote", 5, 4)}.</p>` +
      `<ol>${note("footnote", 7, "Pozn. sedm.")}${note("endnote", 2, "Vysv. dvě.")}${note("footnote", 3, "Tři.", "Druhý odstavec.")}${note("endnote", 5, "Vysv. pět.")}</ol>`;
    const out = convert(html);
    expect(out.dmd).toBe(
      [
        "A[^1] b[^i] c[^2].",
        "",
        "[^1]: Pozn. sedm.",
        "[^i]: Vysv. dvě.",
        "[^2]: Tři.",
        "    Druhý odstavec.",
        "",
        "Další[^ii].",
        "",
        "[^ii]: Vysv. pět.",
      ].join("\n"),
    );
    expect(out).toMatchObject({ footnotes: 2, endnotes: 2, letterEndnotes: false });
    expect(out.parsed.footnotes.map((f) => [f.label, f.kind])).toEqual([
      ["1", "f"],
      ["i", "e"],
      ["2", "f"],
      ["ii", "e"],
    ]);
  });

  it("labels more than 17 endnotes with letters", () => {
    const refs = Array.from({ length: 18 }, (_, i) => ref("endnote", i + 1, i + 1)).join(" ");
    const notes = Array.from({ length: 18 }, (_, i) => note("endnote", i + 1, `V${i + 1}`)).join("");
    const out = convert(`<p>X ${refs}</p><ol>${notes}</ol>`);
    expect(out.letterEndnotes).toBe(true);
    expect(out.parsed.footnotes.map((f) => f.label).slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(out.parsed.footnotes[17].label).toBe("r");
  });

  it("puts the notes of a table after the whole table and of a list item after the item", () => {
    const html =
      `<table><tr><td><p>a${ref("footnote", 1, 1)}</p></td><td><p>b</p></td></tr><tr><td>c</td><td>d${ref("footnote", 2, 2)}</td></tr></table>` +
      `<ul><li>první${ref("footnote", 3, 3)}</li><li>druhá</li></ul>` +
      `<ol>${note("footnote", 1, "N1")}${note("footnote", 2, "N2")}${note("footnote", 3, "N3")}</ol>`;
    const out = convert(html);
    expect(out.dmd).toBe(
      ["| a[^1] | b |", "| --- | --- |", "| c | d[^2] |", "", "[^1]: N1", "[^2]: N2", "", "- první[^3]", "", "[^3]: N3", "", "- druhá"].join("\n"),
    );
    expect(out.parsed.blocks.map((b) => b.kind)).toEqual(["table", "fndefs", "para", "fndefs", "para"]);
  });

  it("writes a heading's note after the heading", () => {
    const out = convert(`<h2>Úvod${ref("footnote", 4, 1)}</h2><p>Text.</p><ol>${note("footnote", 4, "K nadpisu.")}</ol>`);
    expect(out.dmd).toBe("## Úvod[^1]\n\n[^1]: K nadpisu.\n\nText.");
    expect(out.parsed.sections[0].heading).toBe("Úvod");
  });

  it("drops a reference whose note body is missing and ignores the notes list as content", () => {
    const out = convert(`<p>A${ref("footnote", 9, 1)} b</p><ol>${note("footnote", 1, "osiřelá")}</ol>`);
    expect(out.dmd).toBe("A b");
    expect(out.footnotes).toBe(0);
  });

  it("escapes markup-looking text inside a note", () => {
    const out = convert(`<p>A${ref("footnote", 1, 1)}</p><ol>${note("footnote", 1, "Viz [s. 12] a [^9]: tamtéž.")}</ol>`);
    expect(out.dmd).toBe("A[^1]\n\n[^1]: Viz \\[s. 12] a \\[^9]: tamtéž.");
    expect(out.parsed.refs).toHaveLength(1);
  });

  it("splits a note longer than the parser's cap", () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const out = convert(`<p>A${ref("footnote", 1, 1)}</p><ol>${note("footnote", 1, long)}</ol>`);
    expect(out.overflowedNotes).toBe(1);
    const fn = out.parsed.footnotes[0];
    expect(fn.defEnd - fn.defStart).toBeLessThanOrEqual(DMD_LIMITS.maxFootnoteChars);
    expect(out.dmd).toContain("w2999");
  });

  it("treats only a list made entirely of note bodies as the notes list", () => {
    const html = `<ol><li id="${P}footnote-1">not really</li><li>obsah</li></ol>`;
    const out = convert(html);
    expect(out.dmd).toBe("not really\n\nobsah");
    expect(out.orderedItems).toBe(2);
  });
});

describe("htmlToDmd — structure", () => {
  it("maps h1–h6 and keeps multi-line paragraphs", () => {
    const out = convert("<h1>Název</h1><h3>Pod</h3><p>řádek 1<br />řádek 2<br /># ne nadpis</p>");
    expect(out.dmd).toBe("# Název\n\n### Pod\n\nřádek 1\nřádek 2\n\\# ne nadpis");
    expect(out.headings).toBe(2);
    expect(out.parsed.blocks.map((b) => b.kind)).toEqual(["heading", "heading", "para"]);
  });

  it("turns short bold article paragraphs into headings and joins a split title", () => {
    const html =
      "<p><strong>ČÁST PRVNÍ</strong></p>" +
      "<p><strong>Čl. I</strong></p><p><strong>Předmět smlouvy</strong></p>" +
      "<p>Obsah článku.</p>" +
      "<p><strong>Článek 2 – Cena</strong></p>" +
      "<p><strong>§ 5 zní takto:</strong></p>" +
      "<p>Čl. 3</p>" +
      "<p><strong>Čl.</strong> 4 napůl tučně</p>";
    const out = convert(html);
    expect(out.dmd).toBe(
      [
        "# ČÁST PRVNÍ",
        "",
        "## Čl. I – Předmět smlouvy",
        "",
        "Obsah článku.",
        "",
        "## Článek 2 – Cena",
        "",
        "§ 5 zní takto:",
        "",
        "Čl. 3",
        "",
        "Čl. 4 napůl tučně",
      ].join("\n"),
    );
    expect(out.parsed.sections.map((s) => s.key)).toEqual(["part:cast-prvni", "cl:I", "cl:2"]);
  });

  it("does not join a designator with a following body paragraph or another designator", () => {
    const out = convert("<p><strong>Čl. I</strong></p><p>Text, který není nadpis.</p><p><strong>Čl. II</strong></p><p><strong>Čl. III</strong></p>");
    expect(out.dmd).toBe("## Čl. I\n\nText, který není nadpis.\n\n## Čl. II\n\n## Čl. III");
  });

  it("demotes a heading over 300 chars to a paragraph", () => {
    const out = convert(`<h1>${"dlouhý ".repeat(60)}</h1>`);
    expect(out.headings).toBe(0);
    expect(out.parsed.sections).toHaveLength(0);
    expect(out.parsed.problems).toEqual([]);
  });

  it("writes unordered items with a dash, ordered items without their lost number, nested lists", () => {
    const html = "<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul><ol><li>jedna</li><li>dvě</li></ol><ul><li><ol><li>vnořená</li></ol></li></ul>";
    const out = convert(html);
    expect(out.dmd).toBe("- a\n\n- a1\n\n- b\n\njedna\n\ndvě\n\nvnořená");
    expect(out.orderedItems).toBe(3);
  });

  it("writes GFM tables with padding for merged cells and escaped pipes", () => {
    const out = convert(
      '<table><thead><tr><th>A</th><th>B|C</th><th>D</th></tr></thead><tbody><tr><td colspan="2"><p>spojené</p><p>dvě</p></td><td>x</td></tr><tr><td>jen jedna</td></tr></tbody></table>',
    );
    expect(out.dmd).toBe("| A | B\\|C | D |\n| --- | --- | --- |\n| spojené dvě | | x |\n| jen jedna | | |");
    expect(out.parsed.blocks.map((b) => b.kind)).toEqual(["table"]);
  });

  it("falls back to one text line per row when a row is too long for a table line", () => {
    const long = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" "); // ~23k chars
    const out = convert(
      `<table><tr><td>${long}</td><td>b${ref("footnote", 1, 1)}</td></tr><tr><td>c</td><td>d${ref("footnote", 2, 2)}</td></tr></table>` +
        `<ol>${note("footnote", 1, "N1")}${note("footnote", 2, "N2")}</ol>`,
    );
    expect(out.parsed.blocks.map((b) => b.kind)).toEqual(["para", "fndefs"]);
    expect(out.dmd).toContain("c · d[^2]");
  });

  it("unwraps one-column layout tables and skips empty ones", () => {
    const out = convert("<table><tr><td><p>Rámeček</p><p>druhý odstavec</p></td></tr></table><table><tr><td></td><td> </td></tr></table><p>konec</p>");
    expect(out.dmd).toBe("Rámeček\n\ndruhý odstavec\n\nkonec");
  });

  it("walks wrapper elements and loose text", () => {
    const out = convert("volný text<div><p>v divu</p><h2>nadpis</h2></div><span>jen span</span>");
    expect(out.dmd).toBe("volný text\n\nv divu\n\n## nadpis\n\njen span");
  });
});

describe("htmlToDmd — text hygiene", () => {
  it("escapes markup-looking text, also when split across formatting runs", () => {
    const out = convert("<p>Text [s. 5] a <strong>[</strong>^3] a [m. č. 2].</p><p># x</p><p>&gt; y</p><p>| z</p>");
    expect(out.dmd).toBe("Text \\[s. 5] a \\[^3] a \\[m. č. 2].\n\n\\# x\n\n\\> y\n\n\\| z");
    expect(out.parsed.refs).toHaveLength(0);
    expect(unescapeDmd(out.dmd)).toBe("Text [s. 5] a [^3] a [m. č. 2].\n\n# x\n\n> y\n\n| z");
  });

  it("keeps a backslash before a reference from escaping it", () => {
    const out = convert(`<p>cesta C:\\${ref("footnote", 1, 1)}</p><ol>${note("footnote", 1, "x")}</ol>`);
    expect(out.parsed.refs).toHaveLength(1);
    expect(out.parsed.footnotes[0].refAt).not.toBeNull();
  });

  it("normalizes placeholders and checkboxes, drops images and scripts", () => {
    const out = convert(
      '<p>Jméno: ______ dne …… <input type="checkbox" checked="checked" /> ano <input type="checkbox" /> ne [●]<img src="x.png" alt="logo" /><script>alert(1)</script></p>',
    );
    expect(out.dmd).toBe("Jméno: [____] dne [____] ☒ ano ☐ ne [●]");
    expect(out.placeholders).toBe(5);
  });

  it("keeps link text and drops note back-links", () => {
    const out = convert(`<p><a href="https://example.cz">odkaz</a> a <a href="#${P}_Toc1">obsah</a> <a href="#${P}footnote-ref-1">↑</a></p>`);
    expect(out.dmd).toBe("odkaz a obsah");
  });

  it("collapses whitespace but keeps non-breaking spaces", () => {
    const out = convert("<p>  a \n\t b   §\u00a05  </p>");
    expect(out.dmd).toBe("a b §\u00a05");
  });

  it("never mutates the tree it walks", () => {
    const root = body(`<p>A${ref("footnote", 1, 1)}</p><ul><li>x</li></ul><ol>${note("footnote", 1, "n")}</ol>`);
    const before = root.innerHTML;
    htmlToDmd(root);
    expect(root.innerHTML).toBe(before);
  });

  it("returns an empty document for empty input", () => {
    expect(htmlToDmd(body("")).dmd).toBe("");
  });
});

describe("convertDocx — fixtures", () => {
  it("converts the article with footnotes, endnotes, a note in a heading and in a table", async () => {
    const r = await convertDocx(load("clanek-poznamky.docx"), DEFAULT_CONVERT_OPTIONS);
    expect(r.dmd).toBe(
      [
        "# Odpovědnost za škodu v judikatuře",
        "",
        "JUDr. Jan Novák, Ph.D.",
        "",
        "# 1. Úvod",
        "",
        "Nejvyšší soud dovodil odpovědnost[^1] i tehdy, je-li škoda způsobena jinak[^i], a to s odkazem na doktrínu.[^2]",
        "",
        "[^1]: Srov. rozsudek NS ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019.",
        "[^i]: Vysvětlivka první.",
        "[^2]: MELZER, F. In: PETROV, J. a kol. Občanský zákoník. Komentář. 2. vyd. Praha: C. H. Beck, 2019.",
        "    Shodně též nález ÚS sp. zn. II. ÚS 1234/20.",
        "",
        "## 2. Judikatura[^3]",
        "",
        "[^3]: Poznámka v nadpisu.",
        "",
        "| Soud | Sp. zn. | Závěr |",
        "| --- | --- | --- |",
        "| NSS | 4 As 12/2019[^4] | zamítnuto |",
        "| Shrnutí přes dva sloupce | | — |",
        "",
        "[^4]: Viz rozhodnutí NSS 4 As 12/2019-45.",
        "",
        "Druhá vysvětlivka[^ii] a text za ní.",
        "",
        "[^ii]: Vysvětlivka druhá.",
        "",
        "## 3. Závěr",
        "",
        "Závěrem lze shrnout[^5].",
        "",
        "[^5]: Viz text \\[s. 12] a \\[^9]: tamtéž.",
      ].join("\n"),
    );
    const parsed = parseDmd(r.dmd);
    expect(parsed.stats).toMatchObject({ footnotes: 7, danglingRefs: 0, danglingDefs: 0, headings: 4 });
    expect(parsed.footnotes.filter((f) => f.kind === "e").map((f) => f.label)).toEqual(["i", "ii"]);
    expect(r).toMatchObject({
      kind: "docx",
      converter: "docx@1",
      labelSource: "none",
      physicalPages: null,
      pageFlags: [],
      pageLabels: [],
      warnings: [],
    });
    expect(r.quality).toMatchObject({ footnotes: "linked", linked_ratio: 1, headings_from: "docx", numbering: "ok" });
  });

  it("converts the template: placeholders, checkboxes, lost numbering, dropped comments, escapes", async () => {
    const r = await convertDocx(load("vzor-smlouva.docx"), DEFAULT_CONVERT_OPTIONS);
    const parsed = parseDmd(r.dmd);
    expect(parsed.stats.danglingRefs).toBe(0);
    expect(parsed.sections.map((s) => [s.level, s.heading])).toEqual([
      [1, "SMLOUVA O DÍLO"],
      [1, "Smluvní strany"],
      [1, "Předmět smlouvy"],
      [1, "Cena díla"],
      [2, "Článek V – Závěrečná ustanovení"],
    ]);
    expect(parsed.sections[4].key).toBe("cl:V");
    expect(r.dmd).toContain("uzavřená podle § 2586 a násl. zákona č. 89/2012 Sb., občanský zákoník[^1]\n\n[^1]: Poznámka k vzoru:");
    expect(r.dmd).toContain("Objednatel: [●], IČO: [●], se sídlem [____]");
    expect(r.dmd).toContain("Zhotovitel: [____], IČO: [●]"); // FORMTEXT en spaces
    expect(r.dmd).toContain("Zhotovitel se zavazuje provést dílo: [____]");
    expect(r.dmd).toContain("☒ cena včetně DPH\n\n☐ cena bez DPH");
    expect(r.dmd).toContain("- Příloha č. 1 – Rozpočet");
    expect(r.dmd).toContain("Pozor: text \\[s. 5] a \\[^3] a \\[m. č. 2] není značka.\n\n\\# 1 není nadpis\n\n\\> není citace\n\n\\| není tabulka |");
    expect(r.dmd).toContain("| V [●] dne [●] | V [●] dne [●] |\n| --- | --- |\n| [____] Objednatel | [____] Zhotovitel |");
    expect(r.dmd).not.toContain("INTERNÍ KOMENTÁŘ");
    expect(parsed.refs).toHaveLength(1);
    expect(parsed.problems).toEqual([]);

    expect(r.quality.numbering).toBe("lost");
    // 3 article headings ("Čl. %1") + 4 numbered odstavce.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^Automatické číslování .* 7 odstavcům nebo nadpisům chybí jejich čísla/);
  });

  it("rejects bytes that are not a Word document", async () => {
    const junk = new TextEncoder().encode("PK\u0003\u0004 not really a zip").buffer as ArrayBuffer;
    await expect(convertDocx(junk, DEFAULT_CONVERT_OPTIONS)).rejects.toMatchObject({ code: "broken" });
  });

  it("refuses to run without a DOM parser", async () => {
    const saved = globalThis.DOMParser;
    // @ts-expect-error — simulate a server / worker without DOMParser
    delete globalThis.DOMParser;
    try {
      await expect(convertDocx(load("clanek-poznamky.docx"), DEFAULT_CONVERT_OPTIONS)).rejects.toBeInstanceOf(ConvertError);
    } finally {
      globalThis.DOMParser = saved;
    }
  });
});

describe("htmlToDmd — adversarial input", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const TEXT = ["[", "]", "^", "[^1]", "[^1]: ", "s. ", "[s. 4]", "[m. č. 2] ", "#", "# ", "> ", "|", "\\", " ", "1", "ř", "⟦", "_____", "…", "Čl. I", "§ 5"];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("always yields parseable DMD with every reference bound and no structural problems", () => {
    const next = rng(7);
    for (let round = 0; round < 200; round++) {
      const blocks: string[] = [];
      const notes: string[] = [];
      let n = 0;
      const text = () => {
        let s = "";
        const len = 1 + Math.floor(next() * 8);
        for (let i = 0; i < len; i++) {
          const r = next();
          if (r < 0.1) {
            n++;
            const kind = next() < 0.7 ? "footnote" : "endnote";
            s += ref(kind, n, n);
            notes.push(note(kind, n, esc(TEXT[Math.floor(next() * TEXT.length)])));
          } else if (r < 0.2) s += `<strong>${esc(TEXT[Math.floor(next() * TEXT.length)])}</strong>`;
          else if (r < 0.25) s += "<br />";
          else s += esc(TEXT[Math.floor(next() * TEXT.length)]);
        }
        return s;
      };
      const count = 1 + Math.floor(next() * 6);
      for (let b = 0; b < count; b++) {
        const r = next();
        if (r < 0.5) blocks.push(`<p>${text()}</p>`);
        else if (r < 0.65) {
          const level = 1 + Math.floor(next() * 6);
          blocks.push(`<h${level}>${text()}</h${level}>`);
        }
        else if (r < 0.8) blocks.push(`<ul><li>${text()}</li><li>${text()}</li></ul>`);
        else blocks.push(`<table><tr><td>${text()}</td><td>${text()}</td></tr></table>`);
      }
      const html = blocks.join("") + (notes.length ? `<ol>${notes.join("")}</ol>` : "");
      const out = htmlToDmd(body(html));
      const parsed = parseDmd(out.dmd);
      expect(parsed.stats.danglingRefs, html).toBe(0);
      expect(parsed.stats.danglingDefs, html).toBe(0);
      expect(parsed.problems, html).toEqual([]);
      expect(parsed.stats.footnotes, html).toBe(out.footnotes + out.endnotes);
    }
  });
});
