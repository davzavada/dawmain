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
  "NODE_ENV",
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

  it("is on when DAWMAIN_REQUIRE_AUTH is set, with no token and no Clerk", () => {
    cleanEnv({ DAWMAIN_REQUIRE_AUTH: "1" });
    expect(authRequired()).toBe(true);
  });

  it("is on in a production server without the flag (a lost line in the unit must not open the endpoint)", () => {
    cleanEnv({ NODE_ENV: "production" });
    expect(authForced()).toBe(true);
    expect(authRequired()).toBe(true);
  });

  it("stays off in development and tests without the flag", () => {
    for (const mode of ["development", "test"]) {
      cleanEnv({ NODE_ENV: mode });
      expect(authForced()).toBe(false);
    }
  });

  it("a production build opts out only with an explicit DAWMAIN_REQUIRE_AUTH=0", () => {
    cleanEnv({ NODE_ENV: "production", DAWMAIN_REQUIRE_AUTH: "0" });
    expect(authForced()).toBe(false);
    cleanEnv({ NODE_ENV: "production", DAWMAIN_REQUIRE_AUTH: "ture" });
    expect(authForced()).toBe(true);
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
  it("reads APP_ENV, APP_REGION and GIT_SHA", () => {
    cleanEnv({ APP_ENV: "production", APP_REGION: "home", GIT_SHA: "abcdef0123456789" });
    expect(appEnvironment()).toBe("production");
    expect(appRegion()).toBe("home");
    expect(gitCommit()).toBe("abcdef0");
  });

  it("falls back to local / null", () => {
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

  it("is off by default and for 0 / false / off / no, on only when set otherwise", () => {
    cleanEnv();
    expect(forwardedHostTrusted()).toBe(false);
    for (const value of ["0", "false", "off", "no"]) {
      cleanEnv({ TRUST_FORWARDED_HOST: value });
      expect(forwardedHostTrusted()).toBe(false);
    }
    cleanEnv({ TRUST_FORWARDED_HOST: "1" });
    expect(forwardedHostTrusted()).toBe(true);
  });

  it("sameOrigin follows x-forwarded-host only where explicitly trusted", () => {
    cleanEnv({ TRUST_FORWARDED_HOST: "1" });
    expect(sameOrigin(forged())).toBe(true);
  });

  it("sameOrigin ignores a client-sent x-forwarded-host by default and with TRUST_FORWARDED_HOST=0", () => {
    cleanEnv();
    expect(sameOrigin(forged())).toBe(false);
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
    cleanEnv({ TRUST_FORWARDED_HOST: "1" });
    expect(publicOrigin(request())).toBe("https://evil.example");
    cleanEnv();
    expect(publicOrigin(request())).toBe("https://dawmain.davidzavada.cz");
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

  it("without PUBLIC_URL (npm run dev) the advertised origin is the request's own", () => {
    cleanEnv();
    const local = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
      headers: { host: "localhost:3000", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(local)).toBe("http://localhost:3000");
    expect(challengeOrigin()).toBeUndefined();
  });

  it("behind a trusted proxy the advertised origin comes from its X-Forwarded-* headers", () => {
    cleanEnv({ TRUST_FORWARDED_HOST: "1", PUBLIC_URL: "https://dawmain.davidzavada.cz" });
    const proxied = new Request("http://internal/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-host": "staging.example", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(proxied)).toBe("https://staging.example");
    expect(challengeOrigin()).toBeUndefined();
  });
});
