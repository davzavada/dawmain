import "server-only";
import { USER_ID_RE } from "@/src/files/config";
import { openSecret, sealSecret } from "@/src/secrets/seal";
import { SourceError } from "@/src/sources/shared/errors";
import {
  AUTHORIZE_PARAMS,
  LIMITS,
  OAUTH_ACCESS_URL,
  OAUTH_AUTHORIZE_URL,
  OAUTH_REQUEST_URL,
  SOURCE,
  STATE_TTL_SECONDS,
  ZOTERO_KEY_RE,
  ZOTERO_UA,
  clientKey,
  clientSecret,
} from "./config";
import { oauthHeader, parseForm } from "./oauth1";

/**
 * The three-legged OAuth 1.0a flow against www.zotero.org, whose only
 * product is an API key (https://www.zotero.org/support/dev/web_api/v3/oauth):
 *
 *   1. requestToken(callback)  — POST /oauth/request, signed with the
 *      consumer secret; a temporary token + secret come back;
 *   2. authorizeUrl(token)     — the user approves Dawmain's fixed, read-only
 *      permissions on zotero.org and is sent back with a verifier;
 *   3. accessToken(…, verifier) — POST /oauth/access, signed with both
 *      secrets; the API key comes back as `oauth_token_secret`.
 *
 * Between 1 and 3 the temporary token and its secret wait in a short-lived
 * cookie, sealed and bound to the Clerk user (sealState / openState), so a
 * callback can finish only the connection the same account started.
 *
 * Nothing here logs, and no error message carries a token, a secret, a
 * verifier or the key — only HTTP statuses and OAuth problem codes.
 */

/** Temporary credentials from step 1. */
export interface RequestToken {
  token: string;
  tokenSecret: string;
}

/** What step 3 yields: the API key and whose it is. */
export interface AccessGrant {
  key: string;
  userID: number;
  username: string;
}

/** Defined in ./config, which ./store shares without importing the OAuth flow; re-exported for this module's callers. */
export { ZOTERO_KEY_RE };
/** Request tokens and verifiers are opaque; this admits hex, base64 and base64url and nothing that needs escaping. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,256}$/;
/** Zotero user ids: positive integers (kept within Number's exact range). */
const USER_ID_NUM_RE = /^[1-9][0-9]{0,15}$/;
/** The token endpoints answer a few hundred bytes; anything much larger is not an OAuth answer. */
const MAX_FORM_BYTES = 16 * 1024;
/** A sealed state is ~250 characters; a cookie value far beyond that is not ours. */
const MAX_STATE_CHARS = 2_048;
const MAX_USERNAME_CHARS = 255;

type Step = "request" | "access";

const STEP_LABEL: Record<Step, string> = {
  request: "requesting a temporary OAuth token",
  access: "exchanging the authorization for an API key",
};

const HINTS = {
  unreachable: "zotero.org did not respond. Try connecting Zotero again in a minute.",
  request:
    "zotero.org refused to start the connection. Try again later; if it keeps failing, check the OAuth app's client key, secret and callback URL at zotero.org/oauth/apps.",
  access: "The authorization expired, was already used or was denied. Start connecting Zotero again.",
  drift:
    "zotero.org answered the OAuth step in an unexpected format. Try again later; if it keeps failing, the OAuth flow changed and src/zotero/oauth.ts needs updating.",
} as const;

function consumer(): { key: string; secret: string } {
  const key = clientKey();
  const secret = clientSecret();
  if (!key || !secret) {
    throw new Error("ZOTERO_OAUTH_CLIENT_KEY and ZOTERO_OAUTH_CLIENT_SECRET must both be set — Zotero cannot be connected.");
  }
  return { key, secret };
}

function drift(step: Step, what: string): SourceError {
  return new SourceError(SOURCE, "PARSE_DRIFT", `${SOURCE}: ${STEP_LABEL[step]} returned ${what}.`, HINTS.drift);
}

/** A log-safe label for a network failure — the error's name, never its text. */
function failureLabel(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.name;
  return "network error";
}

/**
 * The body, as text, when it is at most `max` bytes; null when larger.
 * Read chunk by chunk so an oversized answer is cut off without being
 * buffered whole.
 */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Why a token endpoint refused, safe to put in an error message: an OAuth
 * `oauth_problem` code, or a short plain-English sentence ("Invalid
 * signature"). A single word is never echoed — it could be a token.
 */
function refusalReason(body: string | null): string | null {
  if (!body) return null;
  const problem = parseForm(body).oauth_problem;
  if (problem && /^[a-z_]{1,40}$/.test(problem)) return problem;
  const text = body.trim();
  return /^[A-Za-z][A-Za-z .'-]{0,59}$/.test(text) && text.includes(" ") ? text : null;
}

/**
 * One signed POST to a token endpoint, answered by a form body. Redirects
 * are not followed: a token endpoint that redirects is not answering, and a
 * followed redirect would replay the signed Authorization header elsewhere.
 */
async function postSigned(step: Step, url: string, authorization: string): Promise<Record<string, string>> {
  let response: Response;
  let body: string | null;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization, "user-agent": ZOTERO_UA, accept: "application/x-www-form-urlencoded, text/plain" },
      redirect: "manual",
      signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
    });
    body = await readCapped(response, MAX_FORM_BYTES);
  } catch (error) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_UNREACHABLE",
      `${SOURCE}: ${STEP_LABEL[step]} did not complete (${failureLabel(error)}).`,
      HINTS.unreachable,
    );
  }
  if (response.status < 200 || response.status > 299) {
    const reason = refusalReason(body);
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `${SOURCE}: ${STEP_LABEL[step]} failed (HTTP ${response.status}${reason ? `, ${reason}` : ""}).`,
      step === "request" ? HINTS.request : HINTS.access,
    );
  }
  if (body === null) throw drift(step, "an oversized answer");
  return parseForm(body);
}

/**
 * Step 1: a temporary token for `callbackUrl` (our /api/zotero/callback on
 * the origin the user is on). `oauth_callback_confirmed=true` is required —
 * without it the server ignored the callback (OAuth 1.0 without the 1.0a
 * fix) and the verifier would never come back to us.
 */
export async function requestToken(callbackUrl: string): Promise<RequestToken> {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error("The Zotero OAuth callback must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The Zotero OAuth callback must be an http(s) URL.");
  }
  const { key, secret } = consumer();
  const authorization = oauthHeader({
    method: "POST",
    url: OAUTH_REQUEST_URL,
    consumerKey: key,
    consumerSecret: secret,
    extra: { oauth_callback: callbackUrl },
  });
  const form = await postSigned("request", OAUTH_REQUEST_URL, authorization);
  if (form.oauth_callback_confirmed !== "true") throw drift("request", "no oauth_callback_confirmed=true");
  const token = form.oauth_token;
  const tokenSecret = form.oauth_token_secret;
  if (!token || !TOKEN_RE.test(token) || !tokenSecret || !TOKEN_RE.test(tokenSecret)) {
    throw drift("request", "no usable token");
  }
  return { token, tokenSecret };
}

/**
 * Step 2: where to send the user. The permissions are fixed in
 * AUTHORIZE_PARAMS (read-only, notes, all groups) and appended in that
 * order. `identity` is refused outright: with it Zotero creates no key at
 * all and answers the literal "identity" in its place.
 */
export function authorizeUrl(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("Malformed Zotero OAuth request token.");
  if (AUTHORIZE_PARAMS.some(([name]) => name.toLowerCase() === "identity")) {
    throw new Error("AUTHORIZE_PARAMS must never ask for `identity` — Zotero would create no key.");
  }
  const query = new URLSearchParams([["oauth_token", token], ...AUTHORIZE_PARAMS.map(([n, v]): [string, string] => [n, v])]);
  return `${OAUTH_AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Step 3: trade the approved temporary token for the API key. Zotero
 * returns the key as `oauth_token_secret` (and repeats it as
 * `oauth_token`) together with the numeric user id and the username.
 * An answer without a real key — "identity", or anything that is not a key
 * — is drift, never stored.
 */
export async function accessToken(token: string, tokenSecret: string, verifier: string): Promise<AccessGrant> {
  if (!TOKEN_RE.test(token) || !TOKEN_RE.test(tokenSecret)) throw new Error("Malformed Zotero OAuth request token.");
  if (!TOKEN_RE.test(verifier)) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `${SOURCE}: the authorization came back with a malformed verifier.`,
      HINTS.access,
    );
  }
  const { key: consumerKey, secret: consumerSecret } = consumer();
  const authorization = oauthHeader({
    method: "POST",
    url: OAUTH_ACCESS_URL,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
    extra: { oauth_verifier: verifier },
  });
  const form = await postSigned("access", OAUTH_ACCESS_URL, authorization);
  const key = form.oauth_token_secret;
  if (!key || key.toLowerCase() === "identity" || !ZOTERO_KEY_RE.test(key)) throw drift("access", "no API key");
  const rawUserID = form.userID;
  const userID = rawUserID && USER_ID_NUM_RE.test(rawUserID) ? Number(rawUserID) : NaN;
  if (!Number.isSafeInteger(userID) || userID <= 0) throw drift("access", "no valid userID");
  // Display only (the numeric id is what the API uses); a missing username
  // must not throw away a key zotero.org has already created.
  const username = (form.username ?? "").trim().slice(0, MAX_USERNAME_CHARS);
  return { key, userID, username };
}

// ---------------------------------------------------------------------------
// The state cookie between /connect and /callback

interface StatePayload {
  /** Request token. */
  t: string;
  /** Request token secret. */
  s: string;
  /** Clerk user id that started the connection. */
  u: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

function stateAad(userId: string): string {
  return `state:${userId}`;
}

/**
 * The request token and its secret, sealed for the cookie: the secret must
 * not reach the browser in the clear, and the aad binds the blob to the
 * Clerk user so a cookie planted in another account's browser does not
 * open there (login CSRF). Expires STATE_TTL_SECONDS after `now`.
 */
export function sealState(input: { token: string; tokenSecret: string; userId: string; now?: number }): string {
  if (!USER_ID_RE.test(input.userId)) throw new Error("invalid user id");
  const payload: StatePayload = {
    t: input.token,
    s: input.tokenSecret,
    u: input.userId,
    exp: (input.now ?? Date.now()) + STATE_TTL_SECONDS * 1000,
  };
  return sealSecret(JSON.stringify(payload), "zotero-oauth-state-v1", stateAad(input.userId));
}

/**
 * The request token back from the cookie — or null for anything that is
 * not a live state of this user: a missing, foreign, tampered, expired or
 * malformed value, or a deployment whose CREDENTIALS_SECRET changed. Never
 * throws: every failure means the same thing to the callback ("start
 * again").
 */
export function openState(value: string | null | undefined, userId: string, now: number = Date.now()): RequestToken | null {
  if (typeof value !== "string" || value.length > MAX_STATE_CHARS || !USER_ID_RE.test(userId)) return null;
  try {
    const parsed: unknown = JSON.parse(openSecret(value, "zotero-oauth-state-v1", stateAad(userId)));
    if (!parsed || typeof parsed !== "object") return null;
    const { t, s, u, exp } = parsed as Partial<Record<keyof StatePayload, unknown>>;
    if (typeof t !== "string" || !TOKEN_RE.test(t) || typeof s !== "string" || !TOKEN_RE.test(s)) return null;
    // The aad already binds the user; the payload says so too, independently.
    if (u !== userId) return null;
    if (typeof exp !== "number" || !Number.isFinite(exp) || now >= exp) return null;
    return { token: t, tokenSecret: s };
  } catch {
    return null;
  }
}
