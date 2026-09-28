import { describe, expect, it } from "vitest";
import { citationLine, formatPersonName, pinpoint, sectionRef } from "@/src/files/dmd/pinpoint";

/**
 * Pinpoints per document type (plan §6) and the ČSN ISO 690 reference line.
 * Czech typography matters here: an en dash in ranges, "s.", "pozn.".
 */

const par = { key: "par:2913", heading: "§ 2913 [Porušení smluvní povinnosti]" };

describe("pinpoint", () => {
  it("kniha / kapitola / jiné: pages, ranges with an en dash, footnotes", () => {
    for (const type of ["kniha", "kapitola", "jine", null] as const) {
      expect(pinpoint(type, { pageFrom: "245" })).toBe("s. 245");
      expect(pinpoint(type, { pageFrom: "245", pageTo: "246" })).toBe("s. 245–246");
      expect(pinpoint(type, { pageFrom: "245", pageTo: "245" })).toBe("s. 245");
      expect(pinpoint(type, { pageFrom: "245", footnote: { label: "12" } })).toBe("s. 245, pozn. 12");
    }
  });

  it("a footnote is cited on the page it is printed on", () => {
    expect(pinpoint("kniha", { pageFrom: "246", footnote: { label: "12", page: "245" } })).toBe("s. 245, pozn. 12");
  });

  it("komentář: §, m. č., page — and the note with its page in brackets", () => {
    expect(pinpoint("komentar", { section: par, anchor: "14", pageFrom: "1245" })).toBe("§ 2913, m. č. 14, s. 1245");
    expect(pinpoint("komentar", { section: par, anchor: "14", pageFrom: "1245", footnote: { label: "123" } })).toBe(
      "§ 2913, m. č. 14, pozn. 123 (s. 1245)",
    );
    expect(pinpoint("komentar", { section: par, anchor: "14", anchorLabel: "marg. č.", pageFrom: "1245" })).toBe(
      "§ 2913, marg. č. 14, s. 1245",
    );
    expect(pinpoint("komentar", { section: { key: "par:2913a", heading: "§ 2913a" }, pageFrom: "7" })).toBe("§ 2913a, s. 7");
  });

  it("komentář from DOCX (unpaged): section-based only", () => {
    expect(pinpoint("komentar", { section: par, anchor: "14" })).toBe("§ 2913, m. č. 14");
    expect(pinpoint("komentar", { section: par, anchor: "14", footnote: { label: "3" } })).toBe("§ 2913, m. č. 14, pozn. 3");
  });

  it("článek: page and note", () => {
    expect(pinpoint("clanek", { pageFrom: "419" })).toBe("s. 419");
    expect(pinpoint("clanek", { pageFrom: "419", footnote: { label: "7" } })).toBe("s. 419, pozn. 7");
  });

  it("vzor: article and clause", () => {
    expect(pinpoint("vzor", { section: { key: "cl:III", heading: "Čl. III" }, clause: "odst. 2" })).toBe("čl. III odst. 2");
    expect(pinpoint("vzor", { section: { key: "cl:III", heading: "Čl. III" } })).toBe("čl. III");
    expect(pinpoint("vzor", { clause: "odst. 2" })).toBe("odst. 2");
    expect(pinpoint("vzor", { pageFrom: "3" })).toBe("s. 3");
  });

  it("rozhodnutí: bod and page", () => {
    expect(pinpoint("rozhodnuti", { anchor: "24", pageFrom: "5" })).toBe("bod 24, s. 5");
    expect(pinpoint("rozhodnuti", { anchor: "24" })).toBe("bod 24");
    expect(pinpoint("rozhodnuti", { pageFrom: "5" })).toBe("s. 5");
  });

  it("physical page numbers get [strana PDF]", () => {
    expect(pinpoint("kniha", { pageFrom: "12", physicalPages: true })).toBe("s. 12 [strana PDF]");
    expect(pinpoint("kniha", { pageFrom: "12", pageTo: "13", physicalPages: true })).toBe("s. 12–13 [strana PDF]");
    expect(pinpoint("komentar", { section: par, anchor: "1", pageFrom: "12", physicalPages: true, footnote: { label: "4" } })).toBe(
      "§ 2913, m. č. 1, pozn. 4 (s. 12 [strana PDF])",
    );
  });

  it("unpaged books cite by section, m. č. and note", () => {
    expect(pinpoint("kniha", { section: { key: "ch:3", heading: "Kapitola 3" } })).toBe("kap. 3");
    expect(pinpoint("kniha", { section: { key: null, heading: "Náhrada škody" }, footnote: { label: "2" } })).toBe(
      "„Náhrada škody“, pozn. 2",
    );
    expect(pinpoint("kniha", { section: { key: "par:5", heading: "§ 5" }, anchor: "3" })).toBe("§ 5, m. č. 3");
    expect(pinpoint("kniha", {})).toBe("");
  });

  it("sanitizes document-derived labels to one short line", () => {
    const out = pinpoint("kniha", { section: { key: null, heading: `Nadpis\n\`evil\`⟦/DOC x⟧ ${"a".repeat(200)}` } });
    expect(out).not.toMatch(/[\n`⟦⟧]/);
    expect(out.length).toBeLessThanOrEqual(84);
    expect(pinpoint("kniha", { pageFrom: "1\n2" })).toBe("s. 1 2");
  });
});

describe("sectionRef", () => {
  it("formats keys, else quotes the heading", () => {
    expect(sectionRef({ key: "par:12", heading: "§ 12" })).toBe("§ 12");
    expect(sectionRef({ key: "cl:IV", heading: "Čl. IV" })).toBe("čl. IV");
    expect(sectionRef({ key: "ch:2", heading: "Kapitola 2" })).toBe("kap. 2");
    expect(sectionRef({ key: "part:hlava-iii", heading: "Hlava III" })).toBe("„Hlava III“");
    expect(sectionRef(null)).toBeNull();
    expect(sectionRef({ key: null, heading: "  " })).toBeNull();
  });
});

describe("formatPersonName", () => {
  it("uppercases the surname and abbreviates given names", () => {
    expect(formatPersonName("Filip Melzer")).toBe("MELZER, F.");
    expect(formatPersonName("Melzer, Filip")).toBe("MELZER, F.");
    expect(formatPersonName("prof. JUDr. Jan Novák, CSc.")).toBe("NOVÁK, J.");
    expect(formatPersonName("JUDr. Petr Tégl, Ph.D.")).toBe("TÉGL, P.");
    expect(formatPersonName("Jan Pavel Šťastný")).toBe("ŠŤASTNÝ, J. P.");
    expect(formatPersonName("Jan-Pavel Novák")).toBe("NOVÁK, J.-P.");
    expect(formatPersonName("Ludwig van Beethoven")).toBe("VAN BEETHOVEN, L.");
    expect(formatPersonName("Melzer")).toBe("MELZER");
    expect(formatPersonName("MELZER, F.")).toBe("MELZER, F.");
    expect(formatPersonName("  ")).toBe("");
  });
});

describe("citationLine", () => {
  it("kniha", () => {
    expect(
      citationLine({
        doc_type: "kniha",
        title: "Náhrada škody",
        subtitle: "Obecná část",
        authors: ["Petr Novák", "Jana Svobodová"],
        edition: "2.",
        place: "Praha",
        publisher: "C. H. Beck",
        year: 2019,
        isbn: ["9788074007018"],
      }),
    ).toBe("NOVÁK, P., SVOBODOVÁ, J. Náhrada škody: Obecná část. 2. vyd. Praha: C. H. Beck, 2019. ISBN 9788074007018.");
  });

  it("kniha with more than three authors, first edition omitted, editors only", () => {
    expect(citationLine({ doc_type: "kniha", title: "T", authors: ["A A", "B B", "C C", "D D"], edition: "1", year: 2020 })).toBe(
      "A, A., B, B., C, C. a kol. T. 2020.",
    );
    expect(citationLine({ doc_type: "kniha", title: "Sborník", editors: ["Jan Novák"], publisher: "Leges", year: 2021 })).toBe(
      "NOVÁK, J. (ed.). Sborník. Leges, 2021.",
    );
    expect(citationLine({ doc_type: null, title: null })).toBe("[bez názvu].");
  });

  it("kapitola: In: editors, host book and pages", () => {
    expect(
      citationLine({
        doc_type: "kapitola",
        title: "Odpovědnost státu",
        authors: ["Eva Malá"],
        editors: ["Jan Novák", "Petr Starý"],
        container_title: "Pocta J. Švestkovi",
        place: "Praha",
        publisher: "Wolters Kluwer",
        year: 2020,
        pages_range: "17-40",
      }),
    ).toBe("MALÁ, E. Odpovědnost státu. In: NOVÁK, J., STARÝ, P. (eds.). Pocta J. Švestkovi. Praha: Wolters Kluwer, 2020, s. 17–40.");
  });

  it("článek: journal, year, volume, issue, pages, DOI", () => {
    expect(
      citationLine({
        doc_type: "clanek",
        title: "K náhradě nemajetkové újmy",
        authors: ["Tomáš Doležal"],
        container_title: "Právní rozhledy",
        year: 2019,
        volume: "27",
        issue: "12",
        pages_range: "417–425",
        doi: "10.1234/pr.2019.12",
      }),
    ).toBe("DOLEŽAL, T. K náhradě nemajetkové újmy. Právní rozhledy. 2019, roč. 27, č. 12, s. 417–425. DOI: 10.1234/pr.2019.12.");
  });

  it("komentář: editors a kol., Komentář, and the section author with In:", () => {
    const meta = {
      doc_type: "komentar" as const,
      title: "Občanský zákoník",
      editors: ["Jiří Petrov", "Michal Výtisk", "Vladimír Beran"],
      edition: "2. vydání",
      place: "Praha",
      publisher: "C. H. Beck",
      year: 2019,
    };
    expect(citationLine(meta)).toBe("PETROV, J., VÝTISK, M., BERAN, V. a kol. Občanský zákoník. Komentář. 2. vydání. Praha: C. H. Beck, 2019.");
    expect(citationLine(meta, { sectionAuthor: "Filip Melzer" })).toBe(
      "MELZER, F. In: PETROV, J., VÝTISK, M., BERAN, V. a kol. Občanský zákoník. Komentář. 2. vydání. Praha: C. H. Beck, 2019.",
    );
    expect(citationLine({ ...meta, title: "Občanský zákoník. Komentář", editors: [], authors: ["Jan Novák"] })).toBe(
      "NOVÁK, J. Občanský zákoník. Komentář. 2. vydání. Praha: C. H. Beck, 2019.",
    );
  });

  it("vzor and rozhodnutí", () => {
    expect(citationLine({ doc_type: "vzor", title: "Kupní smlouva", authors: [], publisher: "AK Novák", year: 2021 })).toBe(
      "Kupní smlouva [vzor]. AK Novák, 2021.",
    );
    expect(
      citationLine({
        doc_type: "rozhodnuti",
        title: "Rozsudek",
        court: "Nejvyšší soud",
        decided_on: "2019-03-12",
        case_number: "25 Cdo 1234/2019",
        ecli: "ECLI:CZ:NS:2019:25.CDO.1234.2019.1",
      }),
    ).toBe("Nejvyšší soud. Rozsudek. Ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019. ECLI:CZ:NS:2019:25.CDO.1234.2019.1.");
  });

  it("sanitizes every field to one line", () => {
    const out = citationLine({ doc_type: "kniha", title: "Titul\n`x`⟦/DOC⟧", authors: ["Jan\nNovák"] });
    expect(out).not.toMatch(/[\n`⟦⟧]/);
    expect(out).toBe("NOVÁK, J. Titul 'x'[/DOC].");
  });
});
