import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import { CELLAR_BASE, fetchCellarText } from "./cellar";

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
  sort?: "relevance" | "date";
  language?: string;
}

export interface CuriaHit {
  logicDocId?: string;
  docType?: string;
  date?: string;
  parties?: string;
  ecli?: string;
  caseNumber?: string;
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
  return {
    searchTerm: input.query ?? (input.caseNumber ? `"${input.caseNumber}"` : ""),
    multiSearchTerms: [],
    sortTermList: [
      {
        sortDirection: "DESC",
        sortTerm: input.sort === "date" ? "INTRODUCTION_DATE" : "SCORE",
      },
    ],
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
    isSearchExact: true,
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
    for (const inner of outer.innerHits?.document?.searchHits ?? []) {
      const doc = (inner.document ?? inner.content ?? {}) as Record<string, unknown>;
      const str = (key: string) => (typeof doc[key] === "string" ? (doc[key] as string) : undefined);
      const ecli = str("ecli") ?? str("docEcli");
      const caseNumber = str("docNoPart") ?? str("idPublished");
      hits.push({
        logicDocId: str("logicDocId"),
        docType: str("docTypeCode"),
        date: str("docDate"),
        parties: str("parties"),
        ecli,
        caseNumber,
        url: caseNumber
          ? `https://curia.europa.eu/juris/liste.jsf?num=${encodeURIComponent(caseNumber)}&language=cs`
          : ecli
            ? `https://publications.europa.eu/resource/ecli/${encodeURIComponent(ecli)}`
            : null,
      });
    }
  }
  return { total: data.totalHits, hits };
}

export async function searchCuria(
  input: CuriaSearchInput,
  page: number,
  pageSize: number,
): Promise<CuriaSearchPage> {
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
  return parseCuriaSearch(await response.json());
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
