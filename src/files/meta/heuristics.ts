/**
 * Deterministic metadata proposals — what the review form shows when the
 * AI is unavailable or out of budget, and what wins over the AI for
 * identifiers and dates (mergeProposals). Built for the Czech legal
 * literature the feature is for:
 *
 *   books        the tiráž ("© C. H. Beck, 2019", "ISBN 978-80-7400-…
 *                (váz.)", "2. vydání", "Praha 2019", "Wolters Kluwer ČR,
 *                a. s.") and the title page (authors, title, subtitle,
 *                series, publisher, place and year as separate lines);
 *   commentaries "Komentář" on the title page, "Petrov, J., Výtisk, M.,
 *                Beran, V. a kol." (a collective → editors), the
 *                "Autorský kolektiv" page, the commented act from the
 *                title (acts.ts), the marginal-number label;
 *   articles     journal running heads ("Právní rozhledy 12/2023"), ISSN,
 *                DOI, the printed page range from the page labels,
 *                "Abstrakt" and "Klíčová slova";
 *   templates    "Vzor", "KUPNÍ SMLOUVA", placeholders [●] / [____];
 *   decisions    ROZSUDEK / USNESENÍ / NÁLEZ, "Jménem republiky", sp. zn.,
 *                ECLI, the court, "V Brně dne 24. 4. 2019".
 *
 * Every value is sanitized to one line and carries its source ("heuristic"
 * for the text, "pdf" for the PDF info dictionary, "filename", "user" for
 * the uploader's type hint) and a confidence of 0.3–0.95: a checksum-valid
 * ISBN in a tiráž is near-certain, a title guessed from the first line of
 * a page is not, and the review form highlights everything below 0.5.
 *
 * Pure — unit-tested (tests/files-meta-heuristics.test.ts).
 */

import { sanitizeLine } from "@/src/files/dmd/normalize";
import { resolveAct } from "@/src/files/index/acts";
import { canonicalCaseNumber, findIdentSpans, normalizeIsbn } from "@/src/files/index/identifiers";
import { foldWord } from "@/src/files/text/analyze";
import {
  DOC_TYPES,
  type BibMeta,
  type DocType,
  type MetaField,
  type MetaSource,
  type ProposedField,
  type ProposedMeta,
  type TemplateKind,
} from "@/src/files/types";
import type { MetaInput } from "./input";

type Prop<K extends MetaField> = ProposedField<BibMeta[K]>;

function prop<K extends MetaField>(value: BibMeta[K], confidence: number, source: MetaSource = "heuristic"): Prop<K> {
  return { value, source, confidence: Math.round(Math.min(0.95, Math.max(0.3, confidence)) * 100) / 100 };
}

/** Caps of the proposed strings (the confirm form enforces its own, see schema.ts). */
const CAP = { title: 300, line: 200, name: 120, summary: 600, keyword: 60 } as const;
const MAX_NAMES = 10;
const MAX_KEYWORDS = 8;
const MAX_ISBNS = 4;

// ---------------------------------------------------------------------------
// Text helpers

const PAGE_HEADER_RE = /^--- s\. [^\n]{1,14} ---$/;

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Lowercase without diacritics (whole string). */
function fold(s: string): string {
  return foldWord(s);
}

/** Heading marker of the MetaInput text removed. */
function unhead(line: string): string {
  return line.replace(/^#\s+/, "");
}

/** Tokens sentenceCase keeps in capitals. */
const ACRONYMS = new Set(["ČR", "SR", "EU", "ES", "EHS", "ÚS", "NS", "NSS", "SDEU", "ESLP", "GDPR", "DPH", "OSŘ", "ZOK", "OZ", "AZ", "ZP", "IT", "AI", "ČNB", "ČAK", "USA", "OSN"]);
const ROMAN_TOKEN_RE = /^[IVXLC]{1,6}\.?$/;

function isShouting(s: string): boolean {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  return upper / letters.length >= 0.8;
}

/**
 * ALL CAPS → sentence case ("OBČANSKÝ ZÁKONÍK VI" → "Občanský zákoník VI"),
 * keeping roman numerals and common acronyms. A lone "V" or "I" followed by
 * a word is the preposition "v" / the conjunction "i", not a numeral.
 * Text that is not shouting is returned unchanged. Pure.
 */
export function sentenceCase(s: string): string {
  if (!isShouting(s)) return s;
  let first = true;
  // split with a capture group alternates word, space, word…: the next word is two ahead.
  const tokens = s.split(/(\s+)/);
  return tokens
    .map((token, i) => {
      if (/^\s+$/.test(token) || !token) return token;
      const bare = token.replace(/[.,:;()„“"]/g, "");
      const next = tokens[i + 2] ?? "";
      const preposition = (bare === "V" || bare === "I") && token === bare && /^\p{L}{2,}/u.test(next) && !ROMAN_TOKEN_RE.test(next);
      let out: string;
      if (!preposition && (ROMAN_TOKEN_RE.test(bare) || ACRONYMS.has(bare))) out = token;
      else {
        out = token.toLowerCase();
        if (first) out = out.replace(/\p{L}/u, (c) => c.toUpperCase());
      }
      if (/\p{L}/u.test(token)) first = false;
      return out;
    })
    .join("");
}

function clean(s: string, max: number = CAP.line): string {
  return sanitizeLine(s, max).replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, "");
}

// ---------------------------------------------------------------------------
// Identifiers

const ISBN_LABELLED_RE = /ISBN(?:[- ]?1[03])?[ \t]*:?[ \t]*([0-9Xx][0-9Xx \-‐‑–]{8,20}[0-9Xx])/gu;
const ISSN_RE = /\b(e-?ISSN|ISSN)\b(?:\s*\((?:print|tisk|tištěná verze)\))?\s*:?\s*(\d{4})\s*[-‐‑–]\s*(\d{3}[\dXx])/giu;
const DOI_LABELLED_RE = /(?:\bDOI\s*:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s"'<>⟦⟧]+)/giu;

/** ISSN check digit (mod 11, X = 10). */
export function issnValid(digits: string): boolean {
  const d = digits.toUpperCase().replace(/[^0-9X]/g, "");
  if (!/^\d{7}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(d[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? "X" : String(check)) === d[7];
}

/** A DOI without the punctuation and unbalanced brackets that follow it in running text. Pure. */
export function trimDoi(doi: string): string {
  let d = doi.replace(/[.,;:!?'"]+$/, "");
  while (d.endsWith(")") && d.split("(").length < d.split(")").length) d = d.slice(0, -1).replace(/[.,;:]+$/, "");
  return d;
}

/** Checksum-valid ISBNs, labelled first; bare 978/979 numbers only when nothing is labelled. */
function findIsbns(text: string): { values: string[]; labelled: boolean; ambiguous: boolean } {
  const out: string[] = [];
  for (const m of text.matchAll(ISBN_LABELLED_RE)) {
    const isbn = normalizeIsbn(m[1]);
    if (isbn && !out.includes(isbn)) out.push(isbn);
  }
  if (out.length) return { values: out.slice(0, MAX_ISBNS), labelled: true, ambiguous: out.length > MAX_ISBNS };
  for (const span of findIdentSpans(text)) {
    for (const key of span.keys) {
      if (key.startsWith("isbn:") && !out.includes(key.slice(5))) out.push(key.slice(5));
    }
  }
  return { values: out.slice(0, MAX_ISBNS), labelled: false, ambiguous: out.length > MAX_ISBNS };
}

function findIssn(text: string): string | null {
  let online: string | null = null;
  for (const m of text.matchAll(ISSN_RE)) {
    const value = `${m[2]}-${m[3].toUpperCase()}`;
    if (!issnValid(value)) continue;
    const isOnline = /^e/i.test(m[1]) || /^\s*\((?:online|on-line|elektronická)/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 20));
    if (!isOnline) return value;
    online ??= value;
  }
  return online;
}

// ---------------------------------------------------------------------------
// Dates

/** Czech month names in the genitive ("24. dubna 2019"). */
export const CZECH_MONTHS: Readonly<Record<string, number>> = {
  ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6, července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12,
};
const MONTH_SOURCE = "ledna|února|března|dubna|května|července|června|srpna|září|října|listopadu|prosince";
const DATE_SOURCE = String.raw`(\d{1,2})\.\s*(?:(\d{1,2})\.|(${MONTH_SOURCE}))\s*(\d{4})`;

/** A real calendar date 1900–2100 as "YYYY-MM-DD", else null. Pure. */
export function isoDate(day: number, month: number, year: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "24. 4. 2019", "24.04.2019", "24. dubna 2019" → ISO. Groups as in DATE_SOURCE starting at `g`. */
function dateFrom(m: RegExpMatchArray, g = 1): string | null {
  const day = Number(m[g]);
  const month = m[g + 1] ? Number(m[g + 1]) : CZECH_MONTHS[(m[g + 2] ?? "").toLowerCase()];
  return isoDate(day, month ?? 0, Number(m[g + 3]));
}

const YEAR_SOURCE = String.raw`(1[5-9]\d\d|20\d\d)`;

// ---------------------------------------------------------------------------
// Publishers, places, journals

interface Publisher {
  re: RegExp;
  name: string;
  place: string | null;
  /** Needs publishing context (a tiráž, "Vydal…", ©): the name is also an affiliation or a word. */
  strict: boolean;
}

const PUBLISHERS: Publisher[] = [
  { re: /C\.\s?H\.\s?Beck/u, name: "C. H. Beck", place: "Praha", strict: false },
  { re: /Wolters\s+Kluwer/iu, name: "Wolters Kluwer", place: "Praha", strict: false },
  { re: /\bASPI\s+Publishing|\bASPI,\s*a\.\s?s\./u, name: "ASPI", place: "Praha", strict: false },
  { re: /\bLeges\b/u, name: "Leges", place: "Praha", strict: false },
  { re: /\bLinde\s+Praha\b|\bNakladatelství\s+Linde\b/u, name: "Linde", place: "Praha", strict: false },
  { re: /Aleš\s+Čeněk/u, name: "Aleš Čeněk", place: "Plzeň", strict: false },
  { re: /\bKarolinum\b/u, name: "Karolinum", place: "Praha", strict: false },
  { re: /\bAuditorium\b/u, name: "Auditorium", place: "Praha", strict: false },
  { re: /\bGrada(?:\s+Publishing)?\b/u, name: "Grada", place: "Praha", strict: false },
  { re: /\bSagit\b/u, name: "Sagit", place: "Ostrava", strict: false },
  { re: /\bATLAS\s+consulting\b/iu, name: "ATLAS consulting", place: "Ostrava", strict: false },
  { re: /\bTribun\s+EU\b/u, name: "Tribun EU", place: "Brno", strict: false },
  { re: /\bKey\s+Publishing\b/u, name: "Key Publishing", place: "Ostrava", strict: false },
  { re: /\bEurolex\s+Bohemia\b/u, name: "Eurolex Bohemia", place: "Praha", strict: false },
  { re: /\bCodex\s+Bohemia\b/u, name: "Codex Bohemia", place: "Praha", strict: false },
  { re: /\bBova\s+Polygon\b/u, name: "Bova Polygon", place: "Praha", strict: false },
  { re: /\bHavlíček\s+Brain\s+Team\b/u, name: "Havlíček Brain Team", place: "Praha", strict: false },
  { re: /Masarykova\s+univerzita|\bMUNI\s+Press\b/u, name: "Masarykova univerzita", place: "Brno", strict: true },
  { re: /Univerzita\s+Palackého\s+v\s+Olomouci/u, name: "Univerzita Palackého v Olomouci", place: "Olomouc", strict: true },
  { re: /Západočeská\s+univerzita\s+v\s+Plzni/u, name: "Západočeská univerzita v Plzni", place: "Plzeň", strict: true },
  { re: /Univerzita\s+Karlova/u, name: "Univerzita Karlova", place: "Praha", strict: true },
  { re: /Česká\s+advokátní\s+komora/u, name: "Česká advokátní komora", place: "Praha", strict: true },
  { re: /\bAcademia\b/u, name: "Academia", place: "Praha", strict: true },
  { re: /\bOeconomica\b/u, name: "Oeconomica", place: "Praha", strict: true },
  { re: /\bANAG\b/u, name: "ANAG", place: "Olomouc", strict: true },
  { re: /\bNakladatelství\s+Doplněk\b/u, name: "Doplněk", place: "Brno", strict: false },
];

/** A line that says who published the book. */
const PUBLISHING_CONTEXT_RE = /©|\(c\)|\bVyda(?:l|la|lo|li|vatel)\b|\bNakladatel|\bnakladatelství(?![\p{L}])|\bISBN\b|\bTisk\b|\ba\.\s?s\.|\bs\.\s?r\.\s?o\.|\bspol\.\s?s\s?r\.\s?o\./iu;
const GENERIC_PUBLISHER_RE =
  /\b(?:Vydal[aoi]?|Vydavatel|Nakladatel)\s*:?\s+(?:nakladatelství\s+)?([\p{Lu}][^\n,;]{2,70}?)(?:,?\s*(?:s\.\s?r\.\s?o\.|spol\.\s?s\s?r\.\s?o\.|a\.\s?s\.|z\.\s?s\.|o\.\s?p\.\s?s\.|z\.\s?ú\.))?(?=\s*[,;\n]|\s*$|\s+(?:v|ve)\s+roce)/u;

const PLACES: Record<string, string> = {
  praha: "Praha", praze: "Praha", brno: "Brno", brne: "Brno", plzen: "Plzeň", plzni: "Plzeň", olomouc: "Olomouc",
  olomouci: "Olomouc", ostrava: "Ostrava", ostrave: "Ostrava", bratislava: "Bratislava", bratislave: "Bratislava",
  kosice: "Košice", kosiciach: "Košice", wien: "Wien", vieden: "Wien", munchen: "München",
};
const PLACE_SOURCE = "Praha|Praze|Brno|Brně|Plzeň|Plzni|Olomouc|Olomouci|Ostrava|Ostravě|Bratislava|Bratislave|Bratislavě|Košice|Wien|München";
/** "Praha 2019", "V Praze 2019", "Brno, 2020" as a line of its own (a title page, a tiráž). */
const PLACE_YEAR_LINE_RE = new RegExp(String.raw`^(?:V\s+)?(${PLACE_SOURCE})\s*,?\s*${YEAR_SOURCE}\.?$`, "u");
/** "Praha: C. H. Beck, 2019" (ČSN ISO 690 imprint as printed in a tiráž). */
const PLACE_PUBLISHER_RE = new RegExp(String.raw`(?:^|\n)(${PLACE_SOURCE})\s*:\s*[\p{Lu}]`, "u");

interface Journal {
  re: RegExp;
  name: string;
  /** A common word or a book-title word: counts only in running heads or next to an issue ("Právník 4/2021"). */
  strict?: boolean;
}

const JOURNALS: Journal[] = [
  { re: /Právní\s+rozhledy/iu, name: "Právní rozhledy" },
  { re: /Bulletin\s+advokacie/iu, name: "Bulletin advokacie" },
  { re: /Časopis\s+pro\s+právní\s+vědu\s+a\s+praxi/iu, name: "Časopis pro právní vědu a praxi" },
  { re: /Obchodněprávní\s+revue/iu, name: "Obchodněprávní revue" },
  { re: /Trestněprávní\s+revue/iu, name: "Trestněprávní revue" },
  { re: /Soudní\s+rozhledy/iu, name: "Soudní rozhledy" },
  { re: /Rekodifikace\s*(?:&|a)\s*praxe/iu, name: "Rekodifikace & praxe" },
  { re: /Daně\s+a\s+právo\s+v\s+praxi/iu, name: "Daně a právo v praxi" },
  { re: /Acta\s+Universitatis\s+Carolinae\s*[–-]?\s*Iuridica|\bAUC\s+Iuridica/iu, name: "Acta Universitatis Carolinae – Iuridica" },
  { re: /Acta\s+Iuridica\s+Olomucensia/iu, name: "Acta Iuridica Olomucensia" },
  { re: /Masaryk\s+University\s+Journal\s+of\s+Law\s+and\s+Technology/iu, name: "Masaryk University Journal of Law and Technology" },
  { re: /The\s+Lawyer\s+Quarterly/iu, name: "The Lawyer Quarterly" },
  { re: /Časopis\s+zdravotnického\s+práva\s+a\s+bioetiky/iu, name: "Časopis zdravotnického práva a bioetiky" },
  { re: /Revue\s+pro\s+právo\s+a\s+technologie/iu, name: "Revue pro právo a technologie" },
  { re: /Evropské\s+a\s+mezinárodní\s+právo/iu, name: "Evropské a mezinárodní právo" },
  { re: /Státní\s+zastupitelství/iu, name: "Státní zastupitelství" },
  { re: /Právní\s+fórum/iu, name: "Právní fórum" },
  { re: /Právní\s+rádce/iu, name: "Právní rádce" },
  { re: /Soukromé\s+právo/iu, name: "Soukromé právo" },
  { re: /Správní\s+právo/iu, name: "Správní právo" },
  { re: /Trestní\s+právo/iu, name: "Trestní právo" },
  { re: /Obchodní\s+právo/iu, name: "Obchodní právo" },
  { re: /Právo\s+a\s+rodina/iu, name: "Právo a rodina" },
  { re: /Zdravotnictví\s+a\s+právo/iu, name: "Zdravotnictví a právo" },
  { re: /Komorní\s+listy/iu, name: "Komorní listy" },
  { re: /\bAd\s+Notam\b/iu, name: "Ad Notam", strict: true },
  { re: /\bJurisprudence\b/iu, name: "Jurisprudence", strict: true },
  { re: /\bPrávník\b|\bPRÁVNÍK\b/u, name: "Právník", strict: true },
  { re: /\bAntitrust\b|\bANTITRUST\b/u, name: "Antitrust", strict: true },
  { re: /Justičná\s+revue/iu, name: "Justičná revue" },
  { re: /Bulletin\s+slovenskej\s+advokácie/iu, name: "Bulletin slovenskej advokácie" },
  { re: /Právny\s+obzor/iu, name: "Právny obzor" },
];

// ---------------------------------------------------------------------------
// Courts and decisions

const DECISION_FORM_RE = /^(?:#\s+)?(ROZSUDEK|USNESENÍ|NÁLEZ|STANOVISKO|ROZHODNUTÍ|Rozsudek|Usnesení|Nález|Stanovisko)(?:\s+(?:velkého\s+senátu|pléna|Ústavního\s+soudu|Nejvyššího(?:\s+správního)?\s+soudu))?\s*$/mu;
const REPUBLIC_RE = /Jménem\s+republiky|JMÉNEM\s+REPUBLIKY|ČESKÁ\s+REPUBLIKA/u;
const COURT_SOURCE = String.raw`Nejvyšší\s+správní\s+soud|Nejvyšší\s+soud|Ústavní\s+soud|(?:Krajský|Městský|Vrchní|Okresní|Obvodní)\s+soud\s+(?:v|ve|pro)\s+[\p{Lu}][\p{L}]*(?:\s+(?:nad|pod)\s+[\p{Lu}][\p{L}]*|\s+\d{1,2})?(?:\s*[–-]\s*pobočka\s+v\s+[\p{Lu}][\p{L}]*)?|Soudní\s+dvůr(?:\s+Evropské\s+unie)?|Tribunál|Evropský\s+soud\s+pro\s+lidská\s+práva`;
const COURT_RE = new RegExp(`(?<![\\p{L}])(${COURT_SOURCE})(?![\\p{L}])`, "u");
/** A line that is nothing but a court name in capitals ("NEJVYŠŠÍ SOUD", "KRAJSKÝ SOUD V BRNĚ"). */
const COURT_LINE_CI_RE = new RegExp(`^(?:#\\s+)?(${COURT_SOURCE})$`, "iu");
const ECLI_COURTS: Record<string, string> = {
  "CZ:NS": "Nejvyšší soud",
  "CZ:NSS": "Nejvyšší správní soud",
  "CZ:US": "Ústavní soud",
  "EU:C": "Soudní dvůr Evropské unie",
  "EU:T": "Tribunál",
  "CE:ECHR": "Evropský soud pro lidská práva",
};
const CASE_COURTS: Record<string, string> = {
  NS: "Nejvyšší soud",
  NSS: "Nejvyšší správní soud",
  US: "Ústavní soud",
  SDEU: "Soudní dvůr Evropské unie",
};

/** Words that stay lower case inside a court's name. */
const COURT_LOWER = new Set(["soud", "správní", "v", "ve", "pro", "nad", "pod", "pobočka", "dvůr", "unie", "lidská", "práva"]);

/** "KRAJSKÝ SOUD V BRNĚ" → "Krajský soud v Brně", "soudní dvůr evropské unie" → "Soudní dvůr Evropské unie". */
function courtCase(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i === 0 || !COURT_LOWER.has(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Names

/** Academic degrees before and after a name. */
const DEGREE_BEFORE_RE = /(?<![\p{L}])(?:prof|doc|JUDr|Mgr|PhDr|Ing|Bc|RNDr|MUDr|MVDr|PaedDr|ThDr|ThLic|Dr|arch|akad|Dipl)\.\s*(?:et\s+(?=\p{Lu}))?/gu;
const DEGREE_AFTER_RE = /(?:,\s*|\s+)(?:Ph\.\s?D|Th\.\s?D|LL\.\s?M|LL\.\s?B|CSc|DrSc|DSc|MBA|MPA|M\.\s?A|MSc|D\.\s?Phil|BA|MA|LLM|PhD|DiS)\.?(?![\p{L}])/gu;
const NAME_LABEL_RE =
  /^(?:(Editoři|Editorky|Editor(?:ka)?|Pořadatel(?:é|ka)?|Sestavil[aiy]?|Vědecký redaktor|Vedoucí autorského kolektivu|Redakce)|Autoři|Autorky|Autor(?:ka)?|Zpracoval[aiy]?|Kolektiv autorů)\s*:?\s+/iu;
const EDITOR_SUFFIX_RE = /\s*\((?:eds?|editoři|editor|ed|edd|red)\.?\)\s*$/iu;
const COLLECTIVE_RE = /\s*(?:,\s*)?(?:a\s+kol(?:ektiv)?(?:\s+autorů)?\.?|et\s+al\.?)\s*$/iu;
/** A capitalized name word with at least one lower-case letter: "Petrov", "Novák-Svobodová", "McDonald", "O’Brien" — never "ČESKÁ". */
const WORD_TOKEN_RE = /^(?=[^\s]*\p{Ll})[\p{Lu}][\p{L}'’]+(?:-[\p{Lu}][\p{L}'’]+)?$/u;
const INITIAL_TOKEN_RE = /^[\p{Lu}]\.(?:-?[\p{Lu}]\.)?$/u;
const PARTICLES = new Set(["van", "von", "de", "der", "da", "di", "la", "le", "du", "ten", "ter"]);
/** Folded words that are never part of a personal name on a Czech title page. */
const NAME_STOP = new Set(
  (
    "česka cesky ceske republika republiky evropska evropske unie soud soudu zakon zakonik zakona komentar obsah uvod predmluva dil cast " +
    "hlava oddil vydani kapitola priloha rozsudek usneseni nalez abstrakt abstract klicova slova key words summary resume jmenem " +
    "smlouva dohoda praha brno plzen olomouc ostrava beck kluwer wolters leges linde grada karolinum pravni rozhledy bulletin advokacie " +
    "ustavni nejvyssi spravni krajsky mestsky okresni vrchni univerzita fakulta nakladatelstvi edice rada sbornik autorsky kolektiv " +
    "autori literatura poznamky seznam zkratek rejstrik strana the of and for law review journal university press obcansky obchodni " +
    "trestni pracovni danovy novela vzor formular ledna unora brezna dubna kvetna cervna cervence srpna zari rijna listopadu prosince " +
    "leden unor brezen duben kveten cerven cervenec srpen zari rijen listopad prosinec pravo prava praxe revue casopis stat statni"
  ).split(" "),
);

export interface ParsedNames {
  names: string[];
  /** "a kol." / "et al." — a commentary's or a collective work's editors. */
  collective: boolean;
  /** Marked as editors ("Editoři:", "(eds.)"). */
  editors: boolean;
  /** Carried a label ("Autoři:", "Zpracoval:") or academic degrees — strong evidence it is a names line. */
  marked: boolean;
}

/** A name without its academic degrees ("prof. JUDr. Jan Petrov, CSc." → "Jan Petrov"); `had` = some were removed. Pure. */
export function stripDegrees(s: string): { text: string; had: boolean } {
  const before = s.replace(DEGREE_BEFORE_RE, "");
  const text = before.replace(DEGREE_AFTER_RE, "").replace(/\s+/g, " ").trim();
  return { text, had: text.length !== s.replace(/\s+/g, " ").trim().length };
}

/** A lone surname as a model may list it ("Beran"): a capitalized name word that is not a title-page word. Pure. */
export function isSurnameWord(token: string): boolean {
  return WORD_TOKEN_RE.test(token) && !NAME_STOP.has(fold(token));
}

function capitalizeWord(w: string): string {
  return w
    .toLowerCase()
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("-");
}

function validName(tokens: string[], allowSingle: boolean): boolean {
  if (!tokens.length || tokens.length > 4) return false;
  if (tokens.some((t) => NAME_STOP.has(fold(t.replace(/\.$/, ""))))) return false;
  const words = tokens.filter((t) => WORD_TOKEN_RE.test(t));
  const ok = tokens.every((t) => WORD_TOKEN_RE.test(t) || INITIAL_TOKEN_RE.test(t) || PARTICLES.has(t));
  if (!ok || !words.length) return false;
  if (tokens.length === 1) return allowSingle;
  return true;
}

/**
 * A line that consists of personal names only — "Jan Petrov, Michal
 * Výtisk, Vladimír Beran a kol.", "Petrov, J., Výtisk, M., Beran, V. a
 * kol.", "prof. JUDr. Jana Nováková, Ph.D.", "Autoři: …", "Petrov,
 * Výtisk, Beran a kol." — or null. Degrees are dropped; names keep the
 * printed order ("Given Surname" or "Surname, I."). Pure.
 */
export function parseNamesLine(raw: string): ParsedNames | null {
  let s = unhead(sanitizeLine(raw, 400)).replace(/[*†¹²³]+$/u, "").trim();
  if (!s || s.length > 300) return null;
  let editors = false;
  let marked = false;
  const label = NAME_LABEL_RE.exec(s);
  if (label) {
    marked = true;
    editors = !!label[1];
    s = s.slice(label[0].length);
  }
  if (EDITOR_SUFFIX_RE.test(s)) {
    editors = true;
    marked = true;
    s = s.replace(EDITOR_SUFFIX_RE, "");
  }
  let collective = false;
  if (COLLECTIVE_RE.test(s)) {
    collective = true;
    s = s.replace(COLLECTIVE_RE, "");
  }
  const degrees = stripDegrees(s);
  s = degrees.text.replace(/[*†¹²³]+/gu, "").trim();
  if (degrees.had) marked = true;
  if (!s || /[\d§:@/\\|"„“()[\]{}<>=+]|https?/iu.test(s)) return null;
  // All-caps names only with a label or degrees ("JUDr. JANA NOVÁKOVÁ").
  if (isShouting(s)) {
    if (!marked) return null;
    s = s.split(/(\s+|,)/).map((t) => (/\p{L}/u.test(t) ? capitalizeWord(t) : t)).join("");
  }

  // "Surname, I., Surname, I. a Surname, I."
  const inverted = /([\p{Lu}][\p{Ll}'’]+(?:-[\p{Lu}][\p{Ll}'’]+)?),\s*((?:[\p{Lu}]\.\s*){1,3})(?=,|;|\s+a\s|\s*&|$)/gu;
  const invertedAll = new RegExp(String.raw`^(?:[\p{Lu}][\p{Ll}'’]+(?:-[\p{Lu}][\p{Ll}'’]+)?,\s*(?:[\p{Lu}]\.\s*){1,3}(?:,\s*|;\s*|\s+a\s+|\s*&\s*|$))+$`, "u");
  let names: string[];
  if (invertedAll.test(s)) {
    names = [...s.matchAll(inverted)].map((m) => `${m[1]}, ${m[2].replace(/\s+/g, " ").trim()}`);
    if (names.some((n) => NAME_STOP.has(fold(n.split(",")[0])))) return null;
  } else {
    const parts = s.split(/\s*(?:;|,|\s+a\s+|\s*&\s*|\s+and\s+|\s+[–—]\s+)\s*/u).filter(Boolean);
    if (!parts.length || parts.length > 12) return null;
    const allowSingle = collective || (marked && parts.length >= 1) || parts.length >= 3;
    for (const part of parts) if (!validName(part.split(/\s+/), allowSingle)) return null;
    // A lone single word is a surname only with strong evidence.
    if (parts.length === 1 && parts[0].split(/\s+/).length === 1 && !collective && !marked) return null;
    names = parts;
  }
  if (!names.length) return null;
  return { names: names.slice(0, MAX_NAMES).map((n) => clean(n, CAP.name)), collective, editors, marked };
}

/** Folded surname of a name as stored ("Petrov, J." → petrov, "Jan Petrov" → petrov). */
export function surnameOf(name: string): string | null {
  const s = stripDegrees(sanitizeLine(name, 200)).text;
  const comma = s.indexOf(",");
  if (comma > 0) return fold(s.slice(0, comma).trim()) || null;
  const tokens = s.split(/\s+/).filter((t) => t && !INITIAL_TOKEN_RE.test(t));
  const last = tokens[tokens.length - 1];
  return last ? fold(last) : null;
}

// ---------------------------------------------------------------------------
// Title page

type LineKind = "names" | "publisher" | "placeYear" | "edition" | "series" | "komentar" | "noise" | "generic" | "text";

interface TitleLine {
  text: string;
  heading: boolean;
  page: number;
  kind: LineKind;
  names?: ParsedNames;
}

const GENERIC_HEADING_RE =
  /^(?:obsah|předmluva|předmluva\s+k\s+.*vydání|úvod|úvodem|seznam\s+zkratek|seznam\s+použitých\s+zkratek|zkratky|autorský\s+kolektiv|kolektiv\s+autorů|autoři|o\s+autorech|abstrakt|abstract|anotace|shrnutí|summary|resumé|klíčová\s+slova|key\s*words|literatura|rejstřík|věcný\s+rejstřík|poděkování|(?:část|hlava|díl|oddíl|kapitola)\s+\S+|§\s*\d.*|čl\.\s*\S.*|článek\s+\S.*|příloha.*)$/iu;
const SERIES_RE =
  /^(?:Beckov[aáy]\s+(?:edice|mezioborové)[^\n]{0,80}|Beckova\s+právnická\s+učebnice|Edice\s+[^\n]{2,80}|Řada\s+[^\n]{2,80}|Velké\s+komentáře|Komentáře\s+Wolters\s+Kluwer|Praktické\s+komentáře|Spisy\s+Právnické\s+fakulty[^\n]{0,120}|Acta\s+Universitatis\s+Brunensis[^\n]{0,80}|Monografie\s+Wolters\s+Kluwer)$/iu;
const KOMENTAR_LINE_RE = /^(?:(?:velký|praktický|stručný)\s+)?komentář(?:\s+k\s+[^\n]{0,120})?\.?$|^komentované\s+(?:znění|zákony)$/iu;
const EDITION_RE = new RegExp(
  // Each word is followed by mandatory whitespace, so a long run of letters splits one way only (no backtracking blow-up).
  String.raw`(?<![\p{L}\p{N}])(\d{1,2})\.\s*(?:(?:,\s*|a\s+)?[\p{L}]+\s+){0,4}?(?:vydání|vyd\.)|(první|druhé|třetí|čtvrté|páté|šesté|sedmé|osmé|deváté|desáté)\s+(?:(?:,\s*|a\s+)?[\p{L}]+\s+){0,3}?vydání|[Vv]ydání\s+(první|druhé|třetí|čtvrté|páté|šesté|sedmé|osmé|deváté|desáté)`,
  "u",
);
/** Czech ordinal words of an edition ("druhé vydání"). */
export const ORDINALS: Readonly<Record<string, number>> = { první: 1, druhé: 2, třetí: 3, čtvrté: 4, páté: 5, šesté: 6, sedmé: 7, osmé: 8, deváté: 9, desáté: 10 };
const NOISE_RE = /\bISBN\b|\bISSN\b|©|Všechna\s+práva|https?:|www\.|@|^\d[\d\s./–-]*$|^s\.\s*\d|^\*/iu;

function editionOf(text: string): string | null {
  const m = EDITION_RE.exec(text);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : ORDINALS[(m[2] ?? m[3] ?? "").toLowerCase()];
  return n && n <= 30 ? `${n}.` : null;
}

function publisherIn(line: string): Publisher | null {
  for (const p of PUBLISHERS) if (p.re.test(line)) return p;
  return null;
}

/** The publisher a line names — a strict one (a university, a chamber) only with publishing context. */
function publisherLine(line: string): Publisher | null {
  const p = publisherIn(line);
  return p && (!p.strict || PUBLISHING_CONTEXT_RE.test(line)) ? p : null;
}

function classify(text: string, heading: boolean, page: number): TitleLine {
  const line: TitleLine = { text, heading, page, kind: "text" };
  const bare = unhead(text);
  if (NOISE_RE.test(bare)) line.kind = "noise";
  else if (PLACE_YEAR_LINE_RE.test(bare)) line.kind = "placeYear";
  else if (SERIES_RE.test(bare)) line.kind = "series";
  else if (KOMENTAR_LINE_RE.test(bare)) line.kind = "komentar";
  else if (bare.length <= 80 && editionOf(bare) && bare.split(/\s+/).length <= 8) line.kind = "edition";
  else if (bare.length <= 80 && publisherLine(bare)) line.kind = "publisher";
  else {
    const names = bare.length <= 300 ? parseNamesLine(bare) : null;
    if (names) {
      line.kind = "names";
      line.names = names;
    } else if (GENERIC_HEADING_RE.test(bare) || bare.length > 300 || !/\p{L}{2}/u.test(bare)) line.kind = "generic";
  }
  return line;
}

/**
 * The lines of the title-page area of `front`: the first three pages (or,
 * unpaged, the first 40 lines), stopping at the first long paragraph or a
 * table of contents / preface heading.
 */
function titleArea(front: string): TitleLine[] {
  const out: TitleLine[] = [];
  let page = 0;
  for (const raw of lines(front)) {
    if (PAGE_HEADER_RE.test(raw)) {
      page++;
      if (page > 3) break;
      continue;
    }
    const heading = raw.startsWith("# ");
    const bare = unhead(raw);
    if (bare.length > 400) break;
    if (heading && /^(?:obsah|předmluva|úvod|seznam\s+zkratek)\b/iu.test(bare) && out.length) break;
    out.push(classify(raw, heading, Math.max(page, 1)));
    if (out.length >= 40) break;
  }
  return out;
}

/** The page of the title area that looks most like a title page. */
function bestTitlePage(area: TitleLine[]): number | null {
  const score = new Map<number, number>();
  for (const l of area) {
    const add = l.kind === "names" ? 2 : l.kind === "publisher" || l.kind === "placeYear" || l.kind === "edition" ? 2 : l.kind === "text" ? 1 : l.kind === "komentar" ? 1 : 0;
    score.set(l.page, (score.get(l.page) ?? 0) + add);
  }
  let best: number | null = null;
  for (const [page, s] of score) if (best === null || s > (score.get(best) ?? 0)) best = page;
  return best;
}

interface TitleGuess {
  title: string | null;
  subtitle: string | null;
  fromHeading: boolean;
  names: ParsedNames | null;
  komentar: boolean;
  series: string | null;
  edition: string | null;
  publisher: Publisher | null;
  place: string | null;
  year: number | null;
}

function guessTitlePage(front: string): TitleGuess {
  const area = titleArea(front);
  const guess: TitleGuess = {
    title: null, subtitle: null, fromHeading: false, names: null, komentar: false,
    series: null, edition: null, publisher: null, place: null, year: null,
  };
  if (!area.length) return guess;
  const page = bestTitlePage(area);
  const onPage = area.filter((l) => l.page === page);
  for (const l of area) {
    const bare = unhead(l.text);
    if (l.kind === "series") guess.series ??= clean(bare);
    if (l.kind === "komentar" && l.page === page) guess.komentar = true;
    if (l.kind === "edition") guess.edition ??= editionOf(bare);
    if (l.kind === "publisher") guess.publisher ??= publisherLine(bare);
    if (l.kind === "placeYear") {
      const m = PLACE_YEAR_LINE_RE.exec(bare)!;
      guess.place ??= PLACES[fold(m[1])] ?? null;
      guess.year ??= Number(m[2]);
    }
  }
  guess.names = onPage.find((l) => l.kind === "names")?.names ?? area.find((l) => l.kind === "names")?.names ?? null;

  // Title: a heading on the title page, else its first plain text line;
  // the plain lines right after it (and a "Komentář" line) make the subtitle.
  const candidates = onPage.filter((l) => l.kind === "text");
  const headed = candidates.find((l) => l.heading);
  const first = headed ?? candidates[0] ?? area.find((l) => l.kind === "text" && l.heading) ?? null;
  if (!first) return guess;
  let title = sentenceCase(unhead(first.text));
  let rest = onPage.slice(onPage.indexOf(first) + 1);
  // "NÁHRADA NEMAJETKOVÉ ÚJMY" / "v občanském právu": a short lowercase line continues the title.
  const cont = rest[0];
  if (cont && cont.kind === "text" && !cont.heading && /^\p{Ll}/u.test(cont.text) && cont.text.length <= 80 && !/[\d§]/u.test(cont.text)) {
    title = `${title} ${cont.text}`;
    rest = rest.slice(1);
  }
  guess.title = clean(title, CAP.title);
  guess.fromHeading = first.heading;
  const sub: string[] = [];
  for (const l of rest) {
    const bare = unhead(l.text);
    if (l.kind === "text" && sub.length < 2 && bare.length <= 200 && !/^\p{Ll}/u.test(bare)) sub.push(sentenceCase(bare));
    else if (l.kind === "komentar") {
      sub.push(sentenceCase(bare));
      break;
    } else if (l.kind !== "text") break;
  }
  if (sub.length) guess.subtitle = clean(sub.map((s) => s.replace(/[.:]+$/, "")).join(". "), CAP.title);
  return guess;
}

/** Names on an "Autorský kolektiv" page: one per line, before the § ranges or affiliations. */
function authorsFromPage(page: string): string[] {
  const out: string[] = [];
  for (const raw of lines(page)) {
    if (PAGE_HEADER_RE.test(raw) || raw.startsWith("# ")) continue;
    // "prof. JUDr. Jan Petrov, CSc. – § 1–117" / "JUDr. Michal Výtisk (§ 2894–2990)"
    const head = raw.split(/\s+[–—-]\s+|\s*\(|\s*§|:\s/u)[0];
    const parsed = parseNamesLine(head);
    if (parsed && parsed.names.length === 1 && (parsed.marked || parsed.names[0].split(/\s+/).length >= 2)) {
      const name = parsed.names[0];
      if (!out.some((n) => fold(n) === fold(name))) out.push(name);
    }
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doc type signals

const VZOR_WORD_RE = /(?<![\p{L}])(?:vzor(?:y|ů|u|em)?|vzorov[áéý]|formulář(?:e|ů)?|šablon[ay]?)(?![\p{L}])/iu;
const TEMPLATE_TITLE: Array<[RegExp, TemplateKind]> = [
  [/(?<![\p{L}])pln(?:á|ou)\s+moc/iu, "plna_moc"],
  [/(?<![\p{L}])(?:smlouv|dohod[aouy](?![\p{L}])|dodat(?:ek|ku)\s+(?:č\.|ke\s+smlouvě))/iu, "smlouva"],
  [/(?<![\p{L}])žalob/iu, "zaloba"],
  [/(?<![\p{L}])odvolání/iu, "odvolani"],
  [/(?<![\p{L}])dovolání/iu, "dovolani"],
  [/(?<![\p{L}])(?:návrh\s+na|insolvenční\s+návrh)/iu, "navrh"],
  [/(?<![\p{L}])(?:podání|stížnost|námitk|vyjádření\s+k|rozklad|odpor\s+proti|správní\s+žaloba)/iu, "podani"],
];
const ABSTRACT_RE = /(?:^|\n)(?:#\s+)?(?:Abstrakt|Shrnutí|Anotace|Resumé)(?![\p{L}])\s*[:.]?[ \t]*([^\n]*)/iu;
const ABSTRACT_EN_RE = /(?:^|\n)(?:#\s+)?(?:Abstract|Summary)(?![\p{L}])\s*[:.]?[ \t]*([^\n]*)/iu;
const KEYWORDS_RE = /(?:^|\n)(?:#\s+)?Klíčová\s+slova(?![\p{L}])\s*[:.]?[ \t]*([^\n]*)/iu;
const KEYWORDS_EN_RE = /(?:^|\n)(?:#\s+)?Key\s*words(?![\p{L}])\s*[:.]?[ \t]*([^\n]*)/iu;

function templateKindOf(title: string): TemplateKind | null {
  for (const [re, kind] of TEMPLATE_TITLE) if (re.test(title)) return kind;
  return null;
}

/** The text after a label, or the next line when the label stands alone. */
function labelled(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  let value = m[1].trim();
  if (value.length < 3) {
    const after = text.slice(m.index + m[0].length).split("\n").map((l) => l.trim()).find(Boolean);
    value = after && !PAGE_HEADER_RE.test(after) ? unhead(after) : "";
  }
  return value || null;
}

function keywordsFrom(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/\s*[;,•·]\s*/)) {
    const k = clean(part.replace(/\.$/, ""), CAP.keyword);
    if (k.length >= 2 && !out.some((o) => fold(o) === fold(k))) out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** ≤ 600 chars, cut at a sentence end when one is near. */
function summaryFrom(value: string): string | null {
  const s = sanitizeLine(value, 2_000);
  if (s.length < 40) return null;
  if (s.length <= CAP.summary) return s;
  const head = s.slice(0, CAP.summary);
  const dot = head.lastIndexOf(". ");
  return dot >= 200 ? head.slice(0, dot + 1) : sanitizeLine(s, CAP.summary);
}

// ---------------------------------------------------------------------------
// Language

const LANG_WORDS: Record<string, string[]> = {
  cs: ["a", "se", "na", "je", "že", "ve", "pro", "jako", "ze", "který", "která", "které", "podle", "není", "jsou", "byl", "bylo", "nebo", "také", "jeho", "při", "což"],
  sk: ["a", "sa", "na", "je", "že", "vo", "pre", "ako", "zo", "ktorý", "ktorá", "ktoré", "podľa", "nie", "sú", "bol", "bolo", "alebo", "tiež", "jeho", "pri", "čo"],
  en: ["the", "of", "and", "to", "in", "is", "that", "for", "with", "as", "on", "by", "be", "this", "are", "which"],
  de: ["der", "die", "und", "das", "ist", "nicht", "mit", "von", "zu", "den", "des", "auf", "für", "sich", "dem", "eine"],
};
const LANG_LETTERS: Record<string, RegExp> = { cs: /[řěů]/giu, sk: /[ľĺŕôä]/giu, de: /[ßü]/giu };

function detectLanguage(text: string): { lang: string; confidence: number } | null {
  const sample = text.slice(0, 6_000).toLowerCase();
  const tokens = sample.match(/\p{L}+/gu) ?? [];
  if (tokens.length < 30) return null;
  const scores: Record<string, number> = {};
  for (const [lang, words] of Object.entries(LANG_WORDS)) {
    const set = new Set(words);
    scores[lang] = tokens.filter((t) => set.has(t)).length + 3 * (sample.match(LANG_LETTERS[lang] ?? /$^/g)?.length ?? 0);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] < 8) return null;
  const clear = top[1] >= 1.5 * Math.max(1, second[1]);
  return { lang: top[0], confidence: clear ? 0.8 : 0.5 };
}

// ---------------------------------------------------------------------------
// File name and PDF info

const JUNK_PDF_TITLE_RE = /^(?:microsoft\s+(?:word|powerpoint)\b.*|untitled.*|bez\s+názvu|document\d*|dokument\d*|[\d\s._-]+|.*\.(?:docx?|pdf|indd|rtf|odt|qxd|tex))$/iu;
const JUNK_PDF_AUTHOR_RE = /^(?:admin(?:istrator|istrátor)?|user|uživatel|owner|windows\s+user|autor|author|pc|hp|dell|lenovo|acer|asus|unknown|neznámý)$/iu;

function fileTitle(fileName: string): string | null {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!/\p{L}{3}/u.test(base)) return null;
  return clean(base, CAP.title) || null;
}

// ---------------------------------------------------------------------------
// Extractors — each reads the zones and returns candidates; heuristicMeta
// composes them.

/** A candidate value with its confidence (and a source other than "heuristic" when it has one). */
interface Found<T> {
  value: T;
  confidence: number;
  source?: MetaSource;
}

/** The parts of the input each extractor reads. */
interface Zones {
  front: string;
  colophon: string;
  authorsPage: string;
  heads: string;
  pdf: Record<string, string>;
  facts: MetaInput["facts"];
  fileName: string;
  /** front + colophon + author page. */
  body: string;
  /** The first 25 lines of the front — the title page area. */
  titleZone: string;
  /** Where a journal names itself: running heads, the PDF subject/title, the top of the first page. */
  journalZone: string;
  /** The head of a decision: the title zone and the first 3k characters. */
  decisionZone: string;
}

function zonesOf(input: MetaInput): Zones {
  const front = input.front ?? "";
  const colophon = input.colophon ?? "";
  const authorsPage = input.authorsPage ?? "";
  const heads = input.runningHeads ?? "";
  const pdf = input.pdfInfo ?? {};
  const titleZone = lines(front).filter((l) => !PAGE_HEADER_RE.test(l)).slice(0, 25).join("\n");
  return {
    front,
    colophon,
    authorsPage,
    heads,
    pdf,
    facts: input.facts,
    fileName: input.fileName ?? "",
    body: [front, colophon, authorsPage].join("\n"),
    titleZone,
    journalZone: [heads, pdf.subject ?? "", pdf.title ?? "", titleZone.slice(0, 600)].join("\n"),
    decisionZone: [titleZone, front.slice(0, 3_000)].join("\n"),
  };
}

function doiOf(z: Zones): Found<string> | null {
  for (const m of [z.body, z.heads].join("\n").matchAll(DOI_LABELLED_RE)) return { value: trimDoi(m[1]).toLowerCase(), confidence: 0.85 };
  const bare = findIdentSpans(z.front.slice(0, 3_000)).flatMap((s) => s.keys).find((k) => k.startsWith("doi:"));
  return bare ? { value: bare.slice(4), confidence: 0.55 } : null;
}

// ── decisions

interface CaseNumber extends Found<string> {
  court: "NS" | "NSS" | "US" | "SDEU" | null;
}

/** The decision's own sp. zn.: labelled ("Spisová značka:"), heading the text, or after "sp. zn." near the top. */
function caseNumberOf(z: Zones): CaseNumber | null {
  const labelledCase = /(?:Spisová\s+značka|Sp\.\s*zn\.)\s*:\s*([^\n]{3,60})/iu.exec(z.decisionZone);
  const c = labelledCase ? canonicalCaseNumber(labelledCase[1]) : null;
  if (c) return { value: c.display, court: c.court, confidence: 0.95 };
  // A decision's own number heads it: "25 Cdo 1234/2019-150" on one of the first lines.
  for (const l of lines(z.titleZone).slice(0, 5)) {
    const bare = unhead(l).replace(/^(?:sp\.\s*zn\.|č\.\s*j\.)\s*/iu, "");
    const parsed = bare.length <= 45 ? canonicalCaseNumber(bare) : null;
    if (parsed) return { value: parsed.display, court: parsed.court, confidence: 0.85 };
  }
  const m = /sp\.\s*zn\.\s*([^\n]{3,50})/iu.exec(z.front.slice(0, 1_500));
  const near = m ? canonicalCaseNumber(m[1]) : null;
  return near ? { value: near.display, court: near.court, confidence: 0.7 } : null;
}

function ecliOf(z: Zones): string | null {
  const key = findIdentSpans(z.decisionZone).flatMap((s) => s.keys).find((k) => k.startsWith("ecli:"));
  return key ? `ECLI:${key.slice(5).toUpperCase()}` : null;
}

/** The deciding court: a "Soud:" label, the ECLI's court code, the court named at the top, the case number's registry. */
function courtOf(z: Zones, ecli: string | null, caseNumber: CaseNumber | null): Found<string> | null {
  const label = /(?:^|\n)Soud\s*:\s*([^\n]{3,80})/u.exec(z.decisionZone);
  const labelled = label ? (COURT_RE.exec(label[1]) ?? COURT_LINE_CI_RE.exec(label[1].trim())) : null;
  if (labelled) return { value: courtCase(labelled[1]), confidence: 0.9 };
  const code = ecli ? /^ECLI:([A-Z]{2}:[A-Z]+):/.exec(ecli)?.[1] : undefined;
  if (code && ECLI_COURTS[code]) return { value: ECLI_COURTS[code], confidence: 0.9 };
  const named =
    COURT_RE.exec(z.decisionZone) ??
    lines(z.decisionZone)
      .filter((l) => isShouting(l) && l.length <= 80)
      .map((l) => COURT_LINE_CI_RE.exec(l))
      .find(Boolean) ??
    null;
  if (named) {
    const after = z.decisionZone.slice(named.index + named[0].length, named.index + named[0].length + 40);
    return { value: courtCase(named[1]), confidence: /^\s*(?:rozhodl|rozhodla|rozhodlo|jako\s+soud)/iu.test(after) ? 0.8 : 0.6 };
  }
  const byRegistry = caseNumber?.court ? CASE_COURTS[caseNumber.court] : undefined;
  return byRegistry ? { value: byRegistry, confidence: 0.75 } : null;
}

/**
 * The decision's date: "Datum rozhodnutí:", the closing "V Brně dne 24. 4.
 * 2019", or the date right after its own number ("II. ÚS 1234/18 ze dne …").
 * Never an "ze dne" inside the text — that is the appealed decision's.
 */
function decisionDateOf(z: Zones, caseNumber: CaseNumber | null): Found<string> | null {
  const label = new RegExp(String.raw`Datum\s+(?:rozhodnutí|vydání\s+rozhodnutí)\s*:\s*${DATE_SOURCE}`, "iu").exec(z.decisionZone);
  const labelled = label ? dateFrom(label) : null;
  if (labelled) return { value: labelled, confidence: 0.9 };
  const closingRe = new RegExp(String.raw`(?:^|\n)\s*V\s+[\p{Lu}][\p{L}]+(?:\s+nad\s+[\p{Lu}][\p{L}]+)?\s+dne\s+${DATE_SOURCE}`, "u");
  const closing = closingRe.exec([z.colophon, z.front].join("\n"));
  const closed = closing ? dateFrom(closing) : null;
  if (closed) return { value: closed, confidence: 0.85 };
  if (!caseNumber) return null;
  const near = new RegExp(String.raw`ze\s+dne\s+${DATE_SOURCE}`, "u");
  for (const l of lines(z.decisionZone).slice(0, 8)) {
    const own = canonicalCaseNumber(l)?.display === caseNumber.value;
    const m = own ? near.exec(l) : null;
    const d = m ? dateFrom(m) : null;
    if (d) return { value: d, confidence: 0.8 };
  }
  return null;
}

// ── journals

interface JournalFound {
  journal: Journal;
  /** Named by a running head or the PDF subject — the strongest article signal. */
  inHeads: boolean;
  issue: string | null;
  volume: string | null;
  year: number | null;
}

function journalOf(z: Zones): JournalFound | null {
  const headsZone = [z.heads, z.pdf.subject ?? ""].join("\n");
  for (const journal of JOURNALS) {
    const inHeads = journal.re.test(headsZone);
    const m = inHeads ? null : journal.re.exec(z.journalZone);
    if (!inHeads && !m) continue;
    if (!inHeads && journal.strict) {
      const after = z.journalZone.slice(m!.index + m![0].length, m!.index + m![0].length + 30);
      if (!/^\s*,?\s*(?:č\.\s*)?\d{1,2}\s*\/\s*\d{4}|^\s*,\s*(?:roč|\d{4})/u.test(after)) continue;
    }
    const at = z.journalZone.search(journal.re);
    const after = z.journalZone.slice(at, at + 160);
    let issue: string | null = null;
    let year: number | null = null;
    const slash = new RegExp(String.raw`(?:č\.\s*)?(\d{1,2})\s*\/\s*${YEAR_SOURCE}(?!\d)`, "u").exec(after);
    if (slash) {
      issue = slash[1];
      year = Number(slash[2]);
    } else {
      issue = /(?:číslo|č\.)\s*(\d{1,2})(?!\d)/iu.exec(after)?.[1] ?? null;
      const y = new RegExp(`(?<!\\d)${YEAR_SOURCE}(?!\\d)`, "u").exec(after);
      year = y ? Number(y[1]) : null;
    }
    const volume = /roč(?:ník|\.)\s*([IVXLC]{1,8}|\d{1,3})(?![\p{L}\p{N}])/iu.exec(z.journalZone)?.[1] ?? null;
    return { journal, inHeads, issue, volume, year };
  }
  return null;
}

/** Printed "s. 417–425" near the journal's name, else the numeric page labels (not starting at 1). */
function pagesRangeOf(z: Zones): Found<string> | null {
  const printed = /(?<![\p{L}])s\.\s*(\d{1,4})\s*[-–]\s*(\d{1,4})(?!\d)/u.exec(z.journalZone);
  if (printed && Number(printed[2]) >= Number(printed[1])) return { value: `${printed[1]}–${printed[2]}`, confidence: 0.8 };
  const first = z.facts?.paged ? z.facts.firstPageLabel : null;
  const last = z.facts?.paged ? z.facts.lastPageLabel : null;
  if (!first || !last || !/^\d{1,4}$/.test(first) || !/^\d{1,4}$/.test(last)) return null;
  const a = Number(first);
  const b = Number(last);
  return a > 1 && b >= a ? { value: a === b ? String(a) : `${a}–${b}`, confidence: 0.7 } : null;
}

// ── document type

/** Doc-type candidates, strongest first on a tie. */
const TYPE_PRIORITY: DocType[] = ["rozhodnuti", "komentar", "vzor", "clanek", "kapitola", "kniha", "jine"];
const KOMENTAR_WORD_RE = /komentář|komentované\s+zákony|velké\s+komentáře/iu;

interface TypeSignals {
  form: RegExpExecArray | null;
  caseNumber: CaseNumber | null;
  ecli: string | null;
  court: Found<string> | null;
  tp: TitleGuess;
  templateKind: TemplateKind | null;
  journal: JournalFound | null;
  isbns: number;
  issn: boolean;
  doi: boolean;
  abstract: boolean;
}

/** The strongest document type the text supports, or null. */
function guessDocType(z: Zones, s: TypeSignals): Found<DocType> | null {
  const scores = new Map<DocType, number>();
  const vote = (t: DocType, c: number) => scores.set(t, Math.max(scores.get(t) ?? 0, c));
  const republic = REPUBLIC_RE.test(z.decisionZone);
  if (s.form && (republic || s.caseNumber || s.ecli || s.court)) vote("rozhodnuti", 0.9);
  else if (s.caseNumber && s.ecli) vote("rozhodnuti", 0.8);
  else if (s.caseNumber && /(?:^|\n)Typ\s+rozhodnutí\s*:/iu.test(z.decisionZone)) vote("rozhodnuti", 0.85);

  const titleText = [s.tp.title, s.tp.subtitle].filter(Boolean).join(" ");
  if (s.tp.komentar || [titleText, s.tp.series ?? "", z.pdf.title ?? ""].some((t) => KOMENTAR_WORD_RE.test(t))) vote("komentar", 0.85);
  else if ((z.facts?.parSections ?? 0) >= 20 && z.facts?.anchorLabel) vote("komentar", 0.6);

  const placeholders = z.facts?.placeholders ?? 0;
  if (VZOR_WORD_RE.test(s.tp.title ?? "") || VZOR_WORD_RE.test(lines(z.titleZone).slice(0, 3).join(" "))) vote("vzor", 0.85);
  else if (s.templateKind && placeholders >= 2) vote("vzor", 0.8);
  else if (s.templateKind && s.tp.fromHeading) vote("vzor", 0.55);
  else if (placeholders >= 5) vote("vzor", 0.5);

  if (s.journal) vote("clanek", s.journal.inHeads || !s.isbns ? 0.85 : 0.6);
  else if (s.issn && !s.isbns) vote("clanek", 0.75);
  else if (s.abstract && !s.isbns) vote("clanek", 0.65);
  else if (s.doi && !s.isbns) vote("clanek", 0.55);
  if (s.isbns) vote("kniha", /sborník/iu.test(titleText) ? 0.6 : 0.7);

  let best: Found<DocType> | null = null;
  for (const t of TYPE_PRIORITY) {
    const c = scores.get(t);
    if (c !== undefined && c > (best?.confidence ?? 0)) best = { value: t, confidence: c };
  }
  if (best) return best;
  const n = z.fileName;
  const byName: DocType | null = /koment/iu.test(n)
    ? "komentar"
    : /vzor|smlouv|žalob|zalob/iu.test(n)
      ? "vzor"
      : /rozsud|usnes|nález|nalez|(?<![a-z])cdo(?![a-z])/iu.test(n)
        ? "rozhodnuti"
        : /článek|clanek/iu.test(n)
          ? "clanek"
          : null;
  return byName ? { value: byName, confidence: 0.4, source: "filename" } : null;
}

// ── title and people

/**
 * The title: a decision's form ("Rozsudek"); else a heading on the title
 * page (0.6) beats a PDF title the text confirms (0.55), a plain first line
 * (0.45), an unconfirmed PDF title (0.35) and the file name (0.3).
 */
function titleOf(z: Zones, tp: TitleGuess, docType: DocType | null, form: RegExpExecArray | null): { title: Found<string>; subtitle: string | null } | null {
  if (docType === "rozhodnuti" && form) return { title: { value: clean(sentenceCase(form[1]), CAP.title), confidence: 0.75 }, subtitle: null };
  const candidates: Array<{ title: Found<string>; subtitle: string | null }> = [];
  if (tp.title && !(docType === "rozhodnuti" && canonicalCaseNumber(tp.title))) {
    candidates.push({ title: { value: tp.title, confidence: tp.fromHeading ? 0.6 : 0.45 }, subtitle: tp.subtitle });
  }
  const pdfTitle = z.pdf.title ? clean(z.pdf.title, CAP.title) : "";
  if (pdfTitle.length >= 3 && !JUNK_PDF_TITLE_RE.test(pdfTitle)) {
    const confirmed = fold(z.front).includes(fold(pdfTitle));
    candidates.push({ title: { value: pdfTitle, confidence: confirmed ? 0.55 : 0.35, source: "pdf" }, subtitle: null });
  }
  const nameTitle = fileTitle(z.fileName);
  if (nameTitle) candidates.push({ title: { value: nameTitle, confidence: 0.3, source: "filename" }, subtitle: null });
  return candidates.sort((a, b) => b.title.confidence - a.title.confidence)[0] ?? null;
}

/** Authors and editors: the title page's names line, the author page, the PDF author. Never for a decision (judges, parties). */
function peopleOf(z: Zones, tp: TitleGuess, docType: DocType | null): { authors: Found<string[]> | null; editors: Found<string[]> | null } {
  let authors: Found<string[]> | null = null;
  let editors: Found<string[]> | null = null;
  if (docType === "rozhodnuti") return { authors, editors };
  if (tp.names) {
    const found = { value: tp.names.names, confidence: tp.names.marked ? 0.75 : 0.6 };
    // "Petrov, Výtisk, Beran a kol." on a commentary names its editors.
    if (tp.names.editors || (tp.names.collective && docType === "komentar")) editors = found;
    else authors = found;
  }
  const page = z.authorsPage || (/Autorský kolektiv|Kolektiv autorů|Autoři/iu.test(z.front) ? z.front : "");
  const collective = authorsFromPage(page);
  if (!authors && collective.length >= 2) authors = { value: collective, confidence: 0.55 };
  if (!authors && !editors && z.pdf.author) {
    // "Jan Novák; Petr Svoboda" — one name per part; junk (the typesetter's account) dropped.
    const names = z.pdf.author
      .split(/\s*;\s*/)
      .filter((part) => part && !JUNK_PDF_AUTHOR_RE.test(part))
      .flatMap((part) => parseNamesLine(part)?.names ?? [])
      .slice(0, MAX_NAMES);
    if (names.length) {
      const folded = fold(z.body);
      const inText = names.every((n) => {
        const s = surnameOf(n);
        return !!s && folded.includes(s);
      });
      authors = { value: names, confidence: inText ? 0.45 : 0.3, source: "pdf" };
    }
  }
  return { authors, editors };
}

// ── imprint

/**
 * An edition statement on a line of its own (title page, tiráž) is the
 * book's; one inside running text may cite another work's edition.
 */
function editionFound(z: Zones, tp: TitleGuess): Found<string> | null {
  if (tp.edition) return { value: tp.edition, confidence: 0.85 };
  const line = lines([z.colophon, z.front.slice(0, 6_000)].join("\n"))
    .map((l) => unhead(l))
    .find((l) => l.length <= 80 && l.split(/\s+/).length <= 8 && editionOf(l));
  const fromLine = line ? editionOf(line) : null;
  if (fromLine) return { value: fromLine, confidence: 0.85 };
  const fromColophon = editionOf(z.colophon);
  if (fromColophon) return { value: fromColophon, confidence: 0.8 };
  const inText = editionOf(z.front.slice(0, 4_000));
  return inText ? { value: inText, confidence: 0.6 } : null;
}

function publisherOf(z: Zones, tp: TitleGuess): (Found<string> & { place: string | null }) | null {
  for (const zone of [z.colophon, z.front]) {
    // A line that says who published ("© …", "Vydalo …", "…, s. r. o.") beats a bare mention.
    let bare: Publisher | null = null;
    for (const l of lines(zone)) {
      const p = publisherIn(l);
      if (!p) continue;
      if (zone === z.colophon || PUBLISHING_CONTEXT_RE.test(l)) return { value: p.name, place: p.place, confidence: 0.85 };
      if (!p.strict) bare ??= p;
    }
    if (bare) return { value: bare.name, place: bare.place, confidence: 0.7 };
  }
  if (tp.publisher) return { value: tp.publisher.name, place: tp.publisher.place, confidence: 0.75 };
  const g = GENERIC_PUBLISHER_RE.exec(z.colophon) ?? GENERIC_PUBLISHER_RE.exec(z.front);
  const name = g ? clean(g[1]) : "";
  return name.length >= 3 && !/^(?:v|ve)\s/iu.test(name) ? { value: name, place: null, confidence: 0.55 } : null;
}

/** "Praha 2019" on the title page or in the tiráž, "Praha: Leges", the publisher's address, the publisher's seat. */
function placeOf(z: Zones, tp: TitleGuess, publisher: { place: string | null } | null): Found<string> | null {
  if (tp.place) return { value: tp.place, confidence: 0.8 };
  const zone = lines([z.colophon, z.front].join("\n"));
  for (const l of zone) {
    const m = PLACE_YEAR_LINE_RE.exec(unhead(l));
    if (m && PLACES[fold(m[1])]) return { value: PLACES[fold(m[1])], confidence: 0.8 };
  }
  const imprint = PLACE_PUBLISHER_RE.exec(z.colophon);
  if (imprint && PLACES[fold(imprint[1])]) return { value: PLACES[fold(imprint[1])], confidence: 0.75 };
  // The publisher's address in a tiráž: "…, 130 00 Praha 3".
  const postal = new RegExp(String.raw`(?<!\d)\d{3}\s?\d{2}\s+(${PLACE_SOURCE})(?![\p{L}])`, "u");
  for (const l of zone) {
    const m = PUBLISHING_CONTEXT_RE.test(l) ? postal.exec(l) : null;
    if (m && PLACES[fold(m[1])]) return { value: PLACES[fold(m[1])], confidence: 0.65 };
  }
  return publisher?.place ? { value: publisher.place, confidence: 0.5 } : null;
}

/** The year: © (latest), the decision's date, the journal issue, "Praha 2019", "vydání … 2019", the file name. */
function yearOf(z: Zones, tp: TitleGuess, extra: { decidedOn: Found<string> | null; isDecision: boolean; journalYear: number | null }): Found<number> | null {
  const years: Array<Found<number>> = [];
  const copyright: number[] = [];
  const yearRe = new RegExp(`(?<!\\d)${YEAR_SOURCE}(?!\\d)`, "gu");
  for (const l of lines([z.colophon, z.front].join("\n"))) {
    if (/©|\(c\)|Copyright/iu.test(l)) for (const m of l.matchAll(yearRe)) copyright.push(Number(m[1]));
  }
  if (copyright.length) years.push({ value: Math.max(...copyright), confidence: 0.9 });
  // A decision's date is its year; elsewhere "V Praze dne …" signs a preface — a weak hint.
  if (extra.decidedOn) years.push({ value: Number(extra.decidedOn.value.slice(0, 4)), confidence: extra.isDecision ? extra.decidedOn.confidence : 0.5 });
  if (extra.journalYear) years.push({ value: extra.journalYear, confidence: 0.8 });
  if (tp.year) years.push({ value: tp.year, confidence: 0.8 });
  for (const l of lines(z.colophon)) {
    const m = PLACE_YEAR_LINE_RE.exec(unhead(l));
    if (m) years.push({ value: Number(m[2]), confidence: 0.8 });
  }
  const edition = new RegExp(String.raw`(?:vydání|vyd\.)[^\n]{0,60}?(?<!\d)${YEAR_SOURCE}(?!\d)`, "u").exec([z.colophon, z.titleZone].join("\n"));
  if (edition) years.push({ value: Number(edition[1]), confidence: 0.75 });
  const fromName = /(?<!\d)(19[5-9]\d|20\d\d)(?!\d)/.exec(z.fileName);
  if (fromName) years.push({ value: Number(fromName[1]), confidence: 0.3, source: "filename" });
  return years.filter((y) => y.value >= 1500 && y.value <= 2100).sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

/** For a commentary: the act named in the title (or the PDF title), else near the top of the text. */
function commentedActOf(z: Zones, tp: TitleGuess): Found<{ act: string; name: string }> | null {
  const titleText = [tp.title, tp.subtitle].filter(Boolean).join(" ");
  const fromTitle = resolveAct(titleText) ?? resolveAct(z.pdf.title ?? "");
  if (fromTitle) return { value: fromTitle, confidence: 0.85 };
  const near = resolveAct(z.titleZone.slice(0, 1_500));
  return near ? { value: near, confidence: 0.6 } : null;
}

/** "rozsudek_25_Cdo_1234_2019.pdf" → "25 Cdo 1234/2019". */
function caseNumberFromFileName(fileName: string): string | null {
  const spaced = fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/_+/g, " ")
    .replace(/(\p{L})\s+(\d{1,6})[\s-](\d{4}|\d{2})(?!\d)/u, "$1 $2/$3");
  return canonicalCaseNumber(spaced)?.display ?? null;
}

// ── keywords, summary

function keywordsOf(z: Zones, language: string | null): Found<string[]> | null {
  const czech = labelled(z.front, KEYWORDS_RE);
  if (czech) return { value: keywordsFrom(czech), confidence: 0.8 };
  const heslo = /(?:^|\n)Hesl[oa]\s*:\s*([^\n]{3,300})/u.exec(z.decisionZone)?.[1];
  if (heslo) return { value: keywordsFrom(heslo), confidence: 0.6 };
  const english = language === "en" ? labelled(z.front, KEYWORDS_EN_RE) : null;
  if (english) return { value: keywordsFrom(english), confidence: 0.6 };
  return z.pdf.keywords ? { value: keywordsFrom(z.pdf.keywords), confidence: 0.3, source: "pdf" } : null;
}

function summaryOf(z: Zones, language: string | null): Found<string> | null {
  const abstract = labelled(z.front, ABSTRACT_RE) ?? (language === "en" ? labelled(z.front, ABSTRACT_EN_RE) : null);
  const summary = abstract ? summaryFrom(abstract) : null;
  return summary ? { value: summary, confidence: 0.6 } : null;
}

// ---------------------------------------------------------------------------

/**
 * Deterministic proposals from the metadata input (see the header). Pure.
 */
export function heuristicMeta(input: MetaInput): ProposedMeta {
  const out: ProposedMeta = {};
  const set = <K extends MetaField>(key: K, found: Found<BibMeta[K]> | null | undefined) => {
    if (!found) return;
    const v = found.value as unknown;
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return;
    (out as Record<string, unknown>)[key] = prop<K>(found.value, found.confidence, found.source);
  };
  const z = zonesOf(input);

  // Identifiers
  const isbns = findIsbns([z.colophon, z.front, z.authorsPage].join("\n"));
  if (isbns.values.length) set("isbn", { value: isbns.values, confidence: isbns.ambiguous ? 0.6 : isbns.labelled ? 0.95 : 0.8 });
  const issn = findIssn([z.body, z.heads].join("\n"));
  if (issn) set("issn", { value: issn, confidence: 0.9 });
  const doi = doiOf(z);
  set("doi", doi);

  // Signals, then the type they add up to (the uploader's hint wins)
  const tp = guessTitlePage(z.front);
  const form = DECISION_FORM_RE.exec(z.titleZone);
  const caseNumber = caseNumberOf(z);
  const ecli = ecliOf(z);
  const court = courtOf(z, ecli, caseNumber);
  const decidedOn = decisionDateOf(z, caseNumber);
  const journal = journalOf(z);
  const templateKind = templateKindOf(tp.title ?? "") ?? templateKindOf(lines(z.titleZone)[0] ?? "");
  const abstract = !!labelled(z.front, ABSTRACT_RE) || !!labelled(z.front, KEYWORDS_RE);
  const guessed = guessDocType(z, { form, caseNumber, ecli, court, tp, templateKind, journal, isbns: isbns.values.length, issn: !!issn, doi: !!doi, abstract });
  const hint = input.docTypeHint && (DOC_TYPES as readonly string[]).includes(input.docTypeHint) ? input.docTypeHint : null;
  set("doc_type", hint ? { value: hint, confidence: 0.95, source: "user" } : guessed);
  const docType: DocType | null = hint ?? guessed?.value ?? null;

  // Title and people
  const title = titleOf(z, tp, docType, form);
  if (title) {
    set("title", title.title);
    if (title.subtitle) set("subtitle", { value: title.subtitle, confidence: 0.45 });
  }
  const people = peopleOf(z, tp, docType);
  set("authors", people.authors);
  set("editors", people.editors);

  // Imprint (a decision has none; an article's place is its journal's business)
  set("edition", editionFound(z, tp));
  const publisher = publisherOf(z, tp);
  if (docType !== "rozhodnuti") set("publisher", publisher);
  if (docType !== "rozhodnuti" && docType !== "clanek") set("place", placeOf(z, tp, publisher));
  if (tp.series) set("series", { value: tp.series, confidence: 0.7 });
  set("year", yearOf(z, tp, { decidedOn, isDecision: docType === "rozhodnuti", journalYear: journal?.year ?? null }));

  // Fields of one document type
  if (docType === "rozhodnuti") {
    const fromName = caseNumber ? null : caseNumberFromFileName(z.fileName);
    set("case_number", caseNumber ?? (fromName ? { value: fromName, confidence: 0.4, source: "filename" } : null));
    set("ecli", ecli ? { value: ecli, confidence: 0.95 } : null);
    set("court", court);
    set("decided_on", decidedOn);
  }
  if (docType === "komentar") {
    const act = commentedActOf(z, tp);
    if (act) {
      set("commented_act", { value: act.value.act, confidence: act.confidence });
      set("commented_act_name", { value: act.value.name, confidence: act.confidence });
    }
  }
  if (docType === "vzor") {
    const kind = templateKind ?? templateKindOf(z.fileName);
    set("template_kind", { value: kind ?? "jine", confidence: kind ? 0.7 : 0.4 });
  }
  if (docType === "clanek" || docType === "kapitola" || journal) {
    if (journal) set("container_title", { value: journal.journal.name, confidence: 0.85 });
    if (journal?.issue) set("issue", { value: journal.issue, confidence: 0.8 });
    if (journal?.volume) set("volume", { value: journal.volume, confidence: 0.75 });
    set("pages_range", pagesRangeOf(z));
  }
  if (z.facts?.anchorLabel) set("anchor_label", { value: z.facts.anchorLabel, confidence: 0.9 });
  else if (/(?<![\p{L}])marg\.\s*č\./u.test(z.body)) set("anchor_label", { value: "marg. č.", confidence: 0.5 });

  // Keywords, summary, language
  const language = detectLanguage(z.body);
  set("keywords", keywordsOf(z, language?.lang ?? null));
  set("summary", summaryOf(z, language?.lang ?? null));
  if (language) set("language", { value: language.lang, confidence: language.confidence });
  return out;
}
