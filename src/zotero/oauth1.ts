import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a request signing (RFC 5849), HMAC-SHA1 only — the one flavour
 * zotero.org speaks. Pure: node:crypto and string handling, no I/O. Written
 * here rather than taken from npm because the maintained Zotero client is
 * AGPL and the generic OAuth packages are larger than the ~100 lines this
 * needs.
 *
 * Zotero uses OAuth only to hand out an API key (the three-legged dance in
 * oauth.ts); every later API call carries that key in a header, unsigned.
 */

/** RFC 3986 unreserved characters — the only ones left unencoded (RFC 5849 §3.6). */
function unreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}

/**
 * RFC 3986 percent-encoding over the UTF-8 bytes, uppercase hex. Not
 * encodeURIComponent: that leaves ! ' ( ) * alone (a signature mismatch the
 * server reports only as "invalid signature") and throws on a lone
 * surrogate, which Buffer turns into U+FFFD instead.
 */
export function percentEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    out += unreserved(byte) ? String.fromCharCode(byte) : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * The base string URI (RFC 5849 §3.4.1.2): lowercase scheme and host, the
 * port only when it is not the scheme's default, the path, and never the
 * query or fragment. WHATWG URL already lowercases and drops default ports.
 */
function baseUri(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname || "/"}`;
}

/**
 * Signature base string (RFC 5849 §3.4.1): METHOD & base URI & normalized
 * parameters. The URL's own query parameters are signed too (§3.4.1.3.1);
 * every name and value is encoded first and the pairs are sorted by encoded
 * name, then encoded value (§3.4.1.3.2), so the input order never matters.
 * `oauth_signature` itself is never part of what it signs.
 */
export function baseString(method: string, url: string, params: Array<[string, string]>): string {
  const parsed = new URL(url);
  const all: Array<[string, string]> = [...parsed.searchParams, ...params];
  const normalized = all
    .filter(([name]) => name !== "oauth_signature")
    .map(([name, value]): [string, string] => [percentEncode(name), percentEncode(value)])
    .sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return [method.toUpperCase(), percentEncode(baseUri(parsed)), percentEncode(normalized)].join("&");
}

/** HMAC-SHA1 signature (RFC 5849 §3.4.2): key = encoded consumer secret & encoded token secret; base64 result. */
export function hmacSha1(base: string, consumerSecret: string, tokenSecret = ""): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(base, "utf8").digest("base64");
}

export interface OAuthHeaderInput {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  /** The request token (access step) — absent when asking for one. */
  token?: string;
  tokenSecret?: string;
  /** The per-step protocol parameters: oauth_callback (request), oauth_verifier (access). */
  extra?: Partial<Record<"oauth_callback" | "oauth_verifier", string>>;
  /** application/x-www-form-urlencoded body parameters, which are signed too. */
  bodyParams?: Array<[string, string]>;
  /** Fixed values for test vectors; random / current by default. */
  nonce?: string;
  timestamp?: number | string;
}

/**
 * The full `Authorization` header value for one signed request: every
 * oauth_* parameter (including the signature) percent-encoded and quoted,
 * in name order so the header is deterministic for a given input.
 */
export function oauthHeader(input: OAuthHeaderInput): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  if (input.token !== undefined) oauth.oauth_token = input.token;
  for (const [name, value] of Object.entries(input.extra ?? {})) {
    if (value !== undefined) oauth[name] = value;
  }
  const base = baseString(input.method, input.url, [...Object.entries(oauth), ...(input.bodyParams ?? [])]);
  oauth.oauth_signature = hmacSha1(base, input.consumerSecret, input.tokenSecret ?? "");
  const fields = Object.keys(oauth)
    .sort()
    .map((name) => `${percentEncode(name)}="${percentEncode(oauth[name])}"`);
  return `OAuth ${fields.join(", ")}`;
}

/**
 * An application/x-www-form-urlencoded body (what /oauth/request and
 * /oauth/access answer with) as a plain record. The first occurrence of a
 * repeated name wins — a later duplicate must not override a value that
 * was already checked. The record has no prototype, so a `__proto__` or
 * `constructor` field is just a field.
 */
export function parseForm(body: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [name, value] of new URLSearchParams(body.trim())) {
    if (!Object.hasOwn(out, name)) out[name] = value;
  }
  return out;
}
