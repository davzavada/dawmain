import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Articles of an amending act. Shape from the live fragments of ústavní
 * zákon 71/2012 Sb., version 2013-03-08 (probed 2026-09): every fragment
 * carries its designation in `eli` (…/novela/cl_1/bod_2, Roman I as 1), and
 * e-Sbírka serves "Čl. II Účinnost" BETWEEN point 3 and points 4–13 of čl. I.
 */

const BASE = "/eli/cz/sb/2012/71/2013-03-08/dokument";
const ACT = "ústavního zákona č. 71/2012 Sb.";

function f(eli: string, kodTypuFragmentu: string, xhtml: string | undefined, zkracenaCitace: string) {
  return { eli: `${BASE}${eli}`, kodTypuFragmentu, zkracenaCitace, ...(xhtml !== undefined ? { xhtml } : {}) };
}

const bod = (n: number, text: string) => f(`/novela/cl_1/bod_${n}`, "Bod_Dd", `<var>${n}.</var> ${text}`, `Čl. 1 bod ${n} ${ACT}`);

const HEAD = [
  f("", "Virtual_Document", undefined, "Ústavní zákon č. 71/2012 Sb."),
  f("/prefix/frag_1", "Prefix_Type", "ÚSTAVNÍ ZÁKON", "Ústavní zákon č. 71/2012 Sb."),
  f("/prefix/frag_2", "Prefix", "Parlament se usnesl na tomto ústavním zákoně České republiky:", "Ústavní zákon č. 71/2012 Sb."),
  f("/novela", "Virtual_Novela", undefined, "Ústavní zákon č. 71/2012 Sb."),
];
const CL_I_START = [
  f("/novela/cl_1", "Clanek", "<var>Čl. I</var>", `Čl. 1 ${ACT}`),
  f("/novela/cl_1/frag_1", "Odstavec_Dc", "Ústavní zákon č. 1/1993 Sb., Ústava České republiky, se mění takto:", `Čl. 1 ${ACT}`),
  bod(1, "V čl. 54 odstavec 2 zní:"),
  f("/novela/cl_1/bod_1/frag_2", "Odstavec_Dc", "„<var>(2)</var> Prezident republiky je volen v přímých volbách.“.", `Čl. 1 bod 1 ${ACT}`),
  bod(2, "Čl. 56 zní:"),
  f("/novela/cl_1/bod_2/frag_3", "Clanek", "<var>„Čl. 56</var>", `Čl. 1 bod 2 ${ACT}`),
  f("/novela/cl_1/bod_2/frag_4", "Odstavec_Dc", "<var>(1)</var> Volba prezidenta republiky se koná tajným hlasováním.", `Čl. 1 bod 2 ${ACT}`),
  bod(3, "Čl. 58 zní:"),
  f("/novela/cl_1/bod_3/frag_5", "Odstavec_Dc", "„(1) Podrobnosti stanoví zákon.“.", `Čl. 1 bod 3 ${ACT}`),
];
const CL_II = [
  f("/novela/cl_2", "Clanek", "<var>Čl. II</var>", `Čl. 2 ${ACT}`),
  f("/novela/cl_2/nadpis", "Nadpis", "Účinnost", `Čl. 2 ${ACT}`),
  f("/novela/cl_2/frag_7", "Odstavec_Dc", "Tento ústavní zákon nabývá účinnosti dnem 1. října 2012.", `Čl. 2 ${ACT}`),
];
const CL_I_LATE = [bod(4, "V čl. 59 odst. 1 se slova … nahrazují slovy …."), bod(13, "V čl. 87 odst. 1 písm. i) se slova … zrušují.")];
const SIGNATURE = [f("/zaver/frag_9", "Odstavec_Dc", "Němcová v. r.", "Ústavní zákon č. 71/2012 Sb.")];

function serve(pages: unknown[][]): number[] {
  const fetched: number[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = decodeURIComponent(String(input));
    const page = /cisloStranky=(\d+)/.exec(url)?.[1];
    if (page !== undefined) {
      fetched.push(Number(page));
      return new Response(JSON.stringify({ pocetStranek: pages.length, seznam: pages[Number(page)] ?? [] }));
    }
    return new Response(JSON.stringify({ nazev: "Ústavní zákon", staleUrl: "/sb/2012/71/2013-03-08", typZneni: "AKTUALNI" }));
  });
  return fetched;
}

beforeEach(() => {
  delete process.env.ESBIRKA_API_KEY;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("articles by their designation (finding 1)", () => {
  const ONE_PAGE = [[...HEAD, ...CL_I_START, ...CL_II, ...CL_I_LATE, ...SIGNATURE]];

  it("čl. I keeps the points e-Sbírka serves after čl. II", async () => {
    serve(ONE_PAGE);
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 2012, 71, undefined, "čl. I");
    expect(result.via).toBe("scan");
    expect(result.text.split("\n")[0]).toBe("Čl. I");
    expect(result.text).toContain("3. Čl. 58 zní:");
    expect(result.text).toContain("4. V čl. 59 odst. 1");
    expect(result.text).toContain("13. V čl. 87 odst. 1");
    expect(result.text).not.toContain("Účinnost");
    expect(result.text).not.toContain("Němcová");
  });

  it("čl. II is its own fragments only — not the late points of čl. I", async () => {
    serve(ONE_PAGE);
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 2012, 71, undefined, "čl. II");
    expect(result.text).toBe("Čl. II\nÚčinnost\nTento ústavní zákon nabývá účinnosti dnem 1. října 2012.");
  });

  it("an arabic label finds the same article", async () => {
    serve(ONE_PAGE);
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 2012, 71, undefined, "čl. 1");
    expect(result.text).toContain("13. V čl. 87 odst. 1");
  });

  it("a quoted „Čl. 56 inside a point is never taken for článek 56", async () => {
    serve(ONE_PAGE);
    const { getSection } = await import("@/src/sources/esbirka");
    await expect(getSection("sb", 2012, 71, undefined, "čl. 56")).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("follows the article onto the next page, and stops at the first page without it", async () => {
    const CL_III = [
      f("/novela/cl_3", "Clanek", "<var>Čl. III</var>", `Čl. 3 ${ACT}`),
      f("/novela/cl_3/frag_8", "Odstavec_Dc", "Přechodné ustanovení.", `Čl. 3 ${ACT}`),
    ];
    const pages = [[...HEAD, ...CL_I_START, ...CL_II], [...CL_I_LATE], [...CL_III], [...SIGNATURE], [...SIGNATURE]];
    const fetched = serve(pages);
    const { getSection } = await import("@/src/sources/esbirka");
    const first = await getSection("sb", 2012, 71, undefined, "čl. I");
    expect(first.text).toContain("13. V čl. 87 odst. 1");
    expect(first.text).not.toContain("Přechodné ustanovení");
    // Page 0 ends outside čl. I: page 1 alone; it ends inside: then a batch, stopped at page 2.
    expect([...new Set(fetched)].sort()).toEqual([0, 1, 2, 3, 4]);
    const third = await getSection("sb", 2012, 71, undefined, "čl. III");
    expect(third.text).toBe("Čl. III\nPřechodné ustanovení.");
  });

  it("falls back to the text when the designation does not name the article", async () => {
    // Designated act, but "Čl. 10a" carries no cl_10a segment.
    const page = [
      ...HEAD,
      f("/novela/cl_1", "Clanek", "<var>Čl. 10</var>", `Čl. 1 ${ACT}`),
      f("/novela/cl_1/frag_1", "Odstavec_Dc", "Text článku 10.", `Čl. 1 ${ACT}`),
      f("/novela/frag_2", "Clanek", "Čl. 10a", ACT),
      f("/novela/frag_3", "Odstavec_Dc", "Text článku 10a.", ACT),
      f("/novela/frag_4", "Clanek", "Čl. 11", ACT),
    ];
    serve([page]);
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 2012, 71, undefined, "čl. 10a");
    expect(result).toMatchObject({ via: "text", text: "Čl. 10a\nText článku 10a." });
  });
});

describe("articleSegment", () => {
  it("maps Roman labels to the arabic eli number and keeps the rest", async () => {
    const { articleSegment } = await import("@/src/sources/esbirka");
    expect(["I", "II", "IV", "IX", "XIV", "XL", "XCIX"].map(articleSegment)).toEqual(["1", "2", "4", "9", "14", "40", "99"]);
    expect(articleSegment("10a")).toBe("10a");
    expect(articleSegment("36")).toBe("36");
  });
});
