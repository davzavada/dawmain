import { SourceError } from "./shared/errors";
import { CookieSession, fetchUpstream } from "./shared/http";
import { decodeBody, htmlToText, loadHtml, looksLikeHtml } from "./shared/html";
import { czechToIso } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * Nejvyšší správní soud — vyhledavac.nssoud.cz (server-rendered ASP.NET Core
 * MVC; no JSON API).
 *
 * Search needs an antiforgery handshake: GET / (cookies + token + ALL form
 * fields — the model binder rejects partial posts), then POST /Home/Index
 * echoing everything plus the criteria. Field indices for the criteria are
 * NOT hardcoded: the live form is harvested and criteria are located by the
 * hidden `…TechnickyNazev` sibling (verbatim technical names captured from a
 * live browser POST, 2026-08), because the `vyhledavaciSekce[…]` indices
 * shift between form versions. Codebook criteria (soud/senát, rejstřík,
 * oblast úpravy) post `HodnotaCiselnikPolozkySelected` id lists resolved at
 * runtime from the `ciselnikTreeData` blobs the form itself carries — the
 * Selected field is absent from the raw HTML (the UI widget synthesizes it),
 * so it is constructed from the TechnickyNazev prefix. Document endpoints
 * are sessionless; the plain-text variant is UTF-16.
 * See docs/research/cz-sources.json.
 */

const SOURCE = "Nejvyšší správní soud";
const BASE = "https://vyhledavac.nssoud.cz";
/** Fresh sessions per request trip NSS rate limiting — cache the handshake. */
const SESSION_TTL_MS = 10 * 60 * 1000;

// ---------- form harvest ----------

export interface NssFormField {
  name: string;
  value: string;
  label: string;
}

export interface NssForm {
  fields: NssFormField[];
}

/** Harvest every form field with its nearest label text. Pure — unit-tested. */
export function parseNssForm(html: string): NssForm {
  const $ = loadHtml(html);
  const form = $("form").first();
  if (!form.length || !form.find("input[name='__RequestVerificationToken']").length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NSS landing page has no search form with an antiforgery token.",
      "The portal may be down or redesigned — run dawmain_probe_sources (canary 'nss') with include_raw.",
    );
  }
  const fields: NssFormField[] = [];
  form.find("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const type = ($el.attr("type") ?? "").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") return;
    // Unchecked checkboxes/radios are not submitted by a browser — mirror that.
    if ((type === "checkbox" || type === "radio") && $el.attr("checked") === undefined) return;
    const label =
      $el.closest("div").find("label").first().text().trim() ||
      $el.attr("placeholder") ||
      $el.attr("aria-label") ||
      "";
    fields.push({ name, value: $el.attr("value") ?? "", label: label.replace(/\s+/g, " ") });
  });
  return { fields };
}

/**
 * Locate a criteria input. The reliable identifier is the VALUE of the sibling
 * hidden `…TechnickyNazev` field (e.g. "datumvydanirozhodnuti") — the numeric
 * indices in the names shift between form versions. Strategy: find a
 * TechnickyNazev (value-level, then condition-level) whose value matches
 * `technicalPattern`, take its prefix, and return the input `prefix + suffix`.
 * Fallback: a label match, which still identifies the criterion by meaning.
 *
 * The blind "first field carrying this suffix" fallback applies ONLY when the
 * caller named no technical pattern. Where one was named and the form no
 * longer answers it, the criterion is genuinely lost, and guessing by
 * datatype is worse than saying so: every text criterion ends in
 * `.HodnotaText` and every date in `.HodnotaDatumACasOd`, so the guess files
 * the full text into "číslo jednací", or a decision-date bound onto the
 * publication date — and NSS answers that with a plausible, wrong result set
 * instead of an error. A rešerše may fail loudly; it must not quietly answer
 * a different question. Pure.
 */
export function findField(
  form: NssForm,
  suffix: string | null,
  labelPattern: RegExp | null,
  technicalPattern?: RegExp,
): NssFormField | undefined {
  if (technicalPattern && suffix) {
    for (const field of form.fields) {
      if (!field.name.endsWith(".TechnickyNazev") || !technicalPattern.test(field.value)) continue;
      const prefix = field.name.slice(0, -".TechnickyNazev".length);
      // Value-level sibling (same vyhledavaciPodminkaHodnota[j] prefix)…
      const direct = form.fields.find((candidate) => candidate.name === prefix + suffix);
      if (direct) return direct;
      // …or condition-level: any value input nested under this condition.
      const nested = form.fields.find(
        (candidate) => candidate.name.startsWith(prefix + ".") && candidate.name.endsWith(suffix),
      );
      if (nested) return nested;
    }
  }
  if (suffix && !technicalPattern) {
    const bySuffix = form.fields.find((field) => field.name.endsWith(suffix));
    if (bySuffix) return bySuffix;
  }
  if (labelPattern) {
    return form.fields.find(
      (field) => field.name.includes("vyhledavaciSekce") && labelPattern.test(field.label),
    );
  }
  return undefined;
}

/**
 * Strict variant of findField for the criteria whose technical names were
 * captured verbatim: only the value-level TechnickyNazev route, no suffix or
 * label fallback — a fallback here would silently file the criterion into a
 * WRONG field of the same datatype (e.g. poř. č. instead of číslo předpisu).
 */
export function findFieldStrict(
  form: NssForm,
  technicalPattern: RegExp,
  suffix: string,
): NssFormField | undefined {
  const prefix = findValuePrefix(form, technicalPattern);
  return prefix ? form.fields.find((field) => field.name === prefix + suffix) : undefined;
}

/** Name prefix of the value-level entry (`…vyhledavaciPodminkaHodnota[j]`). */
export function findValuePrefix(form: NssForm, technicalPattern: RegExp): string | undefined {
  for (const field of form.fields) {
    if (
      field.name.endsWith(".TechnickyNazev") &&
      field.name.includes("vyhledavaciPodminkaHodnota") &&
      technicalPattern.test(field.value)
    ) {
      return field.name.slice(0, -".TechnickyNazev".length);
    }
  }
  return undefined;
}

// ---------- codebooks (číselníky) ----------

export interface CiselnikNode {
  id: number;
  title: string;
  subs?: CiselnikNode[];
}

/** The codebooks ship as JS object literals (unquoted keys) in hidden inputs. */
export function parseCiselnikTree(raw: string): CiselnikNode[] {
  try {
    const parsed = JSON.parse(raw.replace(/([{,])(id|title|subs):/g, '$1"$2":')) as CiselnikNode[];
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "An NSS codebook (ciselnikTreeData) is no longer parseable.",
      "The form markup changed — run dawmain_probe_sources (canary 'nss') and update parseCiselnikTree in src/sources/nss.ts.",
    );
  }
}

const fold = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Select codebook entries whose title satisfies `matches`; a matching node
 * brings ALL its descendants along — mirroring the UI, where checking a
 * parent checks the whole subtree (the captured POST for "krajské soudy"
 * carries the group id plus every court and pobočka under it).
 */
export function selectFromCiselnik(
  nodes: CiselnikNode[],
  matches: (title: string) => boolean,
): { ids: number[]; titles: string[] } {
  const ids: number[] = [];
  const titles: string[] = [];
  const addSubtree = (node: CiselnikNode) => {
    if (!ids.includes(node.id)) {
      ids.push(node.id);
      titles.push(node.title);
    }
    for (const sub of node.subs ?? []) addSubtree(sub);
  };
  const walk = (list: CiselnikNode[]) => {
    for (const node of list) {
      if (matches(node.title)) addSubtree(node);
      else if (node.subs) walk(node.subs);
    }
  };
  walk(nodes);
  return { ids, titles };
}

/** Flat title list, for "no such value — pick one of:" error hints. */
export function ciselnikTitles(nodes: CiselnikNode[]): string[] {
  const titles: string[] = [];
  const walk = (list: CiselnikNode[]) => {
    for (const node of list) {
      titles.push(node.title);
      if (node.subs) walk(node.subs);
    }
  };
  walk(nodes);
  return titles;
}

// ---------- applied-provision references ----------

export interface NssActRef {
  cislo: string;
  rok: string;
  /** Community qualifier of an EU citation ("ES" in "2004/48/ES"). */
  druh?: string;
}

/**
 * "číslo/rok" act reference. Czech Sb./Sb.m.s. citations put the year second
 * ("106/1999 Sb."); modern EU citations put it first ("2016/679", "2004/48"),
 * pre-2015 regulations second ("1049/2001") — with euStyle a leading 4-digit
 * year wins, otherwise the trailing one. A community qualifier ("2004/48/ES")
 * comes back as druh, to be posted into the EU row's druh dial.
 */
export function parseNssActRef(ref: string, euStyle: boolean): NssActRef {
  const m = /^\s*(?:č\.\s*)?(\d{1,4})\s*\/\s*(\d{1,4})(?:\s*\/?\s*(EU|ES|EHS|EURATOM))?(?:\s*Sb\.?(?:\s*m\.?\s*s\.?)?)?\s*$/i.exec(
    ref,
  );
  const isYear = (part: string) => /^\d{4}$/.test(part) && Number(part) >= 1900 && Number(part) <= 2099;
  if (m) {
    const druh = m[3] ? { druh: m[3].toUpperCase() } : {};
    if (euStyle && isYear(m[1])) return { cislo: m[2], rok: m[1], ...druh };
    if (isYear(m[2])) return { cislo: m[1], rok: m[2], ...druh };
    if (isYear(m[1])) return { cislo: m[2], rok: m[1], ...druh };
  }
  throw new SourceError(
    SOURCE,
    "INPUT_INVALID",
    `"${ref}" is not a recognizable act reference.`,
    "Use 'číslo/rok': '106/1999' (Sb.), '209/1992' (Sb.m.s.), '2016/679' or '1049/2001' (EU).",
  );
}

export interface NssProvision {
  /** Explicit marker: § vs. článek. Unset = § for Sb., čl. elsewhere. */
  kind?: "par" | "cl";
  unit: string;
  odst?: string;
  pism?: string;
}

/** "§ 17 odst. 2 písm. a", "čl. 8 odst. 2", or compact "17(2)(a)". */
export function parseNssProvision(ref: string): NssProvision {
  const text = ref.trim().replace(/\s+/g, " ");
  // Longest alternatives first — "čl" would otherwise eat "článek"'s prefix.
  const kindMatch = /^(§|článek|čl\.?|cl\.?|art(?:icle)?\.?)\s*/iu.exec(text);
  const kind = kindMatch ? (kindMatch[1] === "§" ? "par" : "cl") : undefined;
  const rest = kindMatch ? text.slice(kindMatch[0].length) : text;
  const m =
    /^(\d+[a-z]*)(?:\s*\(\s*(\d+[a-z]*)\s*\)|\s+odst\.?\s*(\d+[a-z]*))?(?:\s*\(\s*([a-z]{1,2})\s*\)|\s+p[íi]sm\.?\s*([a-z]{1,2})\)?)?$/i.exec(
      rest,
    );
  if (!m) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${ref}" is not a recognizable provision reference.`,
      "Use '§ 17 odst. 2 písm. a', 'čl. 8 odst. 2', or compact '17(2)(a)'.",
    );
  }
  return { kind, unit: m[1], odst: m[2] ?? m[3], pism: m[4] ?? m[5] };
}

// ---------- results ----------

export interface NssHit {
  id: string;
  caseNumber?: string;
  court?: string;
  date?: string; // ISO
  form?: string;
  url: string;
}

export interface NssResultsPage {
  total: number | null;
  hits: NssHit[];
  /** Pagination context embedded in the inline script (needed for page > 1). */
  pagination: { currParams: string; currViewId: string; currSort: string } | null;
  /** True when the response is the blank form again (expired session). */
  blankForm: boolean;
}

const COUNT_RE = /Počet nalezených záznamů:\s*([\d\s]+)/;
const RESULT_ID_INPUT = "input[name^='ZobrazeneVysledky'][name$='.ID']";

/**
 * Decode an inline <script> string literal the way the browser's JS engine
 * does. NSS writes currParams through JavaScriptEncoder, and a quote INSIDE a
 * JSON string value — every codebook criterion's ciselnikTreeData
 * (`title:\"kárné soudy\"`), a quoted-phrase query — arrives as `\\\u0022`:
 * an escaped backslash, then an escaped quote. Rewriting only \uXXXX leaves
 * `\\"`, which is invalid JSON, and MyResTRowsCont answers that with no rows —
 * page 2+ of every court/registry/area/phrase search came back empty
 * (measured live 2026-09: court 'nss', "dobré mravy", page 2 = "719
 * decisions", 0 rows). One pass over every escape consumes `\\` before a
 * following `u` can be misread. Pure.
 */
export function decodeNssScriptLiteral(value: string): string {
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  return value.replace(
    /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (_, unicode: string | undefined, hex: string | undefined, char: string) =>
      unicode
        ? String.fromCharCode(parseInt(unicode, 16))
        : hex
          ? String.fromCharCode(parseInt(hex, 16))
          : (simple[char] ?? char),
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Parse the search response or a MyResTRowsCont fragment. Pure — unit-tested. */
export function parseNssResults(html: string): NssResultsPage {
  const countMatch = COUNT_RE.exec(html);
  // MyResTRowsCont answers bare `<tbody><tr><td>…` rows. Outside a table the
  // parser drops those start tags (the HTML spec's "in body" mode), so every
  // row lost its citation and cells and page 2+ printed "? — id N" (measured
  // live 2026-09). Parsed in table context they read exactly like page 1.
  // A fragment is told by what it starts with, not by the absence of
  // "<table" anywhere: a row whose cell holds a table of its own would
  // otherwise be parsed out of context again.
  const fragment =
    !/<(?:html|body)[\s>]/i.test(html) &&
    (/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:tbody|tr)[\s>]/i.test(html) || !/<table[\s>]/i.test(html));
  const $ = loadHtml(fragment ? `<table>${html}</table>` : html);

  const hits: NssHit[] = [];
  $(RESULT_ID_INPUT).each((_, el) => {
    const $input = $(el);
    const id = $input.attr("value");
    if (!id) return;
    // A row's own <tbody> — but only while it holds this one result: bare <tr>
    // rows in table context share ONE implied tbody, and reading the citation
    // from there would lend the first row's case number to every hit.
    const tbody = $input.closest("tbody");
    const container = tbody.length && tbody.find(RESULT_ID_INPUT).length === 1 ? tbody : $input.closest("tr");
    const citationAnchor = container.find("a[title^='Citace']").first();
    const citation = citationAnchor.attr("title")?.replace(/^Citace:\s*/, "").trim();
    // "rozsudek {court} ze dne {date}, čj. {spisová značka}"
    let court: string | undefined;
    let date: string | undefined;
    let form: string | undefined;
    let caseNumber: string | undefined;
    if (citation) {
      const m = /^(\S+)\s+(.*?)\s+ze dne\s+([\d.\s/]+?),\s*čj\.\s*(.+)$/u.exec(citation);
      if (m) {
        form = m[1];
        court = m[2];
        date = czechToIso(m[3]) ?? undefined;
        caseNumber = m[4].replace(/ /g, " ").trim();
      }
    }
    if (!caseNumber) {
      // Fall back to the cell texts: date cell + case-number cell.
      const cells = container.find("td").toArray().map((cell) => $(cell).text().trim());
      date = date ?? cells.map((cell) => czechToIso(cell)).find((iso): iso is string => Boolean(iso));
      caseNumber = cells.find((cell) => /\d+\s*\/\s*\d{4}/.test(cell));
    }
    hits.push({ id, caseNumber, court, date, form, url: `${BASE}/DokumentOriginal/Html/${id}` });
  });

  let pagination: NssResultsPage["pagination"] = null;
  const currParams = /var\s+currParams\s*=\s*'([^']*)'/.exec(html);
  const currViewId = /var\s+currViewId\s*=\s*'([^']*)'/.exec(html);
  const currSort = /var\s+currSort\s*=\s*'([^']*)'/.exec(html);
  if (currParams && currViewId && currSort) {
    const params = decodeNssScriptLiteral(currParams[1]);
    // Undecodable conditions would come back from MyResTRowsCont as an empty
    // page that reads like the end of the results — no context is honest.
    if (isJson(params)) {
      pagination = {
        currParams: params,
        currViewId: currViewId[1],
        currSort: decodeNssScriptLiteral(currSort[1]),
      };
    }
  }

  const blankForm =
    !countMatch && !hits.length && html.includes("__RequestVerificationToken");

  return {
    total: countMatch ? Number(countMatch[1].replace(/\s+/g, "")) : null,
    hits,
    pagination,
    blankForm,
  };
}

// ---------- decision detail ----------

export interface NssDecision {
  id: string;
  metadata: Record<string, string>;
  /** The detail page failed this time (not cached) — the metadata is missing, not absent. */
  metadataUnavailable?: boolean;
  text: string;
  url: string;
}

/**
 * Technical field names confirmed live on /DokumentDetail/Index/{id}
 * (captured 2026-08 via probe fetch_url). They appear as `data-field-id`
 * ATTRIBUTES — on `div.detcard` rows (value in a child `span.det-textval`)
 * and on table cells (`td.det-textval` is itself the value; the matching
 * `td.det-textitle` header carries the same attribute and must be skipped).
 */
const DETAIL_FIELDS: Record<string, string> = {
  oznacenivecivcelku: "Spisová značka",
  ecli: "ECLI",
  soudsenat: "Soud (senát)",
  soudcezpravodaj: "Soudce zpravodaj",
  druhdokumentuavyrokrozhodnuti: "Druh dokumentu",
  vyrokrozhodnuti: "Výrok rozhodnutí NSS",
  typrizeni: "Typ řízení",
  stavrizeni: "Stav řízení",
  rozhodnutivevztahukrizeni: "Rozhodnutí ve vztahu k řízení",
  datumvydanirozhodnuti: "Datum vydání rozhodnutí",
  pravnivetaanv: "Právní věta",
  sbnsspublikovano: "Sb. NSS publikováno",
  oblastupravy: "Oblast úpravy",
  ucastnikrizeni: "Účastníci řízení",
  zastupce: "Zástupce",
  nazevspravnihoorganu: "Správní orgán",
};

/** Parse the metadata detail page. Pure — unit-tested. */
export function parseNssDetail(html: string): Record<string, string> {
  const $ = loadHtml(html);
  const metadata: Record<string, string> = {};
  for (const [fieldId, label] of Object.entries(DETAIL_FIELDS)) {
    const values: string[] = [];
    $(`[data-field-id='${fieldId}']`).each((_, el) => {
      const $el = $(el);
      const text = ($el.hasClass("det-textval") ? $el : $el.find(".det-textval"))
        .text()
        .replace(/\s+/g, " ")
        .trim();
      if (text) values.push(text);
    });
    if (values.length) metadata[label] = [...new Set(values)].join("; ");
  }
  return metadata;
}

/**
 * The Text/Html endpoints signal a missing document with a tiny 'N/A' body.
 * That page is UTF-16 without a charset (live 2026-09: "HTTP 200 text/html"),
 * so read as UTF-8 it carries a NUL after every character (216 chars, the tag
 * boundaries broken) — the NULs and BOM remnants are dropped before judging.
 */
export function isNssMissingBody(body: string): boolean {
  const clean = body.replace(/[\u0000\ufeff\ufffd]/g, "");
  return clean.length < 200 && /(^|>)\s*N\/A\s*(<|$)/.test(clean);
}

// ---------- I/O ----------

interface NssSession {
  cookies: CookieSession;
  fields: NssFormField[];
  fetchedAt: number;
}

let cachedSession: NssSession | null = null;
/** The handshake under way — concurrent callers share it instead of each opening a session. */
let pendingSession: Promise<NssSession> | null = null;

/**
 * The cached session, or a fresh one. Every search that starts while a
 * handshake is under way awaits that same handshake: a cold caselaw_search
 * with 3 variants used to open 3 sessions at once (a multi-variant page p up
 * to 3·p) — the burst the rate limit above punishes. `stale` is the session a
 * caller just saw rejected: a replacement is fetched only while it is still
 * the cached one — a newer session another caller already fetched is reused,
 * so N requests hitting one expiry cost one GET /, not N.
 */
function handshake(stale?: NssSession): Promise<NssSession> {
  if (cachedSession && cachedSession !== stale && Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS) {
    return Promise.resolve(cachedSession);
  }
  pendingSession ??= (async () => {
    const cookies = new CookieSession();
    const response = await fetchUpstream(SOURCE, `${BASE}/`);
    cookies.absorb(response);
    const { fields } = parseNssForm(await response.text());
    cachedSession = { cookies, fields, fetchedAt: Date.now() };
    return cachedSession;
  })().finally(() => {
    pendingSession = null;
  });
  return pendingSession;
}

export interface NssSearchInput {
  query?: string;
  caseNumber?: string;
  dateFrom?: string; // ISO — datum vydání rozhodnutí
  dateTo?: string; // ISO
  publishedFrom?: string; // ISO — datum zpřístupnění (aktualizovano)
  publishedTo?: string; // ISO
  court?: "nss" | "rozsireny-senat" | "krajske" | "karne";
  /** Rejstřík code, e.g. "Afs" — exact match against the dial codebook. */
  registry?: string;
  /** Oblast úpravy — substring; every matching area is selected (OR). */
  area?: string;
  appliesAct?: string; // Sb. — "106/1999"
  appliesTreaty?: string; // Sb.m.s. — "209/1992"
  appliesEuRegulation?: string; // "2016/679" or "1049/2001"
  appliesEuDirective?: string; // "2004/48"
  appliesProvision?: string; // "§ 17 odst. 2 písm. a" | "čl. 8" | "17(2)(a)"
}

/**
 * Every captured NSS POST carries dates zero-padded (DD.MM.YYYY) — pad here
 * instead of using the shared unpadded isoToCzech (which mirrors NALUS).
 */
function isoToCzechPadded(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * A bound NSS cannot bind is not an error there: "30.02.2026" is nulled by the
 * model binder and the search runs WITHOUT it (measured live 2026-09:
 * date_from 2026-02-30 answered the identical 719 hits, 2025 decisions
 * included, as no date at all). Impossible days and inverted ranges are
 * therefore refused here, before any request. Pure.
 */
export function validateNssDates(input: NssSearchInput): void {
  const bounds: Array<[string, string | undefined]> = [
    ["date_from", input.dateFrom],
    ["date_to", input.dateTo],
    ["published_from", input.publishedFrom],
    ["published_to", input.publishedTo],
  ];
  for (const [label, value] of bounds) {
    if (value === undefined) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (
      !m ||
      !date ||
      date.getUTCFullYear() !== Number(m[1]) ||
      date.getUTCMonth() !== Number(m[2]) - 1 ||
      date.getUTCDate() !== Number(m[3])
    ) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `${label} "${value}" is not a real date.`,
        "Use an existing day as YYYY-MM-DD, e.g. 2026-02-28 for the end of February.",
      );
    }
  }
  const ranges: Array<[string, string | undefined, string, string | undefined]> = [
    ["date_from", input.dateFrom, "date_to", input.dateTo],
    ["published_from", input.publishedFrom, "published_to", input.publishedTo],
  ];
  for (const [fromLabel, from, toLabel, to] of ranges) {
    if (from && to && from > to) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `${fromLabel} ${from} is after ${toLabel} ${to}.`,
        `Swap them — ${fromLabel} is the earlier bound.`,
      );
    }
  }
}

/**
 * The full-text value as NSS can match it. The index has no '§' token: any
 * query containing one answers 0 (measured live 2026-09: "náhrada nemajetkové
 * újmy § 2958" = 0, the same words without '§' = 2), so it goes — the number
 * after it still narrows. Pure.
 */
export function nssFullText(query: string): string {
  return query.replace(/§+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Codebook nodes behind the `court` filter (titles verbatim from the live
 * tree). "karne" is two nodes: the kárné soudy at NS and the vrchní soudy
 * (Ds, since the 2025 reform) and the NSS's own kárný senát under the NSS
 * node, which decided every disciplinary case of judges, prosecutors and
 * executors until then (Kss, Ksz, Kse…; live 2026-09: 362 Kss decisions,
 * none reachable through "kárné soudy" alone).
 */
const NSS_COURT_GROUPS: Record<NonNullable<NssSearchInput["court"]>, string[]> = {
  nss: ["Nejvyšší správní soud"],
  "rozsireny-senat": ["rozšířený senát NSS"],
  krajske: ["krajské soudy"],
  karne: ["kárné soudy", "kárný senát"],
};

/**
 * Applies_* family consistency. Runs BEFORE the generic empty-criteria guard
 * (and before any network I/O): a caller who DID pass applies_provision must
 * hear what is missing, not "provide at least one criterion". Returns the
 * act filters that are set.
 */
export function validateNssApplies(input: NssSearchInput): string[] {
  const actFilters = [
    input.appliesAct,
    input.appliesTreaty,
    input.appliesEuRegulation,
    input.appliesEuDirective,
  ].filter((value): value is string => Boolean(value));
  if (actFilters.length > 1) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "Pass at most one of applies_act / applies_treaty / applies_eu_regulation / applies_eu_directive.",
      "The NSS form has one row per act family — run separate searches to combine them.",
    );
  }
  if (input.appliesProvision && !actFilters.length) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "applies_provision needs an act to attach to.",
      "Pair it with applies_act, applies_treaty, applies_eu_regulation, or applies_eu_directive.",
    );
  }
  return actFilters;
}

/** Build the search POST body from the harvested form. Pure — unit-tested. */
export function buildNssSearchForm(fields: NssFormField[], input: NssSearchInput): URLSearchParams {
  const form = new URLSearchParams();
  for (const field of fields) form.set(field.name, field.value);
  const formModel: NssForm = { fields };

  const drift = (criterion: string): never => {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `Could not locate the NSS form field for ${criterion}.`,
      "The search form changed. Run dawmain_probe_sources with discover:true and update the field mapping in src/sources/nss.ts; date-range search may still work.",
    );
  };
  // No two criteria may end up in the same input. Every setter goes through
  // this: a lookup that lands on an input another criterion already owns is
  // drift, not a search — otherwise the second value silently overwrites the
  // first and NSS answers a question nobody asked.
  const claimed = new Map<string, string>();
  const claim = (criterion: string, name: string, value: string): void => {
    const owner = claimed.get(name);
    if (owner && owner !== criterion) {
      throw new SourceError(
        SOURCE,
        "PARSE_DRIFT",
        `The NSS form fields for "${owner}" and "${criterion}" resolved to the same input (${name}).`,
        "The search form changed. Run dawmain_probe_sources with discover:true and update the field mapping in src/sources/nss.ts; searching on one criterion at a time may still work.",
      );
    }
    claimed.set(name, criterion);
    form.set(name, value);
  };
  const setCriterion = (
    criterion: string,
    value: string,
    suffix: string | null,
    labelPattern: RegExp | null,
    technicalPattern?: RegExp,
  ) => {
    const field = findField(formModel, suffix, labelPattern, technicalPattern);
    if (!field) drift(criterion);
    else claim(criterion, field.name, value);
  };
  // Verbatim-captured technical names — never fall back to a same-suffix field.
  const setStrict = (criterion: string, value: string, technicalPattern: RegExp, suffix: string) => {
    const field = findFieldStrict(formModel, technicalPattern, suffix);
    if (!field) drift(criterion);
    else claim(criterion, field.name, value);
  };
  const setDial = (
    criterion: string,
    technicalPattern: RegExp,
    pick: (tree: CiselnikNode[]) => { ids: number[]; titles: string[] },
  ) => {
    const prefix = findValuePrefix(formModel, technicalPattern);
    const treeField = prefix
      ? fields.find((field) => field.name === `${prefix}.ciselnikTreeData`)
      : undefined;
    if (!prefix || !treeField) return drift(criterion);
    const { ids, titles } = pick(parseCiselnikTree(treeField.value));
    claim(criterion, `${prefix}.HodnotaCiselnikPolozky`, titles.join(", "));
    // Synthesized: the UI widget creates this field client-side on submit —
    // it is absent from the raw HTML, but it is what the server filters by.
    claim(criterion, `${prefix}.HodnotaCiselnikPolozkySelected`, ids.join(","));
  };

  validateNssDates(input);
  if (input.dateFrom) {
    setCriterion("date from", isoToCzechPadded(input.dateFrom), ".HodnotaDatumACasOd", null, /^datumvydanirozhodnuti$/);
  }
  if (input.dateTo) {
    setCriterion("date to", isoToCzechPadded(input.dateTo), ".HodnotaDatumACasDo", null, /^datumvydanirozhodnuti$/);
  }
  if (input.publishedFrom) {
    setStrict("published from", isoToCzechPadded(input.publishedFrom), /^aktualizovano$/, ".HodnotaDatumACasOd");
  }
  if (input.publishedTo) {
    setStrict("published to", isoToCzechPadded(input.publishedTo), /^aktualizovano$/, ".HodnotaDatumACasDo");
  }
  const fullText = input.query ? nssFullText(input.query) : "";
  if (fullText) {
    setCriterion(
      "full text",
      fullText,
      ".HodnotaText",
      /pln[ýé]\s*text|fulltext|text\s+rozhodnutí|slova/i,
      /^textdokumentu$|fulltext|^text/i,
    );
  }
  if (input.caseNumber) {
    setCriterion(
      "case number",
      input.caseNumber,
      ".HodnotaText",
      /spisov[áé]\s*značk|čísl[oa]\s*jednací|čj/i,
      /oznacenivecivcelku|cislojednaci|spisovaznacka/i,
    );
  }
  if (input.court) {
    const groups = NSS_COURT_GROUPS[input.court];
    const wanted = groups.map(fold);
    setDial("court", /^soudsenat$/, (tree) => {
      const selection = selectFromCiselnik(tree, (title) => wanted.includes(fold(title)));
      // Every node must be found: a group that silently lost half its nodes
      // would answer a narrower question under the same name.
      const found = new Set(selection.titles.map(fold));
      const missing = groups.find((title) => !found.has(fold(title)));
      if (missing) drift(`court group "${missing}"`);
      return selection;
    });
  }
  if (input.registry) {
    const wanted = fold(input.registry);
    setDial("registry", /^oznacenivecidelenerejstrikovaznacka$/, (tree) => {
      const selection = selectFromCiselnik(tree, (title) => fold(title) === wanted);
      if (!selection.ids.length) {
        throw new SourceError(
          SOURCE,
          "INPUT_INVALID",
          `"${input.registry}" is not an NSS rejstřík code.`,
          `Valid codes: ${ciselnikTitles(tree).join(", ")}.`,
        );
      }
      return selection;
    });
  }
  if (input.area) {
    const wanted = fold(input.area);
    setDial("area", /^oblastupravy$/, (tree) => {
      const selection = selectFromCiselnik(tree, (title) => fold(title).includes(wanted));
      if (!selection.ids.length) {
        throw new SourceError(
          SOURCE,
          "INPUT_INVALID",
          `No oblast úpravy matches "${input.area}".`,
          `Available areas: ${ciselnikTitles(tree).join("; ")}.`,
        );
      }
      return selection;
    });
  }

  const actFilters = validateNssApplies(input);
  if (actFilters.length) {
    // Field-name stem of the row this reference belongs to; Sb.m.s. has no
    // písm. field and Sb. is the only row where a bare unit means §.
    const row = input.appliesAct
      ? { stem: "aplikovanepravnipredpisysb", ref: input.appliesAct, eu: false, par: "aplikovanepravnipredpisysb§", pism: true }
      : input.appliesTreaty
        ? { stem: "aplikovanepravnipredpisysbms", ref: input.appliesTreaty, eu: false, par: null, pism: false }
        : input.appliesEuRegulation
          ? { stem: "aplikovanepravnipredpisynarizenieu", ref: input.appliesEuRegulation, eu: true, par: null, pism: true }
          : { stem: "aplikovanepravnipredpisysmerniceeu", ref: input.appliesEuDirective!, eu: true, par: null, pism: true };
    const act = parseNssActRef(row.ref, row.eu);
    const exact = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    setStrict("applied act number", act.cislo, exact(`${row.stem}cislo`), ".HodnotaCislo");
    setStrict("applied act year", act.rok, exact(`${row.stem}rok`), ".HodnotaCislo");
    if (act.druh) {
      if (!row.eu) {
        throw new SourceError(
          SOURCE,
          "INPUT_INVALID",
          `A community qualifier ("/${act.druh}") only belongs on an EU act reference.`,
          "Drop it, or move the reference to applies_eu_regulation / applies_eu_directive.",
        );
      }
      // "2004/48/ES" narrows the EU row's druh dial to that community series.
      setDial("applied act druh", exact(`${row.stem}druh`), (tree) => {
        const selection = selectFromCiselnik(tree, (title) => fold(title) === fold(act.druh!));
        if (!selection.ids.length) drift(`druh "${act.druh}"`);
        return selection;
      });
    }
    if (input.appliesProvision) {
      const provision = parseNssProvision(input.appliesProvision);
      const asParagraph = row.par !== null && provision.kind !== "cl";
      if (asParagraph) {
        setStrict("applied §", provision.unit, exact(row.par!), ".HodnotaText");
      } else {
        setStrict("applied čl.", provision.unit, exact(`${row.stem}cl`), ".HodnotaText");
      }
      if (provision.odst) {
        setStrict("applied odst.", provision.odst, exact(`${row.stem}odst`), ".HodnotaText");
      }
      if (provision.pism) {
        if (!row.pism) {
          throw new SourceError(
            SOURCE,
            "INPUT_INVALID",
            "The Sb.m.s. row has no písm. field.",
            "Narrow a treaty reference to čl./odst. only.",
          );
        }
        setStrict("applied písm.", provision.pism, exact(`${row.stem}pism`), ".HodnotaText");
      }
    }
  }

  return form;
}

interface NssAnswer {
  status: number;
  ok: boolean;
  html: string;
}

/** Release a body nobody will read, so its connection is freed at once. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function postSearch(session: NssSession, input: NssSearchInput): Promise<NssAnswer> {
  const form = buildNssSearchForm(session.fields, input);

  const response = await fetchUpstream(SOURCE, `${BASE}/Home/Index`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session.cookies.header(),
      referer: `${BASE}`,
    },
    body: form.toString(),
    timeoutMs: 25_000,
  });
  session.cookies.absorb(response);
  if (!response.ok) {
    await discard(response);
    return { status: response.status, ok: false, html: "" };
  }
  return { status: response.status, ok: true, html: await response.text() };
}

export interface NssSearchResult extends NssResultsPage {
  /** Tool-level page semantics: page 1 = inline 40 rows, later pages = 20. */
  page: number;
}

export interface NssSearchOptions {
  /**
   * When the caller's clock for this search started (Date.now()). A page > 1
   * budgets its row fragment from here — pass it when the caller itself ran
   * page 1 just before. Not part of the cache key.
   */
  since?: number;
}

const searchCache = new TtlCache<NssSearchResult>(SEARCH_TTL_MS);
/** Decision texts are big — a couple of dozen at most; metadata is small. */
const textCache = new TtlCache<string>(DOCUMENT_TTL_MS, 24);
const metadataCache = new TtlCache<Record<string, string>>(DOCUMENT_TTL_MS);

/** Rows on the inline first page; every MyResTRowsCont page carries 20. */
const FIRST_PAGE_ROWS = 40;
const LATER_PAGE_ROWS = 20;
/**
 * Page 1 (handshake included) plus one row fragment together. The fragment
 * re-runs the same full-text search upstream, so it deserves the 25 s the
 * Index POST gets — when page 1 came from the cache. A call that had to run
 * page 1 first leaves the fragment only the rest (never under 10 s), so a
 * slow search, its fragment and the 15 s read_top previews stay inside the
 * 60 s function limit.
 */
const PAGING_BUDGET_MS = 40_000;
const FRAGMENT_MAX_TIMEOUT_MS = 25_000;
const FRAGMENT_MIN_TIMEOUT_MS = 10_000;

/**
 * Statuses an expired or rejected antiforgery session may answer with instead
 * of the documented blank 200 form (ASP.NET Core's default rejection is 400).
 * They get the same single re-handshake before the search is given up.
 */
const STALE_SESSION_STATUSES = new Set([400, 403, 419]);

export async function searchNss(
  input: NssSearchInput,
  page: number,
  options: NssSearchOptions = {},
): Promise<NssSearchResult> {
  return searchCache.through(memoKey("nss-search", [input, page]), () =>
    page > 1 ? runLaterPage(input, page, options.since ?? Date.now()) : runFirstPage(input),
  );
}

/** Everything that can be refused without asking NSS. */
function validateNssSearch(input: NssSearchInput): void {
  validateNssApplies(input);
  validateNssDates(input);
  const hasCriterion =
    (input.query && nssFullText(input.query)) ||
    input.caseNumber ||
    input.dateFrom ||
    input.dateTo ||
    input.publishedFrom ||
    input.publishedTo ||
    input.court ||
    input.registry ||
    input.area ||
    input.appliesAct ||
    input.appliesTreaty ||
    input.appliesEuRegulation ||
    input.appliesEuDirective;
  if (!hasCriterion) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NSS search needs at least one criterion.",
      "Provide query (full-text), case_number, a date range, court, registry, area, or an applies_* filter.",
    );
  }
}

async function runFirstPage(input: NssSearchInput): Promise<NssSearchResult> {
  validateNssSearch(input);

  let session = await handshake();
  let answer = await postSearch(session, input);
  let results = answer.ok ? parseNssResults(answer.html) : null;
  if (results?.blankForm || STALE_SESSION_STATUSES.has(answer.status)) {
    // Expired session → one forced re-handshake (shared with every search
    // that hit the same expiry).
    session = await handshake(session);
    answer = await postSearch(session, input);
    results = answer.ok ? parseNssResults(answer.html) : null;
    if (results?.blankForm) {
      throw new SourceError(
        SOURCE,
        "SESSION_EXPIRED",
        "NSS keeps answering with a blank search form.",
        "The portal may be rejecting automated searches right now — try again in a few minutes.",
      );
    }
  }
  if (!results) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `NSS answered the search with HTTP ${answer.status}.`,
      "The portal refused the request — try again in a few minutes; if it persists, run dawmain_probe_sources (canary 'nss').",
    );
  }
  // A genuine zero says "Počet nalezených záznamů: 0". A page with neither a
  // count nor rows is something else — an error page, a redirect target, a
  // redesign — and must not read (or be cached) as "no case law".
  if (results.total === null && !results.hits.length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NSS answered without a result count.",
      "The results page changed or an error page came back — run dawmain_probe_sources (canary 'nss') with include_raw.",
    );
  }
  if (results.total && !results.hits.length) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NSS reports ${results.total} decisions, but no result row could be read.`,
      "The result rows changed — run dawmain_probe_sources (canary 'nss') with include_raw.",
    );
  }
  return { ...results, page: 1 };
}

/**
 * Later pages come from the AJAX row endpoint, rebuilt from page 1's
 * pagination context. Page 1 is taken through the cache: paging on (or
 * several pages of one variant) costs one row fragment each instead of the
 * slow full-text POST again — MyResTRowsCont re-runs the search from the
 * posted conditions anyway.
 */
async function runLaterPage(input: NssSearchInput, page: number, since: number): Promise<NssSearchResult> {
  const first = await searchNss(input, 1);
  const offset = FIRST_PAGE_ROWS + (page - 2) * LATER_PAGE_ROWS;
  if (first.total !== null && offset >= first.total) {
    // Past the last hit — nothing to ask NSS for.
    return { total: first.total, hits: [], pagination: null, blankForm: false, page };
  }
  if (!first.pagination) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NSS result page carries no pagination context (currParams).",
      "Only the first page is available — narrow the query instead of paging.",
    );
  }
  const session = await handshake();
  const body = new URLSearchParams({
    vyhledavaciPodminky: first.pagination.currParams,
    zobrazeniVysledkuId: first.pagination.currViewId,
    pageNum: String(page - 1),
    resultOrder: first.pagination.currSort,
  });
  const response = await fetchUpstream(SOURCE, `${BASE}/Home/MyResTRowsCont`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      cookie: session.cookies.header(),
      referer: `${BASE}/Home/Index`,
    },
    body: body.toString(),
    timeoutMs: Math.min(
      FRAGMENT_MAX_TIMEOUT_MS,
      Math.max(FRAGMENT_MIN_TIMEOUT_MS, PAGING_BUDGET_MS - (Date.now() - since)),
    ),
  });
  session.cookies.absorb(response);
  if (!response.ok) {
    await discard(response);
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `NSS answered page ${page} with HTTP ${response.status}.`,
      "Try again in a minute, or narrow the query instead of paging.",
    );
  }
  const fragment = parseNssResults(await response.text());
  if (!fragment.hits.length && first.total !== null) {
    // The offset is below the total here: the rows exist, NSS did not send
    // them. An empty page would read as the end of the results.
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `NSS sent no rows for page ${page} although it reports ${first.total} decisions.`,
      "Narrow the query (court, registry, dates) instead of paging; if page 2 of a small search fails too, run dawmain_probe_sources (canary 'nss').",
    );
  }
  return { ...fragment, total: fragment.total ?? first.total, page };
}

function assertNssId(id: string): void {
  if (!/^\d{1,10}$/.test(id)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${id}" is not an NSS document id.`,
      "Pass the numeric id returned by nss_search.",
    );
  }
}

const detailUrl = (id: string) => `${BASE}/DokumentDetail/Index/${id}`;

/**
 * Metadata and text are cached apart. A detail page that failed is not
 * cached — the next call asks for it alone while the text stays cached; one
 * failed request used to strip ECLI and spisová značka from every answer for
 * that id for 10 minutes. The detail keeps the GET default timeout and retry:
 * the citation fields are worth the wait.
 */
export async function getNssDecision(id: string): Promise<NssDecision> {
  assertNssId(id);
  const [metadata, text] = await Promise.all([
    nssMetadata(id).catch(() => null),
    nssText(id),
  ]);
  return {
    id,
    metadata: metadata ?? {},
    ...(metadata ? {} : { metadataUnavailable: true }),
    text,
    url: detailUrl(id),
  };
}

/**
 * The decision text alone — for read_top previews, which must never wait on
 * the detail page. The detail is still requested (not awaited), so the
 * nss_get_decision a preview usually leads to finds its metadata cached.
 */
export async function getNssDecisionText(id: string): Promise<string> {
  assertNssId(id);
  void nssMetadata(id).catch(() => {});
  return nssText(id);
}

function nssMetadata(id: string): Promise<Record<string, string>> {
  return metadataCache.through(memoKey("nss-meta", [id]), () => loadNssMetadata(id));
}

function nssText(id: string): Promise<string> {
  return textCache.through(memoKey("nss-text", [id]), () => loadNssText(id));
}

async function loadNssMetadata(id: string): Promise<Record<string, string>> {
  const response = await fetchUpstream(SOURCE, detailUrl(id));
  // 404 is definitive — the document has no detail page — and is cached so.
  if (response.status === 404) {
    await discard(response);
    return {};
  }
  if (!response.ok) {
    await discard(response);
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `NSS detail page answered HTTP ${response.status}.`,
      "Call nss_get_decision again for the metadata.",
    );
  }
  return parseNssDetail(await response.text());
}

function missingDocument(id: string): SourceError {
  return new SourceError(
    SOURCE,
    "NOT_FOUND",
    `NSS has no document text for id ${id}.`,
    "The id may be stale — re-run nss_search and use a fresh id.",
  );
}

/**
 * The HTML rendition's charset varies: real decisions come as "text/html;
 * charset=UTF-8", the missing-document page as UTF-16 with no charset at all
 * (live 2026-09). Read as UTF-8, that page came back as its own markup — the
 * NULs defeated the N/A test and the tags survived as text. Without a charset
 * or BOM the bytes decide: UTF-8 markup never holds NUL bytes, UTF-16LE
 * markup has one after nearly every character.
 */
async function decodeRendition(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512));
  let nuls = 0;
  for (let i = 1; i < head.length; i += 2) if (head[i] === 0) nuls++;
  const fallback = nuls > head.length / 8 ? "utf-16le" : "utf-8";
  const text = await decodeBody(new Response(buffer, { headers: response.headers }), fallback);
  return text.replace(/\u0000/g, "");
}

async function loadNssText(id: string): Promise<string> {
  const textResponse = await fetchUpstream(SOURCE, `${BASE}/DokumentOriginal/Text/${id}`);
  let text = "";
  if (textResponse.ok) {
    // The plain-text endpoint is UTF-16 (BOM-detected in decodeBody); Aspose
    // leaves control characters where dashes belong (\u001e in case numbers).
    text = (await decodeBody(textResponse, "utf-16le"))
      .replace(/\u001e/g, "-")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
      .trim();
  } else {
    // An error page is not the decision — never hand it out as the text.
    await discard(textResponse);
  }
  if (text && !isNssMissingBody(text)) {
    // Residual tags in the text rendition — strip them.
    return looksLikeHtml(text) ? htmlToText(text) : text;
  }

  // No usable text rendition: fall back to the HTML rendition before
  // declaring the document missing.
  const htmlResponse = await fetchUpstream(SOURCE, `${BASE}/DokumentOriginal/Html/${id}`);
  if (!htmlResponse.ok) {
    await discard(htmlResponse);
    if (htmlResponse.status === 404 || htmlResponse.status === 410) throw missingDocument(id);
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `NSS answered HTTP ${htmlResponse.status} for the text of document ${id}.`,
      "Try again in a minute; if it persists, run dawmain_probe_sources (canary 'nss').",
    );
  }
  const html = await decodeRendition(htmlResponse);
  const converted = isNssMissingBody(html) ? "" : htmlToText(html);
  // htmlToText keeps the <title> ("N/A - text"): a page that says nothing
  // else is the missing-document page in another shape.
  if (!converted || /^\s*(?:N\/A(?:\s*-\s*text)?\s*)+$/i.test(converted)) throw missingDocument(id);
  return converted;
}
