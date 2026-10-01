import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNalusForm,
  classifyNalusPostBody,
  ecliToSz,
  isValidSz,
  NALUS_OUTCOMES,
  nalusEcli,
  nalusQueryText,
  normalizeNalusInput,
  resolveNalusValues,
  parseFormState,
  parseNalusAbstract,
  parseNalusDecision,
  parseNalusResults,
  stripRtfMarkers,
} from "@/src/sources/nalus";
import { SourceError } from "@/src/sources/shared/errors";

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, "fixtures", "nalus", name), "utf8");

describe("identifiers", () => {
  it("validates sz", () => {
    expect(isValidSz("1-1169-26_1")).toBe(true);
    expect(isValidSz("Pl-24-10_1")).toBe(true);
    expect(isValidSz("St-1-93")).toBe(true);
    expect(isValidSz("X-1-93")).toBe(false);
    expect(isValidSz("I. ÚS 1169/26")).toBe(false);
  });

  it("maps ECLI to sz", () => {
    expect(ecliToSz("ECLI:CZ:US:2026:1.US.1169.26.1")).toBe("1-1169-26_1");
    expect(ecliToSz("ECLI:CZ:US:2011:Pl.US.24.10.1")).toBe("Pl-24-10_1");
    expect(ecliToSz("ECLI:CZ:US:2006:Pl.US-st.1.93.1")).toBe("St-1-93_1");
    expect(ecliToSz("ECLI:CZ:NS:2026:27.CDO.1525.2025.1")).toBeNull();
  });
});

describe("parseFormState (live fixture, captured 2026-08-01)", () => {
  it("harvests the three WebForms tokens", () => {
    const state = parseFormState(fixture("search-form.html"));
    expect(state.__VIEWSTATE).toBeTruthy();
    expect(state.__VIEWSTATEGENERATOR).toBeTruthy();
    expect(state.__EVENTVALIDATION).toBeTruthy();
  });

  it("throws PARSE_DRIFT when tokens are missing", () => {
    expect(() => parseFormState("<html><form></form></html>")).toThrowError(SourceError);
  });
});

describe("buildNalusForm", () => {
  const state = { __VIEWSTATE: "V", __VIEWSTATEGENERATOR: "G", __EVENTVALIDATION: "E" };

  it("sets criteria, defaults to all decision types, and searches operative scopes", () => {
    const form = buildNalusForm(state, { query: "svoboda projevu", dateFrom: "2020-01-01" }, 80);
    expect(form.get("ctl00$MainContent$but_search")).toBe("Vyhledat");
    expect(form.get("ctl00$MainContent$text")).toBe("svoboda projevu");
    expect(form.get("ctl00$MainContent$nalezy")).toBe("on");
    expect(form.get("ctl00$MainContent$usneseni")).toBe("on");
    expect(form.get("ctl00$MainContent$oduvodneni")).toBe("on");
    expect(form.get("ctl00$MainContent$odlisne_stanovisko")).toBeNull();
    expect(form.get("ctl00$MainContent$decidedFrom")).toBe("1.1.2020");
    expect(form.get("ctl00$MainContent$resultsPageSize")).toBe("80");
  });

  it("restricts decision types when asked", () => {
    const form = buildNalusForm(state, { citace: "Pl. ÚS 24/10", types: ["nález"] }, 20);
    expect(form.get("ctl00$MainContent$citace")).toBe("Pl. ÚS 24/10");
    expect(form.get("ctl00$MainContent$nalezy")).toBe("on");
    expect(form.get("ctl00$MainContent$usneseni")).toBeNull();
  });

  it("include_dissents adds the odlišné stanovisko zone to a full-text query", () => {
    const form = buildNalusForm(state, { query: "svoboda projevu", includeDissents: true }, 20);
    expect(form.get("ctl00$MainContent$odlisne_stanovisko")).toBe("on");
    expect(form.get("ctl00$MainContent$oduvodneni")).toBe("on");
  });

  it("availability dates, only-published and relevance sort", () => {
    const form = buildNalusForm(
      state,
      { publishedFrom: "2026-08-21", publishedTo: "2026-08-27", onlyPublished: true, sort: "relevance" },
      20,
    );
    expect(form.get("ctl00$MainContent$availableFrom")).toBe("21.8.2026");
    expect(form.get("ctl00$MainContent$availableTo")).toBe("27.8.2026");
    expect(form.get("ctl00$MainContent$jen_publikovana")).toBe("on");
    expect(form.get("ctl00$MainContent$razeni")).toBe("5");
  });

  it("posts the free-text contested act/organ fields and never the readonly číselník pickers", () => {
    // Live 2026-09: NALUS ignores whatever reaches the readonly pickers —
    // posting them only made an unfiltered list look filtered.
    const form = buildNalusForm(
      state,
      {
        judge: "Wagnerová",
        dissentingJudge: "Fiala Josef",
        outcome: ["vyhověno"],
        petitioner: ["SKUPINA POSLANCŮ"],
        contestedOrganType: ["SOUD"],
        contestedActKind: ["zákon"],
        contestedOrgan: "Nejvyšší soud",
        contestedActNumber: "106/1999",
        contestedActClause: "§ 17",
      },
      20,
    );
    for (const field of ["soudce_zpravodaj", "soudce_stanovisko", "vyrok_multi", "navrhovatel", "affected_organ_type", "actkind"]) {
      expect(form.get(`ctl00$MainContent$${field}`), field).toBeNull();
    }
    expect(form.get("ctl00$MainContent$affected_organ_spec")).toBe("Nejvyšší soud");
    expect(form.get("ctl00$MainContent$actkindnumber_txt")).toBe("106/1999");
    expect(form.get("ctl00$MainContent$actkindclause_txt")).toBe("§ 17");
    expect(form.get("ctl00$MainContent$razeni")).toBe("2");
  });

  it("drops '§' from the full-text value — NALUS answers 0 with it", () => {
    const form = buildNalusForm(state, { query: "náhrada nemajetkové újmy § 2958" }, 20);
    expect(form.get("ctl00$MainContent$text")).toBe("náhrada nemajetkové újmy 2958");
    expect(nalusQueryText("§§ 2958  odst. 1")).toBe("2958 odst. 1");
    // A query of nothing but '§' is no full-text criterion at all.
    expect(buildNalusForm(state, { query: "§", citace: "Pl. ÚS 24/10" }, 20).get("ctl00$MainContent$text")).toBeNull();
  });
});

describe("normalizeNalusInput", () => {
  it("gives caselaw_search's ÚS lane and us_search the same criteria for the same search", () => {
    const lane = normalizeNalusInput({ query: "svoboda projevu", dateFrom: undefined, dateTo: undefined, sort: "relevance" });
    const tool = normalizeNalusInput({
      query: " svoboda  projevu ",
      citace: undefined,
      onlyPublished: false,
      includeDissents: false,
      types: ["stanovisko", "nález", "usnesení"],
      contestedOrgan: "  ",
      sort: "relevance",
    });
    expect(JSON.stringify(tool)).toBe(JSON.stringify(lane));
    expect(lane).toEqual({ query: "svoboda projevu", sort: "relevance" });
  });

  it("folds sort, sorts types, and drops include_dissents without a query", () => {
    expect(normalizeNalusInput({ citace: "Pl. ÚS 24/10", types: ["usnesení", "nález"], includeDissents: true })).toEqual({
      citace: "Pl. ÚS 24/10",
      types: ["nález", "usnesení"],
      sort: "date",
    });
  });

  it("refuses every číselník picker before any request, naming the us_search parameter", () => {
    for (const [field, value, param] of [
      ["judge", "Wagnerová", "judge"],
      ["dissentingJudge", "Fiala", "dissenting_judge"],
      ["outcome", ["zamítnuto"], "outcome"],
      ["petitioner", ["SKUPINA POSLANCŮ"], "petitioner"],
      ["contestedOrganType", ["SOUD"], "contested_organ_type"],
      ["contestedActKind", ["zákon"], "contested_act_kind"],
    ] as const) {
      try {
        normalizeNalusInput({ query: "x", [field]: value });
        expect.unreachable(field);
      } catch (error) {
        expect((error as SourceError).kind).toBe("INPUT_INVALID");
        expect((error as SourceError).message).toContain(param);
        expect((error as SourceError).message).toContain("UNFILTERED");
        expect((error as SourceError).hint).toContain("contested_act_number");
      }
    }
    // Empty pickers are no pickers.
    expect(normalizeNalusInput({ query: "x", judge: " ", outcome: [] })).toEqual({ query: "x", sort: "date" });
  });
});

describe("resolveNalusValues", () => {
  it("maps case/diacritics-insensitive input onto canonical titles", () => {
    expect(resolveNalusValues(["ODMITNUTO PRO ZJEVNOU NEOPODSTATNENOST"], NALUS_OUTCOMES, "výrok")).toEqual([
      "odmítnuto pro zjevnou neopodstatněnost",
    ]);
    // Titles that themselves contain commas survive verbatim, double space included.
    expect(resolveNalusValues(["procesní -  změna návrhu"], NALUS_OUTCOMES, "výrok")).toEqual([
      "procesní -  změna návrhu",
    ]);
    expect(
      resolveNalusValues(["procesní - svědečné, tlumočné, znalečné"], NALUS_OUTCOMES, "výrok"),
    ).toEqual(["procesní - svědečné, tlumočné, znalečné"]);
  });

  it("rejects unknown values with the whole menu in the hint", () => {
    try {
      resolveNalusValues(["vyhráno"], NALUS_OUTCOMES, "výrok");
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("INPUT_INVALID");
      expect((error as SourceError).hint).toContain("vyhověno");
    }
  });
});

describe("nalusCitationDate", () => {
  it("reads the date of published and unpublished decisions alike", async () => {
    const { nalusCitationDate } = await import("@/src/sources/nalus");
    expect(nalusCitationDate("nález sp. zn. Pl. ÚS 24/10 ze dne 22. 3. 2011 (N 52/60 SbNU 625; 94/2011 Sb.)")).toBe(
      "2011-03-22",
    );
    expect(nalusCitationDate("usnesení sp. zn. I. ÚS 1169/26 ze dne 7. 7. 2026")).toBe("2026-07-07");
    expect(nalusCitationDate("nález sp. zn. Pl. ÚS 24/10")).toBeUndefined();
  });
});

describe("parseNalusResults (live fixture)", () => {
  it("extracts hits with sz, ECLI, form and date", () => {
    const page = parseNalusResults(fixture("results-page-1.html"));
    expect(page.total).toBe(63);
    expect(page.hits.length).toBeGreaterThanOrEqual(10);

    const first = page.hits[0];
    expect(first.caseNumber).toBe("I.ÚS 1169/26 #1");
    expect(first.ecli).toBe("ECLI:CZ:US:2026:1.US.1169.26.1");
    expect(first.sz).toBe("1-1169-26_1");
    expect(first.form).toBe("usnesení");
    expect(first.date).toBe("2026-07-07");
  });

  it("throws PARSE_DRIFT on an unrecognizable page", () => {
    expect(() => parseNalusResults("<html><body>redesign</body></html>")).toThrowError(SourceError);
  });

  it("pairs every hit with its own sz and citation, all ten of them", () => {
    const page = parseNalusResults(fixture("results-page-1.html"));
    for (const hit of page.hits) {
      // "III.ÚS 1623/26 #1" ↔ "3-1623-26_1" ↔ "… III. ÚS 1623/26 …"
      const [, senate, num, yy, counter] = /^(I{1,3}|IV|Pl)\.ÚS (\d+)\/(\d+) #(\d+)$/.exec(hit.caseNumber) ?? [];
      const registry = { I: "1", II: "2", III: "3", IV: "4", Pl: "Pl" }[senate as "I"];
      expect(hit.sz, hit.caseNumber).toBe(`${registry}-${num}-${yy}_${counter}`);
      expect(hit.citation, hit.caseNumber).toContain(`${senate}. ÚS ${num}/${yy}`);
    }
  });

  it("a row without its Odkaz link loses only its own sz — the others stay on their decisions", () => {
    const html = fixture("results-page-1.html");
    const link = /<img[^>]*ShowLink\("https:\/\/nalus\.usoud\.cz:443\/Search\/GetText\.aspx\?sz=3-1623-26_1"[^>]*>/;
    expect(link.test(html)).toBe(true);
    const page = parseNalusResults(html.replace(link, ""));
    const all = parseNalusResults(html);
    expect(page.hits[1].caseNumber).toBe("III.ÚS 1623/26 #1");
    expect(page.hits[1].sz).toBeNull();
    expect(page.hits[1].url).toBeNull();
    page.hits.forEach((hit, i) => {
      if (i !== 1) expect(hit.sz).toBe(all.hits[i].sz);
    });
  });

  it("a row whose citation does not parse keeps its date and form from its own cells", () => {
    const html = fixture("results-page-1.html").replace(
      'ShowLink("usnesení sp. zn. I. ÚS 1169/26 ze dne 7. 7. 2026", "Citace"',
      'ShowLink("„divná“ citace", "Citace"',
    );
    const page = parseNalusResults(html);
    expect(page.hits[0].citation).toBeUndefined();
    expect(page.hits[0].date).toBe("2026-07-07");
    expect(page.hits[0].form).toBe("usnesení");
    expect(page.hits[0].sz).toBe("1-1169-26_1");
    expect(page.hits[1].citation).toContain("III. ÚS 1623/26");
  });
});

describe("classifyNalusPostBody (a 200 answer to the criteria POST)", () => {
  const form = fixture("search-form.html");

  it("the zero-hits marker is an empty result", () => {
    expect(classifyNalusPostBody(`${form}<span id="ctl00_MainContent_lbError">Nebyly nalezeny žádné záznamy</span>`)).toBe(
      "zero-hits",
    );
  });

  it("the form re-rendered with an input complaint is INPUT_INVALID carrying NALUS's own words", () => {
    const body = form.replace("</form>", '<span id="ctl00_MainContent_lbError">Zadejte alespoň jedno kritérium</span></form>');
    try {
      classifyNalusPostBody(body);
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("INPUT_INVALID");
      expect((error as SourceError).message).toContain("Zadejte alespoň jedno kritérium");
      expect((error as SourceError).hint).not.toContain("dawmain_probe_sources");
    }
  });

  it("another printed message is UPSTREAM_ERROR; hidden validators say nothing", () => {
    const body = form.replace("</form>", '<span id="ctl00_MainContent_lbError">Chyba databáze</span></form>');
    expect(() => classifyNalusPostBody(body)).toThrowError(/Chyba databáze/);
    try {
      classifyNalusPostBody(body);
    } catch (error) {
      expect((error as SourceError).kind).toBe("UPSTREAM_ERROR");
    }
    // The fixture's validators are all display:none — a silent form stays drift.
    try {
      classifyNalusPostBody(form);
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
  });

  it("a body that is not the form is PARSE_DRIFT with the probe hint", () => {
    try {
      classifyNalusPostBody("<html><body>maintenance</body></html>");
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
      expect((error as SourceError).hint).toContain("dawmain_probe_sources");
    }
  });
});

describe("nalusEcli", () => {
  it("rebuilds the ECLI from the sz and the decision year — the inverse of ecliToSz", () => {
    expect(nalusEcli("Pl-24-10_1", "Pl.ÚS 24/10 ze dne 22. 3. 2011")).toBe("ECLI:CZ:US:2011:Pl.US.24.10.1");
    expect(nalusEcli("1-1169-26_1", "I.ÚS 1169/26 ze dne 7. 7. 2026")).toBe("ECLI:CZ:US:2026:1.US.1169.26.1");
    expect(nalusEcli("St-1-93_1", "Pl.ÚS-st. 1/93 ze dne 1. 1. 2006")).toBe("ECLI:CZ:US:2006:Pl.US-st.1.93.1");
    for (const sz of ["Pl-24-10_1", "1-1169-26_1", "St-1-93_1"]) {
      expect(ecliToSz(nalusEcli(sz, "x ze dne 1. 1. 2020") as string)).toBe(sz);
    }
    expect(nalusEcli("1-709-05", "I.ÚS 709/05 ze dne 25. 4. 2006")).toBeUndefined();
    expect(nalusEcli("1-709-05_1", undefined)).toBeUndefined();
  });
});

describe("parseNalusAbstract", () => {
  it("drops NALUS's 'není k dispozici' placeholders", () => {
    const html = `<table class="legalSentenceContent"><tr><td>Právní věta není k dispozici.</td></tr></table>
<table class="abstractContent"><tr><td>Abstrakt není k dispozici.</td></tr></table>`;
    expect(parseNalusAbstract(html)).toEqual({ abstract: undefined, legalSentence: undefined });
    const real = `<table class="legalSentenceContent"><tr><td>Zásah do svobody projevu musí být přiměřený.</td></tr></table>`;
    expect(parseNalusAbstract(real).legalSentence).toBe("Zásah do svobody projevu musí být přiměřený.");
  });
});

describe("parseNalusDecision", () => {
  // Synthetic — span ids and hidden inputs verbatim from the research.
  const pad = "<!-- padding to clear the too-short heuristic -->".repeat(150);
  const DOC_HTML = `
<html><body>${pad}
<span id="lblRegistrySign">I.ÚS 1169/26 ze dne 7. 7. 2026</span>
<span id="lblDecisionForm">Usnesení</span>
<input type="hidden" id="docContentHidden" value="Ústavní soud rozhodl\\par o ústavní stížnosti\\b stěžovatele\\b0 takto:" />
<table><tr><td class="DocContent">fallback obsah</td></tr></table>
</body></html>`;

  it("prefers docContentHidden and strips RTF markers", () => {
    const decision = parseNalusDecision(DOC_HTML, "1-1169-26_1");
    expect(decision.registrySign).toContain("I.ÚS 1169/26");
    expect(decision.text).toContain("Ústavní soud rozhodl");
    expect(decision.text).toContain("stěžovatele");
    expect(decision.text).not.toContain("\\par");
    expect(decision.text).not.toContain("\\b");
  });

  it("a decision quoting the word 'nenalezeno' is still the decision", () => {
    const html = DOC_HTML.replace("Ústavní soud rozhodl", "Při domovní prohlídce nic nenalezeno.\\par Ústavní soud rozhodl");
    const decision = parseNalusDecision(html, "1-1169-26_1");
    expect(decision.text).toContain("nic nenalezeno.\nÚstavní soud rozhodl");
  });

  it("a long page with neither text nor the not-found marker is PARSE_DRIFT", () => {
    try {
      parseNalusDecision(`<html>${pad}</html>`, "1-1169-26_1");
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
  });

  it("throws NOT_FOUND for the nenalezeno page", () => {
    try {
      parseNalusDecision(`<html>nenalezeno${pad}</html>`, "1-9999-99_1");
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("NOT_FOUND");
    }
  });
});

describe("stripRtfMarkers", () => {
  it("turns \\par into newlines and drops control words", () => {
    expect(stripRtfMarkers("první\\par druhá\\b tučně\\b0 dál")).toBe("první\ndruhá tučně dál");
  });

  it("leaves no space around breaks, so runs of empty lines collapse", () => {
    expect(stripRtfMarkers("a\\par \\par \\par b")).toBe("a\n\nb");
    expect(stripRtfMarkers("takto:\\par \\par Ochranné podání se odmítá. \\par \\par \\par Odůvodnění:")).toBe(
      "takto:\n\nOchranné podání se odmítá.\n\nOdůvodnění:",
    );
  });
});
