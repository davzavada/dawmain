import { describe, expect, it } from "vitest";
import { z } from "zod";
import { heuristicMeta } from "@/src/files/meta/heuristics";
import {
  bibMetaBaseSchema,
  bibMetaSchema,
  normalizeAct,
  normalizeDate,
  normalizeDoi,
  normalizeEcli,
  normalizeEdition,
  normalizeIssn,
  proposalToBibMeta,
} from "@/src/files/meta/schema";
import type { ProposedField, ProposedMeta } from "@/src/files/types";
import { fixtureInput, META_FIXTURE_NAMES } from "./fixtures/files/meta/load";

/**
 * The provisional BibMeta built from the server's proposal and the confirm
 * form's validation.
 */

const f = <T>(value: T, confidence: number, source: ProposedField["source"] = "heuristic"): ProposedField<T> => ({ value, source, confidence });

describe("proposalToBibMeta", () => {
  it("fills defaults and falls back to the file name for the title", () => {
    expect(proposalToBibMeta({}, "C:\\Users\\x\\Petrov_OZ-komentar.pdf")).toEqual({
      doc_type: "jine",
      title: "Petrov_OZ-komentar",
      subtitle: null,
      authors: [],
      editors: [],
      year: null,
      edition: null,
      publisher: null,
      place: null,
      series: null,
      isbn: [],
      issn: null,
      doi: null,
      container_title: null,
      volume: null,
      issue: null,
      pages_range: null,
      commented_act: null,
      commented_act_name: null,
      section_range: null,
      anchor_label: null,
      template_kind: null,
      court: null,
      case_number: null,
      ecli: null,
      decided_on: null,
      keywords: [],
      summary: null,
      language: "cs",
    });
    expect(proposalToBibMeta({ summary: { value: "Shrnutí z abstraktu.", source: "heuristic", confidence: 0.6 } }, "a.pdf").summary).toBeNull();
    expect(proposalToBibMeta({}, "").title).toBe("Bez názvu");
    expect(proposalToBibMeta({}, ".pdf").title).toBe("Bez názvu");
  });

  it("leaves out fields of other document types", () => {
    const p: ProposedMeta = {
      doc_type: f("kniha", 0.7),
      court: f("Nejvyšší soud", 0.8),
      case_number: f("25 Cdo 1234/2019", 0.8),
      commented_act: f("zak:89/2012", 0.8),
      template_kind: f("smlouva", 0.7),
    };
    const meta = proposalToBibMeta(p, "a.pdf");
    expect(meta).toMatchObject({ doc_type: "kniha", court: null, case_number: null, commented_act: null, template_kind: null });
    const komentar = proposalToBibMeta({ ...p, doc_type: f("komentar", 0.8) }, "a.pdf");
    expect(komentar).toMatchObject({ commented_act: "zak:89/2012", commented_act_name: "občanský zákoník" });
  });

  it("caps and normalizes whatever the proposals hold", () => {
    const p = {
      title: f("T".repeat(1_000), 0.6),
      authors: f(Array.from({ length: 30 }, (_, i) => `Autor Číslo${i}`), 0.6),
      keywords: f(Array.from({ length: 30 }, (_, i) => `slovo ${i}`), 0.6),
      isbn: f(["978-80-7400-773-6", "bad", "9788074007736"], 0.9),
      issn: f("12106410", 0.9),
      doi: f("DOI: 10.1000/ABC", 0.9),
      year: f(3000, 0.9),
      pages_range: f("417 - 425", 0.7),
      language: f("xx-yy", 0.7),
      anchor_label: f("odst.", 0.7),
    } as unknown as ProposedMeta;
    const meta = proposalToBibMeta(p, "a.pdf");
    expect(meta.title.length).toBeLessThanOrEqual(300);
    expect(meta.authors).toHaveLength(10);
    expect(meta.keywords).toHaveLength(8);
    expect(meta.isbn).toEqual(["9788074007736"]);
    expect(meta.issn).toBe("1210-6410");
    expect(meta.doi).toBe("10.1000/abc");
    expect(meta.year).toBeNull();
    expect(meta.pages_range).toBe("417–425");
    expect(meta.language).toBe("cs");
    expect(meta.anchor_label).toBeNull();
  });

  it.each(META_FIXTURE_NAMES)("%s: the heuristic proposal always passes the base form schema", (name) => {
    const meta = proposalToBibMeta(heuristicMeta(fixtureInput(name)), `${name}.pdf`);
    const parsed = bibMetaBaseSchema.safeParse(meta);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toEqual(meta); // already normalized: the form schema changes nothing
  });
});

describe("bibMetaSchema (confirm form)", () => {
  const form = {
    doc_type: "komentar",
    title: "  Občanský zákoník  ",
    subtitle: "",
    authors: "Jan Petrov\nMichal Výtisk\n\nJan Petrov",
    editors: [],
    year: "2019",
    edition: "2. vydání",
    publisher: "C. H. Beck",
    place: "Praha",
    series: null,
    isbn: "978-80-7400-773-6; 80-7179-526-7",
    issn: "12106410",
    doi: "https://doi.org/10.14712/23366478.2020.12",
    container_title: "",
    volume: "",
    issue: "",
    pages_range: "417-425",
    commented_act: "89/2012 Sb.",
    commented_act_name: "",
    section_range: "",
    anchor_label: "m. č.",
    template_kind: "",
    court: "",
    case_number: "25 Cdo 1234/19",
    ecli: "ecli:cz:ns:2019:25.cdo.1234.2019.1",
    decided_on: "24. 4. 2019",
    keywords: ["soukromé právo", "Soukromé právo"],
    summary: "",
    language: "",
  };

  it("normalizes a submitted form", () => {
    const parsed = bibMetaSchema.safeParse(form);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toMatchObject({
      title: "Občanský zákoník",
      subtitle: null,
      authors: ["Jan Petrov", "Michal Výtisk"],
      year: 2019,
      edition: "2.",
      isbn: ["9788074007736", "9788071795261"],
      issn: "1210-6410",
      doi: "10.14712/23366478.2020.12",
      pages_range: "417–425",
      commented_act: "zak:89/2012",
      commented_act_name: "občanský zákoník",
      template_kind: null,
      case_number: "25 Cdo 1234/2019",
      ecli: "ECLI:CZ:NS:2019:25.CDO.1234.2019.1",
      decided_on: "2019-04-24",
      keywords: ["soukromé právo"],
      language: "cs",
    });
  });

  it("accepts a minimal form with missing optional keys", () => {
    const parsed = bibMetaSchema.safeParse({ doc_type: "kniha", title: "Kniha" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ authors: [], isbn: [], year: null, language: "cs" });
  });

  function issues(input: unknown, schema: z.ZodType = bibMetaSchema) {
    const parsed = schema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }

  it.each([
    [{ title: "" }, "title: Vyplňte název."],
    [{ title: "x".repeat(301) }, "title: Název může mít nejvýš 300 znaků."],
    [{ doc_type: "monografie" }, "doc_type: Vyberte typ dokumentu."],
    [{ year: "abc" }, "year: Rok zadejte číslem."],
    [{ year: 1499 }, "year: Rok musí být mezi 1500 a 2100."],
    [{ year: 2019.5 }, "year: Rok zadejte celým číslem."],
    [{ isbn: ["978-80-7400-773-5"] }, "isbn.0: Neplatné ISBN (nesedí kontrolní číslice)."],
    [{ issn: "1210-6411" }, "issn: Neplatné ISSN (očekává se např. 1210-6410)."],
    [{ doi: "doi-neni" }, "doi: Neplatné DOI (očekává se např. 10.14712/23366478.2020.12)."],
    [{ ecli: "ECLI:nic" }, "ecli: Neplatné ECLI (očekává se např. ECLI:CZ:NS:2019:25.CDO.1234.2019.1)."],
    [{ decided_on: "31. 2. 2019" }, "decided_on: Datum rozhodnutí zadejte jako 24. 4. 2019."],
    [{ decided_on: "2019-02-31" }, "decided_on: Datum rozhodnutí neexistuje."],
    [{ commented_act: "nějaký zákon" }, "commented_act: Komentovaný předpis zadejte číslem a rokem, např. 89/2012 (nebo CELEX 32016R0679)."],
    [{ keywords: Array.from({ length: 9 }, (_, i) => `k${i}`) }, "keywords: Klíčová slova: nejvýš 8 položek."],
    [{ authors: Array.from({ length: 11 }, (_, i) => `Autor ${i}`) }, "authors: Autoři: nejvýš 10 položek."],
    [{ summary: "s".repeat(601) }, "summary: Shrnutí může mít nejvýš 600 znaků."],
    [{ anchor_label: "odst." }, "anchor_label: Označení marginálních čísel: vyberte z nabídky."],
    [{ pages_range: "417–425; DROP TABLE" }, "pages_range: Rozsah stran zadejte např. jako 417–425."],
    [{ language: "čeština" }, "language: Jazyk zadejte kódem, např. cs."],
    [{ isbn: [42] }, "isbn.0: ISBN: neplatná hodnota."],
  ])("rejects %j with a Czech message", (patch, message) => {
    expect(issues({ ...form, ...patch })).toContain(message);
  });

  it("rejects unknown keys (strict)", () => {
    expect(issues({ ...form, id: "x" }).join("\n")).toMatch(/Unrecognized key/);
  });

  it("requires the commented act of a commentary on confirmation, not in the base schema", () => {
    const noAct = { ...form, commented_act: "" };
    expect(issues(noAct)).toEqual(["commented_act: U komentáře vyplňte komentovaný předpis (např. 89/2012)."]);
    expect(issues(noAct, bibMetaBaseSchema)).toEqual([]);
    expect(issues({ ...noAct, doc_type: "kniha" })).toEqual([]);
  });

  it("accepts an act by abbreviation or CELEX and keeps a typed name", () => {
    expect(bibMetaSchema.safeParse({ ...form, commented_act: "OSŘ" }).data?.commented_act).toBe("zak:99/1963");
    const eu = bibMetaSchema.safeParse({ ...form, commented_act: "32016R0679", commented_act_name: "GDPR" }).data;
    expect(eu).toMatchObject({ commented_act: "eu:32016R0679", commented_act_name: "GDPR" });
  });

  it("collapses multi-line and control characters in text fields", () => {
    const parsed = bibMetaSchema.safeParse({ ...form, title: "Občanský\nzákoník\u0007 ⟦DOC⟧", summary: "a\n\nb" });
    expect(parsed.data?.title).toBe("Občanský zákoník [DOC]");
    expect(parsed.data?.summary).toBe("a b");
  });
});

describe("normalizers", () => {
  it("normalizeIssn / normalizeDoi / normalizeEcli / normalizeDate / normalizeAct / normalizeEdition", () => {
    expect(normalizeIssn("ISSN 0323 0619")).toBe("0323-0619");
    expect(normalizeIssn("2336-647x")).toBeNull();
    expect(normalizeIssn("1".repeat(600))).toBeNull();
    expect(normalizeDoi("doi: 10.1000/ABC).")).toBe("10.1000/abc");
    expect(normalizeDoi("10.1000/a(b)")).toBe("10.1000/a(b)");
    expect(normalizeDoi("11.1000/x")).toBeNull();
    expect(normalizeEcli(" ecli:eu:c:2019:123. ")).toBe("ECLI:EU:C:2019:123");
    expect(normalizeEcli("ECLI:CZ")).toBeNull();
    expect(normalizeDate("24.04.2019")).toBe("2019-04-24");
    expect(normalizeDate("24. dubna 2019")).toBe("2019-04-24");
    expect(normalizeDate("29. 2. 2019")).toBeNull();
    expect(normalizeDate("1. 1. 1850")).toBeNull();
    expect(normalizeAct("zak:89/2012")).toBe("zak:89/2012");
    expect(normalizeAct("0089/2012")).toBe("zak:89/2012");
    expect(normalizeAct("eu:32016r0679")).toBe("eu:32016R0679");
    expect(normalizeAct("x".repeat(600))).toBeNull();
    expect(normalizeEdition("2")).toBe("2.");
    expect(normalizeEdition("druhé vydání")).toBe("2.");
    expect(normalizeEdition("Vydání první")).toBe("1.");
    expect(normalizeEdition("2., přepracované vydání")).toBe("2.");
    expect(normalizeEdition("dotisk 1. vydání")).toBe("dotisk 1. vydání");
    expect(normalizeEdition("")).toBeNull();
  });
});
