import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText } from "./shared/html";
import {
  CELLAR_BASE,
  budgetSpent,
  cellarDeadline,
  fetchCellarDocument,
  fetchWithinDeadline,
  hasBudget,
  normalizeCelex,
  normalizeEcli,
  requireCellarLanguage,
  resolveCellarLanguage,
} from "./cellar";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

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

/** "C-311/18" + document type → CELEX (62018CJ0311). Pure — unit-tested.
 * Appeals ("C-465/20 P") and urgent references ("C-216/18 PPU") — the form
 * InfoCuria itself prints — carry the plain docket number in their CELEX
 * (62020CJ0465 — verified live: the appeal judgment in C-465/20 P);
 * other suffixes (RENV, P(R), DEP, REC…) get a different or suffixed CELEX
 * and stay null rather than name the wrong document. */
export function caseNumberToCelex(caseNumber: string, docType: "judgment" | "order" | "opinion"): string | null {
  // Citations copied from judgments use the non-breaking hyphen (C‑311/18).
  const normalized = caseNumber.trim().replace(/[\u2010-\u2015\u2212]/g, "-");
  const m = /^([CTF])-(\d{1,4})\/(\d{2})(?:\s*(?:P|PPU))?$/i.exec(normalized);
  if (!m) return null;
  const court = m[1].toUpperCase();
  if (court === "F") return null; // Civil Service Tribunal — out of CELEX scope here
  const number = m[2].padStart(4, "0");
  const yy = Number(m[3]);
  // Two-digit years: the Court's docket starts 1953 — 54+ → 19xx, else 20xx.
  const year = yy >= 54 ? 1900 + yy : 2000 + yy;
  // General Court opinions are TC (61989TC0001 = AG Vesterdorf in T-1/89,
  // verified live) — TO is an order. Since the 2024 transfer of preliminary
  // references, T- cases have Advocates General again.
  const typeLetters =
    court === "C"
      ? { judgment: "CJ", order: "CO", opinion: "CC" }[docType]
      : { judgment: "TJ", order: "TO", opinion: "TC" }[docType];
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
  /** Document kind — server-side typeDoc filter + client-side docTypeCode guard. */
  docType?: "judgment" | "opinion" | "avis" | "order" | "request" | "any";
  /** Member states whose courts referred the preliminary question ("CZ", "SK"…). */
  referredFrom?: string[];
  /** CELEX of an act the decision must cite in its grounds (e.g. "32004L0048"). */
  citesCelex?: string;
  /** Narrows citesCelex to one article ("1", "17", "17(2)"). */
  citesArticle?: string;
  dateFrom?: string; // ISO, docDate (server-side + client-side guard)
  dateTo?: string; // ISO
  sort?: "relevance" | "date";
  language?: string;
}

/** Advanced-search "Document type" codes per kind. `typeDoc` = the form's own
 * values (ARRET=Judgment, INF=Judgment (Information), ARRET_EXT=Judgment
 * (extracts), AVIS=Opinions of the Court, CONCL=Opinion, ORD=Order, REF=Order
 * (Information), ORD_EXT=Order (extracts), DDP=Request for a preliminary
 * ruling; also DECISION, DELI, POSITION, OBSRP_PUB, JO, RES=Summary/Abstract).
 * `prefixes` = docTypeCode prefixes of the returned documents, which are finer
 * (ARRET_SOM, DDP_COMM…) — the client-side guard behind the server filter. */
export const CURIA_DOC_TYPES: Record<string, { typeDoc: string[]; prefixes: string[] }> = {
  judgment: { typeDoc: ["ARRET", "INF", "ARRET_EXT"], prefixes: ["ARRET", "INF"] },
  opinion: { typeDoc: ["CONCL"], prefixes: ["CONCL"] },
  avis: { typeDoc: ["AVIS"], prefixes: ["AVIS"] },
  order: { typeDoc: ["ORD", "REF", "ORD_EXT"], prefixes: ["ORD", "REF"] },
  request: { typeDoc: ["DDP"], prefixes: ["DDP"] },
};

/** "32004L0048" + "1" → "32004L0048*A01*" — one value of the citationsMotif
 * filter, exactly as the SPA unpacks its citationsMotif_a URL parameter
 * (decode, split on commas). Pure — unit-tested. */
export function buildCitationsMotif(celex: string, article?: string): string {
  const act = celex.trim().toUpperCase();
  const raw = article?.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return `${act}*`;
  // "1" → A01; "17(2)" → A17P2; an already-encoded "A17P2" passes through.
  const m = /^(\d+)(?:\((\d+)\))?$/.exec(raw);
  const code = m ? `A${m[1].padStart(2, "0")}${m[2] ? `P${m[2]}` : ""}` : raw.startsWith("A") ? raw : `A${raw}`;
  return `${act}*${code}*`;
}

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

/**
 * One matching case (InfoCuria "affair") with its matching documents. The
 * backend pages by CASE — pageSize = cases, totalHits = cases — and every
 * case carries its documents in innerHits (judgment, AG opinion, OJ notices,
 * summary…), so the case is the unit of a page. A case that matched with no
 * scored document (keyword-less searches) holds one bare listing hit with no
 * docType.
 */
export interface CuriaAffair {
  /** Stable across variants and pages: case number, else affair id, else name. */
  key: string;
  caseNumber?: string;
  caseName?: string;
  stateCode?: string;
  docs: CuriaHit[];
}

export interface CuriaSearchPage {
  /** Matching CASES upstream. */
  total: number;
  affairs: CuriaAffair[];
  /** Every document of every affair, in order — the flat view. */
  hits: CuriaHit[];
}

/** InfoCuria writes missing ids as "", "null" or "id_null" — all mean none. */
export function realLogicDocId(id: string | undefined): string | undefined {
  const bare = id?.trim().replace(/^id_/, "");
  return bare && bare !== "null" ? id!.trim() : undefined;
}

/** Plain-language kind of an InfoCuria docTypeCode — the codes alone read as
 * noise, and an OJ notice's date (its publication in the Official Journal)
 * must not pass for a decision date. */
export function curiaDocKind(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code.endsWith("_COMM")) return "OJ notice";
  if (code.startsWith("ARRET") || code.startsWith("INF")) return "judgment";
  if (code.startsWith("ORD") || code.startsWith("REF")) return "order";
  if (code.startsWith("CONCL")) return "AG opinion";
  if (code.startsWith("AVIS")) return "Opinion of the Court";
  if (code.startsWith("DDP")) return "request for a preliminary ruling";
  if (code.startsWith("RES")) return "summary";
  return undefined;
}

/** Decisions first (judgment > order > AG opinion > avis), then documents
 * with an ECLI (summaries), then the rest (OJ notices). */
function docRank(hit: CuriaHit): number {
  const kind = curiaDocKind(hit.docType);
  const decisions = ["judgment", "order", "AG opinion", "Opinion of the Court"];
  const rank = kind ? decisions.indexOf(kind) : -1;
  if (rank >= 0) return rank;
  return hit.ecli ? decisions.length : decisions.length + 1;
}

/** A case's documents, decisions first; upstream order breaks ties. Pure. */
export function orderCuriaDocuments(docs: CuriaHit[]): CuriaHit[] {
  return docs
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => docRank(a.hit) - docRank(b.hit) || a.index - b.index)
    .map(({ hit }) => hit);
}

/** The document that stands for a case (previews, one-line lanes): the best
 * readable one — a decision before a summary before an OJ notice. Pure. */
export function bestCuriaDocument(docs: CuriaHit[]): CuriaHit | undefined {
  return orderCuriaDocuments(docs).find((hit) => hit.ecli || realLogicDocId(hit.logicDocId));
}

/** Identity of one document across variants: the logicDocId is unique per
 * document; an ECLI is shared by a judgment and its summary (RES), so it
 * only counts together with the doc type. */
function docKey(hit: CuriaHit): string {
  return (
    realLogicDocId(hit.logicDocId) ??
    (hit.ecli ? `${hit.ecli}|${hit.docType}` : `${hit.caseNumber}|${hit.date}|${hit.docType}|${hit.url}`)
  );
}

/**
 * Round-robin merge of per-variant case lists — rank 0 of every variant,
 * then rank 1… — so every variant is represented. A case found by several
 * variants appears once, at its first position, with the union of the
 * documents each variant matched. Pure — unit-tested.
 */
export function mergeCuriaAffairs(lists: CuriaAffair[][]): CuriaAffair[] {
  const byKey = new Map<string, CuriaAffair>();
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const affair = list[rank];
      if (!affair) continue;
      const seen = byKey.get(affair.key);
      if (!seen) {
        byKey.set(affair.key, { ...affair, docs: [...affair.docs] });
        continue;
      }
      const keys = new Set(seen.docs.map(docKey));
      for (const doc of affair.docs) {
        // A bare listing adds nothing to a case that already has documents.
        if (!doc.docType && seen.docs.length) continue;
        const key = docKey(doc);
        if (keys.has(key)) continue;
        keys.add(key);
        seen.docs.push(doc);
      }
    }
  }
  return [...byKey.values()];
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
  // Advanced-search filters, built exactly like the SPA's createFilterWs:
  // {field, values, valuesWithFullHierarchy: values, isMatchAll?} with the
  // field names stripped of their _a suffix on the wire
  // (getAdvacedFiltersWithoutSuffix — both read from the app bundle). A
  // single "from,to" docDate value is what made the backend answer HTTP 500;
  // the captured payload sends two values.
  const filterEntry = (field: string, values: string[], isMatchAll?: boolean) => ({
    field,
    values,
    valuesWithFullHierarchy: values,
    ...(isMatchAll === undefined ? {} : { isMatchAll }),
  });
  const constraints: Array<Record<string, unknown>> = [];
  if (input.docType && input.docType !== "any") {
    const kind = CURIA_DOC_TYPES[input.docType];
    if (kind) constraints.push(filterEntry("typeDoc", kind.typeDoc));
  }
  if (input.referredFrom?.length) {
    constraints.push(
      filterEntry(
        "oqp",
        input.referredFrom.map((code) => `NAT_${code.toUpperCase()}`),
      ),
    );
  }
  if (input.citesCelex) {
    // isMatchAll mirrors the form's "match all citations" (vs "any") choice.
    constraints.push(
      filterEntry("citationsMotif", [buildCitationsMotif(input.citesCelex, input.citesArticle)], true),
    );
  }
  if (input.dateFrom || input.dateTo) {
    constraints.push(
      filterEntry("docDate", [input.dateFrom ?? "1952-01-01", input.dateTo ?? "2099-12-31"]),
    );
  }

  // The backend runs EITHER a searchTerm search OR an advanced-filters
  // search: with advancedFiltersValue non-empty it silently IGNORES
  // searchTerm (verified live — "Telia Finland" + a 2023 date window
  // returned the whole 2023 slice, byte-identical to any other text). The
  // form therefore moves the criteria into the filters too — text, affair
  // (number or name of the case), eCli — and leaves searchTerm and the
  // top-level identifier keys empty; so do we whenever a constraint is on.
  // An ECLI always takes this route: on the searchTerm route without a term
  // the backend ignores the top-level ecli key and returns the whole index
  // (verified live: ECLI:EU:C:2020:559 alone → 59 368 "matching" cases,
  // newest first; as the eCli criterion → C-311/18 alone).
  const useAdvanced = constraints.length > 0 || Boolean(input.ecli);
  const criteria: Array<Record<string, unknown>> = [];
  if (useAdvanced) {
    if (input.query) {
      criteria.push(filterEntry("text", [input.query]));
      // Unlike the searchTerm route, the "text" criterion searches ONLY the
      // chosen language version (verified live: a Czech phrase scored 0
      // under EN, 5 under CS). allLang is the form's "extend to all language
      // versions" checkbox — always on here, so both routes stay multilingual.
      criteria.push(filterEntry("allLang", ["true"]));
    }
    if (input.caseNumber) criteria.push(filterEntry("affair", [input.caseNumber]));
    else if (input.parties) criteria.push(filterEntry("affair", [input.parties]));
    if (input.ecli) criteria.push(filterEntry("eCli", [input.ecli]));
  }
  // Without constraints, party names go through full text — the backend
  // ignores usualName without a searchTerm (verified live: found C-201/22
  // for "Telia Finland").
  const searchTerm = useAdvanced
    ? ""
    : (input.query ?? (input.caseNumber ? `"${input.caseNumber}"` : (input.parties ?? "")));
  return {
    searchTerm,
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
    ecli: useAdvanced ? "" : (input.ecli ?? ""),
    publishedId: useAdvanced ? "" : (input.caseNumber ?? ""),
    usualName: useAdvanced ? "" : (input.parties ?? ""),
    logicDocId: "",
    repJurExpand: true,
    filtersValue,
    advancedFiltersValue: [...criteria, ...constraints],
    // The captured advanced-search payload sends isSearchExact: true. On the
    // searchTerm route free-text behaves better non-exact, identifiers exact.
    isSearchExact: useAdvanced ? true : !input.query,
    searchSources: ["document", "metadata"],
  };
}

/** The citable human page of one document on curia.europa.eu — the classic
 * interface's docid deep link, which the elastic logicDocId numbers match. */
function curiaDocumentUrl(docId: string, language: string): string {
  return `https://curia.europa.eu/juris/document/document.jsf?text=&docid=${encodeURIComponent(docId)}&doclang=${language.toUpperCase().slice(0, 2)}`;
}

/** Extract the cases and their documents from the nested innerHits shape;
 * `language` only shapes the verification links. Pure — unit-tested. */
export function parseCuriaSearch(json: unknown, language = "en"): CuriaSearchPage {
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
  const lang2 = language.toLowerCase().slice(0, 2);
  const listingUrl = (caseNumber: string) =>
    `https://curia.europa.eu/juris/liste.jsf?num=${encodeURIComponent(caseNumber)}&language=${encodeURIComponent(lang2)}`;
  const affairs: CuriaAffair[] = [];
  data.searchHits.forEach((outer, index) => {
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
    const affId = (outer as Record<string, unknown>).affId ?? affair.affId;

    const docs: CuriaHit[] = [];
    const innerDocs = outer.innerHits?.document?.searchHits ?? [];
    if (!innerDocs.length && (affairCaseNumber || caseName)) {
      // Keyword-less searches (referred_from alone…) score no documents, but
      // the affair itself matched — surface it with its case-listing link.
      docs.push({
        caseNumber: affairCaseNumber,
        caseName,
        stateCode,
        url: affairCaseNumber ? listingUrl(affairCaseNumber) : null,
      });
    }
    for (const inner of innerDocs) {
      const doc = (inner.document ?? inner.content ?? {}) as Record<string, unknown>;
      const str = (key: string) => (typeof doc[key] === "string" ? (doc[key] as string) : undefined);
      // || not ??: InfoCuria can return EMPTY-STRING ids, which must fall
      // through like missing ones.
      const ecli = str("ecli") || str("docEcli") || undefined;
      const caseNumber = str("docNoPart") ?? str("idPublished") ?? affairCaseNumber;
      const logicDocId = realLogicDocId(str("logicDocId"));
      const docId = logicDocId?.replace(/^id_/, "");
      docs.push({
        logicDocId,
        docType: str("docTypeCode"),
        date: str("docDate"),
        parties: str("parties"),
        ecli,
        caseNumber,
        caseName,
        stateCode,
        // The citable curia.europa.eu page of the document itself; EUR-Lex
        // by ECLI and the case listing are the fallbacks.
        url: docId
          ? curiaDocumentUrl(docId, language)
          : ecli
            ? `https://eur-lex.europa.eu/legal-content/${language.toUpperCase().slice(0, 2)}/TXT/?uri=ecli:${encodeURIComponent(ecli)}`
            : caseNumber
              ? listingUrl(caseNumber)
              : null,
      });
    }
    if (!docs.length) return;
    const caseNumber = affairCaseNumber ?? docs[0].caseNumber;
    affairs.push({
      key:
        caseNumber ??
        (typeof affId === "string" || typeof affId === "number" ? `aff:${affId}` : caseName ?? `#${index}`),
      caseNumber,
      caseName,
      stateCode,
      docs,
    });
  });
  return { total: data.totalHits, affairs, hits: affairs.flatMap((affair) => affair.docs) };
}

/** Client-side refinements over the returned documents. Pure — unit-tested. */
export function refineCuriaHits(hits: CuriaHit[], input: CuriaSearchInput): CuriaHit[] {
  return hits.filter((hit) => {
    if (input.docType && input.docType !== "any") {
      const prefixes = CURIA_DOC_TYPES[input.docType]?.prefixes ?? [];
      if (!prefixes.some((prefix) => (hit.docType ?? "").startsWith(prefix))) return false;
    }
    if (input.state === "closed" && hit.stateCode && !hit.stateCode.startsWith("CLOT")) return false;
    if (input.state === "pending" && hit.stateCode && !hit.stateCode.startsWith("ENC")) return false;
    if (input.dateFrom && hit.date && hit.date < input.dateFrom) return false;
    if (input.dateTo && hit.date && hit.date > input.dateTo) return false;
    return true;
  });
}

/** refineCuriaHits inside every case; a case left with no document goes,
 * and `filtered` counts the documents removed. Pure — unit-tested. */
export function refineCuriaAffairs(
  affairs: CuriaAffair[],
  input: CuriaSearchInput,
): { affairs: CuriaAffair[]; filtered: number } {
  let filtered = 0;
  const kept: CuriaAffair[] = [];
  for (const affair of affairs) {
    const docs = refineCuriaHits(affair.docs, input);
    filtered += affair.docs.length - docs.length;
    if (docs.length) kept.push({ ...affair, docs });
  }
  return { affairs: kept, filtered };
}

export type CuriaSearchResult = CuriaSearchPage & {
  /** Documents the client-side guards removed from this page. */
  filtered: number;
};

const searchCache = new TtlCache<CuriaSearchResult>(SEARCH_TTL_MS);

/** One upstream page of `pageSize` CASES. */
export async function searchCuria(input: CuriaSearchInput, page: number, pageSize: number): Promise<CuriaSearchResult> {
  return searchCache.through(memoKey("curia-search", [input, page, pageSize]), () =>
    runSearchCuria(input, page, pageSize),
  );
}

/** Let go of a body nobody reads, so the connection is freed now rather than at GC. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function runSearchCuria(input: CuriaSearchInput, page: number, pageSize: number): Promise<CuriaSearchResult> {
  if (
    !input.query &&
    !input.caseNumber &&
    !input.ecli &&
    !input.parties &&
    !input.referredFrom?.length &&
    !input.citesCelex
  ) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "CURIA search needs at least one criterion.",
      "Provide query (full-text keywords), case_number (e.g. 'C-311/18'), ecli, parties, referred_from, or cites_celex.",
    );
  }
  const response = await fetchUpstream(SOURCE, `${WS_BASE}/elastic-connector/search`, {
    method: "POST",
    headers: SPA_HEADERS,
    body: JSON.stringify(buildCuriaBody(input, page, pageSize)),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    await discard(response);
    // A rejected request shape is not fixed by waiting; an auth/WAF refusal
    // or anything else may be transient.
    const shapeRejected = [400, 404, 405, 415, 422].includes(response.status);
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `InfoCuria answered HTTP ${response.status}.`,
      shapeRejected
        ? "The backend rejected the request shape — it may have changed; run dawmain_probe_sources (canary 'curia')."
        : "Try again in a minute; if it persists the backend may have changed — run dawmain_probe_sources.",
    );
  }
  // A 200 with an HTML body (WAF, maintenance page) is a wrong format, not
  // silence — response.json() would surface it as "did not respond".
  const body = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `InfoCuria answered HTTP 200 with a non-JSON body (${JSON.stringify(body.trim().slice(0, 80))}).`,
      "The backend may be under maintenance or have changed — run dawmain_probe_sources (canary 'curia') with include_raw.",
    );
  }
  const parsed = parseCuriaSearch(json, input.language ?? "en");
  const refined = refineCuriaAffairs(parsed.affairs, input);
  return {
    total: parsed.total,
    affairs: refined.affairs,
    hits: refined.affairs.flatMap((affair) => affair.docs),
    filtered: refined.filtered,
  };
}

// ---------- document text ----------

export interface CuriaDocument {
  text: string;
  via: "cellar" | "infocuria-blob";
  url: string;
  /** ISO 639-1 of the text served. */
  language: string;
  /** The requested language had no text — this is the English one. */
  fallback: boolean;
}

/** Blob texts, like Cellar's: big — few entries; the TTL bounds memory. */
const blobCache = new TtlCache<string>(DOCUMENT_TTL_MS, 24);
const BLOB_TIMEOUT_MS = 25_000;

/** Thrown inside a cache load so a miss stays uncached (through() stores
 * whatever its load returns). */
class NoBlobText extends Error {}

/** The InfoCuria blob of one document in one language; null when it has none. */
async function fetchCuriaBlob(id: string, lang2: string, deadline: number): Promise<{ text: string; url: string } | null> {
  const url = `${WS_BASE}/blob/download-file/${encodeURIComponent(id)}/${lang2.toUpperCase()}/html`;
  try {
    const text = await blobCache.through(memoKey("curia-blob", [id, lang2]), async () => {
      const response = await fetchWithinDeadline(
        SOURCE,
        url,
        { headers: SPA_HEADERS },
        {
          deadline,
          timeoutMs: BLOB_TIMEOUT_MS,
          retryOnTimeout: true,
          retryStatus: () => true,
          what: "fetching the InfoCuria text",
        },
      );
      if (!response.ok) {
        await discard(response);
        throw new NoBlobText();
      }
      const text = htmlToText(await response.text());
      if (text.length <= 200) throw new NoBlobText();
      return text;
    });
    return { text, url };
  } catch (error) {
    if (error instanceof NoBlobText) return null;
    throw error;
  }
}

/** Cellar failing (5xx, unreachable, budget) — not a bad input or a miss. */
function isOutage(error: unknown): error is SourceError {
  return error instanceof SourceError && (error.kind === "UPSTREAM_ERROR" || error.kind === "UPSTREAM_UNREACHABLE");
}

export async function getCuriaDocument(options: {
  celex?: string;
  ecli?: string;
  logicDocId?: string;
  language?: string;
  /** The tool call's Cellar deadline (cellarDeadline()); starts here without one. */
  deadline?: number;
}): Promise<CuriaDocument> {
  // One deadline for every step — CELEX, ECLI and the blob run in sequence.
  const deadline = options.deadline ?? cellarDeadline();
  const celex = options.celex ? normalizeCelex(options.celex) : "";
  const ecli = options.ecli ? normalizeEcli(options.ecli) : "";
  const logicDocId = realLogicDocId(options.logicDocId);
  // Cellar refuses a language it does not know (never a silent English);
  // a logic_doc_id-only read never reaches Cellar, so an unknown code there
  // reads the English blob — said as a fallback — instead of being refused.
  const resolved = resolveCellarLanguage(options.language ?? "en");
  const unresolved = !resolved;
  const requested =
    celex || ecli ? requireCellarLanguage(SOURCE, options.language ?? "en") : (resolved ?? { iso2: "en", iso3: "eng" });

  let cellarFailure: SourceError | undefined;
  try {
    if (celex) {
      const document = await fetchCellarDocument(SOURCE, `/celex/${encodeURIComponent(celex)}`, requested.iso2, { deadline });
      if (document) {
        return { ...document, via: "cellar", url: `${CELLAR_BASE}/celex/${celex}`, fallback: document.language !== requested.iso2 };
      }
    }
    if (ecli) {
      const document = await fetchCellarDocument(SOURCE, `/ecli/${encodeURIComponent(ecli)}`, requested.iso2, { deadline });
      if (document) {
        return { ...document, via: "cellar", url: `${CELLAR_BASE}/ecli/${ecli}`, fallback: document.language !== requested.iso2 };
      }
    }
  } catch (error) {
    // Cellar down: the blob is another host, so a logic_doc_id still gets
    // its chance — straight away, not via the next Cellar identifier (same
    // failing host, another retry and back-off). Without one, or when the
    // blob has nothing either, the Cellar error is what the model hears: an
    // outage must not read as "no such document".
    if (!logicDocId || !isOutage(error)) throw error;
    cellarFailure = error;
  }
  if (logicDocId) {
    // A Cellar timeout can eat the whole budget; a blob request that could
    // only time out is not started.
    if (!hasBudget(deadline)) throw cellarFailure ?? budgetSpent(SOURCE, "fetching the InfoCuria text");
    const id = logicDocId.replace(/^id_/, "");
    let blob: { text: string; url: string } | null;
    try {
      blob = await fetchCuriaBlob(id, requested.iso2, deadline);
    } catch (error) {
      throw cellarFailure ?? error;
    }
    if (blob) return { ...blob, via: "infocuria-blob", language: requested.iso2, fallback: unresolved };
    // Like Cellar: no text in the requested language → the English one,
    // said as a fallback. A brand-new document often exists in English
    // only, and asking in Czech must not lose a text English would give.
    if (requested.iso2 !== "en" && hasBudget(deadline)) {
      let english: { text: string; url: string } | null = null;
      try {
        english = await fetchCuriaBlob(id, "en", deadline);
      } catch (error) {
        throw cellarFailure ?? error;
      }
      if (english) return { ...english, via: "infocuria-blob", language: "en", fallback: true };
    }
  }
  if (cellarFailure) throw cellarFailure;

  throw new SourceError(
    SOURCE,
    "NOT_FOUND",
    "No text could be retrieved for the given identifiers.",
    "Check the CELEX (e.g. 62018CJ0311) or ECLI (ECLI:EU:C:2020:559). For very recent decisions, OJ notices and documents not in Cellar pass the logic_doc_id that sdeu_search lists. Some documents exist only in selected languages — try language 'en' or 'fr'.",
  );
}
