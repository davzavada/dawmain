import { describe, expect, it } from "vitest";
import {
  charPage,
  DOC_PAGE_CHARS,
  excerptTerms,
  findExcerpts,
  foldText,
  previewExcerpt,
  snippet,
  uniqueQueries,
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

  it("re-setting an existing key at capacity keeps the other entries", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<string>(60_000, 2);
    cache.set("a", "A");
    cache.set("b", "B");
    cache.set("b", "B2"); // same key: no eviction
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBe("B2");
    cache.set("a", "A2"); // a refreshed key moves to the end of the eviction order
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A2");
  });

  it("through() shares one load among concurrent callers of a key", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<number>(60_000);
    let loads = 0;
    let release!: (value: number) => void;
    const load = () => {
      loads++;
      return new Promise<number>((resolve) => (release = resolve));
    };
    const all = Promise.all([cache.through("k", load), cache.through("k", load), cache.through("k", load)]);
    await Promise.resolve(); // the loader starts a microtask later
    release(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(loads).toBe(1);
    expect(await cache.through("k", load)).toBe(7); // now cached
    expect(loads).toBe(1);
  });

  it("through() never caches a rejection: every waiter sees it, the next call loads again", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<number>(60_000);
    let loads = 0;
    const failing = async () => {
      loads++;
      throw new Error("boom");
    };
    const results = await Promise.allSettled([cache.through("k", failing), cache.through("k", failing)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(loads).toBe(1);
    expect(await cache.through("k", async () => 5)).toBe(5);
  });

  it("through() recovers from a loader that throws synchronously", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<number>(60_000);
    const sync = (() => {
      throw new Error("sync");
    }) as unknown as () => Promise<number>;
    await expect(cache.through("k", sync)).rejects.toThrow("sync");
    expect(await cache.through("k", async () => 3)).toBe(3);
  });

  it("delete() during a load keeps the landing value out of the cache, and the caller still gets it", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<number>(60_000);
    let release!: (value: number) => void;
    const first = cache.through("k", () => new Promise<number>((resolve) => (release = resolve)));
    cache.delete("k");
    // A call after the delete starts its own load rather than joining the dead one.
    const second = cache.through("k", async () => 2);
    await Promise.resolve();
    release(1);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(cache.get("k")).toBe(2);
  });

  it("a caller may evict the value it got (NS bodyUnverified) once through() settles", async () => {
    const { TtlCache } = await import("@/src/sources/shared/cache");
    const cache = new TtlCache<{ unverified: boolean }>(60_000);
    let loads = 0;
    const load = async () => {
      loads++;
      return { unverified: true };
    };
    const read = async () => {
      const value = await cache.through("k", load);
      if (value.unverified) cache.delete("k");
      return value;
    };
    await Promise.all([read(), read()]);
    expect(loads).toBe(1);
    expect(cache.get("k")).toBeUndefined();
    await read();
    expect(loads).toBe(2);
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

describe("foldText / previewExcerpt (one fold per preview)", () => {
  // The fold as it was: one NFD normalize per character.
  const reference = (text: string) => {
    let out = "";
    for (const char of text) out += char.length === 2 ? char : (char.normalize("NFD")[0]?.toLowerCase() ?? char);
    return out;
  };
  const sample = "İstanbul ﬁnále 𝒜 Žaloba NÁHRADA škody é\u0301 ÆØÅ ß ǅ Ω ﬀ — § 2958 [24] \n Účinnost";

  it("folds exactly as the per-character fold, offsets 1:1", () => {
    expect(foldText(sample)).toBe(reference(sample));
    expect(foldText(sample).length).toBe(sample.length);
    expect(foldText(sample.repeat(3))).toBe(reference(sample.repeat(3)));
  });

  it("previewExcerpt answers as findExcerpts term by term did", () => {
    const text = `${"úvod bez shody. ".repeat(40)}\n24. Soud dospěl k závěru, že NÁHRADA škody náleží.\n${"závěr. ".repeat(40)}`;
    const terms = ["bezpečný přístav", "nemajetková újma", "náhrada škody"];
    const old = (() => {
      for (const term of terms) {
        const result = findExcerpts(text, term, 300, 1_200, 2, 300);
        if (result.matches) return { matches: result.matches, excerpt: result.text };
      }
      return { matches: 0, excerpt: "" };
    })();
    expect(previewExcerpt(text, terms)).toEqual(old);
    expect(previewExcerpt(text, terms).matches).toBe(1);
    expect(previewExcerpt(text, ["nic takového"])).toEqual({ matches: 0, excerpt: "" });
  });
});

describe("uniqueQueries whitespace", () => {
  it("treats variants differing only in whitespace as one, and sends the collapsed form", () => {
    expect(uniqueQueries("náhrada  škody", ["náhrada škody", " náhrada\tškody "])).toEqual(["náhrada škody"]);
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

  it("opens a window at its paragraph, so the bod number heads the excerpt", async () => {
    const { findExcerpts } = await import("@/src/sources/shared/text");
    const text = [
      "[23] Předchozí odstavec o něčem jiném. " + "Výplň. ".repeat(40),
      "[24] Nejvyšší správní soud dále uvádí, že " + "odůvodnění ".repeat(20) + "zásahová žaloba je subsidiární.",
      "[25] Další odstavec.",
    ].join("\n");
    const result = findExcerpts(text, "zásahová žaloba");
    expect(result.text.startsWith("[24] Nejvyšší správní soud")).toBe(true);
    expect(result.text).not.toContain("[23]");
    expect(result.text).not.toContain("[25]");
  });

  it("shows at most eight passages and counts the rest", async () => {
    const { findExcerpts, pageOrExcerpt } = await import("@/src/sources/shared/text");
    const text = Array.from({ length: 12 }, (_, i) => `${i + 1}. Odstavec o náhradě škody číslo ${i + 1}.`).join("\n");
    const result = findExcerpts(text, "náhradě škody");
    expect(result.matches).toBe(12);
    expect(result.windows).toBe(12);
    expect(result.shown).toBe(8);
    expect(result.truncated).toBe(true);
    const view = pageOrExcerpt(text, 1, "náhradě škody");
    expect(view.has_more).toBe(true);
    expect(view.text).toContain("8 of 12 passages shown");
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
    // An excerpt never passes for the decision: it says where the whole is.
    expect(excerpted.text).toContain("(Excerpts only, 1 match — the whole text: page 1; a decision you rely on, read in full.)");
  });

  it("a single passage longer than the cap counts as truncated", async () => {
    const { findExcerpts } = await import("@/src/sources/shared/text");
    const text = "škoda ".repeat(400);
    const result = findExcerpts(text, "škoda", 500, 300);
    expect(result.shown).toBe(1);
    expect(result.windows).toBe(1);
    expect(result.cut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(301);
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

  it("interleave merges variants round-robin, first occurrence wins", async () => {
    const { interleave } = await import("@/src/sources/shared/text");
    const first = ["a", "b", "c", "d"];
    const second = ["x", "b", "y"];
    const third: string[] = [];
    // Concatenation would have been a, b, c, d — the second variant never shown.
    expect(interleave([first, second, third], (id) => id)).toEqual(["a", "x", "b", "c", "y", "d"]);
    expect(interleave([], (id: string) => id)).toEqual([]);
  });

  it("runVariants keeps the variants that answered and names the ones that failed", async () => {
    const { runVariants } = await import("@/src/mcp/tools/variants");
    const outcome = await runVariants(["rychlá", "pomalá", "chybná"], async (variant) => {
      if (variant === "pomalá") return new Promise<string>(() => {});
      if (variant === "chybná") throw new Error("HTTP 500");
      return `hits for ${variant}`;
    }, 50);
    expect(outcome.values).toEqual(["hits for rychlá", null, null]);
    expect(outcome.failures.map((failure) => failure.variant)).toEqual(["pomalá", "chybná"]);
    expect(outcome.failures[0].error).toContain("timed out");
    expect(outcome.failures[1].error).toBe("HTTP 500");
  });

  it("runVariants fails only when every variant fails — with the first error", async () => {
    const { runVariants } = await import("@/src/mcp/tools/variants");
    await expect(
      runVariants(["a", "b"], async (variant) => {
        throw new Error(`boom ${variant}`);
      }),
    ).rejects.toThrow("boom a");
  });

  it("maxTotal reports the largest known variant total", async () => {
    const { maxTotal } = await import("@/src/sources/shared/text");
    expect(maxTotal([12, null, 179])).toBe(179);
    expect(maxTotal([null, null])).toBeNull();
  });

  it("previewExcerpt falls through variants and stays silent on a miss", async () => {
    const { previewExcerpt } = await import("@/src/sources/shared/text");
    const hit = previewExcerpt(decision, ["neexistuje", "safe harbour"], 40, 500);
    expect(hit.matches).toBe(2);
    expect(hit.excerpt).toContain("safe harbour");
    expect(hit.excerpt.length).toBeLessThanOrEqual(501);
    // The head of a decision that never mentions the terms tells nothing.
    expect(previewExcerpt(decision, ["neexistuje"], 40, 120)).toEqual({ matches: 0, excerpt: "" });
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
