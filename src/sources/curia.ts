import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { CELLAR_BASE, fetchCellarText } from "./cellar";
import { SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * CJEU case law.
 *
 * Search: the new InfoCuria's JSON backend (infocuriaws elastic-connector) —
 * undocumented but the freshest index (same-day judgments); it already
 * replaced its predecessor once, so shape mismatches surface as PARSE_DRIFT
 * rather than being papered over. Text: Cellar (Publications Office) by
 * CELEX/ECLI — stable, official, WAF-free — with the InfoCuria blob endpoint
 * as fallback for documents too new for Cellar.
 * See docs/research/eu-ip-sources.json.
 */

const SOURCE = "CJEU (InfoCuria)";
const WS_BASE = "https://infocuriaws.curia.europa.eu";
const SPA_ORIGIN = "https://infocuria.curia.europa.eu";

const SPA_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  accept: "application/json",
  origin: SPA_ORIGIN,
  referer: `${SPA_ORIGIN}/`,
};

// ---------- identifiers ----------

/** "C-311/18" + document type → CELEX (62018CJ0311). Pure — unit-tested. */
export function caseNumberToCelex(caseNumber: string, docType: "judgment" | "order" | "opinion"): string | null {
  const m = /^([CTF])-(\d{1,4})\/(\d{2})$/i.exec(caseNumber.trim());
  if (!m) return null;
  const court = m[1].toUpperCase();
  if (court === "F") return null; // Civil Service Tribunal — out of CELEX scope here
  const number = m[2].padStart(4, "0");
  const yy = Number(m[3]);
  // Two-digit years: the Court's docket starts 1953 — 54+ → 19xx, else 20xx.
  const year = yy >= 54 ? 1900 + yy : 2000 + yy;
  const typeLetters =
    court === "C"
      ? { judgment: "CJ", order: "CO", opinion: "CC" }[docType]
      : { judgment: "TJ", order: "TO", opinion: "TO" }[docType];
  return `6${year}${typeLetters}${number}`;
}

// ---------- search ----------

export interface CuriaSearchInput {
  query?: string;
  caseNumber?: string;
  ecli?: string;
  parties?: string; // usual name of the case ("Schrems", "Google Spain")
  court?: "C" | "T";
  /** Case status of the main proceedings (InfoCuria "Case status"). */
  state?: "all" | "closed" | "pending";
  /** Client-side filter over docTypeCode of the returned documents. */
  docType?: "judgment" | "opinion" | "order" | "request" | "any";
  dateFrom?: string; // ISO, client-side on docDate
  dateTo?: string; // ISO
  sort?: "relevance" | "date";
  language?: string;
}

/** docTypeCode prefixes per docType (codes observed live: ARRET, ARRET_SOM,
 * ARRET_EXT, CONCL, DDP, DDP_COMM, DDP_ADD, RES, ARR_COMM, ORD…). */
const DOC_TYPE_PREFIXES: Record<string, string[]> = {
  judgment: ["ARRET"],
  opinion: ["CONCL"],
  order: ["ORD", "RES"],
  request: ["DDP"],
};

export interface CuriaHit {
  logicDocId?: string;
  docType?: string;
  date?: string;
  parties?: string;
  ecli?: string;
  caseNumber?: string;
  /** Usual name of the case from the affair level (e.g. "Telia Finland"). */
  caseName?: string;
  /** Affair state code (CLOTPUB… = closed, ENC… = pending). */
  stateCode?: string;
  /** Human-verifiable link: InfoCuria case listing, else Cellar by ECLI. */
  url: string | null;
}

export interface CuriaSearchPage {
  total: number;
  hits: CuriaHit[];
}

/** Build the verbatim elastic-connector body. Pure — unit-tested. */
export function buildCuriaBody(input: CuriaSearchInput, page: number, pageSize: number): Record<string, unknown> {
  const filtersValue: Array<Record<string, unknown>> = [];
  if (input.court) {
    filtersValue.push({
      field: "jurisdiction",
      values: [input.court],
      valuesWithFullHierarchy: [input.court],
    });
  }
  if (input.state === "closed") {
    filtersValue.push({
      field: "affairState",
      values: ["CLOTPUB"],
      valuesWithFullHierarchy: ["CLOTPUB"],
    });
  } else if (input.state === "pending") {
    // Pending codes start with ENC (en cours) — the client-side
    // affairStateCode guard in the caller backs this filter up.
    filtersValue.push({
      field: "affairState",
      values: ["ENC"],
      valuesWithFullHierarchy: ["ENC"],
    });
  }
  // The backend ignores usualName without a searchTerm — party names go
  // through full text too (verified live: found C-201/22 for "Telia Finland").
  const searchTerm =
    input.query ?? (input.caseNumber ? `"${input.caseNumber}"` : (input.parties ?? ""));
  return {
    searchTerm,
    multiSearchTerms: [],
    sortTermList: [
      {
        sortDirection: "DESC",
        sortTerm: input.sort === "date" ? "INTRODUCTION_DATE" : "SCORE",
      },
    ],
    // Free-text keyword search behaves better non-exact (raglex production
    // client); identifiers stay exact.
    
    pagination: {
      pageNumber: page,
      pageSize,
      from: page * pageSize + 1,
      to: (page + 1) * pageSize,
    },
    language: (input.language ?? "EN").toUpperCase(),
    tabName: "affair",
    isAllTabsRequest: false,
    ecli: input.ecli ?? "",
    publishedId: input.caseNumber ?? "",
    usualName: input.parties ?? "",
    logicDocId: "",
    repJurExpand: true,
    filtersValue,
    advancedFiltersValue: [],
    isSearchExact: !input.query,
    searchSources: ["document", "metadata"],
  };
}

/** Extract hits from the nested innerHits shape. Pure — unit-tested. */
export function parseCuriaSearch(json: unknown): CuriaSearchPage {
  const data = json as {
    totalHits?: number;
    searchHits?: Array<{
      innerHits?: { document?: { searchHits?: Array<{ document?: Record<string, unknown>; content?: Record<string, unknown> }> } };
    }>;
  };
  if (typeof data.totalHits !== "number" || !Array.isArray(data.searchHits)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "InfoCuria search response is missing totalHits/searchHits.",
      "The undocumented backend may have changed shape — run dawmain_probe_sources (canary 'curia') with include_raw. The classic curia.europa.eu/juris GET interface is the fallback.",
    );
  }
  const hits: CuriaHit[] = [];
  for (const outer of data.searchHits) {
    // Affair-level content: case number, usual name, state code.
    const affair = ((outer as Record<string, unknown>).content ?? {}) as Record<string, unknown>;
    const affairStr = (key: string) =>
      typeof affair[key] === "string" ? (affair[key] as string) : undefined;
    const usualNameML = Array.isArray(affair.usualNameML)
      ? (affair.usualNameML as Array<Record<string, unknown>>)
      : [];
    const caseName = usualNameML
      .map((entry) => (typeof entry.en === "string" ? entry.en : undefined))
      .find(Boolean);
    const affairCaseNumber = affairStr("publishedId") ?? affairStr("publishedAffId");
    const stateCode = affairStr("affairStateCode");

    for (const inner of outer.innerHits?.document?.searchHits ?? []) {
      const doc = (inner.document ?? inner.content ?? {}) as Record<string, unknown>;
      const str = (key: string) => (typeof doc[key] === "string" ? (doc[key] as string) : undefined);
      const ecli = str("ecli") ?? str("docEcli");
      const caseNumber = str("docNoPart") ?? str("idPublished") ?? affairCaseNumber;
      hits.push({
        logicDocId: str("logicDocId"),
        docType: str("docTypeCode"),
        date: str("docDate"),
        parties: str("parties"),
        ecli,
        caseNumber,
        caseName,
        stateCode,
        // Prefer a link that opens the TEXT of the document itself.
        url: ecli
          ? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=ecli:${encodeURIComponent(ecli)}`
          : str("logicDocId")
            ? `${WS_BASE}/blob/download-file/${encodeURIComponent(str("logicDocId")!.replace(/^id_/, ""))}/EN/html`
            : caseNumber
              ? `https://curia.europa.eu/juris/liste.jsf?num=${encodeURIComponent(caseNumber)}&language=cs`
              : null,
      });
    }
  }
  return { total: data.totalHits, hits };
}

/** Client-side refinements over the returned documents. Pure — unit-tested. */
export function refineCuriaHits(hits: CuriaHit[], input: CuriaSearchInput): CuriaHit[] {
  return hits.filter((hit) => {
    if (input.docType && input.docType !== "any") {
      const prefixes = DOC_TYPE_PREFIXES[input.docType] ?? [];
      if (!prefixes.some((prefix) => (hit.docType ?? "").startsWith(prefix))) return false;
    }
    if (input.state === "closed" && hit.stateCode && !hit.stateCode.startsWith("CLOT")) return false;
    if (input.state === "pending" && hit.stateCode && !hit.stateCode.startsWith("ENC")) return false;
    if (input.dateFrom && hit.date && hit.date < input.dateFrom) return false;
    if (input.dateTo && hit.date && hit.date > input.dateTo) return false;
    return true;
  });
}

const searchCache = new TtlCache<CuriaSearchPage & { filtered: number }>(SEARCH_TTL_MS);

export async function searchCuria(
  input: CuriaSearchInput,
  page: number,
  pageSize: number,
): Promise<CuriaSearchPage & { filtered: number }> {
  return searchCache.through(memoKey("curia-search", [input, page, pageSize]), () =>
    runSearchCuria(input, page, pageSize),
  );
}

async function runSearchCuria(
  input: CuriaSearchInput,
  page: number,
  pageSize: number,
): Promise<CuriaSearchPage & { filtered: number }> {
  if (!input.query && !input.caseNumber && !input.ecli && !input.parties) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "CURIA search needs at least one criterion.",
      "Provide query (full-text keywords), case_number (e.g. 'C-311/18'), ecli, or parties.",
    );
  }
  const response = await fetchUpstream(SOURCE, `${WS_BASE}/elastic-connector/search`, {
    method: "POST",
    headers: SPA_HEADERS,
    body: JSON.stringify(buildCuriaBody(input, page, pageSize)),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `InfoCuria answered HTTP ${response.status}.`,
      "Try again in a minute; if it persists the backend may have changed — run dawmain_probe_sources.",
    );
  }
  const parsed = parseCuriaSearch(await response.json());
  const refined = refineCuriaHits(parsed.hits, input);
  return { total: parsed.total, hits: refined, filtered: parsed.hits.length - refined.length };
}

// ---------- document text ----------

export interface CuriaDocument {
  text: string;
  via: "cellar" | "infocuria-blob";
  url: string;
}

export async function getCuriaDocument(options: {
  celex?: string;
  ecli?: string;
  logicDocId?: string;
  language?: string;
}): Promise<CuriaDocument> {
  const language = options.language ?? "en";

  if (options.celex) {
    const text = await fetchCellarText(SOURCE, `/celex/${encodeURIComponent(options.celex)}`, language);
    if (text) return { text, via: "cellar", url: `${CELLAR_BASE}/celex/${options.celex}` };
  }
  if (options.ecli) {
    const text = await fetchCellarText(SOURCE, `/ecli/${encodeURIComponent(options.ecli)}`, language);
    if (text) return { text, via: "cellar", url: `${CELLAR_BASE}/ecli/${options.ecli}` };
  }
  if (options.logicDocId) {
    // Blob endpoint for documents too new for Cellar. Strip the "id_" prefix.
    const id = options.logicDocId.replace(/^id_/, "");
    const lang = (language === "cs" ? "CS" : language.toUpperCase()).slice(0, 2);
    const url = `${WS_BASE}/blob/download-file/${encodeURIComponent(id)}/${lang}/html`;
    const response = await fetchUpstream(SOURCE, url, { headers: SPA_HEADERS, timeoutMs: 25_000 });
    if (response.ok) {
      const text = htmlToText(await response.text());
      if (text.length > 200) return { text, via: "infocuria-blob", url };
    }
  }

  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    "No text could be retrieved for the given identifiers.",
    "Check the CELEX (e.g. 62018CJ0311) or ECLI (ECLI:EU:C:2020:559). For very recent decisions pass the logic_doc_id from curia_search. Some documents exist only in selected languages — try language 'en' or 'fr'.",
  );
}
