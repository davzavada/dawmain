import "server-only";
import { auth } from "@clerk/nextjs/server";
import { getAccess } from "@/src/files/access";
import { sanitizeLine } from "@/src/files/dmd/normalize";
import { errorCode, filesError, filesJson, MESSAGES, NO_STORE_HEADERS } from "@/src/files/errors";
import { allowToolCall, sameOrigin } from "@/src/files/guards";
import { clerkConfigured, tokenMatches } from "@/src/mcp/config";
import { proRefusal } from "@/src/mcp/pro-caller";
import { forwardedHostTrusted } from "@/src/runtime";
import { SourceError } from "@/src/sources/shared/errors";
import { getKeyInfo, listGroups, revokeKey, searchItems } from "./client";
import { CALLBACK_PATH, LIMITS, STATE_COOKIE, STATE_TTL_SECONDS, zoteroConfigured, type ZoteroMode } from "./config";
import { ZoteroKeyInvalidError, zoteroBreakerOpen } from "./http";
import { accessToken, authorizeUrl, openState, requestToken, sealState, type AccessGrant, type OpenedState } from "./oauth";
import { deleteConnection, keyFingerprint, LIBRARY_REF_RE, loadConnection, markRevoked, saveConnection, saveDisabledLibraries } from "./store";
import type { ConnectionState, KeyInfo, ZoteroCreds } from "./types";
import type { ZoteroConnectionView, ZoteroLibrariesAnswer, ZoteroLibraryView, ZoteroStatus, ZoteroStav } from "./web-types";

/**
 * The web side of the Zotero connection — the logic behind the thin route
 * handlers in app/api/zotero/{connect,callback,disconnect,status}; the
 * contract with the modal is ./web-types.ts.
 *
 *   connect     a form POST (a navigation) carrying mode=read|write: Origin,
 *               configuration, session, Pro (the Vlastní zdroje
 *               entitlement), LIMITS.connectsPerHour → a temporary token
 *               from zotero.org, sealed with the mode into a cookie that
 *               only the callback path gets → 303 to zotero.org, asking for
 *               write access to the personal library only in "write" mode.
 *   callback    zotero.org sends the browser back: the cookie opens for the
 *               signed-in user and holds the token in the query → the key
 *               → /keys/current: the same Zotero user and the personal
 *               library → stored sealed with its effective mode ("write"
 *               only when chosen AND the key may write to the personal
 *               library; a key with more rights than chosen is kept and
 *               simply never used to write); the key it replaces is revoked.
 *   disconnect  fetch: revoke the key on zotero.org, best effort, and forget it.
 *   status      fetch: what the page shows — never the key or its fingerprint.
 *   libraries   fetch: GET the personal library and the readable groups,
 *               each with its switch (on for the assistant, or off); POST
 *               { library, on } flips one switch — at least one stays on.
 *
 * The navigations always answer 303: to zotero.org, or back to the /zotero
 * page with a relative Location (/zotero?stav=…), which the browser resolves
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

/** Where every navigation ends: the /zotero page, with the outcome for its banner. */
export function backTo(stav: ZoteroStav): string {
  return `/zotero?stav=${stav}`;
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
 * checked (x-forwarded-host where trusted, else Host) — NOT siteOrigin or
 * the production URL. The state cookie is set on this host; on another
 * host (a test instance, localhost), a callback to the production domain
 * would arrive without it.
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
  const trusted = forwardedHostTrusted();
  const host = (trusted && first("x-forwarded-host")) || first("host") || url.host.toLowerCase();
  const proto = (trusted && first("x-forwarded-proto")) || url.protocol.replace(/:$/, "");
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

/** Bound on the connect form's body: it carries one short field. */
const MAX_CONNECT_BODY_CHARS = 1_024;

/**
 * The mode the connect form chose: "write" only when the form says exactly
 * that; a missing, unknown or unreadable body is "read" — the narrower
 * permission is what a malformed request gets.
 */
export async function connectMode(request: Request): Promise<ZoteroMode> {
  try {
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return "read";
    const body = await request.text();
    if (body.length > MAX_CONNECT_BODY_CHARS) return "read";
    return new URLSearchParams(body).get("mode") === "write" ? "write" : "read";
  } catch {
    return "read";
  }
}

/**
 * "Připojit Zotero": 303 to zotero.org's authorize page with Dawmain's
 * fixed permissions for the chosen mode (authorizeUrl), the temporary
 * token and the mode sealed into the state cookie for this user; any
 * refusal is a 303 back to the modal. Only a cross-site POST gets a 403
 * (JSON, like /api/files): the page that sent it is not ours to redirect.
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
    if (proRefusal(await getAccess(userId, { fresh: true }), "zotero") !== null) return seeOther(backTo("nepro"));
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
  const mode = await connectMode(request);
  try {
    const { token, tokenSecret } = await requestToken(origin + CALLBACK_PATH);
    return seeOther(authorizeUrl(token, mode), stateCookie(sealState({ token, tokenSecret, userId, mode })));
  } catch (error) {
    logZoteroError("connect.request", error);
    return seeOther(backTo("chyba"));
  }
}

// ---------------------------------------------------------------------------
// GET /api/zotero/callback

/** The request token (and mode) of a state cookie that opens for this user, else null. */
function stateFor(request: Request, userId: string): OpenedState | null {
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
  // Without the personal library the tools would have nothing to start from.
  if (!info.library) return refuse("chyba", "no-library");
  // The user may have changed the permissions on zotero.org's form. Writing
  // needs both: the user chose it here, and the key may write to the
  // personal library. Anything else is "read" — a key that can write more
  // than chosen (in the library or a group) is kept, and nothing ever writes
  // with it; a "write" choice whose key cannot write is shown as "jen čtení".
  const mode: ZoteroMode = state.mode === "write" && info.userWrite ? "write" : "read";

  try {
    const previous: ConnectionState = await loadConnection(userId);
    // The libraries switched off stay off across a reconnect of the same Zotero account (a new choice of mode).
    const keepOff = previous.state === "ok" && previous.conn.creds.userID === grant.userID ? previous.conn.disabled : [];
    await saveConnection(userId, {
      userID: grant.userID,
      // /keys/current is the account's current name; the grant's is what it was at approval.
      username: info.username || grant.username,
      key: grant.key,
      notes: info.notes,
      groups: info.groups,
      mode,
      keyWrite: info.userWrite,
      ...(keepOff.length ? { disabled: [...keepOff] } : {}),
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
    mode: conn.mode,
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
  const pro = proRefusal(access, "zotero") === null;
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
  // Without Clerk nobody can be signed in: say so instead of a 503 from auth().
  if (!clerkConfigured()) return filesJson({ state: "signed_out" } satisfies ZoteroStatus);
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

// ---------------------------------------------------------------------------
// GET / POST /api/zotero/libraries

/** The library list is the page's main content: a little more patience than for the status's group names. */
const LIBRARIES_MS = 6_000;
const LIBRARIES_UNAVAILABLE = "Knihovny Zotera se teď nepodařilo načíst. Zkuste to prosím za chvíli.";
const TOGGLE_UNAVAILABLE = "Změnu se teď nepodařilo uložit. Zkuste to prosím za chvíli.";
const NOT_CONNECTED = "Zotero není připojené.";
const NO_PRO = "Zotero jde používat jen v režimu Pro.";
const NOT_CONFIGURED = "Připojení Zotera není na tomto webu zapnuté.";
const LAST_ON = "Aspoň jedna knihovna musí zůstat zapnutá. Když asistent nemá v Zoteru hledat vůbec, Zotero odpojte.";
const UNKNOWN_LIBRARY = "Tuhle knihovnu připojený klíč nečte. Načtěte stránku znovu.";
const STALE = "Připojení Zotera se mezitím změnilo. Načtěte stránku znovu.";
/** Bound on the toggle's body: one short JSON object. */
const MAX_TOGGLE_BODY_CHARS = 512;

type Conn = Extract<ConnectionState, { state: "ok" }>["conn"];

/** A refusal of the library routes: status and the Czech message. */
class LibrariesRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The signed-in user's usable connection: configured, Pro, connected —
 * else a LibrariesRefusal. Clerk failures throw as they are.
 */
async function usableConnection(): Promise<{ userId: string; conn: Conn }> {
  if (!clerkConfigured() || !zoteroConfigured()) throw new LibrariesRefusal(404, NOT_CONFIGURED);
  const userId = await sessionUserId();
  if (!userId) throw new LibrariesRefusal(401, MESSAGES.signIn);
  const [access, stored] = await Promise.all([getAccess(userId), loadConnection(userId)]);
  if (proRefusal(access, "zotero") !== null) throw new LibrariesRefusal(403, NO_PRO);
  if (stored.state !== "ok") throw new LibrariesRefusal(409, NOT_CONNECTED);
  return { userId, conn: stored.conn };
}

/**
 * Every library the key reads, personal first, with its switch and item
 * count (best effort: the personal library's from the Total-Results of a
 * one-item page, a group's from Zotero's own meta.numItems). Should the
 * groups not list, `groupsFailed` says so and only the personal library
 * comes back. A rejected key throws ZoteroKeyInvalidError.
 */
export async function librariesFor(conn: Conn): Promise<ZoteroLibrariesAnswer> {
  const io = { signal: AbortSignal.timeout(LIBRARIES_MS) };
  const off = new Set(conn.disabled);
  const [count, groups] = await Promise.all([
    searchItems(conn.creds, { type: "user", id: conn.creds.userID }, { limit: 1, start: 0 }, io).then(
      (r) => r.paging.total,
      (error: unknown) => {
        if (error instanceof ZoteroKeyInvalidError) throw error;
        logZoteroError("libraries.count", error);
        return null;
      },
    ),
    conn.groups === "none"
      ? Promise.resolve([])
      : listGroups(conn.creds, conn.groups, io).catch((error: unknown) => {
          if (error instanceof ZoteroKeyInvalidError) throw error;
          logZoteroError("libraries.groups", error);
          return null;
        }),
  ]);
  const libraries: ZoteroLibraryView[] = [
    { id: "personal", kind: "personal", name: "Moje knihovna", items: count, on: !off.has("personal"), saves: conn.mode === "write" },
    ...(groups ?? []).map(
      (g): ZoteroLibraryView => ({
        id: String(g.id),
        kind: "group",
        name: sanitizeLine(g.name, GROUP_NAME_CHARS) || `Skupina ${g.id}`,
        items: g.numItems,
        on: !off.has(String(g.id)),
        saves: false,
      }),
    ),
  ];
  return { libraries, groupsFailed: groups === null, mode: conn.mode };
}

/** A rejected key on the way: mark it revoked (never sent again) and answer as not connected. */
async function libraryFailure(error: unknown, where: string, unavailable: string, ctx: { userId: string; conn: Conn } | null): Promise<Response> {
  if (error instanceof LibrariesRefusal) return filesError(error.status, error.message);
  if (error instanceof ZoteroKeyInvalidError && ctx) {
    try {
      await markRevoked(ctx.userId, ctx.conn.fp);
    } catch (markError) {
      logZoteroError(`${where}.mark-revoked`, markError);
    }
    return filesError(409, "Klíč k Zoteru přestal platit. Připojte Zotero znovu.");
  }
  logZoteroError(where, error);
  return filesError(503, unavailable);
}

/** GET /api/zotero/libraries → ZoteroLibrariesAnswer. */
export async function librariesResponse(): Promise<Response> {
  let ctx: { userId: string; conn: Conn } | null = null;
  try {
    ctx = await usableConnection();
    return filesJson(await librariesFor(ctx.conn));
  } catch (error) {
    return libraryFailure(error, "libraries", LIBRARIES_UNAVAILABLE, ctx);
  }
}

/** The toggle's body: { library: "personal" | "<group id>", on: boolean }, else null. */
export async function toggleInput(request: Request): Promise<{ library: string; on: boolean } | null> {
  try {
    if (!(request.headers.get("content-type")?.toLowerCase() ?? "").startsWith("application/json")) return null;
    const text = await request.text();
    if (text.length > MAX_TOGGLE_BODY_CHARS) return null;
    const body = JSON.parse(text) as { library?: unknown; on?: unknown } | null;
    if (!body || typeof body !== "object") return null;
    if (typeof body.library !== "string" || !LIBRARY_REF_RE.test(body.library) || typeof body.on !== "boolean") return null;
    return { library: body.library, on: body.on };
  } catch {
    return null;
  }
}

/**
 * The switched-off set after flipping one library, over the libraries the
 * key reads now (`known`, personal included); refs the key no longer reads
 * are dropped. A LibrariesRefusal for a library not in `known`, or when
 * nothing would stay on. Pure.
 */
export function nextDisabled(current: readonly string[], known: readonly string[], library: string, on: boolean): string[] {
  if (!known.includes(library)) throw new LibrariesRefusal(404, UNKNOWN_LIBRARY);
  const off = new Set(current.filter((ref) => known.includes(ref)));
  if (on) off.delete(library);
  else off.add(library);
  if (known.every((ref) => off.has(ref))) throw new LibrariesRefusal(409, LAST_ON);
  return [...off];
}

/**
 * POST /api/zotero/libraries { library, on } → the list as GET answers it,
 * after the switch is stored. Same-origin only. The groups must list (a
 * group the key no longer reads cannot be switched, and "at least one
 * stays on" counts over what the key reads now).
 */
export async function toggleLibraryResponse(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return filesError(403, MESSAGES.badOrigin);
  const input = await toggleInput(request);
  if (!input) return filesError(400, MESSAGES.badRequest);
  let ctx: { userId: string; conn: Conn } | null = null;
  try {
    ctx = await usableConnection();
    const { conn, userId } = ctx;
    const before = await librariesFor(conn);
    if (before.groupsFailed) throw new LibrariesRefusal(503, LIBRARIES_UNAVAILABLE);
    const known = before.libraries.map((l) => l.id);
    // The flip applies to the list as stored now (re-read by the store), not to `conn` from before the Zotero requests.
    let disabled: string[] = [];
    const flip = (current: readonly string[]) => (disabled = nextDisabled(current, known, input.library, input.on));
    if (!(await saveDisabledLibraries(userId, conn.fp, flip))) throw new LibrariesRefusal(409, STALE);
    const off = new Set(disabled);
    return filesJson({ ...before, libraries: before.libraries.map((l) => ({ ...l, on: !off.has(l.id) })) } satisfies ZoteroLibrariesAnswer);
  } catch (error) {
    return libraryFailure(error, "libraries.toggle", TOGGLE_UNAVAILABLE, ctx);
  }
}
