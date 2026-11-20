// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sanitizeRendered } from "@/app/_zdroje/sanitize-rendered";

function render(html: string, css = ""): { body: HTMLElement; styles: HTMLElement } {
  const body = document.createElement("div");
  body.innerHTML = html;
  const styles = document.createElement("div");
  styles.innerHTML = css;
  return { body, styles };
}

describe("sanitizeRendered — a rendered Word file is inert", () => {
  it("drops what runs or embeds, and every event handler", () => {
    const { body } = render(
      '<section class="fp-docx"><p onclick="x()" ONMOUSEOVER="y()">text</p><script>alert(1)</script><iframe srcdoc="<b>"></iframe>' +
        '<object data="x"></object><embed src="x"><form action="/api"><input></form><svg><foreignObject><p>in</p></foreignObject><a xlink:href="javascript:1">s</a></svg>' +
        '<img src="x" onerror="z()"><base href="//evil"></section>',
    );
    sanitizeRendered(body);
    expect(body.querySelector("script, iframe, object, embed, form, base, foreignObject")).toBeNull();
    const handlers = [...body.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.name.toLowerCase())).filter((n) => n.startsWith("on"));
    expect(handlers).toEqual([]);
    expect(body.querySelector("svg a")?.getAttribute("xlink:href")).toBeNull();
    expect(body.textContent).toContain("text");
  });

  it("keeps inline images, web links and anchors; drops scripted and foreign-scheme URLs", () => {
    const { body } = render(
      '<img id="ok" src="data:image/png;base64,AAAA"><img id="svg" src="data:image/svg+xml;base64,AAAA"><img id="html" src="data:text/html,<script>">' +
        '<a id="web" href="https://example.cz/x">w</a><a id="frag" href="#fn1">f</a><a id="js" href=" JavaScript:alert(1)">j</a><a id="vb" href="vbscript:x">v</a>',
    );
    sanitizeRendered(body);
    const attr = (id: string, name: string) => body.querySelector(`#${id}`)?.getAttribute(name);
    expect(attr("ok", "src")).toBe("data:image/png;base64,AAAA");
    expect(attr("svg", "src")).toBeNull();
    expect(attr("html", "src")).toBeNull();
    expect(attr("web", "href")).toBe("https://example.cz/x");
    expect(attr("frag", "href")).toBe("#fn1");
    expect(attr("js", "href")).toBeNull();
    expect(attr("vb", "href")).toBeNull();
  });

  it("styles keep their layout and lose what reaches outside the document", () => {
    const { body, styles } = render(
      '<p id="a" style="color: red; margin-left: 2pt">a</p><p id="b" style="background: url(https://evil/x.png)">b</p><p id="c" style="background-image: url(data:image/png;base64,AA)">c</p>',
      '<style>@import url("https://evil/a.css"); .fp-docx p { color: #000; background: url(https://evil/t.gif) } @font-face { src: url(data:font/ttf;base64,AA) }</style>',
    );
    sanitizeRendered(body, styles);
    expect(body.querySelector("#a")?.getAttribute("style")).toContain("margin-left");
    expect(body.querySelector("#b")?.getAttribute("style")).toBeNull();
    expect(body.querySelector("#c")?.getAttribute("style")).toContain("data:image/png");
    const css = styles.querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("evil");
    expect(css).not.toContain("@import");
    expect(css).toContain("color: #000");
    expect(css).toContain("data:font/ttf");
  });
});
