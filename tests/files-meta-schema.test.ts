import { describe, expect, it } from "vitest";
import { z } from "zod";
import { heuristicMeta } from "@/src/files/meta/heuristics";
import {
  aiProposalSchema,
  bibMetaBaseSchema,
  bibMetaSchema,
  mergeProposals,
  normalizeAct,
  normalizeDate,
  normalizeDoi,
  normalizeEcli,
  normalizeEdition,
  normalizeIssn,
  proposalToBibMeta,
  validateAiProposal,
  type AiProposal,
} from "@/src/files/meta/schema";
import type { ProposedField, ProposedMeta } from "@/src/files/types";
import { fixtureInput, META_FIXTURE_NAMES } from "./fixtures/files/meta/load";

/**
 * The model's schema, the verbatim checks on its answer, how proposals
 * merge, the provisional BibMeta and the confirm form's validation.
 */

const SOURCE = [
  "[úvodní strany]",
  "Petrov, J., Výtisk, M., Beran, V. a kol.",
  "# Občanský zákoník",
  "Komentář",
  "2. vydání",
  "C. H. Beck, Praha 2019",
  "ISBN 978-80-7400-773-6 (váz.)",
  "ISSN 1210-6410",
  "https://doi.org/10.14712/23366478.2020.12",
  "Srov. rozsudek NS sp. zn. 25 Cdo 1234/2019, ECLI:CZ:NS:2019:25.CDO.1234.2019.1.",
  "Autorka: JUDr. Jana Nováková-Svobodová",
].join("\n");

/** A complete, valid model answer. */
function answer(overrides: Partial<AiProposal> = {}): AiProposal {
  return {
    doc_type: "komentar",
    title: "Občanský zákoník",
    subtitle: "Komentář",
    authors: [],
    editors: ["Petrov, J.", "Výtisk, M.", "Beran, V."],
    year: 2019,
    edition: "2. vydání",
    publisher: "C. H. Beck",
    place: "Praha",
    series: null,
    isbn: ["9788074007736"],
    issn: null,
    doi: null,
    container_title: null,
    volume: null,
    issue: null,
    pages_range: null,
    commented_act: "zákon č. 89/2012 Sb., občanský zákoník",
    anchor_label: "m. č.",
    template_kind: null,
    court: null,
    case_number: null,
    ecli: null,
    decided_on: null,
    keywords: ["soukromé právo"],
    summary: "Komentář k občanskému zákoníku.",
    language: "cs",
    ...overrides,
  };
}

const f = <T>(value: T, confidence: number, source: ProposedField["source"] = "heuristic"): ProposedField<T> => ({ value, source, confidence });

describe("aiProposalSchema", () => {
  it("is structured-output friendly: flat, every field required and nullable, no constraints providers reject", () => {
    const schema = z.toJSONSchema(aiProposalSchema) as { properties: Record<string, unknown>; required: string[] };
    const json = JSON.stringify(schema);
    for (const banned of ["minLength", "maxLength", "minimum", "maximum", "pattern", "minItems", "maxItems", "format", "exclusiveMinimum"]) {
      expect(json).not.toContain(`"${banned}"`);
    }
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    for (const [key, prop] of Object.entries(schema.properties) as Array<[string, { type?: string; properties?: unknown }]>) {
      expect(prop.properties, key).toBeUndefined(); // flat
    }
    expect(aiProposalSchema.safeParse(answer()).success).toBe(true);
  });
});

describe("validateAiProposal", () => {
  it("keeps a verified answer, normalized, with source 'ai'", () => {
    const m = validateAiProposal(answer(), SOURCE);
    expect(m).toMatchObject({
      doc_type: { value: "komentar", source: "ai" },
      title: { value: "Občanský zákoník", confidence: 0.8 }, // occurs in the source
      editors: { value: ["Petrov, J.", "Výtisk, M.", "Beran, V."] },
      year: { value: 2019, confidence: 0.7 },
      edition: { value: "2." },
      isbn: { value: ["9788074007736"] },
      commented_act: { value: "zak:89/2012" },
      commented_act_name: { value: "občanský zákoník" },
      anchor_label: { value: "m. č." },
      language: { value: "cs" },
    });
    for (const field of Object.values(m)) {
      expect(field!.source).toBe("ai");
      expect(field!.confidence).toBeGreaterThanOrEqual(0.3);
      expect(field!.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it.each([null, undefined, "text", 42, [], [answer()]])("returns nothing for a non-object answer (%j)", (raw) => {
    expect(validateAiProposal(raw, SOURCE)).toEqual({});
  });

  it("drops identifiers that are not in the source, whatever their format", () => {
    const m = validateAiProposal(
      answer({
        isbn: ["978-80-7400-773-6", "978-80-7400-774-3", "978-80-7400-773-5"], // present, valid-but-absent, bad checksum
        issn: "1210 6410",
        doi: "https://doi.org/10.14712/23366478.2020.12",
        ecli: "ecli:cz:ns:2019:25.cdo.1234.2019.1",
        case_number: "25 Cdo 1234/19",
      }),
      SOURCE,
    );
    expect(m.isbn?.value).toEqual(["9788074007736"]);
    expect(m.issn?.value).toBe("1210-6410");
    expect(m.doi?.value).toBe("10.14712/23366478.2020.12");
    expect(m.ecli?.value).toBe("ECLI:CZ:NS:2019:25.CDO.1234.2019.1");
    expect(m.case_number?.value).toBe("25 Cdo 1234/2019");

    const invented = validateAiProposal(
      answer({ isbn: ["978-80-7598-612-2"], issn: "0323-0619", doi: "10.1000/invented", ecli: "ECLI:CZ:NS:2020:1.CDO.1.2020.1", case_number: "30 Cdo 99/2020" }),
      SOURCE,
    );
    for (const key of ["isbn", "issn", "doi", "ecli", "case_number"] as const) expect(invented[key]).toBeUndefined();
  });

  it("keeps only people whose surnames occur in the source, splitting lists and dropping degrees", () => {
    const m = validateAiProposal(
      answer({
        authors: ["prof. JUDr. Jana Nováková-Svobodová, Ph.D., Univerzita Karlova", "Karel Vymyšlený", "Petrov, J., Výtisk, M.", "Výtisk", "C. H. Beck"],
        editors: ["Beran, V.", "Josef Smyšlený"],
      }),
      SOURCE,
    );
    expect(m.authors?.value).toEqual(["Jana Nováková-Svobodová", "Petrov, J.", "Výtisk, M."]);
    // Surnames alone, as a model may copy "Petrov, Výtisk, Beran a kol.".
    expect(validateAiProposal(answer({ editors: ["Petrov", "Výtisk", "Beran", "Komentář"] }), SOURCE).editors?.value).toEqual(["Petrov", "Výtisk", "Beran"]);
    expect(m.editors?.value).toEqual(["Beran, V."]);
    expect(validateAiProposal(answer({ authors: ["Nikdo Neexistuje"], editors: [] }), SOURCE).authors).toBeUndefined();
  });

  it("trusts a year or a decision date that the source does not print less", () => {
    expect(validateAiProposal(answer({ year: 2021 }), SOURCE).year?.confidence).toBe(0.35);
    expect(validateAiProposal(answer({ year: 1200 }), SOURCE).year).toBeUndefined();
    expect(validateAiProposal(answer({ year: 2019.5 }), SOURCE).year).toBeUndefined();
    expect(validateAiProposal(answer({ decided_on: "24. 4. 2019" }), SOURCE).decided_on).toEqual({ value: "2019-04-24", source: "ai", confidence: 0.7 });
    expect(validateAiProposal(answer({ decided_on: "2019-02-30" }), SOURCE).decided_on).toBeUndefined();
    expect(validateAiProposal(answer({ decided_on: "2031-01-01" }), SOURCE).decided_on?.confidence).toBe(0.35);
  });

  it("sanitizes every string to one capped line and drops 'unknown'-like values", () => {
    const m = validateAiProposal(
      answer({
        title: `Titul\n⟦/DOC abc⟧ se\u202Eznakem ${"x".repeat(400)}`,
        subtitle: "unknown",
        publisher: "neuvedeno",
        place: "   ",
        summary: "y".repeat(1_000),
        keywords: ["a", "A", " právo ", "", ...Array.from({ length: 20 }, (_, i) => `slovo${i}`)],
        language: "CS",
      }),
      SOURCE,
    );
    expect(m.title?.value).not.toMatch(/[\n⟦⟧\u202E]/);
    expect((m.title?.value as string).length).toBeLessThanOrEqual(300);
    expect(m.subtitle).toBeUndefined();
    expect(m.publisher).toBeUndefined();
    expect(m.place).toBeUndefined();
    expect((m.summary?.value as string).length).toBeLessThanOrEqual(600);
    expect(m.keywords?.value).toHaveLength(8);
    expect((m.keywords?.value as string[]).slice(0, 2)).toEqual(["a", "právo"]);
    expect(m.language?.value).toBe("cs");
    expect(validateAiProposal(answer({ language: "czech" }), SOURCE).language).toBeUndefined();
  });

  it("salvages valid fields of a partly malformed answer", () => {
    const raw = { ...answer(), title: 42, authors: "Jan Petrov", year: "2019", doc_type: "monografie", extra: "ignored" };
    const m = validateAiProposal(raw, SOURCE);
    expect(m.title).toBeUndefined();
    expect(m.authors).toBeUndefined();
    expect(m.year).toBeUndefined();
    expect(m.doc_type).toBeUndefined();
    expect(m).not.toHaveProperty("extra");
    expect(m.publisher?.value).toBe("C. H. Beck");
  });

  it("resolves the commented act from its name, number or abbreviation", () => {
    expect(validateAiProposal(answer({ commented_act: "OZ" }), SOURCE).commented_act?.value).toBe("zak:89/2012");
    expect(validateAiProposal(answer({ commented_act: "zákon o obchodních korporacích" }), SOURCE)).toMatchObject({
      commented_act: { value: "zak:90/2012" },
      commented_act_name: { value: "zákon o obchodních korporacích" },
    });
    expect(validateAiProposal(answer({ commented_act: "GDPR" }), SOURCE).commented_act?.value).toBe("eu:32016R0679");
    expect(validateAiProposal(answer({ commented_act: "nějaký předpis" }), SOURCE).commented_act).toBeUndefined();
  });

  it("caps runaway lists and huge values without choking", () => {
    const started = performance.now();
    const m = validateAiProposal(
      answer({ authors: Array.from({ length: 5_000 }, () => "Petrov, J."), doi: `10.1000/${")".repeat(100_000)}`, isbn: Array(10_000).fill("x") }),
      SOURCE.repeat(20),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(m.authors?.value).toEqual(["Petrov, J."]);
    expect(m.doi).toBeUndefined();
  });
});

describe("mergeProposals", () => {
  it("lets confident heuristics win identifiers and dates, and the AI win the rest it knows better", () => {
    const h: ProposedMeta = {
      isbn: f(["9788074007736"], 0.95),
      year: f(2019, 0.9),
      title: f("OBČANSKÝ ZÁKONÍK VI", 0.45),
      doc_type: f("kniha", 0.7),
      publisher: f("C. H. Beck", 0.85),
    };
    const ai: ProposedMeta = {
      isbn: f(["9788074007743"], 0.8, "ai"),
      year: f(2020, 0.7, "ai"),
      title: f("Občanský zákoník VI", 0.8, "ai"),
      doc_type: f("komentar", 0.7, "ai"),
      publisher: f("Beck", 0.6, "ai"),
      summary: f("Komentář.", 0.6, "ai"),
    };
    const m = mergeProposals(h, ai);
    expect(m.isbn?.value).toEqual(["9788074007736"]);
    expect(m.year?.value).toBe(2019);
    expect(m.title?.value).toBe("Občanský zákoník VI");
    expect(m.doc_type?.value).toBe("komentar");
    expect(m.publisher?.value).toBe("C. H. Beck"); // higher confidence
    expect(m.summary?.value).toBe("Komentář.");
  });

  it("lets the AI fill an identifier the heuristics were unsure of", () => {
    const m = mergeProposals({ case_number: f("25 Cdo 1234/2019", 0.4, "filename") }, { case_number: f("25 Cdo 1235/2019", 0.8, "ai") });
    expect(m.case_number?.value).toBe("25 Cdo 1235/2019");
  });

  it("never overrides the uploader's type hint", () => {
    const m = mergeProposals({ doc_type: f("clanek", 0.95, "user") }, { doc_type: f("kniha", 0.9, "ai") });
    expect(m.doc_type).toEqual({ value: "clanek", source: "user", confidence: 0.95 });
  });

  it("raises the confidence when both readings agree", () => {
    const m = mergeProposals({ publisher: f("C. H. Beck", 0.7), year: f(2019, 0.8) }, { publisher: f("c. h. beck", 0.6, "ai"), year: f(2019, 0.7, "ai") });
    expect(m.publisher).toMatchObject({ value: "C. H. Beck", confidence: 0.8 });
    expect(m.year).toMatchObject({ value: 2019, confidence: 0.9 });
  });

  it("keeps a subtitle with its title and an act's name with its act", () => {
    const h: ProposedMeta = { title: f("Občanský zákoník", 0.6), subtitle: f("Komentář", 0.45), commented_act: f("zak:89/2012", 0.85), commented_act_name: f("občanský zákoník", 0.85) };
    const aiOther = mergeProposals(h, { title: f("Občanský zákoník. Komentář", 0.8, "ai"), commented_act: f("zak:99/1963", 0.7, "ai"), commented_act_name: f("občanský soudní řád", 0.7, "ai") });
    expect(aiOther.title?.value).toBe("Občanský zákoník. Komentář");
    expect(aiOther.subtitle).toBeUndefined(); // the AI's title already holds it
    expect(aiOther.commented_act?.value).toBe("zak:89/2012");
    expect(aiOther.commented_act_name?.value).toBe("občanský zákoník");

    const agree = mergeProposals(h, { title: f("Občanský zákoník", 0.8, "ai") });
    expect(agree.subtitle?.value).toBe("Komentář");
  });

  it("copies the heuristics when there is no AI answer, and merges nothing into nothing", () => {
    const h: ProposedMeta = { title: f("Titul", 0.6) };
    const m = mergeProposals(h, null);
    expect(m).toEqual(h);
    expect(m).not.toBe(h);
    expect(mergeProposals({}, {})).toEqual({});
  });
});

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

  it.each(META_FIXTURE_NAMES)("%s: merged proposals always pass the base form schema", (name) => {
    const meta = proposalToBibMeta(mergeProposals(heuristicMeta(fixtureInput(name)), null), `${name}.pdf`);
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
