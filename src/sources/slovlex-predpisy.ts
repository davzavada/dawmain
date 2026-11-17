import type { AnyNode, Element } from "domhandler";
import { SourceError, asSourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { loadHtml } from "./shared/html";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { foldText } from "./shared/text";
import { chunkFragments, parseSectionLabel, type SectionLabel } from "./esbirka";
import { SLOVLEX_GATEWAY, SLOVLEX_STATIC, SLOVLEX_WEB, SLOVLEX_ZBIERKA, actIri, parseActCitation, slovlexJson, todayIso } from "./slovlex-base";

/**
 * Slov-Lex — Zbierka zákonov SR (docs/research/slovlex.md, plan section 1).
 *
 *   GET {gateway}/vyhladavanie/predpisZbierky/rozsirene   Solr search (acts, not sections)
 *   GET {static}/SK/ZZ/{year}/{number}/                   history page: one
 *       tr.effectivenessHistoryItem per version (data-iri, data-vyhlasene,
 *       data-ucinnostod, data-ucinnostdo; amending acts in the third cell)
 *   GET {static}/SK/ZZ/{year}/{number}/{YYYYMMDD|vyhlasene_znenie}.html   the text
 *
 * The text page marks every provision: div.paragraf#paragraf-N, div.clanok
 * #predpis.clanok-N, their *Oznacenie labels, odsek/pismeno/bod below. An
 * AMENDING act quotes the new wording of the amended act inside div.citat —
 * a "paragraf-30" there is the amended act's § 30, not this act's. Units are
 * therefore only the paragraphs and articles outside any .citat; the quoted
 * ones are indexed separately, to answer "this § is quoted in Čl. I".
 */

const SOURCE = SLOVLEX_ZBIERKA;
const SEARCH_PATH = "/vyhladavanie/predpisZbierky/rozsirene";
/** The Občiansky zákonník's page is 1.7 MB. */
const TEXT_TIMEOUT_MS = 25_000;

const searchCache = new TtlCache<PredpisSearchPage>(SEARCH_TTL_MS);
const historyCache = new TtlCache<PredpisVersion[]>(DOCUMENT_TTL_MS, 24);
/** Parsed models, never the HTML: a big act parses once per instance. */
const actCache = new TtlCache<ParsedAct>(DOCUMENT_TTL_MS, 6);

// ---------- search ----------

export interface PredpisSearchInput {
  query?: string;
  title?: string;
  /** "40/1964" (a suffix "Zb." / "Z. z." is tolerated). */
  number?: string;
  year?: number;
  /** typPredp_value, e.g. "Zákon", "Vyhláška", "Nariadenie vlády". */
  type?: string;
  in_force_on?: string;
  published_from?: string;
  published_to?: string;
  sort?: "relevance" | "newest";
}

/** "40/1964 Zb." / "/SK/ZZ/1964/40" → "40/1964" — the only shape `cislo` matches (with the suffix: 0 hits). */
function cisloParam(number: string): string {
  const parsed = parseActCitation(number);
  return parsed ? `${parsed.number}/${parsed.year}` : number.trim();
}

/** The search URL — only the criteria given, plus rows/start (and sort for "newest"). Pure; the probe uses it. */
export function buildPredpisSearchUrl(input: PredpisSearchInput, start: number, rows: number): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | undefined) => {
    if (value === undefined) return;
    const text = String(value).trim();
    if (text) params.set(key, text);
  };
  put("text", input.query);
  put("nazov", input.title);
  put("cislo", input.number ? cisloParam(input.number) : undefined);
  put("rocnik", input.year);
  put("typPredp_value", input.type);
  put("ucinnyK", input.in_force_on);
  put("vyhlaseny_zaciatok", input.published_from);
  put("vyhlaseny_koniec", input.published_to);
  params.set("rows", String(rows));
  params.set("start", String(start));
  if (input.sort === "newest") params.set("sort", "vyhlaseny desc");
  return `${SLOVLEX_GATEWAY}${SEARCH_PATH}?${params.toString()}`;
}

export interface PredpisHit {
  /** "40/1964 Zb.", "325/2025 Z. z." */
  citation: string;
  year: number;
  number: number;
  title: string;
  type?: string;
  /** Announcement date (YYYY-MM-DD). */
  published?: string;
  /** The wording the hit points at (the one in force today, or on in_force_on). */
  version_from?: string;
  version_to?: string;
  /** "/SK/ZZ/1964/40/20260731" */
  iri: string;
  url: string;
  /** Up to 3 section headings (nadpisy) containing a query term. */
  headings: string[];
}

export interface PredpisSearchPage {
  total: number;
  start: number;
  items: PredpisHit[];
}

const MAX_HEADINGS = 3;

/** Folded query words, each cut to a crude stem so "nájom" finds "nájmu" headings. */
function headingStems(terms: string[]): string[] {
  const words = terms.flatMap((term) => foldText(term).split(/[^\p{L}\p{N}]+/u)).filter((word) => word.length >= 3);
  return [...new Set(words.map((word) => (word.length > 5 ? word.slice(0, word.length - 2) : word.length > 4 ? word.slice(0, 4) : word)))];
}

const isoDay = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;

const nbsp = (text: string) => text.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/**
 * The Solr answer → hits. `terms` (the query words) pick the nadpisy worth
 * showing: the Občiansky zákonník carries 132 of them, all irrelevant
 * unless they name what was searched. Pure — unit-tested.
 */
export function parsePredpisSearch(json: unknown, terms: string[] = []): PredpisSearchPage {
  const body = json as { numFound?: unknown; start?: unknown; docs?: unknown } | null;
  if (!body || typeof body.numFound !== "number" || !Array.isArray(body.docs)) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "Slov-Lex search answered without numFound/docs.", "The search API changed — run dawmain_probe_sources; retrying will not help.");
  }
  const stems = headingStems(terms);
  const items: PredpisHit[] = [];
  for (const raw of body.docs as Array<Record<string, unknown>>) {
    const iri = typeof raw.iri === "string" ? raw.iri : "";
    const id = parseActCitation(iri);
    if (!id) continue;
    const nadpisy = Array.isArray(raw.nadpisy) ? raw.nadpisy.filter((h): h is string => typeof h === "string") : [];
    const headings = stems.length
      ? [...new Set(nadpisy.filter((heading) => stems.some((stem) => foldText(heading).includes(stem))))].slice(0, MAX_HEADINGS)
      : [];
    items.push({
      citation: typeof raw.cislo === "string" ? nbsp(raw.cislo) : defaultCitation(id.year, id.number),
      year: id.year,
      number: id.number,
      title: typeof raw.nazov === "string" ? nbsp(raw.nazov) : "",
      ...(typeof raw.typPredp_value === "string" ? { type: raw.typPredp_value } : {}),
      ...(isoDay(raw.vyhlaseny) ? { published: isoDay(raw.vyhlaseny) } : {}),
      ...(isoDay(raw.ucinnyOd) ? { version_from: isoDay(raw.ucinnyOd) } : {}),
      ...(isoDay(raw.ucinnyDo) ? { version_to: isoDay(raw.ucinnyDo) } : {}),
      iri,
      url: `${SLOVLEX_WEB}/ezbierky/pravne-predpisy${iri}`,
      headings,
    });
  }
  return { total: body.numFound, start: typeof body.start === "number" ? body.start : 0, items };
}

/** Before 1993 the collection was the Zbierka zákonov ČSFR/ČSSR ("Zb."); since then "Z. z.". */
export function defaultCitation(year: number, number: number): string {
  return `${number}/${year} ${year < 1993 ? "Zb." : "Z. z."}`;
}

/** At least one real criterion; the number in its one working shape. Throws INPUT_INVALID. */
function assertSearchInput(input: PredpisSearchInput): void {
  const criteria = [input.query, input.title, input.number, input.type, input.published_from, input.published_to].some((v) => v?.trim()) || input.year !== undefined;
  if (!criteria) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "sk_predpis_search needs at least one criterion: query, title, number, year, type or a published_from/published_to range (in_force_on alone would list every act).",
      'Add a criterion — e.g. query: "nájom bytu", title: "Občiansky zákonník" or number: "40/1964".',
    );
  }
  if (input.number?.trim() && !parseActCitation(input.number)) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `number "${input.number}" is not číslo/rok.`, 'Pass number as "40/1964" (number/year), or use year alone.');
  }
}

export async function searchPredpisy(input: PredpisSearchInput, offset: number, limit: number): Promise<PredpisSearchPage> {
  assertSearchInput(input);
  const url = buildPredpisSearchUrl(input, offset, limit);
  const terms = [input.query, input.title].filter((t): t is string => Boolean(t?.trim()));
  return searchCache.through(memoKey("slovlex-predpis-search", url), async () => parsePredpisSearch(await slovlexJson(SOURCE, url), terms));
}

// ---------- versions (history page) ----------

export interface PredpisVersion {
  /** "/SK/ZZ/1964/40/20260731" or "/SK/ZZ/1964/40/vyhlasene_znenie" */
  iri: string;
  /** The last iri segment: "20260731" or "vyhlasene_znenie" — the text file's name. */
  version: string;
  /** The as-announced wording (no effective dates). */
  announced: boolean;
  from?: string;
  /** Absent = open-ended. */
  to?: string;
  /** Amending acts that produced this wording, "58/1969 Zb.". */
  amended_by: string[];
}

/**
 * The history table (on the history page and on every text page) → its
 * versions in document order: as announced first, then oldest to newest.
 * Pure — unit-tested.
 */
export function parseHistory(html: string): PredpisVersion[] {
  const $ = loadHtml(html);
  const versions: PredpisVersion[] = [];
  $("tr.effectivenessHistoryItem").each((_, row) => {
    const $row = $(row);
    const iri = ($row.attr("data-iri") ?? "").trim();
    const version = iri.split("/").pop() ?? "";
    if (!iri || !version) return;
    const announced = $row.attr("data-vyhlasene") === "1" || version === "vyhlasene_znenie";
    const from = isoDay($row.attr("data-ucinnostod"));
    const to = isoDay($row.attr("data-ucinnostdo"));
    const amended_by = $row
      .find("td")
      .eq(2)
      .find("a")
      .map((_, a) => nbsp($(a).text()))
      .get()
      .filter(Boolean);
    versions.push({ iri, version, announced, ...(from ? { from } : {}), ...(to ? { to } : {}), amended_by });
  });
  return versions;
}

/** The date meaning "the as-announced wording" (as in esbirka_get_text). */
export const ANNOUNCED_DATE = "0000-00-00";

/**
 * The version in force on `date` (YYYY-MM-DD), the announced one for
 * "0000-00-00", or null when no version covers the date. An act whose
 * history has no dated version at all reads as announced. Pure.
 */
export function pickVersion(versions: PredpisVersion[], date: string): PredpisVersion | null {
  const announced = versions.find((v) => v.announced) ?? null;
  if (date === ANNOUNCED_DATE) return announced;
  const dated = versions.filter((v) => !v.announced && v.from);
  if (!dated.length) return announced;
  return dated.find((v) => v.from! <= date && (!v.to || date <= v.to)) ?? null;
}

export function historyUrl(year: number, number: number): string {
  return `${SLOVLEX_STATIC}${actIri(year, number)}/`;
}

export function textUrl(year: number, number: number, version: string): string {
  return `${SLOVLEX_STATIC}${actIri(year, number, version)}.html`;
}

/** GET a static page as text; 404 → NOT_FOUND naming the act. */
async function fetchStatic(url: string, what: string, timeoutMs?: number): Promise<string> {
  const response = await fetchUpstream(SOURCE, url, { headers: { accept: "text/html" }, ...(timeoutMs ? { timeoutMs } : {}) });
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError(SOURCE, "NOT_FOUND", `Slov-Lex has no ${what} (${url} → HTTP 404).`, "Check year and number — sk_predpis_search finds the act; a version comes from sk_predpis_get_act.");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Slov-Lex answered HTTP ${response.status} for ${url}.`, "Try again in a minute; if it persists, run dawmain_probe_sources.");
  }
  try {
    return await response.text();
  } catch (error) {
    throw asSourceError(SOURCE, error);
  }
}

/** All versions of an act (cached). 404 → NOT_FOUND; a page without rows → PARSE_DRIFT. */
export async function getVersions(year: number, number: number): Promise<PredpisVersion[]> {
  return historyCache.through(`${year}/${number}`, async () => {
    const html = await fetchStatic(historyUrl(year, number), `act ${defaultCitation(year, number)}`);
    const versions = parseHistory(html);
    if (!versions.length) {
      throw new SourceError(SOURCE, "PARSE_DRIFT", `The Slov-Lex history page of ${defaultCitation(year, number)} lists no versions.`, "The page layout changed — run dawmain_probe_sources; retrying will not help.");
    }
    return versions;
  });
}

export type VersionStatus = "announced" | "current" | "past" | "future";

export function versionStatus(version: PredpisVersion, today: string): VersionStatus {
  if (version.announced) return "announced";
  if (version.from && version.from > today) return "future";
  if (version.to && version.to < today) return "past";
  return "current";
}

export interface ResolvedVersion {
  version: PredpisVersion;
  status: VersionStatus;
  /** Effective dates of versions not yet in force — only when reading the current one. */
  future: string[];
}

/**
 * The version a read quotes: on `date`, or today without one. No version on
 * that date → NOT_FOUND saying which dates the act covers.
 */
export async function resolveVersion(year: number, number: number, date?: string, today = todayIso()): Promise<ResolvedVersion> {
  const versions = await getVersions(year, number);
  const on = date ?? today;
  const version = pickVersion(versions, on);
  if (!version) {
    const dated = versions.filter((v) => !v.announced && v.from);
    const first = dated[0]?.from;
    const last = dated[dated.length - 1];
    const citation = defaultCitation(year, number);
    if (on === ANNOUNCED_DATE) {
      throw new SourceError(SOURCE, "NOT_FOUND", `Slov-Lex has no as-announced wording of ${citation}.`, "Omit date for the version in force today.");
    }
    const message =
      first && on < first
        ? `${citation} was not yet in force on ${on} — its first version is in force from ${first}.`
        : last?.to && on > last.to
          ? `Slov-Lex has no version of ${citation} in force on ${on}: the last one ends ${last.to} (the act may be repealed or replaced).`
          : `Slov-Lex has no version of ${citation} in force on ${on}.`;
    throw new SourceError(SOURCE, "NOT_FOUND", message, `Pass a date covered by its history (sk_predpis_get_act lists the versions), or date: "${ANNOUNCED_DATE}" for the as-announced wording.`);
  }
  const status = versionStatus(version, today);
  const future =
    status === "current"
      ? versions.filter((v) => !v.announced && v.from && v.from > today && (!version.from || v.from > version.from)).map((v) => v.from!)
      : [];
  return { version, status, future };
}

// ---------- the text ----------

export type ActUnitKind = "paragraph" | "article" | "heading" | "note" | "annex" | "other";

export interface ActUnit {
  kind: ActUnitKind;
  /** The label as printed: "§ 1", "Čl. I", "PRVÁ ČASŤ". */
  label?: string;
  /** Match keys: "§:1", "čl:I", "čl:1" (from the label and the id suffix). */
  keys: string[];
  /** For units inside an article that holds paragraphs (Čl. I of "zákon … a o zmene niektorých zákonov"): that article's keys. */
  article?: string[];
  text: string;
  /** Footnotes (ids "poznamky.poznamka-1") the unit refers to. */
  notes: string[];
}

export interface ParsedAct {
  iri?: string;
  title?: string;
  from?: string;
  to?: string;
  units: ActUnit[];
  /** Footnote id → its text ("1) Napríklad …"). */
  notes: Record<string, string>;
  /** Key of a § / čl. quoted (inside .citat) → the labels of the articles that quote it. */
  cited: Record<string, string[]>;
}

/** Container classes walked through, their label + heading becoming a heading unit. */
const STRUCTURE = new Set(["cast", "hlava", "diel", "oddiel", "pododdiel", "skupinaParagrafov"]);
/** Labels printed on a line of their own; the others (odsek "(1)", pismeno "a)", bod "1.") prefix their text. */
const OWN_LINE_LABEL = /^(?:paragraf|clanok|ustavnyclanok|cast|hlava|diel|oddiel|pododdiel|skupinaParagrafov|priloha|predpis)Oznacenie$/;
const BLOCK = new Set(["div", "p", "table", "tbody", "thead", "tr", "td", "th", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

const firstClass = (el: Element): string => (el.attribs.class ?? "").trim().split(/\s+/)[0] ?? "";
const clean = (text: string) => text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const elementChildren = (el: Element): Element[] => (el.children as AnyNode[]).filter((n): n is Element => n.type === "tag");

function inlineText(node: AnyNode): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  if (node.type !== "tag") return "";
  const el = node as Element;
  if (el.name === "br") return " ";
  return (el.children as AnyNode[]).map(inlineText).join("");
}

/** One element's text, a line per odsek / písmeno / bod, labels in front of their text. */
function renderLines(el: Element, lines: string[]): void {
  let buffer = "";
  let pending: string | null = null;
  const push = (raw: string) => {
    const text = clean(raw);
    if (!text) return;
    lines.push(pending ? `${pending} ${text}` : text);
    pending = null;
  };
  const flush = () => {
    push(buffer);
    buffer = "";
  };
  for (const node of el.children as AnyNode[]) {
    if (node.type === "text") {
      buffer += (node as unknown as { data: string }).data;
      continue;
    }
    if (node.type !== "tag") continue;
    const child = node as Element;
    if (child.name === "br") {
      flush();
      continue;
    }
    if (!BLOCK.has(child.name)) {
      buffer += inlineText(child);
      continue;
    }
    flush();
    const cls = firstClass(child);
    if (/Oznacenie$/.test(cls)) {
      const label = clean(inlineText(child));
      if (!label) continue;
      if (pending) lines.push(pending);
      pending = null;
      if (OWN_LINE_LABEL.test(cls)) lines.push(label);
      else pending = label;
      continue;
    }
    const sub: string[] = [];
    renderLines(child, sub);
    if (sub.length && pending) {
      sub[0] = `${pending} ${sub[0]}`;
      pending = null;
    }
    lines.push(...sub);
  }
  flush();
  if (pending) lines.push(pending);
}

function render(el: Element): string {
  const lines: string[] = [];
  renderLines(el, lines);
  return lines.join("\n");
}

/** "„§ 30" → "§:30"; "Čl. I" → "čl:I"; "Článok 5a" → "čl:5a". */
function labelKey(label: string): string | null {
  const text = clean(label).replace(/[„“"]/g, "").trim();
  const paragraph = /^§\s*([0-9]+[a-z]*)\.?$/i.exec(text);
  if (paragraph) return `§:${paragraph[1].toLowerCase()}`;
  const article = /^(?:čl\.?|článok|článek)\s*([0-9]+[a-z]*|[ivxlc]+)\.?$/iu.exec(text);
  if (article) return `čl:${/^[ivxlc]+$/i.test(article[1]) ? article[1].toUpperCase() : article[1].toLowerCase()}`;
  return null;
}

/** The suffix of "paragraf-42a" / "predpis.clanok-1" → its key. */
function idKey(id: string | undefined, kind: "paragraf" | "clanok"): string | null {
  const m = new RegExp(`(?:^|\\.)${kind === "clanok" ? "(?:ustavny)?clanok" : kind}-([0-9]+[a-z]*|[IVXLC]+)$`, "i").exec(id ?? "");
  if (!m) return null;
  const value = /^[ivxlc]+$/i.test(m[1]) && kind === "clanok" && !/^[0-9]/.test(m[1]) ? m[1].toUpperCase() : m[1].toLowerCase();
  return `${kind === "paragraf" ? "§" : "čl"}:${value}`;
}

function ownLabel(el: Element): string | undefined {
  const label = elementChildren(el).find((child) => /Oznacenie$/.test(firstClass(child)));
  return label ? clean(inlineText(label)) || undefined : undefined;
}

function unitKeys(el: Element, kind: "paragraf" | "clanok"): string[] {
  const label = ownLabel(el);
  return [...new Set([label ? labelKey(label) : null, idKey(el.attribs.id, kind)].filter((k): k is string => Boolean(k)))];
}

function hasClass(el: Element, cls: string): boolean {
  return (el.attribs.class ?? "").split(/\s+/).includes(cls);
}

/**
 * Whether a § or článok is the act's own: every container between it and
 * `stop` is a structural one (časť, hlava, …, an article holding §§). A §
 * under .citat — or straight under an amending point (bod), which some
 * pages print without .citat ("Za § 33 sa vkladajú § 33a a 33b, ktoré
 * znejú:") — is the amended act's wording, quoted.
 */
function isOwn(el: Element, stop: Element): boolean {
  for (let p = el.parent as Element | null; p && p !== stop; p = p.parent as Element | null) {
    if (p.type !== "tag") return false;
    const cls = firstClass(p);
    if (!STRUCTURE.has(cls) && cls !== "clanok") return false;
  }
  return true;
}

function descendants(el: Element, cls: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const child of elementChildren(node)) {
      if (hasClass(child, cls)) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

function footnoteRefs(el: Element): string[] {
  const refs: string[] = [];
  const walk = (node: Element) => {
    for (const child of elementChildren(node)) {
      const href = child.name === "a" ? child.attribs.href : undefined;
      if (href?.startsWith("#poznamky.")) refs.push(href.slice(1));
      walk(child);
    }
  };
  walk(el);
  return [...new Set(refs)];
}

/**
 * A text page → a flat sequence of units (paragraphs, articles, structural
 * headings, the rest) plus footnotes and the index of quoted provisions.
 * Never keyed by #paragraf-N alone: in an amending act those ids belong to
 * the quoted wording. Pure — unit-tested.
 */
export function parseActText(html: string): ParsedAct {
  const $ = loadHtml(html);
  const root = $("div#predpis").get(0) as Element | undefined;
  if (!root) {
    throw new SourceError(SOURCE, "PARSE_DRIFT", "The Slov-Lex text page has no div#predpis.", "The page layout changed — run dawmain_probe_sources; retrying will not help.");
  }
  const units: ActUnit[] = [];
  const cited: Record<string, string[]> = {};

  const collect = (children: Element[], article?: string[]) => {
    for (const el of children) {
      const cls = firstClass(el);
      if (STRUCTURE.has(cls)) {
        const head = elementChildren(el)
          .filter((child) => /(?:Oznacenie|Nadpis)$/.test(firstClass(child)))
          .map((child) => clean(inlineText(child)))
          .filter(Boolean);
        if (head.length) units.push({ kind: "heading", label: head[0], keys: [], ...(article ? { article } : {}), text: head.join(" — "), notes: [] });
        collect(bodyOf(el), article);
        continue;
      }
      if (cls === "paragraf") {
        units.push({ kind: "paragraph", label: ownLabel(el), keys: unitKeys(el, "paragraf"), ...(article ? { article } : {}), text: render(el), notes: footnoteRefs(el) });
        continue;
      }
      if (cls === "clanok" || cls === "ustavnyclanok") {
        const keys = unitKeys(el, "clanok");
        // An article holding the act's own §§ (Čl. I of "zákon … a o zmene
        // niektorých zákonov") is walked through, its §§ units of their own.
        const ownParagraphs = descendants(el, "paragraf").some((p) => isOwn(p, el));
        if (ownParagraphs) {
          const label = ownLabel(el);
          if (label) units.push({ kind: "heading", label, keys: [], article: keys, text: label, notes: [] });
          collect(bodyOf(el), keys);
          continue;
        }
        units.push({ kind: "article", label: ownLabel(el), keys, ...(article ? { article } : {}), text: render(el), notes: footnoteRefs(el) });
        continue;
      }
      const text = render(el);
      if (text) units.push({ kind: "other", keys: [], ...(article ? { article } : {}), text, notes: footnoteRefs(el) });
    }
  };
  /** A container's children minus its own label and heading. */
  const bodyOf = (el: Element) => elementChildren(el).filter((child) => !/(?:Oznacenie|Nadpis)$/.test(firstClass(child)));
  collect(elementChildren(root));

  // Quoted provisions: §§ and articles that are not the act's own, by the article quoting them.
  for (const [kind, cls] of [["paragraf", "paragraf"], ["clanok", "clanok"], ["clanok", "ustavnyclanok"]] as const) {
    for (const el of descendants(root, cls)) {
      if (isOwn(el, root)) continue;
      let host: Element | null = null;
      for (let p = el.parent as Element | null; p && p !== root && p.type === "tag"; p = p.parent as Element | null) {
        if ((hasClass(p, "clanok") || hasClass(p, "ustavnyclanok")) && isOwn(p, root)) {
          host = p;
          break;
        }
      }
      const hostLabel = host ? ownLabel(host) ?? "?" : "?";
      for (const key of unitKeys(el, kind)) {
        const list = (cited[key] ??= []);
        if (!list.includes(hostLabel)) list.push(hostLabel);
      }
    }
  }

  const notes: Record<string, string> = {};
  const notesRoot = $("div#poznamky").get(0) as Element | undefined;
  if (notesRoot) {
    const list = descendants(notesRoot, "poznamka").filter((n) => n.attribs.id);
    if (list.length) units.push({ kind: "heading", label: "Poznámky", keys: [], text: "Poznámky pod čiarou", notes: [] });
    for (const note of list) {
      const text = render(note);
      notes[note.attribs.id] = text;
      units.push({ kind: "note", keys: [], text, notes: [] });
    }
  }
  const annexes = $("div#prilohy").get(0) as Element | undefined;
  if (annexes) {
    for (const annex of elementChildren(annexes).filter((el) => hasClass(el, "priloha"))) {
      units.push({ kind: "annex", label: ownLabel(annex), keys: [], text: render(annex), notes: [] });
    }
  }

  const header = $(".ucinnost_header").first();
  const iri = $("div#iri").attr("data-iri");
  const title = clean($("div#predpis\\.nadpis").first().text());
  const from = isoDay(header.attr("data-from"));
  const to = isoDay(header.attr("data-to"));
  return { ...(iri ? { iri } : {}), ...(title ? { title } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), units, notes, cited };
}

/** "§ 12", "12", "3a", "čl. I", "čl. 1", "článok 5" → a label; anything else → null. */
export function parseSkSectionLabel(section: string): SectionLabel | null {
  return parseSectionLabel(section.trim().replace(/^článok\b\.?/iu, "čl."));
}

export type UnitMatch = { units: ActUnit[] } | { citedIn: string[] } | null;

/**
 * The units of one § or one článok: a § by its label or id suffix (never one
 * quoted inside .citat); an article by "Čl. I" or its arabic id ("čl. 1"
 * hits Čl. I), with every unit an article walked through. Only a quoted
 * match → { citedIn: the quoting articles }. Pure — unit-tested.
 */
export function findUnit(act: ParsedAct, label: SectionLabel): UnitMatch {
  const key = `${label.kind === "paragraph" ? "§" : "čl"}:${label.value}`;
  if (label.kind === "paragraph") {
    const unit = act.units.find((u) => u.kind === "paragraph" && u.keys.includes(key));
    if (unit) return { units: [unit] };
  } else {
    const own = act.units.find((u) => u.kind === "article" && u.keys.includes(key));
    if (own) return { units: [own] };
    const walked = act.units.filter((u) => u.article?.includes(key));
    if (walked.length) return { units: walked };
  }
  const quoted = act.cited[key];
  return quoted?.length ? { citedIn: quoted } : null;
}

/** A unit's text with the footnotes it cites, for a single-provision read. */
export function unitText(act: ParsedAct, units: ActUnit[]): string {
  const body = units.map((u) => u.text).join("\n");
  const refs = [...new Set(units.flatMap((u) => u.notes))].map((id) => act.notes[id]).filter(Boolean);
  return refs.length ? `${body}\n\nPoznámky pod čiarou:\n${refs.join("\n")}` : body;
}

/** The whole act cut into pages, breaking only between units. Pure. */
export function actPages(act: ParsedAct): string[] {
  return chunkFragments(act.units.map((u) => (u.kind === "paragraph" || u.kind === "article" || u.kind === "heading" ? `\n${u.text}` : u.text)));
}

/** The parsed text of one version (cached per version). */
export async function getActUnits(year: number, number: number, version: string): Promise<ParsedAct> {
  return actCache.through(`${year}/${number}/${version}`, async () => {
    const html = await fetchStatic(textUrl(year, number, version), `text ${actIri(year, number, version)}`, TEXT_TIMEOUT_MS);
    return parseActText(html);
  });
}

/** Title, type and announcement date from a cislo= search; null when it fails or finds nothing. */
export async function getActMeta(year: number, number: number): Promise<PredpisHit | null> {
  try {
    const page = await searchPredpisy({ number: `${number}/${year}` }, 0, 1);
    return page.items.find((item) => item.year === year && item.number === number) ?? null;
  } catch {
    return null;
  }
}

/** The portal page of an act (no version = the current wording). */
export function portalUrl(year: number, number: number, version?: string): string {
  return `${SLOVLEX_WEB}/ezbierky/pravne-predpisy${actIri(year, number, version)}`;
}
