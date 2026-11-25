import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIRROR_TOOLS } from "@/src/mcp/tools/mirror-route";
import { JUSTICE_COURT_CODES } from "@/src/sources/justice";
import { markedExcerpt, mirrorConfig, MirrorRefusal, mirrorProvisions, resetMirrorBreaker, searchMirror } from "@/src/sources/mirror";

const HIT = {
  source: "ns",
  id: "CD001AB3CD24B0BFC12582390057DA50",
  caseNumber: "7 Tdo 1517/2017",
  court: "Nejvyšší soud",
  form: "usneseni",
  category: "C",
  date: "2017-12-13",
  published: null,
  ecli: null,
  url: "https://rozhodnuti.nsoud.cz/x",
  score: 1,
  excerpt: "o náhradě újmy",
  highlights: [[2, 9]],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("MIRROR_API_URL", "https://mirror.test/");
  vi.stubEnv("MIRROR_API_TOKEN", "t0ken");
  vi.stubEnv("MIRROR_CF_ACCESS_CLIENT_ID", "id");
  vi.stubEnv("MIRROR_CF_ACCESS_CLIENT_SECRET", "secret");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  resetMirrorBreaker();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function textOf(answer: unknown): string {
  expect(answer).not.toHaveProperty("fallback");
  return (answer as { content: Array<{ text: string }> }).content[0].text;
}

describe("mirror client", () => {
  it("needs both URL and token; sends the Access pair only when complete", () => {
    expect(mirrorConfig({ MIRROR_API_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(mirrorConfig({ MIRROR_API_URL: "https://x/", MIRROR_API_TOKEN: "t", MIRROR_CF_ACCESS_CLIENT_ID: "a" } as unknown as NodeJS.ProcessEnv)).toEqual({
      url: "https://x",
      token: "t",
    });
  });

  it("briefExcerpt: one line around the first match, cut at words", async () => {
    const { briefExcerpt } = await import("@/src/mcp/tools/mirror-route");
    expect(briefExcerpt({ excerpt: "o náhradě újmy", highlights: [[2, 9]] })).toBe("o «náhradě» újmy");
    const long = `${"úvodní slova ".repeat(40)}výpověď z nájmu bytu ${"další text ".repeat(40)}`;
    const at = long.indexOf("výpověď");
    const brief = briefExcerpt({ excerpt: long, highlights: [[at, at + 7]] });
    expect(brief.length).toBeLessThanOrEqual(222);
    expect(brief).toContain("«výpověď» z nájmu bytu");
    expect(brief.startsWith("…")).toBe(true);
    expect(brief.endsWith("…")).toBe(true);
  });

  it("briefExcerpt: the stretch with the most different query words, not the first marked one", async () => {
    const { briefExcerpt } = await import("@/src/mcp/tools/mirror-route");
    // The parties' addresses come first ("bytem" = residing at); the passage on the question sits further on.
    const head = "žalobců a) R. R., b) T. R., všech bytem XY, zastoupených advokátem se sídlem v Podbořanech, ";
    const filler = "proti žalované o určení neplatnosti a o zaplacení částky s příslušenstvím, o dovolání žalobců proti rozsudku krajského soudu ".repeat(3);
    const passage = "výpověď z nájmu bytu pro neplacení nájemného je oprávněná";
    const excerpt = `${head}${filler}${passage} a dále`;
    const mark = (word: string, from = 0): [number, number] => [excerpt.indexOf(word, from), excerpt.indexOf(word, from) + word.length];
    const at = excerpt.indexOf(passage);
    const brief = briefExcerpt({ excerpt, highlights: [mark("bytem"), mark("výpověď", at), mark("nájmu", at), mark("bytu", at), mark("nájemného", at)] });
    expect(brief).toContain("«výpověď» z «nájmu» «bytu» pro neplacení «nájemného»");
    expect(brief).not.toContain("«bytem»");
  });

  it("courtLabel, sizeNote, citedByLine: what a line says beside the značka", async () => {
    const { courtLabel, sizeNote, citedByLine, citedByCourts } = await import("@/src/mcp/tools/mirror-route");
    expect(courtLabel({ source: "ns", court: "Nejvyšší soud" })).toBeNull();
    expect(courtLabel({ source: "us", court: "Ústavní soud – plénum" })).toBeNull();
    expect(courtLabel({ source: "nss", court: "Nejvyšší správní soud (tříčlenný senát NSS)" })).toBeNull();
    expect(courtLabel({ source: "nss", court: "Nejvyšší správní soud (7členný RS NSS)" })).toBe("rozšířený senát");
    expect(courtLabel({ source: "nss", court: "Krajský soud v Brně" })).toBe("Krajský soud v Brně");
    expect(courtLabel({ source: "justice", court: "Okresní soud v Kolíně" })).toBe("Okresní soud v Kolíně");
    expect(sizeNote(12_000)).toBe("1 str.");
    expect(sizeNote(45_000)).toBe("1 str.");
    expect(sizeNote(100_000)).toBe("~3 str.");
    expect(sizeNote(null)).toBeNull();
    expect(sizeNote(undefined)).toBeNull();
    expect(citedByCourts({ justice: 32, ns: 4, us: 1 })).toBe("ÚS 1, NS 4, obecné soudy 32");
    expect(citedByLine({ total: 37, bySource: { justice: 32, ns: 4, us: 1 }, top: 1 }, "ns", "AB")).toBe(
      "Citováno: 37× (ÚS 1, NS 4, obecné soudy 32; of them 1 stanovisko / plénum ÚS / velký senát NS / rozšířený senát NSS) → caselaw_citations source: ns, id: AB",
    );
    expect(citedByLine({ total: 0, bySource: {}, top: 0 }, "ns", "AB")).toContain("necituje");
  });

  it("a refused call (400, 504) is a MirrorRefusal and leaves the breaker shut", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "provision must be like par:2913/o1 or § 2913 odst. 1" }, 400));
    const refused = await mirrorProvisions({ act: "89/2012", provision: "???" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MirrorRefusal);
    expect((refused as MirrorRefusal).status).toBe(400);
    expect((refused as MirrorRefusal).message).toContain("provision must be like");
    fetchMock.mockResolvedValueOnce(json({ error: "query timed out" }, 504));
    expect(await mirrorProvisions({ act: "89/2012", provision: "§ 237" }).catch((error: unknown) => error)).toBeInstanceOf(MirrorRefusal);
    // The mirror is still asked: neither refusal paused it.
    fetchMock.mockResolvedValueOnce(json({ hits: [], channel: null, terms: [] }));
    await searchMirror({ q: "újma" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("marks highlights", () => {
    expect(markedExcerpt({ excerpt: "o náhradě újmy", highlights: [[2, 9]] })).toBe("o «náhradě» újmy");
  });
});

describe("mirror routing", () => {
  it("caselaw_search: one request per court and variant, Access headers on each, ids in the live get_* form", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ queries: ["újma", "náhrada újmy"], per_source_limit: 2, read_top: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://mirror.test/v1/search?")).toBe(true);
    expect(init.headers).toMatchObject({ authorization: "Bearer t0ken", "cf-access-client-id": "id", "cf-access-client-secret": "secret" });
    expect(out).toContain("caselaw_get_decision source: ns, id: CD001AB3CD24B0BFC12582390057DA50");
    expect(out).toContain("«náhradě»");
  });

  it("a hit line: no link, no court that goes without saying, the length and the citing count, and the legend once", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [{ ...HIT, chars: 100_000, citedBy: 37 }], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.ns_search({ query: "náhrada újmy" }));
    expect(out).toContain("1. 7 Tdo 1517/2017 [C] (usnesení, 2017-12-13) · ~3 str. · cit. 37× → caselaw_get_decision source: ns, id: CD001AB3CD24B0BFC12582390057DA50");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("— Nejvyšší soud");
    expect(out.match(/str\. = pages/g)).toHaveLength(1);
    // An API that predates the facts: the line simply has none.
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    expect(textOf(await MIRROR_TOOLS.ns_search({ query: "újma" }))).toContain("(usnesení, 2017-12-13) → caselaw_get_decision source: ns");
  });

  it("says when no decision held all the words of any variant, and when the list is full", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "or", terms: [] }));
    const loose = textOf(await MIRROR_TOOLS.caselaw_search({ query: "výpověď z nájmu bytu neplacení nájemného", per_source_limit: 1 }));
    expect(loose).toContain("✓ NS: the best 1 (there may be more — narrow rather than page) ⚠ no decision holds ALL the words");
    fetchMock.mockImplementation(async (url: string) => json({ hits: [HIT], channel: url.includes("q=%C3%BAjma") ? "and" : "or", terms: [] }));
    const mixed = textOf(await MIRROR_TOOLS.caselaw_search({ queries: ["újma", "náhrada nemajetkové újmy pozůstalých"], per_source_limit: 5 }));
    expect(mixed).toContain("✓ NS: 1 (per variant: 1 · 1 any-word)");
    expect(mixed).not.toContain("no decision holds ALL");
  });

  const PROVISION_HIT = {
    source: "ns",
    id: "ABAC1831AC9B92B5C125824E0041B784",
    caseNumber: "26 Cdo 4848/2016",
    court: "Nejvyšší soud",
    form: "rozsudek",
    category: "B",
    date: "2017-12-13",
    url: "https://rozhodnuti.nsoud.cz/y",
    mentions: 3,
    excerpt: "než je tomu u výpovědního důvodu podle § 2291 odst. 1, 2 o. z. (výpověď bez výpovědní doby)",
    citedBy: 37,
    chars: 20_000,
  };

  it("caselaw_search by provision: one request per court, the most cited first, no query needed", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json({ act: "zak:89/2012", provision: "par:2291", total: url.includes("source=ns&") ? 412 : 0, sortedBy: "cited", hits: url.includes("source=ns&") ? [PROVISION_HIT] : [] }),
    );
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ applies_act: "89/2012", applies_provision: "§ 2291", date_from: "2014-01-01" }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.every((url) => url.startsWith("https://mirror.test/v1/provisions?") && url.includes("sort=cited") && url.includes("from=2014-01-01"))).toBe(true);
    expect(urls.map((url) => new URL(url).searchParams.get("source")).sort()).toEqual(["ns", "nss", "us"]);
    expect(out).toContain("Decisions citing § 2291 of 89/2012 (decided 2014-01-01 – …):");
    expect(out).toContain("✓ NS: 412 decisions cite it — most cited first");
    expect(out).toContain("1. [NS] 26 Cdo 4848/2016 [B] (rozsudek, 2017-12-13) · 1 str. · cit. 37× · names the provision 3× → caselaw_get_decision source: ns, id: ABAC1831AC9B92B5C125824E0041B784");
    expect(out).toContain("   …než je tomu u výpovědního důvodu podle § 2291");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("NOT applied");
  });

  it("caselaw_search by provision: words next to it are named as not applied; half a pair and an unreadable § are input errors", async () => {
    fetchMock.mockImplementation(async () => json({ act: "a", provision: "p", total: 1, sortedBy: "cited", hits: [PROVISION_HIT] }));
    const withWords = textOf(await MIRROR_TOOLS.caselaw_search({ query: "neplacení nájemného", applies_act: "89/2012", applies_provision: "2291", sources: ["ns"] }));
    expect(withWords).toContain("The query words were NOT applied");
    expect(withWords).toContain(`query: '"§ 2291" neplacení nájemného'`);
    // A provision without its mark takes the one the act uses.
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("provision")).toBe("§ 2291");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    const half = (await MIRROR_TOOLS.caselaw_search({ applies_act: "89/2012" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(half.isError).toBe(true);
    expect(half.content[0].text).toContain("go together");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => json({ error: "provision must be like par:2913/o1 or § 2913 odst. 1" }, 400));
    const bad = (await MIRROR_TOOLS.caselaw_search({ applies_act: "89/2012", applies_provision: "???" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("provision must be like");
  });

  it("provisionRequest: Sbírka numbers and CELEX are ids, EU law and treaties by name go as a citation", async () => {
    const { provisionRequest } = await import("@/src/mcp/tools/mirror-route");
    expect(provisionRequest("89/2012", "2291")).toEqual({ act: "89/2012", provision: "§ 2291" });
    expect(provisionRequest(" 89/2012 Sb. ", "§ 2291 odst. 2")).toEqual({ act: "89/2012", provision: "§ 2291 odst. 2" });
    expect(provisionRequest("2/1993", "čl. 36")).toEqual({ act: "2/1993", provision: "čl. 36" });
    expect(provisionRequest("sm:12/2005", "3")).toEqual({ act: "sm:12/2005", provision: "čl. 3" });
    expect(provisionRequest("32016R0679", "6")).toEqual({ act: "eu:32016R0679", provision: "čl. 6" });
    expect(provisionRequest("eu:12016E/TXT", "článek 267")).toEqual({ act: "eu:12016E/TXT", provision: "čl. 267" });
    expect(provisionRequest("GDPR", "6 odst. 1 písm. f)")).toEqual({ cite: "čl. 6 odst. 1 písm. f) GDPR" });
    expect(provisionRequest("SFEU", "art. 267")).toEqual({ cite: "čl. 267 SFEU" });
    expect(provisionRequest("Listina EU", "čl. 47")).toEqual({ cite: "čl. 47 Listina EU" });
    expect(provisionRequest("směrnice 2004/48/ES", "8")).toEqual({ cite: "čl. 8 směrnice 2004/48/ES" });
    expect(provisionRequest("nařízení (EU) 2016/679", "čl. 6")).toEqual({ cite: "čl. 6 nařízení (EU) 2016/679" });
    // The parser reads the official form only: "(EU)" is added where the caller left it out.
    expect(provisionRequest("nařízení 2016/679", "čl. 6")).toEqual({ cite: "čl. 6 nařízení (EU) 2016/679" });
    expect(provisionRequest("směrnice 2016/1148", "14")).toEqual({ cite: "čl. 14 směrnice (EU) 2016/1148" });
    expect(provisionRequest("o. z.", "2291")).toEqual({ cite: "§ 2291 o. z." });
    // An EU number alone: never read as "act 2016 of the year 1148", and the kind cannot be guessed.
    expect(provisionRequest("2016/1148", "čl. 14")).toEqual(expect.stringContaining("does not say which act"));
    expect(provisionRequest("2016/679", "čl. 6")).toEqual(expect.stringContaining("nařízení (EU) 2016/679"));
  });

  it("caselaw_search by provision takes EU law by name: one citation for the mirror to read, the resolved act in the answer", async () => {
    fetchMock.mockImplementation(async () => json({ act: "eu:32016R0679", provision: "cl:6", total: 12, sortedBy: "cited", hits: [{ ...PROVISION_HIT, source: "nss", id: "7", caseNumber: "1 As 1/2020", court: "Nejvyšší správní soud" }] }));
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ applies_act: "GDPR", applies_provision: "čl. 6", sources: ["nss"] }));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("cite")).toBe("čl. 6 GDPR");
    expect(url.searchParams.has("act")).toBe(false);
    expect(out).toContain("Decisions citing čl. 6 GDPR (CELEX 32016R0679):");
    expect(out).toContain("caselaw_get_decision source: nss, id: 7");
    fetchMock.mockClear();
    const refused = (await MIRROR_TOOLS.caselaw_search({ applies_act: "2016/1148", applies_provision: "čl. 14" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("does not say which act");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caselaw_search by provision: a count that runs out of time is asked again newest first", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("sort=cited") ? json({ error: "query timed out" }, 504) : json({ act: "a", provision: "p", total: 90_000, hits: [PROVISION_HIT] }),
    );
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ applies_act: "99/1963", applies_provision: "§ 237", sources: ["ns"] }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("sort=newest");
    expect(out).toContain("✓ NS: 90000 decisions cite it — newest first (too many to order by citations — narrow with dates)");
  });

  it("justice_search by provision alone is answered from the mirror; with words it goes to the court", async () => {
    fetchMock.mockImplementation(async () =>
      json({ act: "a", provision: "p", total: 956, sortedBy: "newest", hits: [{ ...PROVISION_HIT, source: "justice", id: "u-1", caseNumber: "17 C 82/2026", court: "Okresní soud ve Vsetíně", category: null }] }),
    );
    const out = textOf(await MIRROR_TOOLS.justice_search({ applies_act: "89/2012", applies_section: "§ 2291", limit: 1, page: 2, match: "all_words", sort: "published" }));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/provisions");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ act: "89/2012", provision: "§ 2291", source: "justice", sort: "newest", limit: "1", offset: "2" });
    expect(out).toContain("Obecné soudy citing § 2291 of 89/2012: 956 decisions, newest first — 3–3.");
    expect(out).toContain("3. 17 C 82/2026 (rozsudek, 2017-12-13) — Okresní soud ve Vsetíně · 1 str. · cit. 37× · names the provision 3× → caselaw_get_decision source: justice, id: u-1");
    expect(out).toContain("More: page: 3 (same arguments).");
    expect(await MIRROR_TOOLS.justice_search({ query: "výpověď", applies_act: "89/2012", applies_section: "§ 2291" })).toEqual({
      fallback: 'the mirror has no "applies_act" filter',
    });
  });

  it("caselaw_search notes the CJEU instead of dropping it silently; CJEU alone goes live", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [], channel: null, terms: [] }));
    expect(textOf(await MIRROR_TOOLS.caselaw_search({ query: "újma", include_eu: true }))).toContain("sdeu_search");
    expect(await MIRROR_TOOLS.caselaw_search({ query: "újma", sources: ["sdeu"] })).toHaveProperty("fallback");
  });

  it("include_eu: the CJEU lane is asked of the court in the same call, beside the mirror's lanes", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const live = vi.fn(async (_args: Record<string, unknown>) => ({ content: [{ type: "text", text: "✓ SDEU: 12 matches\n1. [SDEU] C-311/18 (judgment, 2020-07-16) → sdeu_get_document ecli: ECLI:EU:C:2020:559" }] }));
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ query: "předávání osobních údajů", include_eu: true, eu_court: "C", per_source_limit: 3 }, live));
    // The live tool is asked for the CJEU alone, with the call's own arguments.
    expect(live).toHaveBeenCalledTimes(1);
    expect(live.mock.calls[0][0]).toMatchObject({ query: "předávání osobních údajů", sources: ["sdeu"], include_eu: true, eu_court: "C", per_source_limit: 3 });
    expect(out).toContain("✓ NS:");
    expect(out).toContain("── SDEU — answered live by the court");
    expect(out).toContain("sdeu_get_document ecli: ECLI:EU:C:2020:559");
    expect(out).not.toContain("did not answer");
    // The court failing costs the lane, not the answer.
    const failing = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "InfoCuria is down" }] }));
    const partial = textOf(await MIRROR_TOOLS.caselaw_search({ query: "újma", include_eu: true }, failing));
    expect(partial).toContain("– SDEU: did not answer just now — search it with sdeu_search.");
    expect(partial).toContain("✓ NS:");
    // Without include_eu nobody asks the court.
    const untouched = vi.fn();
    await MIRROR_TOOLS.caselaw_search({ query: "újma" }, untouched);
    expect(untouched).not.toHaveBeenCalled();
  });

  it("a query in the courts' search syntax goes to the court: the mirror reads words and phrases only", async () => {
    const { hasSearchOperators } = await import("@/src/mcp/tools/mirror-route");
    expect(hasSearchOperators(['"smluvní pokuta" NOT nájem'])).toBe(true);
    expect(hasSearchOperators(["nájem AND (výpověď OR odstoupení)"])).toBe(true);
    expect(hasSearchOperators(["nájem*"])).toBe(true);
    expect(hasSearchOperators(["újma NEAR pozůstalý"])).toBe(true);
    // Plain words, phrases, lower-case "not"/"or" and a question mark inside a phrase are not syntax.
    expect(hasSearchOperators(['"náhrada újmy" pozůstalým', "výpověď z nájmu bytu", "or not and", '"co je to?" výklad'])).toBe(false);
    expect(await MIRROR_TOOLS.ns_search({ query: '"smluvní pokuta" NOT nájem' })).toEqual({
      fallback: 'the mirror reads words and "phrases" only, not search operators (AND, OR, NOT, NEAR, *, brackets)',
    });
    expect(await MIRROR_TOOLS.caselaw_search({ queries: ["újma", "nájem*"] })).toHaveProperty("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back on what the mirror cannot do, before any request", async () => {
    expect(await MIRROR_TOOLS.ns_search({ query: "x", offset: 20 })).toEqual({ fallback: "the mirror answers the first page only" });
    expect(await MIRROR_TOOLS.nss_search({ query: "x", court: "krajske" })).toHaveProperty("fallback");
    expect(await MIRROR_TOOLS.us_search({ query: "x", judge: "Šimíček" })).toEqual({ fallback: 'the mirror has no "judge" filter' });
    expect(await MIRROR_TOOLS.justice_search({ query: "x", match: "phrase" })).toHaveProperty("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("case_number finds THAT decision (by-case), never the ones citing it", async () => {
    fetchMock.mockImplementation(async () =>
      json({ decisions: [{ source: "ns", id: "BD87C5D0B5398F19C12580FF00256234", caseNumber: "26 Cdo 4249/2016", court: "Nejvyšší soud", form: "rozsudek", date: "2017-01-18" }] }),
    );
    const out = textOf(await MIRROR_TOOLS.ns_search({ case_number: "26 Cdo 4249/2016", limit: 20, offset: 0, read_top: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/by-case");
    expect(url.searchParams.get("case")).toBe("26 Cdo 4249/2016");
    expect(url.searchParams.getAll("source")).toEqual(["ns"]);
    expect(out).toContain("1. 26 Cdo 4249/2016 (rozsudek, 2017-01-18) — Nejvyšší soud → caselaw_get_decision source: ns, id: BD87C5D0B5398F19C12580FF00256234");
  });

  it("an ÚS ecli is looked up the same way; a značka the mirror lacks, or one with other filters, goes to the court", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [{ source: "us", id: "Pl-24-10_1", caseNumber: "Pl. ÚS 24/10", court: null, form: "nalez", date: "2011-03-22" }] }));
    expect(textOf(await MIRROR_TOOLS.us_search({ ecli: "ECLI:CZ:US:2011:Pl.US.24.10.1", page: 0 }))).toContain("caselaw_get_decision source: us, id: Pl-24-10_1");
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe("/v1/by-case");
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ decisions: [] }));
    expect(await MIRROR_TOOLS.nss_search({ case_number: "1 As 113/2012", page: 1 })).toEqual({ fallback: 'the mirror holds no NSS decision with the spisová značka "1 As 113/2012"' });
    fetchMock.mockClear();
    expect(await MIRROR_TOOLS.justice_search({ case_number: "8 Co 60/2025", query: "sazebník", page: 0 })).toEqual({
      fallback: "the mirror looks a spisová značka up on its own, without other filters",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("justice_search: court_codes go to the mirror, with the other filters", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [{ ...HIT, source: "justice", id: "d2965a2d-ec0d-476b-983f-75e716972829", court: "Krajský soud v Brně" }], channel: "and", terms: [] }));
    const out = textOf(
      await MIRROR_TOOLS.justice_search({ query: "sazebník", match: "all_words", court_codes: ["ksbr", "KSBRJI", "KSBR"], date_from: "2025-01-01", date_to: "2025-06-30", page: 0 }),
    );
    expect(out).toContain("caselaw_get_decision source: justice, id: d2965a2d-ec0d-476b-983f-75e716972829");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const qs = new URL(fetchMock.mock.calls[0][0] as string).searchParams;
    expect(qs.get("court_code")).toBe("KSBR,KSBRJI");
    expect(qs.getAll("source")).toEqual(["justice"]);
    expect(qs.get("q")).toBe("sazebník");
    expect(qs.get("case")).toBeNull();
    expect(qs.get("from")).toBe("2025-01-01");
    expect(qs.get("to")).toBe("2025-06-30");
    // No codes, no parameter.
    await MIRROR_TOOLS.justice_search({ query: "sazebník", court_codes: [] });
    expect(new URL(fetchMock.mock.calls[1][0] as string).searchParams.has("court_code")).toBe(false);
  });

  it("justice_search: an unknown court code answers with the whole list, as live — no request, no fallback", async () => {
    const answer = (await MIRROR_TOOLS.justice_search({ query: "sazebník", court_codes: ["KSBR", "KSBRNO"] })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(answer).not.toHaveProperty("fallback");
    expect(answer.isError).toBe(true);
    expect(answer.content[0].text).toContain('"KSBRNO" is not a justice.cz court code.');
    expect(answer.content[0].text).toContain(`Valid codes: ${JUSTICE_COURT_CODES.join(", ")}.`);
    expect(fetchMock).not.toHaveBeenCalled();
    // Filters the mirror lacks still go live, where the same check runs.
    expect(await MIRROR_TOOLS.justice_search({ query: "x", court_codes: ["KSBR"], applies_act: "89/2012" })).toEqual({ fallback: 'the mirror has no "applies_act" filter' });
  });

  it("schema defaults do not count as filters", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [], channel: null, terms: [] }));
    const answer = await MIRROR_TOOLS.us_search({ query: "x", only_published: false, include_dissents: false, sort: "date", page: 0, read_top: 0 });
    expect(answer).not.toHaveProperty("fallback");
  });

  it("get_decision: joins the pages; a decision the mirror lacks goes live", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/v1/decisions/nss/1")) {
        const page = url.includes("page=2") ? 2 : 1;
        return json({
          source: "nss",
          id: "1",
          caseNumber: "1 As 1/2020",
          caseNumbers: ["1 As 1/2020"],
          court: "Nejvyšší správní soud",
          form: "rozsudek",
          category: null,
          date: "2020-01-01",
          published: null,
          ecli: null,
          legalSentence: null,
          url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/1",
          goneAt: null,
          text: { text: page === 1 ? "první " : "druhá", page, total_pages: 2 },
        });
      }
      return json({ error: "not found" }, 404);
    });
    const out = textOf(await MIRROR_TOOLS.caselaw_get_decision({ source: "nss", id: "1", page: 1 }));
    expect(out).toContain("první druhá");
    // An API that predates the citing counts: the header has no such line.
    expect(out).not.toContain("Citováno");
    expect(await MIRROR_TOOLS.caselaw_get_decision({ source: "nss", id: "2", page: 1 })).toEqual({
      fallback: "the mirror does not hold this decision (yet)",
    });
  });

  it("get_decision: the header says who cites the decision; outline returns its parts instead of the text", async () => {
    const body = [
      "Nejvyšší soud rozhodl ve věci žalobce proti žalované o zaplacení, takto:",
      "",
      "I. Dovolání se zamítá.",
      "II. Žádný z účastníků nemá právo na náhradu nákladů.",
      "",
      "Odůvodnění:",
      "",
      "I. Dosavadní průběh řízení",
      "1. Žalobce se domáhal zaplacení nájemného.",
      "2. Soud prvního stupně žalobě vyhověl.",
      "II. Posouzení věci",
      "3. Dovolání není důvodné.",
      "4. Nezaplacení nájemného je hrubým porušením povinnosti.",
      "",
      "Poučení: Proti tomuto rozsudku není opravný prostředek přípustný.",
    ].join("\n");
    fetchMock.mockImplementation(async () =>
      json({
        source: "ns",
        id: "AB",
        caseNumber: "26 Cdo 1/2020",
        caseNumbers: ["26 Cdo 1/2020"],
        court: "Nejvyšší soud",
        form: "rozsudek",
        category: "B",
        date: "2020-01-01",
        published: null,
        ecli: null,
        legalSentence: null,
        url: "https://rozhodnuti.nsoud.cz/z",
        goneAt: null,
        citedBy: { total: 5, bySource: { ns: 2, justice: 3 }, top: 0 },
        text: { text: body, page: 1, total_pages: 1 },
      }),
    );
    const read = textOf(await MIRROR_TOOLS.caselaw_get_decision({ source: "ns", id: "AB", page: 1 }));
    expect(read).toContain("Citováno: 5× (NS 2, obecné soudy 3) → caselaw_citations source: ns, id: AB");
    expect(read).toContain("https://rozhodnuti.nsoud.cz/z");
    const outline = textOf(await MIRROR_TOOLS.caselaw_get_decision({ source: "ns", id: "AB", page: 1, outline: true }));
    expect(outline).toContain("■ výrok");
    expect(outline).toContain("I. Dovolání se zamítá.");
    expect(outline).toMatch(/■ odůvodnění — \d+ znaků, body 1–4/);
    expect(outline).toContain("· I. Dosavadní průběh řízení — body 1–2");
    expect(outline).toContain("· II. Posouzení věci — body 3–4");
    expect(outline).toContain("An outline, not a reading");
    expect(outline).not.toContain("Dovolání není důvodné");
  });

  it("an Access refusal reads as such and goes live", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>login</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const answer = await MIRROR_TOOLS.ns_search({ query: "x" });
    expect((answer as { fallback: string }).fallback).toContain("Cloudflare Access");
  });
});

describe("breaker", () => {
  it("after a failure the mirror is skipped (no request) until the pause ends", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>login</html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(searchMirror({ q: "x" })).rejects.toThrow("Cloudflare Access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const answer = await MIRROR_TOOLS.ns_search({ query: "x" });
    expect((answer as { fallback: string }).fallback).toContain("paused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("every caller reads the mirror (no per-account switch)", () => {
  async function nsSearch(): Promise<(args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>> {
    const { registerAllTools } = await import("@/src/mcp/tools");
    let handler: ((args: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAllTools(
      {
        registerTool(name: string, _config: unknown, h: typeof handler) {
          if (name === "ns_search") handler = h;
        },
      } as never,
      { zotero: false },
    );
    return handler!;
  }

  it("a call with no signed-in user at all is answered from the mirror, not the court", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      expect(String(url)).toContain("mirror.test");
      return json({ total: 1, hits: [HIT] });
    });
    const result = await (await nsSearch())({ query: "náhrada újmy" }, {});
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("Dawmain mirror");
    expect(text).toContain("7 Tdo 1517/2017");
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("mirror.test"))).toBe(true);
  });

  it("without MIRROR_API_URL the live tool answers and the mirror is never asked", async () => {
    vi.stubEnv("MIRROR_API_URL", "");
    fetchMock.mockImplementation(async () => new Response("<html></html>", { status: 200 }));
    await (await nsSearch())({ query: "náhrada újmy" }, {});
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("mirror.test"))).toBe(false);
  });
});
