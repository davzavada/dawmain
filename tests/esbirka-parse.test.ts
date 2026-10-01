import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Count the cheerio conversions the §-scan runs (finding 7). The spy calls
// the real htmlToText, so every other behaviour is unchanged.
vi.mock("@/src/sources/shared/html", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/src/sources/shared/html")>();
  return { ...original, htmlToText: vi.fn(original.htmlToText) };
});

const html = await import("@/src/sources/shared/html");
const htmlToText = vi.mocked(html.htmlToText);

beforeEach(() => {
  delete process.env.ESBIRKA_API_KEY;
  vi.resetModules();
  htmlToText.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fragmentText is htmlToText, byte for byte", () => {
  const samples = [
    "",
    "Základní ustanovení",
    "  leading and trailing  ",
    "\n\n  § 3006\n",
    "a b  c",
    "tabs\t\tand   spaces",
    "one\n\n\n\nfour newlines",
    " \n x \n ",
    "form\ffeed",
    "\fleading form feed",
    "quote „Čl. 56“ – dash > gt ]]> -->",
    "žluťoučký kůň úpěl ďábelské ódy",
    "  nbsp-led",
    "\t\ttab-led",
    // Markup, entities, CR, NUL — the parser's work, not the fast path's.
    "<var>§ 1</var>",
    "Text <b>ustanovení</b>&nbsp;§&nbsp;7.",
    "a&amp;b",
    "a\r\nb",
    "a\rb",
    "nul\0byte",
    "<p>one</p><p>two</p>",
    "<textarea>t",
    "<!-- c",
    "x<table><tr><td>1</td></tr>",
    "a<br>b",
  ];

  it("on well-formed, malformed and plain samples", async () => {
    const { fragmentText } = await import("@/src/sources/esbirka");
    for (const sample of samples) expect(fragmentText(sample), JSON.stringify(sample)).toBe(htmlToText(sample));
  });

  it("parses plain text without the parser", async () => {
    const { fragmentText } = await import("@/src/sources/esbirka");
    htmlToText.mockClear();
    fragmentText("Základní ustanovení");
    expect(htmlToText).not.toHaveBeenCalled();
  });
});

describe("fragment text is converted only when read (finding 7)", () => {
  it("keeps eli and converts on first access", async () => {
    const { parseFragments } = await import("@/src/sources/esbirka");
    const page = parseFragments({
      pocetStranek: 1,
      seznam: [{ kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 7 zákona", xhtml: "<var>§ 7</var>", eli: "/eli/cz/sb/1993/31/dokument/norma/par_7" }],
    });
    expect(htmlToText).not.toHaveBeenCalled();
    expect(page.fragments[0].eli).toBe("/eli/cz/sb/1993/31/dokument/norma/par_7");
    expect(page.fragments[0].text).toBe("§ 7");
    expect(page.fragments[0].text).toBe("§ 7");
    expect(htmlToText).toHaveBeenCalledTimes(1);
  });

  it("a § scan converts the § it returns, not the pages it looks through", async () => {
    const page = (p: number) =>
      Array.from({ length: 100 }, (_, i) => p * 100 + i + 1).flatMap((n) => [
        { kodTypuFragmentu: "Paragraf", zkracenaCitace: `§ ${n} zákona č. 89/2012 Sb.`, xhtml: `<var>§ ${n}</var>` },
        { kodTypuFragmentu: "Odstavec_Dc", zkracenaCitace: `§ ${n} odst. 1 zákona č. 89/2012 Sb.`, xhtml: `<var>(1)</var> Text ${n}.` },
      ]);
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/sparql?")) return new Response("blocked", { status: 403 });
      const p = /cisloStranky=(\d+)/.exec(url)?.[1];
      if (p !== undefined) return new Response(JSON.stringify({ pocetStranek: 11, seznam: page(Number(p)) }));
      return new Response(JSON.stringify({ nazev: "Zákon", staleUrl: "/sb/2012/89/2026-01-01", typZneni: "AKTUALNI" }));
    });
    const { getSection } = await import("@/src/sources/esbirka");
    htmlToText.mockClear();
    const result = await getSection("sb", 2012, 89, undefined, "§ 950");
    expect(result.text).toBe("§ 950\n(1) Text 950.");
    expect(htmlToText).toHaveBeenCalledTimes(2);
  });
});
