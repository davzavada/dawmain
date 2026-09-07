import { afterEach, describe, expect, it, vi } from "vitest";
import { clerkConfigured, tokenMatches } from "@/src/mcp/config";
import { authMode, authorizationServerMetadata, clerkAuthorizationServer, verifyRequestAuth } from "@/src/mcp/auth";

/**
 * The endpoint's gate (src/mcp/auth.ts): shared token + Clerk OAuth. These
 * assertions pin the pure pieces the route handler relies on — the JWT
 * signature check needs the issuer's JWKS and is exercised against a
 * deployment, as is the fail-closed behaviour (scripts/smoke.mjs).
 */
describe("tokenMatches", () => {
  const token = "dm_" + "a".repeat(40);

  it("accepts the exact token and nothing else", () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, token.slice(0, -1) + "b")).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
    expect(tokenMatches(token, token + "x")).toBe(false);
    expect(tokenMatches(token, token.toUpperCase())).toBe(false);
  });

  it("compares bytes, not characters — a multi-byte token still matches itself", () => {
    const utf8 = "tökén-Ω-" + "ř".repeat(20);
    expect(tokenMatches(utf8, utf8)).toBe(true);
    expect(tokenMatches(utf8, utf8.replace("Ω", "O"))).toBe(false);
  });

  it("never throws on length mismatch (timingSafeEqual would)", () => {
    expect(() => tokenMatches("short", "considerably-longer-value")).not.toThrow();
    expect(tokenMatches("short", "considerably-longer-value")).toBe(false);
  });
});

describe("clerkConfigured", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
  });

  it("requires BOTH keys — a publishable key alone must not advertise OAuth", () => {
    expect(clerkConfigured()).toBe(false);
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    expect(clerkConfigured()).toBe(false);
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    expect(clerkConfigured()).toBe(true);
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "   ";
    expect(clerkConfigured()).toBe(false);
  });
});

describe("verifyRequestAuth + authMode", () => {
  const shared = "dm_" + "s".repeat(40);

  afterEach(() => {
    delete process.env.MCP_BEARER_TOKEN;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
  });

  it("accepts the shared token from any supported header", async () => {
    process.env.MCP_BEARER_TOKEN = shared;
    const viaApiKey = new Request("http://localhost/api/mcp", {
      headers: { "x-api-key": shared, authorization: "Bearer unrelated-oauth-junk" },
    });
    const info = await verifyRequestAuth(viaApiKey, "unrelated-oauth-junk");
    expect(info?.clientId).toBe("shared-token");
  });

  it("rejects a wrong shared token without touching the network (Clerk unconfigured)", async () => {
    process.env.MCP_BEARER_TOKEN = shared;
    const bad = new Request("http://localhost/api/mcp", {
      headers: { authorization: `Bearer ${shared}x` },
    });
    expect(await verifyRequestAuth(bad, `${shared}x`)).toBeUndefined();
  });

  it("reports the configured methods", () => {
    expect(authMode()).toBe("open");
    process.env.MCP_BEARER_TOKEN = shared;
    expect(authMode()).toBe("token");
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    expect(authMode()).toBe("oauth+token");
    delete process.env.MCP_BEARER_TOKEN;
    expect(authMode()).toBe("oauth");
  });
});

describe("authorizationServerMetadata", () => {
  // Same shape Clerk issues: the frontend-API host, "$"-terminated, base64 in the key.
  const host = "guarded-login-42.clerk.accounts.dev";
  const publishableKey = "pk_test_" + Buffer.from(`${host}$`).toString("base64");
  const issuer = `https://${host}`;
  const document = { issuer, authorization_endpoint: `${issuer}/oauth/authorize` };

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
  });

  function configure(): void {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = publishableKey;
    process.env.CLERK_SECRET_KEY = "sk_test_x";
  }

  it("derives the issuer from the publishable key", () => {
    expect(clerkAuthorizationServer(publishableKey)).toBe(issuer);
  });

  it("is 404 while OAuth is unconfigured, without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await authorizationServerMetadata();
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 instead of crashing when Clerk is unreachable — twice", async () => {
    configure();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await authorizationServerMetadata();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${issuer}/.well-known/oauth-authorization-server`);
  });

  it("treats an outage page from Clerk as a failure, not as metadata", async () => {
    configure();
    const html = () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    const fetchMock = vi.fn().mockImplementation(async () => html());
    vi.stubGlobal("fetch", fetchMock);
    expect((await authorizationServerMetadata()).status).toBe(503);

    // A 200 that is not JSON (the failure mode that threw inside .json()).
    fetchMock.mockImplementation(async () => new Response("<html>maintenance</html>", { status: 200 }));
    expect((await authorizationServerMetadata()).status).toBe(503);
  });

  it("recovers on the retry and then serves the cached document", async () => {
    configure();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(async () => Response.json(document));
    vi.stubGlobal("fetch", fetchMock);

    const first = await authorizationServerMetadata();
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(await first.json()).toEqual(document);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await authorizationServerMetadata();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(document);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
