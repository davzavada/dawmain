import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNalusForm,
  ecliToSz,
  isValidSz,
  parseFormState,
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
    expect(stripRtfMarkers("první\\par druhá\\b tučně\\b0 dál")).toBe("první\n druhá tučně dál");
  });
});
