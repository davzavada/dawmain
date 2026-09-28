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
/** "zákon(a|u|em…) o <words>", any whitespace between the words. */
const zakonO = (words: string) => `zákon${W}${SP}o${SP}${words.split(" ").join(SP)}`;

interface ActSpec {
  act: string;
  name: string;
  /** Case-sensitive abbreviations (regex sources), each a whole word. */
  abbr?: string[];
  /** Case-insensitive name patterns (regex sources); W absorbs case endings. */
  names?: string[];
  /** Patterns that need their own flags or lookarounds. */
  custom?: RegExp[];
}

const ACTS: ActSpec[] = [
  // Civil law
  {
    act: "zak:89/2012",
    name: "občanský zákoník",
    abbr: [`o\\.${S}z\\.`, "OZ", "NOZ", "ObčZ", `obč\\.${S}zák\\.`],
    names: [`občansk${W}${SP}zákoník${W}`],
  },
  { act: "zak:99/1963", name: "občanský soudní řád", abbr: [`o\\.${S}s\\.${S}ř\\.`, "OSŘ"], names: [`občansk${W}${SP}soudní${W}${SP}řád${W}`] },
  {
    act: "zak:292/2013",
    name: "zákon o zvláštních řízeních soudních",
    abbr: [`z\\.${S}ř\\.${S}s\\.`, "ZŘS", "ZZŘS", "ZOSŘ"],
    names: [zakonO("zvláštních řízeních soudních")],
  },
  {
    act: "zak:90/2012",
    name: "zákon o obchodních korporacích",
    abbr: [`z\\.${S}o\\.${S}k\\.`, "ZOK", "ZObchK"],
    names: [zakonO("obchodních korporacích")],
  },
  { act: "zak:513/1991", name: "obchodní zákoník", abbr: [`obch\\.${S}zák\\.`, "ObchZ", "ObZ"], names: [`obchodní${W}${SP}zákoník${W}`] },
  { act: "zak:91/2012", name: "zákon o mezinárodním právu soukromém", abbr: ["ZMPS"], names: [zakonO("mezinárodním právu soukromém")] },
  { act: "zak:304/2013", name: "zákon o veřejných rejstřících", abbr: ["ZVR", "ZVeřRej"], names: [zakonO("veřejných rejstřících")] },
  { act: "zak:256/2013", name: "katastrální zákon", names: [`katastrální${W}${SP}zákon${W}`] },
  { act: "zak:634/1992", name: "zákon o ochraně spotřebitele", abbr: ["ZOS", "ZOchS"], names: [zakonO("ochraně spotřebitele")] },
  { act: "zak:216/1994", name: "zákon o rozhodčím řízení", abbr: ["ZRŘ"], names: [zakonO("rozhodčím řízení")] },
  { act: "zak:120/2001", name: "exekuční řád", abbr: [`ex\\.${S}ř\\.`, "EŘ", "ExŘ"], names: [`exekuční${W}${SP}řád${W}`] },
  { act: "zak:358/1992", name: "notářský řád", abbr: [`not\\.${S}ř\\.`, "NotŘ"], names: [`notářsk${W}${SP}řád${W}`] },
  {
    act: "zak:182/2006",
    name: "insolvenční zákon",
    abbr: [`ins\\.${S}z\\.`, `insolv\\.${S}zák\\.`, "InsZ", "IZ"],
    names: [`insolvenční${W}${SP}zákon${W}`],
  },
  // Not "ZA": all-caps headings ("ODPOVĚDNOST ZA ŠKODU") would match it.
  { act: "zak:85/1996", name: "zákon o advokacii", abbr: ["ZAdv"], names: [zakonO("advokacii")] },
  { act: "zak:121/2000", name: "autorský zákon", abbr: [`aut\\.${S}zák\\.`, "AZ", "AutZ"], names: [`autorsk${W}${SP}zákon${W}`] },
  { act: "zak:6/2002", name: "zákon o soudech a soudcích", abbr: ["ZSS", "ZSaS"], names: [zakonO("soudech a soudcích")] },
  { act: "zak:257/2016", name: "zákon o spotřebitelském úvěru", abbr: ["ZSÚ", "ZSpÚ"], names: [zakonO("spotřebitelském úvěru")] },
  { act: "zak:370/2017", name: "zákon o platebním styku", abbr: ["ZPS", "ZPlS"], names: [zakonO("platebním styku")] },
  {
    act: "zak:256/2004",
    name: "zákon o podnikání na kapitálovém trhu",
    abbr: ["ZPKT"],
    names: [zakonO("podnikání na kapitálovém trhu")],
  },
  { act: "zak:21/1992", name: "zákon o bankách", names: [zakonO("bankách")] },
  // Labour and social law
  { act: "zak:262/2006", name: "zákoník práce", abbr: [`zák\\.${S}práce`, `zák\\.${S}pr\\.`, "ZP", "ZPr"], names: [`zákoník${W}${SP}práce`] },
  { act: "zak:435/2004", name: "zákon o zaměstnanosti", abbr: ["ZZam"], names: [zakonO("zaměstnanosti")] },
  { act: "zak:234/2014", name: "zákon o státní službě", abbr: ["ZSSl"], names: [zakonO("státní službě")] },
  { act: "zak:187/2006", name: "zákon o nemocenském pojištění", names: [zakonO("nemocenském pojištění")] },
  // Criminal law
  {
    act: "zak:40/2009",
    name: "trestní zákoník",
    abbr: [`tr\\.${S}zák\\.`, `tr\\.${S}z\\.`, "TZ", "TrZ", "TZk"],
    names: [`trestní${W}${SP}zákoník${W}`],
  },
  { act: "zak:141/1961", name: "trestní řád", abbr: [`tr\\.${S}ř\\.`, "TŘ", "TrŘ"], names: [`trestní${W}${SP}řád${W}`] },
  {
    act: "zak:418/2011",
    name: "zákon o trestní odpovědnosti právnických osob",
    abbr: ["TOPO", "ZTOPO"],
    names: [zakonO("trestní odpovědnosti právnických osob")],
  },
  { act: "zak:45/2013", name: "zákon o obětech trestných činů", names: [zakonO("obětech trestných činů")] },
  {
    act: "zak:250/2016",
    name: "zákon o odpovědnosti za přestupky a řízení o nich",
    abbr: ["ZOP", "PřZ"],
    names: [zakonO("odpovědnosti za přestupky")],
  },
  // Administrative and public law. "soudní řád správní" and "správní řád"
  // never match inside each other (the words are reversed).
  { act: "zak:150/2002", name: "soudní řád správní", abbr: [`s\\.${S}ř\\.${S}s\\.`, "SŘS"], names: [`soudní${W}${SP}řád${W}${SP}správní${W}`] },
  { act: "zak:500/2004", name: "správní řád", abbr: [`spr\\.${S}ř\\.`, "SŘ", "SpŘ"], names: [`správní${W}${SP}řád${W}`] },
  { act: "zak:280/2009", name: "daňový řád", abbr: [`daň\\.${S}ř\\.`, "DŘ", "DaŘ"], names: [`daňov${W}${SP}řád${W}`] },
  { act: "zak:586/1992", name: "zákon o daních z příjmů", abbr: ["ZDP", "ZDaP"], names: [zakonO("daních z příjmů")] },
  {
    act: "zak:235/2004",
    name: "zákon o dani z přidané hodnoty",
    abbr: ["ZDPH"],
    names: [`zákon${W}${SP}o${SP}(?:dani${SP}z${SP}přidané${SP}hodnoty|DPH)`],
  },
  {
    act: "zak:134/2016",
    name: "zákon o zadávání veřejných zakázek",
    abbr: ["ZZVZ"],
    names: [zakonO("zadávání veřejných zakázek")],
  },
  {
    act: "zak:106/1999",
    name: "zákon o svobodném přístupu k informacím",
    abbr: ["InfZ", "ZSPI", "ZSvPI"],
    names: [zakonO("svobodném přístupu k informacím")],
  },
  {
    act: "zak:110/2019",
    name: "zákon o zpracování osobních údajů",
    abbr: ["ZZOÚ"],
    names: [zakonO("zpracování osobních údajů")],
  },
  { act: "zak:128/2000", name: "zákon o obcích", names: [zakonO("obcích")] },
  { act: "zak:129/2000", name: "zákon o krajích", names: [zakonO("krajích")] },
  { act: "zak:182/1993", name: "zákon o Ústavním soudu", abbr: ["ZÚS", "ZoÚS"], names: [zakonO("Ústavním soudu")] },
  // Constitutional order. "Ústava" only capitalized and in its case forms
  // ("ústav", "Ústavní soud" are other words).
  { act: "zak:1/1993", name: "Ústava České republiky", custom: [new RegExp(`${B}Ústav(?:a|y|ě|u|ou)${E}`, "u")] },
  {
    act: "zak:2/1993",
    name: "Listina základních práv a svobod",
    abbr: ["LZPS"],
    // Not the EU Charter ("Listina základních práv Evropské unie / EU"),
    // which has no id the schema accepts.
    custom: [
      new RegExp(
        `${B}Listin(?:a|y|ě|u|ou)(?:${SP}základních${SP}práv${SP}a${SP}svobod)?${E}(?!${SP}základních${SP}práv${SP}(?:Evropské|EU))`,
        "u",
      ),
    ],
  },
  // EU secondary law (CELEX; the treaties have no id the schema accepts).
  {
    act: "eu:32016R0679",
    name: "obecné nařízení o ochraně osobních údajů (GDPR)",
    abbr: ["GDPR", "ONOOÚ"],
    names: [`obecn${W}${SP}nařízení${SP}o${SP}ochraně${SP}osobních${SP}údajů`],
  },
  { act: "eu:32012R1215", name: "nařízení Brusel I bis", names: [`Brusel${SP}I${SP}bis`] },
  { act: "eu:32019R1111", name: "nařízení Brusel II ter", names: [`Brusel${SP}II${SP}ter`] },
  // Case-sensitive: "Řím I" is not "řím i".
  { act: "eu:32008R0593", name: "nařízení Řím I", custom: [new RegExp(`${B}Řím${SP}I${E}`, "u")] },
  { act: "eu:32007R0864", name: "nařízení Řím II", custom: [new RegExp(`${B}Řím${SP}II${E}`, "u")] },
  { act: "eu:32015R0848", name: "nařízení o insolvenčním řízení (přepracované znění)", names: [`insolvenční${W}${SP}nařízení${W}`] },
  { act: "eu:32022R2065", name: "akt o digitálních službách (DSA)", abbr: ["DSA"] },
  { act: "eu:32022R1925", name: "akt o digitálních trzích (DMA)", abbr: ["DMA"] },
  { act: "eu:32024R1689", name: "akt o umělé inteligenci (AI Act)", abbr: ["AI Act", "AIA"] },
  { act: "eu:32014R0910", name: "nařízení eIDAS", abbr: ["eIDAS"] },
];

/**
 * One entry per pattern. resolveAct takes the EARLIEST match in the text
 * and, at equal position, the longest — so the order here does not matter.
 */
export const ACT_ABBREVIATIONS: ReadonlyArray<ActEntry> = ACTS.flatMap(({ act, name, abbr: forms, names, custom }) => [
  ...(forms ? [{ act, name, abbreviation: true, pattern: abbr(...forms) }] : []),
  ...(names ?? []).map((source) => ({ act, name, abbreviation: false, pattern: named(source) })),
  ...(custom ?? []).map((pattern) => ({ act, name, abbreviation: false, pattern })),
]);

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
    const name = NAMES.get(act) ?? `předpis č. ${Number(number)}/${year} Sb.`;
    candidates.push({ index: m.index, length: m[0].length, act, name });
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
