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

  it("a hit whose excerpt holds none of the words is listed without it — the opening of a text is its letterhead", async () => {
    const letterhead = { ...HIT, id: "AA", caseNumber: "3 As 11/2011", excerpt: "ČESKÁ REPUBLIKA ROZSUDEK JMÉNEM REPUBLIKY", highlights: [] };
    fetchMock.mockImplementation(async () => json({ hits: [letterhead, HIT], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.ns_search({ query: "náhrada újmy", read_top: 1 }));
    expect(out).toContain("1. 3 As 11/2011");
    expect(out).not.toContain("JMÉNEM REPUBLIKY");
    expect(out).toContain("o «náhradě» újmy");
    // A list without words shows what the mirror sends for it (právní věta, výrok), which carries no marks.
    fetchMock.mockImplementation(async () => json({ hits: [{ ...letterhead, excerpt: "Dovolání se odmítá." }], channel: "ident", terms: [], total: 1 }));
    expect(textOf(await MIRROR_TOOLS.ns_search({ category: "A" }))).toContain("Dovolání se odmítá.");
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

  it("caselaw_search: a provision WITH words narrows the search to the decisions citing it; half a pair and an unreadable § are input errors", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.caselaw_search({ query: "neplacení nájemného", applies_act: "89/2012", applies_provision: "2291", sources: ["ns"] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    // One search: the words, with the cited provision as its filter — not a list of every citing decision.
    expect(url.pathname).toBe("/v1/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "neplacení nájemného", act: "89/2012", provision: "§ 2291", source: "ns" });
    expect(out).toContain('"neplacení nájemného" — among the decisions citing § 2291 of 89/2012');
    expect(out).toContain("7 Tdo 1517/2017");
    // EU law by name goes as one citation the mirror reads.
    fetchMock.mockClear();
    textOf(await MIRROR_TOOLS.caselaw_search({ query: "oprávněný zájem", applies_act: "GDPR", applies_provision: "čl. 6", sources: ["nss"] }));
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("cite")).toBe("čl. 6 GDPR");
    fetchMock.mockClear();
    for (const args of [{ applies_act: "89/2012" }, { query: "nájem", applies_act: "89/2012" }]) {
      const half = (await MIRROR_TOOLS.caselaw_search(args)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(half.isError).toBe(true);
      expect(half.content[0].text).toContain("go together");
    }
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

  it("justice_search: applies_act + applies_section is the mirror's cited-provision filter — alone a counted list, with words a search", async () => {
    const hit = { ...HIT, source: "justice", id: "u-1", caseNumber: "17 C 82/2026", court: "Okresní soud ve Vsetíně", category: null, form: "rozsudek", chars: 20_000, citedBy: 37 };
    fetchMock.mockImplementation(async () => json({ hits: [hit], channel: "ident", terms: [], total: 956 }));
    const out = textOf(await MIRROR_TOOLS.justice_search({ applies_act: "89/2012", applies_section: "§ 2291", limit: 1, page: 2, match: "all_words", sort: "published" }));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ act: "89/2012", provision: "§ 2291", source: "justice", sort: "newest", newest_by: "published", limit: "1", offset: "2" });
    expect(url.searchParams.has("q")).toBe(false);
    expect(out).toContain("JUSTICE: 956 decisions, newest first — 3–3");
    expect(out).toContain("3. 7 Tdo 1517/2017".replace("7 Tdo 1517/2017", "17 C 82/2026") + " (rozsudek, 2017-12-13) — Okresní soud ve Vsetíně · 1 str. · cit. 37× → caselaw_get_decision source: justice, id: u-1");
    expect(out).toContain("More: page: 3 (same arguments).");
    // With words: the same filter on a search by relevance.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ hits: [hit], channel: "and", terms: [] }));
    textOf(await MIRROR_TOOLS.justice_search({ query: "výpověď", applies_act: "89/2012", applies_section: "§ 2291", court_codes: ["KSBR"], types: ["JUDGEMENT", "RESOLUTION"], match: "phrase" }));
    expect(Object.fromEntries(new URL(String(fetchMock.mock.calls[0][0])).searchParams)).toMatchObject({
      q: "výpověď",
      act: "89/2012",
      provision: "§ 2291",
      court_code: "KSBR",
      type: "rozsudek,usneseni",
      match: "phrase",
      sort: "relevance",
    });
    // The act alone: every decision citing any provision of it.
    fetchMock.mockClear();
    textOf(await MIRROR_TOOLS.justice_search({ applies_act: "262/2006" }));
    const actOnly = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(actOnly.get("act")).toBe("262/2006");
    expect(actOnly.has("provision")).toBe(false);
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

  it("a query with search operators is the mirror's too: it is sent on as written, never to the live court", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const out = textOf(await MIRROR_TOOLS.ns_search({ query: '"smluvní pokuta" NOT nájem' }));
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("q")).toBe('"smluvní pokuta" NOT nájem');
    expect(out).toContain("7 Tdo 1517/2017");
    fetchMock.mockClear();
    textOf(await MIRROR_TOOLS.caselaw_search({ queries: ["nájem AND (výpověď OR odstoupení)", "promlč* NEAR námitka"], sources: ["ns"] }));
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("q")).sort()).toEqual(["nájem AND (výpověď OR odstoupení)", "promlč* NEAR námitka"]);
    // An expression that does not parse is the reader's to correct: the answer says what is wrong.
    // It never goes to the live court (the NS box guessed and answered "≥1000 matches").
    fetchMock.mockImplementation(async () => json({ error: "the query could not be read: a bracket is not closed" }, 400));
    for (const call of [MIRROR_TOOLS.ns_search({ query: "nájem AND (výpověď" }), MIRROR_TOOLS.caselaw_search({ query: "nájem AND (výpověď" })]) {
      const refused = (await call) as { isError?: boolean; content: Array<{ text: string }> };
      expect(refused).not.toHaveProperty("fallback");
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("The query could not be read — a bracket is not closed.");
      expect(refused.content[0].text).toContain("Correct the expression and call again");
    }
    // One unreadable variant among good ones costs only itself: the rest answer, and the line names it.
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).searchParams.get("q") === "újma" ? json({ hits: [HIT], channel: "and", terms: [] }) : json({ error: "the query could not be read: a bracket is not closed" }, 400),
    );
    const partial = textOf(await MIRROR_TOOLS.ns_search({ queries: ["újma", "nájem AND (výpověď"] }));
    expect(partial).toContain("7 Tdo 1517/2017");
    expect(partial).toContain("a bracket is not closed");
    // Something the mirror cannot do (not a mistake in the query) still goes to the court with the reason.
    fetchMock.mockImplementation(async () => json({ error: "search operators and the case filter do not combine" }, 400));
    expect(await MIRROR_TOOLS.ns_search({ query: "nájem NOT družstvo" })).toEqual({ fallback: expect.stringContaining("do not combine") });
    // And none of these refusals paused the mirror.
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    textOf(await MIRROR_TOOLS.ns_search({ query: "újma" }));
  });

  it("the mirror answers the courts' own filters and any page — the live court only what the mirror holds no data for", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "and", terms: [] }));
    const sent = async (call: Promise<unknown>): Promise<Record<string, string>> => {
      fetchMock.mockClear();
      textOf(await call);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      return Object.fromEntries(new URL(String(fetchMock.mock.calls[0][0])).searchParams);
    };
    // NS: a later page, the form, a lower court of its database, the web date.
    expect(await sent(MIRROR_TOOLS.ns_search({ query: "x", offset: 20, type: "usnesení", court: "Vrchní soud v Praze", published_from: "2026-11-01" }))).toMatchObject({
      offset: "20",
      type: "usneseni",
      court: "Vrchní soud v Praze",
      published_from: "2026-11-01",
    });
    // NSS: the kind of court, the registry, the area, the applied provision in each of its four kinds.
    expect(await sent(MIRROR_TOOLS.nss_search({ query: "x", court: "rozsireny-senat", registry: "Afs", page: 3 }))).toMatchObject({
      court_class: "rozsireny",
      regional: "1",
      registry: "Afs",
      offset: "40",
    });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_act: "150/2002", applies_provision: "82" }))).toMatchObject({ act: "150/2002", provision: "§ 82" });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_act: "280/2009", applies_provision: "17(2)(a)" }))).toMatchObject({ provision: "§ 17 odst. 2 písm. a)" });
    expect(await sent(MIRROR_TOOLS.nss_search({ query: "x", applies_eu_regulation: "2016/679", applies_provision: "čl. 6 odst. 1" }))).toMatchObject({ act: "32016R0679", provision: "čl. 6 odst. 1" });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_eu_regulation: "1049/2001" }))).toMatchObject({ act: "32001R1049" });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_eu_directive: "2004/48/ES", applies_provision: "8" }))).toMatchObject({ act: "32004L0048", provision: "čl. 8" });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_treaty: "209/1992" }))).toMatchObject({ act: "209/1992" });
    expect(await sent(MIRROR_TOOLS.nss_search({ applies_treaty: "10/2010", applies_provision: "3" }))).toMatchObject({ act: "sm:10/2010", provision: "čl. 3" });
    // ÚS: several forms, the collection, the web date, a later page.
    expect(await sent(MIRROR_TOOLS.us_search({ query: "x", types: ["nález", "stanovisko"], include_dissents: true, published_to: "2026-01-31", page: 2 }))).toMatchObject({
      type: "nalez,stanovisko",
      published_to: "2026-01-31",
      offset: "40",
    });
    // justice: how the words combine, the forms, a later page.
    expect(await sent(MIRROR_TOOLS.justice_search({ query: "x y", match: "any_word", types: ["ORDER_T"], limit: 10, page: 4 }))).toMatchObject({ match: "any", type: "jine", offset: "40", limit: "10" });
    // What the mirror never downloaded: the NALUS číselník fields. Those go to the court, before any request.
    fetchMock.mockClear();
    expect(await MIRROR_TOOLS.us_search({ query: "x", popular_name: "Data retention" })).toEqual({ fallback: 'the mirror has no "popular_name" filter' });
    expect(await MIRROR_TOOLS.us_search({ contested_act_number: "106/1999" })).toEqual({ fallback: 'the mirror has no "contested_act_number" filter' });
    expect(await MIRROR_TOOLS.us_search({ query: "x", judge: "Šimíček" })).toEqual({ fallback: 'the mirror has no "judge" filter' });
    // And two filters whose metadata the mirror holds for part of the decisions only: answering them
    // from it would silently leave the rest out.
    expect(await MIRROR_TOOLS.nss_search({ query: "x", area: "Pobyt cizinců" })).toEqual({ fallback: 'the mirror has no "area" filter' });
    expect(await MIRROR_TOOLS.us_search({ query: "x", only_published: true })).toEqual({ fallback: 'the mirror has no "only_published" filter' });
    // A call with nothing to search for and nothing to filter by: the live tool says what it needs.
    expect(await MIRROR_TOOLS.ns_search({ limit: 20, offset: 0 })).toEqual({ fallback: "no query, spisová značka or filter" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a filter-only call is a counted list, newest first, with the call for the next page", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [HIT, { ...HIT, id: "B".repeat(32), caseNumber: "31 Cdo 1/2024" }], channel: "ident", terms: [], total: 352 }));
    const out = textOf(await MIRROR_TOOLS.ns_search({ category: "A", date_from: "2024-01-01", limit: 2, offset: 4 }));
    const qs = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(qs.has("q")).toBe(false);
    expect(Object.fromEntries(qs)).toMatchObject({ category: "A", from: "2024-01-01", limit: "2", offset: "4" });
    expect(out).toContain("NS: 352 decisions, newest first — 5–6");
    expect(out).toContain("5. 7 Tdo 1517/2017");
    expect(out).toContain("6. 31 Cdo 1/2024");
    expect(out).toContain("More: offset: 6 (same arguments).");
    // The last page says nothing of a next one; an empty one says the list ended.
    fetchMock.mockImplementation(async () => json({ hits: [HIT], channel: "ident", terms: [], total: 5 }));
    expect(textOf(await MIRROR_TOOLS.ns_search({ category: "A", limit: 2, offset: 4 }))).not.toContain("More:");
    fetchMock.mockImplementation(async () => json({ hits: [], channel: "ident", terms: [], total: 5 }));
    expect(textOf(await MIRROR_TOOLS.ns_search({ category: "A", limit: 2, offset: 6 }))).toContain("No further hits");
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
    expect(out).toContain("1. 26 Cdo 4249/2016 (rozsudek, 2017-01-18) → caselaw_get_decision source: ns, id: BD87C5D0B5398F19C12580FF00256234");
  });

  it("caselaw_get_decision reads by spisová značka: one decision is read at once, several are listed, none goes to the court", async () => {
    const decision = { source: "ns", id: "AB", caseNumber: "31 Cdo 2273/2022", court: "Nejvyšší soud", form: "rozsudek", date: "2023-01-11", chars: 9000, citedBy: 417 };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/by-case") return json({ decisions: [decision] });
      if (url.pathname === "/v1/decisions/ns/AB") {
        return json({ source: "ns", id: "AB", caseNumbers: ["31 Cdo 2273/2022"], court: "Nejvyšší soud", form: "rozsudek", category: null, date: "2023-01-11", published: null, ecli: null, legalSentence: null, url: "https://nsoud.cz/x", goneAt: null, text: { text: "Soud moderuje smluvní pokutu.", page: 1, total_pages: 1 } });
      }
      return json({ error: "not found" }, 404);
    });
    const read = textOf(await MIRROR_TOOLS.caselaw_get_decision({ source: "ns", case_number: "31 Cdo 2273/2022", page: 1 }));
    expect(read).toContain("Soud moderuje smluvní pokutu.");
    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(paths[0].pathname).toBe("/v1/by-case");
    expect(paths[0].searchParams.get("case")).toBe("31 Cdo 2273/2022");
    expect(paths[0].searchParams.getAll("source")).toEqual(["ns"]);
    // Two decisions under one značka: the reader chooses, with the length and the citing count of each.
    fetchMock.mockImplementation(async () => json({ decisions: [decision, { ...decision, id: "CD", form: "usneseni", date: "2022-09-01", chars: 1500, citedBy: 0 }] }));
    const list = textOf(await MIRROR_TOOLS.caselaw_get_decision({ source: "ns", case_number: "31 Cdo 2273/2022" }));
    expect(list).toContain('2 NS decisions carry the spisová značka "31 Cdo 2273/2022"');
    expect(list).toContain("· cit. 417× → caselaw_get_decision source: ns, id: AB");
    expect(list).toContain("→ caselaw_get_decision source: ns, id: CD");
    // None: the live tool answers (it says how to look the značka up at the court).
    fetchMock.mockImplementation(async () => json({ decisions: [] }));
    expect(await MIRROR_TOOLS.caselaw_get_decision({ source: "nss", case_number: "1 As 1/2099" })).toEqual({
      fallback: 'the mirror holds no NSS decision with the spisová značka "1 As 1/2099"',
    });
    expect(await MIRROR_TOOLS.caselaw_get_decision({ source: "ns" })).toEqual({ fallback: "no id" });
  });

  it("a značka looked up by a search carries the length and the citing count", async () => {
    fetchMock.mockImplementation(async () =>
      json({ decisions: [{ source: "ns", id: "AB", caseNumber: "26 Cdo 4249/2016", court: "Nejvyšší soud", form: "rozsudek", date: "2017-01-18", chars: 5400, citedBy: 12 }] }),
    );
    const out = textOf(await MIRROR_TOOLS.ns_search({ case_number: "26 Cdo 4249/2016" }));
    expect(out).toContain("1. 26 Cdo 4249/2016 (rozsudek, 2017-01-18) · 1 str. · cit. 12× → caselaw_get_decision source: ns, id: AB");
  });

  it("an ÚS ecli is looked up the same way; a značka the mirror lacks, or one with other filters, goes to the court", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [{ source: "us", id: "Pl-24-10_1", caseNumber: "Pl. ÚS 24/10", court: null, form: "nalez", date: "2011-03-22" }] }));
    expect(textOf(await MIRROR_TOOLS.us_search({ ecli: "ECLI:CZ:US:2011:Pl.US.24.10.1", page: 0 }))).toContain("caselaw_get_decision source: us, id: Pl-24-10_1");
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe("/v1/by-case");
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ decisions: [] }));
    expect(await MIRROR_TOOLS.nss_search({ case_number: "1 As 113/2012", page: 1 })).toEqual({ fallback: 'the mirror holds no NSS decision with the spisová značka "1 As 113/2012"' });
    // A značka WITH words or filters stays in the mirror: it becomes the search's own-case filter.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ hits: [{ ...HIT, source: "justice", id: "u-9", caseNumber: "8 Co 60/2025", court: "Krajský soud v Brně" }], channel: "and", terms: [] }));
    const narrowed = textOf(await MIRROR_TOOLS.justice_search({ case_number: "8 Co 60/2025", query: "sazebník", date_from: "2025-01-01", page: 0 }));
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "sazebník", own_case: "8 Co 60/2025", from: "2025-01-01", source: "justice" });
    expect(url.searchParams.has("case")).toBe(false);
    expect(narrowed).toContain("8 Co 60/2025");
    // An ÚS ECLI with words: the same.
    fetchMock.mockClear();
    textOf(await MIRROR_TOOLS.us_search({ ecli: "ECLI:CZ:US:2011:Pl.US.24.10.1", query: "data retention" }));
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("own_case")).toBe("ECLI:CZ:US:2011:Pl.US.24.10.1");
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
    // applies_section without its act is an input error too — said here, not by the court.
    const lone = (await MIRROR_TOOLS.justice_search({ query: "x", applies_section: "§ 2201" })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(lone.isError).toBe(true);
    expect(lone.content[0].text).toContain("applies_section needs applies_act");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("euCelex reads the numbers the courts write: year/number, number/year before 2015, a community suffix", async () => {
    const { euCelex } = await import("@/src/mcp/tools/mirror-route");
    expect(euCelex("R", "2016/679")).toBe("32016R0679");
    expect(euCelex("R", "1049/2001")).toBe("32001R1049");
    expect(euCelex("R", "1907/2006")).toBe("32006R1907");
    expect(euCelex("R", "2015/2283")).toBe("32015R2283");
    expect(euCelex("L", "2004/48/ES")).toBe("32004L0048");
    expect(euCelex("L", "95/46/ES")).toBe("31995L0046");
    expect(euCelex("L", "12/34")).toBeNull();
    expect(euCelex("R", "GDPR")).toBeNull();
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

  it("a request that fails while the mirror answers another does not pause it", async () => {
    // Two searches open at once: the quick one is answered, the slow one then fails (a timeout, a reset).
    let failSlow: (error: Error) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("q=slow")) return new Promise<Response>((_, reject) => (failSlow = reject));
      return json({ hits: [HIT], channel: "and", terms: [] });
    });
    const slow = searchMirror({ q: "slow" }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await searchMirror({ q: "quick" });
    failSlow(new Error("The operation was aborted due to timeout"));
    expect(await slow).toBeInstanceOf(Error);
    // The mirror is still asked: it answered in the meantime, so only that one request failed.
    await searchMirror({ q: "next" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a mirror that keeps running out of time on searches is paused; a search that answers in between starts the count again", async () => {
    const slow = () => json({ error: "query timed out" }, 504);
    const fine = () => json({ hits: [], channel: null, terms: [] });
    const refused = () => searchMirror({ q: "x" }).catch((error: unknown) => error);
    // Four in a row, then one that answers: the mirror is still asked.
    for (let i = 0; i < 4; i++) fetchMock.mockResolvedValueOnce(slow());
    for (let i = 0; i < 4; i++) expect(await refused()).toBeInstanceOf(MirrorRefusal);
    fetchMock.mockResolvedValueOnce(fine());
    await searchMirror({ q: "x" });
    // Five in a row: paused, the sixth is not sent.
    for (let i = 0; i < 5; i++) fetchMock.mockResolvedValueOnce(slow());
    for (let i = 0; i < 5; i++) expect(await refused()).toBeInstanceOf(MirrorRefusal);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    await expect(searchMirror({ q: "x" })).rejects.toThrow("paused after a failure (5 searches in a row ran out of time)");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("a search tells the mirror how long it may run, less than this client waits", async () => {
    fetchMock.mockImplementation(async () => json({ hits: [], channel: null, terms: [] }));
    await searchMirror({ q: "újma" });
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("timeout_ms")).toBe("6000");
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
