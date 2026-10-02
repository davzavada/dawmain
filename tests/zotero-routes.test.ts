import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * The Zotero web routes (app/api/zotero/{connect,callback,disconnect,status},
 * logic in src/zotero/web.ts), called directly with Request objects.
 *
 * Clerk is mocked: auth() returns the session user, and the backend client
 * is an in-memory user table that merges privateMetadata the way
 * updateUserMetadata does (RFC 7396: null deletes). The store, the OAuth
 * flow, the sealing and the API client are the real modules; the store's
 * writes are spied on. zotero.org is unreachable from the test container,
 * so fetch is a router answering www.zotero.org/oauth/* and api.zotero.org
 * with forms and JSON built from the documentation
 * (tests/fixtures/zotero/*.json; replace with live captures when available).
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({ users: { getUser: mocks.getUser, updateUserMetadata: mocks.updateUserMetadata } }),
}));
vi.mock("@/src/zotero/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/zotero/store")>();
  return {
    ...actual,
    saveConnection: vi.fn(actual.saveConnection),
    markRevoked: vi.fn(actual.markRevoked),
    deleteConnection: vi.fn(actual.deleteConnection),
  };
});

import { GET as callbackGET } from "@/app/api/zotero/callback/route";
import { POST as connectPOST } from "@/app/api/zotero/connect/route";
import { POST as disconnectPOST } from "@/app/api/zotero/disconnect/route";
import { GET as statusGET } from "@/app/api/zotero/status/route";
import { __setAccessLoaderForTests, buildAccess, type Access } from "@/src/files/access";
import { __resetGuardsForTests } from "@/src/files/guards";
import { personalProCaller, proRefusal } from "@/src/mcp/pro-caller";
import { __resetZoteroClientForTests } from "@/src/zotero/client";
import {
  API_ORIGIN,
  CALLBACK_PATH,
  LIMITS,
  OAUTH_ACCESS_URL,
  OAUTH_AUTHORIZE_URL,
  OAUTH_REQUEST_URL,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
} from "@/src/zotero/config";
import { __resetZoteroHttpForTests } from "@/src/zotero/http";
import { openState, sealState } from "@/src/zotero/oauth";
import {
  __resetZoteroStoreForTests,
  deleteConnection,
  keyFingerprint,
  loadConnection,
  markRevoked,
  saveConnection,
} from "@/src/zotero/store";
import { ZOTERO_STAV, type ZoteroStatus } from "@/src/zotero/web-types";

// ---------------------------------------------------------------------------
// Fixtures

const USER = "user_2abcDEF123";
const OTHER = "user_2zyxWVU987";
const NO_PRO = "user_2noPRO456";
const BANNED = "user_2banned789";

const CLIENT_KEY = "ck0123456789abcdef";
const CLIENT_SECRET = "cs-very-secret-consumer-9876";
const REQUEST_TOKEN = "1d4ab1b7c5dda2a5a3f1";
const REQUEST_SECRET = "c6d5d3b1c5aa7b6e9f00";
const VERIFIER = "8e4b5c6d7a1f2e3d";
/** The key the grant (and the /keys/current fixtures) carry. */
const API_KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const OLD_KEY = "Q8MjGpzKfYa3cYOwwvRQEXte";
const ZOTERO_USER = 475425;
const SECRETS = [CLIENT_SECRET, REQUEST_SECRET, VERIFIER, API_KEY, OLD_KEY];

/** A preview deployment: the request's own host, not the production domain. */
const PREVIEW_HOST = "dawmain-git-zotero-cloud-dz.vercel.app";
const ORIGIN = `https://${PREVIEW_HOST}`;
const PRODUCTION_HOST = "dawmain.davidzavada.cz";

const DIR = path.resolve(import.meta.dirname, "fixtures/zotero");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const form = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/x-www-form-urlencoded" } });

const ENV: Record<string, string> = {
  ZOTERO_OAUTH_CLIENT_KEY: CLIENT_KEY,
  ZOTERO_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  CREDENTIALS_SECRET: "a-test-secret-of-sufficient-length",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
  CLERK_SECRET_KEY: "sk_test_routes",
  VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION_HOST,
};

const ACCESS: Record<string, Access> = {
  [USER]: buildAccess({ id: USER, publicMetadata: { pro: true } }, []),
  [OTHER]: buildAccess({ id: OTHER, publicMetadata: { pro: true } }, []),
  [NO_PRO]: buildAccess({ id: NO_PRO, publicMetadata: {} }, []),
  [BANNED]: buildAccess({ id: BANNED, banned: true, publicMetadata: { pro: true } }, []),
};

// ---------------------------------------------------------------------------
// In-memory Clerk

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** Clerk's metadata deep merge (RFC 7396): objects merge, everything else replaces, null deletes. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete out[name];
    else out[name] = mergePatch(out[name], value);
  }
  return out;
}

let users: Map<string, Json>;
const storedRecord = (userId = USER) => users.get(userId)?.zotero as Json | undefined;
const signedIn = (userId: string | null) => mocks.auth.mockResolvedValue({ userId });

// ---------------------------------------------------------------------------
// zotero.org, stubbed

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

type Answer = () => Response | Promise<Response>;

/** What each endpoint answers; tests replace entries. A factory, so every call gets a fresh body. */
let zotero: { request: Answer; access: Answer; keyInfo: Answer; revoke: Answer; groups: Answer };
let calls: Call[];

function defaultZotero(): typeof zotero {
  return {
    request: () => form(`oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=true`),
    access: () => form(`oauth_token=${API_KEY}&oauth_token_secret=${API_KEY}&userID=${ZOTERO_USER}&username=name-at-approval`),
    keyInfo: () => json(fixture("keys-current.json")),
    revoke: () => new Response(null, { status: 204 }),
    groups: () => json(fixture("groups.json")),
  };
}

function route(call: Call): Answer {
  if (call.url === OAUTH_REQUEST_URL && call.method === "POST") return zotero.request;
  if (call.url === OAUTH_ACCESS_URL && call.method === "POST") return zotero.access;
  if (call.url === `${API_ORIGIN}/keys/current`) return call.method === "DELETE" ? zotero.revoke : zotero.keyInfo;
  if (call.url.startsWith(`${API_ORIGIN}/users/${ZOTERO_USER}/groups`)) return zotero.groups;
  throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
}

const callsTo = (url: string, method?: string) => calls.filter((c) => c.url === url && (!method || c.method === method));
const revokedKeys = () => callsTo(`${API_ORIGIN}/keys/current`, "DELETE").map((c) => c.headers.get("zotero-api-key"));

/** The decoded fields of an OAuth Authorization header. */
function oauthFields(header: string | null): Record<string, string> {
  expect(header?.startsWith("OAuth ")).toBe(true);
  const out: Record<string, string> = {};
  for (const part of header!.slice(6).split(", ")) {
    const match = /^([a-z_]+)="([A-Za-z0-9%._~-]*)"$/.exec(part);
    expect(match, `malformed header field: ${part}`).not.toBeNull();
    out[match![1]] = decodeURIComponent(match![2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Requests and responses

const SAME_ORIGIN_HEADERS: Record<string, string> = {
  origin: ORIGIN,
  host: PREVIEW_HOST,
  "x-forwarded-host": PREVIEW_HOST,
  "x-forwarded-proto": "https",
  "sec-fetch-site": "same-origin",
};

/** The modal's form POST; `mode` is what the radio cards chose (undefined: no body at all). */
const connectRequest = (headers: Record<string, string> = SAME_ORIGIN_HEADERS, mode?: string) =>
  new Request(`${ORIGIN}/api/zotero/connect`, {
    method: "POST",
    headers: mode === undefined ? headers : { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: mode === undefined ? undefined : new URLSearchParams({ mode }).toString(),
  });

const disconnectRequest = (headers: Record<string, string> = SAME_ORIGIN_HEADERS) =>
  new Request(`${ORIGIN}/api/zotero/disconnect`, { method: "POST", headers });

function callbackRequest(query: Record<string, string>, cookie?: string): Request {
  const url = new URL(CALLBACK_PATH, ORIGIN);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers: Record<string, string> = { host: PREVIEW_HOST, "x-forwarded-host": PREVIEW_HOST, "sec-fetch-site": "cross-site" };
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request(url, { headers });
}

/** The Cookie header a browser sends back for a state sealed for `userId`. */
const stateCookieFor = (userId = USER, token = REQUEST_TOKEN, tokenSecret = REQUEST_SECRET, mode: "read" | "write" = "read") =>
  `__session=clerk-session; ${STATE_COOKIE}=${sealState({ token, tokenSecret, userId, mode })}`;

const APPROVED = { oauth_token: REQUEST_TOKEN, oauth_verifier: VERIFIER };

/** The `stav` of a 303 back to the modal (the Location is relative: the browser stays on its origin). */
function stavOf(res: Response): string | null {
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location).toMatch(/^\/\?zotero=1&stav=[a-z]+$/);
  const stav = new URLSearchParams(location.slice(2)).get("stav");
  expect(ZOTERO_STAV).toContain(stav);
  return stav;
}

const setCookies = (res: Response) => res.headers.getSetCookie();

/** The Set-Cookie attributes, lower-cased, name → value ("" for flags). */
function cookieAttributes(header: string): { name: string; value: string; attrs: Map<string, string> } {
  const [pair, ...rest] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const attrs = new Map<string, string>();
  for (const attr of rest) {
    const i = attr.indexOf("=");
    attrs.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? "" : attr.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

function expectStateCookieCleared(res: Response): void {
  const cookies = setCookies(res);
  expect(cookies).toHaveLength(1);
  const { name, value, attrs } = cookieAttributes(cookies[0]);
  expect(name).toBe(STATE_COOKIE);
  expect(value).toBe("");
  expect(attrs.get("max-age")).toBe("0");
  // The same Path as when it was set, or the browser keeps the original.
  expect(attrs.get("path")).toBe(CALLBACK_PATH);
}

async function connected(key = API_KEY, groups: "all" | "none" | number[] = "all", mode: "read" | "write" = "read"): Promise<void> {
  await saveConnection(USER, { userID: ZOTERO_USER, username: "zuser", key, notes: true, groups, mode, keyWrite: mode === "write" });
  vi.mocked(saveConnection).mockClear();
  mocks.updateUserMetadata.mockClear();
}

// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};
let logs: MockInstance<typeof console.error>;

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  __resetGuardsForTests();
  __resetZoteroHttpForTests();
  __resetZoteroClientForTests();
  __resetZoteroStoreForTests();
  __setAccessLoaderForTests(async (userId) => ACCESS[userId] ?? buildAccess({ id: userId }, []));
  vi.clearAllMocks();

  users = new Map([
    [USER, { unrelated: { keep: true } }],
    [OTHER, {}],
    [NO_PRO, {}],
    [BANNED, {}],
  ]);
  mocks.getUser.mockImplementation(async (userId: string) => {
    const meta = users.get(userId);
    if (!meta) throw Object.assign(new Error("Clerk 404"), { code: "api_response_error", status: 404 });
    return { id: userId, privateMetadata: structuredClone(meta) };
  });
  mocks.updateUserMetadata.mockImplementation(async (userId: string, params: { privateMetadata: Json }) => {
    const meta = users.get(userId);
    if (!meta) throw Object.assign(new Error("Clerk 404"), { code: "api_response_error", status: 404 });
    users.set(userId, mergePatch(meta, params.privateMetadata) as Json);
    return { id: userId };
  });
  signedIn(USER);

  zotero = defaultZotero();
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers) };
    calls.push(call);
    return route(call)();
  });
  logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Whatever a test did, no log line carries a secret, a token secret, a verifier or a key.
  const logged = JSON.stringify(logs.mock.calls);
  for (const secret of SECRETS) expect(logged).not.toContain(secret);
  logs.mockRestore();
  vi.unstubAllGlobals();
  __setAccessLoaderForTests(null);
  for (const name of Object.keys(ENV)) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

// ---------------------------------------------------------------------------

describe("proRefusal — the website and the MCP gate agree on Pro", () => {
  it("gives personalProCaller's reason for every kind of account", async () => {
    const team = buildAccess({ id: USER, publicMetadata: {} }, [
      { role: "org:member", organization: { id: "org_team", name: "Tým", slug: "tym", publicMetadata: { pro: true } } },
    ]);
    const lapsedTeam = buildAccess({ id: USER, publicMetadata: {} }, [
      { role: "org:member", organization: { id: "org_team", name: "Tým", slug: "tym", publicMetadata: {} } },
    ]);
    // Clerk's feature switches (publicMetadata.features): Zotero follows its own, not Vlastní zdroje's.
    const zoteroOff = buildAccess({ id: USER, publicMetadata: { pro: true, features: { zotero: false } } }, []);
    const teamZoteroOff = buildAccess({ id: USER, publicMetadata: {} }, [
      { role: "org:member", organization: { id: "org_team", name: "Tým", slug: "tym", publicMetadata: { pro: true, features: { zotero: false } } } },
    ]);
    const filesOff = buildAccess({ id: USER, publicMetadata: { pro: true, features: { files: false } } }, []);
    const cases: Array<[Access, ReturnType<typeof proRefusal>]> = [
      [ACCESS[USER], null],
      [team, null],
      [lapsedTeam, "no-pro"],
      [zoteroOff, "no-pro"],
      [teamZoteroOff, "no-pro"],
      [filesOff, null],
      [ACCESS[NO_PRO], "no-pro"],
      [ACCESS[BANNED], "banned"],
    ];
    for (const [access, expected] of cases) {
      expect(proRefusal(access, "zotero")).toBe(expected);
      __setAccessLoaderForTests(async () => access);
      const ctx = { http: { authInfo: { token: "t", clientId: "client_abc", scopes: [], extra: { userId: access.userId } } } };
      const mcp = await personalProCaller(ctx, "zotero");
      expect(mcp.ok ? null : mcp.reason).toBe(expected);
    }
  });
});

describe("POST /api/zotero/connect", () => {
  it("refuses a request without Origin, or from another site, with 403 before anything else", async () => {
    const { origin: _origin, ...noOrigin } = SAME_ORIGIN_HEADERS;
    for (const headers of [noOrigin, { ...SAME_ORIGIN_HEADERS, origin: "https://evil.example" }, { ...SAME_ORIGIN_HEADERS, "sec-fetch-site": "cross-site" }]) {
      const res = await connectPOST(connectRequest(headers));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Požadavek nepřišel z tohoto webu." });
      expect(setCookies(res)).toEqual([]);
    }
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("without a mode (or an odd one): zotero.org's authorize page with the fixed read permissions and no identity", async () => {
    const res = await connectPOST(connectRequest());
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location.startsWith(`${OAUTH_AUTHORIZE_URL}?`)).toBe(true);
    expect(location.startsWith("https://www.zotero.org/oauth/authorize?")).toBe(true);
    const params = new URL(location).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      oauth_token: REQUEST_TOKEN,
      name: "Dawmain",
      library_access: "1",
      notes_access: "1",
      write_access: "0",
      all_groups: "read",
    });
    expect([...params.keys()].map((k) => k.toLowerCase())).not.toContain("identity");
    expect(location).not.toContain(REQUEST_SECRET);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    for (const odd of ["read", "WRITE", "write ", ""]) {
      const again = await connectPOST(connectRequest(SAME_ORIGIN_HEADERS, odd));
      expect(new URL(again.headers.get("location")!).searchParams.get("write_access"), odd).toBe("0");
    }
  });

  it("mode=write asks for write access to the personal library (groups stay read) and seals the mode into the state", async () => {
    const res = await connectPOST(connectRequest(SAME_ORIGIN_HEADERS, "write"));
    const params = new URL(res.headers.get("location")!).searchParams;
    expect(params.get("write_access")).toBe("1");
    expect(params.get("all_groups")).toBe("read");
    const cookie = cookieAttributes(setCookies(res)[0]);
    expect(openState(cookie.value, USER)).toMatchObject({ token: REQUEST_TOKEN, mode: "write" });
    // A read connect seals read.
    const read = await connectPOST(connectRequest(SAME_ORIGIN_HEADERS, "read"));
    expect(openState(cookieAttributes(setCookies(read)[0]).value, USER)).toMatchObject({ mode: "read" });
  });

  it("asks zotero.org to call back on the request's own origin (a preview), not the production domain", async () => {
    await connectPOST(connectRequest());
    const [request] = callsTo(OAUTH_REQUEST_URL, "POST");
    expect(request).toBeDefined();
    expect(oauthFields(request.headers.get("authorization")).oauth_callback).toBe(`https://${PREVIEW_HOST}/api/zotero/callback`);
    expect(request.headers.get("authorization")).not.toContain(PRODUCTION_HOST);
  });

  it("takes the public host from x-forwarded-host, and never an http callback for a public host", async () => {
    const headers = {
      origin: "https://dawmain.example",
      host: "internal.lambda",
      "x-forwarded-host": "dawmain.example",
      "x-forwarded-proto": "http",
    };
    await connectPOST(connectRequest(headers));
    expect(oauthFields(callsTo(OAUTH_REQUEST_URL)[0].headers.get("authorization")).oauth_callback).toBe("https://dawmain.example/api/zotero/callback");
  });

  it("allows an http callback on localhost (next dev)", async () => {
    await connectPOST(new Request("http://localhost:3000/api/zotero/connect", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000" } }));
    expect(oauthFields(callsTo(OAUTH_REQUEST_URL)[0].headers.get("authorization")).oauth_callback).toBe("http://localhost:3000/api/zotero/callback");
  });

  it("sets the sealed state cookie: HttpOnly, Secure, SameSite=Lax, only on the callback path, for 10 minutes", async () => {
    const res = await connectPOST(connectRequest());
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const { name, value, attrs } = cookieAttributes(cookies[0]);
    expect(name).toBe(STATE_COOKIE);
    expect(attrs.has("httponly")).toBe(true);
    expect(attrs.has("secure")).toBe(true);
    expect(attrs.get("samesite")).toBe("Lax");
    expect(attrs.get("path")).toBe(CALLBACK_PATH);
    expect(attrs.get("max-age")).toBe(String(STATE_TTL_SECONDS));
    expect(attrs.has("domain")).toBe(false);
    // Sealed: neither the token secret nor the token in the clear, and it opens only for this user.
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(cookies[0]).not.toContain(REQUEST_SECRET);
    expect(cookies[0]).not.toContain(REQUEST_TOKEN);
    expect(openState(value, USER)).toEqual({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, mode: "read" });
    expect(openState(value, OTHER)).toBeNull();
  });

  it("sends a signed-out visitor back with stav=prihlaseni, and never calls zotero.org", async () => {
    signedIn(null);
    const res = await connectPOST(connectRequest());
    expect(stavOf(res)).toBe("prihlaseni");
    expect(setCookies(res)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("answers stav=nedostupne on a deployment without the OAuth app or the sealing secret", async () => {
    for (const missing of ["ZOTERO_OAUTH_CLIENT_KEY", "ZOTERO_OAUTH_CLIENT_SECRET", "CREDENTIALS_SECRET", "CLERK_SECRET_KEY"]) {
      const saved = process.env[missing];
      delete process.env[missing];
      const res = await connectPOST(connectRequest());
      expect(stavOf(res)).toBe("nedostupne");
      expect(setCookies(res)).toEqual([]);
      process.env[missing] = saved;
    }
    expect(calls).toEqual([]);
  });

  it("answers stav=nepro without a Pro library, banned or not", async () => {
    for (const user of [NO_PRO, BANNED]) {
      signedIn(user);
      const res = await connectPOST(connectRequest());
      expect(stavOf(res)).toBe("nepro");
      expect(setCookies(res)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it(`answers stav=limit after ${LIMITS.connectsPerHour} attempts in an hour, per user`, async () => {
    for (let i = 0; i < LIMITS.connectsPerHour; i++) expect((await connectPOST(connectRequest())).status).toBe(303);
    expect(callsTo(OAUTH_REQUEST_URL)).toHaveLength(LIMITS.connectsPerHour);
    const res = await connectPOST(connectRequest());
    expect(stavOf(res)).toBe("limit");
    expect(setCookies(res)).toEqual([]);
    expect(callsTo(OAUTH_REQUEST_URL)).toHaveLength(LIMITS.connectsPerHour);
    // Another account has its own bucket.
    signedIn(OTHER);
    expect(new URL((await connectPOST(connectRequest())).headers.get("location")!).origin).toBe("https://www.zotero.org");
  });

  it("answers stav=chyba when zotero.org fails, refuses or cannot be reached, or Clerk fails", async () => {
    const failures: Answer[] = [
      () => form("oauth_problem=signature_invalid", 401),
      () => new Response("down", { status: 503 }),
      () => form(`oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`), // no oauth_callback_confirmed
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const failure of failures) {
      zotero.request = failure;
      const res = await connectPOST(connectRequest());
      expect(stavOf(res)).toBe("chyba");
      expect(setCookies(res)).toEqual([]);
    }
    mocks.auth.mockRejectedValueOnce(new Error("clerk down"));
    expect(stavOf(await connectPOST(connectRequest()))).toBe("chyba");
    __setAccessLoaderForTests(async () => {
      throw Object.assign(new Error("Clerk 500"), { code: "api_response_error", status: 500 });
    });
    expect(stavOf(await connectPOST(connectRequest()))).toBe("chyba");
  });
});

describe("GET /api/zotero/callback", () => {
  it("answers stav=vyprselo without the state cookie, and clears it anyway", async () => {
    const res = await callbackGET(callbackRequest(APPROVED));
    expect(stavOf(res)).toBe("vyprselo");
    expectStateCookieCleared(res);
    expect(calls).toEqual([]);
  });

  it("answers stav=prihlaseni when signed out, without calling zotero.org", async () => {
    signedIn(null);
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
    expect(stavOf(res)).toBe("prihlaseni");
    expectStateCookieCleared(res);
    expect(calls).toEqual([]);
  });

  it("never exchanges a state another account started (login CSRF)", async () => {
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor(OTHER)));
    expect(stavOf(res)).toBe("vyprselo");
    expectStateCookieCleared(res);
    expect(calls).toEqual([]);
    expect(vi.mocked(saveConnection)).not.toHaveBeenCalled();
  });

  it("never exchanges when the token in the query is not the one in the cookie", async () => {
    for (const token of ["0d4ab1b7c5dda2a5a3f1", `${REQUEST_TOKEN}x`, ""]) {
      const res = await callbackGET(callbackRequest({ oauth_token: token, oauth_verifier: VERIFIER }, stateCookieFor()));
      expect(stavOf(res)).toBe("vyprselo");
      expectStateCookieCleared(res);
    }
    // A verifier without the token it belongs to.
    expect(stavOf(await callbackGET(callbackRequest({ oauth_verifier: VERIFIER }, stateCookieFor())))).toBe("vyprselo");
    expect(calls).toEqual([]);
  });

  it("answers stav=vyprselo for an expired or tampered state", async () => {
    const expired = `${STATE_COOKIE}=${sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: Date.now() - STATE_TTL_SECONDS * 1000 - 1 })}`;
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, expired)))).toBe("vyprselo");
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, `${STATE_COOKIE}=v1.AAAA`)))).toBe("vyprselo");
    expect(calls).toEqual([]);
  });

  it("answers stav=zamitnuto when the user declined on zotero.org (no verifier)", async () => {
    const denials: Array<Record<string, string>> = [{ oauth_token: REQUEST_TOKEN }, { oauth_token: REQUEST_TOKEN, denied: "1" }, {}];
    for (const query of denials) {
      const res = await callbackGET(callbackRequest(query, stateCookieFor()));
      expect(stavOf(res)).toBe("zamitnuto");
      expectStateCookieCleared(res);
    }
    expect(calls).toEqual([]);
  });

  it("connects: exchanges the verifier, checks the key, stores it sealed through saveConnection and clears the cookie", async () => {
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
    expect(stavOf(res)).toBe("pripojeno");
    expectStateCookieCleared(res);

    const [exchange] = callsTo(OAUTH_ACCESS_URL, "POST");
    const fields = oauthFields(exchange.headers.get("authorization"));
    expect(fields.oauth_token).toBe(REQUEST_TOKEN);
    expect(fields.oauth_verifier).toBe(VERIFIER);
    expect(callsTo(`${API_ORIGIN}/keys/current`, "GET")[0].headers.get("zotero-api-key")).toBe(API_KEY);
    expect(revokedKeys()).toEqual([]);

    // Stored only through saveConnection, with the name /keys/current gives.
    expect(vi.mocked(saveConnection)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveConnection)).toHaveBeenCalledWith(USER, {
      userID: ZOTERO_USER,
      username: "zuser",
      key: API_KEY,
      notes: true,
      groups: "all",
      mode: "read",
      keyWrite: false,
    });
    expect(mocks.updateUserMetadata).toHaveBeenCalledTimes(1);
    const everything = JSON.stringify([...users.entries()]);
    for (const secret of [API_KEY, REQUEST_SECRET, VERIFIER]) expect(everything).not.toContain(secret);
    expect(storedRecord()?.sealed).toMatch(/^v1\./);
    expect(users.get(USER)?.unrelated).toEqual({ keep: true });

    const state = await loadConnection(USER);
    expect(state.state === "ok" && state.conn.creds).toEqual({ userID: ZOTERO_USER, key: API_KEY });
  });

  it("works end to end with the cookie /connect set", async () => {
    const started = await connectPOST(connectRequest());
    const cookie = setCookies(started)[0].split(";")[0];
    const token = new URL(started.headers.get("location")!).searchParams.get("oauth_token")!;
    const res = await callbackGET(callbackRequest({ oauth_token: token, oauth_verifier: VERIFIER }, cookie));
    expect(stavOf(res)).toBe("pripojeno");
    expect((await loadConnection(USER)).state).toBe("ok");
  });

  it("answers stav=chyba and still clears the cookie when something unforeseen throws", async () => {
    const request = callbackRequest(APPROVED, stateCookieFor());
    // Past the state check, where no inner try reaches: a bare 500 would keep the cookie.
    Object.defineProperty(request, "url", {
      get() {
        throw new Error(`boom ${VERIFIER}`);
      },
    });
    const res = await callbackGET(request);
    expect(stavOf(res)).toBe("chyba");
    expectStateCookieCleared(res);
    expect(callsTo(OAUTH_ACCESS_URL)).toEqual([]);
  });

  const writeKey = () => {
    const base = fixture("keys-current.json") as Json;
    return { ...base, access: { ...(base.access as Json), user: { library: true, files: true, notes: true, write: true } } };
  };

  it("chose write and the key may write to the personal library: stored in write mode", async () => {
    zotero.keyInfo = () => json(writeKey());
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor(USER, REQUEST_TOKEN, REQUEST_SECRET, "write")));
    expect(stavOf(res)).toBe("pripojeno");
    expect(revokedKeys()).toEqual([]);
    expect(vi.mocked(saveConnection).mock.calls[0][1]).toMatchObject({ mode: "write", keyWrite: true });
    const state = await loadConnection(USER);
    expect(state.state === "ok" && state.conn.mode).toBe("write");
  });

  it("chose write but the key cannot write there (unticked on zotero.org, or only a group): stored as read", async () => {
    for (const body of [fixture("keys-current.json"), fixture("keys-current-write.json")]) {
      vi.mocked(saveConnection).mockClear();
      zotero.keyInfo = () => json(body);
      expect(stavOf(await callbackGET(callbackRequest(APPROVED, stateCookieFor(USER, REQUEST_TOKEN, REQUEST_SECRET, "write"))))).toBe("pripojeno");
      expect(vi.mocked(saveConnection).mock.calls[0][1]).toMatchObject({ mode: "read", keyWrite: false });
      const state = await loadConnection(USER);
      expect(state.state === "ok" && state.conn.mode).toBe("read");
    }
  });

  it("chose read but the key may write anyway: no longer refused — kept, in read mode, never revoked", async () => {
    for (const body of [writeKey(), fixture("keys-current-write.json")]) {
      calls = [];
      vi.mocked(saveConnection).mockClear();
      zotero.keyInfo = () => json(body);
      const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
      expect(stavOf(res)).toBe("pripojeno");
      expectStateCookieCleared(res);
      expect(revokedKeys()).toEqual([]);
      expect(vi.mocked(saveConnection).mock.calls[0][1]).toMatchObject({ mode: "read" });
      const state = await loadConnection(USER);
      expect(state.state === "ok" && state.conn.mode).toBe("read");
    }
  });

  it("revokes and refuses a key of another Zotero user, or without the personal library (stav=chyba)", async () => {
    const base = fixture("keys-current.json") as Json;
    const variants: Json[] = [
      { ...base, userID: 999999 },
      { ...base, access: { user: { library: false, notes: false, write: false }, groups: { all: { library: true, write: false } } } },
    ];
    for (const body of variants) {
      calls = [];
      zotero.keyInfo = () => json(body);
      const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
      expect(stavOf(res)).toBe("chyba");
      expectStateCookieCleared(res);
      expect(revokedKeys()).toEqual([API_KEY]);
    }
    expect(vi.mocked(saveConnection)).not.toHaveBeenCalled();
    expect(storedRecord()).toBeUndefined();
  });

  it("answers stav=chyba when the exchange fails, storing nothing", async () => {
    zotero.access = () => form("oauth_problem=token_rejected", 401);
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
    expect(stavOf(res)).toBe("chyba");
    expectStateCookieCleared(res);
    expect(callsTo(`${API_ORIGIN}/keys/current`)).toEqual([]);
    expect(storedRecord()).toBeUndefined();
  });

  it("revokes the new key when it cannot be checked or saved", async () => {
    zotero.keyInfo = () => new Response("down", { status: 502 });
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, stateCookieFor())))).toBe("chyba");
    expect(revokedKeys()).toEqual([API_KEY]);

    calls = [];
    zotero.keyInfo = defaultZotero().keyInfo;
    mocks.updateUserMetadata.mockRejectedValueOnce(Object.assign(new Error("Clerk 500"), { code: "api_response_error", status: 500 }));
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, stateCookieFor())))).toBe("chyba");
    expect(revokedKeys()).toEqual([API_KEY]);
    expect(storedRecord()).toBeUndefined();
  });

  it("revokes the key it replaces on reconnect, after saving the new one", async () => {
    await connected(OLD_KEY);
    const res = await callbackGET(callbackRequest(APPROVED, stateCookieFor()));
    expect(stavOf(res)).toBe("pripojeno");
    expect(revokedKeys()).toEqual([OLD_KEY]);
    const state = await loadConnection(USER);
    expect(state.state === "ok" && state.conn.fp).toBe(keyFingerprint(API_KEY));
  });

  it("does not revoke the stored key when zotero.org handed out the same key again", async () => {
    await connected(API_KEY);
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, stateCookieFor())))).toBe("pripojeno");
    expect(revokedKeys()).toEqual([]);
    expect((await loadConnection(USER)).state).toBe("ok");
  });

  it("stores a new key over a revoked or unreadable record without revoking anything", async () => {
    await connected(OLD_KEY);
    await markRevoked(USER, keyFingerprint(OLD_KEY));
    expect(stavOf(await callbackGET(callbackRequest(APPROVED, stateCookieFor())))).toBe("pripojeno");
    expect(revokedKeys()).toEqual([]);
    expect((await loadConnection(USER)).state).toBe("ok");
    expect(storedRecord()?.revokedAt).toBeUndefined();
  });
});

describe("POST /api/zotero/disconnect", () => {
  it("refuses a request without Origin (403) and a signed-out one (401)", async () => {
    const { origin: _origin, ...noOrigin } = SAME_ORIGIN_HEADERS;
    const refused = await disconnectPOST(disconnectRequest(noOrigin));
    expect(refused.status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();

    signedIn(null);
    const res = await disconnectPOST(disconnectRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Přihlaste se prosím." });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual([]);
  });

  it("revokes the key on zotero.org and forgets the connection", async () => {
    await connected();
    const res = await disconnectPOST(disconnectRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(revokedKeys()).toEqual([API_KEY]);
    expect(vi.mocked(deleteConnection)).toHaveBeenCalledWith(USER);
    expect(storedRecord()).toBeUndefined();
    expect(users.get(USER)?.unrelated).toEqual({ keep: true });
  });

  it("disconnects when Zotero answers 403 (key already gone), fails, or cannot be reached", async () => {
    const answers: Answer[] = [
      () => new Response("Invalid key", { status: 403 }),
      () => new Response("Forbidden", { status: 403 }),
      () => new Response("down", { status: 500 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      await connected();
      zotero.revoke = answer;
      const res = await disconnectPOST(disconnectRequest());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(storedRecord()).toBeUndefined();
      __resetZoteroHttpForTests();
    }
  });

  it("forgets a revoked, an unreadable or a malformed record without calling Zotero", async () => {
    await connected();
    await markRevoked(USER, keyFingerprint(API_KEY));
    expect((await disconnectPOST(disconnectRequest())).status).toBe(200);
    expect(storedRecord()).toBeUndefined();

    await connected();
    process.env.CREDENTIALS_SECRET = "another-secret-of-sufficient-length!";
    expect((await disconnectPOST(disconnectRequest())).status).toBe(200);
    expect(storedRecord()).toBeUndefined();
    process.env.CREDENTIALS_SECRET = ENV.CREDENTIALS_SECRET;

    users.set(USER, { zotero: { v: 0, whatever: true } });
    expect((await disconnectPOST(disconnectRequest())).status).toBe(200);
    expect(storedRecord()).toBeUndefined();
    expect(revokedKeys()).toEqual([]);
  });

  it("answers 503 when Clerk fails, so the modal can say so and the user can retry", async () => {
    mocks.getUser.mockRejectedValueOnce(Object.assign(new Error("Clerk 500"), { code: "api_response_error", status: 500 }));
    const res = await disconnectPOST(disconnectRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Zkuste to prosím za chvíli/);
  });
});

describe("GET /api/zotero/status", () => {
  async function status(): Promise<{ res: Response; body: ZoteroStatus; text: string }> {
    const res = await statusGET();
    const text = await res.text();
    return { res, body: JSON.parse(text) as ZoteroStatus, text };
  }

  function expectNoSecrets(text: string): void {
    for (const secret of [API_KEY, OLD_KEY, keyFingerprint(API_KEY), keyFingerprint(OLD_KEY)]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(?:key|fp|sealed)"/);
  }

  it("answers { state: 'signed_out' } with 200 when nobody is signed in", async () => {
    signedIn(null);
    const { res, body } = await status();
    expect(res.status).toBe(200);
    expect(body).toEqual({ state: "signed_out" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an account without Pro and without a connection, with no call to Zotero", async () => {
    signedIn(NO_PRO);
    const { body } = await status();
    expect(body).toEqual({ state: "ok", configured: true, pro: false, connection: null, revoked: null, unreadable: null });
    expect(calls).toEqual([]);
  });

  it("says when the deployment is not configured", async () => {
    delete process.env.ZOTERO_OAUTH_CLIENT_SECRET;
    const { body } = await status();
    expect(body).toMatchObject({ state: "ok", configured: false, pro: true, connection: null });
  });

  it("a connection with the readable groups' names, never the key or its fingerprint", async () => {
    await connected();
    const { body, text } = await status();
    expect(body).toEqual({
      state: "ok",
      configured: true,
      pro: true,
      connection: {
        username: "zuser",
        userID: ZOTERO_USER,
        connectedAt: expect.any(String),
        mode: "read",
        notes: true,
        groups: "all",
        groupNames: ["Advokátní kancelář – judikatura", "Seminář občanské právo"],
      },
      revoked: null,
      unreadable: null,
    });
    expectNoSecrets(text);
    expect(callsTo(`${API_ORIGIN}/users/${ZOTERO_USER}/groups?limit=100&start=0`)).toHaveLength(1);
  });

  it("exposes the effective mode: write for a write connection, read for one stored before modes", async () => {
    await connected(API_KEY, "all", "write");
    const { body } = await status();
    expect(body.state === "ok" && body.connection?.mode).toBe("write");

    const { mode: _m, keyWrite: _k, ...legacy } = storedRecord()!;
    users.set(USER, { ...users.get(USER), zotero: legacy });
    __resetZoteroStoreForTests();
    const again = await status();
    expect(again.body.state === "ok" && again.body.connection?.mode).toBe("read");
  });

  it("names only the groups the key may read", async () => {
    await connected(API_KEY, [222222]);
    const { body } = await status();
    expect(body.state === "ok" && body.connection).toMatchObject({ groups: [222222], groupNames: ["Seminář občanské právo"] });
  });

  it("omits the group names when Zotero fails, and does not ask for them without group access or Pro", async () => {
    await connected();
    zotero.groups = () => new Response("down", { status: 500 });
    let { body, text } = await status();
    expect(body.state === "ok" && body.connection).toMatchObject({ username: "zuser", groups: "all" });
    expect(body.state === "ok" && body.connection && "groupNames" in body.connection).toBe(false);
    expectNoSecrets(text);

    calls = [];
    await connected(API_KEY, "none");
    ({ body } = await status());
    expect(body.state === "ok" && body.connection).toMatchObject({ groups: "none" });
    expect(calls).toEqual([]);

    ACCESS[USER] = buildAccess({ id: USER, publicMetadata: {} }, []);
    __setAccessLoaderForTests(async (userId) => ACCESS[userId]);
    try {
      await connected();
      ({ body } = await status());
      expect(body).toMatchObject({ pro: false, connection: { username: "zuser" } });
      expect(calls).toEqual([]);
    } finally {
      ACCESS[USER] = buildAccess({ id: USER, publicMetadata: { pro: true } }, []);
    }
  });

  it("a key Zotero revoked", async () => {
    await connected();
    await markRevoked(USER, keyFingerprint(API_KEY));
    const { body, text } = await status();
    expect(body).toEqual({
      state: "ok",
      configured: true,
      pro: true,
      connection: null,
      revoked: { username: "zuser", revokedAt: expect.any(String) },
      unreadable: null,
    });
    expectNoSecrets(text);
    expect(calls).toEqual([]);
  });

  it("a key that no longer opens (CREDENTIALS_SECRET rotated)", async () => {
    await connected();
    process.env.CREDENTIALS_SECRET = "another-secret-of-sufficient-length!";
    const { body, text } = await status();
    expect(body).toEqual({ state: "ok", configured: true, pro: true, connection: null, revoked: null, unreadable: { username: "zuser" } });
    expectNoSecrets(text);
    expect(calls).toEqual([]);
  });

  it("marks the connection revoked when Zotero rejects the key while naming the groups", async () => {
    await connected();
    zotero.groups = () => new Response("Invalid key", { status: 403 });
    const { body, text } = await status();
    expect(body).toMatchObject({ connection: null, revoked: { username: "zuser" } });
    expectNoSecrets(text);
    expect(vi.mocked(markRevoked)).toHaveBeenCalledWith(USER, keyFingerprint(API_KEY));
    expect((await loadConnection(USER)).state).toBe("revoked");
    // And it is never sent again: the next status asks Zotero nothing.
    calls = [];
    await status();
    expect(calls).toEqual([]);
  });

  it("answers 503 when Clerk fails", async () => {
    mocks.getUser.mockRejectedValueOnce(Object.assign(new Error("Clerk 500"), { code: "api_response_error", status: 500 }));
    const res = await statusGET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Zkuste to prosím za chvíli/);
  });
});

// ---------------------------------------------------------------------------
// Static contract: what the routes may emit, log and how they are served

describe("the Zotero routes' contract", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const ROUTES = ["connect", "callback", "disconnect", "status"].map((name) => `app/api/zotero/${name}/route.ts`);

  it("every stav the server can send back is one the modal knows (ZOTERO_STAV)", () => {
    const source = read("src/zotero/web.ts");
    const emitted = new Set([...source.matchAll(/\b(?:backTo|done|refuse|callbackDone)\("([a-z]+)"/g)].map((m) => m[1]));
    expect([...emitted].sort()).toEqual(
      ["chyba", "limit", "nedostupne", "nepro", "pripojeno", "prihlaseni", "vyprselo", "zamitnuto"].sort(),
    );
    for (const stav of emitted) expect(ZOTERO_STAV).toContain(stav);
  });

  it("every route runs on Node.js, is never prerendered or cached, and never logs by itself", () => {
    for (const file of ROUTES) {
      const source = read(file);
      expect(source, file).toMatch(/export const runtime = "nodejs";/);
      expect(source, file).toMatch(/export const dynamic = "force-dynamic";/);
      expect(source, file).not.toMatch(/console\./);
    }
  });

  it("logs only through logZoteroError, which prints the step and a code, never a value", () => {
    const source = read("src/zotero/web.ts");
    const lines = source.split("\n").filter((line) => /console\./.test(line));
    expect(lines).toEqual(["  console.error(`zotero: ${where} failed (${code})`);"]);
  });

  it("serves /api/zotero/* as a private area: no-store, same-origin referrer, no framing", async () => {
    const { default: config } = await import("@/next.config");
    const rules = await config.headers!();
    const rule = rules.find((r) => r.source === "/api/zotero/:path*");
    expect(rule).toBeDefined();
    const headers = Object.fromEntries(rule!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["referrer-policy"]).toBe("same-origin");
    expect(headers["x-frame-options"]).toBe("DENY");
  });
});
