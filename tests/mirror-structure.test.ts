import { describe, expect, it } from "vitest";
import { deriveStructure, justiceParts, structureOf, verdictText } from "@/src/mirror/structure";

const part = (body: string, s: { start: number; end: number }) => body.slice(s.start, s.end);
const kinds = (body: string) => deriveStructure(body).sections.map((s) => s.kind);

describe("sections by their opening lines", () => {
  const ns = [
    "Nejvyšší soud rozhodl v senátě složeném z předsedy JUDr. A. B. ve věci žalobce C. D., proti žalovanému E. F., o zaplacení 10 000 Kč, t a k t o :",
    "",
    "I. Dovolání se odmítá.",
    "",
    "II. Žalobce je povinen zaplatit žalovanému na náhradě nákladů dovolacího řízení 3 000 Kč.",
    "",
    "O d ů v o d n ě n í (§ 243f odst. 3 o. s. ř.) :",
    "",
    "1. Okresní soud žalobu zamítl. Uvedl tři důvody:",
    "1. první, 2. druhý.",
    "2. Odvolací soud rozsudek potvrdil.",
    "",
    "3. Dovolání není přípustné.",
    "",
    "Poučení: Proti tomuto usnesení není přípustný opravný prostředek.",
    "",
    "V Brně dne 23. 5. 2018",
  ].join("\n");

  it("finds záhlaví, výrok, odůvodnění and poučení, with letter-spaced headings", () => {
    const s = deriveStructure(ns);
    expect(s.sections.map((x) => x.kind)).toEqual(["zahlavi", "vyrok", "oduvodneni", "pouceni"]);
    const vyrok = part(ns, s.sections[1]);
    expect(vyrok.startsWith("I. Dovolání se odmítá.")).toBe(true);
    expect(vyrok.endsWith("3 000 Kč.")).toBe(true);
    expect(part(ns, s.sections[2]).startsWith("O d ů v o d n ě n í")).toBe(true);
    expect(verdictText(ns, s)).toBe(vyrok);
  });

  it("numbers the body paragraphs in sequence, a list inside one is not a new one", () => {
    const s = deriveStructure(ns);
    expect(s.paragraphs.map((p) => p.num)).toEqual(["1", "2", "3"]);
    expect(part(ns, s.paragraphs[0])).toBe("1. Okresní soud žalobu zamítl. Uvedl tři důvody:\n1. první, 2. druhý.");
    expect(part(ns, s.paragraphs[2])).toBe("3. Dovolání není přípustné.");
  });

  it("reads NSS [n] paragraphs and Roman headings, also a numeral alone on its line", () => {
    const nss = "rozhodl takto:\nKasační stížnost se zamítá.\nOdůvodnění:\nI. Vymezení věci\n[1] Žalobce napadl rozhodnutí.\n[2] Krajský soud žalobu zamítl.\nII.\nPosouzení věci\n[3] Kasační stížnost není důvodná.\nPoučení: Proti tomuto rozsudku nejsou opravné prostředky přípustné.";
    const s = deriveStructure(nss);
    expect(s.paragraphs.map((p) => p.num)).toEqual(["1", "2", "3"]);
    expect(s.headings.map((h) => h.text)).toEqual(["I. Vymezení věci", "II. Posouzení věci"]);
  });

  it("without the odůvodnění's heading keeps the výrok to its own paragraphs", () => {
    const nd = "Nejvyšší soud rozhodl takto:\n\nVěc se přikazuje Okresnímu soudu v Liberci.\n\nOkresní soud v České Lípě navrhl přikázání věci, neboť obviněný bydlí v Liberci.\n\nV Brně 5. června 2013";
    const s = deriveStructure(nd);
    expect(verdictText(nd, s)).toBe("Věc se přikazuje Okresnímu soudu v Liberci.");
  });

  it("leaves out what it cannot find, and puts a dissent apart", () => {
    // A Sbírka excerpt: the reasons without the výrok.
    expect(kinds("Z odůvodnění:\nSoud prvního stupně rozhodl.")).toEqual(["oduvodneni"]);
    expect(kinds("Soud prvního stupně rozhodl a odvolací soud jeho rozhodnutí potvrdil.")).toEqual([]);
    const us = "Ústavní soud rozhodl takto:\nÚstavní stížnost se zamítá.\nOdůvodnění\n1. Stěžovatel namítá.\n2. Nemá pravdu.\nPoučení: Proti rozhodnutí není odvolání přípustné.\n\nOdlišné stanovisko soudce X\nNesouhlasím.";
    const s = deriveStructure(us);
    expect(s.sections.map((x) => x.kind)).toEqual(["zahlavi", "vyrok", "oduvodneni", "pouceni", "stanovisko"]);
    expect(part(us, s.sections[3])).toBe("Poučení: Proti rozhodnutí není odvolání přípustné.");
  });
});

describe("justice: the finaldoc's sections, exact", () => {
  const parts = { header: "Okresní soud rozhodl", verdict: "I. Žaloba se zamítá.", justification: "1. Žalobce se domáhal.\n2. Soud zjistil.", information: "Proti rozsudku lze podat odvolání." };
  const body = [parts.header, parts.verdict, parts.justification, parts.information].join("\n\n");

  it("places each section where the text joins them", () => {
    const s = justiceParts(body, parts)!;
    expect(s.map((x) => [x.kind, part(body, x)])).toEqual([
      ["zahlavi", parts.header],
      ["vyrok", parts.verdict],
      ["oduvodneni", parts.justification],
      ["pouceni", parts.information],
    ]);
    expect(justiceParts(body + " navíc", parts)).toBeNull();
  });

  it("takes them from the stored finaldoc JSON, the numbering from the odůvodnění", () => {
    const json = { header: [{ texts: [{ text: parts.header }] }], verdict: [{ texts: [{ text: parts.verdict }] }], justification: [{ texts: [{ text: "1. Žalobce se domáhal." }] }, { texts: [{ text: "2. Soud zjistil." }] }], information: [{ texts: [{ text: parts.information }] }] };
    const s = structureOf("justice", body, new TextEncoder().encode(JSON.stringify(json)));
    expect(s.sections.map((x) => x.kind)).toEqual(["zahlavi", "vyrok", "oduvodneni", "pouceni"]);
    expect(s.paragraphs.map((p) => p.num)).toEqual(["1", "2"]);
    expect(structureOf("justice", body, new TextEncoder().encode("not json")).sections.map((x) => x.kind)).toEqual([]);
  });
});
