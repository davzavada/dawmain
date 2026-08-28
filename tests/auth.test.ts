import { afterEach, describe, expect, it } from "vitest";
import { clerkConfigured, tokenMatches } from "@/src/mcp/config";
import { authMode, verifyRequestAuth } from "@/src/mcp/auth";

/**
 * The endpoint's gate (src/mcp/auth.ts): shared token + AuthKit OAuth. These
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
