import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";

/**
 * Client of the home mirror's API v1 (src/mirror/api/server.ts) as Vercel
 * reaches it: through the Cloudflare Tunnel `dawmain-databaze`
 * (docs/infra/proxmox.md), behind Cloudflare Access (service token) and the
 * API's own bearer token. Locally the LAN address works too
 * (MIRROR_API_URL=http://192.168.0.52:8080, no Access headers).
 *
 *   MIRROR_API_URL                   https://dawmain-databaze.davidzavada.cz
 *   MIRROR_API_TOKEN                 the API's bearer token (/etc/mirror/env on `app`)
 *   MIRROR_CF_ACCESS_CLIENT_ID       Access service token `dawmain-vercel`
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
/** After a failure the mirror is skipped for this long (every account goes straight live). */
export const MIRROR_PAUSE_MS = 60_000;

/**
 * The breaker, per instance: a mirror that failed (home connection down,
 * the laptop asleep, Access refusing) is not asked again for MIRROR_PAUSE_MS,
 * so the accounts switched to it do not each wait out a timeout before
 * their live answer. A 404 (decision not there) is an answer, not a failure.
 */
let pausedUntil = 0;
let pauseReason = "";

/** Tests only. */
export function resetMirrorBreaker(): void {
  pausedUntil = 0;
  pauseReason = "";
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

async function getJson<T>(path: string, timeoutMs: number, opts: { probe?: boolean } = {}): Promise<T | null> {
  if (!opts.probe && Date.now() < pausedUntil) {
    throw new SourceError(
      MIRROR_SOURCE_LABEL,
      "UPSTREAM_UNREACHABLE",
      `The case-law mirror is paused after a failure (${pauseReason}).`,
      "The live court tools answer meanwhile.",
    );
  }
  try {
    const result = await fetchJson<T>(path, timeoutMs);
    // A probe that got through ends a pause early.
    if (opts.probe) pausedUntil = 0;
    return result;
  } catch (error) {
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
    // A 404 is an answer (no such decision), not the mirror being down.
    passStatus: () => false,
  });
  if (response.status === 404) return null;
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
  /** rozsudek | usneseni | nalez | stanovisko | jine */
  type?: string;
  regional?: boolean;
  sort?: "relevance" | "newest";
  limit?: number;
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
}

export interface MirrorSearchResult {
  hits: MirrorHit[];
  channel: "and" | "or" | "ident" | null;
  terms: string[];
}

function searchQuery(params: MirrorSearchParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.caseNumber?.trim()) qs.set("case", params.caseNumber.trim());
  for (const source of params.sources ?? []) qs.append("source", source);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.categories?.length) qs.set("category", params.categories.join(","));
  if (params.type) qs.set("type", params.type);
  if (params.regional) qs.set("regional", "1");
  if (params.sort) qs.set("sort", params.sort);
  qs.set("limit", String(Math.min(50, Math.max(1, params.limit ?? 20))));
  return qs;
}

export async function searchMirror(params: MirrorSearchParams): Promise<MirrorSearchResult> {
  const result = await getJson<MirrorSearchResult>(`/v1/search?${searchQuery(params)}`, SEARCH_TIMEOUT_MS);
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
  /** The whole text, every page joined; null = the mirror has no text. */
  text: string | null;
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
