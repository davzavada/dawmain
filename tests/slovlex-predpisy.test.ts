import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildPredpisSearchUrl,
  findUnit,
  parseActText,
  parseHistory,
  parsePredpisSearch,
  parseSkSectionLabel,
  pickVersion,
  resolveVersion,
  unitText,
} from "@/src/sources/slovlex-predpisy";
import { registerSkPredpisy } from "@/src/mcp/tools/sk-predpisy";
import { foldText } from "@/src/sources/shared/text";

/**
 * Fixtures in tests/fixtures/slovlex/ are live captures (2026-11-17): the
 * Solr search answers (predpis-search-*.json), the history pages of 40/1964
 * Zb., 325/2025 Z. z. and 18/1996 Z. z., the text of 325/2025 (an AMENDING
 * act, wording from 2029-09-01) and of 18/1996 Z. z. o cenách (a principal
 * act: časti, §§ with nadpisy, odseky, písmená, footnotes; wording from
 * 2026-01-01).
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "slovlex", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

const HISTORY_40 = fixture("predpis-history-40-1964.html");
const HISTORY_325 = fixture("predpis-history-325-2025.html");
const HISTORY_18 = fixture("predpis-history-18-1996.html");
const TEXT_325 = fixture("predpis-text-325-2025-20290901.html");
const TEXT_18 = fixture("predpis-text-18-1996-20260101.html");

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools: Record<string, Handler> = {};
registerSkPredpisy({ registerTool: (name: string, _config: unknown, handler: Handler) => void (tools[name] = handler) } as never);

const SEARCH_18 = {
  numFound: 1,
  start: 0,
  docs: [
    {
      iri: "/SK/ZZ/1996/18/20260101",
      vyhlaseny: "1996-01-20T00:00:00Z",
      typPredp_value: "Zákon",
      rocnik: "1996",
      nazov: "Zákon Národnej rady Slovenskej republiky o cenách",
      cislo: "18/1996 Z. z.",
      ucinnyOd: "2026-01-01T00:00:00Z",
    },
  ],
};

/** Routes Slov-Lex URLs to fixtures; anything else is a 404 like the static host's. */
function stubSlovLex(): { urls: string[] } {
  const urls: string[] = [];
  const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const data = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      const routes: Record<string, () => Response> = {
        "https://static.slov-lex.sk/static/SK/ZZ/1964/40/": () => html(HISTORY_40),
        "https://static.slov-lex.sk/static/SK/ZZ/2025/325/": () => html(HISTORY_325),
        "https://static.slov-lex.sk/static/SK/ZZ/2025/325/20290901.html": () => html(TEXT_325),
        "https://static.slov-lex.sk/static/SK/ZZ/1996/18/": () => html(HISTORY_18),
        "https://static.slov-lex.sk/static/SK/ZZ/1996/18/20260101.html": () => html(TEXT_18),
      };
      if (routes[url]) return routes[url]();
      if (url.startsWith("https://api-gateway.slov-lex.sk/vyhladavanie/predpisZbierky/rozsirene")) {
        const params = new URL(url).searchParams;
        if (params.get("cislo") === "40/1964") return data(json("predpis-search-cislo.json"));
        if (params.get("cislo") === "18/1996") return data(SEARCH_18);
        if (params.get("text")) return data(json("predpis-search-text.json"));
        return data({ numFound: 1, start: Number(params.get("start")), docs: [] });
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
  return { urls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parsePredpisSearch", () => {
  it("reads the number search (one hit, the 132 nadpisy dropped without query terms)", () => {
    const page = parsePredpisSearch(json("predpis-search-cislo.json"));
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      citation: "40/1964 Zb.",
      year: 1964,
      number: 40,
      title: "Občiansky zákonník",
      type: "Zákon",
      published: "1964-03-05",
      version_from: "2026-07-31",
      version_to: "2027-06-30",
      iri: "/SK/ZZ/1964/40/20260731",
      url: "https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1964/40/20260731",
      headings: [],
    });
  });

  it("keeps at most 3 nadpisy that contain a query term (diacritics folded)", () => {
    const page = parsePredpisSearch(json("predpis-search-text.json"), ["nájom bytu"]);
    expect(page.total).toBe(22115);
    const oz = page.items[0];
    expect(oz.citation).toBe("40/1964 Zb.");
    expect(oz.headings.length).toBeGreaterThan(0);
    expect(oz.headings.length).toBeLessThanOrEqual(3);
    for (const heading of oz.headings) expect(/najo|bytu/.test(foldText(heading))).toBe(true);
  });

  it("reads the title search and the empty-query listing", () => {
    const byTitle = parsePredpisSearch(json("predpis-search-nazov.json"), ["Zákonník"]);
    expect(byTitle.total).toBe(338);
    expect(byTitle.items.map((i) => i.citation)).toContain("311/2001 Z. z.");
    const all = parsePredpisSearch(json("predpis-search-empty-query.json"));
    expect(all.total).toBe(26617);
    expect(all.items[0]).toMatchObject({ citation: "282/2026 Z. z.", type: "Oznámenie", headings: [] });
    expect(all.items[0].version_to).toBeUndefined();
  });

  it("refuses a body without numFound as drift", () => {
    expect(() => parsePredpisSearch({ error: "x" })).toThrow(/numFound/);
  });
});

describe("buildPredpisSearchUrl", () => {
  it("sends only the criteria given, the number in its working shape, rows and start", () => {
    const url = new URL(buildPredpisSearchUrl({ number: "40/1964 Zb.", query: " ", title: undefined }, 0, 1));
    expect(url.origin + url.pathname).toBe("https://api-gateway.slov-lex.sk/vyhladavanie/predpisZbierky/rozsirene");
    expect([...url.searchParams.keys()].sort()).toEqual(["cislo", "rows", "start"]);
    expect(url.searchParams.get("cislo")).toBe("40/1964");
    expect(url.searchParams.get("rows")).toBe("1");
    expect(url.searchParams.get("start")).toBe("0");
  });

  it("maps every criterion and sorts newest by announcement", () => {
    const url = new URL(
      buildPredpisSearchUrl(
        {
          query: "nájom bytu",
          title: "Občiansky",
          year: 1964,
          type: "Zákon",
          in_force_on: "2020-01-01",
          published_from: "1964-01-01",
          published_to: "1964-12-31",
          sort: "newest",
        },
        20,
        10,
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: "nájom bytu",
      nazov: "Občiansky",
      rocnik: "1964",
      typPredp_value: "Zákon",
      ucinnyK: "2020-01-01",
      vyhlaseny_zaciatok: "1964-01-01",
      vyhlaseny_koniec: "1964-12-31",
      rows: "10",
      start: "20",
      sort: "vyhlaseny desc",
    });
    expect(new URL(buildPredpisSearchUrl({ query: "x", sort: "relevance" }, 0, 10)).searchParams.has("sort")).toBe(false);
  });
});

describe("parseHistory / pickVersion", () => {
  const oz = parseHistory(HISTORY_40);
  const novela = parseHistory(HISTORY_325);

  it("reads all 69 versions of the Občiansky zákonník with their amending acts", () => {
    expect(oz).toHaveLength(69);
    expect(oz[0]).toEqual({ iri: "/SK/ZZ/1964/40/vyhlasene_znenie", version: "vyhlasene_znenie", announced: true, amended_by: [] });
    expect(oz[2]).toMatchObject({ version: "19690701", from: "1969-07-01", to: "1982-12-31", amended_by: ["58/1969 Zb."] });
    expect(oz.find((v) => v.version === "19900501")?.amended_by).toEqual(["105/1990 Zb.", "116/1990 Zb."]);
    expect(oz[68]).toMatchObject({ version: "20260731", from: "2026-07-31", to: "2027-06-30", amended_by: ["310/2025 Z. z."] });
  });

  it("leaves the last version of 325/2025 open-ended", () => {
    expect(novela.at(-1)).toEqual({ iri: "/SK/ZZ/2025/325/20290901", version: "20290901", announced: false, from: "2029-09-01", amended_by: [] });
  });

  it("picks the version in force on a date", () => {
    expect(pickVersion(oz, "2026-11-17")?.version).toBe("20260731");
    expect(pickVersion(oz, "1970-01-01")?.version).toBe("19690701");
    expect(pickVersion(oz, "1969-07-01")?.version).toBe("19690701");
    expect(pickVersion(oz, "0000-00-00")?.version).toBe("vyhlasene_znenie");
    expect(pickVersion(novela, "2028-01-01")?.version).toBe("20280101");
    expect(pickVersion(novela, "2029-09-01")?.version).toBe("20290901");
    expect(pickVersion(novela, "2040-01-01")?.version).toBe("20290901");
  });

  it("finds no version before the first or after a closed last one", () => {
    expect(pickVersion(oz, "1964-01-01")).toBeNull();
    expect(pickVersion(oz, "2028-01-01")).toBeNull();
  });

  it("resolves today's version and lists the published future ones", async () => {
    stubSlovLex();
    const resolved = await resolveVersion(2025, 325, undefined, "2026-11-17");
    expect(resolved.version.version).toBe("20260901");
    expect(resolved.status).toBe("current");
    expect(resolved.future).toEqual(["2028-01-01", "2029-09-01"]);
    const future = await resolveVersion(2025, 325, "2029-09-01", "2026-11-17");
    expect(future.status).toBe("future");
    expect(future.future).toEqual([]);
  });
});

describe("parseActText", () => {
  describe("amending act 325/2025", () => {
    const act = parseActText(TEXT_325);

    it("has the five articles Čl. I–V as its own units", () => {
      expect(act.iri).toBe("/SK/ZZ/2025/325/20290901");
      expect(act.from).toBe("2029-09-01");
      expect(act.units.filter((u) => u.kind === "article").map((u) => u.label)).toEqual(["Čl. I", "Čl. II", "Čl. III", "Čl. IV", "Čl. V"]);
      expect(act.units.some((u) => u.kind === "paragraph")).toBe(false);
    });

    it("finds Čl. I by its roman label and by its arabic id, quoted § 30 included", () => {
      for (const section of ["čl. I", "čl. 1", "Čl. I", "článok 1"]) {
        const match = findUnit(act, parseSkSectionLabel(section)!);
        expect(match && "units" in match, section).toBe(true);
        const text = unitText(act, (match as { units: Parameters<typeof unitText>[1] }).units);
        expect(text.startsWith("Čl. I\n")).toBe(true);
        expect(text).toContain("„§ 30");
        expect(text).toContain("Pedagogický zamestnanec a odborný zamestnanec, ktorý bol najmenej dva roky");
      }
    });

    it("never answers § 30 with the quoted wording", () => {
      expect(findUnit(act, parseSkSectionLabel("§ 30")!)).toEqual({ citedIn: ["Čl. I"] });
      expect(findUnit(act, parseSkSectionLabel("§ 36a")!)).toEqual({ citedIn: ["Čl. IV"] });
      expect(findUnit(act, parseSkSectionLabel("§ 999")!)).toBeNull();
    });
  });

  describe("principal act 18/1996 Z. z. o cenách", () => {
    const act = parseActText(TEXT_18);

    it("reads title, version and the structure", () => {
      expect(act).toMatchObject({ iri: "/SK/ZZ/1996/18/20260101", title: "o cenách", from: "2026-01-01" });
      const headings = act.units.filter((u) => u.kind === "heading").map((u) => u.text);
      expect(headings[0]).toBe("PRVÁ ČASŤ — ZÁKLADNÉ USTANOVENIA");
      expect(headings).toContain("Vecné usmerňovanie cien");
      const paragraphs = act.units.filter((u) => u.kind === "paragraph").map((u) => u.label);
      expect(paragraphs[0]).toBe("§ 1");
      expect(paragraphs).toContain("§ 23e");
      expect(paragraphs.at(-1)).toBe("§ 25");
      expect(Object.keys(act.cited)).toEqual([]);
    });

    it("returns one § with its nadpis, odseky, písmená and the footnotes it cites", () => {
      const match = findUnit(act, parseSkSectionLabel("§ 2")!);
      expect(match && "units" in match).toBe(true);
      const text = unitText(act, (match as { units: Parameters<typeof unitText>[1] }).units);
      const lines = text.split("\n");
      expect(lines[0]).toBe("§ 2");
      expect(lines[1]).toBe("Základné pojmy");
      expect(lines[2]).toMatch(/^\(1\) Cena je peňažná suma dohodnutá pri nákupe a predaji tovaru\./);
      expect(text).toContain("\n(3) Na účely tohto zákona sa\na) ekonomicky oprávnenými nákladmi");
      expect(text).toContain("\nb) primeranou ziskovou prirážkou");
      expect(text).toContain("\n\nPoznámky pod čiarou:\n3)");
      expect(text).not.toContain("§ 3\n");
    });

    it("matches '23e' and '§23e' alike and misses a § the act does not have", () => {
      for (const section of ["§ 23e", "§23e", "23e"]) {
        const match = findUnit(act, parseSkSectionLabel(section)!);
        expect(match && "units" in match && match.units[0].label).toBe("§ 23e");
      }
      expect(findUnit(act, parseSkSectionLabel("§ 9")!)).toBeNull();
    });
  });
});

describe("parseActText: Ústava SR markup", () => {
  // Shape of /SK/ZZ/1992/460/20251101.html (live 2026-11-17): articles are div.ustavnyclanok#ustavnyclanok-N.
  const html = `<div class="predpis Skupina " id="predpis">
    <div class="predpisTyp" id="predpis.typ">ÚSTAVA</div>
    <div class="text" id="predpis.text">PREAMBULA<br class="auto-merge">My, národ slovenský,</div>
    <div class="hlava Skupina " id="predpis.hlava-prva">
      <div class="hlavaOznacenie" id="predpis.hlava-prva.oznacenie">PRVÁ HLAVA</div>
      <div class="ustavnyclanok Skupina " id="ustavnyclanok-7a">
        <div class="ustavnyclanokOznacenie" id="ustavnyclanok-7a.oznacenie">Čl. 7a</div>
        <div class="odsek Skupina " id="ustavnyclanok-7a.odsek-1">
          <div class="odsekOznacenie" id="ustavnyclanok-7a.odsek-1.oznacenie">(1)</div>
          <div class="text" id="ustavnyclanok-7a.odsek-1.text"> Slovenská republika podporuje&nbsp;národné povedomie.</div>
        </div>
      </div>
    </div>
  </div><div id="iri" data-iri="/SK/ZZ/1992/460/20251101"></div>`;

  it("reads constitutional articles as articles", () => {
    const act = parseActText(html);
    expect(act.units.map((u) => u.text)).toEqual(["ÚSTAVA", "PREAMBULA\nMy, národ slovenský,", "PRVÁ HLAVA", "Čl. 7a\n(1) Slovenská republika podporuje národné povedomie."]);
    const match = findUnit(act, parseSkSectionLabel("čl. 7a")!);
    expect(match && "units" in match && match.units[0].label).toBe("Čl. 7a");
  });
});

describe("sk_predpis_get_text", () => {
  it("reads one § of today's wording, the parsed act then from cache", async () => {
    const { urls } = stubSlovLex();
    const first = await tools.sk_predpis_get_text({ year: 1996, number: 18, section: "§ 2", page: 1 });
    expect(first.isError).toBeUndefined();
    expect(first.content[0].text.startsWith("/SK/ZZ/1996/18/20260101 § 2 — účinné 2026-01-01 – (open):\n\n§ 2\nZákladné pojmy")).toBe(true);
    expect(first.structuredContent).toMatchObject({
      iri: "/SK/ZZ/1996/18/20260101",
      url: "https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1996/18/20260101",
      section: "§ 2",
      version_from: "2026-01-01",
      version_type: "current",
      page: 1,
      total_pages: 1,
      has_more: false,
    });
    expect(first.structuredContent).not.toHaveProperty("future_versions");
    const fetched = urls.length;
    const second = await tools.sk_predpis_get_text({ year: 1996, number: 18, section: "§ 3", page: 1 });
    expect(second.content[0].text).toContain("§ 3\n(1) Dohoda o cene je dohoda o výške ceny");
    expect(urls.length).toBe(fetched);
  });

  it("warns about a future wording and carries the date into the next window", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_text({ year: 2025, number: 325, date: "2029-09-01", section: "čl. I", page: 1 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text.startsWith("/SK/ZZ/2025/325/20290901 čl. I — účinné 2029-09-01 – (open):\n⚠ This wording takes effect only on 2029-09-01")).toBe(true);
    expect(result.structuredContent).toMatchObject({ version_type: "future", has_more: true });
    expect(result.structuredContent?.total_pages as number).toBeGreaterThan(1);
    expect(text).toContain('pokračuj bez ptaní: section: "čl. I", date: "2029-09-01", page: 2');
  });

  it("answers a § quoted by an amending act with NOT_FOUND and the way to read it", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_text({ year: 2025, number: 325, date: "2029-09-01", section: "§ 30", page: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: "NOT_FOUND" } });
    expect(result.content[0].text).toContain("amending act");
    expect(result.content[0].text).toContain("Čl. I");
    expect(result.content[0].text).toContain('section: "čl. I"');
  });

  it("pages through the whole act with its footnotes", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_text({ year: 1996, number: 18, page: 1 });
    const text = result.content[0].text;
    expect(text.startsWith("/SK/ZZ/1996/18/20260101 — text page 1/")).toBe(true);
    expect(text).toContain("o cenách");
    expect(text).toContain("\n§ 25\n");
    expect(text).toContain("Poznámky pod čiarou");
  });

  it("refuses a malformed section and a date without a version", async () => {
    stubSlovLex();
    const bad = await tools.sk_predpis_get_text({ year: 1996, number: 18, section: "odsek 2", page: 1 });
    expect(bad.structuredContent).toMatchObject({ error: { kind: "INPUT_INVALID" } });
    const early = await tools.sk_predpis_get_text({ year: 1964, number: 40, date: "1950-01-01", section: "§ 1", page: 1 });
    expect(early.structuredContent).toMatchObject({ error: { kind: "NOT_FOUND" } });
    expect(early.content[0].text).toContain("first version is in force from 1964-04-01");
  });

  it("maps the static host's 404 to NOT_FOUND", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_text({ year: 1996, number: 9999, section: "§ 1", page: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: "NOT_FOUND", source: "Slov-Lex (Zbierka zákonov SR)" } });
  });
});

describe("sk_predpis_get_act", () => {
  it("lists versions newest first, marks today's and names the amending acts", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_act({ year: 1964, number: 40 });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { versions: Array<{ iri: string; amended_by: string[] }> } & Record<string, unknown>;
    expect(out).toMatchObject({
      citation: "40/1964 Zb.",
      title: "Občiansky zákonník",
      type: "Zákon",
      published: "1964-03-05",
      url: "https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1964/40",
      in_force_iri: "/SK/ZZ/1964/40/20260731",
    });
    expect(out.versions).toHaveLength(69);
    expect(out.versions[0]).toEqual({ from: "2026-07-31", to: "2027-06-30", announced: false, iri: "/SK/ZZ/1964/40/20260731", amended_by: ["310/2025 Z. z."] });
    const text = result.content[0].text;
    expect(text).toContain("40/1964 Zb. — Občiansky zákonník [Zákon]");
    expect(text).toContain("  • 2026-07-31 – 2027-06-30 · 310/2025 Z. z. ← účinné k 2026-11-17");
    expect(text).toContain("39 older versions not listed");
  });

  it("flags future versions and marks the one in force on 'date'", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_act({ year: 2025, number: 325, date: "2026-01-15" });
    const text = result.content[0].text;
    expect(text).toContain("2026-01-01 – 2026-08-31 ← účinné k 2026-01-15");
    expect(text).toContain("2029-09-01 – (open) (budúce — ešte neúčinné)");
    expect(result.structuredContent).not.toHaveProperty("title");
    expect(result.structuredContent).toMatchObject({ citation: "325/2025 Z. z.", in_force_iri: "/SK/ZZ/2025/325/20260101" });
  });

  it("maps an unknown act to NOT_FOUND", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_get_act({ year: 1996, number: 9999 });
    expect(result.structuredContent).toMatchObject({ error: { kind: "NOT_FOUND" } });
  });
});

describe("sk_predpis_search", () => {
  it("searches by number and prints the hit with its wording and URL", async () => {
    const { urls } = stubSlovLex();
    const result = await tools.sk_predpis_search({ number: "40/1964", sort: "relevance", limit: 10, offset: 0 });
    expect(new URL(urls[0]).searchParams.get("cislo")).toBe("40/1964");
    expect(result.structuredContent).toMatchObject({ total: 1, count: 1, offset: 0, has_more: false });
    expect(result.content[0].text).toContain(
      "1. 40/1964 Zb. — Občiansky zákonník [Zákon] · znenie od 2026-07-31\n   https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1964/40/20260731",
    );
  });

  it("shows the nadpisy matching a full-text query", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_search({ query: "nájom bytu", sort: "relevance", limit: 10, offset: 0 });
    expect(result.content[0].text).toMatch(/1\. 40\/1964 Zb\. — Občiansky zákonník \[Zákon\] · znenie od 2026-07-31\n {3}nadpisy: „[^\n]*bytu/);
    expect((result.structuredContent?.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty("headings");
  });

  it("says a page past the end is past the end, not 'no match'", async () => {
    stubSlovLex();
    const result = await tools.sk_predpis_search({ year: 1996, sort: "relevance", limit: 10, offset: 5 });
    expect(result.content[0].text).toContain("No more acts");
    expect(result.content[0].text).toContain("use an offset below 1");
  });

  it("refuses a call without criteria, a bad number and an inverted range", async () => {
    stubSlovLex();
    const none = await tools.sk_predpis_search({ in_force_on: "2020-01-01", sort: "relevance", limit: 10, offset: 0 });
    expect(none.structuredContent).toMatchObject({ error: { kind: "INPUT_INVALID" } });
    const badNumber = await tools.sk_predpis_search({ number: "Občiansky", sort: "relevance", limit: 10, offset: 0 });
    expect(badNumber.structuredContent).toMatchObject({ error: { kind: "INPUT_INVALID" } });
    const inverted = await tools.sk_predpis_search({ query: "x", published_from: "2020-01-01", published_to: "2019-01-01", sort: "relevance", limit: 10, offset: 0 });
    expect(inverted.structuredContent).toMatchObject({ error: { kind: "INPUT_INVALID" } });
    expect(inverted.content[0].text).toContain("published_from");
  });
});
