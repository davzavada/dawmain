import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import CzechStemmer from "@/src/files/text/stem/czech-stemmer.js";
import { foldWord, indexTerm, queryTerm, queryTerms } from "@/src/files/text/analyze";

/**
 * The stemmer contract of Vlastní zdroje search: the vendored Snowball files
 * are pinned, and — the property search depends on — every inflected form of
 * a legal term, typed with or without diacritics, yields a query prefix that
 * matches the index term of every other form.
 */

const STEM_DIR = path.join(__dirname, "..", "src", "files", "text", "stem");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(path.join(STEM_DIR, file))).digest("hex");

describe("vendored Snowball Czech stemmer", () => {
  it("is byte-identical to the pinned upstream files (bump ANALYZER_VERSION when this changes)", () => {
    expect(sha256("czech-stemmer.js")).toBe("55c7f42589587ac7ac5bcf4db748435d68166e99eed9c7ceaa965e988be8276f");
    expect(sha256("base-stemmer.js")).toBe("bf6f03e1a0d29d9e6e669a3a13069187e4095a8c67251e475f5b6b2102974e26");
  });

  it("stems lowercase words with diacritics", () => {
    const s = new CzechStemmer();
    expect(s.stemWord("smlouvách")).toBe("smlouv");
    expect(s.stemWord("rozsudkem")).toBe("rozsudk");
    expect(s.stemWord("zaměstnavatelům")).toBe("zaměstnavatel");
  });

  it("must run BEFORE folding — folding first breaks it", () => {
    const s = new CzechStemmer();
    // stem → fold
    expect(foldWord(s.stemWord("smlouvách"))).toBe("smlouv");
    expect(foldWord(s.stemWord("vlastnického"))).toBe("vlastnick");
    expect(foldWord(s.stemWord("nejvyššího"))).toBe("nejvyss");
    // fold → stem: the suffix table no longer applies
    expect(s.stemWord(foldWord("smlouvách"))).toBe("smlouvach");
    expect(s.stemWord(foldWord("vlastnického"))).not.toBe("vlastnick");
    expect(s.stemWord(foldWord("nejvyššího"))).not.toBe("nejvyss");
    // indexTerm does it in the right order
    expect(indexTerm("smlouvách")).toBe("smlouv");
    expect(indexTerm("vlastnického")).toBe("vlastnick");
  });
});

/** Inflected forms of legal terms (with diacritics), one paradigm per row. */
const PARADIGMS: Record<string, string[]> = {
  smlouva: ["smlouva", "smlouvy", "smlouvě", "smlouvu", "smlouvo", "smlouvou", "smlouvám", "smlouvách", "smlouvami", "smluv"],
  zaměstnavatel: [
    "zaměstnavatel", "zaměstnavatele", "zaměstnavateli", "zaměstnavatelem", "zaměstnavatelé", "zaměstnavatelů",
    "zaměstnavatelům", "zaměstnavatelích",
  ],
  zaměstnanec: ["zaměstnance", "zaměstnanci", "zaměstnancem", "zaměstnanců", "zaměstnancům", "zaměstnancích"],
  odpovědnost: ["odpovědnost", "odpovědnosti", "odpovědností", "odpovědnostem", "odpovědnostech", "odpovědnostmi"],
  náhrada: ["náhrada", "náhrady", "náhradě", "náhradu", "náhradou", "náhrad", "náhradám", "náhradách"],
  škoda: ["škoda", "škody", "škodě", "škodu", "škodou", "škodám", "škodách", "škodami"],
  rozsudek: ["rozsudek", "rozsudku", "rozsudkem", "rozsudky", "rozsudků", "rozsudkům", "rozsudcích"],
  promlčení: ["promlčení", "promlčením", "promlčeních"],
  výpověď: ["výpověď", "výpovědi", "výpovědí", "výpovědím", "výpovědích", "výpověďmi"],
  vlastnický: ["vlastnické", "vlastnického", "vlastnickému", "vlastnickém", "vlastnickým", "vlastnická", "vlastnický"],
  právo: ["právo", "práva", "právu", "právem", "právech", "právům", "právy"],
  soud: ["soud", "soudu", "soudem", "soudy", "soudů", "soudům", "soudech"],
  zákon: ["zákon", "zákona", "zákonu", "zákonem", "zákony", "zákonů", "zákonům", "zákonech"],
  dovolání: ["dovolání", "dovoláním", "dovoláních"],
  dlužník: ["dlužník", "dlužníka", "dlužníkovi", "dlužníkem", "dlužníci", "dlužníků", "dlužníkům", "dlužnících"],
  věřitel: ["věřitel", "věřitele", "věřiteli", "věřitelem", "věřitelé", "věřitelů", "věřitelům"],
  pohledávka: ["pohledávka", "pohledávky", "pohledávce", "pohledávku", "pohledávkou", "pohledávek", "pohledávkám", "pohledávkách"],
  neplatnost: ["neplatnost", "neplatnosti", "neplatností"],
  žaloba: ["žaloba", "žaloby", "žalobě", "žalobu", "žalobou", "žalob", "žalobám", "žalobách"],
  žalobce: ["žalobce", "žalobci", "žalobcem", "žalobců", "žalobcům"],
  řízení: ["řízení", "řízením", "řízeních"],
  rozhodnutí: ["rozhodnutí", "rozhodnutím", "rozhodnutích"],
  odvolání: ["odvolání", "odvoláním", "odvoláních"],
  vada: ["vada", "vady", "vadě", "vadu", "vadou", "vad", "vadám", "vadách", "vadami"],
  prodlení: ["prodlení", "prodlením"],
  úrok: ["úrok", "úroku", "úrokem", "úroky", "úroků", "úrokům", "úrocích"],
  nájemce: ["nájemce", "nájemci", "nájemcem", "nájemců", "nájemcům"],
  vlastník: ["vlastník", "vlastníka", "vlastníkovi", "vlastníkem", "vlastníci", "vlastníků"],
  společnost: ["společnost", "společnosti", "společností", "společnostem", "společnostech"],
  jednatel: ["jednatel", "jednatele", "jednateli", "jednatelem", "jednatelé", "jednatelů"],
  stavba: ["stavba", "stavby", "stavbě", "stavbu", "stavbou", "staveb", "stavbám", "stavbách"],
  pozemek: ["pozemek", "pozemku", "pozemkem", "pozemky", "pozemků", "pozemkům", "pozemcích"],
  článek: ["článek", "článku", "článkem", "články", "článků"],
  povinnost: ["povinnost", "povinnosti", "povinností", "povinnostem", "povinnostech"],
  újma: ["újma", "újmy", "újmě", "újmu", "újmou"],
  exekuce: ["exekuce", "exekuci", "exekucí", "exekucím", "exekucích"],
  věc: ["věc", "věci", "věcí", "věcem", "věcech", "věcmi"],
  obec: ["obec", "obce", "obci", "obcí", "obcím", "obcích"],
  soudce: ["soudce", "soudci", "soudcem", "soudců", "soudcům"],
  obchodní: ["obchodní", "obchodního", "obchodnímu", "obchodním", "obchodních"],
  pracovní: ["pracovní", "pracovního", "pracovnímu", "pracovním", "pracovních"],
  poměr: ["poměr", "poměru", "poměrem", "poměry", "poměrů"],
  nárok: ["nárok", "nároku", "nárokem", "nároky", "nároků", "nárocích"],
  plnění: ["plnění", "plněním", "plněních"],
  dědictví: ["dědictví", "dědictvím"],
  manžel: ["manžel", "manžela", "manželovi", "manželem", "manželé", "manželů"],
  ústavní: ["ústavní", "ústavního", "ústavnímu", "ústavním"],
  stížnost: ["stížnost", "stížnosti", "stížností"],
  nájem: ["nájem", "nájmu", "nájmem", "nájmy", "nájmů"],
  dítě: ["dítě", "dítěte", "dítěti", "dítětem", "děti", "dětí", "dětem", "dětech", "dětmi"],
  proces: ["proces", "procesu", "procesem", "procesy", "procesů"],
  čeština: ["čeština", "češtiny", "češtině", "češtinu", "češtinou"],
  účet: ["účet", "účtu", "účtem", "účty", "účtů"],
};

/**
 * Stem pairs the two stemmers cannot bring together — a vowel alternation
 * in the stem, or Snowball stripping -em from a nominative ("nájem" → naj)
 * but not the -m- from "nájmu" (→ najm). Recorded as
 * "<lemma>: <query prefixes> ✗ <index term>" so a new miss fails the suite
 * and a fixed one is noticed. Bridging them would need prefixes so short
 * ("naj", "d") that they match unrelated words.
 */
const KNOWN_MISSES = new Set<string>([
  "nájem: najm ✗ naj",
  "dítě: dit ✗ det",
  "dítě: det ✗ dit",
]);

describe("query prefixes meet index terms across a paradigm", () => {
  const misses: string[] = [];
  for (const [lemma, forms] of Object.entries(PARADIGMS)) {
    for (const typed of forms) {
      for (const input of [typed, foldWord(typed)]) {
        const prefixes = queryTerms(input);
        for (const other of forms) {
          const term = indexTerm(other);
          const miss = `${lemma}: ${prefixes.join("|")} ✗ ${term}`;
          if (!prefixes.some((p) => term.startsWith(p)) && !misses.includes(miss)) misses.push(miss);
        }
      }
    }
  }

  it("every form typed with or without diacritics finds every other form", () => {
    expect(misses.filter((m) => !KNOWN_MISSES.has(m))).toEqual([]);
  });

  it("prefixes are not cut shorter than the paradigm needs (precision)", () => {
    const short: string[] = [];
    for (const [lemma, forms] of Object.entries(PARADIGMS)) {
      const shortest = Math.min(...forms.map((f) => indexTerm(f).length));
      for (const typed of forms) {
        for (const input of [typed, foldWord(typed)]) {
          const longest = Math.max(...queryTerms(input).map((p) => p.length));
          if (longest < Math.min(shortest - 1, input.length)) short.push(`${lemma}: ${input} [${queryTerms(input)}]`);
        }
      }
    }
    expect(short).toEqual([]);
  });

  it("the known-miss list is current", () => {
    expect([...KNOWN_MISSES].filter((m) => !misses.includes(m))).toEqual([]);
  });

  it("queryTerm on a word with diacritics is exactly indexTerm", () => {
    for (const forms of Object.values(PARADIGMS)) {
      for (const f of forms) if (foldWord(f) !== f) expect(queryTerm(f)).toBe(indexTerm(f));
    }
  });
});
