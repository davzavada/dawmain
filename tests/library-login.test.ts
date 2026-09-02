import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieJar,
  findLoginForm,
  formRequest,
  isLoginHost,
  libraryProxies,
  openAsReader,
  proxyLoginUrl,
  unwrapProxiedLink,
  walk,
} from "@/src/sources/library-login";
import { SourceError } from "@/src/sources/shared/errors";

// Every host here is fictional — resolve them all to a public address so the
// guard runs its logic without a network.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

const CAS_HTML = readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", "cas-login-form.html"), "utf8");

describe("unwrapProxiedLink / proxyLoginUrl", () => {
  it("finds the work behind EZproxy and OCLC linker wrappers", () => {
    expect(unwrapProxiedLink("https://peacepalace.idm.oclc.org/login?url=https://www.taylorfrancis.com/books/9781003697534")).toBe(
      "https://www.taylorfrancis.com/books/9781003697534",
    );
    expect(unwrapProxiedLink("https://ezaccess.libraries.psu.edu/login?url=https://www.heinonline.org/HOL/Page?handle=x")).toBeNull();
    expect(unwrapProxiedLink("https://ezproxy.is.cuni.cz/login?url=https://link.springer.com/book/1")).toBe("https://link.springer.com/book/1");
    // The capture's linker2 form wraps the proxied link inside jHome.
    expect(
      unwrapProxiedLink(
        "https://linker2.worldcat.org/?jHome=https%3A%2F%2Fpeacepalace.idm.oclc.org%2Flogin%3Furl%3Dhttps%3A%2F%2Fwww.taylorfrancis.com%2Fbooks%2F9781003697534&linktype=best",
      ),
    ).toBe("https://www.taylorfrancis.com/books/9781003697534");
    expect(unwrapProxiedLink("https://www.taylorfrancis.com/books/9781003697534")).toBeNull();
    expect(unwrapProxiedLink("not a url")).toBeNull();
  });
  it("builds the EZproxy entry URL", () => {
    expect(proxyLoginUrl("https://peacepalace.idm.oclc.org", "https://x.test/a?b=1")).toBe(
      "https://peacepalace.idm.oclc.org/login?url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1",
    );
    expect(libraryProxies().peacepalace.verified).toBe(true);
    expect(libraryProxies().cuni.verified).toBe(false);
  });
});

describe("CookieJar", () => {
  it("keeps cookies per domain and hands them only to that domain and its subdomains", () => {
    const jar = new CookieJar();
    jar.absorb(new Response(null, { headers: [["set-cookie", "ezproxy=abc; Path=/; HttpOnly"], ["set-cookie", "shared=1; Domain=.idm.oclc.org"]] }), new URL("https://peacepalace.idm.oclc.org/login"));
    jar.absorb(new Response(null, { headers: [["set-cookie", "JSESSIONID=cas1"]] }), new URL("https://cas.cuni.cz/cas/login"));
    expect(jar.header(new URL("https://peacepalace.idm.oclc.org/connect"))).toBe("ezproxy=abc; shared=1");
    expect(jar.header(new URL("https://www-taylorfrancis-com.idm.oclc.org/x"))).toBe("shared=1");
    expect(jar.header(new URL("https://cas.cuni.cz/cas/login"))).toBe("JSESSIONID=cas1");
    expect(jar.header(new URL("https://www.taylorfrancis.com/books/1"))).toBe("");
    expect(jar.size).toBe(3);
  });

  it("ignores a Domain attribute the responder does not belong to", () => {
    const jar = new CookieJar();
    jar.absorb(new Response(null, { headers: [["set-cookie", "planted=1; Domain=oclc.org"], ["set-cookie", "tld=1; Domain=org"]] }), new URL("https://publisher.test/x"));
    expect(jar.header(new URL("https://peacepalace.idm.oclc.org/login"))).toBe("");
    expect(jar.header(new URL("https://publisher.test/y"))).toBe("planted=1; tld=1");
  });
});

describe("findLoginForm", () => {
  it("picks the captured CAS form with its hidden flow fields, not the e-Identity one", () => {
    const form = findLoginForm(CAS_HTML, "https://cas.cuni.cz/cas/login?service=https%3A%2F%2Fidp.cuni.cz%2Fidp%2FAuthn%2FExternal");
    expect(form).not.toBeNull();
    expect(form!.action).toBe("https://cas.cuni.cz/cas/login");
    expect(form!.method).toBe("POST");
    expect(form!.usernameField).toBe("username");
    expect(form!.passwordField).toBe("password");
    expect(form!.fields._eventId).toBe("submit");
    expect(form!.fields.execution).toMatch(/…$/);
    expect(form!.fields).not.toHaveProperty("client_name");
    expect(form!.autoPost).toBe(false);
  });
  it("recognises a SimpleSAMLphp login form and an IdP auto-post form", () => {
    const ssp = findLoginForm(
      `<form action="?" method="post"><input type="text" name="username"><input type="password" name="password"><input type="hidden" name="AuthState" value="_abc:https://x"><button name="login" type="submit">Login</button></form>`,
      "https://peacepalacelibrary.nl/saml/module.php/core/loginuserpass?AuthState=_abc",
    );
    expect(ssp!.action).toBe("https://peacepalacelibrary.nl/saml/module.php/core/loginuserpass?");
    expect(ssp!.fields.AuthState).toBe("_abc:https://x");
    const saml = findLoginForm(
      `<html><body onload="document.forms[0].submit()"><form method="post" action="https://shib.oclc.org/Shibboleth.sso/SAML2/POST"><input type="hidden" name="SAMLResponse" value="PHNhbWw+"/><input type="hidden" name="RelayState" value="ss:mem:1"/><noscript><input type="submit" value="Submit"/></noscript></form></body></html>`,
      "https://peacepalacelibrary.nl/saml/saml2/idp/SSOService.php",
    );
    expect(saml!.autoPost).toBe(true);
    expect(saml!.fields).toEqual({ SAMLResponse: "PHNhbWw+", RelayState: "ss:mem:1" });
    expect(saml!.passwordField).toBeNull();
    expect(findLoginForm("<html><body><p>The work</p></body></html>", "https://x.test/")).toBeNull();
  });
});

/**
 * A stub of a whole CAS-style chain: proxy → IdP redirect → CAS form →
 * (credentials posted) → ticket redirect → proxy sets its session → the
 * proxied publisher page. Records every request so the tests can read the
 * chain back.
 */
function casChain(acceptPassword = "correct") {
  const requests: Array<{ url: string; method: string; body?: string; cookie?: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined, cookie: headers.cookie });
    const u = new URL(url);
    if (u.hostname === "ezproxy.is.cuni.cz" && u.searchParams.has("ticket")) {
      return new Response(null, { status: 302, headers: { location: "https://www-publisher-com.ezproxy.is.cuni.cz/book/1", "set-cookie": "ezproxy=session1; Domain=.ezproxy.is.cuni.cz; Path=/" } });
    }
    if (u.hostname === "ezproxy.is.cuni.cz" && u.pathname === "/login") {
      if (headers.cookie?.includes("ezproxy=session1")) {
        return new Response(null, { status: 302, headers: { location: "https://www-publisher-com.ezproxy.is.cuni.cz/book/1" } });
      }
      return new Response(null, { status: 302, headers: { location: "https://cas.cuni.cz/cas/login?service=https%3A%2F%2Fezproxy.is.cuni.cz%2Flogin%3Furl%3D" + encodeURIComponent(u.searchParams.get("url") ?? "") } });
    }
    if (u.hostname === "cas.cuni.cz" && init.method !== "POST") {
      return new Response(CAS_HTML.replace('action="login"', 'action="https://cas.cuni.cz/cas/login?service=x"'), { status: 200, headers: { "content-type": "text/html;charset=utf-8", "set-cookie": "JSESSIONID=cas42; Path=/cas; HttpOnly" } });
    }
    if (u.hostname === "cas.cuni.cz" && init.method === "POST") {
      const params = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      if (params.get("password") !== acceptPassword) {
        return new Response(CAS_HTML, { status: 401, headers: { "content-type": "text/html" } });
      }
      return new Response(null, { status: 302, headers: { location: "https://ezproxy.is.cuni.cz/login?url=https%3A%2F%2Fpublisher.test%2Fbook%2F1&ticket=ST-1" } });
    }
    if (u.hostname === "www-publisher-com.ezproxy.is.cuni.cz") {
      return new Response(`<html><body><article>${"<p>The licensed chapter text about genocide, dolus specialis and the Rome Statute.</p>".repeat(60)}</article></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return requests;
}

describe("walk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs in through a CAS chain, posting the hidden flow fields with the credentials, and lands on the work", async () => {
    const requests = casChain();
    const result = await walk("https://ezproxy.is.cuni.cz/login?url=https%3A%2F%2Fpublisher.test%2Fbook%2F1", {
      credential: { username: "reader", password: "correct" },
      loginHosts: libraryProxies().cuni.loginHosts,
    });
    expect(result.loginRequired).toBe(false);
    expect(result.submittedLogin).toBe(true);
    expect(result.finalUrl).toBe("https://www-publisher-com.ezproxy.is.cuni.cz/book/1");
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toContain("dolus specialis");
    const post = requests.find((r) => r.method === "POST")!;
    const params = new URLSearchParams(post.body);
    expect(post.url).toBe("https://cas.cuni.cz/cas/login?service=x");
    expect(params.get("username")).toBe("reader");
    expect(params.get("password")).toBe("correct");
    expect(params.get("_eventId")).toBe("submit");
    expect(params.get("execution")).toMatch(/…$/);
    expect(post.cookie).toContain("JSESSIONID=cas42");
    // The publisher never sees the CAS cookie; the proxy session travels to the proxied host.
    const publisher = requests.find((r) => r.url.startsWith("https://www-publisher-com.ezproxy.is.cuni.cz"))!;
    expect(publisher.cookie).toBe("ezproxy=session1");
    // proxy → CAS form → CAS POST → proxy with ticket → the proxied publisher page
    expect(result.hops).toHaveLength(5);
  });

  it("stops at the login form without a credential and says so", async () => {
    casChain();
    const result = await walk("https://ezproxy.is.cuni.cz/login?url=https%3A%2F%2Fpublisher.test%2Fbook%2F1", { loginHosts: libraryProxies().cuni.loginHosts });
    expect(result.loginRequired).toBe(true);
    expect(result.finalUrl).toMatch(/^https:\/\/cas\.cuni\.cz\/cas\/login/);
  });

  it("reports a refused password instead of looping", async () => {
    casChain("other");
    await expect(
      walk("https://ezproxy.is.cuni.cz/login?url=https%3A%2F%2Fpublisher.test%2Fbook%2F1", {
        credential: { username: "reader", password: "wrong" },
        loginHosts: libraryProxies().cuni.loginHosts,
      }),
    ).rejects.toMatchObject({ kind: "SESSION_EXPIRED" });
  });

  it("never posts the credential to a host that is not the library's sign-in", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET" });
      // A publisher page with a sign-in widget in its header — and the work below it.
      return new Response(
        `<html><body><form method="post" action="https://evil.test/steal"><input name="username"><input type="password" name="password"></form><article>${"<p>The chapter text.</p>".repeat(200)}</article></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    const result = await walk("https://publisher.test/chapter/1", { credential: { username: "reader", password: "secret" }, loginHosts: libraryProxies().cuni.loginHosts });
    expect(requests).toEqual([{ url: "https://publisher.test/chapter/1", method: "GET" }]);
    expect(result.loginRequired).toBe(false);
    expect(result.submittedLogin).toBe(false);
    expect(new TextDecoder().decode(result.body)).toContain("The chapter text.");
    expect(isLoginHost("https://cas.cuni.cz/cas/login", libraryProxies().cuni.loginHosts)).toBe(true);
    expect(isLoginHost("https://idp.cuni.cz/idp/x", libraryProxies().cuni.loginHosts)).toBe(true);
    expect(isLoginHost("https://ezproxy.is.cuni.cz/login", libraryProxies().cuni.loginHosts)).toBe(true);
    // EZproxy's rewritten publisher host and its port mode are the publisher, not the library.
    expect(isLoginHost("https://www-publisher-com.ezproxy.is.cuni.cz/book/1", libraryProxies().cuni.loginHosts)).toBe(false);
    expect(isLoginHost("https://ezproxy.is.cuni.cz:2048/book/1", libraryProxies().cuni.loginHosts)).toBe(false);
    expect(isLoginHost("https://cuni.cz.evil.test/", libraryProxies().cuni.loginHosts)).toBe(false);
    expect(isLoginHost("https://shib.oclc.org/Shibboleth.sso/Login", libraryProxies().peacepalace.loginHosts)).toBe(true);
    expect(isLoginHost("https://www-taylorfrancis-com.peacepalace.idm.oclc.org/x", libraryProxies().peacepalace.loginHosts)).toBe(false);
  });

  it("does not hand the password to a publisher served through the proxy's rewritten host", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET" });
      const u = new URL(url);
      if (u.hostname === "ezproxy.is.cuni.cz") return new Response(null, { status: 302, headers: { location: "https://www-publisher-com.ezproxy.is.cuni.cz/doi/10.1000/x" } });
      // An Atypon-style page: the publisher's own sign-in form in the markup, paywalled abstract below.
      return new Response(`<html><body><form method="post" action="/action/doLogin"><input name="login"><input type="password" name="password"></form><p>Abstract. Sign in to read. Purchase this article.</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    });
    const result = await walk("https://ezproxy.is.cuni.cz/login?url=https%3A%2F%2Fpublisher.test%2Fdoi%2F10.1000%2Fx", {
      credential: { username: "reader", password: "secret" },
      loginHosts: libraryProxies().cuni.loginHosts,
    });
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(result.submittedLogin).toBe(false);
    expect(result.loginRequired).toBe(false);
  });

  it("auto-posts a hidden-only hand-off on a sign-in host with its submit button, and only there", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
      const u = new URL(url);
      if (u.hostname === "idp.cuni.cz" && init.method !== "POST") {
        return new Response(`<form method="post" action="/idp/profile/SAML2/Redirect/SSO?execution=e1s2"><input type="hidden" name="csrf_token" value="t1"><button type="submit" name="_eventId_proceed" id="_eventId_proceed">Continue</button></form>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u.hostname === "idp.cuni.cz" && init.method === "POST") {
        return new Response(null, { status: 302, headers: { location: "https://publisher.test/landing" } });
      }
      if (u.hostname === "publisher.test") {
        // A hidden-only form WITHOUT a hand-off field, on a host that is not a sign-in host: content, not a hand-off.
        return new Response(`<html><body><form method="post" action="https://tracker.test/beacon"><input type="hidden" name="csrf" value="x"></form>${"<p>Landing page text.</p>".repeat(300)}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    });
    const result = await walk("https://idp.cuni.cz/idp/profile/SAML2/Redirect/SSO?execution=e1s2", { loginHosts: libraryProxies().cuni.loginHosts });
    expect(requests[1]).toEqual({ url: "https://idp.cuni.cz/idp/profile/SAML2/Redirect/SSO?execution=e1s2", method: "POST", body: "csrf_token=t1&_eventId_proceed=" });
    expect(requests).toHaveLength(3);
    expect(result.finalUrl).toBe("https://publisher.test/landing");
    // The same hand-off page on the open path (no sign-in hosts) is returned as content, never posted.
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push({ url, method: "GET" });
      return new Response(`<form method="post" action="https://sp.test/acs"><input type="hidden" name="SAMLResponse" value="x"></form>`, { status: 200, headers: { "content-type": "text/html" } });
    });
    const open = await walk("https://idp.other.test/handoff");
    expect(open.finalUrl).toBe("https://idp.other.test/handoff");
    expect(requests.at(-1)?.method).toBe("GET");
    expect(formRequest({ action: "https://x.test/a?k=1", method: "GET", fields: {}, usernameField: null, passwordField: null, autoPost: false }, { b: "2 3" })).toEqual({ url: "https://x.test/a?k=1&b=2+3", method: "GET" });
  });

  it("auto-posts an IdP's SAMLResponse form on the way back to the service provider", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
      const u = new URL(url);
      if (u.hostname === "idp.test" && init.method !== "POST") {
        return new Response(`<form method="post" action="/saml/loginuserpass?AuthState=_s1"><input name="username"><input type="password" name="password"><input type="hidden" name="AuthState" value="_s1"></form>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u.hostname === "idp.test" && init.method === "POST" && u.pathname.endsWith("loginuserpass")) {
        return new Response(`<html><body onload="document.forms[0].submit()"><form method="post" action="https://sp.test/Shibboleth.sso/SAML2/POST"><input type="hidden" name="SAMLResponse" value="PHNhbWw+"><input type="hidden" name="RelayState" value="rs1"></form></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u.hostname === "sp.test") {
        expect(init.method).toBe("POST");
        expect(init.body).toBe("SAMLResponse=PHNhbWw%2B&RelayState=rs1");
        return new Response(null, { status: 302, headers: { location: "https://proxy.test/connect?session=abc", "set-cookie": "_shibsession_x=1; Path=/" } });
      }
      if (u.hostname === "proxy.test") {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("not found", { status: 404 });
    });
    const result = await walk("https://idp.test/saml/idp/SSOService.php?SAMLRequest=x", { credential: { username: "u", password: "p" }, loginHosts: [/^idp\.test$/] });
    expect(result.contentType).toBe("application/pdf");
    expect(result.finalUrl).toBe("https://proxy.test/connect?session=abc");
    expect(requests.map((r) => `${r.method} ${new URL(r.url).hostname}`)).toEqual(["GET idp.test", "POST idp.test", "POST sp.test", "GET proxy.test"]);
  });

  it("gives up on a chain that loops", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "https://loop.test/again" } }));
    await expect(walk("https://loop.test/start", { maxHops: 4 })).rejects.toThrow(/Gave up after 4 hops/);
  });
});

describe("openAsReader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs in once per reader and reuses the proxy session for the next work", async () => {
    const requests = casChain();
    const credential = { username: "reader", password: "correct" };
    const first = await openAsReader("cuni", "https://publisher.test/book/1", credential, "user_1");
    expect(first.proxy.proxyBase).toBe("https://ezproxy.is.cuni.cz");
    expect(first.submittedLogin).toBe(true);
    const posts = requests.filter((r) => r.method === "POST").length;
    const second = await openAsReader("cuni", "https://publisher.test/book/1", credential, "user_1");
    expect(second.submittedLogin).toBe(false);
    expect(requests.filter((r) => r.method === "POST").length).toBe(posts);
    // Another reader gets their own session, hence their own sign-in.
    await openAsReader("cuni", "https://publisher.test/book/1", credential, "user_2");
    expect(requests.filter((r) => r.method === "POST").length).toBe(posts + 1);
  });

  it("remembers a refused login and does not replay it, until the password changes", async () => {
    const requests = casChain("correct");
    const wrong = { username: "reader", password: "wrong" };
    await expect(openAsReader("cuni", "https://publisher.test/book/1", wrong, "user_4")).rejects.toMatchObject({ kind: "SESSION_EXPIRED" });
    const posts = requests.filter((r) => r.method === "POST").length;
    expect(posts).toBe(1);
    await expect(openAsReader("cuni", "https://publisher.test/book/1", wrong, "user_4")).rejects.toThrow(/not retried for 30 minutes/);
    expect(requests.filter((r) => r.method === "POST").length).toBe(posts);
    // A corrected password is tried at once.
    const ok = await openAsReader("cuni", "https://publisher.test/book/1", { username: "reader", password: "correct" }, "user_4");
    expect(ok.submittedLogin).toBe(true);
  });

  it("reports a chain that ends somewhere that is neither the proxy nor the work", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.hostname === "ezproxy.is.cuni.cz") return new Response(null, { status: 302, headers: { location: "https://consent.test/attribute-release" } });
      return new Response(`<html><body><form method="post"><select name="choice"><option value="1">Once</option></select></form>${"<p>Attribute release consent text.</p>".repeat(100)}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    });
    await expect(openAsReader("cuni", "https://publisher.test/book/9", { username: "u", password: "p" }, "user_5")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(openAsReader("cuni", "https://publisher.test/book/9", { username: "u", password: "p" }, "user_5")).rejects.toThrow(/stopped at consent\.test/);
  });

  it("returns a sign-in page on the proxy's own host as loginRequired, not as the work", async () => {
    vi.stubGlobal("fetch", async () => new Response(`<form method="post"><input name="username"><input type="password" name="pw"></form>`, { status: 200, headers: { "content-type": "text/html" } }));
    // The proxy host is a login host; without any credential the walk says so.
    const result = await walk("https://ezproxy.is.cuni.cz/login?url=x", { loginHosts: libraryProxies().cuni.loginHosts });
    expect(result.loginRequired).toBe(true);
  });
});
