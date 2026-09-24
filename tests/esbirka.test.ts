import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStaleUrl,
  normalizeSectionLabel,
  parseActDetail,
  parseFragments,
  parseHistory,
  parseSearch,
} from "@/src/sources/esbirka";
import { SourceError } from "@/src/sources/shared/errors";

// Shapes are verbatim from docs/research/cz-sources.json (official OpenAPI +
// working client code). Marked synthetic: hand-assembled, not captured live.

describe("buildStaleUrl", () => {
  it("builds plain and dated identifiers", () => {
    expect(buildStaleUrl("sb", 2012, 89)).toBe("/sb/2012/89");
    expect(buildStaleUrl("sb", 1993, 1, "2026-01-01")).toBe("/sb/1993/1/2026-01-01");
  });
});

describe("normalizeSectionLabel", () => {
  it("strips the § sign and whitespace", () => {
    expect(normalizeSectionLabel("§ 12")).toBe("12");
    expect(normalizeSectionLabel("§3a")).toBe("3a");
    expect(normalizeSectionLabel("129b")).toBe("129b");
  });
});

describe("parseSearch", () => {
  // synthetic
  const payload = {
    pocetCelkem: 42,
    seznam: [
      {
        staleUrl: "/sb/2012/89",
        nazev: "Zákon občanský zákoník",
        kodDokumentuSbirky: "z89-2012",
        stavDokumentuSbirky: "PLATNY",
        datum: "2012-03-22",
      },
    ],
    fazetovyFiltr: {},
  };

  it("maps the seznam items", () => {
    const result = parseSearch(payload);
    expect(result.total).toBe(42);
    expect(result.items[0]).toEqual({
      staleUrl: "/sb/2012/89",
      nazev: "Zákon občanský zákoník",
      kod: "z89-2012",
      stav: "PLATNY",
      datum: "2012-03-22",
    });
  });

  it("throws PARSE_DRIFT when seznam is missing", () => {
    expect(() => parseSearch({ nonsense: true })).toThrowError(SourceError);
    try {
      parseSearch({});
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
  });
});

describe("parseActDetail", () => {
  it("extracts the known metadata fields", () => {
    // synthetic
    const detail = parseActDetail({
      staleUrl: "/sb/2012/89",
      nazev: "Zákon občanský zákoník",
      eli: "https://opendata.eselpoint.gov.cz/esel-esb/eli/cz/sb/2012/89",
      uplnaCitace: "Zákon č. 89/2012 Sb., občanský zákoník",
      datumUcinnostiOd: "2014-01-01",
      typZneni: "KONSOLIDOVANE",
      novely: [],
    });
    expect(detail.nazev).toContain("občanský zákoník");
    expect(detail.uplnaCitace).toContain("89/2012 Sb.");
  });

  it("throws PARSE_DRIFT for an unrecognizable object", () => {
    expect(() => parseActDetail({ foo: 1 })).toThrowError(SourceError);
  });
});

describe("parseHistory", () => {
  it("maps version entries and tolerates missing fields", () => {
    // synthetic
    const versions = parseHistory({
      historie: [
        { datumUcinnostiZneniOd: "2014-01-01", datumUcinnostiZneniDo: "2016-12-31", cisloZneni: 1 },
        { datumUcinnostiZneniOd: "2017-01-01", typZneni: "NOVELIZOVANE" },
      ],
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].datumUcinnostiOd).toBe("2014-01-01");
    expect(versions[1].typZneni).toBe("NOVELIZOVANE");
  });

  it("returns [] when historie is absent", () => {
    expect(parseHistory({})).toEqual([]);
  });
});

describe("parseFragments", () => {
  it("converts xhtml to text and keeps citations", () => {
    // synthetic — fragment fields verbatim from the OpenAPI definition
    const result = parseFragments({
      pocetStranek: 3,
      seznam: [
        {
          id: 1,
          kodTypuFragmentu: "Paragraf",
          zkracenaCitace: "§ 7 odst. 5 zákona č. 31/1993 Sb.",
          xhtml: "<p>Text <b>ustanovení</b>&nbsp;§&nbsp;7.</p>",
          hloubka: 2,
        },
      ],
    });
    expect(result.totalPages).toBe(3);
    expect(result.fragments[0].text).toBe("Text ustanovení § 7.");
    expect(result.fragments[0].zkracenaCitace).toContain("§ 7");
  });
});

/**
 * e-Sbírka runs two channels: the registered API (keyed) and the SPA's keyless
 * gateway, which serves the same paths. The point of the second is that a
 * refusal by the first does not end the request — so every way the keyed host
 * can refuse has to reach the gateway, not just a bad key.
 */
describe("keyed → keyless channel fallback", () => {
  const ACT = JSON.stringify({ nazev: "Občanský zákoník", staleUrl: "/sb/2012/89" });
  const KEYED = "api.e-sbirka.gov.cz";
  const KEYLESS = "sbr-cache";

  beforeEach(() => {
    process.env.ESBIRKA_API_KEY = "test-key";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.ESBIRKA_API_KEY;
    vi.unstubAllGlobals();
  });

  /** Stub the keyed host with `keyedResponse`; the gateway always answers. */
  async function getActWith(keyedResponse: () => Response): Promise<string[]> {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return String(url).includes(KEYED) ? keyedResponse() : new Response(ACT, { status: 200 });
    });
    const { getAct } = await import("@/src/sources/esbirka");
    const act = await getAct("/sb/2012/89");
    expect(act.nazev).toBe("Občanský zákoník");
    return calls;
  }

  it("falls back when the key is rejected (401)", async () => {
    const calls = await getActWith(() => new Response("no", { status: 401 }));
    expect(calls.some((url) => url.includes(KEYLESS))).toBe(true);
  });

  it("falls back when the keyed host is down (500)", async () => {
    const calls = await getActWith(() => new Response("boom", { status: 500 }));
    expect(calls.some((url) => url.includes(KEYLESS))).toBe(true);
  });

  it("falls back on a redirect the keyed channel must not follow", async () => {
    // redirect:"manual" is deliberate — following it would forward the API key
    // cross-origin. The 3xx that comes back still has to reach the gateway.
    const calls = await getActWith(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    expect(calls.some((url) => url.includes(KEYLESS))).toBe(true);
  });

  it("does NOT retry a 404 on the gateway — the document simply does not exist", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response("missing", { status: 404 });
    });
    const { getAct } = await import("@/src/sources/esbirka");
    await expect(getAct("/sb/2012/99999")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(calls.filter((url) => url.includes(KEYLESS))).toHaveLength(0);
  });
});

describe("renderFragments / chunkFragments", () => {
  it("opens a § after a blank line with its own label — no repeated citation heading", async () => {
    const { renderFragments } = await import("@/src/sources/esbirka");
    const text = renderFragments([
      { text: "HLAVA I", kodTypuFragmentu: "Nadpis", zkracenaCitace: "zákon č. 89/2012 Sb." },
      { text: "§ 1", kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 1 zákona č. 89/2012 Sb." },
      { text: "(1) Ustanovení právního řádu…", kodTypuFragmentu: "Odstavec_Dc" },
      { text: "", kodTypuFragmentu: "Virtual_Norma" },
    ]).join("\n");
    expect(text).toBe("HLAVA I\n\n§ 1\n(1) Ustanovení právního řádu…");
    expect(text).not.toContain("zákona č. 89/2012 Sb.");
  });

  it("cuts pages at fragment boundaries and splits only an oversized fragment", async () => {
    const { chunkFragments } = await import("@/src/sources/esbirka");
    expect(chunkFragments(["aaaa", "bbbb", "cccc"], 9)).toEqual(["aaaa\nbbbb", "cccc"]);
    expect(chunkFragments(["x".repeat(20)], 8)).toEqual(["xxxxxxxx", "xxxxxxxx", "xxxx"]);
    expect(chunkFragments([], 8)).toEqual([""]);
  });
});

describe("parseSectionLabel", () => {
  it("tells sections from articles", async () => {
    const { parseSectionLabel } = await import("@/src/sources/esbirka");
    expect(parseSectionLabel("§ 2291")).toEqual({ kind: "paragraph", value: "2291" });
    expect(parseSectionLabel("390a")).toEqual({ kind: "paragraph", value: "390a" });
    expect(parseSectionLabel("čl. 36")).toEqual({ kind: "article", value: "36" });
    expect(parseSectionLabel("Čl. I")).toEqual({ kind: "article", value: "I" });
    expect(parseSectionLabel("článek 10a")).toEqual({ kind: "article", value: "10a" });
    expect(parseSectionLabel("čl. ii")).toEqual({ kind: "article", value: "II" });
    expect(parseSectionLabel("odst. 2")).toBeNull();
    expect(parseSectionLabel("§ 12; DROP")).toBeNull();
  });
});

// Line layout verbatim from the live Listina text (esbirka_get_text 1993/2,
// 2026-09): "Čl. N" alone on a line, paragraphs "(N) …", two-line HLAVA
// headings, lowercase cross-references inside the text.
const LISTINA = [
  "Čl. 35",
  "(1) Každý má právo na příznivé životní prostředí.",
  "HLAVA PÁTÁ",
  "PRÁVO NA SOUDNÍ A JINOU PRÁVNÍ OCHRANU",
  "Čl. 36",
  "(1) Každý se může domáhat stanoveným postupem svého práva u nezávislého a nestranného soudu a ve stanovených případech u jiného orgánu.",
  "(2) Kdo tvrdí, že byl na svých právech zkrácen rozhodnutím orgánu veřejné správy, může se obrátit na soud, … podle Listiny.",
  "(3) Každý má právo na náhradu škody způsobené mu nezákonným rozhodnutím soudu, … nesprávným úředním postupem.",
  "(4) Podmínky a podrobnosti upravuje zákon.",
  "Čl. 37",
  "(1) Každý má právo odepřít výpověď, … viz čl. 36 odst. 1.",
].join("\n");

describe("extractArticle", () => {
  it("cuts one article from its heading to the next heading", async () => {
    const { extractArticle } = await import("@/src/sources/esbirka");
    const found = extractArticle(LISTINA, "36");
    expect(found?.closed).toBe(true);
    expect(found?.text.split("\n")[0]).toBe("Čl. 36");
    expect(found?.text).toContain("(4) Podmínky a podrobnosti upravuje zákon.");
    expect(found?.text).not.toContain("Čl. 37");
  });

  it("stops before a structural heading, and never matches a cross-reference", async () => {
    const { extractArticle } = await import("@/src/sources/esbirka");
    expect(extractArticle(LISTINA, "35")?.text).toBe(
      "Čl. 35\n(1) Každý má právo na příznivé životní prostředí.",
    );
    expect(extractArticle("… viz čl. 36 odst. 1.", "36")).toBeNull();
    expect(extractArticle(LISTINA, "37")?.closed).toBe(false);
  });
});

/**
 * Which time version a § comes from. The open data's "latest version" of
 * the Civil Code is the one from 2027-01-01, not yet in force — the version
 * has to be settled through the REST detail before anything is read.
 */
describe("getSection reads the version in force", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const detail = {
    nazev: "Zákon občanský zákoník",
    staleUrl: "/sb/2012/89/2026-01-01",
    datumUcinnostiZneniOd: "2026-01-01",
    datumUcinnostiZneniDo: "2026-12-31",
    typZneni: "AKTUALNI",
  };
  const fragments = {
    pocetStranek: 1,
    seznam: [
      { kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 2291 zákona č. 89/2012 Sb.", xhtml: "§ 2291" },
      {
        kodTypuFragmentu: "Odstavec_Dc",
        zkracenaCitace: "§ 2291 odst. 1 zákona č. 89/2012 Sb.",
        xhtml: "(1) Poruší-li nájemce svou povinnost zvlášť závažným způsobem…",
      },
      { kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 2292 zákona č. 89/2012 Sb.", xhtml: "§ 2292" },
    ],
  };

  it("resolves the current version, asks SPARQL only for that exact version, and reports it", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      calls.push(url);
      if (url.includes("/sparql?")) {
        return new Response(JSON.stringify({ results: { bindings: [] } }), {
          headers: { "content-type": "application/sparql-results+json" },
        });
      }
      if (url.includes("/fragmenty")) return new Response(JSON.stringify(fragments));
      return new Response(JSON.stringify(detail));
    });
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 2012, 89, undefined, "§ 2291");
    expect(result.via).toBe("scan");
    expect(result.text).toContain("zvlášť závažným způsobem");
    expect(result.text).not.toContain("§ 2292");
    expect(result.version).toMatchObject({ staleUrl: "/sb/2012/89/2026-01-01", from: "2026-01-01", type: "AKTUALNI" });
    const sparql = calls.find((url) => url.includes("/sparql?")) ?? "";
    expect(sparql).toContain("/sb/2012/89/2026-01-01>");
    expect(sparql).not.toContain("má-poslední-znění");
    expect(calls.some((url) => url.includes("/sb/2012/89/2026-01-01/fragmenty"))).toBe(true);
  });

  it("reads an article out of the text", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/fragmenty")) {
        return new Response(
          JSON.stringify({
            pocetStranek: 1,
            seznam: LISTINA.split("\n").map((line) => ({
              kodTypuFragmentu: "Odstavec_Dc",
              zkracenaCitace: "Usnesení Předsednictva České národní rady č. 2/1993 Sb.",
              xhtml: line,
            })),
          }),
        );
      }
      return new Response(JSON.stringify({ nazev: "Listina", staleUrl: "/sb/1993/2/2021-10-01", typZneni: "AKTUALNI" }));
    });
    const { getSection } = await import("@/src/sources/esbirka");
    const result = await getSection("sb", 1993, 2, undefined, "čl. 36");
    expect(result.via).toBe("text");
    expect(result.text.startsWith("Čl. 36\n(1) Každý se může domáhat")).toBe(true);
  });
});

describe("getActText pages the whole act to what a client accepts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("splits oversized upstream pages and walks on across them", async () => {
    // Two upstream pages of ~70k characters each → four pages of ≤ 45k.
    const upstream = (page: number) => ({
      pocetStranek: 2,
      seznam: Array.from({ length: 70 }, (_, i) => ({
        kodTypuFragmentu: "Odstavec_Dc",
        xhtml: `${page}-${i} ${"x".repeat(990)}`,
      })),
    });
    vi.stubGlobal("fetch", async (input: string) => {
      const page = Number(/cisloStranky=(\d+)/.exec(String(input))?.[1] ?? 0);
      return new Response(JSON.stringify(upstream(page)));
    });
    const { getActText } = await import("@/src/sources/esbirka");
    const first = await getActText("/sb/2000/1", 1);
    expect(first.text.length).toBeLessThanOrEqual(45_000);
    expect(first.hasMore).toBe(true);
    expect(first.totalPagesExact).toBe(false);
    const third = await getActText("/sb/2000/1", 3);
    expect(third.text.startsWith("1-0 ")).toBe(true);
    expect(third.totalPagesExact).toBe(true);
    expect(third.totalPages).toBe(4);
    const last = await getActText("/sb/2000/1", 99);
    expect(last.page).toBe(4);
    expect(last.hasMore).toBe(false);
  });
});

describe("searchActs requires all words through the advanced endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends all_words as fulltextVsechnaSlova, never the simple search", async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: { body?: string }) => {
      bodies.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ pocetCelkem: 0, seznam: [] }));
    });
    const { searchActs } = await import("@/src/sources/esbirka");
    await searchActs("zvlášť závažným způsobem nájemce", 0, 5);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toContain("/rozsirena-vyhledavani");
    expect(JSON.parse(bodies[0].body)).toMatchObject({ fulltextVsechnaSlova: "zvlášť závažným způsobem nájemce" });
  });
});
