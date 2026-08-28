import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNssSearchForm,
  ciselnikTitles,
  findField,
  findFieldStrict,
  isNssMissingBody,
  parseCiselnikTree,
  parseNssActRef,
  parseNssDetail,
  parseNssForm,
  parseNssProvision,
  parseNssResults,
  selectFromCiselnik,
  validateNssApplies,
} from "@/src/sources/nss";
import { SourceError } from "@/src/sources/shared/errors";

// Synthetic — form shape per the research: hidden token + vyhledavaciSekce
// model inputs whose exact indices must be harvested at runtime.
const FORM_HTML = `
<html><body><form method="post" action="/Home/Index">
<input name="__RequestVerificationToken" type="hidden" value="tok123" />
<input name="FormularCiselnik" type="hidden" value="1" />
<div><label>Datum rozhodnutí od</label>
  <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasOd" type="text" value="" /></div>
<div><label>Datum rozhodnutí do</label>
  <input name="vyhledavaciSekce[1].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaDatumACasDo" type="text" value="" /></div>
<div><label>Plný text rozhodnutí</label>
  <input name="vyhledavaciSekce[0].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaText" type="text" value="" /></div>
<div><label>Spisová značka</label>
  <input name="vyhledavaciSekce[2].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].Hodnota" type="text" value="" /></div>
<input name="hidden_checkbox" type="checkbox" />
<input name="checked_box" type="checkbox" checked="checked" value="on" />
<input type="submit" name="submitbtn" value="Vyhledat" />
</form></body></html>`;

describe("parseNssForm", () => {
  it("harvests fields with labels, skips submits and unchecked boxes", () => {
    const form = parseNssForm(FORM_HTML);
    const names = form.fields.map((field) => field.name);
    expect(names).toContain("__RequestVerificationToken");
    expect(names).toContain("FormularCiselnik");
    expect(names).toContain("checked_box");
    expect(names).not.toContain("hidden_checkbox");
    expect(names).not.toContain("submitbtn");
    const dateField = form.fields.find((field) => field.name.endsWith(".HodnotaDatumACasOd"));
    expect(dateField?.label).toContain("Datum rozhodnutí od");
  });

  it("throws PARSE_DRIFT without the antiforgery token", () => {
    expect(() => parseNssForm("<html><form><input name='x'/></form></html>")).toThrowError(
      SourceError,
    );
  });
});

describe("findField", () => {
  const form = parseNssForm(FORM_HTML);

  it("locates dates by name suffix", () => {
    expect(findField(form, ".HodnotaDatumACasOd", null)?.name).toContain("HodnotaDatumACasOd");
  });
  it("locates full text by suffix, spisová značka by label", () => {
    expect(findField(form, ".HodnotaText", /pln[ýé]\s*text/i)?.label).toContain("Plný text");
    expect(findField(form, null, /spisov[áé]\s*značk/i)?.name).toContain("vyhledavaciSekce[2]");
  });
  it("returns undefined when nothing matches", () => {
    expect(findField(form, ".Nonexistent", /nesmysl/)).toBeUndefined();
  });
});

// Synthetic — result rows per the research: hidden ID inputs, citation anchor
// title, count header with space-grouped number, inline pagination vars.
const RESULTS_HTML = `
<html><body>
<h6>Počet nalezených záznamů: 1 234</h6>
<table>
<tbody>
<tr><td><input type="hidden" name="ZobrazeneVysledky[0].ID" value="743842" /></td>
<td>10.06.2026</td>
<td><a title="Citace: rozsudek Nejvyšší správní soud ze dne 10. 6. 2026, čj. 1 Afs 25/2024&#160;-&#160;30" href="/DokumentDetail/Index/743842">1 Afs 25/2024</a></td>
<td><a href="/DokumentOriginal/Html/743842">HTML</a></td></tr>
</tbody>
<tbody>
<tr><td><input type="hidden" name="ZobrazeneVysledky[1].ID" value="724005" /></td>
<td>09.06.2026</td>
<td>2 Azs 100/2025</td></tr>
</tbody>
</table>
<script>
var moreRowsUrl = '/Home/MyResTRowsCont';
var currParams = '[{\\u0022Id\\u0022:19,\\u0022TechnickyNazev\\u0022:\\u0022datumvydanirozhodnuti\\u0022}]';
var currViewId = '1';
var currSort = ' order by  zvht38.Hodnota NOOR ';
</script>
</body></html>`;

describe("parseNssResults", () => {
  it("extracts total, hits, and citation metadata", () => {
    const page = parseNssResults(RESULTS_HTML);
    expect(page.total).toBe(1234);
    expect(page.hits).toHaveLength(2);
    expect(page.hits[0].id).toBe("743842");
    expect(page.hits[0].form).toBe("rozsudek");
    expect(page.hits[0].date).toBe("2026-06-10");
    expect(page.hits[0].caseNumber).toContain("1 Afs 25/2024");
    expect(page.hits[1].id).toBe("724005");
    expect(page.hits[1].caseNumber).toContain("2 Azs 100/2025");
  });

  it("decodes the \\uXXXX-escaped pagination context", () => {
    const page = parseNssResults(RESULTS_HTML);
    expect(page.pagination?.currParams).toContain('"Id":19');
    expect(page.pagination?.currViewId).toBe("1");
    expect(page.pagination?.currSort).toContain("order by");
  });

  it("flags the blank form (expired session) instead of reporting zero hits", () => {
    const page = parseNssResults(
      "<html><form><input name='__RequestVerificationToken' value='t'/></form></html>",
    );
    expect(page.blankForm).toBe(true);
    expect(page.total).toBeNull();
  });
});

describe("parseNssDetail", () => {
  // Live capture of DokumentDetail/Index/784744 (1 As 59/2026) — the field
  // keys are data-field-id ATTRIBUTES, not element ids.
  const DETAIL_HTML = readFileSync(
    path.join(__dirname, "fixtures", "nss-detail-784744.html"),
    "utf8",
  );

  it("extracts the confirmed data-field-id cards from the live capture", () => {
    const metadata = parseNssDetail(DETAIL_HTML);
    expect(metadata["Spisová značka"]).toBe("1 As 59/2026-106");
    expect(metadata["ECLI"]).toBe("ECLI:CZ:NSS:2026:1.As.59.2026.106");
    expect(metadata["Soudce zpravodaj"]).toContain("POSPÍŠIL Ivo");
    expect(metadata["Soud (senát)"]).toBe("tříčlenný senát NSS");
    expect(metadata["Druh dokumentu"]).toBe("Rozsudek");
    expect(metadata["Výrok rozhodnutí NSS"]).toContain("zrušeno");
    expect(metadata["Typ řízení"]).toBe("opatření obecné povahy");
    expect(metadata["Stav řízení"]).toBe("Skončeno");
    expect(metadata["Datum vydání rozhodnutí"]).toBe("20.08.2026");
  });

  it("joins repeated cards and never leaks det-textitle header cells", () => {
    const metadata = parseNssDetail(DETAIL_HTML);
    // Two zástupce cards → one joined value.
    expect(metadata["Zástupce"]).toContain("AVE CZ");
    expect(metadata["Zástupce"]).toContain("Obec Rybitví");
    expect(metadata["Zástupce"]).toContain("; ");
    // The účastník table in the capture has only its header row — the
    // det-textitle cells carry the same data-field-id and must not leak.
    expect(metadata["Účastníci řízení"]).toBeUndefined();
  });

  it("reads td.det-textval table cells (účastníci) when rows are present", () => {
    const metadata = parseNssDetail(`
      <table><thead><tr>
        <td class="det-textitle" data-field-id="ucastnikrizeni">Účastník řízení</td>
      </tr></thead><tbody>
        <tr><td class="det-textval" data-field-id="ucastnikrizeni">AVE CZ odpadové hospodářství s.r.o.</td></tr>
        <tr><td class="det-textval" data-field-id="ucastnikrizeni">Obec Rybitví</td></tr>
      </tbody></table>`);
    expect(metadata["Účastníci řízení"]).toBe("AVE CZ odpadové hospodářství s.r.o.; Obec Rybitví");
  });
});

// Live capture: the rendered search form (response to a browser POST,
// 2026-08) — every technical name, codebook blob, and value input verbatim.
const SEARCH_FORM_HTML = readFileSync(
  path.join(__dirname, "fixtures", "nss-search-form.html"),
  "utf8",
);
const SEARCH_FORM = parseNssForm(SEARCH_FORM_HTML);

/** Value of the input reached via a value-level TechnickyNazev match. */
function param(form: URLSearchParams, technical: RegExp, suffix: string): string | null {
  const field = findFieldStrict(SEARCH_FORM, technical, ".TechnickyNazev");
  if (!field) return null;
  const prefix = field.name.slice(0, -".TechnickyNazev".length);
  return form.get(prefix + suffix);
}

describe("parseCiselnikTree / selectFromCiselnik", () => {
  it("parses the unquoted-key literal, including commas inside titles", () => {
    const tree = parseCiselnikTree(
      '[{id:1,title:"Obyvatelstvo - evidence, doklady"},{id:2,title:"skupina",subs:[{id:3,title:"dítě"}]}]',
    );
    expect(tree).toHaveLength(2);
    expect(tree[0].title).toBe("Obyvatelstvo - evidence, doklady");
    expect(tree[1].subs?.[0]).toEqual({ id: 3, title: "dítě" });
  });

  it("throws PARSE_DRIFT on garbage", () => {
    expect(() => parseCiselnikTree("nonsense")).toThrowError(SourceError);
  });

  it("selects a matching node with its whole subtree, parent first", () => {
    const tree = parseCiselnikTree('[{id:2,title:"skupina",subs:[{id:3,title:"dítě"}]},{id:4,title:"jiné"}]');
    expect(selectFromCiselnik(tree, (title) => title === "skupina")).toEqual({
      ids: [2, 3],
      titles: ["skupina", "dítě"],
    });
    expect(ciselnikTitles(tree)).toEqual(["skupina", "dítě", "jiné"]);
  });
});

describe("parseNssActRef", () => {
  it("reads Czech Sb./Sb.m.s. citations (year second)", () => {
    expect(parseNssActRef("106/1999", false)).toEqual({ cislo: "106", rok: "1999" });
    expect(parseNssActRef("č. 106/1999 Sb.", false)).toEqual({ cislo: "106", rok: "1999" });
    expect(parseNssActRef("209/1992 Sb. m. s.", false)).toEqual({ cislo: "209", rok: "1992" });
  });

  it("reads EU citations: modern year-first, pre-2015 year-second, druh kept", () => {
    expect(parseNssActRef("2016/679", true)).toEqual({ cislo: "679", rok: "2016" });
    expect(parseNssActRef("2004/48/ES", true)).toEqual({ cislo: "48", rok: "2004", druh: "ES" });
    expect(parseNssActRef("1049/2001", true)).toEqual({ cislo: "1049", rok: "2001" });
  });

  it("rejects references without a plausible year", () => {
    expect(() => parseNssActRef("GDPR", false)).toThrowError(SourceError);
    expect(() => parseNssActRef("12/34", false)).toThrowError(SourceError);
  });
});

describe("parseNssProvision", () => {
  it("reads Czech long form, compact form, and bare units", () => {
    expect(parseNssProvision("§ 17 odst. 2 písm. a)")).toEqual({
      kind: "par",
      unit: "17",
      odst: "2",
      pism: "a",
    });
    expect(parseNssProvision("17(2)(a)")).toEqual({ kind: undefined, unit: "17", odst: "2", pism: "a" });
    expect(parseNssProvision("čl. 8 odst. 2")).toEqual({ kind: "cl", unit: "8", odst: "2", pism: undefined });
    expect(parseNssProvision("článek 36")).toEqual({ kind: "cl", unit: "36", odst: undefined, pism: undefined });
    expect(parseNssProvision("§17a")).toEqual({ kind: "par", unit: "17a", odst: undefined, pism: undefined });
    expect(parseNssProvision("36")).toEqual({ kind: undefined, unit: "36", odst: undefined, pism: undefined });
  });

  it("rejects unparseable references", () => {
    expect(() => parseNssProvision("odst. bez čísla")).toThrowError(SourceError);
  });
});

describe("buildNssSearchForm (live-captured form)", () => {
  it("harvests the captured form incl. the § field and codebook blobs", () => {
    const techValues = SEARCH_FORM.fields
      .filter((field) => field.name.endsWith(".TechnickyNazev"))
      .map((field) => field.value);
    expect(techValues).toContain("aplikovanepravnipredpisysb§");
    expect(techValues).toContain("aktualizovano");
    expect(techValues).toContain("soudsenat");
    expect(SEARCH_FORM.fields.some((field) => field.name.endsWith(".ciselnikTreeData"))).toBe(true);
  });

  it("court: krajske posts the captured id set, parent-first DFS", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, { court: "krajske" });
    // Byte-identical to the id list a real browser POST carried for this group.
    expect(param(form, /^soudsenat$/, ".HodnotaCiselnikPolozkySelected")).toBe(
      "8147,276,314,274,275,315,270,319,269,264,271,318,280",
    );
    expect(param(form, /^soudsenat$/, ".HodnotaCiselnikPolozky")).toContain("krajské soudy");
  });

  it("court: rozsireny-senat selects the grand-chamber subtree", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, { court: "rozsireny-senat" });
    expect(param(form, /^soudsenat$/, ".HodnotaCiselnikPolozkySelected")).toBe("8155,8154,8153");
  });

  it("registry resolves codes case-insensitively and rejects unknowns with the code list", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, { registry: "afs" });
    expect(param(form, /^oznacenivecidelenerejstrikovaznacka$/, ".HodnotaCiselnikPolozkySelected")).toBe("85");
    expect(param(form, /^oznacenivecidelenerejstrikovaznacka$/, ".HodnotaCiselnikPolozky")).toBe("Afs");
    try {
      buildNssSearchForm(SEARCH_FORM.fields, { registry: "Qqq" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).hint).toContain("Azs");
    }
  });

  it("area substring-matches diacritics-insensitively and ORs every match", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, { area: "dan" });
    const selected = param(form, /^oblastupravy$/, ".HodnotaCiselnikPolozkySelected");
    expect(selected).toContain("164");
    expect(selected).toContain("165");
    expect(selected).toContain("171");
    try {
      buildNssSearchForm(SEARCH_FORM.fields, { area: "neexistující oblast" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).hint).toContain("Azyl");
    }
  });

  it("applies_act + § provision fills the Sb. row (číslo, rok, §, odst., písm.)", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      appliesAct: "106/1999",
      appliesProvision: "§ 17 odst. 2 písm. a",
    });
    expect(param(form, /^aplikovanepravnipredpisysbcislo$/, ".HodnotaCislo")).toBe("106");
    expect(param(form, /^aplikovanepravnipredpisysbrok$/, ".HodnotaCislo")).toBe("1999");
    expect(param(form, /^aplikovanepravnipredpisysb§$/, ".HodnotaText")).toBe("17");
    expect(param(form, /^aplikovanepravnipredpisysbodst$/, ".HodnotaText")).toBe("2");
    expect(param(form, /^aplikovanepravnipredpisysbpism$/, ".HodnotaText")).toBe("a");
  });

  it("applies_act with a čl. provision routes to the Sb. čl. field", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      appliesAct: "2/1993",
      appliesProvision: "čl. 36 odst. 1",
    });
    expect(param(form, /^aplikovanepravnipredpisysbcl$/, ".HodnotaText")).toBe("36");
    expect(param(form, /^aplikovanepravnipredpisysb§$/, ".HodnotaText")).not.toBe("36");
  });

  it("applies_eu_regulation fills the Nařízení EU row", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      appliesEuRegulation: "2016/679",
      appliesProvision: "čl. 17 odst. 1 písm. b",
    });
    expect(param(form, /^aplikovanepravnipredpisynarizenieucislo$/, ".HodnotaCislo")).toBe("679");
    expect(param(form, /^aplikovanepravnipredpisynarizenieurok$/, ".HodnotaCislo")).toBe("2016");
    expect(param(form, /^aplikovanepravnipredpisynarizenieucl$/, ".HodnotaText")).toBe("17");
    expect(param(form, /^aplikovanepravnipredpisynarizenieuodst$/, ".HodnotaText")).toBe("1");
    expect(param(form, /^aplikovanepravnipredpisynarizenieupism$/, ".HodnotaText")).toBe("b");
  });

  it("applies_treaty fills the Sb.m.s. row; písm. there is rejected", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      appliesTreaty: "209/1992",
      appliesProvision: "čl. 8",
    });
    expect(param(form, /^aplikovanepravnipredpisysbmscislo$/, ".HodnotaCislo")).toBe("209");
    expect(param(form, /^aplikovanepravnipredpisysbmsrok$/, ".HodnotaCislo")).toBe("1992");
    expect(param(form, /^aplikovanepravnipredpisysbmscl$/, ".HodnotaText")).toBe("8");
    expect(() =>
      buildNssSearchForm(SEARCH_FORM.fields, { appliesTreaty: "209/1992", appliesProvision: "čl. 8 písm. a" }),
    ).toThrowError(SourceError);
  });

  it("a community qualifier narrows the EU druh dial; on a Sb. act it is rejected", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, { appliesEuDirective: "2004/48/ES" });
    expect(param(form, /^aplikovanepravnipredpisysmerniceeudruh$/, ".HodnotaCiselnikPolozkySelected")).toBe("342");
    expect(param(form, /^aplikovanepravnipredpisysmerniceeudruh$/, ".HodnotaCiselnikPolozky")).toBe("ES");
    const regulation = buildNssSearchForm(SEARCH_FORM.fields, { appliesEuRegulation: "2016/679/EU" });
    expect(param(regulation, /^aplikovanepravnipredpisynarizenieudruh$/, ".HodnotaCiselnikPolozkySelected")).toBe("341");
    expect(() =>
      buildNssSearchForm(SEARCH_FORM.fields, { appliesAct: "106/1999/EU" }),
    ).toThrowError(SourceError);
  });

  it("strict locators never fall back to a same-suffix field and drift loudly", () => {
    // A form whose only .HodnotaCislo belongs to a DIFFERENT criterion:
    // findField's suffix fallback would happily (and wrongly) return it.
    const decoy = parseNssForm(`
      <html><body><form method="post">
      <input name="__RequestVerificationToken" type="hidden" value="tok" />
      <input name="vyhledavaciSekce[0].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].TechnickyNazev" type="hidden" value="oznacenivecideleneporadovecislo" />
      <input name="vyhledavaciSekce[0].vyhledavaciPodminka[0].vyhledavaciPodminkaHodnota[0].HodnotaCislo" type="text" value="" />
      </form></body></html>`);
    expect(findField(decoy, ".HodnotaCislo", null, /^aplikovanepravnipredpisysbcislo$/)?.name).toContain(
      "HodnotaCislo",
    );
    expect(findFieldStrict(decoy, /^aplikovanepravnipredpisysbcislo$/, ".HodnotaCislo")).toBeUndefined();
    try {
      buildNssSearchForm(decoy.fields, { appliesAct: "106/1999" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
    try {
      buildNssSearchForm(decoy.fields, { publishedFrom: "2026-08-01" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    }
  });

  it("rejects two applies_* filters and a provision without an act", () => {
    expect(() =>
      buildNssSearchForm(SEARCH_FORM.fields, { appliesAct: "106/1999", appliesEuDirective: "2004/48" }),
    ).toThrowError(SourceError);
    expect(() =>
      buildNssSearchForm(SEARCH_FORM.fields, { appliesProvision: "§ 17" }),
    ).toThrowError(SourceError);
  });

  it("validateNssApplies names the missing act — the message the generic guard must not shadow", () => {
    try {
      validateNssApplies({ appliesProvision: "§ 17" });
      expect.unreachable();
    } catch (error) {
      expect((error as SourceError).message).toContain("applies_provision needs an act");
      expect((error as SourceError).hint).toContain("applies_act");
    }
    expect(validateNssApplies({ appliesAct: "106/1999", appliesProvision: "§ 17" })).toEqual(["106/1999"]);
    expect(validateNssApplies({ query: "cokoli" })).toEqual([]);
  });

  it("published dates land in aktualizovano, decision dates in datumvydanirozhodnuti", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      publishedFrom: "2026-08-01",
      publishedTo: "2026-08-07",
      dateFrom: "2025-01-01",
    });
    // Zero-padded DD.MM.YYYY — byte-identical to the captured browser POST.
    expect(param(form, /^aktualizovano$/, ".HodnotaDatumACasOd")).toBe("01.08.2026");
    expect(param(form, /^aktualizovano$/, ".HodnotaDatumACasDo")).toBe("07.08.2026");
    expect(param(form, /^datumvydanirozhodnuti$/, ".HodnotaDatumACasOd")).toBe("01.01.2025");
  });

  it("full text and case number still target their captured fields", () => {
    const form = buildNssSearchForm(SEARCH_FORM.fields, {
      query: "nezákonný zásah",
      caseNumber: "1 Afs 25/2024",
    });
    expect(param(form, /^textDokumentu$/i, ".HodnotaText")).toBe("nezákonný zásah");
    expect(param(form, /^oznacenivecivcelku$/, ".HodnotaText")).toBe("1 Afs 25/2024");
  });
});

describe("isNssMissingBody", () => {
  it("detects the tiny N/A page", () => {
    expect(isNssMissingBody("<html><body>\n    N/A\n</body></html>")).toBe(true);
    expect(isNssMissingBody("N/A")).toBe(true);
    expect(isNssMissingBody("ROZSUDEK JMÉNEM REPUBLIKY " + "x".repeat(300))).toBe(false);
  });
});
