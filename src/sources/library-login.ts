import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { SourceError } from "./shared/errors";
import { fetchUpstream, readBodyCapped } from "./shared/http";
import { looksLikeHtml } from "./shared/html";
import { assertPublicUrl } from "./shared/publicurl";
import { TtlCache, memoKey } from "./shared/cache";
import type { LibraryId, ReaderCredential } from "../mcp/credentials";

/**
 * Opening a licensed work the way a reader does: through the library's
 * proxy, signed in with the reader's own login.
 *
 * Both libraries front their licensed content with EZproxy —
 * `https://<proxy>/login?url=<work>` — and hand the sign-in to an identity
 * provider: the Peace Palace to its SimpleSAMLphp IdP (peacepalacelibrary.nl,
 * via OCLC's Shibboleth SP shib.oclc.org — the login-page URL the user
 * supplied), Charles University to Shibboleth → CAS (cas.cuni.cz; the CAS
 * form was captured: username, password, hidden execution + _eventId).
 * The exact redirect chains were NOT captured, so nothing here hard-codes
 * them: the walker behaves like a browser with a cookie jar — follows
 * redirects, fills in the password form of the library's own sign-in hosts,
 * auto-posts the forms an IdP hands back (SAMLResponse, "continue" pages
 * made of hidden fields), and stops at the first page that is neither.
 * Which page that is, and whether the login was accepted, is what the
 * caller reads back. Unverified hostnames are marked and env-overridable;
 * a chain that does not fit is reported, never guessed through.
 *
 * Two rules protect the reader: the password is posted ONLY to a form on
 * one of the library's own sign-in hosts — a catalogue record can link to
 * any site, and a page with a password box is not thereby the library —
 * and a refused login is not retried for a while, so a stale password
 * cannot lock the account by being replayed on every read. Every hop
 * passes the public-address guard: an IdP redirect is a link like any
 * other.
 */

export const SOURCE = "přihlášení čtenáře (knihovní proxy)";
const MAX_HOPS = 25;
const HOP_TIMEOUT_MS = 20_000;
/** A reader's proxy session lives this long on a warm instance. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** A refused login is not replayed for this long. */
const REFUSAL_TTL_MS = 30 * 60 * 1000;

export interface LibraryProxy {
  id: LibraryId;
  label: string;
  /** EZproxy base — `${proxyBase}/login?url=<target>` starts the session. */
  proxyBase: string;
  /** True when the host comes from the capture, not from memory. */
  verified: boolean;
  note: string;
  /** Hosts that may receive the reader's username and password. */
  loginHosts: RegExp[];
}

export function libraryProxies(): Record<LibraryId, LibraryProxy> {
  return {
    peacepalace: {
      id: "peacepalace",
      label: "Peace Palace Library",
      // Host verbatim from the capture: every licensed access link the
      // Discovery SPA builds points at peacepalace.idm.oclc.org/login?url=….
      proxyBase: "https://peacepalace.idm.oclc.org",
      verified: true,
      note: "OCLC-hosted EZproxy; sign-in via SAML at peacepalacelibrary.nl",
      // The library's own IdP (the login page the user supplied) and OCLC's
      // SP/proxy hosts that front it.
      loginHosts: [/(^|\.)peacepalacelibrary\.nl$/i, /(^|\.)oclc\.org$/i],
    },
    cuni: {
      id: "cuni",
      label: "Univerzita Karlova",
      // From memory of the university's remote-access service, not from a
      // capture — override with CUNI_PROXY_BASE when it differs.
      proxyBase: (process.env.CUNI_PROXY_BASE?.trim() || "https://ezproxy.is.cuni.cz").replace(/\/+$/, ""),
      verified: false,
      note: "EZproxy of the university (host unverified); sign-in via Shibboleth → CAS",
      loginHosts: [/(^|\.)cuni\.cz$/i],
    },
  };
}

export function proxyLoginUrl(proxyBase: string, target: string): string {
  return `${proxyBase}/login?url=${encodeURIComponent(target)}`;
}

/** Is `host` one of the library's sign-in hosts? Pure. */
export function isLoginHost(host: string, loginHosts: RegExp[]): boolean {
  const lower = host.toLowerCase();
  return loginHosts.some((pattern) => pattern.test(lower));
}

/** Proxy hosts whose `login?url=` wrapper is worth unwrapping: OCLC's
 * per-library EZproxy domains and the university's, by exact label — a
 * hostname merely containing "ezproxy" is anyone's. */
function isKnownProxyHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (/(^|\.)idm\.oclc\.org$/.test(lower)) return true;
  const cuniHost = new URL(libraryProxies().cuni.proxyBase).hostname.toLowerCase();
  return lower === cuniHost;
}

/**
 * The work behind a library-wrapped link: `…idm.oclc.org/login?url=X`, the
 * university proxy's `login?url=X`, and OCLC's `linker2.worldcat.org/?jHome=
 * <encoded proxied link>` (which wraps the former). Null for an ordinary
 * link. Pure — unit-tested.
 */
export function unwrapProxiedLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.hostname === "linker2.worldcat.org") {
    const home = url.searchParams.get("jHome");
    return home ? (unwrapProxiedLink(home) ?? home) : null;
  }
  if (isKnownProxyHost(url.hostname) && url.pathname === "/login") {
    const target = url.searchParams.get("url") ?? url.searchParams.get("qurl");
    return target && /^https?:\/\//i.test(target) ? target : null;
  }
  return null;
}

// ---------- cookie jar ----------

/**
 * Cookies per domain — a proxy session must not travel to the publisher,
 * nor the IdP's to the proxy. A Domain attribute is honoured only when the
 * responding host is that domain or lies under it (RFC 6265 §5.3), so no
 * site can plant a cookie for another. Path and expiry are ignored: a
 * login chain is seconds long, and a sibling path is harmless.
 */
export class CookieJar {
  private readonly store = new Map<string, Map<string, string>>();

  absorb(response: Response, url: URL): void {
    const host = url.hostname.toLowerCase();
    for (const raw of response.headers.getSetCookie()) {
      const parts = raw.split(";").map((part) => part.trim());
      const eq = parts[0].indexOf("=");
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq).trim();
      const value = parts[0].slice(eq + 1).trim();
      let domain = host;
      for (const attr of parts.slice(1)) {
        const [key, attrValue] = attr.split("=");
        if (key.toLowerCase() !== "domain" || !attrValue) continue;
        const asked = attrValue.trim().replace(/^\./, "").toLowerCase();
        // Only a domain the responder belongs to, and never a bare TLD.
        if (asked.includes(".") && (host === asked || host.endsWith(`.${asked}`))) domain = asked;
      }
      const bucket = this.store.get(domain) ?? new Map<string, string>();
      bucket.set(name, value);
      this.store.set(domain, bucket);
    }
  }

  header(url: URL): string {
    const host = url.hostname.toLowerCase();
    const pairs: string[] = [];
    for (const [domain, bucket] of this.store) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        for (const [name, value] of bucket) pairs.push(`${name}=${value}`);
      }
    }
    return pairs.join("; ");
  }

  get size(): number {
    let n = 0;
    for (const bucket of this.store.values()) n += bucket.size;
    return n;
  }
}

// ---------- forms ----------

export interface FoundForm {
  action: string;
  method: "GET" | "POST";
  /** Every field a browser would submit, hidden ones and the first named
   * submit button included. */
  fields: Record<string, string>;
  usernameField: string | null;
  passwordField: string | null;
  /** A form made of hidden fields only — an IdP's SAMLResponse hand-off or
   * a "continue" page — which a browser would submit on load. */
  autoPost: boolean;
}

/**
 * The form on a page that wants a login (has a password input) or that an
 * IdP wants posted on (hidden fields only: SAMLResponse, RelayState,
 * Shibboleth's _eventId_proceed…). CAS's page also carries an e-Identity
 * form without a password field — the password one wins. Pure —
 * unit-tested against the captured CAS page shape.
 */
export function findLoginForm(html: string, baseUrl: string): FoundForm | null {
  const $ = cheerio.load(html);
  const forms = $("form").toArray();
  const isVisibleInput = (type: string) => !["hidden", "submit", "button", "image", "file", "reset"].includes(type);
  const withPassword = forms.find((form) => $(form).find("input[type='password']").length > 0);
  const hiddenOnly = forms.find((form) => {
    const $form = $(form);
    if ($form.find("select, textarea").length) return false;
    const inputs = $form.find("input").toArray();
    const named = inputs.filter((el) => $(el).attr("name"));
    return named.length > 0 && named.every((el) => !isVisibleInput(($(el).attr("type") ?? "text").toLowerCase()));
  });
  const form = withPassword ?? hiddenOnly;
  if (!form) return null;
  const $form = $(form);
  const fields: Record<string, string> = {};
  $form.find("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (["submit", "button", "image", "file", "reset"].includes(type)) return;
    if ((type === "checkbox" || type === "radio") && $el.attr("checked") === undefined) return;
    if (el.tagName === "select") {
      fields[name] = $el.find("option[selected]").attr("value") ?? $el.find("option").first().attr("value") ?? "";
      return;
    }
    fields[name] = $el.attr("value") ?? $el.text() ?? "";
  });
  // A browser sends the clicked submit button too; Shibboleth's
  // _eventId_proceed and the like ride on it.
  const submit = $form.find("button[type='submit'][name], input[type='submit'][name], button:not([type])[name]").first();
  const submitName = submit.attr("name");
  if (submitName && !(submitName in fields)) fields[submitName] = submit.attr("value") ?? "";
  const passwordField = $form.find("input[type='password']").first().attr("name") ?? null;
  const usernameField =
    $form.find("input[name='username'], input[name='j_username'], input[name='user'], input[name='login'], input[autocomplete='username']").first().attr("name") ??
    $form
      .find("input[type='text'], input[type='email'], input:not([type])")
      .toArray()
      .map((el) => $(el).attr("name"))
      .find((name): name is string => Boolean(name) && name !== passwordField) ??
    null;
  let action: string;
  try {
    action = new URL($form.attr("action") ?? "", baseUrl).href;
  } catch {
    action = baseUrl;
  }
  return {
    action,
    method: ($form.attr("method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET",
    fields,
    usernameField,
    passwordField,
    autoPost: !withPassword && Boolean(hiddenOnly),
  };
}

// ---------- the walk ----------

export interface WalkResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  hops: string[];
  /** A sign-in host asked for a login and no credential was given. */
  loginRequired: boolean;
  /** A credential was posted on the way. */
  submittedLogin: boolean;
}

export interface WalkOptions {
  credential?: ReaderCredential;
  /** Hosts that may receive the credential; without it nothing is posted. */
  loginHosts?: RegExp[];
  jar?: CookieJar;
  maxHops?: number;
  timeoutMs?: number;
}

function encodeForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** A form submission as a browser would send it: GET puts the fields on
 * the URL, POST in a urlencoded body. Pure. */
export function formRequest(form: FoundForm, fields: Record<string, string>): { url: string; method: "GET" | "POST"; body?: string } {
  if (form.method === "GET") {
    const url = new URL(form.action);
    for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    return { url: url.href, method: "GET" };
  }
  return { url: form.action, method: "POST", body: encodeForm(fields) };
}

/**
 * Follow a URL the way a browser with a cookie jar would, until a page
 * that is neither a redirect, a sign-in form nor an auto-posting hand-off.
 * The credential goes to a password form on one of `loginHosts` — once; if
 * that form comes back again the login was refused. A password box on any
 * other host is not a sign-in: the page is returned as content and the
 * caller's wall heuristics decide.
 */
export async function walk(startUrl: string, options: WalkOptions = {}): Promise<WalkResult> {
  const jar = options.jar ?? new CookieJar();
  const maxHops = options.maxHops ?? MAX_HOPS;
  const timeoutMs = options.timeoutMs ?? HOP_TIMEOUT_MS;
  const loginHosts = options.loginHosts ?? [];
  const hops: string[] = [];
  let url = startUrl;
  let method: "GET" | "POST" = "GET";
  let body: string | undefined;
  let submitted = 0;
  let autoPosts = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    const target = await assertPublicUrl(SOURCE, url);
    hops.push(target.href);
    const cookie = jar.header(target);
    const response = await fetchUpstream(SOURCE, target.href, {
      method,
      headers: {
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
        "accept-language": "en,cs;q=0.8",
        ...(cookie ? { cookie } : {}),
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      redirect: "manual",
      retry: false,
      timeoutMs,
    });
    jar.absorb(response, target);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, target).href;
      method = "GET";
      body = undefined;
      continue;
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const bytes = await readBodyCapped(SOURCE, response);
    const isHtml = contentType.includes("html") || (!contentType.includes("pdf") && looksLikeHtml(new TextDecoder().decode(bytes.slice(0, 4_000))));
    if (isHtml) {
      const form = findLoginForm(new TextDecoder("utf-8").decode(bytes), target.href);
      if (form?.autoPost && autoPosts < 5) {
        autoPosts++;
        const next = formRequest(form, form.fields);
        url = next.url;
        method = next.method;
        body = next.body;
        continue;
      }
      if (form?.passwordField && isLoginHost(target.hostname, loginHosts) && isLoginHost(new URL(form.action).hostname, loginHosts)) {
        if (!options.credential) {
          return { finalUrl: target.href, status: response.status, contentType, body: bytes, hops, loginRequired: true, submittedLogin: submitted > 0 };
        }
        if (submitted >= 1) {
          throw new SourceError(
            SOURCE,
            "SESSION_EXPIRED",
            `${target.hostname} showed the login form again after the credentials were posted.`,
            "The library refused the username/password (or wants a second factor). Check the login on /ucet, or sign in by hand in a browser to see what the library asks for.",
          );
        }
        const next = formRequest(
          { ...form, method: form.method === "GET" ? "POST" : form.method },
          {
            ...form.fields,
            [form.usernameField ?? "username"]: options.credential.username,
            [form.passwordField]: options.credential.password,
          },
        );
        url = next.url;
        method = next.method;
        body = next.body;
        submitted++;
        continue;
      }
    }
    return { finalUrl: target.href, status: response.status, contentType, body: bytes, hops, loginRequired: false, submittedLogin: submitted > 0 };
  }
  throw new SourceError(
    SOURCE,
    "UPSTREAM_ERROR",
    `Gave up after ${maxHops} hops starting at ${startUrl}.`,
    "The login chain loops or is longer than any known one — a HAR of the same sign-in in a browser would show where it goes.",
  );
}

// ---------- reader sessions ----------

const sessions = new TtlCache<CookieJar>(SESSION_TTL_MS, 100);
/** When a library refused a login: ISO time, keyed by reader, library and
 * the credential itself, so a corrected password is tried at once. */
const refusals = new TtlCache<string>(REFUSAL_TTL_MS, 200);

function credentialKey(userId: string, library: LibraryId, credential: ReaderCredential): string {
  const digest = createHash("sha256").update(`${credential.username} ${credential.password}`).digest("hex").slice(0, 16);
  return memoKey("reader-refusal", [userId, library, digest]);
}

/**
 * Open `target` through the reader's library proxy, signing in on the way
 * when the proxy asks. The jar is kept per reader and library for the
 * session's lifetime, so a research session signs in once; a refused login
 * is remembered, so a wrong password is not replayed on every read.
 */
export async function openAsReader(
  library: LibraryId,
  target: string,
  credential: ReaderCredential,
  userId: string,
): Promise<WalkResult & { proxy: LibraryProxy }> {
  const proxy = libraryProxies()[library];
  const refusalKey = credentialKey(userId, library, credential);
  const refusedAt = refusals.get(refusalKey);
  if (refusedAt) {
    throw new SourceError(
      SOURCE,
      "SESSION_EXPIRED",
      `${proxy.label} refused this login at ${refusedAt} — not retried for ${REFUSAL_TTL_MS / 60_000} minutes to protect the account.`,
      "Check the username and password on /ucet; a corrected login is tried at once.",
    );
  }
  const key = memoKey("reader-session", [userId, library]);
  const jar = sessions.get(key) ?? new CookieJar();
  let result: WalkResult;
  try {
    result = await walk(proxyLoginUrl(proxy.proxyBase, target), { credential, loginHosts: proxy.loginHosts, jar });
  } catch (error) {
    if (error instanceof SourceError && error.kind === "SESSION_EXPIRED") refusals.set(refusalKey, new Date().toISOString());
    throw error;
  }
  if (result.loginRequired) {
    throw new SourceError(
      SOURCE,
      "SESSION_EXPIRED",
      `${proxy.label}: the proxy still asks for a login after the walk.`,
      "The sign-in chain of this library does not fit the walker — capture the browser's login flow so it can be pinned.",
    );
  }
  sessions.set(key, jar);
  return { ...result, proxy };
}
