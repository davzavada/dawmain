import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { parseCaseNumber } from "./shared/text";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";

/**
 * rozhodnuti.justice.cz — decisions of obecné soudy (okresní, krajské,
 * vrchní), Ministry of Justice, keyless and CC BY 4.0.
 *
 * Search is `GET /api/finaldoc` — the SPA's own backend, captured from a live
 * browser request (2026-09) because it is undocumented: the published
 * open-data surface is only a listing by publication day. It is a Spring
 * backend that answers an unknown enum value with HTTP 400 naming the field,
 * so drifted vocabularies surface as errors rather than as silent misses.
 * Full texts by UUID via /api/finaldoc/{uuid}.
 * See docs/research/cz-sources.json.
 */

const SOURCE = "rozhodnuti.justice.cz";
const BASE = "https://rozhodnuti.justice.cz/api";
/**
 * Full-text over the whole archive is slow; the default 15 s times out. One
 * attempt only, and short of the route's 60 s maxDuration: 30 s plus a retry
 * after a timeout used to run ~61 s, so the platform killed the call and the
 * client saw a bare "server isn't responding" instead of the hint below.
 */
const SEARCH_TIMEOUT_MS = 45_000;
/**
 * retry:false above exists only so a 45 s timeout is never followed by a
 * second one. A 429/5xx or dropped connection that comes back FAST is another
 * matter: the server 429s under load (other clients back off 2 s and get
 * through), so a failure inside this window gets one retry, its timeout cut to
 * what is left of the 45 s — the whole search still ends within 45 s.
 */
const RETRY_WINDOW_MS = 5_000;

const searchCache = new TtlCache<JusticeSearchPage>(SEARCH_TTL_MS);
const decisionCache = new TtlCache<JusticeDecision>(DOCUMENT_TTL_MS, 24);

/**
 * Court codes the `courtCodes` filter accepts — the complete list the SPA
 * sends when every court is ticked (captured 2026-09). Kept verbatim so an
 * unknown code fails with the menu instead of silently narrowing the search
 * to nothing: the API accepts any string here and answers an unknown one with
 * zero hits, which reads exactly like "no such case law exists".
 */
export const JUSTICE_COURT_CODES = [
  // Nejvyšší, Nejvyšší správní a Ústavní soud (also carried by this index)
  "NS", "NSS", "US",
  // Vrchní soudy
  "VSOL", "VSPH",
  // Krajské a městské soudy (…JI/ZL/TA/PA/OL/KV/LI = pobočky)
  "KSBR", "KSBRJI", "KSBRZL", "KSCB", "KSCBTA", "KSHK", "KSHKPA", "KSOS", "KSOSOL",
  "KSPH", "KSPL", "KSPLKV", "KSUL", "KSULLI", "MSBR", "MSPH",
  // Obvodní soudy pro Prahu 1–10
  "OSPH01", "OSPH02", "OSPH03", "OSPH04", "OSPH05",
  "OSPH06", "OSPH07", "OSPH08", "OSPH09", "OSPH10",
  // Okresní soudy
  "OSBI", "OSBK", "OSBN", "OSBR", "OSBU", "OSBUKR", "OSBV", "OSCB", "OSCH", "OSCK",
  "OSCL", "OSCR", "OSCV", "OSDC", "OSDO", "OSFM", "OSHB", "OSHK", "OSHO", "OSJC",
  "OSJE", "OSJH", "OSJI", "OSJN", "OSKD", "OSKH", "OSKI", "OSKIHA", "OSKM", "OSKO",
  "OSKT", "OSKV", "OSLI", "OSLN", "OSLT", "OSMB", "OSME", "OSMO", "OSNA", "OSNB",
  "OSNJ", "OSOL", "OSOP", "OSOV", "OSPB", "OSPE", "OSPI", "OSPJ", "OSPM", "OSPR",
  "OSPS", "OSPT", "OSPU", "OSPV", "OSPY", "OSPZ", "OSRA", "OSRK", "OSRO", "OSSM",
  "OSSO", "OSST", "OSSU", "OSSY", "OSTA", "OSTC", "OSTP", "OSTR", "OSTU", "OSUH",
  "OSUL", "OSUO", "OSVS", "OSVSVM", "OSVY", "OSZL", "OSZN", "OSZR",
] as const;

/** DocTypeEnm values, verbatim from the captured request. */
export const JUSTICE_DOC_TYPES = ["JUDGEMENT", "ORDER_T", "RESOLUTION"] as const;
export type JusticeDocType = (typeof JUSTICE_DOC_TYPES)[number];

/** SearchModeEnm — the three the backend accepts (PHRASE is rejected). */
const SEARCH_MODES: Record<"all_words" | "any_word" | "phrase", string> = {
  all_words: "ALL",
  any_word: "ANY",
  phrase: "EXACT",
};

export interface JusticeSearchInput {
  query?: string;
  match?: keyof typeof SEARCH_MODES;
  /** "8 Co 60/2025" — split into the four fields the API indexes. */
  caseNumber?: string;
  courtCodes?: string[];
  types?: JusticeDocType[];
  decidedFrom?: string; // ISO — datum vydání
  decidedTo?: string;
  publishedFrom?: string; // ISO — datum zveřejnění
  publishedTo?: string;
  /** Applied act, "číslo/rok" — e.g. "89/2012". */
  appliesAct?: string;
  /** Narrows appliesAct to one §, e.g. "§ 2201" or "2201". */
  appliesSection?: string;
  sort?: "published" | "decided";
}

// ---------- parse (pure) ----------

export interface JusticeCaseNumber {
  senate?: number;
  registry?: string;
  index?: number;
  year?: number;
  pageNumber?: number;
}

/** "8 Co 60/2025-174" from the API's split form. Pure — unit-tested. */
export function formatCaseNumber(parts: JusticeCaseNumber | undefined): string | undefined {
  if (!parts || parts.index === undefined || parts.year === undefined) return undefined;
  const head = [parts.senate, parts.registry].filter((part) => part !== undefined).join(" ");
  const tail = `${parts.index}/${parts.year}${parts.pageNumber ? `-${parts.pageNumber}` : ""}`;
  return head ? `${head} ${tail}` : tail;
}

export interface JusticeAffected {
  caseNumber?: string;
  court?: string;
  date?: string;
  /** CHANGE | CONFIRM | CANCEL | COMPLETE | CORRECT | REPLACE. */
  types: string[];
}

export interface JusticeHit {
  uuid: string;
  caseNumber?: string;
  ecli?: string;
  court?: string;
  type?: string;
  decidedAt?: string;
  publishedAt?: string;
  judge?: string;
  subject?: string;
  verdict?: string;
  /** What this decision did to a lower court's — the index's own citator. */
  affects: JusticeAffected[];
  url: string;
}

export interface JusticeSearchPage {
  total: number;
  totalPages: number;
  page: number;
  hits: JusticeHit[];
}

export function decisionUrl(uuid: string): string {
  return `https://rozhodnuti.justice.cz/rozhodnuti/?id=${uuid}`;
}

/** Parse a /api/finaldoc search response. Pure — unit-tested. */
export function parseJusticeSearch(json: unknown): JusticeSearchPage {
  const data = json as {
    items?: Array<Record<string, unknown>>;
    totalElements?: number;
    totalPages?: number;
    pageNumber?: number;
  };
  if (!Array.isArray(data.items)) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "justice.cz search response is missing the 'items' array.",
      "The API shape may have changed — run dawmain_probe_sources (canary 'justice') with include_raw.",
    );
  }
  const hits: JusticeHit[] = [];
  for (const item of data.items) {
    const uuid = typeof item.uuid === "string" ? item.uuid : "";
    // The uuid is the ONLY handle justice_get_decision accepts, so a row
    // without one would hand the model an id its next call must reject.
    if (!uuid) continue;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : undefined);
    const solver = (meta.solver ?? {}) as Record<string, unknown>;
    const judge = [solver.titlesBefore, solver.firstName, solver.lastName, solver.titlesAfter]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ");
    const affectedDocs = Array.isArray(meta.affectedDocs)
      ? (meta.affectedDocs as Array<Record<string, unknown>>)
      : [];
    hits.push({
      uuid,
      caseNumber: formatCaseNumber(meta.caseNumber as JusticeCaseNumber | undefined),
      ecli: str("ecli"),
      court: str("courtCode"),
      type: str("type"),
      decidedAt: str("decisionAt"),
      publishedAt: str("publishedAt"),
      judge: judge || undefined,
      subject: str("caseSubject"),
      verdict: typeof item.verdictText === "string" ? item.verdictText : undefined,
      affects: affectedDocs.map((doc) => ({
        caseNumber: formatCaseNumber(doc.caseNumber as JusticeCaseNumber | undefined),
        court: typeof doc.courtCode === "string" ? doc.courtCode : undefined,
        date: typeof doc.affectedDate === "string" ? doc.affectedDate : undefined,
        types: Array.isArray(doc.affectedTypes) ? (doc.affectedTypes as unknown[]).map(String) : [],
      })),
      url: decisionUrl(uuid),
    });
  }
  return {
    total: typeof data.totalElements === "number" ? data.totalElements : hits.length,
    totalPages: typeof data.totalPages === "number" ? data.totalPages : 1,
    page: typeof data.pageNumber === "number" ? data.pageNumber : 0,
    hits,
  };
}

export interface JusticeSection {
  /** "2201", "14b" — what regulationParagraph takes. */
  paragraph: string;
  /** The "odst. 1 písm. a)" tail the index cannot filter on, when one was given. */
  dropped?: string;
}

/** A § number with its letter, then optionally an odstavec/písmeno/věta/bod tail. */
const SECTION_LABEL =
  /^(\d{1,4}[a-z]{0,3})(?:\s*,?\s*((?:odst|odstavec|písm|písmeno|věta|bod)(?![\p{L}\d]).*))?$/iu;

/**
 * "§ 2201", "§§ 2201", "2201", "§ 14B", "§ 2201 odst. 1 písm. a)" → the
 * paragraph as the API wants it. The letter goes LOWER-case: regulationParagraph
 * matches case-sensitively and the index stores "14b" (live 2026-09, 177/1996
 * published June 2026: "14B" → 0 hits, "14b" → 1 382), so "§ 14B" read as a
 * silent nothing-found. The index records paragraphs, not odstavce, so an
 * odstavec tail is accepted and handed back as `dropped` for the tool to say
 * so, instead of costing the model a round trip. Pure — unit-tested.
 */
export function parseSection(section: string): JusticeSection {
  const cleaned = section.trim().replace(/^§+\s*/u, "");
  const m = SECTION_LABEL.exec(cleaned);
  if (!m) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${section}" is not a section label.`,
      'Pass the section as "§ 2201" or just "2201".',
    );
  }
  const dropped = m[2]?.trim();
  return { paragraph: m[1].toLowerCase(), ...(dropped ? { dropped } : {}) };
}

/** parseSection's paragraph alone. Pure. */
export function normalizeSection(section: string): string {
  return parseSection(section).paragraph;
}

/** "89/2012", "89/2012 Sb.", "č. 89/2012 Sb.", "zákon č. 89/2012 Sb." — number and year. */
const ACT_REFERENCE = /^\s*(?:(?:zákon\p{L}*|zák\.)\s*)?(?:č\.\s*)?(\d{1,4})\s*\/\s*(\d{4})\s*(?:Sb\.?)?\s*$/iu;

/** Build the query string. Pure — unit-tested. */
export function buildJusticeQuery(
  input: JusticeSearchInput,
  page: number,
  limit: number,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("page", String(page));

  if (input.query) {
    params.set("searchText", input.query);
    params.set("searchMode", SEARCH_MODES[input.match ?? "all_words"]);
  }
  if (input.caseNumber) {
    const parts = parseCaseNumber(input.caseNumber);
    if (!parts) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `"${input.caseNumber}" is not a spisová značka.`,
        "Use the '{senát} {rejstřík} {číslo}/{rok}' form, e.g. '8 Co 60/2025'.",
      );
    }
    if (parts.senate) params.set("caseNumberSenate", parts.senate);
    params.set("caseNumberRegistry", parts.registry);
    params.set("caseNumberIndex", parts.number);
    params.set("caseNumberYear", parts.year);
  }
  for (const code of input.courtCodes ?? []) {
    const wanted = code.trim().toUpperCase();
    if (!(JUSTICE_COURT_CODES as readonly string[]).includes(wanted)) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `"${code}" is not a justice.cz court code.`,
        `Valid codes: ${JUSTICE_COURT_CODES.join(", ")}.`,
      );
    }
    params.append("courtCodes", wanted);
  }
  for (const type of input.types ?? []) params.append("type", type);
  if (input.decidedFrom) params.set("issuedFrom", input.decidedFrom);
  if (input.decidedTo) params.set("issuedTo", input.decidedTo);
  if (input.publishedFrom) params.set("publishedFrom", input.publishedFrom);
  if (input.publishedTo) params.set("publishedTo", input.publishedTo);

  if (input.appliesSection && !input.appliesAct) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      "applies_section needs an act to attach to.",
      "Pair it with applies_act, e.g. applies_act '89/2012' + applies_section '§ 2201'.",
    );
  }
  if (input.appliesAct) {
    const act = ACT_REFERENCE.exec(input.appliesAct);
    if (!act) {
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `"${input.appliesAct}" is not an act reference.`,
        "Use 'číslo/rok', e.g. '89/2012' (občanský zákoník) or '99/1963' (o.s.ř.).",
      );
    }
    params.set("regulationNumber", act[1]);
    params.set("regulationYear", act[2]);
    if (input.appliesSection) params.set("regulationParagraph", normalizeSection(input.appliesSection));
  }

  params.set("sortBy", input.sort === "decided" ? "DECISION_AT" : "PUBLISHED_AT");
  params.set("sortDirection", "DESC");
  return params;
}

// ---------- fetch (I/O) ----------

/**
 * The timeout hint, fitted to what timed out. Measured live (2026-09, 45 s
 * each): a query holding a number or act citation — '89/2012', even a bare
 * '2012' — timed out inside a 10-day window, because such tokens occur in
 * nearly every decision; applies_act '89/2012' alone timed out from 2020-10;
 * while 'nájemné' over five years (20 297 hits) answered at once. Telling the
 * first two to "use one word and a window of months" only buys a second 45 s
 * wait. Pure — unit-tested.
 */
export function slowSearchHint(input: JusticeSearchInput): string {
  const others = "for NS/NSS/ÚS case law use caselaw_search.";
  const query = input.query?.trim();
  if (query && /[\d§]/u.test(query)) {
    return `Numbers and act citations in query ('89/2012', '2012', '§ 2201') occur in nearly every decision, so the full-text index times out on them whatever the date window. Drop them from query — the act goes in applies_act '89/2012' (+ applies_section '§ 2201') — and keep query to 1–2 words; ${others}`;
  }
  if (!query && input.appliesAct && !input.appliesSection) {
    return `applies_act alone matches most of the archive for the big codes (o. z., o. s. ř.), and that set is too large to sort in time — the index is slow, not down. Add applies_section '§ …', court_codes or types, or a date window of months; ${others}`;
  }
  if (!query) {
    return `The index is slow on large result sets, not down. Narrow the listing with court_codes, types or a date window of months; ${others}`;
  }
  return `Its full-text index is slow on multi-word queries and on large result sets, not down. Retry with ONE distinctive word (e.g. 'sazebník' rather than a sentence), a date window of months rather than years, and/or court_codes; ${others}`;
}

/** Cut off by the timeout signal — wrapped by fetchUpstream, or raw from a body read. */
function isTimeout(error: unknown): boolean {
  if (error instanceof SourceError) return error.kind === "UPSTREAM_UNREACHABLE" && /timeout/i.test(error.message);
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** "429" or "5xx" when fetchUpstream refused an overloaded answer (it throws those). */
function overloadStatus(error: unknown): string | undefined {
  return error instanceof SourceError && error.kind === "UPSTREAM_ERROR"
    ? /HTTP (429|5\d\d)\b/.exec(error.message)?.[1]
    : undefined;
}

/** The back-off before the one retry, or undefined when the failure does not earn one. */
function transientBackoff(error: unknown): number | undefined {
  if (!(error instanceof SourceError) || isTimeout(error)) return undefined;
  if (error.kind === "UPSTREAM_UNREACHABLE") return 500 + Math.random() * 1000;
  const status = overloadStatus(error);
  if (!status) return undefined;
  return status === "429" ? 2000 : 500 + Math.random() * 1000;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function searchJustice(
  input: JusticeSearchInput,
  page: number,
  limit: number,
): Promise<JusticeSearchPage> {
  // Keyed on the request, not the raw input: 'ksbr' and 'KSBR', '89/2012 Sb.'
  // and '89/2012', '§ 2201' and '2201' send the byte-identical URL, so a
  // respelled repeat is a cache hit instead of another slow full-text query.
  // An input error throws here, before the cache is touched.
  const params = buildJusticeQuery(input, page, limit);
  return searchCache.through(memoKey("justice-search", params.toString()), () => runSearchJustice(params, input));
}

async function runSearchJustice(params: URLSearchParams, input: JusticeSearchInput): Promise<JusticeSearchPage> {
  const started = Date.now();
  const attempt = (timeoutMs: number) =>
    fetchUpstream(SOURCE, `${BASE}/finaldoc?${params}`, {
      headers: { accept: "application/json" },
      timeoutMs,
      retry: false,
    });
  let retried = false;
  try {
    let response: Response;
    try {
      response = await attempt(SEARCH_TIMEOUT_MS);
    } catch (error) {
      const backoff = transientBackoff(error);
      if (backoff === undefined || Date.now() - started >= RETRY_WINDOW_MS) throw error;
      await sleep(backoff);
      retried = true;
      response = await attempt(SEARCH_TIMEOUT_MS - (Date.now() - started));
    }
    if (response.status === 400) {
      // Spring names the field it rejected; that beats any guess we could make.
      const detail = (await response.text()).slice(0, 400);
      throw new SourceError(
        SOURCE,
        "INPUT_INVALID",
        `justice.cz rejected the search: ${detail}`,
        "One of the filter vocabularies has changed upstream — run dawmain_probe_sources with include_raw and check the field the message names.",
      );
    }
    if (!response.ok) {
      // 429 and 5xx never get here (fetchUpstream throws them, handled below).
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `justice.cz answered HTTP ${response.status} for the search.`,
        "Unexpected for this endpoint — run dawmain_probe_sources (canary 'justice') to see whether the API moved.",
      );
    }
    // Inside the try: the timeout signal also covers the body, and a read cut
    // off by it must get the same hint as a request that never answered.
    return parseJusticeSearch(await response.json());
  } catch (error) {
    if (isTimeout(error)) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_UNREACHABLE",
        `justice.cz did not answer the search within ${SEARCH_TIMEOUT_MS / 1000} s.`,
        slowSearchHint(input),
      );
    }
    const status = overloadStatus(error);
    if (status) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `justice.cz answered HTTP ${status} for the search${retried ? " even after a retry" : ""}.`,
        status === "429"
          ? "The server returns 429 under load and is slow on unbounded full-text queries — wait a minute, add a date range and retry."
          : (error as SourceError).hint,
      );
    }
    throw error;
  }
}

// ---------- full text ----------

export interface JusticeDecision {
  uuid: string;
  text: string;
  metadata: Record<string, unknown>;
  url: string;
}

/** Parse a finaldoc response — leniently, the field types drift. Pure. */
export function parseJusticeDecision(json: unknown, uuid: string): JusticeDecision {
  // Paragraph = { texts: [{ text, anonStyle }], … }; read without trusting
  // the shape, which has drifted before (a bare string is taken as it is).
  const data = json as {
    verdictText?: unknown;
    justificationText?: unknown;
    header?: unknown;
    verdict?: unknown;
    justification?: unknown;
    information?: unknown;
    metadata?: Record<string, unknown> | null;
  };

  const flatText = (value: unknown): string => (typeof value === "string" ? value : "");
  const paragraphText = (paragraph: unknown): string => {
    if (typeof paragraph === "string") return paragraph;
    const texts = (paragraph as { texts?: unknown } | null)?.texts;
    return Array.isArray(texts) ? texts.map((t) => flatText((t as { text?: unknown } | null)?.text)).join("") : "";
  };
  const joinParagraphs = (paragraphs: unknown): string =>
    (Array.isArray(paragraphs) ? paragraphs : [])
      .map(paragraphText)
      .filter((line) => line.trim())
      .join("\n");

  // Section by section, the paragraph arrays first. They hold one paragraph
  // per entry, while the flat verdictText/justificationText of current
  // documents run the paragraphs together with no separator at all
  // ("…zastavuje.II. Žádný", "…výroku).2. Proti" — live 8d2e6b9a, 2026-09):
  // the bod number sinks into the previous sentence and find's excerpts
  // cannot start at it. Only the arrays carry the záhlaví (court, senate,
  // parties, the decision under review) and the poučení. Each section falls
  // back to its own flat field, so one drifted null array cannot drop the
  // odůvodnění while the rest of the document still reads as complete.
  const text = [
    joinParagraphs(data.header),
    joinParagraphs(data.verdict) || flatText(data.verdictText),
    joinParagraphs(data.justification) || flatText(data.justificationText),
    joinParagraphs(data.information),
  ]
    .filter((part) => part.trim())
    .join("\n\n");
  if (!text.trim()) {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      `finaldoc ${uuid} contains no extractable text.`,
      "The document may be empty or the shape changed — run dawmain_probe_sources with include_raw.",
    );
  }
  return { uuid, text: text.trim(), metadata: data.metadata ?? {}, url: decisionUrl(uuid) };
}

export async function getJusticeDecision(uuid: string): Promise<JusticeDecision> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `"${uuid}" is not a decision UUID.`,
      "Pass the uuid from justice_search.",
    );
  }
  return decisionCache.through(memoKey("justice-doc", [uuid]), async () => {
    const response = await fetchUpstream(SOURCE, `${BASE}/finaldoc/${uuid}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      throw new SourceError(
        SOURCE,
        "NOT_FOUND",
        `justice.cz has no decision ${uuid}.`,
        "The uuid may be stale — re-run justice_search.",
      );
    }
    if (!response.ok) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `justice.cz answered HTTP ${response.status} for finaldoc.`,
        "Retry in a moment (the server 429s under load).",
      );
    }
    return parseJusticeDecision(await response.json(), uuid);
  });
}
