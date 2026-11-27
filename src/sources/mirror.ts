import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";

/**
 * Client of the home mirror's API v1 (src/mirror/api/server.ts). The web
 * server reaches it over the LAN (MIRROR_API_URL=http://192.168.0.52:8080,
 * no Access headers, docs/infra/proxmox.md); from outside the LAN through
 * the Cloudflare Tunnel `dawmain-databaze`, behind Cloudflare Access
 * (service token) — both with the API's own bearer token.
 *
 *   MIRROR_API_URL                   http://192.168.0.52:8080 (else https://dawmain-databaze.davidzavada.cz)
 *   MIRROR_API_TOKEN                 the API's bearer token (/etc/mirror/env on `app`)
 *   MIRROR_CF_ACCESS_CLIENT_ID       Access service token (only through the tunnel)
 *   MIRROR_CF_ACCESS_CLIENT_SECRET
 *
 * The mirror's ids are the courts' own (NS UNID, NSS numeric id, ÚS sz,
 * justice UUID), so a hit from here is readable by the live *_get_* tools
 * and the other way round.
 */

export const MIRROR_SOURCE_LABEL = "Zrcadlo judikatury";
export type MirrorCourt = "ns" | "nss" | "us" | "justice";
export const MIRROR_COURTS: readonly MirrorCourt[] = ["ns", "nss", "us", "justice"];

// One attempt, short: the live tool answers when the mirror does not, and
// the call's whole budget is 54 s (src/mcp/tools/index.ts).
const SEARCH_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 8_000;
/**
 * What the mirror is asked to spend on one search statement (timeout_ms):
 * less than this client waits, so a query too heavy for the index comes
 * back as a 504 — a refusal of that one query — while the connection is
 * still open. The API's own limit is 12 s: a search that ran 8–12 s used to
 * end here as a timeout, which reads as "the mirror is down" and paused it
 * for every account. An API that predates the parameter ignores it.
 */
export const SEARCH_DEADLINE_MS = 6_000;
/** After a failure the mirror is skipped for this long (every account goes straight live). */
export const MIRROR_PAUSE_MS = 60_000;
/**
 * Searches in a row the mirror gave up on (504) before it is paused like a
 * mirror that is down. One heavy query, or the three variants of one call,
 * stay below it; a mirror that runs out of time on everything (the database
 * busy with something else) would otherwise cost every search its
 * SEARCH_DEADLINE_MS before the live court is asked.
 */
export const SLOW_SEARCH_STREAK = 5;

/**
 * The breaker, per instance: a mirror that failed (home connection down,
 * the laptop asleep, Access refusing) is not asked again for MIRROR_PAUSE_MS,
 * so the accounts switched to it do not each wait out a timeout before
 * their live answer. A 404 (decision not there) is an answer, not a failure.
 *
 * A request that fails while the mirror answered another one in the
 * meantime does not pause it: the mirror is up, and what failed is that one
 * request. caselaw_search sends up to nine searches at once — one of them
 * running out of time used to send the eight that answered, and every other
 * account for a minute, to the live courts.
 */
let pausedUntil = 0;
let pauseReason = "";
/** When the mirror last answered anything (a result, a 404, a refusal). */
let lastAnswerAt = 0;
/** Searches refused for running out of time (504) since the last one that answered. */
let slowSearches = 0;

/**
 * The mirror answered and refused this one call: HTTP 400 (a parameter it
 * cannot read — the message says which) or 504 (this query ran past its
 * statement timeout). The mirror is up, so the breaker stays shut: one
 * unreadable § or one heavy query must not send every account live for a
 * minute.
 */
export class MirrorRefusal extends SourceError {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(
      MIRROR_SOURCE_LABEL,
      status === 400 ? "INPUT_INVALID" : "UPSTREAM_ERROR",
      status === 400 ? `The case-law mirror could not read the request: ${reason}.` : "The case-law mirror ran out of time on this query.",
      status === 400 ? "Correct the parameter and call again." : "Narrow the call (a date range, one court) and call again.",
    );
  }
}

/** Tests only. */
export function resetMirrorBreaker(): void {
  pausedUntil = 0;
  pauseReason = "";
  lastAnswerAt = 0;
  slowSearches = 0;
}

export interface MirrorConfig {
  url: string;
  token: string;
  accessId?: string;
  accessSecret?: string;
}

export function mirrorConfig(env: NodeJS.ProcessEnv = process.env): MirrorConfig | null {
  const url = env.MIRROR_API_URL?.trim().replace(/\/+$/, "");
  const token = env.MIRROR_API_TOKEN?.trim();
  if (!url || !token || !/^https?:\/\//.test(url)) return null;
  const accessId = env.MIRROR_CF_ACCESS_CLIENT_ID?.trim() || undefined;
  const accessSecret = env.MIRROR_CF_ACCESS_CLIENT_SECRET?.trim() || undefined;
  return { url, token, ...(accessId && accessSecret ? { accessId, accessSecret } : {}) };
}

export function mirrorConfigured(): boolean {
  return mirrorConfig() !== null;
}

function headers(config: MirrorConfig): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${config.token}`,
    ...(config.accessId && config.accessSecret
      ? { "cf-access-client-id": config.accessId, "cf-access-client-secret": config.accessSecret }
      : {}),
  };
}

async function getJson<T>(path: string, timeoutMs: number, opts: { probe?: boolean; search?: boolean } = {}): Promise<T | null> {
  if (!opts.probe && Date.now() < pausedUntil) {
    throw new SourceError(
      MIRROR_SOURCE_LABEL,
      "UPSTREAM_UNREACHABLE",
      `The case-law mirror is paused after a failure (${pauseReason}).`,
      "The live court tools answer meanwhile.",
    );
  }
  const startedAt = Date.now();
  try {
    const result = await fetchJson<T>(path, timeoutMs);
    lastAnswerAt = Date.now();
    if (opts.search) slowSearches = 0;
    // A probe that got through ends a pause early.
    if (opts.probe) pausedUntil = 0;
    return result;
  } catch (error) {
    if (error instanceof MirrorRefusal) {
      lastAnswerAt = Date.now();
      // Up, but not answering searches in time: after a few in a row the live courts are quicker.
      if (opts.search && error.status === 504 && ++slowSearches >= SLOW_SEARCH_STREAK) {
        slowSearches = 0;
        pausedUntil = Date.now() + MIRROR_PAUSE_MS;
        pauseReason = `${SLOW_SEARCH_STREAK} searches in a row ran out of time`;
      }
      throw error;
    }
    // The mirror answered another request while this one was open: it is up, this request failed alone.
    if (lastAnswerAt > startedAt) throw error;
    pausedUntil = Date.now() + MIRROR_PAUSE_MS;
    pauseReason = error instanceof Error ? error.message.replace(/^The case-law mirror did not answer: /, "").replace(/\.$/, "") : String(error);
    throw error;
  }
}

async function fetchJson<T>(path: string, timeoutMs: number): Promise<T | null> {
  const config = mirrorConfig();
  if (!config) {
    throw new SourceError(
      MIRROR_SOURCE_LABEL,
      "UPSTREAM_UNREACHABLE",
      "The case-law mirror is not configured on this deployment (MIRROR_API_URL / MIRROR_API_TOKEN).",
      "Use the live court tools.",
    );
  }
  const response = await fetchUpstream(MIRROR_SOURCE_LABEL, `${config.url}${path}`, {
    headers: headers(config),
    timeoutMs,
    retry: false,
    // 400 and 504 are answers about this one call (MirrorRefusal), read below.
    passStatus: (status) => status === 400 || status === 504,
  });
  // A 404 is an answer (no such decision), not the mirror being down.
  if (response.status === 404) return null;
  if (response.status === 400 || response.status === 504) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new MirrorRefusal(response.status, typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("application/json")) {
    // Cloudflare Access answers a missing/wrong service token with its own
    // HTML login page (302/403) — say which lock refused, not "bad JSON".
    const why =
      response.status === 401
        ? "the API refused the bearer token (MIRROR_API_TOKEN)"
        : response.status === 403 || response.redirected || type.includes("text/html")
          ? "Cloudflare Access refused the request (MIRROR_CF_ACCESS_CLIENT_ID / _SECRET)"
          : `HTTP ${response.status}`;
    throw new SourceError(
      MIRROR_SOURCE_LABEL,
      "UPSTREAM_ERROR",
      `The case-law mirror did not answer: ${why}.`,
      "The live court tools still work; an admin switches the source per account on the Správa page.",
    );
  }
  return (await response.json()) as T;
}

export interface MirrorSearchParams {
  q?: string;
  caseNumber?: string;
  sources?: MirrorCourt[];
  from?: string;
  to?: string;
  categories?: string[];
  /** rozhodnuti.justice.cz court codes, any of them; with sources: ["justice"] only. */
  courtCodes?: string[];
  /** rozsudek | usneseni | nalez | stanovisko | jine */
  type?: string;
  /** Several forms at once. */
  types?: string[];
  regional?: boolean;
  sort?: "relevance" | "newest";
  /** With sort "newest": by the decision date (default) or by the day it was put on the web. */
  newestBy?: "decided" | "published";
  /** How bare words combine: every word (default), any word, the words as one phrase. */
  match?: "all" | "any" | "phrase";
  limit?: number;
  /** Hits to skip (paging). */
  offset?: number;
  /** The court's name, a substring (NS database: "Vrchní soud v Praze"). */
  court?: string;
  /** NSS index: nss | rozsireny | krajske | karne. */
  courtClass?: "nss" | "rozsireny" | "krajske" | "karne";
  /** Docket registry: "Afs", "Cdo". */
  registry?: string;
  /** NSS oblast úpravy, a substring. */
  area?: string;
  publishedFrom?: string;
  publishedTo?: string;
  /** The decision's own spisová značka or ECLI (caseNumber also finds the decisions citing it). */
  ownCase?: string;
  /** ÚS: published in a Sbírka only. */
  inCollection?: boolean;
  /** A cited provision: the act ("89/2012", "32016R0679") with an optional provision ("§ 2291"), or one citation the mirror reads ("čl. 6 GDPR"). */
  act?: string;
  provision?: string;
  cite?: string;
}

export interface MirrorHit {
  source: MirrorCourt;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: string | null;
  category: string | null;
  date: string | null;
  published: string | null;
  ecli: string | null;
  url: string;
  score: number;
  excerpt: string;
  highlights: Array<[number, number]>;
  inDissent?: boolean;
  /** Length of the text and how many mirrored decisions cite it — absent from an API that predates them. */
  chars?: number | null;
  citedBy?: number;
}

export interface MirrorSearchResult {
  hits: MirrorHit[];
  channel: "and" | "or" | "ident" | null;
  terms: string[];
  /** How many decisions pass the filters — given for a listing without words. */
  total?: number;
}

function searchQuery(params: MirrorSearchParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.caseNumber?.trim()) qs.set("case", params.caseNumber.trim());
  for (const source of params.sources ?? []) qs.append("source", source);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.categories?.length) qs.set("category", params.categories.join(","));
  if (params.courtCodes?.length) qs.set("court_code", params.courtCodes.join(","));
  const types = [...(params.types ?? []), ...(params.type ? [params.type] : [])];
  if (types.length) qs.set("type", [...new Set(types)].join(","));
  if (params.regional) qs.set("regional", "1");
  if (params.sort) qs.set("sort", params.sort);
  if (params.newestBy) qs.set("newest_by", params.newestBy);
  if (params.match && params.match !== "all") qs.set("match", params.match);
  qs.set("limit", String(Math.min(50, Math.max(1, params.limit ?? 20))));
  if (params.offset) qs.set("offset", String(Math.max(0, Math.floor(params.offset))));
  if (params.court?.trim()) qs.set("court", params.court.trim());
  if (params.courtClass) qs.set("court_class", params.courtClass);
  if (params.registry?.trim()) qs.set("registry", params.registry.trim());
  if (params.area?.trim()) qs.set("area", params.area.trim());
  if (params.publishedFrom) qs.set("published_from", params.publishedFrom);
  if (params.publishedTo) qs.set("published_to", params.publishedTo);
  if (params.ownCase?.trim()) qs.set("own_case", params.ownCase.trim());
  if (params.inCollection) qs.set("collection", "1");
  if (params.cite?.trim()) qs.set("cite", params.cite.trim());
  if (params.act?.trim()) qs.set("act", params.act.trim());
  if (params.provision?.trim()) qs.set("provision", params.provision.trim());
  return qs;
}

export async function searchMirror(params: MirrorSearchParams): Promise<MirrorSearchResult> {
  const qs = searchQuery(params);
  qs.set("timeout_ms", String(SEARCH_DEADLINE_MS));
  const result = await getJson<MirrorSearchResult>(`/v1/search?${qs}`, SEARCH_TIMEOUT_MS, { search: true });
  return result ?? { hits: [], channel: null, terms: [] };
}

export interface MirrorDecision {
  source: MirrorCourt;
  id: string;
  caseNumber: string | null;
  caseNumbers: string[];
  court: string | null;
  form: string | null;
  category: string | null;
  date: string | null;
  published: string | null;
  ecli: string | null;
  legalSentence: string | null;
  url: string;
  goneAt: string | null;
  /** Who cites it, by court (page 1 of the API's answer; absent from an API that predates it). */
  citedBy?: MirrorCitedBySummary;
  /** The whole text, every page joined; null = the mirror has no text. */
  text: string | null;
}

export interface MirrorCitedBySummary {
  total: number;
  bySource: Partial<Record<MirrorCourt, number>>;
  /** Of them: stanoviska, plenum ÚS, velký senát NS, rozšířený senát NSS. */
  top: number;
}

interface DecisionPageJson extends Omit<MirrorDecision, "text"> {
  text: { text: string; page: number; total_pages: number } | null;
}

/** One decision with its whole text (the API pages it by 45k; the pages are fetched in parallel). */
export async function getMirrorDecision(source: MirrorCourt, id: string): Promise<MirrorDecision | null> {
  const base = `/v1/decisions/${source}/${encodeURIComponent(id)}`;
  const first = await getJson<DecisionPageJson>(base, READ_TIMEOUT_MS);
  if (!first) return null;
  const { text: firstPage, ...meta } = first;
  if (!firstPage) return { ...meta, text: null };
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, firstPage.total_pages - 1) }, (_, i) =>
      getJson<DecisionPageJson>(`${base}?page=${i + 2}`, READ_TIMEOUT_MS),
    ),
  );
  return { ...meta, text: [firstPage.text, ...rest.map((page) => page?.text?.text ?? "")].join("") };
}

/** One decision as the links name it (GET /v1/decisions/:source/:id/citations). */
export interface MirrorLinkedDecision {
  source: MirrorCourt;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: string | null;
  date: string | null;
  /** Given by /v1/by-case (absent from an API that predates them, and from citation links). */
  chars?: number | null;
  citedBy?: number;
}

export interface MirrorCitations {
  /** Decisions of another court carrying the same spisová značka (absent when none, and from an API that predates it). */
  sameCaseNumber?: { total: number; decisions: MirrorLinkedDecision[] };
  /** What the decision cites: each cited sp. zn. / ECLI with the mirrored decisions carrying it (none = a court the mirror does not hold). */
  cites: Array<{ key: string; display: string; mentions: number; firstAt: number; decisions: MirrorLinkedDecision[] }>;
  /** Who cites it; `total` counts all, `hits` is the page asked for. bySource, top, order and the excerpts are absent from an API that predates them (then newest first). */
  citedBy: {
    total: number;
    bySource?: Partial<Record<MirrorCourt, number>>;
    top?: number;
    order?: "newest" | "courts";
    hits: Array<MirrorLinkedDecision & { mentions: number; excerpt?: string }>;
  };
}

/** The decisions carrying `caseNumber` (sp. zn. or ECLI) as their own — exact, newest first. */
export async function mirrorDecisionsByCase(caseNumber: string, sources?: MirrorCourt[]): Promise<MirrorLinkedDecision[]> {
  const qs = new URLSearchParams({ case: caseNumber.trim() });
  for (const court of sources ?? []) qs.append("source", court);
  const result = await getJson<{ decisions: MirrorLinkedDecision[] }>(`/v1/by-case?${qs}`, READ_TIMEOUT_MS);
  return result?.decisions ?? [];
}

/** The citation links of one decision; null = the mirror does not hold it. */
export async function getMirrorCitations(
  source: MirrorCourt,
  id: string,
  options: { limit?: number; offset?: number; citedBySources?: MirrorCourt[]; order?: "newest" | "courts" } = {},
): Promise<MirrorCitations | null> {
  const qs = new URLSearchParams();
  if (options.order) qs.set("order", options.order);
  qs.set("limit", String(Math.min(100, Math.max(1, options.limit ?? 20))));
  if (options.offset) qs.set("offset", String(Math.max(0, options.offset)));
  for (const court of options.citedBySources ?? []) qs.append("source", court);
  return getJson<MirrorCitations>(`/v1/decisions/${source}/${encodeURIComponent(id)}/citations?${qs}`, READ_TIMEOUT_MS);
}

export interface MirrorProvisionHit {
  source: MirrorCourt;
  id: string;
  caseNumber: string | null;
  court: string | null;
  form: string | null;
  category: string | null;
  date: string | null;
  url: string;
  /** How often the decision names the provision. */
  mentions: number;
  /** The text around the first citation of it. */
  excerpt: string;
  citedBy?: number;
  chars?: number | null;
}

export interface MirrorProvisionResult {
  act: string;
  provision: string;
  total: number;
  /** Absent from an API that predates the order: newest first. */
  sortedBy?: "newest" | "cited";
  hits: MirrorProvisionHit[];
}

/**
 * The decisions citing one provision (GET /v1/provisions): `act` as "89/2012",
 * `provision` as the user writes it ("§ 2291 odst. 2"). A citation the API
 * cannot parse is a SourceError (HTTP 400) — the caller tells the model.
 */
export async function mirrorProvisions(
  params: (
    | { act: string; provision: string }
    /** A whole citation the API reads itself: "čl. 6 odst. 1 GDPR", "čl. 17 směrnice 2004/48/ES", "§ 2291 o. z.". */
    | { cite: string }
  ) & {
    sources?: MirrorCourt[];
    categories?: string[];
    from?: string;
    to?: string;
    sort?: "newest" | "cited";
    limit?: number;
    offset?: number;
  },
): Promise<MirrorProvisionResult> {
  const qs = new URLSearchParams("cite" in params ? { cite: params.cite.trim() } : { act: params.act.trim(), provision: params.provision.trim() });
  for (const court of params.sources ?? []) qs.append("source", court);
  if (params.categories?.length) qs.set("category", params.categories.join(","));
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.sort) qs.set("sort", params.sort);
  qs.set("limit", String(Math.min(50, Math.max(1, params.limit ?? 20))));
  if (params.offset) qs.set("offset", String(Math.max(0, params.offset)));
  const result = await getJson<MirrorProvisionResult>(`/v1/provisions?${qs}`, SEARCH_TIMEOUT_MS, { search: true });
  return result ?? { act: "act" in params ? params.act : "", provision: "provision" in params ? params.provision : "", total: 0, hits: [] };
}

export interface MirrorStatusJson {
  asOf: string;
  sources?: Array<{
    source: string;
    decisions?: number;
    newestDecidedOn?: string | null;
    lastRun?: { mode?: string; finishedAt?: string | null; error?: string | null } | null;
  }>;
  [key: string]: unknown;
}

export async function mirrorApiStatus(): Promise<MirrorStatusJson | null> {
  // The status page asks even while paused: it is how the operator sees why.
  return getJson<MirrorStatusJson>("/v1/status", 8_000, { probe: true });
}

/** The excerpt with its matches marked «…» (the API sends char ranges). */
export function markedExcerpt(hit: Pick<MirrorHit, "excerpt" | "highlights">): string {
  const ranges = [...(hit.highlights ?? [])].sort((a, b) => b[0] - a[0]);
  let text = hit.excerpt;
  for (const [start, end] of ranges) {
    if (start < 0 || end > text.length || start >= end) continue;
    text = `${text.slice(0, start)}«${text.slice(start, end)}»${text.slice(end)}`;
  }
  return text.replace(/\s+/g, " ").trim();
}
