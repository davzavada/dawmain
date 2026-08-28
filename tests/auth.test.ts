import { afterEach, describe, expect, it } from "vitest";
import { getAuthKitIssuer, tokenMatches } from "@/src/mcp/config";
import { authInfoFromClaims, authMode, verifyRequestAuth } from "@/src/mcp/auth";

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

describe("getAuthKitIssuer", () => {
  afterEach(() => {
    delete process.env.AUTHKIT_DOMAIN;
  });

  it("is undefined when unset or blank", () => {
    delete process.env.AUTHKIT_DOMAIN;
    expect(getAuthKitIssuer()).toBeUndefined();
    process.env.AUTHKIT_DOMAIN = "   ";
    expect(getAuthKitIssuer()).toBeUndefined();
  });

  it("normalizes a bare hostname and trailing slashes", () => {
    process.env.AUTHKIT_DOMAIN = "dawmain.authkit.app";
    expect(getAuthKitIssuer()).toBe("https://dawmain.authkit.app");
    process.env.AUTHKIT_DOMAIN = "https://dawmain.authkit.app/";
    expect(getAuthKitIssuer()).toBe("https://dawmain.authkit.app");
  });
});

describe("authInfoFromClaims", () => {
  const token = "eyJ.fake.jwt";

  it("maps sub, exp and the RFC 6749 scope string", () => {
    const info = authInfoFromClaims(
      { sub: "user_01ABC", sid: "session_01X", exp: 1_900_000_000, scope: "openid profile  email" },
      token,
    );
    expect(info.token).toBe(token);
    expect(info.scopes).toEqual(["openid", "profile", "email"]);
    expect(info.expiresAt).toBe(1_900_000_000);
    expect(info.extra).toMatchObject({ method: "oauth", userId: "user_01ABC", sessionId: "session_01X" });
  });

  it("tolerates missing scope/client claims", () => {
    const info = authInfoFromClaims({ sub: "user_01ABC" }, token);
    expect(info.scopes).toEqual([]);
    expect(info.clientId).toBe("authkit");
    expect(info.expiresAt).toBeUndefined();
  });

  it("prefers client_id, then azp, for the client identity", () => {
    expect(authInfoFromClaims({ client_id: "client_1", azp: "client_2" }, token).clientId).toBe("client_1");
    expect(authInfoFromClaims({ azp: "client_2" }, token).clientId).toBe("client_2");
  });
});

describe("verifyRequestAuth + authMode", () => {
  const shared = "dm_" + "s".repeat(40);

  afterEach(() => {
    delete process.env.MCP_BEARER_TOKEN;
    delete process.env.AUTHKIT_DOMAIN;
  });

  it("accepts the shared token from any supported header", async () => {
    process.env.MCP_BEARER_TOKEN = shared;
    const viaApiKey = new Request("http://localhost/api/mcp", {
      headers: { "x-api-key": shared, authorization: "Bearer unrelated-oauth-junk" },
    });
    const info = await verifyRequestAuth(viaApiKey, "unrelated-oauth-junk");
    expect(info?.clientId).toBe("shared-token");
  });

  it("rejects a wrong shared token without touching the network (no issuer set)", async () => {
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
    process.env.AUTHKIT_DOMAIN = "dawmain.authkit.app";
    expect(authMode()).toBe("oauth+token");
    delete process.env.MCP_BEARER_TOKEN;
    expect(authMode()).toBe("oauth");
  });
});
