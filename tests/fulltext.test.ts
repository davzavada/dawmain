import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDocumentText,
  isPublicAddress,
  looksLikeAccessWall,
  normalizeDoi,
  orderCandidates,
  parseUnpaywall,
} from "@/src/sources/fulltext";
import { SourceError } from "@/src/sources/shared/errors";
import { registerDoctrine } from "@/src/mcp/tools/doctrine";
import type { BibHit } from "@/src/sources/shared/bib";

// Every host in these tests is fictional — resolve them all to a public
// address so the SSRF guard exercises its logic without a network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host.startsWith("private.") ? "10.0.0.5" : "93.184.216.34", family: 4 }],
}));

// The credentials store talks to Clerk; here one reader has a UK login.
vi.mock("@/src/mcp/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/mcp/credentials")>()),
  credentialsConfigured: () => true,
  loadReaderCredentials: async (userId: string) => (userId === "user_with_uk" ? { cuni: { username: "reader", password: "correct" } } : {}),
}));

const fixture = (name: string) => path.join(path.dirname(__dirname), "tests", "fixtures", name);
const json = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8")) as unknown;
const PDF = readFileSync(fixture("pdf/two-pages.pdf"));

describe("parseUnpaywall (verbatim captures)", () => {
  it("reads an open-access record with a PDF location", () => {
    const oa = parseUnpaywall(json("unpaywall/oa-bronze-pdf.json"));
    expect(oa.doi).toBe("10.5117/9789053566312");
    expect(oa.isOa).toBe(true);
    expect(oa.status).toBe("bronze");
    expect(oa.best?.pdfUrl).toBe("https://library.oapen.org/bitstream/20.500.12657/35116/1/340230.pdf");
    expect(oa.locations.length).toBeGreaterThan(0);
  });
  it("reads a closed record", () => {
    const oa = parseUnpaywall(json("unpaywall/closed.json"));
    expect(oa.doi).toBe("10.1163/9789004724822");
    expect(oa.isOa).toBe(false);
    expect(oa.status).toBe("closed");
    expect(oa.best).toBeUndefined();
    expect(oa.locations).toEqual([]);
  });
  it("reads a gold record that has only a landing page", () => {
    const oa = parseUnpaywall(json("unpaywall/oa-gold-landing-only.json"));
    expect(oa.best?.pdfUrl).toBeUndefined();
    expect(oa.best?.landingUrl).toBe("https://directory.doabooks.org/handle/20.500.12854/168486");
    expect(oa.best?.license).toBe("cc-by-nc-nd");
  });
  it("throws PARSE_DRIFT without is_oa", () => {
    expect(() => parseUnpaywall({ message: "nope" })).toThrowError(SourceError);
  });
});

describe("normalizeDoi / isPublicAddress / looksLikeAccessWall", () => {
  it("accepts the DOI in its usual disguises", () => {
    expect(normalizeDoi("10.1163/9789004724822")).toBe("10.1163/9789004724822");
    expect(normalizeDoi("https://doi.org/10.1163/9789004724822")).toBe("10.1163/9789004724822");
    expect(normalizeDoi("doi:10.1093/oso/9780190879679.001.0001")).toBe("10.1093/oso/9780190879679.001.0001");
    expect(normalizeDoi("9789004724822")).toBeNull();
  });
  it("knows a private address from a public one", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:93.184.216.34"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
  it("recognises a login wall by its vocabulary", () => {
    expect(looksLikeAccessWall("Sign in to access this content. Institutional access. Purchase")).toBe(true);
    expect(looksLikeAccessWall("Chapter one. The crime of genocide requires dolus specialis.")).toBe(false);
  });
});

describe("orderCandidates", () => {
  it("puts the explicit link first, then the open copy, the DOI, the record links, proxied links last", () => {
    const candidates = orderCandidates({
      url: "https://repo.test/paper.pdf",
      doi: "10.5117/9789053566312",
      oa: parseUnpaywall(json("unpaywall/oa-bronze-pdf.json")),
      links: [
        "https://linker2.worldcat.org/?jHome=https%3A%2F%2Fpeacepalace.idm.oclc.org%2Flogin",
        "http://public.eblib.com/choice/PublicFullRecord.aspx?p=6476736",
        "https://repo.test/paper.pdf",
      ],
    });
    // The bronze capture names the PDF as both its url and its landing page —
    // one candidate, not two.
    expect(candidates.map((c) => c.url)).toEqual([
      "https://repo.test/paper.pdf",
      "https://library.oapen.org/bitstream/20.500.12657/35116/1/340230.pdf",
      "https://doi.org/10.5117/9789053566312",
      "https://public.eblib.com/choice/PublicFullRecord.aspx?p=6476736",
      "https://linker2.worldcat.org/?jHome=https%3A%2F%2Fpeacepalace.idm.oclc.org%2Flogin",
    ]);
    expect(candidates[1].reason).toMatch(/open-access PDF \(Unpaywall, bronze/);
    expect(candidates.at(-1)?.reason).toMatch(/reader's login/);
  });
  it("skips the open copy when Unpaywall says closed and drops non-https links", () => {
    const candidates = orderCandidates({ doi: "10.1163/9789004724822", oa: parseUnpaywall(json("unpaywall/closed.json")), links: ["ftp://x.test/a"] });
    expect(candidates.map((c) => c.url)).toEqual(["https://doi.org/10.1163/9789004724822"]);
  });
});

describe("fetchDocumentText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts the text of a PDF, following a public redirect", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "https://doi.test/10.1/x") return new Response(null, { status: 302, headers: { location: "https://repo.test/files/x.pdf" } });
      return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
    });
    const document = await fetchDocumentText("https://doi.test/10.1/x");
    expect(calls).toEqual(["https://doi.test/10.1/x", "https://repo.test/files/x.pdf"]);
    expect(document.kind).toBe("pdf");
    expect(document.pages).toBe(2);
    expect(document.finalUrl).toBe("https://repo.test/files/x.pdf");
    expect(document.text).toContain("dolus specialis");
    expect(document.text).toContain("Schabas, Genocide in International Law");
  });

  it("refuses to follow a redirect into a private network", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("hop.test") ? new Response(null, { status: 302, headers: { location: "https://private.corp.test/secret" } }) : new Response("x"),
    );
    await expect(fetchDocumentText("https://hop.test/a")).rejects.toMatchObject({ kind: "INPUT_INVALID" });
  });

  it("refuses http, IP literals and localhost outright", async () => {
    vi.stubGlobal("fetch", async () => new Response("x"));
    await expect(fetchDocumentText("http://repo.test/a.pdf")).rejects.toThrow(/Only https/);
    await expect(fetchDocumentText("https://127.0.0.1/a.pdf")).rejects.toThrow(/not a public site/);
    await expect(fetchDocumentText("https://localhost/a.pdf")).rejects.toThrow(/not a public site/);
  });

  it("reports a login wall as unavailable, not as the work", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("<html><body><h1>Sign in</h1><p>Institutional access required. Purchase this chapter.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(fetchDocumentText("https://publisher.test/doi/10.1/wall")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
    await expect(fetchDocumentText("https://publisher.test/doi/10.1/403")).rejects.toThrow(/login or licence wall/);
  });

  it("reduces a real HTML article to text", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}: the crime of genocide requires a specific intent to destroy a protected group as such, which distinguishes it from crimes against humanity.</p>`).join("");
    vi.stubGlobal("fetch", async () => new Response(`<html><body><article>${paragraphs}</article></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const document = await fetchDocumentText("https://oa-journal.test/article/1");
    expect(document.kind).toBe("html");
    expect(document.text).toContain("Paragraph 39");
  });
});

// ---------- doctrine_get_document end to end ----------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function getDocumentHandler(): Handler {
  let handler: Handler | undefined;
  registerDoctrine({
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === "doctrine_get_document") handler = callback;
    },
  } as never);
  if (!handler) throw new Error("doctrine_get_document did not register");
  return handler;
}

describe("doctrine_get_document (stubbed upstreams)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the full record and reports a closed work honestly", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.hostname === "peacepalace.on.worldcat.org") {
        expect(u.searchParams.get("queryString")).toBe("no:1525268154");
        return new Response(readFileSync(fixture("worldcat/search-page-1.json"), "utf8"), { status: 200 });
      }
      if (u.hostname === "api.unpaywall.org") {
        expect(u.pathname).toBe("/v2/10.1163%2F9789004724822");
        expect(u.searchParams.get("email")).toMatch(/@/);
        return new Response(readFileSync(fixture("unpaywall/closed.json"), "utf8"), { status: 200 });
      }
      if (u.hostname === "doi.org") return new Response(null, { status: 302, headers: { location: "https://brill.test/display/title/1" } });
      return new Response("<html><body>Sign in · Institutional access · Purchase</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const result = await getDocumentHandler()({ source: "peacepalace", id: "1525268154", record_only: false, page: 1 });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { record: BibHit; access: { status: string; oa_status?: string; tried: Array<{ url: string; outcome: string }> }; text: string };
    expect(out.record.id).toBe("1525268154");
    // The record view keeps the abstract and the contents whole.
    expect(out.record.abstract!.length).toBeGreaterThan(400);
    expect(out.record.abstract).not.toMatch(/…$/);
    expect(out.record.contents).toContain("Index 1353");
    expect(out.access.status).toBe("unavailable");
    expect(out.access.oa_status).toBe("closed");
    expect(out.access.tried.map((t) => t.url)).toEqual(["https://doi.org/10.1163/9789004724822"]);
    expect(out.access.tried[0].outcome).toMatch(/landing or login page/);
    expect(out.text).toBe("");
    const text = result.content[0].text;
    expect(text).toContain("RECORD [Peace Palace Library (WorldCat)]: Henry G Schermers, Niels M Blokker (2025). International Institutional Law");
    expect(text).toContain("Contents: Preface xxv");
    expect(text).toContain("ACCESS: no readable copy · Unpaywall: closed");
    expect(text).toContain("licensed titles open only for a caller signed in");
    expect(text).toContain("stored library login (/ucet)");
    expect(calls.filter((c) => c.includes("worldcat"))).toHaveLength(1);
  });

  it("reads an open-access PDF and pages/finds in it", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.hostname === "api.unpaywall.org") return new Response(readFileSync(fixture("unpaywall/oa-bronze-pdf.json"), "utf8"), { status: 200 });
      if (u.hostname === "library.oapen.org") return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response("nope", { status: 404 });
    });
    const handler = getDocumentHandler();
    const result = await handler({ doi: "10.5117/9789053566312", record_only: false, page: 1 });
    const out = result.structuredContent as { record?: unknown; access: { status: string; tried: Array<{ reason: string; outcome: string }> }; via: string; pdf_pages: number; text: string; text_url: string };
    expect(out.record).toBeUndefined();
    expect(out.access.status).toBe("open");
    expect(out.access.tried).toEqual([{ url: "https://library.oapen.org/bitstream/20.500.12657/35116/1/340230.pdf", reason: expect.stringMatching(/open-access PDF/), outcome: "read (pdf)" }]);
    expect(out.via).toBe("pdf");
    expect(out.pdf_pages).toBe(2);
    expect(out.text).toContain("dolus specialis");
    expect(result.content[0].text).toContain("--- TEXT (pdf, via https://library.oapen.org/");

    const found = await handler({ doi: "10.5117/9789053566312", record_only: false, page: 1, find: "Schabas" });
    const excerpt = found.structuredContent as { matches: number; text: string };
    expect(excerpt.matches).toBe(1);
    expect(excerpt.text).toContain("Schabas");
  });

  it("opens a licensed work through the caller's library login when the open copies refuse", async () => {
    process.env.CUNI_PROXY_BASE = "https://ezproxy.test";
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(`${init.method ?? "GET"} ${url}`);
      const u = new URL(url);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (u.hostname === "api.unpaywall.org") return new Response(readFileSync(fixture("unpaywall/closed.json"), "utf8"), { status: 200 });
      if (u.hostname === "doi.org") return new Response(null, { status: 302, headers: { location: "https://brill.test/display/title/1" } });
      if (u.hostname === "brill.test") return new Response("<html><body>Sign in · Institutional access · Purchase</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      if (u.hostname === "ezproxy.test" && u.searchParams.has("ticket")) {
        return new Response(null, { status: 302, headers: { location: "https://brill-test.ezproxy.test/display/title/1", "set-cookie": "ezproxy=s1; Domain=.ezproxy.test" } });
      }
      if (u.hostname === "ezproxy.test") {
        return headers.cookie?.includes("ezproxy=s1")
          ? new Response(null, { status: 302, headers: { location: "https://brill-test.ezproxy.test/display/title/1" } })
          : new Response(null, { status: 302, headers: { location: "https://cas.test/cas/login?service=x" } });
      }
      if (u.hostname === "cas.test" && init.method !== "POST") {
        return new Response(`<form method="post" action="/cas/login?service=x"><input name="username"><input type="password" name="password"><input type="hidden" name="execution" value="e1"><input type="hidden" name="_eventId" value="submit"></form>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u.hostname === "cas.test") {
        return new URLSearchParams(String(init.body)).get("password") === "correct"
          ? new Response(null, { status: 302, headers: { location: "https://ezproxy.test/login?url=x&ticket=ST-1" } })
          : new Response("<form><input type='password' name='password'></form>", { status: 401, headers: { "content-type": "text/html" } });
      }
      if (u.hostname === "brill-test.ezproxy.test") {
        return new Response(`<html><body><article>${"<p>Chapter 3. The mental element of genocide: dolus specialis in the case law of the ad hoc tribunals.</p>".repeat(50)}</article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    });
    const handler = getDocumentHandler();
    const extra = { authInfo: { extra: { userId: "user_with_uk" } } };
    const result = await (handler as unknown as (args: Record<string, unknown>, extra: unknown) => ReturnType<Handler>)({ doi: "10.1163/9789004724822", record_only: false, page: 1 }, extra);
    const out = result.structuredContent as { access: { status: string; reader_logins: string[]; tried: Array<{ url: string; reason: string; outcome: string }> }; via: string; text: string };
    expect(out.access.reader_logins).toEqual(["cuni"]);
    expect(out.access.status).toBe("reader");
    expect(out.access.tried.map((t) => [t.reason, t.outcome])).toEqual([
      ["the DOI (publisher's page)", expect.stringMatching(/landing or login page/)],
      ["through your Univerzita Karlova login", "read (html)"],
    ]);
    expect(out.text).toContain("dolus specialis");
    expect(result.content[0].text).toContain("read through your UKAŽ (Univerzita Karlova) login");
    expect(requests.some((r) => r.startsWith("POST https://cas.test"))).toBe(true);

    // A caller without a stored login gets the honest hint instead.
    const anonymous = await (handler as unknown as (args: Record<string, unknown>, extra: unknown) => ReturnType<Handler>)({ doi: "10.1163/9789004724822", record_only: false, page: 1 }, { authInfo: { extra: { userId: "user_without" } } });
    const anon = anonymous.structuredContent as { access: { status: string; reader_logins: string[] } };
    expect(anon.access).toMatchObject({ status: "unavailable", reader_logins: [] });
    expect(anonymous.content[0].text).toContain("store your library login on /ucet");
    delete process.env.CUNI_PROXY_BASE;
  });

  it("record_only skips every download", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(readFileSync(fixture("worldcat/search-page-1.json"), "utf8"), { status: 200 });
    });
    const result = await getDocumentHandler()({ source: "peacepalace", id: "1525268154", record_only: true, page: 1 });
    const out = result.structuredContent as { access: { status: string; tried: unknown[] } };
    expect(out.access).toEqual({ status: "not_tried", reader_logins: [], tried: [] });
    expect(calls.every((c) => c.includes("worldcat"))).toBe(true);
    expect(result.content[0].text).toContain("record only");
  });

  it("rejects a call that identifies nothing", async () => {
    const result = await getDocumentHandler()({ record_only: false, page: 1 });
    expect(result.isError).toBe(true);
    const half = await getDocumentHandler()({ id: "123", record_only: false, page: 1 });
    expect(half.isError).toBe(true);
  });
});
