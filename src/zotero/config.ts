import { clerkConfigured } from "@/src/mcp/config";
import { secretsConfigured } from "@/src/secrets/seal";

/**
 * Zotero (zotero.org Web API v3) — one place for the constants every part
 * of the integration shares: the OAuth app, the hosts, the politeness
 * limits and the size caps. Nothing here does I/O.
 *
 * The integration is READ-ONLY by design: the OAuth request asks for a key
 * without write access, and a key that turns out to have it is revoked and
 * refused (src/zotero/web.ts).
 */

/** The string health, errors and logs are keyed on. */
export const SOURCE = "Zotero";

export const API_ORIGIN = "https://api.zotero.org";
export const WWW_ORIGIN = "https://www.zotero.org";

/** OAuth 1.0a endpoints (https://www.zotero.org/support/dev/web_api/v3/oauth). */
export const OAUTH_REQUEST_URL = `${WWW_ORIGIN}/oauth/request`;
export const OAUTH_AUTHORIZE_URL = `${WWW_ORIGIN}/oauth/authorize`;
export const OAUTH_ACCESS_URL = `${WWW_ORIGIN}/oauth/access`;

/**
 * Parameters appended to the authorize URL. They pre-fill Zotero's "new
 * key" form: read the personal library and notes, read all groups, never
 * write. `identity` must NEVER be sent — with it Zotero creates no key and
 * returns the literal "identity" in its place.
 */
export const AUTHORIZE_PARAMS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["name", "Dawmain"],
  ["library_access", "1"],
  ["notes_access", "1"],
  ["write_access", "0"],
  ["all_groups", "read"],
] as const);

/** Honest, contactable, and without "Zotero/" (that marks a sync client at /keys/current). */
export const ZOTERO_UA = "dawmain/0.2 (+https://dawmain.davidzavada.cz)";

/** The name of the short-lived cookie that carries the sealed OAuth request token between /connect and /callback. */
export const STATE_COOKIE = "dz_zotero_oauth";
/** Lifetime of that cookie and of the sealed state inside it. */
export const STATE_TTL_SECONDS = 600;

/** Path the OAuth callback lives at (the cookie is scoped to it). */
export const CALLBACK_PATH = "/api/zotero/callback";

export const LIMITS = Object.freeze({
  /** Per request to api.zotero.org. */
  requestTimeoutMs: 15_000,
  /** Whole tool call (the MCP route has maxDuration 60 s). */
  toolBudgetMs: 45_000,
  /** Concurrent requests per Zotero user per instance (Zotero allows 5, shared with desktop sync). */
  concurrencyPerUser: 3,
  /** Wait out a Backoff header up to this long, otherwise fail fast and say how long. */
  maxBackoffWaitMs: 3_000,
  /** Retry a 429/503 once when Retry-After is at most this long. */
  maxRetryAfterMs: 5_000,
  /** After this many invalid keys on one instance, stop calling Zotero for breakerMs. */
  breakerInvalidKeys: 3,
  breakerMs: 300_000,
  /** Biggest JSON body read from the API. */
  maxJsonBytes: 8 * 1024 * 1024,
  /** PDF fallback: biggest file, most pages and longest conversion. */
  maxPdfBytes: 25 * 1024 * 1024,
  maxPdfPages: 300,
  pdfTimeoutMs: 30_000,
  /** Zotero caps `limit` at 100 and `itemKey` at 50. */
  pageSize: 100,
  maxItemKeys: 50,
  /** Docket-number scan over itemType=case. */
  scanPagesPerLibrary: 5,
  scanPagesTotal: 10,
  /** A scan younger than this is reused without asking Zotero whether the library changed (the case links of the court tools). */
  scanFreshMs: 60_000,
  /** Notes-and-annotations scan (zotero_notes): Zotero's q never reads a note's body or an annotation. */
  notesScanPagesPerLibrary: 10,
  notesScanPagesTotal: 20,
  /** A note is searched in its first this many characters. */
  noteScanChars: 10_000,
  /** Collections one call visits with include_subcollections (the named one included). */
  maxSubcollections: 12,
  /** zotero_cite: items per call (Zotero's itemKey cap). */
  maxCiteItems: 50,
  /** Case links in the court tools: lookups per user per hour (own bucket), and how long a lookup may delay an answer. */
  linkLookupsPerHour: 200,
  linkBudgetMs: 6_000,
  /** Libraries one search visits at most. */
  maxLibrariesPerSearch: 6,
  /** Tool calls per user per hour (own bucket, not the files_* one). */
  toolCallsPerHour: 120,
  /** Connect attempts per user per hour. */
  connectsPerHour: 10,
});

/** Cache lifetimes (per instance, always keyed by the Clerk user id). */
export const CACHE_TTL_MS = Object.freeze({
  connection: 2_000,
  collections: 10 * 60 * 1000,
  groups: 10 * 60 * 1000,
  text: 10 * 60 * 1000,
  caseScan: 10 * 60 * 1000,
  notesScan: 10 * 60 * 1000,
  searches: 10 * 60 * 1000,
});

/**
 * Amazon S3 endpoints in every URL style a signed URL comes in: path style
 * (s3.amazonaws.com, s3.<region>…, s3-<region>…) and virtual-hosted
 * (<bucket>.s3.amazonaws.com, <bucket>.s3.<region>…, <bucket>.s3-<region>…),
 * each optionally dualstack. AWS SDKs sign buckets outside the legacy
 * us-east-1 endpoint in the virtual-hosted regional style.
 */
const S3_HOST_RE = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Hosts a `GET /items/{key}/file` redirect may point to. The API answers
 * with a 302 to a short-lived signed URL on Zotero's S3 storage; the key is
 * never sent there. Anything else is refused. Which bucket and URL style
 * Zotero uses is not verified yet, so any S3 endpoint passes: confirm on a
 * live preview and narrow to that one host.
 */
export function isAllowedStorageHost(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  return S3_HOST_RE.test(url.hostname.toLowerCase());
}

export function clientKey(): string | undefined {
  const value = process.env.ZOTERO_OAUTH_CLIENT_KEY?.trim();
  return value ? value : undefined;
}

export function clientSecret(): string | undefined {
  const value = process.env.ZOTERO_OAUTH_CLIENT_SECRET?.trim();
  return value ? value : undefined;
}

/** Whether this deployment can connect Zotero at all (env only, no I/O). */
export function zoteroConfigured(): boolean {
  return Boolean(clientKey() && clientSecret() && secretsConfigured() && clerkConfigured());
}

/** Zotero object keys: 8 characters from this alphabet (write_requests docs). */
export const ITEM_KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/** zotero_cite's export formats (Zotero's own export formats). */
export const EXPORT_FORMATS = ["ris", "bibtex", "biblatex", "csljson"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A citation style id from zotero.org/styles ("iso690-full-note-cs") and a CSL locale ("cs-CZ"). */
export const STYLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/** Zotero API keys are 24 alphanumerics today; the range leaves room without admitting anything else. */
export const ZOTERO_KEY_RE = /^[A-Za-z0-9]{8,64}$/;
