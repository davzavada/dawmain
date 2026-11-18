// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { docHtmlToReact } from "@/app/_zdroje/doc-preview";

const render = (html: string) => renderToStaticMarkup(createElement("div", null, ...docHtmlToReact(html)));

describe("DOCX preview: mammoth's HTML through a whitelist", () => {
  it("keeps formatting, drops scripts, handlers and unknown tags (their text stays)", () => {
    const out = render('<h1 onclick="x()">Nadpis</h1><p>Text <strong>tučně</strong><script>alert(1)</script></p><custom-el>vnitřek</custom-el><style>p{}</style>');
    expect(out).toBe("<div><h1>Nadpis</h1><p>Text <strong>tučně</strong></p>vnitřek</div>");
  });

  it("links only to http(s) and mailto, opening a new tab; javascript: loses its href", () => {
    expect(render('<a href="https://nsoud.cz">NS</a>')).toContain('href="https://nsoud.cz" target="_blank" rel="noopener noreferrer nofollow"');
    expect(render('<a href="javascript:alert(1)">x</a>')).toBe("<div><a>x</a></div>");
  });

  it("images only as raster data: URLs; table spans kept within bounds", () => {
    expect(render('<img src="https://evil.example/x.png"><img src="data:image/png;base64,AAAA" onerror="x()">')).toBe('<div><img src="data:image/png;base64,AAAA" alt=""/></div>');
    expect(render('<table><tbody><tr><td colspan="2" style="color:red">a</td></tr></tbody></table>')).toBe('<div><table><tbody><tr><td colSpan="2">a</td></tr></tbody></table></div>');
  });
});
