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
      "Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz je v zásadě zdarma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)\n\nV oficiálních databázích server hledá živě – funguje jako nachytřený Google a nic si z nich nekopíruje. Kdo má režim Pro, může připojit svou knihovnu Zotero a nahrát vlastní soubory.",
  },
  {
    key: "home.owl",
    group: HOME,
    label: "Karta Owl",
    hint: "Text karty s odkazem na Owl pod úvodem.",
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
    default: "6. 10. 2026",
  },
  {
    key: "legal.terms",
    group: LEGAL,
    label: "Podmínky užití",
    hint: "Celý text stránky /podminky. Řádek „## Nadpis“ začíná oddíl, „- “ položku seznamu. Podpis na konci zůstává.",
    kind: "document",
    maxChars: 40000,
    default: `Dawmain provozuji zdarma a ve volném čase jako nekomerční projekt. Napsat mi můžete na ${MAIL}. Smlouva mezi námi vzniká založením uživatelského účtu. Je bezplatná.

## Účet a slušné užívání

Používejte prosím svůj vlastní účet a nepůjčujte ho dál. Za to, co se pod ním děje, včetně volání vašeho asistenta, odpovídáte vy. Služba je na běžné rešerše. Nedělejte z ní prosím hromadné stahování databází - zdroje jsou cizí a jejich přetížení odnesou všichni ostatní. Když by někdo provoz ohrožoval, můžu jeho přístup dočasně omezit; ozvu se mu a domluvíme se.

Snažím se, aby server šlapal, ale dostupnost nezaručuji - výpadky zdrojů jsou úplně mimo mou kontrolu. Jak na tom databáze zrovna jsou, ukazují kontrolky na [hlavní stránce](/#zdroje).

Za správnost, úplnost ani aktuálnost obsahu ze zdrojů neručím, stejně jako za to, co z nich vyvodí váš AI asistent, nebo za rozhodnutí udělaná bez ověření v primárním zdroji. Službu dostáváte zdarma a takovou, jaká je.

## Vlastní soubory (Pro)

V režimu Pro si na webu nahrajete vlastní dokumenty a váš asistent v nich pak hledá vedle oficiálních databází. Pro je zdarma s dobrovolným příspěvkem ve výši jednoho (1) piva dle volby uživatele a přiděluji ho ručně; stačí mi napsat na ${MAIL}. Můžu ho kdykoli odebrat.

Nahráním dokumentu potvrzujete, že pravidla v tomto oddílu dodržíte - web na ně upozorňuje přímo u nahrávání.

**Kvóty.** Místo se počítá ve stranách: jedna strana je 3 600 znaků převedeného textu včetně poznámek pod čarou. Kolik stran dokument zabere a kolik vám zbývá, uvidíte před nahráním. Kvóty můžu podle kapacity měnit, už nahrané dokumenty kvůli tomu ale nemažu. Když se blíží limity bezplatných služeb, na kterých Vlastní soubory běží, přepnou se samy do režimu jen pro čtení (hledat, číst a mazat jde, nahrávat ne), případně se na čas vypnou.

**AI a citace.** Typ dokumentu (komentář, článek, kniha…), název, autory a další metadata navrhne jazykový model podle začátku dokumentu a asistent v dokumentu hledá hned po zpracování. Návrh se může splést: po rozkliknutí dokumentu v seznamu souborů ho kdykoli opravíte.

**Záloha není.** Originály si nechte u sebe: server je nikdy nedostane, takže vám je ani nemůže vrátit. Uložený text a metadata mimo krátkou historii změn databáze nezálohuji a za jejich ztrátu, třeba při výpadku nebo ukončení služby, neručím. Text svých dokumentů si ale můžete stáhnout odkazem „Stáhnout text“ u dokumentu v seznamu souborů (s denním limitem).

**Osobní údaje.** Jak s nimi zacházím, popisují [Zásady ochrany osobních údajů](/soukromi). Požádá-li mě někdo o výmaz údajů o sobě z nahraného dokumentu, dokument smažu a dám vám vědět.

**Nezákonný obsah.** Máte-li za to, že je ve Vlastních souborech nezákonný obsah (typicky porušení autorských práv), napište mi na ${MAIL}: o jaký dokument jde, proč je podle vás nezákonný, a své jméno a e-mail. Oznámení posoudím bez zbytečného odkladu. Nezákonný obsah nebo obsah v rozporu s těmito pravidly můžu odstranit, zabránit jeho opětovnému nahrání a přístup k Vlastním souborům omezit nebo zrušit. Tomu, koho se to týká, napíšu, co jsem udělal a proč, a může se proti tomu ohradit.

**Kontaktní místo.** Jednotným kontaktním místem pro orgány členských států, Evropskou komisi a Evropský sbor pro digitální služby (čl. 11 nařízení (EU) 2022/2065, akt o digitálních službách) i pro vás jako uživatele (čl. 12) je e-mail ${MAIL}. Psát na něj můžete česky nebo anglicky; odpovídám osobně, ne automat.

**Žádosti úřadů.** Požádá-li o údaje nebo dokumenty soud, policie či jiný orgán, vyhovím jen tak, jak to ukládá zákon, a jen v nezbytném rozsahu. Dám vám o tom vědět, pokud mi to zákon nezakazuje.

## Zotero (Pro)

V režimu Pro si můžete k Dawmainu připojit svou knihovnu v Zoteru (zotero.org). Váš asistent v ní pak hledá a čte záznamy, poznámky, anotace a text příloh, včetně skupin, kterých jste v Zoteru členem. Při připojení si vyberete, jestli Dawmain smí knihovnu **jen číst**, nebo **číst a ukládat**: pak asistent může nalezené dokumenty uložit do vaší osobní knihovny jako nové záznamy. Stávající záznamy Dawmain nikdy nemění ani nemaže a do skupin nezapisuje.

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

**David Závada**, fyzická osoba
E-mail: ${MAIL}

## 2. Jaké údaje zpracovávám

- **Údaje o účtu** - e-mailová adresa, jméno a identifikátor účtu (při přihlášení účtem Google je předá Google).
- **Provozní záznamy a přehled o používání** - čas požadavku, volaný nástroj, výsledek a IP adresa; počty volání u účtu, ze kterých vidím, kdo službu používá, jak často a které nástroje.
- **Vlastní soubory (Pro)** - text dokumentů, které nahrajete, jejich metadata (název, autoři, rok, typ, název souboru) a záznam o tom, kdy jste je nahráli, upravili, stáhli nebo smazali. Dokumenty mohou obsahovat i osobní údaje jiných lidí, například jména autorů.
- **Zotero (Pro)** - zašifrovaný klíč k vaší knihovně a vaše uživatelské jméno a identifikátor v Zoteru.

Údaje o účtu jsou pro poskytování služby nezbytné; bez nich účet nelze vytvořit. Provozní záznamy vznikají automaticky při každém použití služby. Nahrávání dokumentů a připojení Zotera jsou dobrovolné. Obsah rešerší si neukládám a s vaším účtem ho nespojuji.

## 3. Účel a právní základ

- **plnění smlouvy** (čl. 6 odst. 1 písm. b) GDPR): vedení účtu, přihlášení, Vlastní soubory včetně návrhu metadat (bod 5) a připojení Zotera;
- **oprávněný zájem** (čl. 6 odst. 1 písm. f) GDPR): provozní záznamy, hlídání limitů, ochrana služby před zneužitím, záznam o provedeném výmazu a přehled o tom, kdo a jak službu používá, abych ji mohl rozvíjet. Přehled je jen pro mě, k marketingu ho nepoužívám, nikomu ho nedávám a nepoužívám žádné analytické nástroje třetích stran. Na oprávněném zájmu stojí i zpracování osobních údajů jiných lidí v nahraných dokumentech - jen v rozsahu potřebném k tomu, aby v nich váš asistent mohl hledat. Proti zpracování na základě oprávněného zájmu můžete vznést námitku.

## 4. Doba uchování

- Údaje o účtu - dokud účet trvá; o jeho smazání můžete kdykoli požádat e-mailem.
- Provozní záznamy hostingu (včetně IP adresy) - nejdéle 30 dní; počty volání u účtu nejdéle 12 měsíců.
- Vlastní soubory a záznamy o práci s nimi - dokud dokument nesmažete, nejdéle však do zrušení účtu nebo odebrání Pro. Pak knihovnu do týdne smažu (do té doby si po odebrání Pro můžete stáhnout text svých dokumentů). Smazaný dokument zůstane nejdéle 6 hodin v historii změn databáze pro obnovu po havárii. Po výmazu knihovny si ponechám jen záznam o výmazu (identifikátor knihovny, datum a počet smazaných dokumentů), dokud může být potřeba výmaz doložit.
- Klíč k Zoteru, uživatelské jméno a identifikátor - dokud Zotero neodpojíte nebo nezrušíte účet. Přestane-li klíč platit, smažu ho a do opětovného připojení, odpojení nebo zrušení účtu si ponechám jen uživatelské jméno a čas, kdy klíč přestal platit.

## 5. Komu údaje předávám

Na provozu se podílejí tři zpracovatelé:

- **Clerk, Inc.** - přihlašování a správa účtů,
- **Vercel, Inc.** - hosting (Frankfurt) a služba AI Gateway, přes kterou využívám jazykový model Gemini od Google (viz níže),
- **Neon, Inc.** - databáze Vlastních souborů (Frankfurt).

**Návrh metadat přes Gemini.** Po nahrání dokumentu pošlu přes AI Gateway modelu Gemini (Google, dodavatel Vercelu) výňatek z dokumentu, ne celý text: úvodní strany, tiráž, seznam autorů, osnovu nadpisů a záhlaví stran (dohromady nejvýš 16 000 znaků), název souboru a u PDF údaje z jeho vlastností. Účelem je jen navrhnout typ dokumentu, název, autory, rok a podobné údaje, které pak můžete opravit. Právní základ je stejný jako u Vlastních souborů (bod 3). Výňatek může obsahovat osobní údaje lidí uvedených v dokumentu, typicky jména autorů. Vaše jméno ani e-mail s ním neposílám; AI Gateway dostane jen pseudonym kvůli rozpočtu spotřeby. Text se nepoužije k trénování modelů a Vercel ho po vyřízení požadavku smaže.

Jde o americké společnosti; předávání do USA se opírá o EU-US Data Privacy Framework. Jinak údaje předám jen orgánům veřejné moci, ukládá-li mi to zákon. Přihlášení účtem Google se řídí [zásadami ochrany soukromí Google](https://policies.google.com/privacy).

## 6. Zabezpečení

Komunikace probíhá výhradně přes HTTPS. Knihovny Vlastních souborů jsou v databázi od sebe oddělené a klíč k Zoteru je šifrovaný. Používám jen cookies nezbytné pro přihlášení, žádné analytické ani reklamní.

## 7. Vaše práva

Máte právo:

- na přístup ke svým osobním údajům,
- na opravu nepřesných údajů,
- na výmaz údajů,
- na omezení zpracování a na přenositelnost údajů,
- vznést námitku proti zpracování na základě oprávněného zájmu,
- podat stížnost u Úřadu pro ochranu osobních údajů ([uoou.gov.cz](https://uoou.gov.cz)).

Pro uplatnění svých práv mě kontaktujte na ${MAIL}; odpovím do měsíce.`,
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
