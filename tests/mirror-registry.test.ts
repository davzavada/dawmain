import { describe, expect, it } from "vitest";
import { actKind, euActsYearQuery, parseCellarActs, parseEsbirkaActs, shortTitleOf, titleNames } from "@/src/mirror/legal/registry";

describe("act names from official titles (e-Sbírka)", () => {
  it("takes the subject after 'o', past the issuer, cut before amendments", () => {
    expect(titleNames("Zákon České národní rady o daních z příjmů")).toEqual(["zákon o daních z příjmů"]);
    expect(titleNames("Zákon o obchodních společnostech a družstvech (zákon o obchodních korporacích)")).toEqual([
      "zákon o obchodních společnostech a družstvech",
      "zákon o obchodních korporacích",
    ]);
    expect(titleNames("Zákon o provozu na pozemních komunikacích a o změnách některých zákonů")).toEqual(["zákon o provozu na pozemních komunikacích"]);
    expect(titleNames("Vyhláška Ministerstva spravedlnosti o odměnách advokátů a náhradách advokátů za poskytování právních služeb (advokátní tarif)")).toEqual([
      "vyhláška o odměnách advokátů a náhradách advokátů za poskytování právních služeb",
      "advokátní tarif",
    ]);
    expect(titleNames("Zákon ze dne 13. července 1999 o pojištění odpovědnosti za škodu způsobenou provozem vozidla a o změně některých souvisejících zákonů (zákon o pojištění odpovědnosti z provozu vozidla)")).toContain("zákon o pojištění odpovědnosti z provozu vozidla");
  });

  it("keeps out one-word subjects and remarks in parentheses", () => {
    expect(titleNames("Zákon o obcích")).toEqual([]);
    expect(shortTitleOf("Zákon o zrušení … (úplné znění, jak vyplývá z pozdějších změn a doplnění)")).toBeNull();
    expect(shortTitleOf("Nařízení vlády o soutěži (II. kolo)")).toBeNull();
    expect(shortTitleOf("Zákon o obcích (obecní zřízení)")).toBe("obecní zřízení");
    expect(actKind("Nařízení vlády o …")).toBe("nařízení vlády");
  });

  it("reads the Sbírka zákonů and the Sbírka mezinárodních smluv, skipping unnumbered notices", () => {
    const { acts, aliases } = parseEsbirkaActs([
      { "akt-sbírka-kód": "sb", "akt-číslo-předpisu": "90", "akt-rok-předpisu": 2012, "akt-název-vyhlášený": "Zákon o obchodních společnostech a družstvech (zákon o obchodních korporacích)" },
      { "akt-sbírka-kód": "sm", "akt-číslo-předpisu": "012", "akt-rok-předpisu": 2005, "akt-název-vyhlášený": "Sdělení o sjednání úmluvy" },
      { "akt-sbírka-kód": "sb", "akt-číslo-předpisu": "n1", "akt-rok-předpisu": 1960, "akt-název-vyhlášený": "Oznámení" },
      { "akt-sbírka-kód": "ul1", "akt-číslo-předpisu": "1", "akt-rok-předpisu": 1950, "akt-název-vyhlášený": "Vyhláška" },
    ]);
    expect(acts.map((a) => a.id)).toEqual(["zak:90/2012", "sm:12/2005"]);
    expect(acts[0]).toMatchObject({ kind: "zákon", shortTitle: "zákon o obchodních korporacích" });
    expect(aliases.map((a) => a.alias)).toContain("zákon o obchodních korporacích");
  });
});

describe("EU acts (Cellar)", () => {
  it("maps CELEX of regulations, directives and decisions", () => {
    const acts = parseCellarActs({
      results: {
        bindings: [
          { celex: { value: "32016R0679" }, title: { value: "Nařízení Evropského parlamentu a Rady (EU) 2016/679 …" } },
          { celex: { value: "31993L0013" }, title: { value: "Směrnice Rady 93/13/EHS …" } },
          { celex: { value: "32016R0679" }, title: { value: "duplicate" } },
          { celex: { value: "52016PC0001" } },
        ],
      },
    });
    expect(acts.map((a) => [a.id, a.kind, a.number, a.year])).toEqual([
      ["eu:32016R0679", "nařízení", "679", 2016],
      ["eu:31993L0013", "směrnice", "13", 1993],
    ]);
    expect(euActsYearQuery(2016)).toContain('"^32016[RLD][0-9]{4}$"');
    expect(() => euActsYearQuery(16)).toThrow();
  });
});
