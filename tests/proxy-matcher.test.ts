import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";
import nextConfig from "@/next.config";

/**
 * proxy.ts runs Clerk only where auth() is needed. /api/status stays out:
 * it is static and the CDN serves it, which a proxy in front would turn into
 * a function call per badge request.
 */

const runs = (url: string) => unstable_doesMiddlewareMatch({ config, nextConfig, url });

describe("proxy matcher", () => {
  it("skips the public source status", () => {
    expect(runs("/api/status")).toBe(false);
    expect(runs("/api/status/")).toBe(false);
  });

  it("still covers every other API route and the operator page", () => {
    for (const url of [
      "/api/mcp",
      "/api/files/summary",
      "/api/zotero/status",
      "/api/statusx",
      "/api/cron/files",
      "/vlastni-zdroje/provoz",
      "/__clerk/v1/client",
    ]) {
      expect(runs(url), url).toBe(true);
    }
  });

  it("leaves the static pages alone", () => {
    expect(runs("/")).toBe(false);
    expect(runs("/vlastni-zdroje")).toBe(false);
  });
});
