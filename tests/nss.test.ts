import { describe, expect, it } from "vitest";
import {
  findField,
  isNssMissingBody,
  parseNssDetail,
  parseNssForm,
  parseNssResults,
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
  it("reads span.det-textval values from the confirmed div ids", () => {
    const metadata = parseNssDetail(`
      <div id="ecli"><span class="det-textval" title="e">ECLI:CZ:NSS:2026:1.AFS.25.2024.30</span></div>
      <div id="soudcezpravodaj"><span class="det-textval">JUDr. Jana Nováková</span></div>
      <div id="datumvydanirozhodnuti"><span class="det-textval">10.06.2026</span></div>`);
    expect(metadata["ECLI"]).toContain("ECLI:CZ:NSS");
    expect(metadata["Soudce zpravodaj"]).toBe("JUDr. Jana Nováková");
  });
});

describe("isNssMissingBody", () => {
  it("detects the tiny N/A page", () => {
    expect(isNssMissingBody("<html><body>\n    N/A\n</body></html>")).toBe(true);
    expect(isNssMissingBody("N/A")).toBe(true);
    expect(isNssMissingBody("ROZSUDEK JMÉNEM REPUBLIKY " + "x".repeat(300))).toBe(false);
  });
});
