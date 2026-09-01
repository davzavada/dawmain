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
