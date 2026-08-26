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
  popularName?: string;
  dateFrom?: string; // ISO
  dateTo?: string; // ISO
  types?: Array<"nález" | "usnesení" | "stanovisko">;
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
    // Search the operative scopes; odlišné stanovisko stays out by default.
    for (const scope of ["pravni_veta", "abstrakt", "naveti", "vyrok", "oduvodneni"]) {
      form.set(`${MC}${scope}`, "on");
    }
  }
  if (input.citace) form.set(`${MC}citace`, input.citace);
  if (input.ecli) form.set(`${MC}ecli`, input.ecli);
  if (input.judge) form.set(`${MC}soudce_zpravodaj`, input.judge);
  if (input.popularName) form.set(`${MC}popularni_nazev`, input.popularName);
  if (input.dateFrom) form.set(`${MC}decidedFrom`, isoToCzech(input.dateFrom));
  if (input.dateTo) form.set(`${MC}decidedTo`, isoToCzech(input.dateTo));

  form.set(`${MC}razeni`, "2"); // decision date, newest first
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
  if (
    !input.query &&
    !input.citace &&
    !input.ecli &&
    !input.judge &&
    !input.popularName &&
    !input.dateFrom &&
    !input.dateTo
  ) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "NALUS search needs at least one criterion.",
      "Provide query (full-text), case_number (citace), ecli, judge, popular_name, or a date range.",
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
