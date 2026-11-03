/**
 * The act registry (mirror.act, mirror.act_alias) from its sources:
 * e-Sbírka open data (002PravniAkt: every act of the Sbírka zákonů and the
 * Sbírka mezinárodních smluv with its proclaimed title) and Cellar (EU
 * regulations, directives, decisions with their Czech titles). Pure parsing
 * — the CLI downloads, these read. Unit-tested.
 *
 * Names: a title "Zákon [ze dne …] o obchodních korporacích [a o změně …]"
 * gives the name "zákon o obchodních korporacích" — in running text only its
 * first word declines ("zákona o …", "zákonem o …"), so the extractor can
 * find it by that word and the words after "o". An official short title in
 * the trailing parentheses ("(zákon o obchodních korporacích)", "(advokátní
 * tarif)") is a name too. Names whose words all decline ("občanský
 * zákoník") come from the act table in src/files/index/acts.ts and from the
 * case law (mined aliases), not from here.
 */

export interface ActRow {
  id: string;
  collection: "sb" | "sm" | "eu";
  kind: string | null;
  number: string | null;
  year: number | null;
  title: string;
  shortTitle: string | null;
}

export interface AliasRow {
  alias: string;
  actId: string;
  kind: "name" | "abbreviation";
  origin: "title" | "table" | "caselaw" | "manual";
  seen: number;
}

const KIND_RE =
  /^(Ústavní zákon|Zákonné opatření|Zákon|Vyhláška|Nařízení vlády|Nařízení|Sdělení|Usnesení|Rozhodnutí|Opatření|Nález|Dekret|Úplné znění)\b/;

/** Lowercase kind word of a title, or null. */
export function actKind(title: string): string | null {
  return KIND_RE.exec(title.trim())?.[1].toLowerCase() ?? null;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The trailing "(…)" of a title when it is a short citation — it names the
 * act with a legal noun ("(zákon o obchodních korporacích)", "(advokátní
 * tarif)", "(obecní zřízení)") — not a remark ("(úplné znění, jak vyplývá
 * …)", "(II. kolo)").
 */
const SHORT_TITLE_NOUN = /\b(zákon|zákoník|řád|tarif|zřízení|pravidla|předpis|ústav|listin|kodex|statut|norma|regulativ)/iu;

export function shortTitleOf(title: string): string | null {
  const m = /\(([^()]{3,90})\)\s*\.?\s*$/.exec(title);
  if (!m) return null;
  const inner = clean(m[1]);
  if (/\d{4}|ve znění|účinn|platn|viz |úplné znění|změn/iu.test(inner) || !SHORT_TITLE_NOUN.test(inner)) return null;
  return inner;
}

/**
 * Who issued the act, between the kind word and "o": "Zákon České národní
 * rady o daních z příjmů", "Vyhláška Ministerstva spravedlnosti o …",
 * "Nařízení vlády České republiky o …" — skipped to reach the subject.
 */
const ISSUER =
  /^\s+(?:(?:České|Slovenské|Federální(?:ho)?|Národního|Českého|Státního|Státní)\s+[\p{L}\s]{0,40}?|(?:[Mm]inisterst(?:va|ev)|[Mm]inistra|[Úú]řadu|[Vv]lády|[Pp]ředsednictva|ČNB|Rady)\b[\p{L}\s,]{0,90}?)(?=\s+o\s)/u;

/**
 * Names an act is cited by, lowercase: "<kind> o <subject>" from the title
 * (cut where amendments or a second subject begin), and the short title.
 * One-word subjects too ("zákon o obcích", "zákon o telekomunikacích"): the
 * extractor takes a name only right after a § and prefers the longest. Pure.
 */
export function titleNames(title: string): string[] {
  const t = clean(title);
  const names = new Set<string>();
  // A republished full text ("… (úplné znění, jak vyplývá z pozdějších změn)") is not cited by its own number.
  if (/úplné\s+znění/iu.test(t)) return [];
  const kind = actKind(t);
  if (kind === "zákon" || kind === "vyhláška" || kind === "nařízení vlády" || kind === "ústavní zákon") {
    const body = t
      .slice(t.toLowerCase().indexOf(kind) + kind.length)
      .replace(/^\s*ze dne \d{1,2}\.\s*\p{L}+\s+\d{4},?/u, "")
      .replace(ISSUER, "");
    const m = /^\s+o\s+(.+)$/u.exec(body);
    if (m) {
      const subject = m[1]
        .split(/\s+a\s+o\s+změn|\s+a\s+o\s+doplněn|,\s*kterým|,\s*ve znění|\s*\(|;|\.\s*$/u)[0]
        .replace(/[.,]+$/, "")
        .trim();
      if (subject && subject.length <= 120) names.add(`${kind} o ${subject}`.toLowerCase());
    }
  }
  // An implementing act's title may end with the act it implements: "(zákon o …)" in a vyhláška is not its name.
  const short = shortTitleOf(t);
  const shortKind = short ? actKind(short.charAt(0).toUpperCase() + short.slice(1)) : null;
  if (short && short.split(/\s+/).length >= 2 && (!shortKind || shortKind === kind)) names.add(short.toLowerCase());
  return [...names];
}

interface EsbirkaItem {
  "akt-sbírka-kód"?: string;
  "akt-číslo-předpisu"?: string;
  "akt-rok-předpisu"?: number;
  "akt-název-vyhlášený"?: string;
}

/** e-Sbírka 002PravniAkt items → registry rows and their title names (Sbírka zákonů and mezinárodních smluv only). Pure. */
export function parseEsbirkaActs(items: EsbirkaItem[]): { acts: ActRow[]; aliases: AliasRow[] } {
  const acts: ActRow[] = [];
  const aliases: AliasRow[] = [];
  for (const item of items) {
    const collection = item["akt-sbírka-kód"];
    if (collection !== "sb" && collection !== "sm") continue;
    const number = String(Number(item["akt-číslo-předpisu"]));
    const year = Number(item["akt-rok-předpisu"]);
    const title = clean(item["akt-název-vyhlášený"] ?? "");
    if (!/^\d+$/.test(number) || !year || !title) continue;
    const id = `${collection === "sb" ? "zak" : "sm"}:${number}/${year}`;
    acts.push({ id, collection, kind: actKind(title), number, year, title, shortTitle: shortTitleOf(title) });
    for (const alias of titleNames(title)) aliases.push({ alias, actId: id, kind: "name", origin: "title", seen: 0 });
  }
  return { acts, aliases };
}

/** Every EU regulation, directive and decision of one year with its Czech title (~2,000 rows, ~5 s). */
export function euActsYearQuery(year: number): string {
  if (!(Number.isInteger(year) && year >= 1950 && year <= 2100)) throw new Error(`not a year: ${year}`);
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?celex ?title WHERE {
  ?w cdm:resource_legal_id_celex ?celex .
  FILTER(REGEX(STR(?celex), "^3${year}[RLD][0-9]{4}$"))
  OPTIONAL { ?e cdm:expression_belongs_to_work ?w ;
                cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/CES> ;
                cdm:expression_title ?title }
} ORDER BY ?celex`;
}

/** Cellar SPARQL rows (?celex ?title) of EU acts → registry rows. Pure. */
export function parseCellarActs(json: unknown): ActRow[] {
  const rows = (json as { results?: { bindings?: Array<Record<string, { value?: string }>> } })?.results?.bindings ?? [];
  const acts = new Map<string, ActRow>();
  for (const row of rows) {
    const celex = row.celex?.value;
    const m = celex ? /^3(\d{4})([RLD])(\d{4})$/.exec(celex) : null;
    if (!m || acts.has(celex!)) continue;
    const kind = { R: "nařízení", L: "směrnice", D: "rozhodnutí" }[m[2] as "R" | "L" | "D"];
    acts.set(celex!, {
      id: `eu:${celex}`,
      collection: "eu",
      kind,
      number: String(Number(m[3])),
      year: Number(m[1]),
      title: clean(row.title?.value ?? `${kind} ${celex}`),
      shortTitle: null,
    });
  }
  return [...acts.values()];
}

/** Primary EU law and other acts courts cite by name only: id, title, names. */
export const MANUAL_ACTS: Array<{ act: ActRow; names: string[]; abbreviations: string[] }> = [
  {
    act: { id: "eu:11957E/TXT", collection: "eu", kind: "smlouva", number: null, year: 1957, title: "Smlouva o založení Evropského (hospodářského) společenství", shortTitle: null },
    names: ["smlouva o založení evropského společenství"],
    abbreviations: ["SES", "SEHS"],
  },
  {
    act: { id: "eu:12016E/TXT", collection: "eu", kind: "smlouva", number: null, year: 2016, title: "Smlouva o fungování Evropské unie (konsolidované znění)", shortTitle: null },
    names: ["smlouva o fungování evropské unie"],
    abbreviations: ["SFEU", "TFEU", "Smlouvy o fungování EU"],
  },
  {
    act: { id: "eu:12016M/TXT", collection: "eu", kind: "smlouva", number: null, year: 2016, title: "Smlouva o Evropské unii (konsolidované znění)", shortTitle: null },
    names: ["smlouva o evropské unii"],
    abbreviations: ["SEU", "TEU"],
  },
  {
    act: { id: "eu:12016P/TXT", collection: "eu", kind: "listina", number: null, year: 2016, title: "Listina základních práv Evropské unie", shortTitle: null },
    names: ["listina základních práv evropské unie"],
    abbreviations: ["Listina EU", "LZPEU", "Charta"],
  },
];
