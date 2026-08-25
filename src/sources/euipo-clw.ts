import { SourceError } from "./shared/errors";
import { CookieSession, fetchUpstream } from "./shared/http";

/** Politeness pause between listing pages of the client-side filter scan. */
const FILTER_PAGE_DELAY_MS = 300;
/** The download cookie handshake is reusable — cache it per warm instance. */
const PDF_SESSION_TTL_MS = 10 * 60 * 1000;
let pdfSession: { cookies: CookieSession; fetchedAt: number } | null = null;

/**
 * EUIPO eSearch Case Law — Boards of Appeal, opposition, cancellation and
 * examination decisions (plus a design line), via the SPA's undocumented
 * JSON backend. The official EUIPO developer API covers ONLY register data
 * (trademarks/designs) — there is no sanctioned case-law API.
 *
 * The shape of a non-empty `criteria` array is not publicly established, so
 * v1 does server-side sort + pagination and applies filters CLIENT-SIDE over
 * a bounded fetch. PDF downloads need session cookies from GET /eSearchCLW/
 * replayed in the same invocation. See docs/research/eu-ip-sources.json.
 */

const SOURCE = "EUIPO eSearchCLW";
const BASE = "https://euipo.europa.eu";
/** Client-side filtering fetches at most this many 50-row pages. */
const MAX_FILTER_PAGES = 4;

export interface EuipoClwItem {
  uniqueSolrKey?: string;
  caseNumber?: string;
  type?: string;
  ipRight?: string;
  entityName?: string;
  entityNumber?: string;
  date?: string; // ISO
  outcome?: string;
  norms?: string[];
  appealed?: string;
  pdfUrl?: string;
  language?: string;
  viewUrl?: string;
}

/** DD/MM/YYYY → ISO (EUIPO response format). */
export function euipoDateToIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/** Parse an officesearch/rcdsearch response. Pure — unit-tested. */
export function parseEuipoClw(json: unknown): { numFound: number; items: EuipoClwItem[] } {
  const data = json as {
    numFound?: number;
    results?: Array<Record<string, unknown>>;
    errorLabel?: string;
  };
  if (data.errorLabel) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `EUIPO answered with an error: ${data.errorLabel}`,
      "Simplify the request and retry.",
    );
  }
  if (typeof data.numFound !== "number" || !Array.isArray(data.results)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "EUIPO case-law response is missing numFound/results.",
      "The undocumented backend may have changed — run dawmain_probe_sources (canary 'euipo-clw') with include_raw.",
    );
  }
  return {
    numFound: data.numFound,
    items: data.results.map((result) => {
      const str = (key: string) => (typeof result[key] === "string" ? (result[key] as string) : undefined);
      const languages = Array.isArray(result.languagesOriginal)
        ? (result.languagesOriginal as Array<{ code?: string; pdfUrl?: string }>)
        : [];
      const preferred = languages.find((l) => l.code === "en") ?? languages[0];
      const key = str("uniqueSolrKey");
      return {
        uniqueSolrKey: key,
        caseNumber: str("caseNumber"),
        type: str("typeLabel") ?? str("type"),
        ipRight: str("ipRight"),
        entityName: str("entityName"),
        entityNumber: str("entityNumber"),
        date: euipoDateToIso(str("date")),
        outcome: str("outcome"),
        norms: Array.isArray(result.norms) ? (result.norms as unknown[]).map(String) : undefined,
        appealed: str("appealed"),
        pdfUrl: preferred?.pdfUrl,
        language: preferred?.code,
        viewUrl: key ? `${BASE}/eSearchCLW/#key/trademark/${key}` : undefined,
      };
    }),
  };
}

export interface EuipoClwFilter {
  caseNumber?: string;
  ipRight?: string;
  type?: string;
  entityName?: string;
  norm?: string;
}

/** Client-side filters (the criteria wire shape is unknown). Pure. */
export function filterEuipoClw(items: EuipoClwItem[], filter: EuipoClwFilter): EuipoClwItem[] {
  const ci = (value: string | undefined) => (value ?? "").toLowerCase();
  return items.filter((item) => {
    if (filter.caseNumber && !ci(item.caseNumber).includes(ci(filter.caseNumber))) return false;
    if (filter.ipRight && !ci(item.ipRight).includes(ci(filter.ipRight))) return false;
    if (filter.type && !ci(item.type).includes(ci(filter.type))) return false;
    if (filter.entityName && !ci(item.entityName).includes(ci(filter.entityName))) return false;
    if (filter.norm && !(item.norms ?? []).some((norm) => ci(norm).includes(ci(filter.norm)))) return false;
    return true;
  });
}

async function fetchPage(
  register: "trademark" | "design",
  start: number,
  rows: number,
): Promise<{ numFound: number; items: EuipoClwItem[] }> {
  const endpoint = register === "design" ? "rcdsearch" : "officesearch";
  const response = await fetchUpstream(SOURCE, `${BASE}/caselaw/${endpoint}/json/en`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      resultsPerPage: rows,
      start,
      criteria: [],
      sort: { field: "DecisionDate", order: "desc" },
    }),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `EUIPO answered HTTP ${response.status}.`,
      "A WAF may be blocking datacenter IPs — run dawmain_probe_sources (canary 'euipo-clw') to check.",
    );
  }
  return parseEuipoClw(await response.json());
}

export interface EuipoClwSearchResult {
  numFound: number;
  items: EuipoClwItem[];
  scanned: number;
  /** True when the page budget ran out while filtering. */
  truncated: boolean;
}

export async function searchEuipoClw(
  register: "trademark" | "design",
  filter: EuipoClwFilter,
  offset: number,
  limit: number,
): Promise<EuipoClwSearchResult> {
  const hasFilter = Boolean(
    filter.caseNumber || filter.ipRight || filter.type || filter.entityName || filter.norm,
  );

  if (!hasFilter) {
    // Plain newest-first listing — server-side pagination maps directly.
    const page = await fetchPage(register, offset, limit);
    return { numFound: page.numFound, items: page.items, scanned: page.items.length, truncated: false };
  }

  // Filters are client-side: scan up to MAX_FILTER_PAGES × 50 newest rows.
  const matched: EuipoClwItem[] = [];
  let numFound = 0;
  let scanned = 0;
  let truncated = false;
  for (let page = 0; page < MAX_FILTER_PAGES; page++) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, FILTER_PAGE_DELAY_MS));
    const result = await fetchPage(register, page * 50, 50);
    numFound = result.numFound;
    scanned += result.items.length;
    matched.push(...filterEuipoClw(result.items, filter));
    if (matched.length >= offset + limit) break;
    if (scanned >= numFound) break;
    if (page === MAX_FILTER_PAGES - 1) truncated = true;
  }
  return { numFound, items: matched.slice(offset, offset + limit), scanned, truncated };
}

// ---------- document text ----------

export interface EuipoClwDocument {
  text: string;
  pdfUrl: string;
  pages: number;
}

export async function getEuipoClwDocument(pdfUrl: string): Promise<EuipoClwDocument> {
  if (!/^https:\/\/euipo\.europa\.eu\//.test(pdfUrl)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "The pdf_url must be a euipo.europa.eu URL.",
      "Pass the pdfUrl field from a euipo_clw_search hit.",
    );
  }
  if (/\.docx?(\?|$)/i.test(pdfUrl)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "This document is a Word file, not a PDF — text extraction is not supported here.",
      `Download it directly: ${pdfUrl}`,
    );
  }

  // The download endpoint wants the SPA's session cookies — reuse a cached
  // handshake on warm instances (saves one request per document).
  if (!pdfSession || Date.now() - pdfSession.fetchedAt > PDF_SESSION_TTL_MS) {
    const cookies = new CookieSession();
    const warmup = await fetchUpstream(SOURCE, `${BASE}/eSearchCLW/`, { timeoutMs: 15_000 });
    cookies.absorb(warmup);
    pdfSession = { cookies, fetchedAt: Date.now() };
  }

  let response = await fetchUpstream(SOURCE, pdfUrl, {
    headers: { cookie: pdfSession.cookies.header(), referer: `${BASE}/eSearchCLW/` },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    // Stale cached session → one fresh handshake before giving up.
    const cookies = new CookieSession();
    const warmup = await fetchUpstream(SOURCE, `${BASE}/eSearchCLW/`, { timeoutMs: 15_000 });
    cookies.absorb(warmup);
    pdfSession = { cookies, fetchedAt: Date.now() };
    response = await fetchUpstream(SOURCE, pdfUrl, {
      headers: { cookie: pdfSession.cookies.header(), referer: `${BASE}/eSearchCLW/` },
      timeoutMs: 30_000,
    });
  }
  if (!response.ok) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `EUIPO answered HTTP ${response.status} for the PDF.`,
      "The document may have moved — re-run euipo_clw_search for a fresh pdfUrl.",
    );
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length < 4 || String.fromCharCode(...buffer.slice(0, 4)) !== "%PDF") {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      "EUIPO returned something that is not a PDF (probably a login or WAF page).",
      "Run dawmain_probe_sources (canary 'euipo-clw'); if the WAF blocks the deployment's IPs, open the viewUrl in a browser instead.",
    );
  }

  const { extractText } = await import("unpdf");
  const { totalPages, text } = await extractText(buffer, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join("\n") : text).trim();
  if (!merged) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      "The PDF contains no extractable text (probably a scan).",
      `Open it directly: ${pdfUrl}`,
    );
  }
  return { text: merged, pdfUrl, pages: totalPages };
}
