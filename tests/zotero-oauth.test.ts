import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealSecret } from "@/src/secrets/seal";
import { SourceError } from "@/src/sources/shared/errors";
import {
  AUTHORIZE_PARAMS,
  LIMITS,
  OAUTH_ACCESS_URL,
  OAUTH_AUTHORIZE_URL,
  OAUTH_REQUEST_URL,
  STATE_TTL_SECONDS,
  ZOTERO_UA,
} from "@/src/zotero/config";
import { accessToken, authorizeUrl, openState, requestToken, sealState } from "@/src/zotero/oauth";
import { baseString, hmacSha1 } from "@/src/zotero/oauth1";

/**
 * The OAuth 1.0a dance with www.zotero.org (src/zotero/oauth.ts) and the
 * sealed state cookie between /connect and /callback. zotero.org is not
 * reachable from the test container: fetch is stubbed and the answers are
 * built from the documentation (replace with live captures when available).
 */

const CLIENT_KEY = "ck0123456789abcdef";
const CLIENT_SECRET = "cs-very-secret-consumer-9876";
const REQUEST_TOKEN = "1d4ab1b7c5dda2a5a3f1";
const REQUEST_SECRET = "c6d5d3b1c5aa7b6e9f00";
const VERIFIER = "8e4b5c6d7a1f2e3d";
const API_KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const CALLBACK = "https://dawmain.example/api/zotero/callback";
const USER = "user_2abcDEF123";
const SECRETS = [CLIENT_SECRET, REQUEST_TOKEN, REQUEST_SECRET, VERIFIER, API_KEY];

interface Call {
  url: string;
  init: RequestInit;
}

/** Stub fetch with one answer (or a thrown error) and record every call. */
function stubFetch(answer: Response | Error | (() => Response)): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  });
  return calls;
}

const form = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/x-www-form-urlencoded" } });

/** The decoded fields of an OAuth Authorization header. */
function oauthFields(header: string): Record<string, string> {
  expect(header.startsWith("OAuth ")).toBe(true);
  const out: Record<string, string> = {};
  for (const part of header.slice(6).split(", ")) {
    const match = /^([a-z_]+)="([A-Za-z0-9%._~-]*)"$/.exec(part);
    expect(match, `malformed header field: ${part}`).not.toBeNull();
    out[match![1]] = decodeURIComponent(match![2]);
  }
  return out;
}

/** Recompute the signature from the header's own fields. */
function signatureValid(url: string, header: string, tokenSecret = ""): boolean {
  const { oauth_signature, ...signed } = oauthFields(header);
  return hmacSha1(baseString("POST", url, Object.entries(signed)), CLIENT_SECRET, tokenSecret) === oauth_signature;
}

/** Everything an error exposes as text. */
async function errorText(promise: Promise<unknown>): Promise<{ error: unknown; text: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as Partial<SourceError>;
    return { error, text: [String(error), e.message, e.hint, e.stack].join("\n") };
  }
  throw new Error("expected a rejection");
}

const saved: Record<string, string | undefined> = {};
const ENV = {
  ZOTERO_OAUTH_CLIENT_KEY: CLIENT_KEY,
  ZOTERO_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  CREDENTIALS_SECRET: "a-test-secret-of-sufficient-length",
};

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
afterEach(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
});

describe("requestToken", () => {
  it("POSTs a signed request with oauth_callback and parses the temporary token", async () => {
    const calls = stubFetch(form(`oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=true`));
    await expect(requestToken(CALLBACK)).resolves.toEqual({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(OAUTH_REQUEST_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(ZOTERO_UA);
    const fields = oauthFields(headers.authorization);
    expect(fields.oauth_callback).toBe(CALLBACK);
    expect(headers.authorization).toContain('oauth_callback="https%3A%2F%2Fdawmain.example%2Fapi%2Fzotero%2Fcallback"');
    expect(fields.oauth_consumer_key).toBe(CLIENT_KEY);
    expect(fields.oauth_signature_method).toBe("HMAC-SHA1");
    expect(fields.oauth_version).toBe("1.0");
    expect(fields.oauth_token).toBeUndefined();
    expect(fields.oauth_signature).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    // Signed with the consumer secret alone, and the secret is never sent.
    expect(signatureValid(OAUTH_REQUEST_URL, headers.authorization)).toBe(true);
    expect(headers.authorization).not.toContain(CLIENT_SECRET);
  });

  it("uses the configured request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stubFetch(form(`oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=true`));
    await requestToken(CALLBACK);
    expect(timeout).toHaveBeenCalledWith(LIMITS.requestTimeoutMs);
    timeout.mockRestore();
  });

  it("rejects an answer without oauth_callback_confirmed=true", async () => {
    for (const body of [
      `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`,
      `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=false`,
      `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=TRUE`,
    ]) {
      stubFetch(form(body));
      await expect(requestToken(CALLBACK)).rejects.toMatchObject({ name: "SourceError", kind: "PARSE_DRIFT", source: "Zotero" });
    }
  });

  it("rejects an answer without a usable token or secret", async () => {
    for (const body of ["oauth_callback_confirmed=true", `oauth_token=&oauth_token_secret=${REQUEST_SECRET}&oauth_callback_confirmed=true`, `oauth_token=a%20b&oauth_token_secret=x&oauth_callback_confirmed=true`, "<html>maintenance</html>"]) {
      stubFetch(form(body));
      await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "PARSE_DRIFT" });
    }
  });

  it("maps a refusal to UPSTREAM_ERROR with the status and the OAuth problem, and follows no redirect", async () => {
    stubFetch(form("oauth_problem=signature_invalid", 401));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "UPSTREAM_ERROR", message: expect.stringMatching(/HTTP 401, signature_invalid/) });

    stubFetch(new Response("Invalid signature", { status: 400 }));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ message: expect.stringMatching(/HTTP 400, Invalid signature/) });

    const calls = stubFetch(new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "UPSTREAM_ERROR", message: expect.stringMatching(/HTTP 302/) });
    expect(calls).toHaveLength(1);
  });

  it("maps a network failure or timeout to UPSTREAM_UNREACHABLE", async () => {
    stubFetch(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "UPSTREAM_UNREACHABLE", message: expect.stringMatching(/timed out/) });
    stubFetch(new TypeError("fetch failed"));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "UPSTREAM_UNREACHABLE" });
  });

  it("refuses an oversized answer", async () => {
    stubFetch(form(`oauth_callback_confirmed=true&oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&pad=${"x".repeat(40_000)}`));
    await expect(requestToken(CALLBACK)).rejects.toMatchObject({ kind: "PARSE_DRIFT", message: expect.stringMatching(/oversized/) });
  });

  it("throws a clear error without the client key or secret, before any request", async () => {
    const calls = stubFetch(form("unused"));
    delete process.env.ZOTERO_OAUTH_CLIENT_KEY;
    await expect(requestToken(CALLBACK)).rejects.toThrow(/ZOTERO_OAUTH_CLIENT_KEY/);
    process.env.ZOTERO_OAUTH_CLIENT_KEY = CLIENT_KEY;
    process.env.ZOTERO_OAUTH_CLIENT_SECRET = "  ";
    await expect(requestToken(CALLBACK)).rejects.toThrow(/ZOTERO_OAUTH_CLIENT_SECRET/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback that is not an absolute http(s) URL", async () => {
    const calls = stubFetch(form("unused"));
    await expect(requestToken("/api/zotero/callback")).rejects.toThrow(/absolute/);
    await expect(requestToken("javascript:alert(1)")).rejects.toThrow(/http/);
    expect(calls).toHaveLength(0);
  });
});

describe("authorizeUrl", () => {
  it("is the authorize endpoint with the token and exactly the fixed, read-only parameters, in order", () => {
    const url = new URL(authorizeUrl(REQUEST_TOKEN));
    expect(`${url.origin}${url.pathname}`).toBe(OAUTH_AUTHORIZE_URL);
    expect([...url.searchParams]).toEqual([
      ["oauth_token", REQUEST_TOKEN],
      ["name", "Dawmain"],
      ["library_access", "1"],
      ["notes_access", "1"],
      ["write_access", "0"],
      ["all_groups", "read"],
    ]);
    expect([...url.searchParams].slice(1)).toEqual(AUTHORIZE_PARAMS.map(([n, v]) => [n, v]));
    expect(url.searchParams.get("write_access")).toBe("0");
    expect(url.hash).toBe("");
  });

  it("never asks for identity", () => {
    const url = authorizeUrl(REQUEST_TOKEN);
    expect(url).not.toMatch(/identity/i);
    expect(new URL(url).searchParams.has("identity")).toBe(false);
  });

  it("refuses a malformed token rather than injecting parameters", () => {
    expect(() => authorizeUrl("abc&identity=1")).toThrow();
    expect(() => authorizeUrl("")).toThrow();
  });
});

describe("accessToken", () => {
  const good = `oauth_token=${API_KEY}&oauth_token_secret=${API_KEY}&userID=12345&username=zuser`;

  it("returns oauth_token_secret as the key and a numeric userID", async () => {
    const calls = stubFetch(form(good));
    const grant = await accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER);
    expect(grant).toEqual({ key: API_KEY, userID: 12345, username: "zuser" });
    expect(typeof grant.userID).toBe("number");

    const { url, init } = calls[0];
    expect(url).toBe(OAUTH_ACCESS_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(ZOTERO_UA);
    const fields = oauthFields(headers.authorization);
    expect(fields.oauth_token).toBe(REQUEST_TOKEN);
    expect(fields.oauth_verifier).toBe(VERIFIER);
    expect(fields.oauth_callback).toBeUndefined();
    // Signed with both secrets; neither travels.
    expect(signatureValid(OAUTH_ACCESS_URL, headers.authorization, REQUEST_SECRET)).toBe(true);
    expect(signatureValid(OAUTH_ACCESS_URL, headers.authorization)).toBe(false);
    expect(headers.authorization).not.toContain(REQUEST_SECRET);
    expect(headers.authorization).not.toContain(CLIENT_SECRET);
  });

  it("uses oauth_token_secret even when oauth_token differs", async () => {
    stubFetch(form(`oauth_token=SomethingElse123&oauth_token_secret=${API_KEY}&userID=7&username=a%20b`));
    await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)).resolves.toEqual({ key: API_KEY, userID: 7, username: "a b" });
  });

  it("keeps a key whose answer lacks a username", async () => {
    stubFetch(form(`oauth_token_secret=${API_KEY}&userID=7`));
    await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)).resolves.toEqual({ key: API_KEY, userID: 7, username: "" });
  });

  it("rejects 'identity' instead of a key", async () => {
    for (const secret of ["identity", "IDENTITY"]) {
      stubFetch(form(`oauth_token=identity&oauth_token_secret=${secret}&userID=12345&username=zuser`));
      await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)).rejects.toMatchObject({ kind: "PARSE_DRIFT" });
    }
  });

  it("rejects a malformed key or userID", async () => {
    const bodies = [
      "userID=12345&username=zuser",
      "oauth_token_secret=short&userID=12345",
      "oauth_token_secret=has%20a%20space%20inside&userID=12345",
      `oauth_token_secret=${"a".repeat(65)}&userID=12345`,
      `oauth_token_secret=${API_KEY}`,
      `oauth_token_secret=${API_KEY}&userID=0`,
      `oauth_token_secret=${API_KEY}&userID=-5`,
      `oauth_token_secret=${API_KEY}&userID=12a`,
      `oauth_token_secret=${API_KEY}&userID=1e5`,
      `oauth_token_secret=${API_KEY}&userID=1.5`,
      `oauth_token_secret=${API_KEY}&userID=99999999999999999`,
      "<!doctype html><title>Error</title>",
    ];
    for (const body of bodies) {
      stubFetch(form(body));
      await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER), body).rejects.toMatchObject({ kind: "PARSE_DRIFT" });
    }
  });

  it("maps an expired or reused token to UPSTREAM_ERROR", async () => {
    stubFetch(form("oauth_problem=token_rejected", 401));
    await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)).rejects.toMatchObject({
      kind: "UPSTREAM_ERROR",
      hint: expect.stringMatching(/again/),
    });
  });

  it("refuses a malformed verifier without calling zotero.org", async () => {
    const calls = stubFetch(form(good));
    await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, "")).rejects.toMatchObject({ kind: "INPUT_INVALID" });
    await expect(accessToken(REQUEST_TOKEN, REQUEST_SECRET, "a b\"c")).rejects.toMatchObject({ kind: "INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });
});

describe("errors never carry a secret", () => {
  it("in any failure of either step", async () => {
    const echo = `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}&oauth_verifier=${VERIFIER}&key=${API_KEY}&secret=${CLIENT_SECRET}`;
    const scenarios: Array<[string, Response | Error, () => Promise<unknown>]> = [
      ["request 401 echoing everything", form(echo, 401), () => requestToken(CALLBACK)],
      ["request 200 without confirmation", form(echo), () => requestToken(CALLBACK)],
      ["request network error quoting a secret", new TypeError(`connect failed ${CLIENT_SECRET}`), () => requestToken(CALLBACK)],
      ["access 401 echoing everything", form(echo, 401), () => accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)],
      ["access 500 plain secret", new Response(API_KEY, { status: 500 }), () => accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)],
      ["access identity", form(`oauth_token_secret=identity&userID=1&x=${API_KEY}`), () => accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)],
      ["access bad userID", form(`oauth_token_secret=${API_KEY}&userID=abc`), () => accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)],
      ["access network error quoting a secret", new TypeError(`reset ${REQUEST_SECRET} ${VERIFIER}`), () => accessToken(REQUEST_TOKEN, REQUEST_SECRET, VERIFIER)],
    ];
    for (const [name, answer, run] of scenarios) {
      stubFetch(answer);
      const { error, text } = await errorText(run());
      expect(error, name).toBeInstanceOf(SourceError);
      for (const secret of SECRETS) expect(text, `${name} leaks a secret`).not.toContain(secret);
    }
  });
});

describe("OAuth state cookie", () => {
  const NOW = 1_790_000_000_000;

  it("round-trips the request token for the same user", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: NOW });
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(value).not.toContain(REQUEST_SECRET);
    expect(value).not.toContain(REQUEST_TOKEN);
    expect(openState(value, USER, NOW)).toEqual({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET });
    expect(openState(value, USER, NOW + STATE_TTL_SECONDS * 1000 - 1)).toEqual({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET });
  });

  it("expires after STATE_TTL_SECONDS", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: NOW });
    expect(openState(value, USER, NOW + STATE_TTL_SECONDS * 1000)).toBeNull();
    expect(openState(value, USER, NOW + 24 * 3600 * 1000)).toBeNull();
  });

  it("defaults to the current time", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER });
    expect(openState(value, USER)).toEqual({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET });
    expect(openState(value, USER, Date.now() + STATE_TTL_SECONDS * 1000 + 1)).toBeNull();
  });

  it("does not open for another user", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: NOW });
    expect(openState(value, "user_someoneElse", NOW)).toBeNull();
    // Even a payload naming another user under the right aad is refused.
    const forged = sealSecret(JSON.stringify({ t: REQUEST_TOKEN, s: REQUEST_SECRET, u: "user_other", exp: NOW + 60_000 }), "zotero-oauth-state-v1", `state:${USER}`);
    expect(openState(forged, USER, NOW)).toBeNull();
  });

  it("returns null — never throws — for anything tampered, foreign or malformed", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: NOW });
    const raw = Buffer.from(value.slice(3), "base64url");
    raw[raw.length - 1] ^= 0x01;
    const tampered = "v1." + raw.toString("base64url");
    const seal = (plain: string) => sealSecret(plain, "zotero-oauth-state-v1", `state:${USER}`);
    const candidates: Array<string | null | undefined> = [
      tampered,
      undefined,
      null,
      "",
      "v1.",
      "garbage",
      value + "x",
      "v1." + "A".repeat(5_000),
      // Right key, wrong purpose.
      sealSecret(JSON.stringify({ t: REQUEST_TOKEN, s: REQUEST_SECRET, u: USER, exp: NOW + 60_000 }), "zotero-api-key-v1", `state:${USER}`),
      // Right seal, bad contents.
      seal("not json"),
      seal("null"),
      seal("[]"),
      seal(JSON.stringify({ t: REQUEST_TOKEN, s: REQUEST_SECRET, u: USER })),
      seal(JSON.stringify({ t: REQUEST_TOKEN, s: REQUEST_SECRET, u: USER, exp: String(NOW + 60_000) })),
      seal(JSON.stringify({ t: "", s: REQUEST_SECRET, u: USER, exp: NOW + 60_000 })),
      seal(JSON.stringify({ t: REQUEST_TOKEN, s: 42, u: USER, exp: NOW + 60_000 })),
    ];
    for (const candidate of candidates) expect(openState(candidate, USER, NOW)).toBeNull();
    expect(openState(value, "not-a-clerk-id", NOW)).toBeNull();
  });

  it("returns null after CREDENTIALS_SECRET rotated or went missing", () => {
    const value = sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: USER, now: NOW });
    process.env.CREDENTIALS_SECRET = "another-secret-of-sufficient-length!";
    expect(openState(value, USER, NOW)).toBeNull();
    delete process.env.CREDENTIALS_SECRET;
    expect(openState(value, USER, NOW)).toBeNull();
  });

  it("refuses to seal for a malformed user id", () => {
    expect(() => sealState({ token: REQUEST_TOKEN, tokenSecret: REQUEST_SECRET, userId: "nobody" })).toThrow();
  });
});
