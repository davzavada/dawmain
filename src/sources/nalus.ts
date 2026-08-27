import { SourceError } from "./shared/errors";
import { CookieSession, fetchUpstream } from "./shared/http";
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
 * lbError → zero hits), then GET Results.aspx?page={N} with the cookies.
 * See docs/research/cz-sources.json.
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

/** Strip the RTF control words the court leaves in docContentHidden. */
export function stripRtfMarkers(raw: string): string {
  return raw
    .replace(/\\par\b/g, "\n")
    .replace(/\\b0?\b/g, "")
    .replace(/\\[a-z]+\d*\b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse a GetText.aspx page. Pure — unit-tested. */
export function parseNalusDecision(html: string, sz: string): NalusDecision {
  if (html.includes("nenalezeno") || html.length < 6000) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `NALUS has no document for sz=${sz}.`,
      "Check the identifier (e.g. '1-1169-26_1' for I.ÚS 1169/26 #1) or find it via nalus_search. A docket can hold several decisions — try counter suffixes _1, _2.",
    );
  }
  const $ = loadHtml(html);
  const hiddenContent = $("input#docContentHidden").attr("value");
  const text = hiddenContent
    ? stripRtfMarkers(hiddenContent)
    : htmlToText($("td.DocContent").html() ?? "");
  if (!text) {
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

export interface NalusAbstract {
  abstract?: string;
  legalSentence?: string;
}

/** Parse a GetAbstract.aspx page. Pure. */
export function parseNalusAbstract(html: string): NalusAbstract {
  const $ = loadHtml(html);
  const abstract = htmlToText($("table.abstractContent td").html() ?? "") || undefined;
  const legalSentence = htmlToText($("table.legalSentenceContent td").html() ?? "") || undefined;
  return { abstract, legalSentence };
}

const decisionCache = new TtlCache<NalusDecision & NalusAbstract>(DOCUMENT_TTL_MS, 24);
const searchCache = new TtlCache<NalusSearchPage>(SEARCH_TTL_MS);

export async function getNalusDecision(sz: string): Promise<NalusDecision & NalusAbstract> {
  if (!isValidSz(sz)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${sz}" is not a NALUS sz identifier.`,
      "Use '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. '1-1169-26_1' (I.ÚS 1169/26) or 'Pl-24-10_1'. An ECLI works too — pass it as 'ecli'.",
    );
  }
  return decisionCache.through(memoKey("nalus-doc", [sz]), async () => {
    const [decisionResponse, abstractResponse] = await Promise.all([
      fetchUpstream(SOURCE, `${BASE}/GetText.aspx?sz=${sz}`),
      fetchUpstream(SOURCE, `${BASE}/GetAbstract.aspx?sz=${sz}`).catch(() => null),
    ]);
    const decision = parseNalusDecision(await decisionResponse.text(), sz);
    const extras = abstractResponse ? parseNalusAbstract(await abstractResponse.text()) : {};
    return { ...decision, ...extras };
  });
}

// ---------- search (3-step viewstate dance) ----------

export interface NalusSearchInput {
  query?: string;
  citace?: string;
  ecli?: string;
  judge?: string; // soudce zpravodaj (free text)
  dissentingJudge?: string; // soudce s odlišným stanoviskem
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
  outcome?: string[]; // výrok — validated against NALUS_OUTCOMES
  petitioner?: string[]; // navrhovatel (typ) — NALUS_PETITIONERS
  contestedOrganType?: string[]; // dotčený orgán (typ) — NALUS_ORGAN_TYPES
  contestedOrgan?: string; // dotčený orgán (specifikace, free text)
  contestedActKind?: string[]; // napadený akt (druh) — NALUS_ACT_KINDS
  contestedActNumber?: string; // napadený akt (číslo), e.g. "106/1999"
  contestedActName?: string; // napadený akt (název), free text
  contestedActClause?: string; // napadený akt (ustanovení), e.g. "§ 17"
  sort?: "date" | "relevance";
}

// Codebook values verbatim from a captured browser POST (2026-08) where every
// picker item was selected — including oddities like the double space in
// "procesní -  změna návrhu". Some titles contain ", " themselves; the wire
// format joins selections with ", " all the same, mirroring the UI.

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
    hits.push({ sz: null, caseNumber, ecli, judge, url: null });
  });

  // The actions row emits ShowLink("…GetText.aspx?sz=…") and the citation
  // string ("usnesení sp. zn. I. ÚS 1169/26 ze dne 7. 7. 2026") in hit order.
  const szList = [...html.matchAll(/GetText\.aspx\?sz=([^"&\s]+)/g)].map((m) => m[1]);
  const citations = [...html.matchAll(/ShowLink\("((?:nález|usnesení|stanovisko)[^"]*)",\s*"Citace"/g)].map(
    (m) => m[1],
  );
  hits.forEach((hit, index) => {
    hit.sz = szList[index] ?? null;
    hit.url = hit.sz ? `${BASE}/GetText.aspx?sz=${hit.sz}` : null;
    const citation = citations[index];
    if (citation) {
      hit.citation = citation;
      hit.form = citation.split(" ")[0];
      const dateMatch = /ze dne\s+([\d.\s/]+)$/.exec(citation);
      if (dateMatch) hit.date = czechToIso(dateMatch[1]) ?? undefined;
    }
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

  if (input.query) {
    form.set(`${MC}text`, input.query);
    // Search the operative scopes; odlišné stanovisko joins only on request.
    const scopes = ["pravni_veta", "abstrakt", "naveti", "vyrok", "oduvodneni"];
    if (input.includeDissents) scopes.push("odlisne_stanovisko");
    for (const scope of scopes) {
      form.set(`${MC}${scope}`, "on");
    }
  }
  if (input.citace) form.set(`${MC}citace`, input.citace);
  if (input.ecli) form.set(`${MC}ecli`, input.ecli);
  if (input.judge) form.set(`${MC}soudce_zpravodaj`, input.judge);
  if (input.dissentingJudge) form.set(`${MC}soudce_stanovisko`, input.dissentingJudge);
  if (input.popularName) form.set(`${MC}popularni_nazev`, input.popularName);
  if (input.dateFrom) form.set(`${MC}decidedFrom`, isoToCzech(input.dateFrom));
  if (input.dateTo) form.set(`${MC}decidedTo`, isoToCzech(input.dateTo));
  if (input.publishedFrom) form.set(`${MC}availableFrom`, isoToCzech(input.publishedFrom));
  if (input.publishedTo) form.set(`${MC}availableTo`, isoToCzech(input.publishedTo));
  if (input.onlyPublished) form.set(`${MC}jen_publikovana`, "on");
  if (input.outcome?.length) {
    form.set(`${MC}vyrok_multi`, resolveNalusValues(input.outcome, NALUS_OUTCOMES, "výrok").join(", "));
  }
  if (input.petitioner?.length) {
    form.set(
      `${MC}navrhovatel`,
      resolveNalusValues(input.petitioner, NALUS_PETITIONERS, "navrhovatel").join(", "),
    );
  }
  if (input.contestedOrganType?.length) {
    form.set(
      `${MC}affected_organ_type`,
      resolveNalusValues(input.contestedOrganType, NALUS_ORGAN_TYPES, "dotčený orgán").join(", "),
    );
  }
  if (input.contestedOrgan) form.set(`${MC}affected_organ_spec`, input.contestedOrgan);
  if (input.contestedActKind?.length) {
    form.set(
      `${MC}actkind`,
      resolveNalusValues(input.contestedActKind, NALUS_ACT_KINDS, "napadený akt").join(", "),
    );
  }
  if (input.contestedActNumber) form.set(`${MC}actkindnumber_txt`, input.contestedActNumber);
  if (input.contestedActName) form.set(`${MC}actkindname_txt`, input.contestedActName);
  if (input.contestedActClause) form.set(`${MC}actkindclause_txt`, input.contestedActClause);

  // razeni 2 = decision date desc, 5 = relevance ("významu").
  form.set(`${MC}razeni`, input.sort === "relevance" ? "5" : "2");
  form.set(`${MC}resultsPageSize`, String(pageSize));
  form.set(`${MC}resultsFontSize`, "10");
  return form;
}

export async function searchNalus(
  input: NalusSearchInput,
  page: number,
  pageSize: 10 | 20 | 40 | 80 = 20,
): Promise<NalusSearchPage> {
  // The ASP.NET session stores the criteria server-side, so the 3-step dance
  // must keep its own fresh cookies per search (sharing them across concurrent
  // searches would cross-contaminate results) — but identical repeats within
  // the TTL can skip all three requests.
  return searchCache.through(memoKey("nalus-search", [input, page, pageSize]), () =>
    runSearchNalus(input, page, pageSize),
  );
}

async function runSearchNalus(
  input: NalusSearchInput,
  page: number,
  pageSize: 10 | 20 | 40 | 80,
): Promise<NalusSearchPage> {
  const hasCriterion =
    input.query ||
    input.citace ||
    input.ecli ||
    input.judge ||
    input.dissentingJudge ||
    input.popularName ||
    input.dateFrom ||
    input.dateTo ||
    input.publishedFrom ||
    input.publishedTo ||
    input.outcome?.length ||
    input.petitioner?.length ||
    input.contestedOrganType?.length ||
    input.contestedOrgan ||
    input.contestedActKind?.length ||
    input.contestedActNumber ||
    input.contestedActName ||
    input.contestedActClause;
  if (!hasCriterion) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NALUS search needs at least one criterion.",
      "Provide query (full-text), case_number (citace), ecli, judge, dissenting_judge, popular_name, a date range, outcome, petitioner, or a contested_act/organ filter.",
    );
  }
  const session = new CookieSession();

  // Step 1: the form — fresh viewstate every time (the tokens are per-GET).
  const formResponse = await fetchUpstream(SOURCE, `${BASE}/Search.aspx`);
  session.absorb(formResponse);
  const state = parseFormState(await formResponse.text());

  // Step 2: the criteria POST. 302 → results in session; 200 → zero hits.
  const postResponse = await fetchUpstream(SOURCE, `${BASE}/Search.aspx`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session.header(),
      referer: `${BASE}/Search.aspx`,
    },
    body: buildNalusForm(state, input, pageSize).toString(),
    redirect: "manual",
  });
  session.absorb(postResponse);
  if (postResponse.status !== 302) {
    const body = await postResponse.text();
    if (body.toLowerCase().includes(ZERO_HITS_MARKER)) {
      return { hits: [], total: 0, empty: true };
    }
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NALUS search POST answered HTTP ${postResponse.status} without the zero-hits marker.`,
      "The form contract may have changed — run dawmain_probe_sources with include_raw.",
    );
  }

  // Step 3: the results page (0-indexed), same session.
  const resultsResponse = await fetchUpstream(
    SOURCE,
    `${BASE}/Results.aspx${page > 0 ? `?page=${page}` : ""}`,
    { headers: { cookie: session.header(), referer: `${BASE}/Search.aspx` } },
  );
  return parseNalusResults(await resultsResponse.text());
}
