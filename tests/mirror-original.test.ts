import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { justiceOriginalHtml, nsOriginalHtml, nssOriginalHtml, usOriginalHtml } from "@/src/mirror/api/original";

/** The court's formatting from the stored source documents (decision_raw), against live captures. */

const fixture = (p: string) => readFileSync(`tests/fixtures/${p}`, "utf8");
const rule = { ord: 0, char_at: 0, mime: "image/png", width: 609, height: 1, bytes: new Uint8Array([1]) };

describe("ÚS (RTF in docContentHidden)", () => {
  it("keeps bold and paragraphs", () => {
    const html = usOriginalHtml(fixture("mirror/us-gettext-1-1169-26_1.html"), [])!;
    expect(html).toContain("<p><strong>Ústavní stížnost se odmítá.</strong></p>");
    expect(html).toContain("<p>Odůvodnění:</p>");
    expect(html).not.toMatch(/\\par|\\b/);
  });

  it("draws the picture before the dissent as the rule, and leaves out its fallback copy", () => {
    const html = usOriginalHtml(fixture("nalus/gettext-dissent-4-296-24_1.html"), [rule])!;
    expect(html).toMatch(/<hr class="dissent">\s*<p>Odlišné stanovisko<\/p>/);
    expect(html).not.toMatch(/pngblip|wmetafile|[0-9a-f]{64}/);
  });

  it("reads alignment, italics, underline and escapes", () => {
    const page = `<input id="docContentHidden" value="{\\qc \\b NÁLEZ\\b0\\par}\\pard \\i kurzíva\\i0 , \\ul podtržené\\ulnone \\'9a \\u345?\\par &lt;b&gt;">`;
    const html = usOriginalHtml(page, [])!;
    expect(html).toContain('<p class="al-center"><strong>NÁLEZ</strong></p>');
    // A control word eats the one space after it, as RTF says.
    expect(html).toContain("<em>kurzíva</em>, <u>podtržené</u>š ř");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("NS (WebSearch HTML)", () => {
  it("keeps the body's bold and centring, without the metadata and the citation note", () => {
    const html = nsOriginalHtml(fixture("ns-webprint-projednal.html"), [])!;
    expect(html).toContain('<p class="al-center"><strong>USNESENÍ</strong></p>');
    expect(html).toContain("<strong>odmítá</strong>");
    expect(html).toMatch(/<em>„V době od 31\. 5\. 2022/);
    const legacy = nsOriginalHtml(fixture("ns-websearch-legacy.html"), [])!;
    expect(legacy).not.toContain("Citace rozhodnutí Nejvyššího soudu");
    expect(legacy).not.toContain("Datum rozhodnutí");
    expect(legacy).toContain("<strong>ROZSUDEK</strong>");
  });
});

describe("NSS (Word HTML)", () => {
  it("keeps the allowlist only", () => {
    const html = nssOriginalHtml(
      `<html><head><style>p{}</style></head><body><p class=MsoNormal align=center style="x"><b><span style="font-size:12pt">ROZSUDEK</span></b></p>
       <p style="text-align:justify">Text s <a href="https://x">odkazem</a> a <i>kurzívou</i>, <script>alert(1)</script><img src="https://x/a.png"> konec.</p>
       <table><tr><td colspan=2 onclick="x">buňka</td></tr></table></body></html>`,
      [],
    )!;
    expect(html).toContain('<p class="al-center"><strong>ROZSUDEK</strong></p>');
    expect(html).toContain('<p class="al-justify">Text s odkazem a <em>kurzívou</em>,  konec.</p>');
    expect(html).toContain('<table><tr><td colspan="2">buňka</td></tr></table>');
    expect(html).not.toMatch(/script|alert|onclick|https:|class="MsoNormal"/);
  });
});

describe("justice (finaldoc JSON)", () => {
  it("builds paragraphs with their styles and marks anonymised text", () => {
    const html = justiceOriginalHtml(fixture("mirror/justice-finaldoc-d2965a2d.json"))!;
    expect(html).toContain('<span class="anon">Jméno žalobkyně</span>');
    expect(html).toMatch(/<p>I\. Žalovaný je povinen zaplatit/);
    expect(justiceOriginalHtml("not json")).toBeNull();
  });
});
