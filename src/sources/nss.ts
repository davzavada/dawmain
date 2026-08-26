import { SourceError } from "./shared/errors";
import { CookieSession, fetchUpstream } from "./shared/http";
import { decodeBody, decodeJsStringLiteral, htmlToText, loadHtml, looksLikeHtml } from "./shared/html";
import { czechToIso, isoToCzech } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * Nejvyšší správní soud — vyhledavac.nssoud.cz (server-rendered ASP.NET Core
 * MVC; no JSON API).
 *
 * Search needs an antiforgery handshake: GET / (cookies + token + ALL form
 * fields — the model binder rejects partial posts), then POST /Home/Index
 * echoing everything plus the criteria. Field indices for the criteria are
 * NOT hardcoded: the live form is harvested and criteria are located by
 * name suffix (dates) or nearby label (full-text, spisová značka), because
 * the exact `vyhledavaciSekce[…]` indices were never verified publicly and
 * the form has shifted before. Document endpoints are sessionless; the
 * plain-text variant is UTF-16. See docs/research/cz-sources.json.
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
 * Fallbacks: first field with the suffix, then a label match. Pure.
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
  if (suffix) {
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

/** Parse the search response or a MyResTRowsCont fragment. Pure — unit-tested. */
export function parseNssResults(html: string): NssResultsPage {
  const countMatch = COUNT_RE.exec(html);
  const $ = loadHtml(html);

  const hits: NssHit[] = [];
  $("input[name^='ZobrazeneVysledky']").each((_, el) => {
    const $input = $(el);
    if (!/\.ID$/.test($input.attr("name") ?? "")) return;
    const id = $input.attr("value");
    if (!id) return;
    const container = $input.closest("tbody").length ? $input.closest("tbody") : $input.closest("tr");
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
    pagination = {
      currParams: decodeJsStringLiteral(currParams[1]),
      currViewId: currViewId[1],
      currSort: decodeJsStringLiteral(currSort[1]),
    };
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

/** The Text/Html endpoints signal a missing document with a tiny 'N/A' body. */
export function isNssMissingBody(body: string): boolean {
  return body.length < 200 && /(^|>)\s*N\/A\s*(<|$)/.test(body);
}

// ---------- I/O ----------

interface NssSession {
  cookies: CookieSession;
  fields: NssFormField[];
  fetchedAt: number;
}

let cachedSession: NssSession | null = null;

async function handshake(force = false): Promise<NssSession> {
  if (!force && cachedSession && Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS) {
    return cachedSession;
  }
  const cookies = new CookieSession();
  const response = await fetchUpstream(SOURCE, `${BASE}/`);
  cookies.absorb(response);
  const { fields } = parseNssForm(await response.text());
  cachedSession = { cookies, fields, fetchedAt: Date.now() };
  return cachedSession;
}

export interface NssSearchInput {
  query?: string;
  caseNumber?: string;
  dateFrom?: string; // ISO
  dateTo?: string; // ISO
}

async function postSearch(session: NssSession, input: NssSearchInput): Promise<string> {
  const form = new URLSearchParams();
  for (const field of session.fields) form.set(field.name, field.value);

  const formModel: NssForm = { fields: session.fields };
  const setCriterion = (
    criterion: string,
    value: string,
    suffix: string | null,
    labelPattern: RegExp | null,
    technicalPattern?: RegExp,
  ) => {
    const field = findField(formModel, suffix, labelPattern, technicalPattern);
    if (!field) {
      throw new SourceError(
        SOURCE,
        "PARSE_DRIFT",
        `Could not locate the NSS form field for ${criterion}.`,
        "The search form changed. Run dawmain_probe_sources with discover:true and update the field mapping in src/sources/nss.ts; date-range search may still work.",
      );
    }
    form.set(field.name, value);
  };

  if (input.dateFrom) {
    setCriterion("date from", isoToCzech(input.dateFrom), ".HodnotaDatumACasOd", null, /datumvydani/i);
  }
  if (input.dateTo) {
    setCriterion("date to", isoToCzech(input.dateTo), ".HodnotaDatumACasDo", null, /datumvydani/i);
  }
  if (input.query) {
    setCriterion(
      "full text",
      input.query,
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
  return response.text();
}

export interface NssSearchResult extends NssResultsPage {
  /** Tool-level page semantics: page 1 = inline 40 rows, later pages = 20. */
  page: number;
}

const searchCache = new TtlCache<NssSearchResult>(SEARCH_TTL_MS);
const decisionCache = new TtlCache<NssDecision>(DOCUMENT_TTL_MS, 24);

export async function searchNss(input: NssSearchInput, page: number): Promise<NssSearchResult> {
  return searchCache.through(memoKey("nss-search", [input, page]), () => runSearchNss(input, page));
}

async function runSearchNss(input: NssSearchInput, page: number): Promise<NssSearchResult> {
  if (!input.query && !input.caseNumber && !input.dateFrom && !input.dateTo) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NSS search needs at least one criterion.",
      "Provide query (full-text), case_number, or a date range.",
    );
  }

  let session = await handshake();
  let html = await postSearch(session, input);
  let results = parseNssResults(html);
  if (results.blankForm) {
    // Expired session → one forced re-handshake.
    session = await handshake(true);
    html = await postSearch(session, input);
    results = parseNssResults(html);
    if (results.blankForm) {
      throw new SourceError(
        SOURCE,
        "SESSION_EXPIRED",
        "NSS keeps answering with a blank search form.",
        "The portal may be rejecting automated searches right now — try again in a few minutes.",
      );
    }
  }

  if (page <= 1) return { ...results, page: 1 };

  // Later pages come from the AJAX row endpoint, reconstructed from the
  // pagination context (no server session needed for this endpoint).
  if (!results.pagination) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "NSS result page carries no pagination context (currParams).",
      "Only the first page is available — narrow the query instead of paging.",
    );
  }
  const body = new URLSearchParams({
    vyhledavaciPodminky: results.pagination.currParams,
    zobrazeniVysledkuId: results.pagination.currViewId,
    pageNum: String(page - 1),
    resultOrder: results.pagination.currSort,
  });
  const fragmentResponse = await fetchUpstream(SOURCE, `${BASE}/Home/MyResTRowsCont`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      cookie: session.cookies.header(),
      referer: `${BASE}/Home/Index`,
    },
    body: body.toString(),
  });
  const fragment = parseNssResults(await fragmentResponse.text());
  return { ...fragment, total: fragment.total ?? results.total, page };
}

export async function getNssDecision(id: string): Promise<NssDecision> {
  if (!/^\d{1,10}$/.test(id)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${id}" is not an NSS document id.`,
      "Pass the numeric id returned by nss_search.",
    );
  }
  return decisionCache.through(memoKey("nss-doc", [id]), () => runGetNssDecision(id));
}

async function runGetNssDecision(id: string): Promise<NssDecision> {
  const [detailResponse, textResponse] = await Promise.all([
    fetchUpstream(SOURCE, `${BASE}/DokumentDetail/Index/${id}`).catch(() => null),
    fetchUpstream(SOURCE, `${BASE}/DokumentOriginal/Text/${id}`),
  ]);

  // The plain-text endpoint is UTF-16 (BOM-detected in decodeBody); Aspose
  // leaves control characters where dashes belong (\u001e in case numbers).
  let text = (await decodeBody(textResponse, "utf-16le"))
    .replace(/\u001e/g, "-")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .trim();
  if (isNssMissingBody(text)) {
    // Fall back to the HTML rendition before declaring the document missing.
    const htmlResponse = await fetchUpstream(SOURCE, `${BASE}/DokumentOriginal/Html/${id}`);
    const html = await htmlResponse.text();
    if (isNssMissingBody(html)) {
      throw new SourceError(
        SOURCE,
        "NOT_FOUND",
        `NSS has no document text for id ${id}.`,
        "The id may be stale — re-run nss_search and use a fresh id.",
      );
    }
    text = htmlToText(html);
  } else if (looksLikeHtml(text)) {
    // Residual tags in the text rendition — strip them.
    text = htmlToText(text);
  }

  const metadata = detailResponse?.ok ? parseNssDetail(await detailResponse.text()) : {};
  return { id, metadata, text, url: `${BASE}/DokumentDetail/Index/${id}` };
}
