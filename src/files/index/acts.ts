/**
 * Czech (and a few EU) act names and abbreviations → a canonical act id:
 * "zak:<n>/<yyyy>" for the Sbírka zákonů, "eu:<CELEX>" for EU regulations.
 * The same ids are what documents.commented_act holds (see the CHECK in
 * 0001_init.sql), so "§ 2913 OZ" in a query can filter to commentaries on
 * the civil code, and "§ 2913 o. z." in a text yields the compound key
 * parz:89/2012/2913.
 *
 * Both citation conventions are covered: C. H. Beck ("o. z.", "o. s. ř.",
 * "z. o. k.", "s. ř. s.", "tr. zák.") and Wolters Kluwer ("OZ", "OSŘ",
 * "ZOK", "SŘS", "TZ"), plus the older "ObčZ"/"NOZ" and full names in any
 * case form ("zákoníku práce", "občanského soudního řádu").
 *
 * Abbreviations are matched case-sensitively and never inside a word: "AZ"
 * is the copyright act, "az" is nothing. A bare "občanský zákoník" means the
 * current code (89/2012) — the 1964 code is cited by number.
 *
 * Pure — unit-tested (tests/files-identifiers.test.ts).
 */

export interface ActEntry {
  pattern: RegExp;
  act: string;
  name: string;
  /** An abbreviation ("OZ", "o. z."), not a name — it carries no search words. */
  abbreviation: boolean;
}

// Word boundaries that understand Czech letters (\b does not).
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Optional space between the parts of a dotted abbreviation ("o.z.", "o. z."). */
const S = "\\s?";

/** Case-sensitive abbreviation(s), each a whole word. */
function abbr(...forms: string[]): RegExp {
  return new RegExp(`${B}(?:${forms.join("|")})${E}`, "u");
}
/** Case-insensitive full name; `\\p{L}*` absorbs the case ending. */
function named(source: string): RegExp {
  return new RegExp(`${B}${source}${E}`, "iu");
}
const W = "\\p{L}*"; // case ending
const SP = "\\s+";

/**
 * Order matters only for names that contain other names: a more specific
 * entry must come before one that would match inside it (e.g. the EU Charter
 * before the Czech Listina). resolveAct takes the EARLIEST match in the text
 * and, at equal position, the longest.
 */
export const ACT_ABBREVIATIONS: ReadonlyArray<ActEntry> = [
  // Civil law
  { act: "zak:89/2012", name: "občanský zákoník", abbreviation: true, pattern: abbr(`o\\.${S}z\\.`, "OZ", "NOZ", "ObčZ", `obč\\.${S}zák\\.`) },
  { act: "zak:89/2012", name: "občanský zákoník", abbreviation: false, pattern: named(`občansk${W}${SP}zákoník${W}`) },
  { act: "zak:99/1963", name: "občanský soudní řád", abbreviation: true, pattern: abbr(`o\\.${S}s\\.${S}ř\\.`, "OSŘ") },
  { act: "zak:99/1963", name: "občanský soudní řád", abbreviation: false, pattern: named(`občansk${W}${SP}soudní${W}${SP}řád${W}`) },
  { act: "zak:292/2013", name: "zákon o zvláštních řízeních soudních", abbreviation: true, pattern: abbr(`z\\.${S}ř\\.${S}s\\.`, "ZŘS", "ZZŘS", "ZOSŘ") },
  { act: "zak:292/2013", name: "zákon o zvláštních řízeních soudních", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}zvláštních${SP}řízeních${SP}soudních`) },
  { act: "zak:90/2012", name: "zákon o obchodních korporacích", abbreviation: true, pattern: abbr(`z\\.${S}o\\.${S}k\\.`, "ZOK", "ZObchK") },
  { act: "zak:90/2012", name: "zákon o obchodních korporacích", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}obchodních${SP}korporacích`) },
  { act: "zak:513/1991", name: "obchodní zákoník", abbreviation: true, pattern: abbr(`obch\\.${S}zák\\.`, "ObchZ", "ObZ") },
  { act: "zak:513/1991", name: "obchodní zákoník", abbreviation: false, pattern: named(`obchodní${W}${SP}zákoník${W}`) },
  { act: "zak:91/2012", name: "zákon o mezinárodním právu soukromém", abbreviation: true, pattern: abbr("ZMPS") },
  { act: "zak:91/2012", name: "zákon o mezinárodním právu soukromém", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}mezinárodním${SP}právu${SP}soukromém`) },
  { act: "zak:304/2013", name: "zákon o veřejných rejstřících", abbreviation: true, pattern: abbr("ZVR", "ZVeřRej") },
  { act: "zak:304/2013", name: "zákon o veřejných rejstřících", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}veřejných${SP}rejstřících`) },
  { act: "zak:256/2013", name: "katastrální zákon", abbreviation: false, pattern: named(`katastrální${W}${SP}zákon${W}`) },
  { act: "zak:634/1992", name: "zákon o ochraně spotřebitele", abbreviation: true, pattern: abbr("ZOS", "ZOchS") },
  { act: "zak:634/1992", name: "zákon o ochraně spotřebitele", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}ochraně${SP}spotřebitele`) },
  { act: "zak:216/1994", name: "zákon o rozhodčím řízení", abbreviation: true, pattern: abbr("ZRŘ") },
  { act: "zak:216/1994", name: "zákon o rozhodčím řízení", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}rozhodčím${SP}řízení`) },
  { act: "zak:120/2001", name: "exekuční řád", abbreviation: true, pattern: abbr(`ex\\.${S}ř\\.`, "EŘ", "ExŘ") },
  { act: "zak:120/2001", name: "exekuční řád", abbreviation: false, pattern: named(`exekuční${W}${SP}řád${W}`) },
  { act: "zak:358/1992", name: "notářský řád", abbreviation: true, pattern: abbr(`not\\.${S}ř\\.`, "NotŘ") },
  { act: "zak:358/1992", name: "notářský řád", abbreviation: false, pattern: named(`notářsk${W}${SP}řád${W}`) },
  { act: "zak:182/2006", name: "insolvenční zákon", abbreviation: true, pattern: abbr(`ins\\.${S}z\\.`, `insolv\\.${S}zák\\.`, "InsZ", "IZ") },
  { act: "zak:182/2006", name: "insolvenční zákon", abbreviation: false, pattern: named(`insolvenční${W}${SP}zákon${W}`) },
  // Not "ZA": all-caps headings ("ODPOVĚDNOST ZA ŠKODU") would match it.
  { act: "zak:85/1996", name: "zákon o advokacii", abbreviation: true, pattern: abbr("ZAdv") },
  { act: "zak:85/1996", name: "zákon o advokacii", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}advokacii`) },
  { act: "zak:121/2000", name: "autorský zákon", abbreviation: true, pattern: abbr(`aut\\.${S}zák\\.`, "AZ", "AutZ") },
  { act: "zak:121/2000", name: "autorský zákon", abbreviation: false, pattern: named(`autorsk${W}${SP}zákon${W}`) },
  { act: "zak:6/2002", name: "zákon o soudech a soudcích", abbreviation: true, pattern: abbr("ZSS", "ZSaS") },
  { act: "zak:6/2002", name: "zákon o soudech a soudcích", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}soudech${SP}a${SP}soudcích`) },
  { act: "zak:257/2016", name: "zákon o spotřebitelském úvěru", abbreviation: true, pattern: abbr("ZSÚ", "ZSpÚ") },
  { act: "zak:257/2016", name: "zákon o spotřebitelském úvěru", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}spotřebitelském${SP}úvěru`) },
  { act: "zak:370/2017", name: "zákon o platebním styku", abbreviation: true, pattern: abbr("ZPS", "ZPlS") },
  { act: "zak:370/2017", name: "zákon o platebním styku", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}platebním${SP}styku`) },
  { act: "zak:256/2004", name: "zákon o podnikání na kapitálovém trhu", abbreviation: true, pattern: abbr("ZPKT") },
  { act: "zak:256/2004", name: "zákon o podnikání na kapitálovém trhu", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}podnikání${SP}na${SP}kapitálovém${SP}trhu`) },
  { act: "zak:21/1992", name: "zákon o bankách", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}bankách`) },
  // Labour and social law
  { act: "zak:262/2006", name: "zákoník práce", abbreviation: true, pattern: abbr(`zák\\.${S}práce`, `zák\\.${S}pr\\.`, "ZP", "ZPr") },
  { act: "zak:262/2006", name: "zákoník práce", abbreviation: false, pattern: named(`zákoník${W}${SP}práce`) },
  { act: "zak:435/2004", name: "zákon o zaměstnanosti", abbreviation: true, pattern: abbr("ZZam") },
  { act: "zak:435/2004", name: "zákon o zaměstnanosti", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}zaměstnanosti`) },
  { act: "zak:234/2014", name: "zákon o státní službě", abbreviation: true, pattern: abbr("ZSSl") },
  { act: "zak:234/2014", name: "zákon o státní službě", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}státní${SP}službě`) },
  { act: "zak:187/2006", name: "zákon o nemocenském pojištění", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}nemocenském${SP}pojištění`) },
  // Criminal law
  { act: "zak:40/2009", name: "trestní zákoník", abbreviation: true, pattern: abbr(`tr\\.${S}zák\\.`, `tr\\.${S}z\\.`, "TZ", "TrZ", "TZk") },
  { act: "zak:40/2009", name: "trestní zákoník", abbreviation: false, pattern: named(`trestní${W}${SP}zákoník${W}`) },
  { act: "zak:141/1961", name: "trestní řád", abbreviation: true, pattern: abbr(`tr\\.${S}ř\\.`, "TŘ", "TrŘ") },
  { act: "zak:141/1961", name: "trestní řád", abbreviation: false, pattern: named(`trestní${W}${SP}řád${W}`) },
  { act: "zak:418/2011", name: "zákon o trestní odpovědnosti právnických osob", abbreviation: true, pattern: abbr("TOPO", "ZTOPO") },
  { act: "zak:418/2011", name: "zákon o trestní odpovědnosti právnických osob", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}trestní${SP}odpovědnosti${SP}právnických${SP}osob`) },
  { act: "zak:45/2013", name: "zákon o obětech trestných činů", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}obětech${SP}trestných${SP}činů`) },
  { act: "zak:250/2016", name: "zákon o odpovědnosti za přestupky a řízení o nich", abbreviation: true, pattern: abbr("ZOP", "PřZ") },
  { act: "zak:250/2016", name: "zákon o odpovědnosti za přestupky a řízení o nich", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}odpovědnosti${SP}za${SP}přestupky`) },
  // Administrative and public law ("soudní řád správní" before "správní řád":
  // the latter never matches inside the former, the words are reversed).
  { act: "zak:150/2002", name: "soudní řád správní", abbreviation: true, pattern: abbr(`s\\.${S}ř\\.${S}s\\.`, "SŘS") },
  { act: "zak:150/2002", name: "soudní řád správní", abbreviation: false, pattern: named(`soudní${W}${SP}řád${W}${SP}správní${W}`) },
  { act: "zak:500/2004", name: "správní řád", abbreviation: true, pattern: abbr(`spr\\.${S}ř\\.`, "SŘ", "SpŘ") },
  { act: "zak:500/2004", name: "správní řád", abbreviation: false, pattern: named(`správní${W}${SP}řád${W}`) },
  { act: "zak:280/2009", name: "daňový řád", abbreviation: true, pattern: abbr(`daň\\.${S}ř\\.`, "DŘ", "DaŘ") },
  { act: "zak:280/2009", name: "daňový řád", abbreviation: false, pattern: named(`daňov${W}${SP}řád${W}`) },
  { act: "zak:586/1992", name: "zákon o daních z příjmů", abbreviation: true, pattern: abbr("ZDP", "ZDaP") },
  { act: "zak:586/1992", name: "zákon o daních z příjmů", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}daních${SP}z${SP}příjmů`) },
  { act: "zak:235/2004", name: "zákon o dani z přidané hodnoty", abbreviation: true, pattern: abbr("ZDPH") },
  { act: "zak:235/2004", name: "zákon o dani z přidané hodnoty", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}(?:dani${SP}z${SP}přidané${SP}hodnoty|DPH)`) },
  { act: "zak:134/2016", name: "zákon o zadávání veřejných zakázek", abbreviation: true, pattern: abbr("ZZVZ") },
  { act: "zak:134/2016", name: "zákon o zadávání veřejných zakázek", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}zadávání${SP}veřejných${SP}zakázek`) },
  { act: "zak:106/1999", name: "zákon o svobodném přístupu k informacím", abbreviation: true, pattern: abbr("InfZ", "ZSPI", "ZSvPI") },
  { act: "zak:106/1999", name: "zákon o svobodném přístupu k informacím", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}svobodném${SP}přístupu${SP}k${SP}informacím`) },
  { act: "zak:110/2019", name: "zákon o zpracování osobních údajů", abbreviation: true, pattern: abbr("ZZOÚ") },
  { act: "zak:110/2019", name: "zákon o zpracování osobních údajů", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}zpracování${SP}osobních${SP}údajů`) },
  { act: "zak:128/2000", name: "zákon o obcích", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}obcích`) },
  { act: "zak:129/2000", name: "zákon o krajích", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}krajích`) },
  { act: "zak:182/1993", name: "zákon o Ústavním soudu", abbreviation: true, pattern: abbr("ZÚS", "ZoÚS") },
  { act: "zak:182/1993", name: "zákon o Ústavním soudu", abbreviation: false, pattern: named(`zákon${W}${SP}o${SP}Ústavním${SP}soudu`) },
  // Constitutional order. The EU Charter comes before the Czech Listina.
  { act: "zak:1/1993", name: "Ústava České republiky", abbreviation: false, pattern: new RegExp(`${B}Ústav(?:a|y|ě|u|ou)${E}`, "u") },
  { act: "zak:2/1993", name: "Listina základních práv a svobod", abbreviation: true, pattern: abbr("LZPS") },
  // Not the EU Charter ("Listina základních práv Evropské unie / EU"), which
  // has no id the schema accepts.
  {
    act: "zak:2/1993",
    name: "Listina základních práv a svobod",
    abbreviation: false,
    pattern: new RegExp(
      `${B}Listin(?:a|y|ě|u|ou)(?:${SP}základních${SP}práv${SP}a${SP}svobod)?${E}(?!${SP}základních${SP}práv${SP}(?:Evropské|EU))`,
      "u",
    ),
  },
  // EU secondary law (CELEX; the treaties have no id the schema accepts).
  { act: "eu:32016R0679", name: "obecné nařízení o ochraně osobních údajů (GDPR)", abbreviation: true, pattern: abbr("GDPR", "ONOOÚ") },
  { act: "eu:32016R0679", name: "obecné nařízení o ochraně osobních údajů (GDPR)", abbreviation: false, pattern: named(`obecn${W}${SP}nařízení${SP}o${SP}ochraně${SP}osobních${SP}údajů`) },
  { act: "eu:32012R1215", name: "nařízení Brusel I bis", abbreviation: false, pattern: new RegExp(`${B}Brusel${SP}I${SP}bis${E}`, "iu") },
  { act: "eu:32008R0593", name: "nařízení Řím I", abbreviation: false, pattern: new RegExp(`${B}Řím${SP}I${E}`, "u") },
  { act: "eu:32007R0864", name: "nařízení Řím II", abbreviation: false, pattern: new RegExp(`${B}Řím${SP}II${E}`, "u") },
  { act: "eu:32015R0848", name: "nařízení o insolvenčním řízení (přepracované znění)", abbreviation: false, pattern: named(`insolvenční${W}${SP}nařízení${W}`) },
  { act: "eu:32019R1111", name: "nařízení Brusel II ter", abbreviation: false, pattern: new RegExp(`${B}Brusel${SP}II${SP}ter${E}`, "iu") },
  { act: "eu:32022R2065", name: "akt o digitálních službách (DSA)", abbreviation: true, pattern: abbr("DSA") },
  { act: "eu:32022R1925", name: "akt o digitálních trzích (DMA)", abbreviation: true, pattern: abbr("DMA") },
  { act: "eu:32024R1689", name: "akt o umělé inteligenci (AI Act)", abbreviation: true, pattern: abbr("AI Act", "AIA") },
  { act: "eu:32014R0910", name: "nařízení eIDAS", abbreviation: true, pattern: abbr("eIDAS") },
];

/** Canonical names by act id (first entry wins). */
const NAMES = new Map<string, string>();
for (const entry of ACT_ABBREVIATIONS) if (!NAMES.has(entry.act)) NAMES.set(entry.act, entry.name);

/**
 * A Sbírka zákonů number: "89/2012 Sb." (with or without the dot), or
 * "zákon(a) č. 89/2012" without "Sb.". Not "Sb. m. s." (treaties), not
 * "Sb. NSS" (the NSS reports), not "SbNU". Global — use with matchAll or
 * reset lastIndex. Groups 1–2 or 3–4 hold number and year.
 */
export const ACT_NUMBER_RE =
  /(?<![\p{L}\p{N}/])(\d{1,4})\s*\/\s*(\d{4})\s*Sb(?![\p{L}])(?!\.?\s*(?:m\.\s*s\.|NSS))\.?|(?<![\p{L}])(?:zákon|zákona|zákonu|zákonem|zák\.)\s+č\.\s*(\d{1,4})\s*\/\s*(\d{4})(?![\p{N}])/gu;

/** "zak:<n>/<yyyy>" from a number and year; the number without leading zeros. */
export function zakId(number: string, year: string): string {
  return `zak:${Number(number)}/${year}`;
}

/**
 * First act referred to in `text` — a Sbírka number ("zákona č. 89/2012 Sb.",
 * "89/2012 Sb.") or a name/abbreviation from ACT_ABBREVIATIONS — whichever
 * starts earliest (longest on a tie). Pure.
 */
export function resolveAct(text: string): { act: string; name: string } | null {
  let best: { index: number; length: number; act: string; name: string } | null = null;
  const candidates: Array<{ index: number; length: number; act: string; name: string }> = [];
  for (const m of text.matchAll(ACT_NUMBER_RE)) {
    const [number, year] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    const act = zakId(number, year);
    candidates.push({ index: m.index, length: m[0].length, act, name: NAMES.get(act) ?? `zákon č. ${Number(number)}/${year} Sb.` });
    break; // matchAll runs left to right: the first is the earliest
  }
  for (const entry of ACT_ABBREVIATIONS) {
    const m = entry.pattern.exec(text);
    if (m) candidates.push({ index: m.index, length: m[0].length, act: entry.act, name: entry.name });
  }
  for (const c of candidates) {
    if (!best || c.index < best.index || (c.index === best.index && c.length > best.length)) best = c;
  }
  return best ? { act: best.act, name: best.name } : null;
}

/** Canonical short name of an act id ("zak:89/2012" or "89/2012"), null when unknown. Pure. */
export function actName(act: string): string | null {
  const id = /^\d{1,4}\/\d{4}$/.test(act.trim()) ? `zak:${act.trim()}` : act.trim();
  const m = /^zak:0*(\d{1,4})\/(\d{4})$/.exec(id);
  return NAMES.get(m ? zakId(m[1], m[2]) : id) ?? null;
}
