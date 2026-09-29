import { describe, expect, it } from "vitest";
import { baseString, hmacSha1, oauthHeader, parseForm, percentEncode } from "@/src/zotero/oauth1";

/**
 * OAuth 1.0a signing (src/zotero/oauth1.ts). zotero.org answers a wrong
 * signature with a bare "invalid signature", so the published vectors are
 * the only way to know the encoding, sorting and key derivation are right
 * before a live connect.
 */

/** OAuth Core 1.0 Appendix A.5 (the same numbers as RFC 5849 §1.2's protected-resource step). */
const A5 = {
  method: "GET",
  url: "http://photos.example.net/photos?file=vacation.jpg&size=original",
  consumerKey: "dpf43f3p2l4k3l03",
  consumerSecret: "kd94hf93k423kf44",
  token: "nnch734d00sl2jdk",
  tokenSecret: "pfkkdhi9sl3r4s00",
  nonce: "kllo9940pd9333jh",
  timestamp: 1191242096,
};
const A5_BASE =
  "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal";
const A5_SIGNATURE = "tR3+Ty81lMeYAr/Fid0kMTYa/WM=";

const A5_OAUTH: Array<[string, string]> = [
  ["oauth_consumer_key", A5.consumerKey],
  ["oauth_token", A5.token],
  ["oauth_signature_method", "HMAC-SHA1"],
  ["oauth_timestamp", String(A5.timestamp)],
  ["oauth_nonce", A5.nonce],
  ["oauth_version", "1.0"],
];

/** The quoted fields of an Authorization header, decoded. */
function headerFields(header: string): Record<string, string> {
  expect(header.startsWith("OAuth ")).toBe(true);
  const out: Record<string, string> = {};
  for (const part of header.slice("OAuth ".length).split(", ")) {
    const match = /^([A-Za-z0-9_%.~-]+)="([A-Za-z0-9%._~-]*)"$/.exec(part);
    expect(match, `malformed header field: ${part}`).not.toBeNull();
    out[decodeURIComponent(match![1])] = decodeURIComponent(match![2]);
  }
  return out;
}

describe("OAuth Core 1.0 Appendix A.5 vector", () => {
  it("builds the exact signature base string", () => {
    expect(baseString(A5.method, A5.url, A5_OAUTH)).toBe(A5_BASE);
  });

  it("signs it to the published HMAC-SHA1 value", () => {
    expect(hmacSha1(A5_BASE, A5.consumerSecret, A5.tokenSecret)).toBe(A5_SIGNATURE);
  });

  it("puts the same signature into the full Authorization header", () => {
    const header = oauthHeader(A5);
    const fields = headerFields(header);
    expect(fields).toEqual({
      oauth_consumer_key: A5.consumerKey,
      oauth_nonce: A5.nonce,
      oauth_signature: A5_SIGNATURE,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(A5.timestamp),
      oauth_token: A5.token,
      oauth_version: "1.0",
    });
    // Encoded on the wire: + / = of the base64 signature are not unreserved.
    expect(header).toContain('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"');
  });
});

describe("RFC 5849 §3.4.1.1 base string", () => {
  it("merges query and body parameters, double-encodes, and sorts by encoded bytes", () => {
    const params: Array<[string, string]> = [
      ["oauth_consumer_key", "9djdj82h48djs9d2"],
      ["oauth_token", "kkk9d7dh3k39sjv7"],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "137131201"],
      ["oauth_nonce", "7d8f3e4a"],
      // realm and the signature are never signed; the signature is dropped here.
      ["oauth_signature", "bYT5CMsGcbgUdFHObYMEfcx6bsw="],
      // The form body "c2&a3=2+q".
      ["c2", ""],
      ["a3", "2 q"],
    ];
    expect(baseString("POST", "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b", params)).toBe(
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
    );
  });

  it("normalises the base URI: lowercase scheme and host, default port dropped, no query or fragment", () => {
    const uri = (url: string) => baseString("get", url, []).split("&")[1];
    expect(baseString("get", "http://example.com/", []).split("&")[0]).toBe("GET");
    expect(uri("HTTP://Photos.Example.NET:80/Photos?x=1#frag")).toBe("http%3A%2F%2Fphotos.example.net%2FPhotos");
    expect(uri("https://www.zotero.org:443/oauth/request")).toBe("https%3A%2F%2Fwww.zotero.org%2Foauth%2Frequest");
    expect(uri("https://www.zotero.org:8443/oauth/request")).toBe("https%3A%2F%2Fwww.zotero.org%3A8443%2Foauth%2Frequest");
    expect(uri("http://example.com:443/")).toBe("http%3A%2F%2Fexample.com%3A443%2F");
    expect(uri("http://example.com")).toBe("http%3A%2F%2Fexample.com%2F");
  });
});

describe("percentEncode", () => {
  it("keeps exactly the RFC 3986 unreserved set", () => {
    const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    expect(percentEncode(unreserved)).toBe(unreserved);
    expect(percentEncode("")).toBe("");
  });

  it("encodes what encodeURIComponent leaves alone, and space as %20 (never +)", () => {
    expect(percentEncode("!*'()")).toBe("%21%2A%27%28%29");
    expect(percentEncode("a b+c")).toBe("a%20b%2Bc");
    expect(percentEncode("%")).toBe("%25");
    expect(percentEncode("/?#[]@:&=$,;")).toBe("%2F%3F%23%5B%5D%40%3A%26%3D%24%2C%3B");
  });

  it("encodes UTF-8 bytes with uppercase hex", () => {
    expect(percentEncode("č")).toBe("%C4%8D");
    expect(percentEncode("Ústavní soud")).toBe("%C3%9Astavn%C3%AD%20soud");
    expect(percentEncode("🔑")).toBe("%F0%9F%94%91");
    // Uppercase hex even where the digits are letters.
    expect(percentEncode("ÿ\n")).toBe("%C3%BF%0A");
  });

  it("does not throw on a lone surrogate (encoded as U+FFFD)", () => {
    expect(percentEncode("a\uD800b")).toBe("a%EF%BF%BDb");
  });
});

describe("oauthHeader", () => {
  const base = {
    method: "POST",
    url: "https://www.zotero.org/oauth/request",
    consumerKey: "ck/with+odd=chars",
    consumerSecret: "cs&secret",
    nonce: "n0nce",
    timestamp: 1_790_000_000,
  };

  it("carries every oauth_* parameter quoted and percent-encoded", () => {
    const callback = "https://dawmain.example/api/zotero/callback?x=a b&y=č";
    const header = oauthHeader({ ...base, extra: { oauth_callback: callback } });
    for (const name of ["oauth_callback", "oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_version"]) {
      expect(header).toMatch(new RegExp(`(?:^OAuth |, )${name}="[^"]+"`));
    }
    expect(header).toContain(`oauth_callback="${percentEncode(callback)}"`);
    expect(header).toContain('oauth_consumer_key="ck%2Fwith%2Bodd%3Dchars"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_version="1.0"');
    // No token on the request-token step.
    expect(header).not.toContain("oauth_token=");
    // Every value quoted, nothing unencoded between the quotes.
    expect(header.slice(6).split(", ").every((field) => /^[a-z_]+="[A-Za-z0-9%._~-]*"$/.test(field))).toBe(true);
  });

  it("signs what it sends: the signature verifies against the header's own fields", () => {
    const header = oauthHeader({ ...base, token: "rt", tokenSecret: "rts", extra: { oauth_verifier: "v3r1f!er" } });
    const fields = headerFields(header);
    expect(fields.oauth_token).toBe("rt");
    expect(fields.oauth_verifier).toBe("v3r1f!er");
    const { oauth_signature, ...signed } = fields;
    expect(oauth_signature).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(hmacSha1(baseString("POST", base.url, Object.entries(signed)), base.consumerSecret, "rts")).toBe(oauth_signature);
    // The token secret is part of the key: another one gives another signature.
    expect(hmacSha1(baseString("POST", base.url, Object.entries(signed)), base.consumerSecret, "other")).not.toBe(oauth_signature);
  });

  it("does not depend on the order of the input parameters", () => {
    const one = oauthHeader({ ...base, bodyParams: [["b", "2"], ["a", "1"], ["a", "0"]] });
    const two = oauthHeader({ ...base, bodyParams: [["a", "0"], ["b", "2"], ["a", "1"]] });
    expect(one).toBe(two);
    const q1 = baseString("GET", "https://x.test/p?z=1&y=2", [["oauth_nonce", "n"], ["oauth_consumer_key", "k"]]);
    const q2 = baseString("GET", "https://x.test/p?y=2&z=1", [["oauth_consumer_key", "k"], ["oauth_nonce", "n"]]);
    expect(q1).toBe(q2);
    // …but it does depend on the values.
    expect(oauthHeader({ ...base, bodyParams: [["a", "1"]] })).not.toBe(oauthHeader({ ...base, bodyParams: [["a", "2"]] }));
  });

  it("defaults to a fresh random hex nonce and the current time in seconds", () => {
    const { nonce: _n, timestamp: _t, ...rest } = base;
    const before = Math.floor(Date.now() / 1000);
    const one = headerFields(oauthHeader(rest));
    const two = headerFields(oauthHeader(rest));
    const after = Math.floor(Date.now() / 1000);
    expect(one.oauth_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(one.oauth_nonce).not.toBe(two.oauth_nonce);
    expect(Number(one.oauth_timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(one.oauth_timestamp)).toBeLessThanOrEqual(after);
  });
});

describe("parseForm", () => {
  it("decodes an x-www-form-urlencoded body", () => {
    expect(parseForm("oauth_token=abc&oauth_token_secret=d%2Fe+f&oauth_callback_confirmed=true\n")).toEqual({
      oauth_token: "abc",
      oauth_token_secret: "d/e f",
      oauth_callback_confirmed: "true",
    });
    expect(parseForm("")).toEqual({});
    expect(parseForm("username=%C4%8Cech&empty=&flag")).toEqual({ username: "Čech", empty: "", flag: "" });
  });

  it("keeps the first of repeated names and treats __proto__ as an ordinary field", () => {
    const form = parseForm("userID=1&userID=2&__proto__=x&constructor=y");
    expect(form.userID).toBe("1");
    expect(form.__proto__).toBe("x");
    expect(form.constructor).toBe("y");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(form)).toBeNull();
  });
});
