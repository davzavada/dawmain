import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clerkConfigured, tokenMatches } from "@/src/mcp/config";
import { authMode, resetVerifiedTokens, verifyRequestAuth } from "@/src/mcp/auth";

/** Clerk's backend, scripted: which tokens it accepts, and how often it was asked. */
const clerk = vi.hoisted(() => ({ accepted: new Set<string>(), asked: [] as string[], down: false }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    authenticateRequest: async (request: Request) => {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      clerk.asked.push(token);
      if (clerk.down) throw new Error("Clerk unreachable");
      const ok = clerk.accepted.has(token);
      return {
        isAuthenticated: ok,
        reason: "token-invalid",
        message: "",
        toAuth: () => ({ isAuthenticated: ok, tokenType: "oauth_token", clientId: "client_1", scopes: ["profile"], userId: "user_1" }),
      };
    },
  }),
}));

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

describe("verified OAuth tokens are remembered for a minute", () => {
  const oauth = (token: string) => new Request("http://localhost/api/mcp", { headers: { authorization: `Bearer ${token}` } });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    clerk.accepted = new Set(["oat_good"]);
    clerk.asked = [];
    clerk.down = false;
    resetVerifiedTokens();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
  });

  it("asks Clerk once for a token it accepted, and returns the same identity", async () => {
    const first = await verifyRequestAuth(oauth("oat_good"), "oat_good");
    const second = await verifyRequestAuth(oauth("oat_good"), "oat_good");
    expect(first).toMatchObject({ clientId: "client_1", extra: { userId: "user_1" } });
    expect(second).toEqual(first);
    expect(clerk.asked).toEqual(["oat_good"]);
  });

  it("asks again after 60 s — a revoked token stops working within the minute", async () => {
    vi.useFakeTimers();
    await verifyRequestAuth(oauth("oat_good"), "oat_good");
    clerk.accepted.clear();
    vi.advanceTimersByTime(59_000);
    expect(await verifyRequestAuth(oauth("oat_good"), "oat_good")).toBeDefined();
    vi.advanceTimersByTime(2_000);
    expect(await verifyRequestAuth(oauth("oat_good"), "oat_good")).toBeUndefined();
    expect(clerk.asked).toHaveLength(2);
  });

  it("never remembers a rejection, a Clerk failure, or another token", async () => {
    expect(await verifyRequestAuth(oauth("oat_bad"), "oat_bad")).toBeUndefined();
    clerk.accepted.add("oat_bad");
    expect(await verifyRequestAuth(oauth("oat_bad"), "oat_bad")).toBeDefined();

    clerk.down = true;
    expect(await verifyRequestAuth(oauth("oat_other"), "oat_other")).toBeUndefined();
    clerk.down = false;
    expect(await verifyRequestAuth(oauth("oat_other"), "oat_other")).toBeUndefined();
    expect(clerk.asked).toEqual(["oat_bad", "oat_bad", "oat_other", "oat_other"]);
  });
});
