import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SourceError } from "./shared/errors";
import { fetchUpstream } from "./shared/http";
import { htmlToText, looksLikeHtml } from "./shared/html";
import { DOCUMENT_TTL_MS, SEARCH_TTL_MS, TtlCache, memoKey } from "./shared/cache";
import { getUnpaywallEmail } from "../mcp/config";

/**
 * Full texts of the literature — the layer that lets the doctrine tools READ
 * a work instead of only listing it.
 *
 * Two public services carry the open-access part without any library login:
 * Unpaywall (api.unpaywall.org — the OA-location index the WorldCat
 * Discovery SPA itself consults per DOI, seen in the capture) and the DOI
 * resolver (doi.org). What they point at — a repository PDF, an OA
 * monograph on the publisher's site — is fetched here, PDF text extracted
 * with unpdf (the same call the former EUIPO client made), HTML reduced to
 * text. A landing page that turns out to be a login or purchase wall is
 * reported as such, not returned as if it were the work.
 *
 * Every fetched address is public and reached by HTTPS: the guard below
 * refuses private and link-local ranges on EVERY redirect hop, because a
 * document fetcher that follows arbitrary links from catalogue records is
 * otherwise a proxy into the deployment's own network.
 */

export const SOURCE = "plné texty (Unpaywall/DOI)";
const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 25_000;
/** A text shorter than this from an HTML page is a landing/login page, not a work. */
const MIN_HTML_TEXT_CHARS = 2_500;

// ---------- Unpaywall ----------

export interface OaLocation {
  url: string;
  pdfUrl?: string;
  landingUrl?: string;
  license?: string;
  version?: string;
  hostType?: string;
}

export interface OaResolution {
  doi: string;
  isOa: boolean;
  /** gold | hybrid | bronze | green | closed */
  status?: string;
  best?: OaLocation;
  locations: OaLocation[];
  title?: string;
  journal?: string;
  year?: number;
}

type Rec = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function location(value: unknown): OaLocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const loc = value as Rec;
  const url = str(loc.url) ?? str(loc.url_for_pdf) ?? str(loc.url_for_landing_page);
  if (!url) return undefined;
  return {
    url,
    pdfUrl: str(loc.url_for_pdf),
    landingUrl: str(loc.url_for_landing_page),
    license: str(loc.license),
    version: str(loc.version),
    hostType: str(loc.host_type),
  };
}

/** Unpaywall's per-DOI record → resolution. Field names verbatim from the
 * captured responses (tests/fixtures/unpaywall). PARSE_DRIFT without the
 * one boolean every record carries. Pure — unit-tested. */
export function parseUnpaywall(json: unknown): OaResolution {
  const body = (json ?? {}) as Rec;
  if (typeof body.is_oa !== "boolean" || typeof body.doi !== "string") {
    throw new SourceError(
      SOURCE,
      "PARSE_DRIFT",
      "Unpaywall answered without is_oa/doi.",
      "The API may have changed or refused the request (it needs the email parameter) — check UNPAYWALL_EMAIL and run dawmain_probe_sources (canary 'unpaywall').",
    );
  }
  const locations: OaLocation[] = [];
  if (Array.isArray(body.oa_locations)) {
    for (const entry of body.oa_locations) {
      const loc = location(entry);
      if (loc) locations.push(loc);
    }
  }
  return {
    doi: body.doi,
    isOa: body.is_oa,
    status: str(body.oa_status),
    best: location(body.best_oa_location),
    locations,
    title: str(body.title),
    journal: str(body.journal_name),
    year: typeof body.year === "number" ? body.year : undefined,
  };
}

const oaCache = new TtlCache<OaResolution>(SEARCH_TTL_MS);

/** Normalise "https://doi.org/10.1/x", "doi:10.1/x", "10.1/x" → "10.1/x". Pure. */
export function normalizeDoi(raw: string): string | null {
  const trimmed = raw.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return /^10\.\d{4,9}\/\S+$/i.test(trimmed) ? trimmed : null;
}

export async function resolveOpenAccess(doi: string): Promise<OaResolution> {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `"${doi}" is not a DOI.`, "Pass a DOI like 10.1163/9789004724822.");
  }
  return oaCache.through(memoKey("unpaywall", normalized), async () => {
    const url = `${UNPAYWALL_BASE}/${encodeURIComponent(normalized)}?email=${encodeURIComponent(getUnpaywallEmail())}`;
    const response = await fetchUpstream(SOURCE, url, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      return { doi: normalized, isOa: false, locations: [] };
    }
    if (!response.ok) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `Unpaywall answered HTTP ${response.status}.`,
        "Try again in a minute; the DOI itself can still be opened at https://doi.org/" + normalized,
      );
    }
    return parseUnpaywall(await response.json());
  });
}

// ---------- public-address guard ----------

/** RFC 1918/4193/3927 and friends — nothing here is a publisher. Pure. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return false; // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

/** HTTPS, a real hostname, every resolved address public. Throws otherwise. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(SOURCE, "INPUT_INVALID", `"${raw}" is not a valid absolute URL.`, "Pass the access link of a hit, or a DOI.");
  }
  if (url.protocol !== "https:") {
    throw new SourceError(SOURCE, "INPUT_INVALID", `Only https URLs are fetched (got ${url.protocol}).`, "Use the https link of the record.");
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host) || !host.includes(".") || /\.(local|localhost|internal|arpa|home)$/.test(host) || host === "localhost") {
    throw new SourceError(SOURCE, "INPUT_INVALID", `Host ${host} is not a public site.`, "Only public publisher and repository sites are fetched.");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SourceError(SOURCE, "UPSTREAM_UNREACHABLE", `Host ${host} does not resolve.`, "The link may be dead — open the record and try another access link.");
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `Host ${host} resolves to a non-public address.`, "Only public publisher and repository sites are fetched.");
  }
  return url;
}

// ---------- document fetch + extraction ----------

export interface FetchedDocument {
  /** The address asked for. */
  url: string;
  /** Where the redirects ended. */
  finalUrl: string;
  kind: "pdf" | "html";
  text: string;
  pages?: number;
}

/** Words a login/purchase wall shows instead of the work. Pure. */
export function looksLikeAccessWall(text: string): boolean {
  const head = text.slice(0, 4_000).toLowerCase();
  return /\b(sign in|log in|login|přihlásit|přihlášení|institutional access|access denied|purchase|buy this|subscribe|get access|add to cart|403 forbidden)\b/.test(head);
}

const documentCache = new TtlCache<FetchedDocument>(DOCUMENT_TTL_MS, 20);

export async function fetchDocumentText(rawUrl: string): Promise<FetchedDocument> {
  return documentCache.through(memoKey("fulltext-doc", rawUrl), () => downloadDocument(rawUrl));
}

async function downloadDocument(rawUrl: string): Promise<FetchedDocument> {
  let url = await assertPublicUrl(rawUrl);
  let response: Response | undefined;
  for (let hop = 0; ; hop++) {
    response = await fetchUpstream(SOURCE, url.href, {
      headers: { accept: "application/pdf, text/html;q=0.9, */*;q=0.5", "accept-language": "en,cs;q=0.8" },
      redirect: "manual",
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const target = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !target) break;
    if (hop >= MAX_REDIRECTS) {
      throw new SourceError(SOURCE, "UPSTREAM_ERROR", `Too many redirects from ${rawUrl}.`, "Open the link in a browser instead.");
    }
    // Every hop passes the same guard — a redirect is a link like any other.
    url = await assertPublicUrl(new URL(target, url).href);
  }
  if (response.status === 401 || response.status === 403) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `${url.hostname} refused the document (HTTP ${response.status}) — it sits behind a login or licence wall.`,
      "This is not an open-access copy. The record's abstract and contents are still there to orient by; the work itself needs the library's reader login, which this server does not hold.",
    );
  }
  if (!response.ok) {
    throw new SourceError(SOURCE, "UPSTREAM_ERROR", `${url.hostname} answered HTTP ${response.status}.`, "The link may be dead — try another access link of the record, or the DOI.");
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const buffer = new Uint8Array(await response.arrayBuffer());
  const isPdf = contentType.includes("application/pdf") || (buffer.length >= 4 && String.fromCharCode(...buffer.slice(0, 4)) === "%PDF");
  if (isPdf) {
    const { extractText } = await import("unpdf");
    const { totalPages, text } = await extractText(buffer, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : text).replace(/[ \t]+\n/g, "\n").trim();
    if (!merged) {
      throw new SourceError(SOURCE, "NOT_FOUND", "The PDF contains no extractable text (probably a scan).", `Open it directly: ${url.href}`);
    }
    return { url: rawUrl, finalUrl: url.href, kind: "pdf", text: merged, pages: totalPages };
  }
  const body = new TextDecoder("utf-8").decode(buffer);
  if (!contentType.includes("html") && !looksLikeHtml(body)) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `${url.hostname} returned ${contentType || "an unknown format"}, not a PDF or an HTML page.`,
      "Try another access link of the record.",
    );
  }
  const text = htmlToText(body);
  if (text.length < MIN_HTML_TEXT_CHARS || (text.length < 20_000 && looksLikeAccessWall(text))) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `${url.hostname} served a landing or login page (${text.length} characters of text), not the work.`,
      "This is not an open-access copy. Orient by the record's abstract and contents; the work itself needs the library's reader login, which this server does not hold.",
    );
  }
  return { url: rawUrl, finalUrl: url.href, kind: "html", text };
}

// ---------- candidate order ----------

export interface TextCandidate {
  url: string;
  /** Why this address is worth a try — shown to the reader when it fails. */
  reason: string;
}

/**
 * Where to look for a readable copy, best first: an explicit link, the OA
 * copy Unpaywall names (PDF before landing page), then the DOI, then the
 * record's own access links — proxied library links (idm.oclc.org, ezproxy,
 * linker2.worldcat.org) last, since without the reader's login they can only
 * bounce to a sign-in page. Deduplicated. Pure — unit-tested.
 */
export function orderCandidates(input: {
  url?: string;
  doi?: string;
  oa?: OaResolution;
  links?: string[];
}): TextCandidate[] {
  const out: TextCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | undefined, reason: string) => {
    if (!url || !/^https:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, reason });
  };
  push(input.url, "the link you passed");
  if (input.oa?.isOa) {
    push(input.oa.best?.pdfUrl, `open-access PDF (Unpaywall, ${input.oa.status ?? "oa"}${input.oa.best?.license ? `, ${input.oa.best.license}` : ""})`);
    push(input.oa.best?.landingUrl ?? input.oa.best?.url, "open-access copy (Unpaywall)");
    for (const loc of input.oa.locations) {
      push(loc.pdfUrl, `open-access PDF (${loc.hostType ?? "repository"})`);
    }
  }
  const doi = input.doi ? normalizeDoi(input.doi) : null;
  if (doi) push(`https://doi.org/${doi}`, "the DOI (publisher's page)");
  const proxied: string[] = [];
  for (const link of input.links ?? []) {
    if (/idm\.oclc\.org|ezproxy|linker2\.worldcat\.org|openurl/i.test(link)) proxied.push(link);
    else push(link.replace(/^http:\/\//i, "https://"), "access link of the record");
  }
  for (const link of proxied) push(link, "library-proxied link (needs the reader's login)");
  return out;
}
