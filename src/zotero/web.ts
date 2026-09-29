import "server-only";
import { auth } from "@clerk/nextjs/server";
import { getAccess } from "@/src/files/access";
import { sanitizeLine } from "@/src/files/dmd/normalize";
import { errorCode, filesError, filesJson, MESSAGES, NO_STORE_HEADERS } from "@/src/files/errors";
import { allowToolCall, sameOrigin } from "@/src/files/guards";
import { tokenMatches } from "@/src/mcp/config";
import { proRefusal } from "@/src/mcp/pro-caller";
import { SourceError } from "@/src/sources/shared/errors";
import { getKeyInfo, listGroups, revokeKey } from "./client";
import { CALLBACK_PATH, LIMITS, STATE_COOKIE, STATE_TTL_SECONDS, zoteroConfigured } from "./config";
import { ZoteroKeyInvalidError, zoteroBreakerOpen } from "./http";
import { accessToken, authorizeUrl, openState, requestToken, sealState, type AccessGrant, type RequestToken } from "./oauth";
import { deleteConnection, keyFingerprint, loadConnection, markRevoked, saveConnection } from "./store";
import type { ConnectionState, KeyInfo, ZoteroCreds } from "./types";
import type { ZoteroConnectionView, ZoteroStatus, ZoteroStav } from "./web-types";

/**
 * The web side of the Zotero connection — the logic behind the thin route
 * handlers in app/api/zotero/{connect,callback,disconnect,status}; the
 * contract with the modal is ./web-types.ts.
 *
 *   connect     a form POST (a navigation): Origin, configuration, session,
 *               Pro (the Vlastní zdroje entitlement), LIMITS.connectsPerHour
 *               → a temporary token from zotero.org, sealed into a cookie
 *               that only the callback path gets → 303 to zotero.org.
 *   callback    zotero.org sends the browser back: the cookie opens for the
 *               signed-in user and holds the token in the query → the key
 *               → /keys/current: the same Zotero user, the personal library
 *               and NO write access anywhere (a key that can write is revoked
 *               and never stored) → stored sealed; the key it replaces is
 *               revoked.
 *   disconnect  fetch: revoke the key on zotero.org, best effort, and forget it.
 *   status      fetch: what the modal shows — never the key or its fingerprint.
 *
 * The navigations always answer 303: to zotero.org, or back to the modal
 * with a relative Location (/?zotero=1&stav=…), which the browser resolves
 * against the origin it is on — a preview needs no configured site URL.
 * The fetch routes answer no-store JSON with the /api/files messages. Logs
 * carry the step and an opaque code, never a token, a token secret, a
 * verifier or a key.
 */

/** A slow zotero.org must not hold "Odpojit"; the key can still be deleted at zotero.org/settings/keys. */
const DISCONNECT_REVOKE_MS = 5_000;
/** Revoking a key the callback refuses or replaces: the user is waiting on a redirect. */
const CALLBACK_REVOKE_MS = 5_000;
/** Group names are decoration of the status; the modal must not wait for them. */
const GROUP_NAMES_MS = 3_000;
const GROUP_NAME_CHARS = 120;

const STATUS_UNAVAILABLE = "Stav připojení Zotera se teď nepodařilo zjistit. Zkuste to prosím za chvíli.";
const DISCONNECT_UNAVAILABLE = "Zotero se teď nepodařilo odpojit. Zkuste to prosím za chvíli.";

// ---------------------------------------------------------------------------
// Plumbing

/** Where every navigation ends: the Zotero modal, with the outcome for its banner. */
export function backTo(stav: ZoteroStav): string {
  return `/?zotero=1&stav=${stav}`;
}

/**
 * Lax, not Strict: zotero.org sends the browser back with a top-level GET
 * from its own site, which Lax cookies ride on and Strict ones do not. The
 * Path keeps the cookie off every other request of the site.
 */
const STATE_COOKIE_ATTRIBUTES = `Path=${CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax`;

/** Set-Cookie of the sealed OAuth state (the value is "v1.<base64url>", cookie-safe as is). */
export function stateCookie(sealed: string): string {
  return `${STATE_COOKIE}=${sealed}; ${STATE_COOKIE_ATTRIBUTES}; Max-Age=${STATE_TTL_SECONDS}`;
}

/** Set-Cookie that deletes it: the same name and Path, or the browser keeps the original. */
export const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; ${STATE_COOKIE_ATTRIBUTES}; Max-Age=0`;

function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ ...NO_STORE_HEADERS, location });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/**
 * The origin the browser is on, for the OAuth callback: the host sameOrigin
 * checked (x-forwarded-host on Vercel, else Host) — NOT siteOrigin or
 * VERCEL_PROJECT_PRODUCTION_URL. The state cookie is set on this host; on a
 * preview, a callback to the production domain would arrive without it.
 * https except on loopback: the callback URL carries the verifier, and the
 * Secure cookie would not come back over plain http anyway. null for
 * anything but a plain scheme://host[:port]. Pure.
 */
export function publicOrigin(request: Request): string | null {
  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim().toLowerCase() || "";
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const host = first("x-forwarded-host") || first("host") || url.host.toLowerCase();
  const proto = first("x-forwarded-proto") || url.protocol.replace(/:$/, "");
  const origin = `${proto === "http" && LOOPBACK_HOST.test(host) ? "http" : "https"}://${host}`;
  return PLAIN_ORIGIN.test(origin) ? origin : null;
}

/** Every value of the cookie `name` (a browser may send two of one name, e.g. under different paths). */
function cookieValues(request: Request, name: string): string[] {
  const out: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * One log line without secrets. The SourceErrors of src/zotero/* carry
 * only HTTP statuses and OAuth problem codes (never a token, a verifier or
 * a key — oauth.ts and http.ts promise it), and a status is what tells a
 * wrong consumer key from a Zotero outage. Anything else: an opaque code.
 */
function logZoteroError(where: string, error: unknown): void {
  const code = error instanceof SourceError ? `${error.kind}: ${error.message}` : errorCode(error);
  console.error(`zotero: ${where} failed (${code})`);
}

/** The Clerk session's user; null when signed out. Throws when Clerk fails or is not set up. */
async function sessionUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/**
 * Revoke a key on zotero.org, best effort and bounded: Zotero being down,
 * an open breaker or a slow answer must not keep the user from being
 * disconnected or sent back (revokeKey already treats 403/404 as gone).
 */
async function revokeQuietly(creds: ZoteroCreds, where: string, timeoutMs: number): Promise<void> {
  try {
    await revokeKey(creds, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    logZoteroError(where, error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/zotero/connect

/**
 * "Připojit Zotero": 303 to zotero.org's authorize page with Dawmain's
 * fixed read-only permissions (authorizeUrl), the temporary token sealed
 * into the state cookie for this user; any refusal is a 303 back to the
 * modal. Only a cross-site POST gets a 403 (JSON, like /api/files): the
 * page that sent it is not ours to redirect.
 */
export async function connectResponse(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return filesError(403, MESSAGES.badOrigin);
  // Before the session: no sign-in fixes a deployment without the OAuth app
  // or the sealing secret, and without Clerk's keys auth() itself throws.
  if (!zoteroConfigured()) return seeOther(backTo("nedostupne"));
  let userId: string | null;
  try {
    userId = await sessionUserId();
  } catch (error) {
    logZoteroError("connect.auth", error);
    return seeOther(backTo("chyba"));
  }
  if (!userId) return seeOther(backTo("prihlaseni"));
  try {
    // `fresh`: someone who was just granted Pro should not wait out the 60-s access cache.
    if (proRefusal(await getAccess(userId, { fresh: true })) !== null) return seeOther(backTo("nepro"));
  } catch (error) {
    logZoteroError("connect.access", error);
    return seeOther(backTo("chyba"));
  }
  // The callback checks the new key through api.zotero.org; while the
  // invalid-key breaker holds every call there, it could neither check nor
  // revoke it, and zotero.org would keep an orphaned key. Checked before the
  // attempt is counted.
  if (zoteroBreakerOpen()) return seeOther(backTo("chyba"));
  if (!allowToolCall(`zotero-connect:${userId}`, undefined, LIMITS.connectsPerHour)) return seeOther(backTo("limit"));
  const origin = publicOrigin(request);
  if (!origin) return seeOther(backTo("chyba"));
  try {
    const { token, tokenSecret } = await requestToken(origin + CALLBACK_PATH);
    return seeOther(authorizeUrl(token), stateCookie(sealState({ token, tokenSecret, userId })));
  } catch (error) {
    logZoteroError("connect.request", error);
    return seeOther(backTo("chyba"));
  }
}

// ---------------------------------------------------------------------------
// GET /api/zotero/callback

/** The request token of a state cookie that opens for this user, else null. */
function stateFor(request: Request, userId: string): RequestToken | null {
  for (const value of cookieValues(request, STATE_COOKIE)) {
    const state = openState(value, userId);
    if (state) return state;
  }
  return null;
}

/** The callback's answer for `stav`: back to the modal, the state cookie cleared. */
const callbackDone = (stav: ZoteroStav): Response => seeOther(backTo(stav), CLEAR_STATE_COOKIE);

/**
 * zotero.org's redirect back. Every outcome clears the state cookie: a
 * temporary token is exchanged at most once, and whatever went wrong starts
 * over from "Připojit Zotero". That includes an unforeseen throw: it must
 * not become a bare 500 that leaves the cookie (and the user) behind.
 */
export async function callbackResponse(request: Request): Promise<Response> {
  try {
    return await callbackFlow(request);
  } catch (error) {
    logZoteroError("callback", error);
    return callbackDone("chyba");
  }
}

async function callbackFlow(request: Request): Promise<Response> {
  const done = callbackDone;
  if (!zoteroConfigured()) return done("nedostupne");
  let userId: string | null;
  try {
    userId = await sessionUserId();
  } catch (error) {
    logZoteroError("callback.auth", error);
    return done("chyba");
  }
  if (!userId) return done("prihlaseni");
  // A cookie sealed for another account does not open here (its aad names
  // the user who started), exactly like a missing, expired or tampered one.
  const state = stateFor(request, userId);
  if (!state) return done("vyprselo");

  const query = new URL(request.url).searchParams;
  const token = query.get("oauth_token");
  const verifier = query.get("oauth_verifier");
  // The token in the query must be the one this browser was sent to approve
  // — compared in constant time, and before anything goes to zotero.org. A
  // denial may come back without the token; a verifier never may.
  if (token !== null && !tokenMatches(state.token, token)) return done("vyprselo");
  if (!verifier) return done("zamitnuto");
  if (token === null) return done("vyprselo");

  let grant: AccessGrant;
  try {
    grant = await accessToken(state.token, state.tokenSecret, verifier);
  } catch (error) {
    logZoteroError("callback.access", error);
    return done("chyba");
  }
  // From here on zotero.org holds a new key: every refusal revokes it, so
  // nothing Dawmain will never use stays behind in the user's account.
  const creds: ZoteroCreds = { userID: grant.userID, key: grant.key };
  const refuse = async (stav: ZoteroStav, why: string) => {
    await revokeQuietly(creds, `callback.revoke-${why}`, CALLBACK_REVOKE_MS);
    return done(stav);
  };

  let info: KeyInfo;
  try {
    info = await getKeyInfo(grant.key);
  } catch (error) {
    logZoteroError("callback.key", error);
    return refuse("chyba", "unchecked");
  }
  // Not the key this flow asked for: another Zotero user's.
  if (info.userID !== grant.userID) return refuse("chyba", "mismatch");
  // Read-only by design: a key that can write anywhere (the user ticked it
  // on zotero.org's form) is revoked on the spot and never stored. Checked
  // before the library, so such a key always gets the banner that says how
  // to fix it.
  if (info.write) return refuse("zapis", "write");
  // Without the personal library the tools would have nothing to start from.
  if (!info.library) return refuse("chyba", "no-library");

  try {
    const previous: ConnectionState = await loadConnection(userId);
    await saveConnection(userId, {
      userID: grant.userID,
      // /keys/current is the account's current name; the grant's is what it was at approval.
      username: info.username || grant.username,
      key: grant.key,
      notes: info.notes,
      groups: info.groups,
    });
    // Saved first: should the save fail, the old key must still work. A
    // re-approval that returned the same key must not revoke it.
    if (previous.state === "ok" && previous.conn.fp !== keyFingerprint(grant.key)) {
      await revokeQuietly(previous.conn.creds, "callback.revoke-previous", CALLBACK_REVOKE_MS);
    }
  } catch (error) {
    logZoteroError("callback.save", error);
    return refuse("chyba", "unsaved");
  }
  return done("pripojeno");
}

// ---------------------------------------------------------------------------
// POST /api/zotero/disconnect

/**
 * "Odpojit": revoke the key on zotero.org (best effort, DISCONNECT_REVOKE_MS)
 * and forget the connection. Answers { ok: true } whatever Zotero says — the
 * user asked to be disconnected here, and a key Zotero no longer accepts or
 * could not revoke right now is at most left for zotero.org/settings/keys.
 */
export async function disconnectResponse(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return filesError(403, MESSAGES.badOrigin);
  let userId: string | null;
  try {
    userId = await sessionUserId();
  } catch (error) {
    logZoteroError("disconnect.auth", error);
    return filesError(503, DISCONNECT_UNAVAILABLE);
  }
  if (!userId) return filesError(401, MESSAGES.signIn);
  try {
    const stored = await loadConnection(userId);
    // Revoked while the key is still at hand: after the delete nothing here can.
    if (stored.state === "ok") await revokeQuietly(stored.conn.creds, "disconnect.revoke", DISCONNECT_REVOKE_MS);
    // Written in every state, "none" included: a record that is not exactly
    // v1 also reads as "none", and nothing may stay behind.
    await deleteConnection(userId);
    return filesJson({ ok: true });
  } catch (error) {
    logZoteroError("disconnect", error);
    return filesError(503, DISCONNECT_UNAVAILABLE);
  }
}

// ---------------------------------------------------------------------------
// GET /api/zotero/status

function connectionView(conn: Extract<ConnectionState, { state: "ok" }>["conn"]): ZoteroConnectionView {
  return {
    username: conn.username,
    userID: conn.creds.userID,
    connectedAt: conn.connectedAt,
    notes: conn.notes,
    groups: Array.isArray(conn.groups) ? [...conn.groups] : conn.groups,
  };
}

/**
 * What the modal shows for a signed-in user. Only an account that can use
 * the tools (configured, Pro) with group access costs a Zotero request —
 * the group names, best effort within GROUP_NAMES_MS. Should Zotero reject
 * the key there, it is marked revoked (never sent again) and shown so.
 * Clerk failures throw.
 */
export async function statusFor(userId: string): Promise<ZoteroStatus> {
  const configured = zoteroConfigured();
  const [access, stored] = await Promise.all([getAccess(userId), loadConnection(userId)]);
  const pro = proRefusal(access) === null;
  const base = { state: "ok", configured, pro, connection: null, revoked: null, unreadable: null } as const;
  if (stored.state === "none") return base;
  if (stored.state === "revoked") return { ...base, revoked: { username: stored.username, revokedAt: stored.revokedAt } };
  if (stored.state === "unreadable") return { ...base, unreadable: { username: stored.username } };

  const { conn } = stored;
  const connection = connectionView(conn);
  if (!configured || !pro || conn.groups === "none") return { ...base, connection };
  try {
    const groups = await listGroups(conn.creds, conn.groups, { signal: AbortSignal.timeout(GROUP_NAMES_MS) });
    connection.groupNames = groups.map((g) => sanitizeLine(g.name, GROUP_NAME_CHARS));
  } catch (error) {
    if (error instanceof ZoteroKeyInvalidError) {
      try {
        await markRevoked(userId, conn.fp);
      } catch (markError) {
        logZoteroError("status.mark-revoked", markError);
      }
      return { ...base, revoked: { username: conn.username, revokedAt: new Date().toISOString() } };
    }
    logZoteroError("status.groups", error);
  }
  return { ...base, connection };
}

/**
 * The status as a Response. Signed out is a normal answer here
 * ({ state: "signed_out" }), not an error, like /api/files/summary.
 */
export async function statusResponse(): Promise<Response> {
  let userId: string | null;
  try {
    userId = await sessionUserId();
  } catch (error) {
    logZoteroError("status.auth", error);
    return filesError(503, STATUS_UNAVAILABLE);
  }
  if (!userId) return filesJson({ state: "signed_out" } satisfies ZoteroStatus);
  try {
    return filesJson(await statusFor(userId));
  } catch (error) {
    logZoteroError("status", error);
    return filesError(503, STATUS_UNAVAILABLE);
  }
}
