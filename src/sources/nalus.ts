import { SourceError } from "./shared/errors";
import { CookieSession, fetchUpstream, type UpstreamOptions } from "./shared/http";
import { htmlToText, loadHtml } from "./shared/html";
import { czechToIso, isoToCzech } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * NALUS — Ústavní soud decisions (nalus.usoud.cz, ASP.NET WebForms).
 *
 * Document retrieval (GetText.aspx?sz=…, GetAbstract.aspx?sz=…) is fully
 * stateless. Search is a 3-request dance that needs the ASP.NET session
 * cookie across its own steps only: GET the form (viewstate + cookies),
 * POST the criteria with redirect:"manual" (302 → results exist, 200 with
 * the zero-hits marker → none), then GET Results.aspx?page={N} with the
 * cookies. A finished search's session is kept for its own criteria, so the
 * next page of the same search is one GET. See docs/research/cz-sources.json.
 */

const SOURCE = "Ústavní soud (NALUS)";
const BASE = "https://nalus.usoud.cz/Search";

/** sz identifier: {registry}-{number}-{yy}[_{counter}], registry 1|2|3|4|Pl|St. */
export function isValidSz(sz: string): boolean {
  return /^(1|2|3|4|Pl|St)-\d+-\d{2}(_\d+)?$/.test(sz);
}

/** ECLI:CZ:US:2026:1.US.1169.26.1 → 1-1169-26_1 (Pl.US → Pl, Pl.US-st → St). */
export function ecliToSz(ecli: string): string | null {
  const m = /^ECLI:CZ:US:\d{4}:(.+)$/i.exec(ecli.trim());
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length < 4) return null;
  const [senate, us, num, yy, ord] = parts;
  if (!/^US(-st)?$/i.test(us)) return null;
  const registry = /-st$/i.test(us) ? "St" : senate === "Pl" ? "Pl" : senate;
  if (!/^(1|2|3|4|Pl|St)$/.test(registry)) return null;
  return `${registry}-${num}-${yy}${ord ? `_${ord}` : ""}`;
}

// ---------- decision detail (stateless) ----------

export interface NalusDecision {
  sz: string;
  registrySign?: string;
  form?: string;
  popularName?: string;
  text: string;
  url: string;
}

/**
 * Strip the RTF control words the court leaves in docContentHidden. "\par "
 * leaves "\n " behind, so the spaces around each break go too: otherwise
 * every paragraph starts with a space and a blank line holds one, which
 * kept runs of empty lines out of the \n{3,} collapse (live 2-1808-26_1:
 * "V Brně 30. června 2026\n \n \n \n Veronika Křesťanová v. r.").
 */
export function stripRtfMarkers(raw: string): string {
  return raw
    .replace(/\\par\b/g, "\n")
    .replace(/\\b0?\b/g, "")
    .replace(/\\[a-z]+\d*\b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse a GetText.aspx page. Pure — unit-tested. The text is read FIRST: the
 * page carries the whole decision twice, so a decision that merely quotes
 * the word "nenalezeno" (a search protocol: "při prohlídce nic nenalezeno")
 * must not read as NALUS's not-found page. The not-found markers decide only
 * when the page has no text at all.
 */
export function parseNalusDecision(html: string, sz: string): NalusDecision {
  const notFound = () =>
    new SourceError(
      SOURCE,
      "NOT_FOUND",
      `NALUS has no document for sz=${sz}.`,
      "Check the identifier (e.g. '1-1169-26_1' for I.ÚS 1169/26 #1) or find it via us_search. A docket can hold several decisions — try counter suffixes _1, _2.",
    );
  if (html.length < 6000) throw notFound();
  const $ = loadHtml(html);
  const hiddenContent = $("input#docContentHidden").attr("value");
  const text = hiddenContent
    ? stripRtfMarkers(hiddenContent)
    : htmlToText($("td.DocContent").html() ?? "");
  if (!text) {
    if (html.includes("nenalezeno")) throw notFound();
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NALUS document page for sz=${sz} has neither docContentHidden nor td.DocContent.`,
      "The site layout may have changed — run dawmain_probe_sources (canary 'nalus') with include_raw.",
    );
  }
  return {
    sz,
    registrySign: $("span#lblRegistrySign").text().trim() || undefined,
    form: $("span#lblDecisionForm").text().trim() || undefined,
    popularName: $("span#lblPopularName").text().trim() || undefined,
    text,
    url: `${BASE}/GetText.aspx?sz=${sz}`,
  };
}

/**
 * The decision's ECLI, rebuilt from its sz and the year in lblRegistrySign
 * ("I.ÚS 1169/26 ze dne 7. 7. 2026") — the inverse of ecliToSz. GetText.aspx
 * prints no ECLI, and clients read only the text, so without this a ÚS ECLI
 * never reached the model. Undefined without a counter or a year. Pure.
 */
export function nalusEcli(sz: string, registrySign: string | undefined): string | undefined {
  const m = /^(1|2|3|4|Pl|St)-(\d+)-(\d{2})_(\d+)$/.exec(sz);
  const year = registrySign ? /ze dne\s+\d{1,2}\.\s*\d{1,2}\.\s*(\d{4})/.exec(registrySign)?.[1] : undefined;
  if (!m || !year) return undefined;
  const [, registry, num, yy, counter] = m;
  const senate = registry === "St" ? "Pl.US-st" : `${registry}.US`;
  return `ECLI:CZ:US:${year}:${senate}.${num}.${yy}.${counter}`;
}

export interface NalusAbstract {
  abstract?: string;
  legalSentence?: string;
}

/** NALUS fills an empty slot with a placeholder sentence — not a holding. */
const PLACEHOLDER = /^(?:Abstrakt|Právní věta) není k dispozici\.?$/i;

/** Parse a GetAbstract.aspx page. Pure. Placeholders come back undefined. */
export function parseNalusAbstract(html: string): NalusAbstract {
  const $ = loadHtml(html);
  const read = (selector: string) => {
    const value = htmlToText($(selector).html() ?? "");
    return value && !PLACEHOLDER.test(value.trim()) ? value : undefined;
  };
  return { abstract: read("table.abstractContent td"), legalSentence: read("table.legalSentenceContent td") };
}

const decisionCache = new TtlCache<NalusDecision & NalusAbstract & { abstractUnavailable?: true }>(DOCUMENT_TTL_MS, 24);
const searchCache = new TtlCache<NalusSearchPage>(SEARCH_TTL_MS);

/** Options every NALUS call takes from a tool that answers within a budget. */
export interface NalusCallOptions {
  /** Epoch ms by which every request must have ended. Default: no budget
   * beyond fetchUpstream's own per-request timeout and retry. */
  deadlineAt?: number;
}

/** fetchUpstream's per-request timeout — never exceeded, only shortened. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A request with less time than this left is not worth starting. */
const MIN_ATTEMPT_MS = 2_000;
/** fetchUpstream's longest back-off before its retry (2 s after a 429). */
const RETRY_PAUSE_MS = 2_000;

/**
 * fetchUpstream bounded by the caller's deadline. Unbounded, a search's three
 * steps (form GET with its retry, POST, results GET with its retry) reached
 * ~78 s — past the route's 60 s maxDuration, where Vercel kills the call and
 * the model gets a transport failure instead of an error it can act on. Each
 * request gets at most the time left, and a GET retries only when the whole
 * retry (attempt, back-off, attempt) still fits.
 */
async function nalusFetch(
  url: string,
  options: UpstreamOptions,
  deadlineAt: number | undefined,
): Promise<Response> {
  if (deadlineAt === undefined) return fetchUpstream(SOURCE, url, options);
  const left = deadlineAt - Date.now();
  if (left < MIN_ATTEMPT_MS) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_UNREACHABLE",
      "NALUS did not finish within this call's time budget (timed out).",
      "NALUS is answering slowly — try again in a minute, or narrow the search (a date range, types) so it answers faster.",
    );
  }
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, left);
  const retry = (options.retry ?? (options.method ?? "GET") === "GET") && left >= 2 * timeoutMs + RETRY_PAUSE_MS;
  return fetchUpstream(SOURCE, url, { ...options, timeoutMs, retry });
}

export async function getNalusDecision(
  sz: string,
  options: NalusCallOptions = {},
): Promise<NalusDecision & NalusAbstract & { abstractUnavailable?: true }> {
  if (!isValidSz(sz)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${sz}" is not a NALUS sz identifier.`,
      "Use '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. '1-1169-26_1' (I.ÚS 1169/26) or 'Pl-24-10_1'. An ECLI works too — pass it as 'ecli'.",
    );
  }
  const key = memoKey("nalus-doc", [sz]);
  const result = await decisionCache.through(key, async () => {
    const [decisionResponse, abstractResponse] = await Promise.all([
      nalusFetch(`${BASE}/GetText.aspx?sz=${sz}`, {}, options.deadlineAt),
      nalusFetch(`${BASE}/GetAbstract.aspx?sz=${sz}`, {}, options.deadlineAt).catch(() => null),
    ]);
    const decision = parseNalusDecision(await decisionResponse.text(), sz);
    if (!abstractResponse) return { ...decision, abstractUnavailable: true as const };
    return { ...decision, ...parseNalusAbstract(await abstractResponse.text()) };
  });
  // A GetAbstract that failed (or was cut short by a preview's deadline) is
  // not "no právní věta": the text is served, but not kept for 10 minutes
  // without its právní věta — the next read asks again.
  if (result.abstractUnavailable) decisionCache.delete(key);
  return result;
}

// ---------- search (3-step viewstate dance) ----------

export interface NalusSearchInput {
  query?: string;
  citace?: string;
  ecli?: string;
  popularName?: string;
  dateFrom?: string; // ISO — datum rozhodnutí
  dateTo?: string; // ISO
  publishedFrom?: string; // ISO — datum zpřístupnění (availableFrom)
  publishedTo?: string; // ISO
  types?: Array<"nález" | "usnesení" | "stanovisko">;
  /** Jen rozhodnutí publikovaná ve Sbírce zákonů / SbNU. */
  onlyPublished?: boolean;
  /** Add odlišná stanoviska to the zones the full-text query searches. */
  includeDissents?: boolean;
  contestedOrgan?: string; // dotčený orgán (specifikace, free text)
  contestedActNumber?: string; // napadený akt (číslo), e.g. "106/1999"
  contestedActName?: string; // napadený akt (název), free text
  contestedActClause?: string; // napadený akt (ustanovení), e.g. "§ 17"
  sort?: "date" | "relevance";
  // The six číselník pickers below are REJECTED (see NALUS_PICKERS): NALUS
  // ignores whatever is posted into them. Kept in the type so a caller that
  // passes one fails loudly instead of compiling into a silent no-op.
  judge?: string; // soudce zpravodaj
  dissentingJudge?: string; // soudce s odlišným stanoviskem
  outcome?: string[]; // výrok — NALUS_OUTCOMES
  petitioner?: string[]; // navrhovatel (typ) — NALUS_PETITIONERS
  contestedOrganType?: string[]; // dotčený orgán (typ) — NALUS_ORGAN_TYPES
  contestedActKind?: string[]; // napadený akt (druh) — NALUS_ACT_KINDS
}

/**
 * The form's číselník fields — soudce zpravodaj, soudce s odlišným
 * stanoviskem, výrok, navrhovatel, dotčený orgán (typ), napadený akt (druh).
 * They are readonly TextBoxes (readonly="readonly" class="searchCiselnik")
 * filled by the PopupCiselnik.aspx dialog, and ASP.NET's TextBox ignores a
 * posted value when ReadOnly is set: the selection lives server-side. Live
 * (2026-09, nálezy 2010-01-01..2010-03-31): no filter 71 hits; judge
 * 'Wagnerová' (any name order), outcome ['zamítnuto'], petitioner ['SKUPINA
 * POSLANCŮ'] + act kind ['zákon'] — each the byte-identical 71, senate cases
 * of other rapporteurs included; dissenting_judge alone gave NALUS no
 * criterion at all. The popup cannot be replayed without a captured browser
 * flow (fetched sessionless, PopupCiselnik.aspx only bounces to the search
 * form), so until it is, a picker is refused before any request — an
 * unfiltered list presented as filtered is a wrong legal answer. Keys are the
 * NalusSearchInput fields; values the us_search parameter names.
 */
export const NALUS_PICKERS = {
  judge: "judge",
  dissentingJudge: "dissenting_judge",
  outcome: "outcome",
  petitioner: "petitioner",
  contestedOrganType: "contested_organ_type",
  contestedActKind: "contested_act_kind",
} as const;

/** What still narrows a NALUS search — the hint whenever a picker is refused. */
export const NALUS_WORKING_FILTERS =
  "query (the soudce zpravodaj's name also stands in the decision text), case_number, ecli, popular_name, contested_act_number / contested_act_name / contested_act_clause, contested_organ, date_from/date_to, published_from/published_to, types, only_published, include_dissents (full-text zone) and sort";

/** The picker parameters (us_search names) set in this input. */
export function nalusPickersIn(input: Partial<Record<keyof typeof NALUS_PICKERS, unknown>>): string[] {
  return (Object.keys(NALUS_PICKERS) as Array<keyof typeof NALUS_PICKERS>)
    .filter((key) => {
      const value = input[key];
      return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : false;
    })
    .map((key) => NALUS_PICKERS[key]);
}

export function nalusPickerError(pickers: string[]): SourceError {
  return new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `NALUS ignores its číselník filters — ${pickers.join(", ")} would come back UNFILTERED (the same list and total as without ${pickers.length > 1 ? "them" : "it"}), so the call was refused.`,
    `Drop ${pickers.join(", ")} and narrow with what works: ${NALUS_WORKING_FILTERS}. Each hit line names its soudce zpravodaj, so a judge can be screened from the list.`,
  );
}

/**
 * The full-text value NALUS can match: any token containing '§' makes it
 * answer 0 (live 2026-09: the same variant 42 hits without '§ ', 0 with it),
 * and '§' is never a searchable token. Pure.
 */
export function nalusQueryText(query: string): string {
  return query.replace(/§+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The criteria as NALUS sees them, in a fixed key order — the cache key.
 * caselaw_search's ÚS lane passes {query, dateFrom, dateTo, sort} while
 * us_search passes every field (false booleans, undefined…); hashed raw, the
 * same effective search never shared its cached page. Drops blanks, false
 * flags, includeDissents without a query and a types list naming all three
 * (the default); trims; sorts types; folds sort undefined → "date". Refuses
 * the pickers before any I/O. Pure — unit-tested.
 */
export function normalizeNalusInput(input: NalusSearchInput): NalusSearchInput {
  const pickers = nalusPickersIn(input);
  if (pickers.length) throw nalusPickerError(pickers);
  const text = (value: string | undefined) => value?.trim() || undefined;
  const query = input.query === undefined ? undefined : nalusQueryText(input.query) || undefined;
  const order = ["nález", "usnesení", "stanovisko"] as const;
  const types = order.filter((type) => input.types?.includes(type));
  const normalized: NalusSearchInput = {
    query,
    citace: text(input.citace),
    ecli: text(input.ecli),
    popularName: text(input.popularName),
    dateFrom: text(input.dateFrom),
    dateTo: text(input.dateTo),
    publishedFrom: text(input.publishedFrom),
    publishedTo: text(input.publishedTo),
    types: types.length && types.length < order.length ? [...types] : undefined,
    onlyPublished: input.onlyPublished || undefined,
    includeDissents: (query && input.includeDissents) || undefined,
    contestedOrgan: text(input.contestedOrgan),
    contestedActNumber: text(input.contestedActNumber),
    contestedActName: text(input.contestedActName),
    contestedActClause: text(input.contestedActClause),
    sort: input.sort === "relevance" ? "relevance" : "date",
  };
  // JSON.stringify drops undefined fields; delete them all the same so the
  // object is what it looks like to a caller that inspects it.
  for (const key of Object.keys(normalized) as Array<keyof NalusSearchInput>) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}

// Codebook values verbatim from a captured browser POST (2026-08) where every
// picker item was selected — including oddities like the double space in
// "procesní -  změna návrhu". Some titles contain ", " themselves; the wire
// format joins selections with ", " all the same, mirroring the UI. Kept for
// when the PopupCiselnik flow is replayed: posting them into the readonly
// fields does nothing (see NALUS_PICKERS).

export const NALUS_OUTCOMES = [
  "odmítnuto pro neodstraněné vady",
  "odmítnuto pro nedodržení lhůty",
  "odmítnuto pro neoprávněnost navrhovatele",
  "odmítnuto pro nepříslušnost",
  "odmítnuto pro nepřípustnost",
  "odmítnuto pro zjevnou neopodstatněnost",
  "odmítnuto - jiný procesní návrh",
  "rozpor mezinárodní smlouvy s ústavou",
  "soulad mezinárodní smlouvy s ústavou",
  "vyhověno",
  "výrok interpretativní",
  "výrok aditivní",
  "udělení výtky",
  "vykonatelnost odložená - § 58/1",
  "vykonatelnost dřívější - § 58/1",
  "zamítnuto",
  "zastaveno",
  "procesní - atrahováno plénem",
  "procesní - náhrada nákladů řízení - § 62",
  "procesní - náhrada nákladů zastoupení - § 83, 84",
  "procesní - naléhavost věci",
  "procesní - odložení vykonatelnosti",
  "procesní - opravné usnesení",
  "procesní - pokračování v řízení",
  "procesní - pořádková pokuta",
  "procesní - postoupení",
  "procesní - předběžné opatření",
  "procesní - předběžná otázka",
  "procesní - přerušení řízení - jiné",
  "procesní - přerušení řízení - § 78/1",
  "procesní - přerušení řízení - § 78/2",
  "procesní - přibrání tlumočníka",
  "procesní - spojení věcí",
  "procesní - svědečné, tlumočné, znalečné",
  "procesní - účastenství v řízení",
  "procesní - uložení povinnosti",
  "procesní - ustanovení opatrovníka",
  "procesní - ustanovení znalce",
  "procesní - volba kárného senátu (§ 139/2)",
  "procesní - vrácení soudního poplatku",
  "procesní - vyloučení k samostatnému řízení",
  "procesní - vyloučení soudce, asistenta, apod.",
  "procesní - zahájení řízení",
  "procesní -  změna návrhu",
  "procesní - návrh plénu na zrušení právního předpisu",
  "odmítnuto - pro 2b",
  "nevyřízeno",
  "odloženo",
  "vyřízeno jinak",
] as const;

export const NALUS_PETITIONERS = [
  "STĚŽOVATEL - FO",
  "STĚŽOVATEL - PO",
  "SKUPINA POSLANCŮ",
  "SKUPINA SENÁTORŮ",
  "SOUD",
  "MINISTERSTVO",
  "KRAJ / ZASTUPITELSTVO KRAJE",
  "OBEC / ZASTUPITELSTVO OBCE",
  "PLÉNUM ÚS",
  "POLITICKÁ / VOLEBNÍ STRANA",
  "POSLANEC",
  "PREZIDENT REPUBLIKY",
  "PŘEDNOSTA OKRESNÍHO ÚŘADU",
  "PŘEDSEDA POSLANECKÉ SNĚMOVNY PČR",
  "PŘEDSEDA SENÁTU PČR",
  "PŘEDSEDA ÚS",
  "RADA PRO ROZHLASOVÉ A TELEVIZNÍ VYSÍLÁNÍ",
  "ŘEDITEL KRAJSKÉHO ÚŘADU",
  "SENÁT PARLAMENTU ČR",
  "SENÁT ÚS",
  "SENÁTOR",
  "STÁTNÍ ORGÁN JINÝ",
  "VEŘEJNÝ OCHRÁNCE PRÁV",
  "VLÁDA",
] as const;

export const NALUS_ORGAN_TYPES = [
  "SOUD",
  "STÁTNÍ ZASTUPITELSTVÍ",
  "POLICIE",
  "ARMÁDA",
  "VOJSKO",
  "BEZPEČNOSTNÍ INFORMAČNÍ SLUŽBA",
  "CELNÍ ÚŘAD / ŘEDITELSTVÍ",
  "ČESKÁ INSPEKCE ŽIVOTNÍHO PROSTŘEDÍ",
  "ČESKÁ NÁRODNÍ BANKA",
  "ČESKÁ OBCHODNÍ INSPEKCE",
  "ČESKÁ SPRÁVA SOCIÁLNÍHO ZABEZPEČENÍ",
  "ČESKÝ BÁŇSKÝ ÚŘAD",
  "ČESKÝ TELEKOMUNIKAČNÍ ÚŘAD",
  "ČESKÝ ÚŘAD ZEMĚMĚŘICKÝ A KATASTRÁLNÍ",
  "ENERGETICKÝ REGULAČNÍ ÚŘAD",
  "FINANČNÍ ÚŘAD / ŘEDITELSTVÍ",
  "KATASTRÁLNÍ ÚŘAD",
  "KOMISE PRO CENNÉ PAPÍRY",
  "KRAJ / KRAJSKÝ ÚŘAD",
  "MINISTERSTVO / MINISTR",
  "NÁRODNÍ BEZPEČNOSTNÍ ÚŘAD",
  "NÁRODNÍ PAMÁTKOVÝ ÚSTAV",
  "OBEC / OBECNÍ ÚŘAD / MAGISTRÁT",
  "OCHRÁNCE PRÁV DĚTÍ",
  "POSLANECKÁ SNĚMOVNA PARLAMENTU ČR",
  "POZEMKOVÝ FOND",
  "PREZIDENT REPUBLIKY",
  "PROFESNÍ KOMORA",
  "RADA PRO ROZHLASOVÉ A TELEVIZNÍ VYSÍLÁNÍ",
  "SENÁT PARLAMENTU ČR",
  "SOUDNÍ EXEKUTOR",
  "STÁTNÍ ÚŘAD PRO JADERNOU BEZPEČNOST",
  "ÚŘAD EVROPSKÉHO VEŘEJNÉHO ŽALOBCE",
  "ÚŘAD PRÁCE",
  "ÚŘAD PRO OCHRANU HOSPODÁŘSKÉ SOUTĚŽE",
  "ÚŘAD PRO OCHRANU OSOBNÍCH ÚDAJŮ",
  "ÚŘAD PRO ZASTUPOVÁNÍ STÁTU VE VĚCECH MAJETKOVÝCH",
  "ÚŘAD PRŮMYSLOVÉHO VLASTNICTVÍ",
  "ÚSTAVNÍ SOUD",
  "VEŘEJNÝ OCHRÁNCE PRÁV",
  "VĚZEŇSKÁ SLUŽBA",
  "VLÁDA / PŘEDSEDA VLÁDY",
  "ZDRAVOTNÍ POJIŠŤOVNA",
  "JINÝ ORGÁN VEŘEJNÉ MOCI",
] as const;

export const NALUS_ACT_KINDS = [
  "rozhodnutí soudu",
  "rozhodnutí správní",
  "rozhodnutí jiné",
  "jiný zásah orgánu veřejné moci",
  "zákon",
  "jiný právní předpis",
  "obecně závazná vyhláška obce/kraje",
  "nařízení obce/kraje",
  "mezinárodní smlouva",
  "rozhodnutí Ústavního soudu",
  "opatření obecné povahy",
  "interní předpis (normativní instrukce)",
  "ostatní (nezařaditelné)",
] as const;

const foldValue = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Map user-supplied values onto the canonical codebook titles the form posts
 * (case/diacritics/whitespace-insensitive). Unknown values fail loudly with
 * the whole menu — a typo must not degrade into an unfiltered search.
 */
export function resolveNalusValues(
  values: string[],
  canonical: readonly string[],
  criterion: string,
): string[] {
  const byFold = new Map(canonical.map((title) => [foldValue(title), title]));
  return values.map((value) => {
    const match = byFold.get(foldValue(value));
    if (!match) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `"${value}" is not a NALUS ${criterion} value.`,
        `Valid values: ${canonical.join("; ")}.`,
      );
    }
    return match;
  });
}

export interface NalusHit {
  sz: string | null;
  caseNumber: string;
  ecli?: string;
  judge?: string;
  citation?: string;
  form?: string;
  date?: string; // ISO
  url: string | null;
}

export interface NalusSearchPage {
  hits: NalusHit[];
  total: number | null;
  empty: boolean;
}

export const ZERO_HITS_MARKER = "nebyly nalezeny žádné záznamy";

/** Parse a Results.aspx page. Pure — unit-tested against a live fixture. */
export function parseNalusResults(html: string): NalusSearchPage {
  const $ = loadHtml(html);

  const banner = /Výsledky\s+\d+\s*-\s*\d+\s+z\s+celkem\s+(\d+)/.exec(html);
  const total = banner ? Number(banner[1]) : null;

  // Each hit is two rows: the data row holding the ResultDetail anchor, then
  // its actions row, whose onclick handlers carry ShowLink("…GetText.aspx?sz=…",
  // "Odkaz") and ShowLink("usnesení sp. zn. … ze dne …", "Citace"). Both are
  // read from THAT row: zipped by position across the page, one row without a
  // link moved every later sz onto the next decision — cite one, read another.
  const hits: NalusHit[] = [];
  $("a[href^='ResultDetail.aspx']").each((_, el) => {
    const $anchor = $(el);
    const caseNumber = $anchor.text().trim();
    if (!caseNumber) return;
    // The anchor's cell stacks case number <br/> ECLI <br/> reporting judge.
    const cellText = htmlToText($anchor.closest("td").html() ?? "");
    const lines = cellText.split("\n").map((line) => line.trim()).filter(Boolean);
    const ecli = lines.find((line) => line.startsWith("ECLI:"));
    const judge = lines.filter((line) => line !== caseNumber && !line.startsWith("ECLI:")).at(-1);
    const $dataRow = $anchor.closest("tr");
    const handlers = $dataRow
      .next("tr")
      .find("[onclick]")
      .map((_, node) => $(node).attr("onclick") ?? "")
      .get()
      .join("\n");
    const sz = /GetText\.aspx\?sz=([^"&\s]+)/.exec(handlers)?.[1] ?? null;
    const citation = /ShowLink\("((?:nález|usnesení|stanovisko)[^"]*)",\s*"Citace"/.exec(handlers)?.[1];
    const hit: NalusHit = { sz, caseNumber, ecli, judge, url: sz ? `${BASE}/GetText.aspx?sz=${sz}` : null };
    if (citation) {
      hit.citation = citation;
      hit.form = citation.split(" ")[0];
      hit.date = nalusCitationDate(citation);
    } else {
      // No citation to read them from: the data row's own cells — the bold
      // decision date and the "Forma rozhodnutí" cell ("Usnesení<br/>4").
      const cells = $dataRow.children("td");
      const date = czechToIso(cells.find("b").first().text().trim());
      if (date) hit.date = date;
      const formCell = cells
        .map((_, cell) => htmlToText($(cell).html() ?? "").split("\n")[0]?.trim() ?? "")
        .get()
        .find((line) => /^(nález|usnesení|stanovisko)$/i.test(line));
      if (formCell) hit.form = formCell.toLowerCase();
    }
    hits.push(hit);
  });

  if (!hits.length && total === null) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NALUS results page has neither hits nor a count banner.",
      "The layout may have changed — run dawmain_probe_sources with include_raw.",
    );
  }
  return { hits, total, empty: false };
}

/**
 * Decision date from a NALUS citation. Published decisions carry the
 * collection reference AFTER the date — "nález sp. zn. Pl. ÚS 24/10 ze dne
 * 22. 3. 2011 (N 52/60 SbNU 625; 94/2011 Sb.)" — so the date is read where
 * it stands, not from the end of the string (which left exactly the
 * published, citable decisions without a date). Pure — unit-tested.
 */
export function nalusCitationDate(citation: string): string | undefined {
  const m = /ze dne\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/.exec(citation);
  return m ? (czechToIso(m[1]) ?? undefined) : undefined;
}

/** Harvest the WebForms state fields from the search form. Pure. */
export function parseFormState(html: string): Record<string, string> {
  const $ = loadHtml(html);
  const state: Record<string, string> = {};
  for (const name of ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]) {
    const value = $(`input[name='${name}']`).attr("value");
    if (value === undefined) {
      throw new SourceError(
        SOURCE,
        "PARSE_DRIFT",
        `NALUS search form is missing ${name}.`,
        "The form layout may have changed — run dawmain_probe_sources with include_raw.",
      );
    }
    state[name] = value;
  }
  return state;
}

const MC = "ctl00$MainContent$";

/** Build the POST body for the search step. Pure — unit-tested. */
export function buildNalusForm(
  state: Record<string, string>,
  input: NalusSearchInput,
  pageSize: number,
): URLSearchParams {
  const form = new URLSearchParams();
  form.set("__EVENTTARGET", "");
  form.set("__EVENTARGUMENT", "");
  for (const [key, value] of Object.entries(state)) form.set(key, value);
  form.set(`${MC}but_search`, "Vyhledat");

  const types = input.types?.length ? input.types : ["nález", "usnesení", "stanovisko"];
  if (types.includes("nález")) form.set(`${MC}nalezy`, "on");
  if (types.includes("usnesení")) form.set(`${MC}usneseni`, "on");
  if (types.includes("stanovisko")) form.set(`${MC}stanoviska_plena`, "on");

  const query = input.query ? nalusQueryText(input.query) : "";
  if (query) {
    form.set(`${MC}text`, query);
    // Search the operative scopes; odlišné stanovisko joins only on request.
    const scopes = ["pravni_veta", "abstrakt", "naveti", "vyrok", "oduvodneni"];
    if (input.includeDissents) scopes.push("odlisne_stanovisko");
    for (const scope of scopes) {
      form.set(`${MC}${scope}`, "on");
    }
  }
  if (input.citace) form.set(`${MC}citace`, input.citace);
  if (input.ecli) form.set(`${MC}ecli`, input.ecli);
  if (input.popularName) form.set(`${MC}popularni_nazev`, input.popularName);
  if (input.dateFrom) form.set(`${MC}decidedFrom`, isoToCzech(input.dateFrom));
  if (input.dateTo) form.set(`${MC}decidedTo`, isoToCzech(input.dateTo));
  if (input.publishedFrom) form.set(`${MC}availableFrom`, isoToCzech(input.publishedFrom));
  if (input.publishedTo) form.set(`${MC}availableTo`, isoToCzech(input.publishedTo));
  if (input.onlyPublished) form.set(`${MC}jen_publikovana`, "on");
  // The číselník pickers are never posted: NALUS ignores them (NALUS_PICKERS),
  // and searchNalus refuses an input that sets one.
  if (input.contestedOrgan) form.set(`${MC}affected_organ_spec`, input.contestedOrgan);
  if (input.contestedActNumber) form.set(`${MC}actkindnumber_txt`, input.contestedActNumber);
  if (input.contestedActName) form.set(`${MC}actkindname_txt`, input.contestedActName);
  if (input.contestedActClause) form.set(`${MC}actkindclause_txt`, input.contestedActClause);

  // razeni 2 = decision date desc, 5 = relevance ("významu").
  form.set(`${MC}razeni`, input.sort === "relevance" ? "5" : "2");
  form.set(`${MC}resultsPageSize`, String(pageSize));
  form.set(`${MC}resultsFontSize`, "10");
  return form;
}

/**
 * What a 200 answer to the criteria POST means (a 302 means hits). NALUS
 * re-renders its form in two cases: zero hits (the marker), or a search it
 * refused — and then any message it printed (lbError, a visible validator)
 * is the answer, not a layout change. Live 2026-09, swapped dates and a
 * citace failing the form's own pattern both came back as ordinary zero-hit
 * answers, so only a message actually printed is classified: an input
 * complaint as INPUT_INVALID, anything else as UPSTREAM_ERROR. PARSE_DRIFT
 * (and the probe hint) is left for a body that is not the form at all, or a
 * form that says nothing. Pure — unit-tested.
 */
export function classifyNalusPostBody(body: string): "zero-hits" {
  if (body.toLowerCase().includes(ZERO_HITS_MARKER)) return "zero-hits";
  const isForm = body.includes("__VIEWSTATE") && body.includes(`name="${MC}but_search"`);
  if (isForm) {
    const $ = loadHtml(body);
    const messages = $("[id$='lbError'], span[id*='Validator']")
      .filter((_, el) => !/display\s*:\s*none/i.test($(el).attr("style") ?? ""))
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    if (messages.length) {
      const message = messages.join(" ");
      if (/kritéri|zadejte|neplatn|vyberte/i.test(message)) {
        throw new SourceError(
          SOURCE,
          "INPUT_INVALID",
          `NALUS refused the search: "${message}".`,
          "Give at least one searchable criterion: query, case_number, ecli, popular_name, contested_act_number/name/clause, contested_organ or a date range.",
        );
      }
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `NALUS answered the search with: "${message}".`,
        "Try again in a minute; if the message repeats, change the criteria.",
      );
    }
  }
  throw new SourceError(
    SOURCE,
    "PARSE_DRIFT",
    `NALUS search POST answered HTTP 200 without the zero-hits marker${isForm ? " or any message" : ""}.`,
    "The form contract may have changed — run dawmain_probe_sources with include_raw.",
  );
}

/**
 * A finished search's session, kept for its own criteria only. NALUS pages a
 * search by a plain GET of Results.aspx?page=N on the session that POSTed it,
 * so the next page of the same criteria costs one request instead of the
 * whole form GET + POST + GET. Keyed by the normalized criteria and page size
 * (the POST fixes resultsPageSize), never shared across criteria — the
 * session stores them server-side. Under the ASP.NET 20-min session timeout.
 */
interface KeptSession {
  session: CookieSession;
  total: number | null;
}
const sessionCache = new TtlCache<KeptSession>(SEARCH_TTL_MS, 50);

/** Each criteria set's total, page-independent: what a multi-variant page
 * needs to avoid asking for rows past a variant's end. */
const totalCache = new TtlCache<number>(SEARCH_TTL_MS);

/** The total of these criteria if a search answered it in the last 5 min. */
export function knownNalusTotal(input: NalusSearchInput): number | undefined {
  try {
    return totalCache.get(memoKey("nalus-total", [normalizeNalusInput(input)]));
  } catch {
    return undefined;
  }
}

export async function searchNalus(
  input: NalusSearchInput,
  page: number,
  pageSize: 10 | 20 | 40 | 80 = 20,
  options: NalusCallOptions = {},
): Promise<NalusSearchPage> {
  // Normalized first: a refused picker costs no request, and the same
  // effective search shares one cache entry whoever asks (caselaw_search's
  // ÚS lane and a follow-up us_search sort=relevance alike).
  const criteria = normalizeNalusInput(input);
  return searchCache.through(memoKey("nalus-search", [criteria, page, pageSize]), () =>
    runSearchNalus(criteria, page, pageSize, options.deadlineAt),
  );
}

async function runSearchNalus(
  input: NalusSearchInput,
  page: number,
  pageSize: 10 | 20 | 40 | 80,
  deadlineAt: number | undefined,
): Promise<NalusSearchPage> {
  const hasCriterion =
    input.query ||
    input.citace ||
    input.ecli ||
    input.popularName ||
    input.dateFrom ||
    input.dateTo ||
    input.publishedFrom ||
    input.publishedTo ||
    input.contestedOrgan ||
    input.contestedActNumber ||
    input.contestedActName ||
    input.contestedActClause;
  if (!hasCriterion) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NALUS search needs at least one criterion.",
      "Provide query (full-text), case_number (citace), ecli, popular_name, a date range (decision or publication), or a contested_act/contested_organ filter.",
    );
  }
  const sessionKey = memoKey("nalus-session", [input, pageSize]);
  const kept = sessionCache.get(sessionKey);
  if (kept) {
    const reused = await readKeptPage(kept, page, pageSize, deadlineAt).catch(() => null);
    if (reused) return reused;
    sessionCache.delete(sessionKey);
  }

  const session = new CookieSession();

  // Step 1: the form — fresh viewstate every time (the tokens are per-GET).
  const formResponse = await nalusFetch(`${BASE}/Search.aspx`, {}, deadlineAt);
  session.absorb(formResponse);
  const state = parseFormState(await formResponse.text());

  // Step 2: the criteria POST. 302 → results in session; 200 → zero hits.
  const postResponse = await nalusFetch(
    `${BASE}/Search.aspx`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: session.header(),
        referer: `${BASE}/Search.aspx`,
      },
      body: buildNalusForm(state, input, pageSize).toString(),
      redirect: "manual",
    },
    deadlineAt,
  );
  session.absorb(postResponse);
  if (postResponse.status !== 302) {
    classifyNalusPostBody(await postResponse.text());
    totalCache.set(memoKey("nalus-total", [input]), 0);
    return { hits: [], total: 0, empty: true };
  }
  await postResponse.body?.cancel().catch(() => undefined);

  // Step 3: the results page (0-indexed), same session.
  const resultsResponse = await nalusFetch(
    `${BASE}/Results.aspx${page > 0 ? `?page=${page}` : ""}`,
    { headers: { cookie: session.header(), referer: `${BASE}/Search.aspx` } },
    deadlineAt,
  );
  session.absorb(resultsResponse);
  const parsed = parseNalusResults(await resultsResponse.text());
  sessionCache.set(sessionKey, { session, total: parsed.total });
  if (parsed.total !== null) totalCache.set(memoKey("nalus-total", [input]), parsed.total);
  return parsed;
}

/**
 * Page N from a kept session, or null when the session cannot be trusted.
 * What NALUS renders for an expired session is unknown (a redirect to the
 * form, an empty banner…), so a reply counts only when it is a 200 results
 * page whose banner total equals the one this session found, with hits
 * wherever the total says there are rows. No retry: the fallback is the full
 * dance, which has its own.
 */
async function readKeptPage(
  kept: KeptSession,
  page: number,
  pageSize: number,
  deadlineAt: number | undefined,
): Promise<NalusSearchPage | null> {
  const response = await nalusFetch(
    `${BASE}/Results.aspx${page > 0 ? `?page=${page}` : ""}`,
    {
      headers: { cookie: kept.session.header(), referer: `${BASE}/Results.aspx` },
      redirect: "manual",
      retry: false,
    },
    deadlineAt,
  );
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  kept.session.absorb(response);
  const body = await response.text();
  let parsed: NalusSearchPage;
  try {
    parsed = parseNalusResults(body);
  } catch {
    return null;
  }
  if (kept.total === null || parsed.total !== kept.total) return null;
  if (!parsed.hits.length && page * pageSize < kept.total) return null;
  // The rows must be THIS page's: should the session remember the last page
  // it served (Results.aspx without ?page= for page 0), the total and the
  // hits would still look right — the banner's first row number does not.
  const from = /Výsledky\s+(\d+)\s*-/.exec(body)?.[1];
  if (parsed.hits.length && Number(from) !== page * pageSize + 1) return null;
  return parsed;
}
