import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CELLAR_CALL_BUDGET_MS,
  fetchCellarDocument,
  fetchCellarText,
  normalizeCelex,
  normalizeEcli,
  requireCellarLanguage,
  resolveCellarLanguage,
} from "@/src/sources/cellar";

/**
 * The shared Cellar text client behind eurlex_get_document and
 * sdeu_get_document: language resolution, identifier normalisation, the
 * text cache (English fallback included) and the call's time budget.
 * Every test uses its own path — the caches are module-scope.
 */

const SOURCE = "Test (Cellar)";
const LONG = `<html><body><p>${"Článek 1 Předmět a cíle. ".repeat(20)}</p></body></html>`;
const ENGLISH = `<html><body><p>${"Article 1 Subject-matter and objectives. ".repeat(20)}</p></body></html>`;

interface Call {
  url: string;
  lang: string;
}

/** fetch stub answering by Accept-Language; logs every request. */
function stubCellar(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url, lang: (init.headers as Record<string, string>)["accept-language"] };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveCellarLanguage", () => {
  it("knows all 24 EU languages under their usual spellings", () => {
    expect(resolveCellarLanguage("cs")).toEqual({ iso2: "cs", iso3: "ces" });
    for (const spelling of ["CS", "ces", "cze", "cz", "cs-CZ", "cs_cz", " cs "]) {
      expect(resolveCellarLanguage(spelling), spelling).toEqual({ iso2: "cs", iso3: "ces" });
    }
    expect(resolveCellarLanguage("en_GB")).toEqual({ iso2: "en", iso3: "eng" });
    expect(resolveCellarLanguage("ger")).toEqual({ iso2: "de", iso3: "deu" });
    expect(resolveCellarLanguage("nl")).toEqual({ iso2: "nl", iso3: "nld" });
    expect(resolveCellarLanguage("hu")).toEqual({ iso2: "hu", iso3: "hun" });
    expect(resolveCellarLanguage("ga")).toEqual({ iso2: "ga", iso3: "gle" });
    expect(resolveCellarLanguage("rum")).toEqual({ iso2: "ro", iso3: "ron" });
  });

  it("misses anything else — prototype keys included", () => {
    for (const input of ["xx", "", "ru", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveCellarLanguage(input), input).toBeNull();
    }
  });

  it("refuses an unknown language with the codes that work", () => {
    expect(() => requireCellarLanguage(SOURCE, "xx")).toThrowError(
      expect.objectContaining({ kind: "INPUT_INVALID", hint: expect.stringContaining("cs") }),
    );
  });
});

describe("normalizeCelex / normalizeEcli", () => {
  it("strips the CELEX: prefix, spaces and case", () => {
    expect(normalizeCelex(" CELEX:32016r0679 ")).toBe("32016R0679");
    expect(normalizeCelex("celex : 62024CJ0474_RES")).toBe("62024CJ0474_RES");
    expect(normalizeCelex("32016R0679R(02)")).toBe("32016R0679R(02)");
    expect(normalizeCelex("02016R0679-20160504")).toBe("02016R0679-20160504");
  });

  it("upper-cases the ECLI and adds a missing prefix", () => {
    expect(normalizeEcli(" ecli:eu:c:2020:559 ")).toBe("ECLI:EU:C:2020:559");
    expect(normalizeEcli("EU:C:2020:559")).toBe("ECLI:EU:C:2020:559");
    expect(normalizeEcli("   ")).toBe("");
  });
});

describe("fetchCellarDocument — cache and English fallback", () => {
  it("serves the requested language and caches it", async () => {
    const calls = stubCellar(() => new Response(LONG, { status: 200 }));
    const first = await fetchCellarDocument(SOURCE, "/celex/T0001", "cs");
    const again = await fetchCellarDocument(SOURCE, "/celex/T0001", "cz");
    expect(first).toMatchObject({ language: "cs" });
    expect(first?.text).toContain("Předmět");
    expect(again).toEqual(first);
    expect(calls.map((call) => call.lang)).toEqual(["ces"]);
  });

  it("downloads the English fallback once, and skips a language Cellar said it lacks", async () => {
    // Live 2026-09 (audit): ces 404 → eng 200 was re-requested as ces, eng,
    // ces, eng… — the whole English text parsed again on every page.
    const calls = stubCellar(({ lang }) =>
      lang === "ces" ? new Response("not found", { status: 404 }) : new Response(ENGLISH, { status: 200 }),
    );
    for (let i = 0; i < 3; i++) {
      const document = await fetchCellarDocument(SOURCE, "/celex/T0002", "cs");
      expect(document?.language).toBe("en");
      expect(document?.text).toContain("Subject-matter");
    }
    expect(calls.map((call) => call.lang)).toEqual(["ces", "eng"]);
  });

  it("reads the English cache even when the requested language only gave a stub", async () => {
    const calls = stubCellar(({ lang }) =>
      lang === "ces" ? new Response("<p>stub</p>", { status: 200 }) : new Response(ENGLISH, { status: 200 }),
    );
    await fetchCellarDocument(SOURCE, "/celex/T0003", "cs");
    await fetchCellarDocument(SOURCE, "/celex/T0003", "cs");
    // A stub may be transient: the Czech rendition is asked again, English is not.
    expect(calls.map((call) => call.lang)).toEqual(["ces", "eng", "ces"]);
  });

  it("does not remember a transient failure as a missing language", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fail = true;
    const calls = stubCellar(({ lang }) =>
      lang === "ces" && fail ? new Response("busy", { status: 503 }) : new Response(LONG, { status: 200 }),
    );
    await expect(fetchCellarDocument(SOURCE, "/celex/T0004", "cs")).rejects.toMatchObject({ kind: "UPSTREAM_ERROR" });
    // One retry of the 503, no English served in place of an outage.
    expect(calls.map((call) => call.lang)).toEqual(["ces", "ces"]);
    fail = false;
    expect(await fetchCellarDocument(SOURCE, "/celex/T0004", "cs")).toMatchObject({ language: "cs" });
  });

  it("lets go of the body of a response it does not read", async () => {
    const miss = new Response("not found", { status: 404 });
    const cancel = vi.spyOn(miss.body!, "cancel");
    stubCellar(() => miss);
    expect(await fetchCellarText(SOURCE, "/celex/T0005", "en")).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("joins the parts of a multi-part document and fails it whole on a missing part", async () => {
    const listing = (id: string) =>
      new Response(
        `<a href="https://publications.europa.eu/resource/cellar/${id}.01">1</a><a href="https://publications.europa.eu/resource/cellar/${id}.02">2</a><a href="https://evil.example/x">x</a>`,
        { status: 300 },
      );
    const calls = stubCellar(({ url }) => {
      if (url.endsWith("/celex/T0006")) return listing("p6");
      if (url.endsWith("/celex/T0007")) return listing("p7");
      if (url.endsWith("p7.02")) return new Response("gone", { status: 404 });
      return new Response(url.endsWith(".01") ? LONG : ENGLISH, { status: 200 });
    });
    const joined = await fetchCellarText(SOURCE, "/celex/T0006", "en");
    expect(joined).toContain("Předmět");
    expect(joined).toContain("Subject-matter");
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(await fetchCellarText(SOURCE, "/celex/T0007", "en")).toBeNull();
  });

  it("refuses an unknown language before any request", async () => {
    const calls = stubCellar(() => new Response(LONG, { status: 200 }));
    await expect(fetchCellarText(SOURCE, "/celex/T0008", "xx")).rejects.toMatchObject({ kind: "INPUT_INVALID" });
    expect(calls).toEqual([]);
  });
});

describe("fetchCellarDocument — the call's time budget", () => {
  it("cuts each attempt's timeout to what is left of the deadline", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    stubCellar(() => new Response(LONG, { status: 200 }));
    await fetchCellarDocument(SOURCE, "/celex/T0101", "en", { deadline: Date.now() + 12_000 });
    const [ms] = timeouts.mock.calls[0];
    expect(ms).toBeLessThanOrEqual(12_000);
    expect(ms).toBeGreaterThan(11_000);
    // Without a deadline the call's full budget applies, capped at 25 s per GET.
    await fetchCellarDocument(SOURCE, "/celex/T0102", "en");
    expect(timeouts.mock.calls[1][0]).toBe(25_000);
    expect(CELLAR_CALL_BUDGET_MS).toBeLessThan(60_000);
  });

  it("starts no request it could only time out", async () => {
    const calls = stubCellar(() => new Response(LONG, { status: 200 }));
    await expect(
      fetchCellarDocument(SOURCE, "/celex/T0103", "en", { deadline: Date.now() + 1_000 }),
    ).rejects.toMatchObject({ kind: "UPSTREAM_ERROR", message: expect.stringContaining("time budget ran out") });
    expect(calls).toEqual([]);
  });

  it("skips the English fallback when the budget is spent, and says how to get it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = stubCellar(({ lang }) => {
      // The Czech request takes 48 of the 50 s.
      vi.setSystemTime(Date.now() + 48_000);
      return lang === "ces" ? new Response("not found", { status: 404 }) : new Response(ENGLISH, { status: 200 });
    });
    await expect(fetchCellarDocument(SOURCE, "/celex/T0104", "cs")).rejects.toMatchObject({
      kind: "UPSTREAM_ERROR",
      message: expect.stringContaining("English fallback"),
      hint: expect.stringContaining("language: 'en'"),
    });
    expect(calls.map((call) => call.lang)).toEqual(["ces"]);
  });

  it("retries a timed-out GET while the budget allows it, and not after", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const timeout = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    let first = true;
    const calls = stubCellar(() => {
      if (first) {
        first = false;
        timeout();
      }
      return new Response(LONG, { status: 200 });
    });
    expect(await fetchCellarText(SOURCE, "/celex/T0105", "en")).toContain("Předmět");
    expect(calls).toHaveLength(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    const late = stubCellar(() => {
      vi.setSystemTime(Date.now() + 42_000);
      return timeout();
    });
    await expect(fetchCellarText(SOURCE, "/celex/T0106", "en")).rejects.toMatchObject({ kind: "UPSTREAM_UNREACHABLE" });
    expect(late).toHaveLength(1);
  });
});
