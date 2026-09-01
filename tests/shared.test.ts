import { describe, expect, it } from "vitest";
import {
  charPage,
  DOC_PAGE_CHARS,
  excerptTerms,
  snippet,
  isoToCzech,
  czechToIso,
} from "@/src/sources/shared/text";
import { htmlToText, decodeBody, decodeJsStringLiteral } from "@/src/sources/shared/html";
import { CookieSession } from "@/src/sources/shared/http";

describe("charPage", () => {
  it("defaults to 45k-character pages (reliably under client output caps)", () => {
    expect(DOC_PAGE_CHARS).toBe(45_000);
  });

  it("splits into fixed pages", () => {
    const page1 = charPage("a".repeat(30), 1, 25);
    expect(page1.text).toHaveLength(25);
    expect(page1.total_pages).toBe(2);
    expect(page1.has_more).toBe(true);
    const page2 = charPage("a".repeat(30), 2, 25);
    expect(page2.text).toHaveLength(5);
    expect(page2.has_more).toBe(false);
  });
  it("clamps out-of-range pages", () => {
    expect(charPage("abc", 99, 25).page).toBe(1);
    expect(charPage("", 1, 25).total_pages).toBe(1);
  });
});

describe("snippet", () => {
  it("collapses whitespace and cuts on word boundary", () => {
    const s = snippet("word ".repeat(200), 50);
    expect(s.length).toBeLessThanOrEqual(51);
    expect(s.endsWith("…")).toBe(true);
  });
  it("keeps short text untouched", () => {
    expect(snippet("krátký text")).toBe("krátký text");
  });
});

describe("dates", () => {
  it("iso → czech", () => {
    expect(isoToCzech("2026-07-07")).toBe("7.7.2026");
    expect(isoToCzech("2024-12-31")).toBe("31.12.2024");
  });
  it("czech → iso (NALUS spaced, NS compact, slash form)", () => {
    expect(czechToIso("7. 7. 2026")).toBe("2026-07-07");
    expect(czechToIso("07.07.2026")).toBe("2026-07-07");
    expect(czechToIso("31/12/2024")).toBe("2024-12-31");
    expect(czechToIso("nonsense")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("preserves paragraph breaks, drops tags and scripts", () => {
    const text = htmlToText(
      "<p>První&nbsp;odstavec</p><script>var x=1;</script><div>Druhý <b>odstavec</b></div>",
    );
    expect(text).toBe("První odstavec\nDruhý odstavec");
  });
  it("survives Domino font soup without tbody", () => {
    const text = htmlToText(
      '<table><tr><td><font face="Times New Roman">Nejvyšší soud rozhodl</font></td></tr></table>',
    );
    expect(text).toContain("Nejvyšší soud rozhodl");
  });
});

describe("decodeJsStringLiteral", () => {
  it("decodes \\uXXXX escapes from inline scripts (NSS currParams)", () => {
    expect(decodeJsStringLiteral("[{\\u0022Id\\u0022:19}]")).toBe('[{"Id":19}]');
  });
});

describe("decodeBody", () => {
  it("decodes UTF-16LE with BOM regardless of header (NSS /Text)", async () => {
    const chars = "ROZSUDEK č. 1";
    const buf = new Uint8Array(2 + chars.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    for (let i = 0; i < chars.length; i++) {
      const code = chars.charCodeAt(i);
      buf[2 + i * 2] = code & 0xff;
      buf[3 + i * 2] = code >> 8;
    }
    const response = new Response(buf, { headers: { "content-type": "text/plain" } });
    expect(await decodeBody(response)).toBe(chars);
  });
  it("honours charset header", async () => {
    const response = new Response(new TextEncoder().encode("ahoj"), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(await decodeBody(response)).toBe("ahoj");
  });
});

describe("CookieSession", () => {
  it("absorbs set-cookie pairs and emits a Cookie header", () => {
    const session = new CookieSession();
    const response = new Response("", {
      headers: [
        ["set-cookie", "ASP.NET_SessionId=abc123; path=/; HttpOnly"],
        ["set-cookie", "other=1; path=/"],
      ] as [string, string][],
    });
    session.absorb(response);
    expect(session.size).toBe(2);
    expect(session.header()).toBe("ASP.NET_SessionId=abc123; other=1");
  });
});

describe("TtlCache", () => {
  it("serves within TTL and reloads after expiry", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<number>(50);
    let loads = 0;
    const load = async () => ++loads;
    expect(await cache.through("k", load)).toBe(1);
    expect(await cache.through("k", load)).toBe(1); // cached
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await cache.through("k", load)).toBe(2); // expired → reload
  });

  it("evicts the oldest entry once maxEntries is reached", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<string>(60_000, 2);
    cache.set("a", "A");
    cache.set("b", "B");
    cache.set("c", "C"); // over capacity → "a" goes
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("memoKey separates scopes and ignores undefined criteria", async () => {
    const { memoKey } = await import("@/src/sources/shared/cache");
    expect(memoKey("nss-search", [{ query: "azyl" }, 1])).toBe(
      memoKey("nss-search", [{ query: "azyl", caseNumber: undefined }, 1]),
    );
    expect(memoKey("nss-search", [{ query: "azyl" }, 1])).not.toBe(
      memoKey("ns-search", [{ query: "azyl" }, 1]),
    );
  });
});

describe("findExcerpts / pageOrExcerpt", () => {
  const decision =
    "Úvod rozhodnutí. ".repeat(50) +
    "Soud odkazuje na rozsudek C-610/15 Stichting Brein a doktrínu safe harbour. " +
    "Další text. ".repeat(50) +
    "Podruhé zmíněný SAFE HARBOUR v závěru. " +
    "Konec. ".repeat(20);

  it("finds matches diacritics- and case-insensitively and merges windows", async () => {
    const { findExcerpts } = await import("@/src/sources/shared/text");
    const result = findExcerpts(decision, "safe harbour", 80);
    expect(result.matches).toBe(2);
    expect(result.text).toContain("C-610/15");
    expect(result.text).toContain("SAFE HARBOUR");
    expect(result.text).toContain("[…]");
  });

  it("folds Czech diacritics in the needle", async () => {
    const { findExcerpts } = await import("@/src/sources/shared/text");
    expect(findExcerpts("Nejvyšší soud o vydržení rozhodl.", "VYDRZENI", 20).matches).toBe(1);
  });

  it("pageOrExcerpt switches modes", async () => {
    const { pageOrExcerpt } = await import("@/src/sources/shared/text");
    const paged = pageOrExcerpt(decision, 1);
    expect(paged.mode).toBe("page");
    expect(paged.matches).toBeUndefined();
    const excerpted = pageOrExcerpt(decision, 1, "Stichting Brein");
    expect(excerpted.mode).toBe("excerpt");
    expect(excerpted.matches).toBe(1);
    expect(excerpted.text).toContain("Stichting Brein");
    expect(excerpted.has_more).toBe(false);
  });

  it("says so explicitly when find matches nothing", async () => {
    const { pageOrExcerpt } = await import("@/src/sources/shared/text");
    const empty = pageOrExcerpt(decision, 1, "bezpečný přístav");
    expect(empty.matches).toBe(0);
    expect(empty.text).toContain('No occurrences of "bezpečný přístav"');
    expect(empty.text).toContain("stem");
  });
});

describe("looksLikeHtml", () => {
  it("detects markup and rejects plain text", async () => {
    const { looksLikeHtml } = await import("@/src/sources/shared/html");
    expect(looksLikeHtml("<p>Odůvodnění</p>")).toBe(true);
    expect(looksLikeHtml("Nejvyšší soud rozhodl takto: dovolání se zamítá.")).toBe(false);
    expect(looksLikeHtml("a < b and c > d")).toBe(false);
  });

  it("stays fast on pathological input (the old regex took 15 s on 200 kB)", async () => {
    const { looksLikeHtml } = await import("@/src/sources/shared/html");
    const evil = "<a".repeat(400_000); // 800 kB of "<" with no ">"
    const started = Date.now();
    expect(looksLikeHtml(evil)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("narrowestWindow", () => {
  it("reports the LATEST window, not the first variant's", async () => {
    const { narrowestWindow } = await import("@/src/sources/shared/text");
    // Variant 1 searched the whole archive, variants 2-3 were cut back. Saying
    // "no window" here would present a 90-day slice as the whole database.
    expect(narrowestWindow([null, "2025-09-01", "2026-06-01"])).toBe("2026-06-01");
  });
  it("is null only when no variant was windowed", async () => {
    const { narrowestWindow } = await import("@/src/sources/shared/text");
    expect(narrowestWindow([null, null])).toBeNull();
    expect(narrowestWindow([])).toBeNull();
  });
});

describe("parallel-search helpers", () => {
  const decision =
    "Úvod rozhodnutí. ".repeat(20) +
    "Soud odkazuje na doktrínu safe harbour. " +
    "Další text. ".repeat(20) +
    "Podruhé zmíněný SAFE HARBOUR v závěru. " +
    "Konec. ".repeat(10);

  it("uniqueQueries trims, dedupes case-insensitively and caps at 3", async () => {
    const { uniqueQueries } = await import("@/src/sources/shared/text");
    expect(uniqueQueries("náhrada škody", [" Náhrada škody ", "ušlý zisk", "škoda", "čtvrtá"])).toEqual([
      "náhrada škody",
      "ušlý zisk",
      "škoda",
    ]);
    expect(uniqueQueries(undefined, undefined)).toEqual([]);
    expect(uniqueQueries(undefined, ["jediná"])).toEqual(["jediná"]);
  });

  it("dedupeBy keeps the first occurrence in order", async () => {
    const { dedupeBy } = await import("@/src/sources/shared/text");
    const items = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "a", rank: 3 },
    ];
    expect(dedupeBy(items, (i) => i.id)).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
  });

  it("maxTotal reports the largest known variant total", async () => {
    const { maxTotal } = await import("@/src/sources/shared/text");
    expect(maxTotal([12, null, 179])).toBe(179);
    expect(maxTotal([null, null])).toBeNull();
  });

  it("previewExcerpt falls through variants and defaults to the head", async () => {
    const { previewExcerpt } = await import("@/src/sources/shared/text");
    const hit = previewExcerpt(decision, ["neexistuje", "safe harbour"], 40, 500);
    expect(hit.matches).toBe(2);
    expect(hit.excerpt).toContain("safe harbour");
    const miss = previewExcerpt(decision, ["neexistuje"], 40, 120);
    expect(miss.matches).toBe(0);
    expect(miss.excerpt.length).toBeLessThanOrEqual(121);
    expect(miss.excerpt).toContain("Úvod rozhodnutí");
    expect(miss.excerpt.endsWith("…")).toBe(true);
  });
});

describe("excerptTerms", () => {
  it("puts quoted phrases first and drops the syntax around them", () => {
    expect(excerptTerms(['nájem* AND "dobré mravy"'])).toEqual([
      "dobré mravy",
      "nájem dobré mravy",
      "nájem",
      "dobré",
      "mravy",
    ]);
  });
  it("keeps a plain query as one term", () => {
    expect(excerptTerms(["náhrada škody"])).toEqual(["náhrada škody", "náhrada", "škody"]);
  });
  it("ignores empty variants and duplicates", () => {
    expect(excerptTerms([undefined, "  ", "nájemce", "nájemce"])).toEqual(["nájemce"]);
  });
});
