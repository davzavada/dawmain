import { CONTACT } from "./contact";

/**
 * The texts of the website an admin can rewrite on /sprava/texty: the home
 * page's intro, the lines under the Pro sources, and the two legal pages.
 * Everything else on the pages (the source list with its badges, the setup
 * guide, navigation, buttons) is code.
 *
 * Each field has a default — the text as it stands in the repository — and
 * the site shows it wherever nothing else is stored (and whenever the
 * database cannot be read). Stored texts are overrides keyed by field
 * (src/content/store.ts); a field saved back to its default is removed, so
 * a later change of the default in code reaches the site again.
 *
 * Pure, no I/O: the client-side editor and the server read the same list.
 */

/** How a field is written and shown. */
export type TextKind =
  /** One line, shown as typed (no formatting). */
  | "plain"
  /** A few paragraphs: **bold**, *italic*, [links](…). */
  | "block"
  /** A whole page: also `## headings` (each opens a section) and `- lists`. */
  | "document";

export interface TextField {
  key: string;
  group: string;
  label: string;
  /** Where the text shows, for the editor. */
  hint: string;
  kind: TextKind;
  maxChars: number;
  default: string;
}

/** The contact as the legal texts link it. */
const MAIL = `[${CONTACT}](mailto:${CONTACT})`;
/** The GDPR on EUR-Lex (Czech), linked from every legal basis in the privacy policy. */
const GDPR = "https://eur-lex.europa.eu/legal-content/CS/TXT/?uri=CELEX:32016R0679";

const HOME = "Hlavní stránka";
const SOURCES = "Popisky zdrojů";
const LEGAL = "Podmínky a soukromí";

export const TEXT_FIELDS = [
  {
    key: "home.title",
    group: HOME,
    label: "Nadpis",
    hint: "Hlavní nadpis úvodní stránky.",
    kind: "plain",
    maxChars: 120,
    default: "MCP server pro právní systémy",
  },
  {
    key: "home.lead",
    group: HOME,
    label: "Úvodní text",
    hint: "Odstavce pod nadpisem. Prázdný řádek odděluje odstavce.",
    kind: "block",
    maxChars: 3000,
    default:
      "Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz zvládne i server doma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)\n\nV oficiálních databázích server hledá živě – funguje jako nachytřený Google. Jen judikaturu českých soudů si pravidelně kopíruje do vlastní databáze, aby v ní hledal rychleji; odkazy ale vždy vedou na originál u soudu. Kdo má režim Pro (právníky), může připojit svou knihovnu Zotero a nahrát vlastní soubory.",
  },
  {
    key: "home.owl",
    group: HOME,
    label: "Karta Owl",
    hint: "Text karty s odkazem na Owl dole na stránce.",
    kind: "plain",
    maxChars: 300,
    default: "Pokud vás zajímá monitoring recentní rozhodovací praxe a doktrinálního vývoje, podívejte se na můj další projekt.",
  },
  {
    key: "sources.files",
    group: SOURCES,
    label: "Vlastní soubory",
    hint: "Řádek pod „Vlastní soubory“ pro návštěvníky a účty bez Pro. Účet s Pro tu vidí počet dokumentů.",
    kind: "plain",
    maxChars: 300,
    default: "Nahrané knihy, články, komentáře a vzory, ve kterých asistent hledá vedle oficiálních databází.",
  },
  {
    key: "sources.zotero",
    group: SOURCES,
    label: "Zotero",
    hint: "Řádek pod „Zotero“ pro návštěvníky a účty bez Pro. Připojený účet tu vidí své jméno v Zoteru.",
    kind: "plain",
    maxChars: 300,
    default: "Vaše knihovna, ve které asistent hledá a čte, a když povolíte, i ukládá nalezené dokumenty.",
  },
  {
    key: "sources.ukaz",
    group: SOURCES,
    label: "UKAŽ",
    hint: "Řádek pod „UKAŽ“ v seznamu zdrojů.",
    kind: "plain",
    maxChars: 300,
    default: "Katalog literatury Univerzity Karlovy, ve kterém asistent dohledává doktrínu.",
  },
  {
    key: "legal.effective",
    group: LEGAL,
    label: "Účinné od",
    hint: "Datum pod nadpisem obou právních stránek. Při změně jejich textu ho změň taky.",
    kind: "plain",
    maxChars: 40,
    default: "16. 11. 2026",
  },
  {
    key: "legal.terms",
    group: LEGAL,
    label: "Podmínky užití",
    hint: "Celý text stránky /podminky. Řádek „## Nadpis“ začíná oddíl, „- “ položku seznamu. Podpis na konci zůstává.",
    kind: "document",
    maxChars: 40000,
    default: `Dawmain provozuji zdarma a ve volném čase jako nekomerční projekt. Napsat mi můžete na ${MAIL}. Smlouva mezi námi vzniká založením uživatelského účtu. Je bezplatná.

## Kdo může Dawmain používat

Dawmain je zdarma pro všechny: studenty, akademiky, úřady, advokáty i menší advokátní kanceláře. Výjimkou jsou advokátní kanceláře, ve kterých působí více než 20 advokátů. Ty mohou Dawmain používat jen po domluvě se mnou; pokud o přístup stojíte, napište mi na ${MAIL} a domluvíme se.

## Účet a slušné užívání

Používejte prosím svůj vlastní účet a nepůjčujte ho dál. Za to, co se pod ním děje, včetně volání vašeho asistenta, odpovídáte vy. Služba je na běžné rešerše. Nedělejte z ní prosím hromadné stahování databází - zdroje jsou cizí a jejich přetížení odnesou všichni ostatní. Když by někdo provoz ohrožoval, můžu jeho přístup dočasně omezit; ozvu se mu a domluvíme se.

Snažím se, aby server šlapal, ale dostupnost nezaručuji - výpadky zdrojů jsou úplně mimo mou kontrolu. Jak na tom databáze zrovna jsou, ukazují kontrolky na [hlavní stránce](/#zdroje).

Za správnost, úplnost ani aktuálnost obsahu ze zdrojů neručím, stejně jako za to, co z nich vyvodí váš AI asistent, nebo za rozhodnutí udělaná bez ověření v primárním zdroji. Službu dostáváte zdarma a takovou, jaká je.

## Vlastní soubory (Pro)

V režimu Pro (právníky) si na webu nahrajete vlastní dokumenty a váš asistent v nich pak hledá vedle oficiálních databází. Pro je zdarma s dobrovolným příspěvkem ve výši jednoho (1) piva dle volby uživatele a přiděluji ho ručně; stačí mi napsat na ${MAIL}. Můžu ho kdykoli odebrat.

Nahráním dokumentu potvrzujete, že pravidla v tomto oddílu dodržíte - web na ně upozorňuje přímo u nahrávání.

**Kvóty.** Místo se počítá podle velikosti nahraných souborů: osobní knihovna má 100 MB, týmová 1 GB a jeden soubor může mít nejvýš 100 MB. Kolik místa vám zbývá, vidíte na stránce souborů. Kvóty můžu podle kapacity měnit, už nahrané dokumenty kvůli tomu ale nemažu. Když se blíží technické limity, které pro ně mám nastavené, přepnou se samy do režimu jen pro čtení (hledat, číst a mazat jde, nahrávat ne), případně se na čas vypnou.

**AI a citace.** Typ dokumentu (komentář, článek, kniha…), název, autory a další metadata navrhne server podle začátku dokumentu a asistent v dokumentu hledá hned po zpracování. Návrh se může splést: po rozkliknutí dokumentu v seznamu souborů ho kdykoli opravíte.

**Záloha není.** Server ukládá nahraný soubor i jeho převedený text, ve kterém asistent hledá. Nic z toho nezálohuji a za ztrátu, třeba při výpadku nebo ukončení služby, neručím, takže si originály nechte i u sebe. Originál i text si můžete kdykoli stáhnout na stránce souborů (text s denním limitem).

**Týmy.** Na požádání vás zařadím do týmu. Tým má vlastní sdílenou knihovnu: dokumenty nahrané do ní vidí a prohledávají všichni jeho členové a jejich asistenti, správce týmu je může upravit i smazat. Do týmu nahrávejte jen to, co smějí vidět všichni jeho členové. Osobní soubory zůstávají jen vaše. Členy týmů přiděluji a měním já.

**Osobní údaje.** Jak s nimi zacházím, popisují [Zásady ochrany osobních údajů](/soukromi). Požádá-li mě někdo o výmaz údajů o sobě z nahraného dokumentu, dokument smažu a dám vám vědět.

**Nezákonný obsah.** Máte-li za to, že je ve Vlastních souborech nezákonný obsah (typicky porušení autorských práv), napište mi na ${MAIL}: o jaký dokument jde, proč je podle vás nezákonný, a své jméno a e-mail. Oznámení posoudím bez zbytečného odkladu. Nezákonný obsah nebo obsah v rozporu s těmito pravidly můžu odstranit, zabránit jeho opětovnému nahrání a přístup k Vlastním souborům omezit nebo zrušit. Tomu, koho se to týká, napíšu, co jsem udělal a proč, a může se proti tomu ohradit.

**Kontaktní místo.** Jednotným kontaktním místem pro orgány členských států, Evropskou komisi a Evropský sbor pro digitální služby (čl. 11 nařízení (EU) 2022/2065, akt o digitálních službách) i pro vás jako uživatele (čl. 12) je e-mail ${MAIL}. Psát na něj můžete česky nebo anglicky; odpovídám osobně, ne automat.

**Žádosti úřadů.** Požádá-li o údaje nebo dokumenty soud, policie či jiný orgán, vyhovím jen tak, jak to ukládá zákon, a jen v nezbytném rozsahu. Dám vám o tom vědět, pokud mi to zákon nezakazuje.

## Zotero (Pro)

V režimu Pro (právníky) si můžete k Dawmainu připojit svou knihovnu v Zoteru (zotero.org). Váš asistent v ní pak hledá a čte záznamy, poznámky, anotace a text příloh, včetně skupin, kterých jste v Zoteru členem. Při připojení si vyberete, jestli Dawmain smí knihovnu **jen číst**, nebo **číst a ukládat**: pak asistent může nalezené dokumenty uložit do vaší osobní knihovny jako nové záznamy. Stávající záznamy Dawmain nikdy nemění ani nemaže a do skupin nezapisuje.

Zotero se řídí vlastními podmínkami.

## Ukončení a změny

Účet můžete kdykoli zrušit - napište na ${MAIL}. Já můžu provoz ukončit okamžitě.

Podmínky můžu přiměřeně změnit, když se změní fungování služby nebo právní úprava. Nové znění dám sem a o důležité změně napíšu e-mailem s měsíčním předstihem. Když se vám změna nelíbí, můžete kdykoli do jejího účinku účet zrušit.`,
  },
  {
    key: "legal.privacy",
    group: LEGAL,
    label: "Zásady ochrany osobních údajů",
    hint: "Celý text stránky /soukromi. Řádek „## Nadpis“ začíná oddíl, „- “ položku seznamu.",
    kind: "document",
    maxChars: 40000,
    default: `## 1. Správce osobních údajů

**David Závada**, fyzická osoba, e-mail ${MAIL}.

## 2. Co zpracovávám, proč a jak dlouho

**Základ – pro každý účet**

| # | Co a proč | Jaké údaje | Právní základ | Jak dlouho |
|---|---|---|---|---|
| 1 | Účet a přihlášení | e-mail, jméno, identifikátor účtu (při přihlášení účtem Google je předá Google) | plnění smlouvy ([čl. 6 odst. 1 písm. b) GDPR](${GDPR})) | dokud účet trvá |
| 2 | Provoz a ochrana služby: chyby, limity, zneužití | čas požadavku, volaný nástroj, výsledek, IP adresa | oprávněný zájem ([čl. 6 odst. 1 písm. f) GDPR](${GDPR})) | jen po dobu potřebnou k řešení chyb a ochraně služby |
| 3 | Přehled o tom, kdo službu používá, jak často a které nástroje, abych ji mohl rozvíjet; je jen pro mě, k marketingu ho nepoužívám | počty volání u účtu | oprávněný zájem ([čl. 6 odst. 1 písm. f) GDPR](${GDPR})) | počty volání u účtu nejdéle 12 měsíců |

**Nástavba Pro (právníky)**

| # | Co a proč | Jaké údaje | Právní základ | Jak dlouho |
|---|---|---|---|---|
| 4 | Vlastní soubory | soubory, které nahrajete (originál i převedený text), metadata (název, autoři, rok, typ, název souboru a složky), záznam o nahrání, úpravách, stažení a smazání | plnění smlouvy ([čl. 6 odst. 1 písm. b) GDPR](${GDPR})) | dokud dokument nesmažete, nejdéle však do zrušení účtu nebo odebrání Pro. Pak knihovnu do týdne smažu (předtím si soubory můžete stáhnout). Týmové dokumenty do týdne po vypnutí nebo zrušení týmu je smažu |
| 5 | Osobní údaje jiných lidí v nahraných dokumentech (třeba jména autorů), aby v nich asistent mohl hledat | to, co dokument obsahuje | oprávněný zájem ([čl. 6 odst. 1 písm. f) GDPR](${GDPR})) | jako dokument |
| 6 | Zotero | zašifrovaný klíč k vaší knihovně, uživatelské jméno a identifikátor v Zoteru | plnění smlouvy ([čl. 6 odst. 1 písm. b) GDPR](${GDPR})) | dokud Zotero neodpojíte nebo nezrušíte účet; neplatný klíč smažu hned |
| 7 | Doložení výmazu knihovny | identifikátor knihovny, datum, počet smazaných dokumentů | oprávněný zájem ([čl. 6 odst. 1 písm. f) GDPR](${GDPR})) | dokud může být potřeba výmaz doložit |

Údaje o účtu jsou pro poskytování služby nezbytné; bez nich účet nelze vytvořit. Provozní záznamy vznikají automaticky při každém použití služby. Nahrávání dokumentů a připojení Zotera jsou dobrovolné.

Obsah rešerší si neukládám a s vaším účtem ho nespojuji. Rozhodnutí českých soudů si server kopíruje do vlastní databáze; soudy je zveřejňují už anonymizovaná a kopíruji je tak, jak jsou zveřejněná. Databázi zatím pravidelně nezálohuji; smazaný dokument může zůstat nejvýš v dočasném snímku serveru před údržbou, dokud ho nesmažu.

## 3. Komu údaje předávám

Dawmain běží na mém vlastním serveru v České republice. Na provozu se podílejí tito zpracovatelé:

- **Clerk, Inc.** - přihlašování a správa účtů,
- **Cloudflare, Inc.** - síť, přes kterou vede komunikace s webem (ochrana před útoky, šifrované spojení); zpracovává proto IP adresu při přenosu.

Clerk i Cloudflare jsou americké společnosti; předávání do USA se opírá o EU-US Data Privacy Framework. Metadata dokumentu navrhne po nahrání server sám podle začátku dokumentu; text dokumentu přitom žádnému poskytovateli AI neposílám. Co z dokumentu přečte váš asistent, dostane poskytovatel asistenta, kterého používáte. Dokumenty nahrané do týmové knihovny vidí členové toho týmu. Jinak údaje předám jen orgánům veřejné moci, ukládá-li mi to zákon. Přihlášení účtem Google se řídí [zásadami Google](https://policies.google.com/privacy).

## 4. Zabezpečení

Jen HTTPS a šifrovaný tunel k serveru, knihovny oddělené v databázi, klíč k Zoteru šifrovaný. Používám jen cookies nezbytné pro přihlášení, žádné analytické ani reklamní.

## 5. Vaše práva

Máte právo na přístup ke svým údajům, jejich opravu a výmaz, omezení zpracování a přenositelnost, vznést námitku proti zpracování na základě oprávněného zájmu (řádky 2, 3, 5 a 7) a podat stížnost u Úřadu pro ochranu osobních údajů ([uoou.gov.cz](https://uoou.gov.cz)). Napište mi na ${MAIL}; odpovím do měsíce.`,
  },
] as const satisfies readonly TextField[];

export type TextKey = (typeof TEXT_FIELDS)[number]["key"];
export type SiteTexts = Record<TextKey, string>;
/** What is stored: only the fields that differ from their default. */
export type TextOverrides = Partial<SiteTexts>;

const BY_KEY = new Map<string, TextField>(TEXT_FIELDS.map((field) => [field.key, field]));

export function textField(key: string): TextField | undefined {
  return BY_KEY.get(key);
}

/** Every field at its default. */
export const DEFAULT_TEXTS: SiteTexts = Object.fromEntries(TEXT_FIELDS.map((field) => [field.key, field.default])) as SiteTexts;

/** Line endings unified, outer blank space dropped; a one-line field loses its line breaks. Pure. */
export function normalizeText(field: TextField, value: string): string {
  const text = value.replace(/\r\n?/g, "\n").trim();
  return field.kind === "plain" ? text.replace(/\s*\n\s*/g, " ") : text;
}

/**
 * A value as it may be stored, or why not. An empty text is refused — a
 * page with a hole in it is never what was meant; "Vrátit výchozí" is the
 * way back. Pure.
 */
export function checkText(key: string, value: unknown): { ok: true; field: TextField; text: string } | { ok: false; error: string } {
  const field = textField(key);
  if (!field) return { ok: false, error: "Neznámé pole." };
  if (typeof value !== "string") return { ok: false, error: "Neplatný text." };
  const text = normalizeText(field, value);
  if (!text) return { ok: false, error: "Text nemůže být prázdný. Původní znění vrátí „Vrátit výchozí“." };
  if (text.length > field.maxChars) return { ok: false, error: `Text je moc dlouhý (${text.length} znaků, nejvýš ${field.maxChars}).` };
  return { ok: true, field, text };
}

/**
 * What the database holds, reduced to what may be shown: known fields with
 * a text that still passes checkText and differs from the default. Anything
 * else (a field since removed, a value of another type) is dropped. Pure.
 */
export function cleanOverrides(stored: unknown): TextOverrides {
  const out: Record<string, string> = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const checked = checkText(key, value);
    if (checked.ok && checked.text !== checked.field.default) out[key] = checked.text;
  }
  return out as TextOverrides;
}

/** The texts the site shows: the defaults with the stored overrides on top. Pure. */
export function resolveTexts(overrides: TextOverrides): SiteTexts {
  return { ...DEFAULT_TEXTS, ...overrides };
}
