import { ACT_ABBREVIATIONS, ACT_NUMBER_RE, zakId } from "@/src/files/index/acts";
import { EU_ACT_RE, euActId } from "@/src/files/index/identifiers";

/**
 * The provisions a decision cites — § and články, down to odstavec,
 * písmeno and bod — each with the act it belongs to (decided 26. 10.:
 * finer than §, every act, no time versions). DERIVED from the text
 * (decision_provision, rebuilt by `mirror reindex`).
 *
 * 1. Act mentions, with their spans: by number (Sbírka zákonů, Sbírka
 *    mezinárodních smluv, EU acts by number), by name (the registry's
 *    "zákon o …" names: only the first word declines), by the act table's
 *    names and abbreviations (src/files/index/acts.ts), by the sources
 *    cited by name (Ústava, Listina, Úmluva, SFEU, SEU, Listina EU), and by
 *    the caller's global aliases (mined from the case law).
 * 2. Definitions inside the decision — "zákona č. 99/1963 Sb., občanský
 *    soudní řád, ve znění pozdějších předpisů (dále jen „o. s. ř.“)" — bind
 *    the alias to the MAIN act of the clause (not an amendment after "ve
 *    znění"); every later occurrence of the alias is a mention of it. A
 *    definition beats every global meaning, so "(dále jen „zákon“)" makes
 *    "zákon" that one act in this decision only.
 * 3. Provision references: "§", "§§", "čl.", "článek/článku/…", each a list
 *    ("§ 2910 a 2913", "§§ 2910 až 2913" — a range of up to 30 expands),
 *    each with odstavce, písmena and body ("odst. 1 a 2", "písm. a) až c)").
 * 4. Each reference takes the act mentioned right after it, else the act a
 *    back-reference names ("téhož zákona", "citovaného nařízení", "tohoto
 *    zákona") — the last act mentioned before it — else none ('').
 *
 * Provision keys: par:2913, par:2913/o1, par:2913/o1/pb, par:2913/o1/pb/b3,
 * par:243c/o3/v1 (věta první; vposl, vpred / vza = před / za středníkem);
 * cl:6/o1/pf; a písmeno without odstavec: par:2913/pb. Every level is
 * emitted, so a search for § 2913 finds a decision citing only písm. b).
 * Offsets are JavaScript string indices into the text. Pure — unit-tested.
 */

export interface ActMention {
  start: number;
  end: number;
  act: string;
  /** A name several acts share ("zákon o obcích"): all of them — an earlier numbered mention of one decides. */
  alts?: string[];
  /** A title shared with older acts (registry): with nothing else to go by, the year's pick stands. */
  byYear?: true;
  /** Named by its number ("zákona č. 40/1964 Sb."), not by a name. */
  numbered?: true;
  /** By the decision's own "(dále jen „…“)": that binding stands. */
  defined?: true;
}

export interface ProvisionMention {
  /** Act id, or "" when it could not be resolved. */
  act: string;
  /** Deepest key of the reference ("par:2913/o1/pb"); `keys` holds every level. */
  provision: string;
  keys: string[];
  start: number;
  end: number;
  /** How the act was found: named right after, from the next reference of a chain, a back reference; "" none. */
  via: "after" | "chain" | "back" | "";
}

/** What the registry adds: names ("zákon o …" subjects) and global aliases, both resolved with the decision's year. */
export interface ActLookup {
  /** "zákon" + subject words ("obchodních korporacích…") → the act whose name the words start with. */
  byName(kind: string, words: string, year: number | null): { act: string; length: number; alts?: string[] } | null;
  /** Global aliases (mined abbreviations) as [alias, act] — never generic words. */
  aliases(year: number | null): Array<[string, string]>;
  /**
   * The act an amending act amends, when it amends one only ("Zákon, kterým se mění zákon č. 185/2001 Sb.").
   * For checking only: the number the decision writes is never replaced.
   */
  amended?(act: string): string | null;
}

/** Bump when the rules change: `mirror provisions` then redoes every decision. */
export const EXTRACTOR_VERSION = 4;

const ODD_SPACES = /[     ]/g;
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/** "zákon" in any case but "zákoník". */
const ZAKON = "zákon(?:a|u|em|e|ě)?(?![\\p{L}\\p{N}])";

/**
 * Acts cited by name only — the act table (acts.ts) has Ústava; these it
 * lacks. Longest match wins. `before`: [year, act] — in a decision from
 * before that year the name meant the older act.
 */
const NAMED_SOURCES: Array<{ pattern: RegExp; act: string; before?: Array<[number, string]> }> = [
  { pattern: new RegExp(`${B}Listin\\p{L}*\\s+základních\\s+práv\\s+Evropské\\s+unie${E}`, "gu"), act: "eu:12016P/TXT" },
  { pattern: new RegExp(`${B}Listin\\p{L}*\\s+EU${E}`, "gu"), act: "eu:12016P/TXT" },
  { pattern: new RegExp(`${B}Listin\\p{L}*(?:\\s+základních\\s+práv\\s+a\\s+svobod)?${E}`, "gu"), act: "zak:2/1993" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*\\s+o\\s+ochraně\\s+lidských\\s+práv\\s+a\\s+základních\\s+svobod${E}`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*${E}(?!\\s+(?:o|OSN|č\\.|mezi)\\s)`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}(?:SFEU|Smlouv\\p{L}*\\s+o\\s+fungování\\s+(?:Evropské\\s+unie|EU))${E}`, "gu"), act: "eu:12016E/TXT" },
  { pattern: new RegExp(`${B}(?:SEU|Smlouv\\p{L}*\\s+o\\s+Evropské\\s+unii)${E}`, "gu"), act: "eu:12016M/TXT" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*\\s+o\\s+právech\\s+dítěte${E}`, "gu"), act: "zak:104/1991" },
  { pattern: new RegExp(`${B}Úmluv\\p{L}*\\s+o\\s+právním\\s+postavení\\s+uprchlíků${E}`, "gu"), act: "zak:208/1993" },
  { pattern: new RegExp(`${B}Mezinárodní\\p{L}*\\s+pakt\\p{L}*\\s+o\\s+(?:občanských\\s+a\\s+politických|hospodářských,\\s+sociálních\\s+a\\s+kulturních)\\s+právech${E}`, "giu"), act: "zak:120/1976" },
  // The tariffs: courts cite them by their short titles, declined.
  { pattern: new RegExp(`${B}advokátní\\p{L}*\\s+tarif\\p{L}*${E}`, "giu"), act: "zak:177/1996" },
  { pattern: new RegExp(`${B}notářsk\\p{L}*\\s+tarif\\p{L}*${E}`, "giu"), act: "zak:196/2001" },
  { pattern: new RegExp(`${B}exekuční\\p{L}*\\s+tarif\\p{L}*${E}`, "giu"), act: "zak:330/2001" },
  { pattern: new RegExp(`${B}tr\\.\\s?řád\\p{L}*${E}`, "gu"), act: "zak:141/1961" },
  // Abbreviations written without their last dot or without dots ("o. s. ř]", "osř", "obch. zák)").
  { pattern: new RegExp(`${B}(?:osř\\.?|o\\.\\s?s\\.\\s?ř(?![\\p{L}.]))`, "giu"), act: "zak:99/1963" },
  { pattern: new RegExp(`${B}s\\.\\s?ř\\.\\s?s(?![\\p{L}.])`, "gu"), act: "zak:150/2002" },
  { pattern: new RegExp(`${B}obch\\.\\s?zák(?![\\p{L}.])`, "gu"), act: "zak:513/1991" },
  { pattern: new RegExp(`${B}ex\\.\\s?ř\\p{L}*\\.?`, "gu"), act: "zak:120/2001" },
  { pattern: new RegExp(`${B}(?:AT|a\\.\\s?t\\.)(?![\\p{L}])`, "gu"), act: "zak:177/1996" },
  { pattern: new RegExp(`${B}o\\.\\s?z(?![\\p{L}.])`, "gu"), act: "zak:89/2012" },
  { pattern: new RegExp(`${B}obč\\.\\s?(?:zákoník\\p{L}*|zák(?![\\p{L}.]))`, "gu"), act: "zak:89/2012" },
  { pattern: new RegExp(`${B}tr\\.\\s?zákon(?:a|u|em|e)?(?![\\p{L}])`, "gu"), act: "zak:40/2009" },
  // Abbreviations of the case law (review round 2).
  { pattern: new RegExp(`${B}OdpŠk${E}`, "gu"), act: "zak:82/1998" },
  { pattern: new RegExp(`${B}ZKV${E}`, "gu"), act: "zak:328/1991" },
  { pattern: new RegExp(`${B}(?:ZSŠ|zákon\\p{L}*\\s+směnečn\\p{L}*\\s+a\\s+šekov\\p{L}*)${E}`, "gu"), act: "zak:191/1950" },
  { pattern: new RegExp(`${B}ZDP${E}`, "gu"), act: "zak:586/1992" },
  { pattern: new RegExp(`${B}rozpočtov\\p{L}*\\s+pravid\\p{L}*\\s+republiky${E}`, "giu"), act: "zak:576/1990" },
  { pattern: new RegExp(`${B}rozpočtov\\p{L}*\\s+pravid\\p{L}*${E}`, "giu"), act: "zak:218/2000" },
  { pattern: new RegExp(`${B}energetick\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:458/2000" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+velké\\s+privatizaci${E}`, "giu"), act: "zak:92/1991" },
  { pattern: new RegExp(`${B}(?:zákon\\p{L}*|zák\\.)\\s+o\\s+pobytu\\s+cizinců${E}`, "giu"), act: "zak:326/1999" },
  // The Protocols, published with the Convention under 209/1992 Sb., are instruments of their own: "-p1", "-p7".
  { pattern: new RegExp(`${B}[Dd]odatkov\\p{L}*\\s+protokol\\p{L}*(?:\\s+č\\.\\s*1)?(?:\\s+k\\s+(?:této\\s+|[eE]vropské\\s+)?[ÚU]mluv\\p{L}*)?${E}`, "gu"), act: "zak:209/1992-p1" },
  // ECHR by its other names: "Úmluvy o ochraně lidských práv a svobod", "Evropské úmluvy" (not "Evropské úmluvy o extradici").
  { pattern: new RegExp(`${B}[ÚU]mluv\\p{L}*\\s+o\\s+ochraně\\s+lidských\\s+práv(?:\\s+a\\s+(?:základních\\s+)?svobod)?${E}`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}[Ee]vropsk\\p{L}*\\s+[úÚ]mluv\\p{L}*(?!\\s+o\\s+(?!(?:ochraně\\s+)?lidských))(?:\\s+o\\s+(?:ochraně\\s+)?lidských\\s+práv\\p{L}*(?:\\s+a\\s+(?:základních\\s+)?svobod\\p{L}*)?)?${E}`, "gu"), act: "zak:209/1992" },
  { pattern: new RegExp(`${B}Aarhusk\\p{L}*\\s+úmluv\\p{L}*${E}`, "giu"), act: "sm:124/2004" },
  { pattern: new RegExp(`${B}směnečn\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:191/1950" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+politických\\s+stranách${E}`, "giu"), act: "zak:424/1991" },
  { pattern: new RegExp(`${B}spr\\.\\s?ř\\p{L}*\\.?`, "gu"), act: "zak:500/2004" },
  { pattern: new RegExp(`${B}tr\\.\\s?zák(?![\\p{L}.])`, "gu"), act: "zak:40/2009" },
  { pattern: new RegExp(`${B}občansk\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:89/2012" },
  { pattern: new RegExp(`${B}tr\\.\\s?ř(?![\\p{L}.])`, "gu"), act: "zak:141/1961" },
  { pattern: new RegExp(`${B}tr\\s+řád\\p{L}*`, "gu"), act: "zak:141/1961" },
  { pattern: new RegExp(`${B}obch\\.\\s?z\\.(?!\\s?\\p{L}\\.)`, "gu"), act: "zak:513/1991" },
  { pattern: new RegExp(`${B}s\\.\\s?ř\\.(?!\\s?s)`, "gu"), act: "zak:500/2004" },
  { pattern: new RegExp(`${B}transformační\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:42/1992" },
  { pattern: new RegExp(`${B}školsk\\p{L}+\\s+${ZAKON}`, "giu"), act: "zak:561/2004" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+(?:ochraně\\s+)?hospodářské\\s+soutěž\\p{L}*${E}`, "giu"), act: "zak:143/2001", before: [[2001, "zak:63/1991"]] },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+dani\\s+z\\s+příjmů${E}`, "giu"), act: "zak:586/1992" },
  { pattern: new RegExp(`${B}ZDSP${E}`, "gu"), act: "zak:337/1992" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+Ústavním\\p{L}*\\s+soudu${E}`, "giu"), act: "zak:182/1993" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+pozemkových\\s+úpravách${E}`, "giu"), act: "zak:139/2002", before: [[2002, "zak:284/1991"]] },
  { pattern: new RegExp(`${B}Pakt(?:u|em)?${E}`, "gu"), act: "zak:120/1976" },
  { pattern: new RegExp(`${B}(?:SES|Smlouv\\p{L}*\\s+o\\s+(?:založení\\s+)?(?:Evropského\\s+společenství|ES|EHS))${E}`, "gu"), act: "eu:11957E/TXT" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+dr[aá]hách${E}`, "giu"), act: "zak:266/1994" },
  { pattern: new RegExp(`${B}volební\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:247/1995" },
  // Names courts use for acts whose titles say otherwise.
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+půdě${E}`, "giu"), act: "zak:229/1991" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+(?:rozhlasovém\\s+a\\s+televizním\\s+)?vysílání${E}`, "giu"), act: "zak:231/2001" },
  { pattern: new RegExp(`${B}zákon\\p{L}*\\s+o\\s+správě\\s+daní(?:\\s+a\\s+poplatků)?${E}`, "giu"), act: "zak:337/1992" },
  { pattern: new RegExp(`${B}šest\\p{L}*\\s+směrnic\\p{L}*${E}`, "giu"), act: "eu:31977L0388" },
  // "Protokolu č. 7 k Úmluvě": the act id carries the protocol's number (set in findActMentions).
  { pattern: new RegExp(`${B}Protokol\\p{L}*\\s+č\\.\\s*(\\d+)\\s+k\\s+(?:této\\s+|[eE]vropské\\s+)?[ÚU]mluvě${E}`, "gu"), act: "zak:209/1992-p" },
  { pattern: new RegExp(`${B}d\\.\\s?ř\\.(?!\\s?s\\.)`, "gu"), act: "zak:280/2009" },
  { pattern: new RegExp(`${B}horní\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:44/1988" },
  { pattern: new RegExp(`${B}azylov\\p{L}+\\s+${ZAKON}`, "giu"), act: "zak:325/1999" },
  { pattern: new RegExp(`${B}cizineck\\p{L}+\\s+${ZAKON}`, "giu"), act: "zak:326/1999" },
  { pattern: new RegExp(`${B}silniční\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:13/1997" },
  { pattern: new RegExp(`${B}hospodářsk\\p{L}+\\s+zákoník(?:u|em|a)?${E}`, "giu"), act: "zak:109/1964" },
  // Short names of acts replaced by a new one of the same name: the decision's year picks.
  { pattern: new RegExp(`${B}stavební\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:183/2006", before: [[2007, "zak:50/1976"]] },
  { pattern: new RegExp(`${B}celní\\p{L}*\\s+${ZAKON}`, "giu"), act: "zak:242/2016", before: [[2017, "zak:13/1993"]] },
  // Declined forms the act table lacks; the decision's year then decides (RECODIFIED).
  { pattern: new RegExp(`${B}tr\\.\\s?zákoník\\p{L}*${E}`, "gu"), act: "zak:40/2009" },
  { pattern: new RegExp(`${B}trestní\\p{L}*\\s+zákon(?:a|u|em|e)?${E}`, "giu"), act: "zak:40/2009" },
];

/**
 * Abbreviations whose act changed with a recodification: in a decision
 * before the new code's effect, "obč. zák." is the 1964 code (case law,
 * 26. 10.: 169 definitions of it for 40/1964, 22 for 89/2012), "tr. zák."
 * the 1961 one. The decision's year decides; without one, the table's act stays.
 */
/**
 * `settled`: the name is the new act's own and not ambiguous after `until` ("o. z." is the 2012 code's abbreviation;
 * the 1964 one was "obč. zák.") — only the year applies, never "no act".
 */
const RECODIFIED: Array<{ text: RegExp; act: string; until: number; old: string; settled?: true }> = [
  { text: /^(?:obč\.\s?zák|ObčZ|občansk\p{L}+\s+zákon)/iu, act: "zak:89/2012", until: 2014, old: "zak:40/1964" },
  // "o. z." / "OZ" before 2014 is mostly the new code already published; before 2012 it can only be the old one.
  { text: /^(?:o\.\s?z|OZ)/u, act: "zak:89/2012", until: 2012, old: "zak:40/1964", settled: true },
  // "tr. zák." and "trestní zákon" are the old code's names; "tr. zákoník" never is. Decided in 2010, a case was mostly older.
  { text: /^(?:tr\.\s?zák(?!oník)|TrZ|trestní\p{L}*\s+zákon(?!ík))/iu, act: "zak:40/2009", until: 2011, old: "zak:140/1961" },
  { text: /^(?:zákoník\p{L}*\s+práce|zák\.\s?pr(?:áce|\.)|ZPr?(?!\p{L}))/iu, act: "zak:262/2006", until: 2007, old: "zak:65/1965" },
  // Before 2011 "daňový řád" was the zákon o správě daní a poplatků (review round 1: 60 references in three NSS decisions).
  { text: /^(?:daň\.\s?ř|d\.\s?ř|daňov\p{L}*\s+řád|DŘ|DaŘ)/iu, act: "zak:280/2009", until: 2011, old: "zak:337/1992" },
  { text: /^rozpočtov\p{L}*\s+pravid/iu, act: "zak:218/2000", until: 2001, old: "zak:576/1990" },
  { text: /^(?:spr\.\s?ř|s\.\s?ř\.|správní\p{L}*\s+řád)/iu, act: "zak:500/2004", until: 2006, old: "zak:71/1967" },
  { text: /^(?:obch\.\s?zák|ObchZ)/iu, act: "zak:513/1991", until: 9999, old: "zak:513/1991" },
];

/** "starého zákona o pozemkových úpravách", "zák. práce dříve platného", "ve znění účinném do 31. 12. 2013". */
const OLD_HINT = /star\p{L}+|původní\p{L}*|dříve|tehdy|účinn\p{L}*\s+do|platn\p{L}*\s+do/iu;
/** After a name only a qualifier attached to it: "zák. práce dříve platného", "ve znění účinném do …" — not "(dříve § 706 …)". */
const OLD_AFTER = /^[\s,]*(?:dříve\s+platn\p{L}*|tehdy\s+(?:platn|účinn)\p{L}*|(?:ve\s+znění\s+)?(?:účinn|platn)\p{L}*\s+do)/iu;
/** Implementing decrees that tell which of two successor acts a name means. */
const PAIR_HINTS: Record<string, string> = { "zak:205/1999": "zak:168/1999", "zak:69/2024": "zak:30/2024" };
const actYear = (act: string) => Number(/\/(\d{4})/.exec(act)?.[1] ?? 0);

/** The acts a recodified name may mean ("obč. zák.": 89/2012 and 40/1964), or null. */
function pairOf(act: string, matched: string): string[] | null {
  // Only a name of the new act is ambiguous ("rozpočtová pravidla republiky" names the old one alone).
  const r = RECODIFIED.find((x) => x.act === act && x.text.test(matched));
  return r && r.act !== r.old && !r.settled ? [r.act, r.old] : null;
}

/** The year an act took effect, where it matters for telling successors apart; else its year. */
const IN_FORCE: Record<string, number> = {
  "zak:89/2012": 2014, "zak:40/2009": 2010, "zak:500/2004": 2006, "zak:262/2006": 2007, "zak:280/2009": 2011,
  "zak:218/2000": 2001, "zak:183/2006": 2007, "zak:242/2016": 2017, "zak:143/2001": 2001, "zak:139/2002": 2002, "zak:30/2024": 2024,
};
const inForce = (act: string) => IN_FORCE[act] ?? actYear(act);

function recodified(act: string, matched: string, year: number | null): string {
  if (year === null) return act;
  for (const r of RECODIFIED) if (r.act === act && year < r.until && r.text.test(matched)) return r.old;
  return act;
}

/** "zákon(a|u|em…) o", "vyhlášky … o", "nařízení vlády … o" — the start of a name the registry may know. */
const NAME_HEAD = /(?<![\p{L}])(ústavní(?:ho|m)?\s+zákon\p{L}*|zákon\p{L}*|zák\.|vyhlášk\p{L}*|vyhláš\p{L}*|nařízení\s+vlády)\s+o\s+/giu;

/** "směrnice 2008/48", "směrnice Evropského parlamentu a Rady 2008/48": year/number with no "/ES". */
const EU_SHORT_DIRECTIVE_RE = /(?<![\p{L}])směrnic\p{L}*(?:\s+(?:Evropského|parlamentu|a|Rady|Komise))*\s+(?:č\.\s*)?(\d{4})\s*\/\s*(\d{1,4})(?![\p{N}\/])/giu;

/** "z.č. 89/2012, Sb.", "zákona číslo 111/1994", "z. č. 145/2010": numbers the shared pattern misses. */
const LOOSE_NUMBER_RE = /(?<![\p{L}])(?:z\.\s?č\.|zák\.\s?č\.|zákon\p{L}*\s+číslo)\s*(\d{1,4})\s*\/\s*(\d{4})(?![\p{N}])/gu;

/** "zákona č. 168/99 Sb.", "vyhl. č. 177/96 Sb.": a two-digit year, only with "Sb." right after. */
const SHORT_YEAR_RE = /(?<![\p{L}\p{N}/])(\d{1,4})\s*\/\s*(\d{2})\s*Sb\.(?!\s*m\.\s*s\.)/gu;

/** "Sb. m. s." treaties: "č. 12/2005 Sb. m. s." */
const SMS_RE = /(?<![\p{L}\p{N}/])(\d{1,4})\s*\/\s*(\d{4})\s*Sb\.\s*m\.\s*s\./gu;

/**
 * A defined name in any case: words of letters lose their ending ("daňový řád" → "daňov… řád…"),
 * abbreviations and words in capitals stay as written ("o. s. ř.", "DPH", "OdpŠk").
 */
function declined(alias: string): string {
  if (/\./u.test(alias) || !/\s/u.test(alias)) return escapeAlias(alias);
  return alias
    .trim()
    .split(/\s+/u)
    .map((w) => (/^\p{Ll}{4,}$/u.test(w) ? `${w.slice(0, Math.max(3, w.length - 2))}\\p{L}{0,4}` : w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("\\s+");
}

function escapeAlias(alias: string): string {
  return alias
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\.\s*/g, "\\.\\s?")
    .replace(/\s+/g, "\\s+");
}

/** Every act mention of `t` (normalized spaces), longest first on a tie of start. */
export function findActMentions(t: string, lookup: ActLookup | null, year: number | null): ActMention[] {
  const out: ActMention[] = [];
  for (const m of t.matchAll(ACT_NUMBER_RE)) {
    const [n, y] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    out.push({ start: m.index, end: m.index + m[0].length, act: zakId(n, y), numbered: true });
  }
  for (const m of t.matchAll(EU_SHORT_DIRECTIVE_RE)) {
    const y = Number(m[1]);
    if (y >= 1958 && y <= 2014) out.push({ start: m.index, end: m.index + m[0].length, act: `eu:3${y}L${m[2].padStart(4, "0")}`, numbered: true });
  }
  for (const m of t.matchAll(LOOSE_NUMBER_RE)) out.push({ start: m.index, end: m.index + m[0].length, act: zakId(m[1], m[2]), numbered: true });
  for (const m of t.matchAll(SHORT_YEAR_RE)) {
    const yy = Number(m[2]);
    out.push({ start: m.index, end: m.index + m[0].length, act: zakId(m[1], String(yy >= 45 ? 1900 + yy : 2000 + yy)), numbered: true });
  }
  for (const m of t.matchAll(SMS_RE)) out.push({ start: m.index, end: m.index + m[0].length, act: `sm:${Number(m[1])}/${m[2]}` });
  for (const m of t.matchAll(EU_ACT_RE)) {
    // "2002/190/ES": the three-part form puts the year first (a four-digit one included).
    const id = m[3] !== undefined ? euActId(m[1], m[3], m[4]) : m[5].length === 4 ? euActId(m[1], m[6], m[5]) : euActId(m[1], m[5], m[6]);
    if (id) out.push({ start: m.index, end: m.index + m[0].length, act: id });
  }
  for (const entry of ACT_ABBREVIATIONS) {
    const re = new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`);
    for (const m of t.matchAll(re)) {
      const alts = pairOf(entry.act, m[0]);
      out.push({ start: m.index, end: m.index + m[0].length, act: recodified(entry.act, m[0], year), ...(alts ? { alts } : {}) });
    }
  }
  for (const { pattern, act, before } of NAMED_SOURCES) {
    const then = (year !== null && before?.find(([until]) => year < until)?.[1]) || act;
    for (const m of t.matchAll(pattern)) {
      const id = then.endsWith("-p") ? `${then}${m[1]}` : recodified(then, m[0], year);
      const alts = before?.length ? [act, ...before.map(([, old]) => old)] : pairOf(act, m[0]);
      out.push({ start: m.index, end: m.index + m[0].length, act: id, ...(alts ? { alts } : {}) });
    }
  }
  if (lookup) {
    for (const m of t.matchAll(NAME_HEAD)) {
      const head = m[1].toLowerCase();
      const kind = head.startsWith("ústavní") ? "ústavní zákon" : head.startsWith("zák") ? "zákon" : head.startsWith("vyhláš") ? "vyhláška" : "nařízení vlády";
      const wordsStart = m.index + m[0].length;
      const hit = lookup.byName(kind, t.slice(wordsStart, wordsStart + 160), year);
      if (hit) out.push({ start: m.index, end: wordsStart + hit.length, act: hit.act, ...(hit.alts ? { alts: hit.alts, byYear: true as const } : {}) });
    }
    for (const [alias, act] of lookup.aliases(year)) {
      for (const m of t.matchAll(new RegExp(`${B}${escapeAlias(alias)}${E}`, "gu"))) out.push({ start: m.index, end: m.index + m[0].length, act });
    }
  }
  return dedupeMentions(out);
}

/** Overlapping mentions: the one starting first, the longest on a tie, wins. */
function dedupeMentions(mentions: ActMention[]): ActMention[] {
  // On the same span, a registry name that knows every act sharing it beats the act table's one.
  const sorted = mentions.sort((a, b) => a.start - b.start || b.end - a.end || Number(Boolean(b.alts)) - Number(Boolean(a.alts)));
  const kept: ActMention[] = [];
  for (const m of sorted) {
    const last = kept.at(-1);
    if (last && m.start < last.end) {
      // "trestního zákona č. 140/1961 Sb.": the name and "zákona č. 140/1961" overlap — the number tells the act.
      if (m.numbered && !last.numbered) {
        kept[kept.length - 1] = { ...last, act: m.act, end: Math.max(last.end, m.end), numbered: true, alts: undefined };
      }
      continue;
    }
    kept.push(m);
  }
  return kept;
}

const DEFINITION_RE =
  /\(\s*dále\s+(?:jen|též|také|i)?\s*(?:jako\s+)?(?:[„"“]([^”"“„]{1,40})[”"“]\s*(?:nebo\s+[„"“]([^”"“„]{1,40})[”"“]\s*)?|(\p{L}[\p{L}.]*(?:\s+[\p{L}.]+){0,3}?)\s*)\)/gu;
/** How far before "(dále jen" the defined act may be named. */
const DEFINITION_REACH = 300;

export interface Definition {
  alias: string;
  act: string;
  at: number;
}

/** A mention inside "ve znění zákona č. …", "novelizovaného zákonem …": an amendment, not the act cited. */
function isAmendment(t: string, x: ActMention): boolean {
  return /(?:ve\s+znění|novel\p{L}*|změn\p{L}*|doplněn\p{L}*)[\s\p{L},.]{0,25}$/iu.test(t.slice(Math.max(0, x.start - 40), x.start));
}

/** Acts an alias already means globally ("o. s. ř.", "obč. zák." — with the act it replaced). */
const KNOWN = new Map<string, Set<string>>();
// The act table's names and abbreviations, and this module's own (NAMED_SOURCES).
const ABBREVIATION_RES = [
  ...ACT_ABBREVIATIONS.map((entry) => ({ entry: { act: entry.act }, re: new RegExp(entry.pattern.source, entry.pattern.flags.replace("g", "")) })),
  ...NAMED_SOURCES.map(({ pattern, act }) => ({ entry: { act }, re: new RegExp(pattern.source, pattern.flags.replace("g", "")) })),
];

function knownActs(alias: string): Set<string> {
  const cached = KNOWN.get(alias);
  if (cached) return cached;
  const acts = new Set<string>();
  KNOWN.set(alias, acts);
  for (const { entry, re } of ABBREVIATION_RES) {
    const m = re.exec(alias);
    if (m && m.index === 0 && m[0].length === alias.length) {
      acts.add(entry.act);
      for (const r of RECODIFIED) if (r.act === entry.act) acts.add(r.old);
    }
  }
  return acts;
}

/**
 * "(dále jen „X“)" definitions bound to the main act of their clause: the
 * last act mention in the reach before it that is not an amendment ("ve
 * znění zákona č. …"), after the previous definition. An alias with a
 * global meaning ("o. s. ř.") binds only to that act — when the clause
 * names another, the definition is a slip and the global meaning stands. Pure.
 */
export function findDefinitions(t: string, mentions: ActMention[]): Definition[] {
  const defs: Definition[] = [];
  let floor = 0;
  for (const m of t.matchAll(DEFINITION_RE)) {
    const from = Math.max(floor, m.index - DEFINITION_REACH);
    const inReach = mentions.filter((x) => x.start >= from && x.end <= m.index);
    const amendment = (x: ActMention) => isAmendment(t, x);
    floor = m.index + m[0].length;
    for (const alias of [m[1], m[2], m[3]]) {
      const a = alias?.trim();
      if (!a) continue;
      // Unquoted, only an act-like alias: "(dále jen zákon)", "(dále jen Úmluva)", "(dále jen o.s.ř.)" — not "(dále jen žalovaný)".
      if (alias === m[3] && !/^(?:zákon\p{L}*(?:\s+o\s+.+)?|\p{Lu}.*|(?:\p{L}{1,4}\.\s?)+)$/u.test(a)) continue;
      const known = knownActs(a);
      const last = [...inReach].reverse();
      const own = last.find((x) => !amendment(x)) ?? last[0];
      // A dotted abbreviation ("o. s. ř.") defined for another act is a slip; a name ("daňový řád" for 337/1992 in 2009) is not.
      const strict = /^(?:\p{L}{1,5}\.\s?){2,}\p{L}{0,5}\.?$/u.test(a) || !/\s/u.test(a);
      // Of the acts the alias may mean, the one named by number ("zákona č. 140/1961 Sb., trestního zákona (dále jen „tr. zák.“)").
      const main = known.size
        ? (last.find((x) => known.has(x.act) && x.numbered) ?? last.find((x) => known.has(x.act)) ?? (strict ? undefined : own))
        : own;
      if (main) defs.push({ alias: a, act: main.act, at: m.index + m[0].length });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Provision references.

interface Ref {
  head: string; // "par" | "cl"
  n: string;
  sub: string[][]; // each: path segments below the § / článek (["o1"], ["o1","pb"] …)
}

// A § letter sticks to its number ("§ 243c"): "§ 2910 a 2913" is two paragraphs, not "2910a".
// OCR reads 1 as "l" ("§ l42 odst. l"): a leading l before digits is a 1.
const NUM = /(l?\d{1,4})(?:([a-z]{1,2})|\s([a-z])(?=\s+odst))?(?![\p{L}\p{N}])|([IVXLC]{1,6})(?![\p{L}\p{N}])\.?/uy;
const roman = (s: string) => s.toLowerCase();

function lettersBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let c = a.charCodeAt(0); c <= b.charCodeAt(0) && out.length < 26; c++) out.push(String.fromCharCode(c));
  return out;
}

function numbersBetween(a: number, b: number, cap = 30): string[] {
  if (b < a || b - a > cap) return [String(a), String(b)];
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
}

/**
 * Sub-levels after one § / článek number at `pos`: odstavce, then písmena,
 * then body, each a list or range. Returns the paths (each a list of
 * segments) and the end position. Pure.
 */
function parseSubLevels(t: string, pos: number): { paths: string[][]; end: number } {
  // Groups in a row, each from its odstavec: "odst. 1 písm. e), odst. 2".
  const NEXT_GROUP = /\s*(?:in\s+fine\s*)?,?\s*(?:a|i|až|nebo|či|resp\.|respektive)?\s*(?=odst\.\s*(?:\d|[lI](?![\p{L}\p{N}])))/uy;
  let { paths, end } = parseGroup(t, pos);
  for (;;) {
    NEXT_GROUP.lastIndex = end;
    if (!NEXT_GROUP.test(t)) break;
    const next = parseGroup(t, NEXT_GROUP.lastIndex);
    if (!next.paths.length) break;
    paths = [...paths, ...next.paths];
    end = next.end;
  }
  return { paths, end };
}

function parseGroup(t: string, pos: number): { paths: string[][]; end: number } {
  const LIST_SEP = /\s*(?:,|a|i|ani|nebo|či|resp\.)\s*/uy;
  const RANGE = /\s*(?:až|[-‐‑–])\s*/uy;
  const take = (re: RegExp, at: number) => {
    re.lastIndex = at;
    const m = re.exec(t);
    return m ? { m, end: re.lastIndex } : null;
  };
  let end = pos;
  let odst: string[] = [];
  let pism: string[] = [];
  let bod: string[] = [];
  const o =
    take(/\s*,?\s*(?:odst\.|odstav\p{L}*)\s*\(?(\d{1,3}|[lI](?![\p{L}\p{N}]))\)?/uy, end) ??
    // "§ 1811/2 a 1820/1": the odstavec after a slash (one or two digits — never a year).
    take(/\/(\d{1,2})(?![\p{N}\/])/uy, end);
  if (o) {
    odst = [/^[lI]$/.test(o.m[1]) ? "1" : o.m[1]];
    end = o.end;
    for (;;) {
      const r = take(RANGE, end);
      const rn = r ? take(/(\d{1,3})(?!\p{N}|\.\s*\d|\s*[§/])/uy, r.end) : null;
      if (r && rn) {
        odst = [...odst.slice(0, -1), ...numbersBetween(Number(odst.at(-1)), Number(rn.m[1]), 20)];
        end = rn.end;
        continue;
      }
      const s = take(LIST_SEP, end);
      const sn = s ? take(/(\d{1,3})(?!\p{N}|\.\s*\d|\s*[§/])/uy, s.end) : null; // a repeated "odst." starts a new group
      if (s && sn) {
        odst.push(sn.m[1]);
        end = sn.end;
        continue;
      }
      break;
    }
  }
  // "čl. 17 odst. 3 pododst. 2" (EU acts): the pododstavec is a level of its own.
  const sub = take(/\s*,?\s*(?:pododst\.|pododstav\p{L}*)\s*(\d{1,2})/uy, end);
  if (sub) end = sub.end;
  const p =
    take(/\s*,?\s*(?:písm(?:eno|ena|ene|en)?\.?|lit\.)\s*([a-z]{1,2})(?:[)/]|(?![\p{L}\p{N}]))/uy, end) ??
    // "odst. 1 a), d) AT": the letter alone, but only with its bracket, after an odstavec.
    (odst.length ? take(/\s*,?\s*([a-z])[)/]/uy, end) : null);
  if (p) {
    pism = [p.m[1]];
    end = p.end;
    for (;;) {
      const r = take(RANGE, end);
      const rn = r ? take(/([a-z])[)/]/uy, r.end) : null;
      if (r && rn) {
        pism = [...pism.slice(0, -1), ...lettersBetween(pism.at(-1)!, rn.m[1])];
        end = rn.end;
        continue;
      }
      const s = take(LIST_SEP, end);
      // "písm. a), b, c)": a letter of the list may lack its bracket.
      const sn = s ? take(/(?:písm\.\s*)?([a-z]{1,2})(?:[)/]|(?=\s*(?:,|a\s|nebo\s)\s*[a-z]\)))/uy, s.end) : null;
      if (s && sn) {
        pism.push(sn.m[1]);
        end = sn.end;
        continue;
      }
      break;
    }
  }
  const b = take(/\s*,?\s*bod(?:u|ů|y|em)?\.?\s*(\d{1,3})(?![\p{N}])\.?/uy, end);
  if (b) {
    bod = [b.m[1]];
    end = b.end;
    // "bodu 1 a 6", "bodů 1, 2 a 3": a list of body, not of paragraphs.
    for (;;) {
      const sb = take(/\s*(?:,|a|nebo)\s*(\d{1,3})(?![\p{N}]|\s*[§/])\.?(?!\s*(?:odst|písm))/uy, end);
      if (!sb) break;
      bod.push(sb.m[1]);
      end = sb.end;
    }
  }
  // "věty první", "věta druhá", "poslední věta", "věty za středníkem", "věta první před středníkem":
  // the sentence is a level, the part of it around the semicolon one more.
  let veta: string[] = [];
  const ORD = String.raw`prv\p{L}*|druh\p{L}*|třetí|čtvrt\p{L}*|pát\p{L}*|posledn\p{L}*`;
  const v = take(
    new RegExp(
      // "části první věty za středníkem" = of the first sentence, the part after the semicolon
      String.raw`\s*,?\s*(?:část\p{L}*\s+(?:(první)\s+(?=vět))?)?(?:vět(?:a|y|ou|u|ě)\s+(${ORD})|(${ORD})\s+vět\p{L}*)?(?:\s*,?\s*(?:část\p{L}*\s+)?(?:vět\p{L}*\s+)?(před|za)\s+středníkem)?,?`,
      "uy",
    ),
    end,
  );
  if (v && (v.m[1] || v.m[2] || v.m[3] || v.m[4])) {
    const w = (v.m[2] ?? v.m[3] ?? v.m[1] ?? "").toLowerCase();
    if (w) veta.push(w.startsWith("prv") ? "1" : w.startsWith("dru") ? "2" : w.startsWith("tř") ? "3" : w.startsWith("čtv") ? "4" : w.startsWith("pát") ? "5" : "posl");
    if (v.m[4]) veta.push(v.m[4] === "před" ? "pred" : "za");
    end = v.end;
  }
  const levels: string[][] = [];
  const ps = pism.length ? pism.map((x) => `p${x}`) : [null];
  const bs = bod.length ? bod.map((x) => `b${x}`) : [null];
  const vs = veta.map((x) => `v${x}`);
  // "odst. 1, 2 písm. h)": what follows a list of odstavce belongs to the last of them.
  const os = odst.map((x) => `o${x}`);
  for (const a of os.slice(0, -1)) levels.push([a]);
  const ss = sub ? `s${sub.m[1]}` : null;
  for (const c of ps) for (const d of bs) levels.push([os.at(-1) ?? null, ss, c, d, ...vs].filter((x): x is string => x !== null));
  return { paths: levels.filter((l) => l.length > 0), end };
}

const HEAD_RE = /(§§?|(?<![\p{L}])(?:čl\.|[čČ]lán(?:ek|ku|kem|ky|ků|cích)))(?:\s*[.-](?=\d))?\s*(?=l?[\dIVXLC])/gu;

/** Every § / článek reference with its sub-levels and its span. Pure. */
/**
 * The "§" the stored text lost (review of decisions without references, 27. 10.): NS "dovolací řízení podle
 * 243b odst. 5 věty druhé o. s. ř." (some 3,500 NS decisions), old NALUS texts with "š 43 odst. 1" or
 * "ustanovení 5 72 odst. 2" for "§". Only where nothing else can be meant: after "podle / dle / ustanovení /
 * ust." and before "odst. N" — or after "š", which is no Czech word.
 */
const LOST_PAR_RE =
  /(?<!§\s?)(?:(?<=(?:ustanovení|ust\.|podle|dle)\s+)(?:5\s+)?(?=\d{1,4}[a-z]{0,2}\s+odst\.\s*\d)|(?<![\p{L}\p{N}])š\s+(?=\d{1,4}[a-z]{0,2}(?![\p{L}\p{N}])))/gu;

function parseRefs(t: string): Array<{ refs: Ref[]; start: number; end: number; lost?: true }> {
  const out: Array<{ refs: Ref[]; start: number; end: number; lost?: true }> = [];
  let lastEnd = 0;
  const heads = [
    ...[...t.matchAll(HEAD_RE)].map((m) => ({ index: m.index, end: m.index + m[0].length, par: m[1].startsWith("§") })),
    ...[...t.matchAll(LOST_PAR_RE)].map((m) => ({ index: m.index, end: m.index + m[0].length, par: true, lost: true as const })),
  ].sort((a, b) => a.index - b.index);
  for (const m of heads) {
    // A head inside the previous span ("čl. 7, čl. 10 a čl. 13") is already read.
    if (m.index < lastEnd) continue;
    let head = m.par ? "par" : "cl";
    const refs: Ref[] = [];
    let pos = m.end;
    let prev: Ref | null = null;
    let range = false; // the separator before this number was "až" / a dash
    for (;;) {
      NUM.lastIndex = pos;
      const n = NUM.exec(t);
      if (!n) break;
      if (n[4] && head === "par") break; // roman numerals only for články
      const id = n[1] ? String(Number(n[1].replace(/^l/, "1"))) + (n[2] ?? n[3] ?? "") : roman(n[4]);
      pos = NUM.lastIndex;
      const sub = parseSubLevels(t, pos);
      pos = sub.end;
      const ref: Ref = { head, n: id, sub: sub.paths };
      // "§§ 2910 až 2913": the paragraphs between join (up to 30).
      if (prev && range && /^\d+$/.test(prev.n) && /^\d+$/.test(id)) {
        for (const k of numbersBetween(Number(prev.n), Number(id)).slice(1, -1)) refs.push({ head, n: k, sub: [] });
      }
      refs.push(ref);
      prev = ref;
      const sep = /\s*(,\s*(?:a|nebo|či)?|a|až|nebo|či|resp\.|[-‐‑–])\s*(§|čl\.\s*)?(?=\d|[IVXLC]{1,6}(?![\p{L}]))/uy;
      sep.lastIndex = pos;
      const s = sep.exec(t);
      if (!s) break;
      if (s[2]) head = s[2].startsWith("§") ? "par" : "cl";
      range = /až|[-‐‑–]/u.test(s[1]);
      pos = sep.lastIndex;
    }
    if (refs.length) {
      out.push({ refs, start: m.index, end: pos, ...("lost" in m ? { lost: true as const } : {}) });
      lastEnd = pos;
    }
  }
  return out;
}

const BACK_REF =
  /^\s*,?\s*(?:téhož|téže|tého\p{L}*|stejn\p{L}*|příslušn\p{L}*|citovan\p{L}*|cit\.?|uveden\p{L}*|výše\s+uveden\p{L}*|shora\s+uveden\p{L}*|tohoto|této|daného|předmětn\p{L}*|posledně\s+citovan\p{L}*)\s+(?:(?:trestní|občansk|obchodní|správní|daňov)\p{L}*\s+)?(norm\p{L}*|zák\.|vyhl\.|zákon\p{L}*|předpis\p{L}*|řád\p{L}*|nařízení|směrnic\p{L}*|vyhlášk\p{L}*|tarif\p{L}*|úmluv\p{L}*|směrnic\p{L}*|listin\p{L}*|zákoník\p{L}*)/iu;
/** "§ 13 odst. 3 vyhlášky v částce", "článku 2 bodu 10 nařízení,": the kind word alone, with no number of its own, points back. */
const BARE_KIND = /^\s*,?\s*(vyhlášk\p{L}*|vyhl\.|nařízení)(?!\s+(?:\p{L}+\s+){0,6}?č\.|\s*\()(?![\p{L}])/iu;

/** The kind a back reference names: "téhož zákona" a zákon, "uvedené vyhlášky" a vyhláška; others any. */
function kindOf(noun: string): string | null {
  const n = noun.toLowerCase();
  return n.startsWith("vyhl")
    ? "vyhláška"
    : n.startsWith("nařízení")
      ? "nařízení"
      : n.startsWith("směrnic")
        ? "směrnice"
        : /^(?:zák|řád)/u.test(n)
          ? "zákon"
          : null;
}

const VYHLASKY = new Set(["zak:177/1996", "zak:196/2001", "zak:330/2001"]);

/** The kind of act a mention is, from its words and those just before it ("vyhlášky č. 177/1996 Sb."). */
function mentionKind(t: string, x: ActMention): string {
  const eu = /^eu:3\d{4}([RLD])/.exec(x.act)?.[1];
  if (eu) return eu === "R" ? "nařízení" : eu === "L" ? "směrnice" : "rozhodnutí";
  const before = t.slice(Math.max(0, x.start - 70), x.start);
  const own = t.slice(x.start, x.end);
  if (VYHLASKY.has(x.act) || /vyhl/iu.test(own) || /vyhl(?:\.|ášk\p{L}*)(?:\s+[\p{L},]+){0,6}?\s*(?:č\.\s*)?$/iu.test(before)) return "vyhláška";
  if (/nařízení/iu.test(own) || /nařízení\p{L}*(?:\s+[\p{L},()]+){0,6}?\s*(?:č\.\s*)?$/iu.test(before)) return "nařízení";
  if (/(?:nález\p{L}*|sdělení)(?:\s+[\p{L},.\d]+){0,10}?\s*(?:pod\s+)?(?:č\.\s*)?$/iu.test(before)) return "jiné";
  return "zákon";
}

/**
 * Words that may stand between a reference and its act: none ("§ 2913 zákona
 * č. …" — the mention starts with "zákona"), "a násl.", or the kind word
 * before a bare number ("§ 8 vyhlášky č. 177/1996 Sb."). "§ 2913, ve znění
 * …" is not an act.
 */
const KIND_BEFORE_NUMBER = String.raw`(?:vyhlášk\p{L}*|vyhl\.|vládní\p{L}*\s+nařízení|nařízení\p{L}*(?:\s+vlády)?|nař\.\s*vl\.|vl\.\s*nař\.|NV|zákonn\p{L}*\s+opatření|sdělení|usnesení|ústavní\p{L}*\s+zákon\p{L}*)`;
const GAP = new RegExp(
  String.raw`^,?\s*` +
    // "věty první a druhé, o. s. ř.", "§ 237 odst. 3 in fine o. s. ř."
    String.raw`(?:(?:,|a)?\s*(?:(?:vět\p{L}*\s+)?(?:druh|třet|posledn)\p{L}*|(?:prv|druh|třet|posledn)\p{L}*\s+vět\p{L}*)\s*,?\s*)?` +
    String.raw`(?:(?:in\s+fine|a\s+contrario|a\s+contr\.)\s*,?\s*)?` +
    String.raw`["“”]?\s*(?:\([^()]{0,40}\)\s*)?` +
    String.raw`(?:a\s+(?:násl(?:ed)?\.?|následující\p{L}*)\s*,?\s*)?` +
    String.raw`(?:(?:tehdy|v\s+té\s+době)\s+)?(?:platn\p{L}*|účinn\p{L}*|star\p{L}*|původní\p{L}*|dříve\s+platn\p{L}*)?\s*` +
    // "článku II, části první, přechodných ustanovení zákona č. 404/2012 Sb."
    String.raw`(?:část\p{L}*\s+\p{L}+\s*,?\s*)?(?:přechodn\p{L}*\s+ustanovení\s+)?` +
    // The kind word before a bare number, with the issuer between: "vyhlášky Ministerstva financí České republiky č.",
    // "zákona ČNR č." — never across an amendment ("zákona, který byl změněn zákonem č.").
    String.raw`(?:(?:${KIND_BEFORE_NUMBER}|zákon\p{L}*|zák\.)(?:\s+(?!ve\s|znění|změn|novel|kter|jímž|jenž|vyhl|nařízen)[\p{L},]+){0,6}?\s*(?:č\.|číslo)\s*|${KIND_BEFORE_NUMBER}\s+|(?:v\s+)?(?:zákon\p{L}*|zák\.|z\.|úst\.\s?zák\.)\s*(?:č\.|číslo)?\s*|(?:č\.|číslo)\s*)?` +
    String.raw`[\s,]{0,3}$`,
  "iu",
);
const TRAILING_SENTENCE = /^\s*,?\s*vět(?:a|y|ou|ě)\s+(prv\p{L}*|druh\p{L}*|třetí|čtvrt\p{L}*|pát\p{L}*|posledn\p{L}*)/iu;
function sentenceNumber(word: string): string {
  const w = word.toLowerCase();
  return w.startsWith("prv") ? "1" : w.startsWith("dru") ? "2" : w.startsWith("tř") ? "3" : w.startsWith("čtv") ? "4" : w.startsWith("pát") ? "5" : "posl";
}

/** Acts with články only: a "§" of theirs is a slip for "čl.". */
const ARTICLE_ONLY = new Set(["zak:1/1993", "zak:2/1993", "zak:209/1992", "zak:209/1992-p1", "zak:104/1991", "zak:120/1976", "zak:208/1993"]);
/** Acts whose units are články: EU acts, treaties, the constitutional acts. */
function articleBased(act: string): boolean {
  return act.startsWith("eu:") || act.startsWith("sm:") || act.startsWith("zak:209/1992-p") || ARTICLE_ONLY.has(act);
}
/** "čl. 23 spisu" (a page of the court file), "§ 1 až 654. Komentář" (a book title): not citations. */
const NOT_A_CITATION = /^[\s.,)\/–-]*(?:(?:soudního\s+|trestního\s+|správního\s+|tr\.\s*)?spisu|spis(?![\p{L}])|civilní\s+věci|čj\.|č\.\s*j\.|[Kk]omentář|\[?Systém\s+ASPI)/u;

/**
 * What joins references that share the act named after the last of them:
 * "§ 107 a § 361 tr. zák.", "§ 8 odst. 1 ve spojení s § 7 vyhlášky …".
 */
const CHAIN =
  /^(?:\s*(?:,|;|a|i|až|nebo|či|resp\.|respektive|popř\.|případně|též|také|ve\s+spojení\s+s|ve\s+spoj\.\s+s|v\s+návaznosti\s+na|a\s+násl(?:ed)?\.|násl\.|a\s+contrario|a\s+contr\.|za\s+použití|za\s+užití|v\s+souladu\s+s|spojení|s|se|k|dle|podle|[-–]|\([^()]{0,40}\)|(?:druh|třet|čtvrt|posledn)\p{L}*|ani|ustanovení\p{L}*|ust\.|čl\.|článk\p{L}*|článek|dále|na|v|ve))*\s*$/u;

/**
 * The provisions `text` cites, with acts resolved (see the header).
 * `year` (of the decision) picks among acts sharing a name or alias. Pure.
 */
export function extractProvisions(text: string, lookup: ActLookup | null = null, year: number | null = null): ProvisionMention[] {
  const t = text.replace(ODD_SPACES, " ");
  const base = findActMentions(t, lookup, year);
  const defs = findDefinitions(t, base);
  // A defined alias is a mention of its act from its definition on; it beats any global meaning.
  const defined: ActMention[] = [];
  for (const d of defs) {
    // A bare "zákon" never takes "zákona č. 500/2004 Sb." — a number names its own act.
    const alias = /^[zZ]ákon(?:a|u|em|e|ě)?$/u.test(d.alias)
      ? `${d.alias[0]}${ZAKON.slice(1)}(?!\\s+(?:č\\.|číslo|ČNR|České|\\d))`
      : `${declined(d.alias)}${E}`;
    for (const m of t.slice(d.at).matchAll(new RegExp(`${B}${alias}`, "gu"))) {
      defined.push({ start: d.at + m.index, end: d.at + m.index + m[0].length, act: d.act, defined: true });
    }
  }
  // A defined alias beats any global meaning of the same words — but never an act number the decision writes.
  const numbers = base.filter((x) => x.numbered);
  const kept = defined.filter((d) => !numbers.some((x) => d.start < x.end && x.start < d.end));
  const definedSpans = kept.map((x) => [x.start, x.end] as const);
  const mentions = dedupeMentions([
    ...kept,
    ...base.filter((x) => x.numbered || !definedSpans.some(([s, e]) => x.start < e && s < x.end)),
  ]);

  // "zákoníku práce č. 65/1965 Sb.": a name right before its number is that number.
  for (const [k, m] of mentions.entries()) {
    const next = mentions[k + 1];
    if (!m.numbered && next?.numbered && /^\s*,?\s*(?:č\.|číslo)?\s*$/u.test(t.slice(m.end, next.start))) {
      m.act = next.act;
      m.alts = undefined;
    }
  }
  // A name several acts may bear — old and new code ("obč. zák."), predecessors ("stavební zákon"), a shared title
  // ("zákon o obcích") — means what the decision itself says (decided 27. 10.): the act of them it names by number
  // (the last before, else the first after); else the implementing decree it cites with it; "starého", "dříve
  // platného", "účinném do" the oldest. Without any of that the year decides only when one of them alone was in
  // force by then — otherwise the reference stays without an act.
  for (const m of mentions) {
    if (!m.alts || m.numbered || m.defined) continue;
    const cand = m.alts;
    const isCand = (x: ActMention) => Boolean(x.numbered) && cand.includes(x.act);
    const named = [...mentions].reverse().find((x) => isCand(x) && x.start < m.start) ?? mentions.find((x) => isCand(x) && x.start > m.end);
    if (named) {
      m.act = named.act;
      continue;
    }
    const decree = mentions.find((x) => x.numbered && PAIR_HINTS[x.act] && cand.includes(PAIR_HINTS[x.act]));
    if (decree) {
      m.act = PAIR_HINTS[decree.act];
      continue;
    }
    const oldest = [...cand].sort((a, b) => inForce(a) - inForce(b))[0];
    const text = t.slice(m.start, m.end);
    // "obč. zák." beside "o. z." in one decision: the two codes, "obč. zák." the old one.
    const twoCodes = /^obč\.\s?zák/u.test(text) && mentions.some((x) => x.act === "zak:89/2012" && /^o\.\s?z/u.test(t.slice(x.start, x.end)));
    if (twoCodes || OLD_HINT.test(t.slice(Math.max(0, m.start - 15), m.start)) || OLD_AFTER.test(t.slice(m.end, m.end + 40))) {
      m.act = oldest;
      continue;
    }
    if (m.byYear) continue;
    const then = year === null ? cand : cand.filter((a) => inForce(a) <= year);
    m.act = then.length === 1 ? then[0] : "";
  }
  const spans = parseRefs(t).filter(
    (span) => !NOT_A_CITATION.test(t.slice(span.end, span.end + 30)) && !/komentář\p{L}*\s+k\s*$/iu.test(t.slice(Math.max(0, span.start - 20), span.start)),
  );
  const headOf = (i: number) => spans[i].refs[0].head;
  // A článek takes an act from a § only when that act has články (EU, treaties, Ústava, Listina).
  const fits = (i: number, from: number, act: string) => headOf(i) === headOf(from) || headOf(i) === "par" || articleBased(act);
  // Where each reference's own act mention ends (it stands between that reference and the next one).
  const namedUntil = spans.map((span) => span.end);
  const via: ProvisionMention["via"][] = spans.map(() => "");
  const acts = spans.map((span, i) => {
    const after = mentions.find((x) => x.start >= span.end && GAP.test(t.slice(span.end, x.start)));
    if (after) {
      namedUntil[i] = after.end;
      via[i] = "after";
      return after.act;
    }
    const back = BACK_REF.exec(t.slice(span.end, span.end + 60)) ?? BARE_KIND.exec(t.slice(span.end, span.end + 40));
    if (back) {
      const want = kindOf(back[1]);
      via[i] = "back";
      const par = span.refs[0].head === "par";
      return [...mentions].reverse().find((x) => x.end <= span.start && !isAmendment(t, x) && !(par && ARTICLE_ONLY.has(x.act)) && (!want || mentionKind(t, x) === want))?.act ?? "";
    }
    return "";
  });
  // Back to front: an unresolved reference joined to the next one takes its act.
  for (let i = spans.length - 2; i >= 0; i--) {
    // A reference whose own act name was left open (several acts, no number) stays open.
    if (!acts[i] && via[i] !== "after" && acts[i + 1] && fits(i, i + 1, acts[i + 1]) && CHAIN.test(t.slice(spans[i].end, spans[i + 1].start))) {
      acts[i] = acts[i + 1];
      via[i] = "chain";
    }
  }
  const out: ProvisionMention[] = [];
  for (const [i, span] of spans.entries()) {
    // A "§" the text lost counts only with its act: "podle 2 odst. 1 smlouvy" is a contract's clause.
    if (span.lost && !acts[i]) continue;
    // "§ 2664 o. z. věty prvé": the sentence written after the act belongs to the (last) reference.
    if (via[i] === "after") {
      const v = TRAILING_SENTENCE.exec(t.slice(namedUntil[i], namedUntil[i] + 40));
      const last = span.refs.at(-1)!;
      if (v) {
        const level = `v${sentenceNumber(v[1])}`;
        last.sub = last.sub.length ? last.sub.map((path) => [...path, level]) : [[level]];
      }
    }
    for (const ref of span.refs) {
      // The act number the decision writes is the basis and stays, even "§ 37e zák. č. 297/2009 Sb." (an amending act):
      // the registry only checks it (decided 27. 10.).
      const act = acts[i];
      // "§ 89 odst. 2 Ústavy": these acts have články only.
      const head = ref.head === "par" && act && via[i] === "after" && ARTICLE_ONLY.has(act) ? "cl" : ref.head;
      const top = `${head}:${ref.n}`;
      const keys = new Set<string>([top]);
      for (const path of ref.sub) for (let k = 1; k <= path.length; k++) keys.add(`${top}/${path.slice(0, k).join("/")}`);
      // The label: the first path in full ("odst. 2, odst. 4 písm. a)" → o2); `keys` holds them all.
      const provision = ref.sub[0]?.length ? `${top}/${ref.sub[0].join("/")}` : top;
      out.push({ act, provision, keys: [...keys], start: span.start, end: span.end, via: act ? via[i] : "" });
    }
  }
  return out;
}

export interface ProvisionRow {
  act: string;
  provision: string;
  mentions: number;
  firstAt: number;
}

/** Mentions → one row per (act, key) with how often and where first. Pure. */
export function aggregateProvisions(mentions: ProvisionMention[]): ProvisionRow[] {
  const rows = new Map<string, ProvisionRow>();
  for (const m of mentions) {
    for (const key of m.keys) {
      const id = `${m.act}\u0000${key}`;
      const row = rows.get(id);
      if (row) {
        row.mentions++;
        row.firstAt = Math.min(row.firstAt, m.start);
      } else rows.set(id, { act: m.act, provision: key, mentions: 1, firstAt: m.start });
    }
  }
  return [...rows.values()];
}
