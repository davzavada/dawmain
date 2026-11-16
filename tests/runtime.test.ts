import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appEnvironment,
  appRegion,
  authForced,
  forwardedHostTrusted,
  gitCommit,
  productionOrigin,
} from "@/src/runtime";
import { authRequired, challengeOrigin, requestOrigin } from "@/src/mcp/auth";
import { sameOrigin } from "@/src/files/guards";
import { publicOrigin } from "@/src/zotero/web";

const KEYS = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_REGION",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "PUBLIC_URL",
  "APP_ENV",
  "APP_REGION",
  "GIT_SHA",
  "DAWMAIN_REQUIRE_AUTH",
  "TRUST_FORWARDED_HOST",
  "MCP_BEARER_TOKEN",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
];

/** A clean slate: none of the deployment variables set. */
function cleanEnv(set: Record<string, string> = {}): void {
  for (const key of KEYS) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(set)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("authForced / authRequired (the endpoint must fail closed)", () => {
  it("is off locally with nothing configured, so `npm run dev` stays anonymous", () => {
    cleanEnv();
    expect(authForced()).toBe(false);
    expect(authRequired()).toBe(false);
  });

  it("is on on Vercel, whatever else is (not) configured", () => {
    cleanEnv({ VERCEL: "1" });
    expect(authForced()).toBe(true);
    expect(authRequired()).toBe(true);
  });

  it("is on at home when DAWMAIN_REQUIRE_AUTH is set, with no token and no Clerk", () => {
    cleanEnv({ DAWMAIN_REQUIRE_AUTH: "1" });
    expect(authRequired()).toBe(true);
  });

  it.each(["true", "yes", "TRUE", "ture", "enabled"])("treats %s as on (a misspelling must not open the endpoint)", (value) => {
    cleanEnv({ DAWMAIN_REQUIRE_AUTH: value });
    expect(authForced()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE"])("turns off only on an explicit %s", (value) => {
    cleanEnv({ DAWMAIN_REQUIRE_AUTH: value });
    expect(authForced()).toBe(false);
  });

  it("still requires auth once a token is configured, without the flag", () => {
    cleanEnv({ MCP_BEARER_TOKEN: "x".repeat(24) });
    expect(authRequired()).toBe(true);
  });
});

describe("identity of the deployment", () => {
  it("prefers our own variables over Vercel's", () => {
    cleanEnv({
      APP_ENV: "production",
      VERCEL_ENV: "preview",
      APP_REGION: "home",
      VERCEL_REGION: "fra1",
      GIT_SHA: "abcdef0123456789",
      VERCEL_GIT_COMMIT_SHA: "1111111222222",
    });
    expect(appEnvironment()).toBe("production");
    expect(appRegion()).toBe("home");
    expect(gitCommit()).toBe("abcdef0");
  });

  it("falls back to Vercel's, then to local / null", () => {
    cleanEnv({ VERCEL_ENV: "preview", VERCEL_REGION: "fra1", VERCEL_GIT_COMMIT_SHA: "1111111222222" });
    expect(appEnvironment()).toBe("preview");
    expect(appRegion()).toBe("fra1");
    expect(gitCommit()).toBe("1111111");
    cleanEnv();
    expect(appEnvironment()).toBe("local");
    expect(appRegion()).toBeNull();
    expect(gitCommit()).toBeNull();
  });
});

describe("productionOrigin", () => {
  it("takes PUBLIC_URL, trailing slash trimmed", () => {
    cleanEnv({ PUBLIC_URL: "https://dawmain.davidzavada.cz/" });
    expect(productionOrigin()).toBe("https://dawmain.davidzavada.cz");
  });

  it("falls back to the host Vercel names", () => {
    cleanEnv({ VERCEL_PROJECT_PRODUCTION_URL: "dawmain.davidzavada.cz" });
    expect(productionOrigin()).toBe("https://dawmain.davidzavada.cz");
  });

  it("prefers PUBLIC_URL over Vercel's host", () => {
    cleanEnv({ PUBLIC_URL: "https://dawmain.example", VERCEL_PROJECT_PRODUCTION_URL: "other.example" });
    expect(productionOrigin()).toBe("https://dawmain.example");
  });

  it.each(["javascript:alert(1)", "https://evil.example/<script>", "https://a.example/path", "dawmain.example", "ftp://x.example"])(
    "ignores %s (only a plain origin is ever put into a link)",
    (value) => {
      cleanEnv({ PUBLIC_URL: value });
      expect(productionOrigin()).toBeNull();
    },
  );

  it("is null with nothing configured", () => {
    cleanEnv();
    expect(productionOrigin()).toBeNull();
  });
});

describe("forwardedHostTrusted and what depends on it", () => {
  const forged = () =>
    new Request("http://dawmain.davidzavada.cz/api/files/documents", {
      method: "POST",
      headers: {
        host: "dawmain.davidzavada.cz",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });

  it("is on by default and off for 0 / false / off / no", () => {
    cleanEnv();
    expect(forwardedHostTrusted()).toBe(true);
    for (const value of ["0", "false", "off", "no"]) {
      cleanEnv({ TRUST_FORWARDED_HOST: value });
      expect(forwardedHostTrusted()).toBe(false);
    }
  });

  it("sameOrigin follows x-forwarded-host while trusted (Vercel)", () => {
    cleanEnv();
    expect(sameOrigin(forged())).toBe(true);
  });

  it("sameOrigin ignores a client-sent x-forwarded-host at home", () => {
    cleanEnv({ TRUST_FORWARDED_HOST: "0" });
    expect(sameOrigin(forged())).toBe(false);
    const own = new Request("http://dawmain.davidzavada.cz/api/files/documents", {
      method: "POST",
      headers: { host: "dawmain.davidzavada.cz", origin: "https://dawmain.davidzavada.cz" },
    });
    expect(sameOrigin(own)).toBe(true);
  });

  it("the Zotero callback origin takes the forwarded host only while trusted", () => {
    const request = () =>
      new Request("http://127.0.0.1:3000/api/zotero/connect", {
        headers: { host: "dawmain.davidzavada.cz", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      });
    cleanEnv();
    expect(publicOrigin(request())).toBe("https://evil.example");
    cleanEnv({ TRUST_FORWARDED_HOST: "0" });
    expect(publicOrigin(request())).toBe("https://dawmain.davidzavada.cz");
  });

  it("the advertised OAuth origin is the fixed PUBLIC_URL at home, never http://", () => {
    // Behind the tunnel the Node server sees plain http and no x-forwarded-host.
    const behindTunnel = new Request("http://dawmain.davidzavada.cz/.well-known/oauth-protected-resource", {
      headers: { host: "dawmain.davidzavada.cz", "x-forwarded-proto": "https" },
    });
    cleanEnv({ TRUST_FORWARDED_HOST: "0", PUBLIC_URL: "https://dawmain.davidzavada.cz" });
    expect(requestOrigin(behindTunnel)).toBe("https://dawmain.davidzavada.cz");
    expect(challengeOrigin()).toBe("https://dawmain.davidzavada.cz");
  });

  it("on Vercel the advertised origin still comes from the request (previews keep their own)", () => {
    cleanEnv({ VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "dawmain.davidzavada.cz" });
    const preview = new Request("http://internal/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-host": "dawmain-git-x.vercel.app", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(preview)).toBe("https://dawmain-git-x.vercel.app");
    expect(challengeOrigin()).toBeUndefined();
  });
});
