import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { czechToIso, foldText } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { extractDocument, PDF_PAGES_PER_CALL, type ExtractedDocument } from "./shared/documents";
import { SLOVLEX_GATEWAY, SLOVLEX_SUDY, SLOVLEX_WEB, parseActCitation, slovlexJson } from "./slovlex-base";

/**
 * Slov-Lex súdne rozhodnutia — two databases behind one gateway
 * (docs/research/slovlex.md, plan section 1 "Judikatura"):
 *
 * - `sudy`: every published decision of the Slovak všeobecné súdy (~4.7 M,
 *   incl. NS SR sud_100 and NSS SR sud_175) — GET /vseobecne/filter, the
 *   text is a PDF on obcan.justice.sk;
 * - `judikaty`: the curated Zbierka stanovísk a rozhodnutí (~2.9 k, with a
 *   právna veta) — POST /judikaty/filter, the text is HTML in the detail.
 *   Live 2026-11: it holds NS SR (`sud` "NSSR", 715, to 2018) AND Ústavný
 *   súd SR (`sud` "USSR", 2 189, 1993–2014); every other code → HTTP 422.
 *
 * Verified live (2026-11-17):
 * - vseobecne/filter answers 401 unless query, povahaRozhodnutiaFacetFilter,
 *   ecli, spisovaZnacka and cisloSpisu are all present (empty is fine);
 *   a non-ISO vydaniaOd answers 404, so a filter 404 is never "not found".
 * - Full text is fast: 'zákon' over all 4.7 M answers in ~0.5 s, so unlike
 *   justice.cz no default date window is needed.
 * - odkazovanePredpisy takes ONE value (a repeated parameter is comma-joined
 *   by Spring and matches nothing): `/SK/ZZ/1964/40` matches every decision
 *   citing the act or any of its units; `/SK/ZZ/1964/40/#paragraf-420` (the
 *   `#` encoded) matches only references to exactly that unit — not those
 *   naming `#paragraf-420.odsek-1`. Articles (Ústava čl. 46) are stored as
 *   `paragraf-46` too.
 * - spisovaZnacka: `sudy` matches the compact form "30Ek/2848/2026" exactly
 *   (case-insensitive; "30 Ek 2848/2026" → 0); `judikaty` matches a
 *   substring of the stored mark, which is either "3Obdo/27/2018" or
 *   "6 Cdo 138/2016".
 * - /vseobecne/{guid}: the `:` inside the guid works raw.
 */

const BASE = `${SLOVLEX_GATEWAY}/internal/sudne-rozhodnutia`;
const SOURCE = SLOVLEX_SUDY;

export type SkDatabase = "sudy" | "judikaty";

/** Short court names → the code each database filters by. */
export const SK_COURT_ALIASES: Record<string, Partial<Record<SkDatabase, string>>> = {
  ns: { sudy: "sud_100", judikaty: "NSSR" },
  nss: { sudy: "sud_175" },
  us: { judikaty: "USSR" },
};

/** formaRozhodnutiaFacetFilter values — the unfiltered fazetFilter list (live 2026-11). */
export const SK_DECISION_FORMS = [
  "Čiastočný rozsudok",
  "Dopĺňacie uznesenie",
  "Dopĺňací rozsudok",
  "Európsky platobný rozkaz",
  "Medzitýmny rozsudok",
  "Opatrenie",
  "Opatrenie bez poučenia",
  "Opravné uznesenie",
  "Osvedčenie",
  "Platobný rozkaz",
  "Poverenie",
  "Príkaz",
  "Rozhodnutie",
  "Rozkaz na plnenie",
  "Rozsudok",
  "Rozsudok bez odôvodnenia",
  "Rozsudok pre uznanie",
  "Rozsudok pre vzdanie",
  "Rozsudok pre zmeškanie",
  "Šekový platobný rozkaz",
  "Trestný rozkaz",
  "Uznesenie",
  "Uznesenie bez odôvodnenia",
  "Výzva",
  "Zmenkový platobný rozkaz",
] as const;

/** povahaRozhodnutiaFacetFilter values (live 2026-11). */
export const SK_DECISION_NATURES = [
  "Iná povaha rozhodnutia",
  "Odmietajúce odvolanie",
  "Odmietajúce podanie",
  "Potvrdené",
  "Potvrdzujúce",
  "Pripúštajúce spätvzatie návrhu, zrušujúce rozsudok a zastavujúce konanie",
  "Prvostupňové nenapadnuté opravnými prostriedkami",
  "Zastavujúce odvolacie konanie",
  "Zmenené",
  "Zmeňujúce",
  "Zrušené",
  "Zrušujúce",
] as const;

/** oblastPravnejUpravyFacetFilter values (live 2026-11). */
export const SK_LAW_AREAS = ["Občianske právo", "Obchodné právo", "Rodinné právo", "Správne právo", "Trestné právo"] as const;

export interface SkSearchInput {
  database?: SkDatabase;
  query?: string;
  caseNumber?: string;
  ecli?: string;
  /** "ns", "nss", "us", "sud_100", "NSSR" — or a court name, resolved by resolveCourt before the URL is built. */
  court?: string;
  dateFrom?: string;
  dateTo?: string;
  form?: string;
  nature?: string;
  area?: string;
  /** "40/1964", "40/1964 Zb.", "/SK/ZZ/1964/40". */
  appliesAct?: string;
  /** "§ 420", "§ 420 ods. 1 písm. b)", "čl. 46" — with appliesAct. */
  appliesSection?: string;
}

export interface SkDecisionHit {
  id: string;
  case_number?: string;
  court?: string;
  judge?: string;
  type?: string;
  title?: string;
  decided?: string;
  url: string;
}

export interface SkSearchPage {
  database: SkDatabase;
  total: number;
  page: number;
  totalPages: number;
  hits: SkDecisionHit[];
}

// ---------- addresses ----------

export function vseobecneUrl(guid: string): string {
  return `${SLOVLEX_WEB}/sudne-rozhodnutia/vseobecne-sudy-sr/${guid}`;
}

export function judikatUrl(uuid: string): string {
  return `${SLOVLEX_WEB}/sudne-rozhodnutia/judikaty/${uuid}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SUDY_ID = new RegExp(`^${UUID}:${UUID}$`, "i");
const JUDIKAT_ID = new RegExp(`^${UUID}$`, "i");

/**
 * "uuid:uuid" → a všeobecný súd decision, a bare uuid → a judikát. The public
 * slov-lex.sk address of either is accepted too. Pure — unit-tested.
 */
export function parseDecisionId(raw: string): { kind: "sudy" | "judikat"; id: string } {
  let id = raw.trim();
  const fromUrl = new RegExp(`/(?:vseobecne-sudy-sr|vseobecne|judikaty)/(${UUID}(?::|%3A)?(?:${UUID})?)/?(?:[?#].*)?$`, "i").exec(id);
  if (fromUrl) id = fromUrl[1].replace(/%3A/i, ":");
  if (SUDY_ID.test(id)) return { kind: "sudy", id: id.toLowerCase() };
  if (JUDIKAT_ID.test(id)) return { kind: "judikat", id: id.toLowerCase() };
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `"${raw}" is not a Slov-Lex decision id.`,
    "Pass the id from sk_judikatura_search: 'uuid:uuid' for a decision of the všeobecné súdy, a plain uuid for a judikát.",
  );
}

// ---------- input normalisation (pure) ----------

/** "30 Ek 2848/2026", "30Ek/2848/2026", "6 Cdo 138/2016" → parts; Roman ÚS marks ("II. ÚS 307/2014") → null. */
function splitCaseNumber(raw: string): { senate: string; registry: string; number: string; year: string } | null {
  const m = /^\s*(\d{1,3})?\s*(\p{L}+)\s*[\s/]\s*(\d+)\s*\/\s*(\d{4})\b/u.exec(raw);
  if (!m) return null;
  return { senate: m[1] ?? "", registry: m[2], number: m[3], year: m[4] };
}

/** The compact mark the `sudy` index stores: "30Ek/2848/2026". Unparseable input passes through. Pure. */
export function compactCaseNumber(raw: string): string {
  const parts = splitCaseNumber(raw);
  return parts ? `${parts.senate}${parts.registry}/${parts.number}/${parts.year}` : raw.trim();
}

/** The two spellings `judikaty` stores, the caller's first. Pure. */
function judikatCaseNumbers(raw: string): string[] {
  const parts = splitCaseNumber(raw);
  const out = [raw.trim()];
  if (parts) {
    out.push(`${parts.senate}${parts.registry}/${parts.number}/${parts.year}`);
    out.push(`${parts.senate ? `${parts.senate} ` : ""}${parts.registry} ${parts.number}/${parts.year}`);
  }
  return [...new Set(out.filter(Boolean))];
}

const SECTION =
  /^\s*(?:§+|čl\.?|článok|článku|clanok|art\.?)?\s*(\d{1,4}[a-z]{0,3})\s*(?:,?\s*(?:ods\.?|odsek|odst\.?)\s*(\d{1,3}[a-z]?))?\s*(?:,?\s*(?:písm\.?|pism\.?|písmeno|pismeno)\s*([a-z]{1,2})\)?)?\s*$/iu;

/**
 * The odkazovanePredpisy value: the act alone ("/SK/ZZ/1964/40", matches any
 * reference into it) or one unit ("/SK/ZZ/1964/40/#paragraf-420.odsek-1",
 * matches exactly that unit). Články are stored as paragraf-N. Pure — unit-tested.
 */
export function predpisReference(act: string, section?: string): string {
  const parsed = parseActCitation(act);
  if (!parsed) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${act}" is not an act reference.`,
      "Use 'číslo/rok', e.g. '40/1964' (Občiansky zákonník), '160/2015' (Civilný sporový poriadok), '300/2005' (Trestný zákon).",
    );
  }
  const base = `/SK/ZZ/${parsed.year}/${parsed.number}`;
  if (!section) return base;
  const m = SECTION.exec(section);
  if (!m) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${section}" is not a section label.`,
      "Pass it as '§ 420', '§ 420 ods. 1', '§ 420 ods. 1 písm. b)' or 'čl. 46'.",
    );
  }
  const unit = [`paragraf-${m[1].toLowerCase()}`, m[2] ? `odsek-${m[2].toLowerCase()}` : "", m[3] ? `pismeno-${m[3].toLowerCase()}` : ""]
    .filter(Boolean)
    .join(".");
  return `${base}/#${unit}`;
}

/**
 * "/SK/ZZ/1995/233/#paragraf-53.odsek-3.pismeno-b" (všeobecné súdy) or
 * "/SK/ZZ/2015/160/paragraf-447/pismeno-c" (judikáty) → "§ 53 ods. 3 písm. b)
 * 233/1995 Z. z.". Anything else passes through. Pure — unit-tested.
 */
export function formatPredpisReference(ref: string): string {
  const m = /\/SK\/ZZ\/(\d{4})\/(\d+)(?:\/#?([^\s]*))?$/.exec(ref.trim());
  if (!m) return ref.trim();
  const year = Number(m[1]);
  const act = `${m[2]}/${m[1]} ${year < 1993 ? "Zb." : "Z. z."}`;
  // Slov-Lex stores the Ústava's články as paragraf-N too.
  const articles = m[1] === "1992" && m[2] === "460";
  const unit = (m[3] ?? "")
    .split(/[./]/)
    .filter(Boolean)
    .map((part) => {
      const p = /^(paragraf|odsek|pismeno|clanok|bod)-(.+)$/.exec(part);
      if (!p) return part;
      if (p[1] === "paragraf") return articles ? `čl. ${p[2]}` : `§ ${p[2]}`;
      if (p[1] === "odsek") return `ods. ${p[2]}`;
      if (p[1] === "pismeno") return `písm. ${p[2]})`;
      if (p[1] === "clanok") return `čl. ${p[2]}`;
      return `bod ${p[2]}`;
    })
    .join(" ");
  return unit ? `${unit} ${act}` : act;
}

// ---------- requests (pure) ----------

const SUDY_ONLY: Array<[keyof SkSearchInput, string]> = [
  ["ecli", "ecli"],
  ["form", "form"],
  ["nature", "nature"],
  ["area", "area"],
  ["appliesAct", "applies_act"],
  ["appliesSection", "applies_section"],
];

/** Refuse what the chosen database cannot filter by — upstream would ignore it silently. Pure. */
export function assertSearchInput(input: SkSearchInput): void {
  if (input.database === "judikaty") {
    const used = SUDY_ONLY.filter(([key]) => input[key] !== undefined && input[key] !== "").map(([, name]) => name);
    if (used.length) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `database "judikaty" cannot filter by ${used.join(", ")} — those filters exist only for "sudy".`,
        `Drop ${used.join(", ")}, or search database: "sudy" (every decision of the všeobecné súdy).`,
      );
    }
  }
  if (input.appliesSection && !input.appliesAct) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "applies_section needs an act to attach to.",
      "Pair it with applies_act, e.g. applies_act '40/1964' + applies_section '§ 420'.",
    );
  }
}

function sudyCourt(court: string | undefined): string | undefined {
  if (!court?.trim()) return undefined;
  const key = foldText(court.trim());
  const alias = SK_COURT_ALIASES[key];
  if (alias) {
    if (alias.sudy) return alias.sudy;
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `court "${court}" is not in database "sudy".`,
      key === "us"
        ? 'Ústavný súd SR decisions are only in database: "judikaty" (court: "us", 1993–2014); newer ones are on ustavnysud.sk.'
        : 'Use "ns", "nss", a sud_NNN id or a court name.',
    );
  }
  if (/^sud_\d+$/.test(key)) return key;
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `court "${court}" must be resolved to a sud_NNN id first.`,
    'Pass "ns", "nss", a sud_NNN id or a court name (searchSkDecisions resolves names).',
  );
}

/**
 * The GET /vseobecne/filter address. The five Spring-required parameters are
 * ALWAYS present (empty when unused) — without them the gateway answers 401.
 * `court` must be an alias or a sud_NNN id (names go through resolveCourt).
 * Sorted by decision date, newest first. Pure — unit-tested; the probe uses it.
 */
export function buildVseobecneFilterUrl(input: SkSearchInput, page: number, size: number): string {
  const params = new URLSearchParams();
  params.set("query", input.query?.trim() ?? "");
  params.set("povahaRozhodnutiaFacetFilter", input.nature ?? "");
  params.set("ecli", input.ecli?.trim() ?? "");
  params.set("spisovaZnacka", input.caseNumber ? compactCaseNumber(input.caseNumber) : "");
  params.set("cisloSpisu", "");
  const court = sudyCourt(input.court);
  if (court) params.set("guidSud", court);
  if (input.dateFrom) params.set("vydaniaOd", input.dateFrom);
  if (input.dateTo) params.set("vydaniaDo", input.dateTo);
  if (input.form) params.set("formaRozhodnutiaFacetFilter", input.form);
  if (input.area) params.set("oblastPravnejUpravyFacetFilter", input.area);
  if (input.appliesSection && !input.appliesAct) assertSearchInput(input);
  if (input.appliesAct) params.set("odkazovanePredpisy", predpisReference(input.appliesAct, input.appliesSection));
  params.set("page", String(page));
  params.set("size", String(size));
  params.set("sortBy", "datum_vydania_rozhodnutia");
  params.set("sortDirection", "DESC");
  return `${BASE}/vseobecne/filter?${params}`;
}

function judikatyCourt(court: string | undefined): string | undefined {
  if (!court?.trim()) return undefined;
  const key = foldText(court.trim());
  if (key === "nssr") return "NSSR";
  if (key === "ussr") return "USSR";
  const code = SK_COURT_ALIASES[key]?.judikaty;
  if (code) return code;
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `court "${court}" is not in database "judikaty".`,
    'The Zbierka holds only Najvyšší súd SR (court: "ns") and Ústavný súd SR (court: "us"); for any other court search database: "sudy".',
  );
}

/** The POST /judikaty/filter request: only the fields that are set (an empty `sud` answers 422). Pure — unit-tested. */
export function buildJudikatyFilterRequest(input: SkSearchInput, page: number, size: number): { url: string; body: Record<string, string> } {
  const body: Record<string, string> = {};
  if (input.query?.trim()) body.hladanyVyraz = input.query.trim();
  if (input.caseNumber?.trim()) body.spisovaZnacka = input.caseNumber.trim();
  const court = judikatyCourt(input.court);
  if (court) body.sud = court;
  if (input.dateFrom) body.datumRozhodnutiaOd = input.dateFrom;
  if (input.dateTo) body.datumRozhodnutiaDo = input.dateTo;
  const params = new URLSearchParams({ page: String(page), size: String(size), sortBy: "datumRozhodnutia", sortDirection: "DESC" });
  return { url: `${BASE}/judikaty/filter?${params}`, body };
}

// ---------- parse (pure) ----------

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** `sud`/`sudca` come as a bare name in the list and as {id, nazov} in the detail. */
const named = (value: unknown): string | undefined => str(value) ?? str((value as { nazov?: unknown } | null)?.nazov);
const pages = (total: number, size: number) => Math.max(1, Math.ceil(total / Math.max(1, size)));

function drift(what: string): SourceError {
  return new SourceError(SOURCE, "PARSE_DRIFT", `Slov-Lex ${what}.`, "The API shape may have changed — run dawmain_probe_sources (canary slovlex-sudy).");
}

/**
 * Both filters clamp a page past the end to the LAST page (live: page 5 of a
 * one-hit search answers that hit with number: 1), which would repeat hits
 * under the wrong numbers — so such a page is emptied here.
 */
function pastEnd(result: SkSearchPage): SkSearchPage {
  return result.page > result.totalPages ? { ...result, hits: [] } : result;
}

/** Parse a /vseobecne/filter answer. Pure — unit-tested. */
export function parseVseobecneSearch(json: unknown, page: number, size: number): SkSearchPage {
  const data = (json as { page?: { totalElements?: unknown; rozhodnutieList?: unknown } } | null)?.page;
  if (!data || !Array.isArray(data.rozhodnutieList)) throw drift("vseobecne/filter answered without page.rozhodnutieList");
  const hits: SkDecisionHit[] = [];
  for (const row of data.rozhodnutieList as Array<Record<string, unknown>>) {
    const id = str(row.guid);
    if (!id) continue;
    const decided = str(row.datumVydania);
    hits.push({
      id,
      case_number: str(row.spisovaZnacka),
      court: named(row.sud),
      judge: named(row.sudca),
      decided: decided ? (czechToIso(decided) ?? decided) : undefined,
      url: vseobecneUrl(id),
    });
  }
  const total = typeof data.totalElements === "number" ? data.totalElements : hits.length;
  return pastEnd({ database: "sudy", total, page, totalPages: pages(total, size), hits });
}

/** "ÚS SR Nález …", "NS SR Uznesenie …", "NSSR Rozsudok …" → the court; other prefixes (KS …) stay unnamed. */
function judikatCourt(title: string | undefined, sud?: string): string | undefined {
  if (sud === "USSR") return "Ústavný súd SR";
  if (sud === "NSSR") return "Najvyšší súd SR";
  if (!title) return undefined;
  if (/^(?:ÚS SR|Nález Ústavného|Uznesenie Ústavného)/u.test(title)) return "Ústavný súd SR";
  if (/^(?:NS SR|NSSR|NS )/u.test(title)) return "Najvyšší súd SR";
  return undefined;
}

/** "ÚS SR Nález Ústavného súdu …" → "Nález" when typRozhodnutia is null (ÚS rows). */
function judikatType(row: Record<string, unknown>): string | undefined {
  const typ = named(row.typRozhodnutia);
  if (typ) return typ;
  const title = str(row.nazovRozhodnutia);
  return title ? /\b(Nález|Uznesenie|Rozsudok|Stanovisko)\b/u.exec(title)?.[1] : undefined;
}

/** Parse a /judikaty/filter answer. Pure — unit-tested. */
export function parseJudikatySearch(json: unknown, page: number, size: number): SkSearchPage {
  const data = json as { totalElements?: unknown; judikatList?: unknown } | null;
  if (!data || !Array.isArray(data.judikatList)) throw drift("judikaty/filter answered without judikatList");
  const hits: SkDecisionHit[] = [];
  for (const row of data.judikatList as Array<Record<string, unknown>>) {
    const id = str(row.uuid);
    if (!id) continue;
    const title = str(row.nazovRozhodnutia);
    const decided = str(row.datumRozhodnutia);
    hits.push({
      id,
      case_number: str(row.spisovaZnacka),
      court: judikatCourt(title, str(row.sud)),
      type: judikatType(row),
      title,
      decided: decided ? (czechToIso(decided) ?? decided.slice(0, 10)) : undefined,
      url: judikatUrl(id),
    });
  }
  const total = typeof data.totalElements === "number" ? data.totalElements : hits.length;
  return pastEnd({ database: "judikaty", total, page, totalPages: pages(total, size), hits });
}

// ---------- courts ----------

interface SkCourt {
  id: string;
  name: string;
}

const courtCache = new TtlCache<SkCourt[]>(SEARCH_TTL_MS, 2);

async function listCourts(): Promise<SkCourt[]> {
  return courtCache.through("sk-courts", async () => {
    // 68 courts (live 2026-11); limit=40 would cut the list.
    const json = await slovlexJson<unknown>(SOURCE, `${BASE}/vseobecne/sud?query=&limit=100`);
    if (!Array.isArray(json)) throw drift("vseobecne/sud answered without a list");
    return (json as Array<Record<string, unknown>>)
      .map((row) => ({ id: str(row.id) ?? "", name: str(row.nazov) ?? "" }))
      .filter((court) => court.id && court.name);
  });
}

/** Does a folded query token match a folded name token? Short tokens (Roman numerals, "v") exactly, longer ones by stem — "Bratislava" finds "Bratislave". */
function tokenMatches(query: string, name: string): boolean {
  if (query.length <= 2) return name === query;
  const stem = query.length > 4 ? query.slice(0, Math.max(4, query.length - 2)) : query;
  return name.startsWith(stem);
}

/** Courts whose name matches every word of `query`. Pure — unit-tested. */
export function matchCourts(courts: SkCourt[], query: string): SkCourt[] {
  const folded = foldText(query.trim());
  const exact = courts.filter((court) => foldText(court.name) === folded);
  if (exact.length) return exact;
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w && w !== "v" && w !== "sr");
  if (!words.length) return [];
  return courts.filter((court) => {
    const nameWords = foldText(court.name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((word) => nameWords.some((nameWord) => tokenMatches(word, nameWord)));
  });
}

/**
 * The court code a database filters by: an alias ("ns", "nss", "us"), a
 * bare sud_NNN / NSSR / USSR, or — `sudy` only — a court name matched
 * against the gateway's list of 68 courts. Ambiguous or unknown names are
 * refused with the candidates, never guessed.
 */
export async function resolveCourt(court: string | undefined, database: SkDatabase = "sudy"): Promise<string | undefined> {
  if (!court?.trim()) return undefined;
  if (database === "judikaty") return judikatyCourt(court);
  const key = foldText(court.trim());
  if (SK_COURT_ALIASES[key] || /^sud_\d+$/.test(key)) return sudyCourt(court);
  const courts = await listCourts();
  const found = matchCourts(courts, court);
  if (found.length === 1) return found[0].id;
  if (!found.length) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `No Slovak court matches "${court}".`,
      `Use "ns" (Najvyšší súd SR), "nss" (Najvyšší správny súd SR) or a name such as "Krajský súd v Bratislave", "Okresný súd Žilina", "Mestský súd Bratislava I".`,
    );
  }
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `"${court}" matches ${found.length} courts.`,
    `Pick one: ${found
      .slice(0, 15)
      .map((c) => `${c.name} (${c.id})`)
      .join("; ")}${found.length > 15 ? "; …" : ""}.`,
  );
}

// ---------- search (I/O) ----------

const searchCache = new TtlCache<SkSearchPage>(SEARCH_TTL_MS);

/** A filter 404 means a drifted parameter (bad date format, missing sort), never a missing record. */
async function filterJson<T>(url: string, init?: { method: "POST"; body: unknown; retry: true }): Promise<T> {
  try {
    return await slovlexJson<T>(SOURCE, url, init);
  } catch (error) {
    if (error instanceof SourceError && error.kind === "NOT_FOUND") {
      throw new SourceError(SOURCE, "PARSE_DRIFT", `Slov-Lex answered HTTP 404 for the search ${url}.`, "The filter's parameters drifted (a 404 here means a rejected parameter) — run dawmain_probe_sources; retrying will not help.");
    }
    throw error;
  }
}

/** Search one of the two databases, newest decision first. `page` is 1-based (as upstream). */
export async function searchSkDecisions(input: SkSearchInput, page: number, size: number): Promise<SkSearchPage> {
  assertSearchInput(input);
  const database = input.database ?? "sudy";
  const court = await resolveCourt(input.court, database);
  const resolved: SkSearchInput = { ...input, database, court };
  if (database === "sudy") {
    const url = buildVseobecneFilterUrl(resolved, page, size);
    return searchCache.through(memoKey("sk-sudy", url), async () => parseVseobecneSearch(await filterJson(url), page, size));
  }
  // judikaty matches a substring of a mark stored in one of two spellings:
  // try the caller's, then the other two, until one finds something.
  const marks = resolved.caseNumber ? judikatCaseNumbers(resolved.caseNumber) : [undefined];
  let result: SkSearchPage | undefined;
  for (const mark of marks) {
    const request = buildJudikatyFilterRequest({ ...resolved, caseNumber: mark }, page, size);
    result = await searchCache.through(memoKey("sk-judikaty", [request.url, request.body]), async () =>
      parseJudikatySearch(await filterJson(request.url, { method: "POST", body: request.body, retry: true }), page, size),
    );
    if (result.total > 0) break;
  }
  return result!;
}

// ---------- decision (I/O) ----------

export interface SkDecision {
  kind: "sudy" | "judikat";
  id: string;
  url: string;
  case_number?: string;
  court?: string;
  judge?: string;
  type?: string;
  nature?: string;
  area?: string;
  ecli?: string;
  decided?: string;
  title?: string;
  /** Formatted: "§ 53 ods. 3 písm. b) 233/1995 Z. z.". */
  references: string[];
  /** sudy: the PDF on obcan.justice.sk. */
  document?: { name?: string; url: string; size?: number };
  text: string;
  format?: ExtractedDocument["format"];
  pdf?: ExtractedDocument["pdf"];
}

type SkDecisionMeta = Omit<SkDecision, "text" | "format" | "pdf">;

const detailCache = new TtlCache<SkDecisionMeta & { html?: string }>(DOCUMENT_TTL_MS, 24);
const documentCache = new TtlCache<ExtractedDocument>(DOCUMENT_TTL_MS, 12);

/** The metadata of a /vseobecne/{guid} detail. Pure — unit-tested. */
export function parseVseobecneDetail(json: unknown, guid: string): SkDecisionMeta {
  const d = json as Record<string, unknown> | null;
  if (!d || typeof d !== "object") throw drift(`vseobecne/${guid} answered without a decision`);
  const refs = Array.isArray(d.odkazovanePredpisy) ? (d.odkazovanePredpisy as Array<Record<string, unknown>>) : [];
  const doc = (d.dokument ?? null) as Record<string, unknown> | null;
  const decided = str(d.datumVydania);
  const area = [str(d.oblast), str(d.podOblast)].filter(Boolean).join(" / ");
  return {
    kind: "sudy",
    id: guid,
    url: vseobecneUrl(guid),
    case_number: str(d.spisovaZnacka),
    court: named(d.sud),
    judge: named(d.sudca),
    type: str(d.formaRozhodnutia),
    nature: str(d.povaha),
    area: area || undefined,
    ecli: str(d.ecli),
    decided: decided ? (czechToIso(decided) ?? decided) : undefined,
    references: [...new Set(refs.map((ref) => str(ref.nazov) ?? str(ref.url)).filter((r): r is string => Boolean(r)).map(formatPredpisReference))],
    ...(doc && str(doc.url) ? { document: { name: str(doc.name), url: str(doc.url)!, size: typeof doc.size === "number" ? doc.size : undefined } } : {}),
  };
}

/** A judikát's text: the právna veta and odôvodnenie (secHtml), then the decision itself (sudHtml) when it holds more than its heading. Pure. */
export function judikatText(json: unknown): string {
  const d = json as { secHtml?: unknown; sudHtml?: unknown; nazovRozhodnutia?: unknown };
  const clean = (html: unknown) => (typeof html === "string" ? htmlToText(html.replace(/﻿/g, "")).replace(/﻿/g, "").trim() : "");
  const title = str(d.nazovRozhodnutia) ?? "";
  const sec = clean(d.secHtml);
  const sud = clean(d.sudHtml);
  const sudBody = sud.startsWith(title) ? sud.slice(title.length).trim() : sud;
  return [title, sec, sudBody].filter(Boolean).join("\n\n").trim();
}

/** The metadata of a /judikaty/{uuid} detail. Pure — unit-tested. */
export function parseJudikatDetail(json: unknown, uuid: string): SkDecisionMeta & { text: string } {
  const d = json as Record<string, unknown> | null;
  if (!d || typeof d !== "object") throw drift(`judikaty/${uuid} answered without a decision`);
  const refs = Array.isArray(d.vazbyNaPredpisZbierky) ? (d.vazbyNaPredpisZbierky as Array<Record<string, unknown>>) : [];
  const areas = Array.isArray(d.oblastPravnejUpravy) ? (d.oblastPravnejUpravy as unknown[]).map(str).filter(Boolean) : [];
  const title = str(d.nazovRozhodnutia);
  const decided = str(d.datumRozhodnutia);
  const text = judikatText(d);
  if (!text || text === title) throw drift(`judikát ${uuid} has no text (secHtml/sudHtml empty)`);
  return {
    kind: "judikat",
    id: uuid,
    url: judikatUrl(uuid),
    case_number: str(d.spisovaZnacka),
    court: judikatCourt(title, str(d.sud)),
    type: judikatType(d),
    area: areas.join(", ") || undefined,
    ecli: str(d.ecli),
    decided: decided ? (czechToIso(decided) ?? decided.slice(0, 10)) : undefined,
    title,
    references: [...new Set(refs.map((ref) => str(ref.iri) ?? str(ref.menovka)).filter((r): r is string => Boolean(r)).map(formatPredpisReference))],
    text,
  };
}

/** The hosts a decision's file may come from — the detail names it, and we fetch nothing else. */
const DOCUMENT_HOSTS = /^https:\/\/(?:obcan\.justice\.sk|(?:[a-z0-9-]+\.)?slov-lex\.sk)\//i;

function remaining(deadlineAt: number | undefined, fallback: number): number {
  return deadlineAt === undefined ? fallback : Math.max(2_000, deadlineAt - Date.now());
}

/**
 * One decision with its text. sudy: detail → PDF from obcan.justice.sk →
 * extractDocument (only `pdfRange`'s pages); judikát: the detail's HTML.
 * `deadlineAt` (epoch ms, from callDeadline) bounds the chained requests.
 */
export async function getSkDecision(
  rawId: string,
  opts: { pdfRange?: [number, number]; deadlineAt?: number } = {},
): Promise<SkDecision> {
  const { kind, id } = parseDecisionId(rawId);
  if (kind === "judikat") {
    const detail = await detailCache.through(memoKey("sk-judikat", id), async () => {
      const json = await slovlexJson<unknown>(SOURCE, `${BASE}/judikaty/${id}`, { timeoutMs: remaining(opts.deadlineAt, 15_000) });
      const { text, ...meta } = parseJudikatDetail(json, id);
      return { ...meta, html: text };
    });
    const { html, ...meta } = detail;
    return { ...meta, text: html ?? "", format: "html" };
  }
  const meta = await detailCache.through(memoKey("sk-vseobecne", id), async () =>
    parseVseobecneDetail(await slovlexJson<unknown>(SOURCE, `${BASE}/vseobecne/${id}`, { timeoutMs: remaining(opts.deadlineAt, 15_000) }), id),
  );
  const { html: _html, ...decision } = meta;
  if (!decision.document) {
    throw new SourceError(SOURCE, "NOT_FOUND", `Decision ${decision.case_number ?? id} has no document file on Slov-Lex.`, `Open ${decision.url} yourself; the metadata is all Slov-Lex publishes for it.`);
  }
  const fileUrl = decision.document.url;
  if (!DOCUMENT_HOSTS.test(fileUrl)) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", `Decision ${id} links its file at an unexpected host: ${fileUrl}.`, `Open ${decision.url} yourself; run dawmain_probe_sources.`);
  }
  const range = opts.pdfRange ?? [1, PDF_PAGES_PER_CALL];
  const extracted = await documentCache.through(memoKey("sk-doc", [id, range]), async () => {
    const response = await fetchUpstream(SOURCE, fileUrl, { timeoutMs: remaining(opts.deadlineAt, 20_000) });
    if (response.status === 404) {
      void response.body?.cancel().catch(() => {});
      throw new SourceError(SOURCE, "NOT_FOUND", `The file of decision ${decision.case_number ?? id} is missing on obcan.justice.sk (HTTP 404).`, `Open ${decision.url} yourself.`);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SourceError(SOURCE, "UPSTREAM_ERROR", `obcan.justice.sk answered HTTP ${response.status} for the file of decision ${decision.case_number ?? id}.`, `Try again in a minute, or open ${fileUrl} yourself.`);
    }
    const bytes = await response.arrayBuffer();
    return extractDocument(SOURCE, { bytes, url: fileUrl }, range, { label: decision.document?.name ?? decision.case_number ?? id });
  });
  return { ...decision, text: extracted.text, format: extracted.format, ...(extracted.pdf ? { pdf: extracted.pdf } : {}) };
}
