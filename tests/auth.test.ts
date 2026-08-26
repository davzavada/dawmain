import { describe, expect, it } from "vitest";
import { tokenMatches } from "@/src/mcp/config";

/**
 * The endpoint's only gate. These assertions pin the properties the route
 * handler relies on; the fail-closed behaviour itself lives in
 * app/api/mcp/route.ts and is exercised by scripts/smoke.mjs against a
 * running server.
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
