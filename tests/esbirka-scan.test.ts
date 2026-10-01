import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlToText } from "@/src/sources/shared/html";

/**
 * The § scan reads as few ~1 MB fragment pages as it can — and must still
 * return exactly what the old linear scan returned. Fixtures follow the live
 * page shape (2026-09): a § is a "Paragraf" fragment followed by its
 * odstavce, every fragment's zkracenaCitace names its § ("§ 2913 odst. 1
 * zákona č. 89/2012 Sb."), structural headings cite the part they head.
 */

interface Frag {
  kodTypuFragmentu: string;
  zkracenaCitace: string;
  xhtml?: string;
  eli?: string;
}

function paragraf(label: string, odstavce: number, options: { heading?: boolean; part?: string } = {}): Frag[] {
  const cite = (tail = "") => `§ ${label}${tail} zákona č. 89/2012 Sb.`;
  const eli = options.part ? `/eli/cz/sb/2012/89/2026-01-01/dokument/${options.part}/par_${label}` : undefined;
  const out: Frag[] = [];
  if (options.heading) out.push({ kodTypuFragmentu: "Nadpis_nad", zkracenaCitace: cite(), xhtml: `Nadpis ${label}`, eli });
  out.push({ kodTypuFragmentu: "Paragraf", zkracenaCitace: cite(), xhtml: `<var>§ ${label}</var>`, eli });
  for (let k = 1; k <= odstavce; k++) {
    out.push({
      kodTypuFragmentu: "Odstavec_Dc",
      zkracenaCitace: cite(` odst. ${k}`),
      xhtml: `<var>(${k})</var> Text ${label}/${k}${options.part === "prilohy" ? " (příloha)" : ""}.`,
      ...(eli ? { eli: `${eli}/odst_${k}` } : {}),
    });
  }
  return out;
}

/** §§ from..to, each with `odstavce` paragraphs. */
function run(from: number, to: number, odstavce = 2, part?: string): Frag[] {
  const out: Frag[] = [];
  for (let n = from; n <= to; n++) out.push(...paragraf(String(n), odstavce, { part }));
  return out;
}

/** Cut a flat fragment list at the given start indices (page 0 starts at 0). */
function cut(flat: Frag[], starts: number[]): Frag[][] {
  const bounds = [...starts, flat.length];
  return starts.map((start, i) => flat.slice(start, bounds[i + 1]));
}

/** Equal pages of whole §§ (3 fragments each at 2 odstavce). */
function pagesOf(sections: Array<[number, number]>, odstavce = 2, part?: string): Frag[][] {
  return sections.map(([from, to]) => run(from, to, odstavce, part));
}

/** The pre-jump scan, verbatim in behaviour: page 0, then batches of 5 up to page 14, until a page without the §. */
function linearReference(pages: Frag[][], paragraph: string): string | null {
  const sectionRe = new RegExp(`(^|[^0-9a-z])§\\s*${paragraph}(\\s|$|[^0-9a-z])`, "iu");
  const matchesOf = (page: Frag[]) =>
    page.filter((f) => f.zkracenaCitace && sectionRe.test(f.zkracenaCitace)).map((f) => (f.xhtml ? htmlToText(f.xhtml) : ""));
  const totalPages = Math.min(pages.length, 15);
  const collected = matchesOf(pages[0]);
  let done = false;
  for (let start = 1; start < totalPages && !done; start += 5) {
    for (let page = start; page < Math.min(start + 5, totalPages); page++) {
      const found = matchesOf(pages[page]);
      collected.push(...found);
      if (collected.length && !found.length) {
        done = true;
        break;
      }
    }
  }
  return collected.length ? collected.join("\n") || null : null;
}

interface Served {
  pagesFetched: number[];
  sparql: number;
}

/** Serve act 2012/`number` from `pages`; SPARQL is WAF-blocked (403) as measured live. */
function serve(acts: Map<number, Frag[][]>): Served {
  const served: Served = { pagesFetched: [], sparql: 0 };
  vi.stubGlobal("fetch", async (input: string) => {
    const url = decodeURIComponent(String(input));
    if (url.includes("/sparql?")) {
      served.sparql++;
      return new Response("<h2>The request is blocked.</h2>", { status: 403, headers: { "content-type": "text/html" } });
    }
    const match = /\/sb\/2012\/(\d+)(?:\/[\d-]+)?(?:\/fragmenty\?cisloStranky=(\d+)|(\/historie))?$/.exec(url);
    if (!match) return new Response("?", { status: 404 });
    const number = Number(match[1]);
    const pages = acts.get(number);
    if (!pages) return new Response("missing", { status: 404 });
    if (match[2] !== undefined) {
      const page = Number(match[2]);
      served.pagesFetched.push(page);
      return new Response(JSON.stringify({ pocetStranek: pages.length, seznam: pages[page] ?? [] }));
    }
    if (match[3]) return new Response(JSON.stringify({ historie: [] }));
    return new Response(
      JSON.stringify({
        nazev: "Zákon",
        staleUrl: `/sb/2012/${number}/2026-01-01`,
        datumUcinnostiZneniOd: "2026-01-01",
        typZneni: "AKTUALNI",
      }),
    );
  });
  return served;
}

async function load() {
  return import("@/src/sources/esbirka");
}

beforeEach(() => {
  delete process.env.ESBIRKA_API_KEY;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 11 pages of 100 §§ each — the Civil Code's shape (page 10 starts at § 3006 live). */
const UNIFORM = pagesOf(Array.from({ length: 11 }, (_, p) => [p * 100 + 1, p * 100 + 100] as [number, number]));

describe("§ scan stops where the § visibly ends (finding 4)", () => {
  it("reads only page 0 for a § that begins and ends there", async () => {
    const served = serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 29");
    expect(result.via).toBe("scan");
    expect(result.text).toBe(linearReference(UNIFORM, "29"));
    expect(result.text).toBe("§ 29\n(1) Text 29/1.\n(2) Text 29/2.");
    expect(served.pagesFetched).toEqual([0]);
  });

  it("reads page 1 alone for a § that runs over the end of page 0, and returns both parts", async () => {
    const flat = run(1, 1100);
    // Page 0 ends after § 100's heading and first odstavec.
    const pages = cut(flat, [0, 299, ...Array.from({ length: 9 }, (_, i) => 300 + (i + 1) * 300)]);
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 100");
    expect(result.text).toBe("§ 100\n(1) Text 100/1.\n(2) Text 100/2.");
    expect(result.text).toBe(linearReference(pages, "100"));
    expect(served.pagesFetched.sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("in the linear scan, a § ending mid-page 5 does not fetch pages 6–10", async () => {
    // Page 0 out of order (a later § first) — no jump, the linear scan runs.
    const pages = UNIFORM.map((page) => [...page]);
    pages[0] = [...paragraf("99", 1), ...pages[0].filter((f) => !f.zkracenaCitace.startsWith("§ 99 "))];
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 550");
    expect(result.text).toBe(linearReference(pages, "550"));
    expect(Math.max(...served.pagesFetched)).toBe(5);
  });

  it("keeps reading when the § is interleaved with another on its page (out of order)", async () => {
    const page0 = [
      ...paragraf("4", 1),
      ...paragraf("5", 2),
      ...paragraf("6", 1),
      { kodTypuFragmentu: "Odstavec_Dc", zkracenaCitace: "§ 5 odst. 3 zákona č. 89/2012 Sb.", xhtml: "(3) Late 5/3." },
      ...paragraf("7", 1),
    ];
    const page1 = [
      { kodTypuFragmentu: "Odstavec_Dc", zkracenaCitace: "§ 5 odst. 4 zákona č. 89/2012 Sb.", xhtml: "(4) Late 5/4." },
      ...run(8, 20),
    ];
    const pages = [page0, page1, run(21, 40), run(41, 60)];
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "5");
    expect(result.text).toBe(linearReference(pages, "5"));
    expect(result.text).toContain("(4) Late 5/4.");
    expect(served.pagesFetched.sort((a, b) => a - b)).toEqual([0, 1]);
  });
});

describe("§ scan jumps near a deep § (finding 6)", () => {
  it("reads the predicted pages, not every page before them", async () => {
    const served = serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 950");
    expect(result.text).toBe(linearReference(UNIFORM, "950"));
    expect(result.text).toBe("§ 950\n(1) Text 950/1.\n(2) Text 950/2.");
    // Page 0 ends at § 100 → § 950 predicted near page 10; the last page too.
    expect(new Set(served.pagesFetched)).toEqual(new Set([0, 9, 10]));
  });

  it("reads back when the § begins at the end of the page before the first guessed one", async () => {
    const flat = run(1, 1100);
    // § 750 (fragments 2247–2249): its heading and odst. 1 close page 6, odst. 2 opens page 7.
    const starts = [0, 300, 625, 950, 1275, 1600, 1925, 2249, 2750, 3000, 3150];
    const pages = cut(flat, starts);
    expect(pages[6].at(-1)?.zkracenaCitace).toBe("§ 750 odst. 1 zákona č. 89/2012 Sb.");
    expect(pages[7][0].zkracenaCitace).toBe("§ 750 odst. 2 zákona č. 89/2012 Sb.");
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 750");
    expect(result.text).toBe("§ 750\n(1) Text 750/1.\n(2) Text 750/2.");
    expect(result.text).toBe(linearReference(pages, "750"));
    // Guesses 7–9 and the last page; then page 6 for the § heading.
    expect(new Set(served.pagesFetched)).toEqual(new Set([0, 6, 7, 8, 9, 10]));
  });

  it("reads back from a guessed page whose § is interleaved with another, even after a foreign fragment", async () => {
    const flat = run(1, 1100);
    const at = (label: string) => flat.findIndex((f) => f.zkracenaCitace === `§ ${label} zákona č. 89/2012 Sb.`);
    // Page 6 ends with § 750's heading; page 7 opens with the rest of § 749,
    // then § 750 odst. 1, § 751's heading, and § 750 odst. 2 served late.
    const page7 = [
      { kodTypuFragmentu: "Odstavec_Dc", zkracenaCitace: "§ 749 odst. 3 zákona č. 89/2012 Sb.", xhtml: "(3) Text 749/3." },
      flat[at("750") + 1],
      ...flat.slice(at("751"), at("751") + 3),
      flat[at("750") + 2],
      ...flat.slice(at("752"), at("800")),
    ];
    const bounds = ["101", "250", "375", "500", "625", "750"];
    const pages = [
      flat.slice(0, at("101")),
      ...bounds.slice(0, -1).map((label, i) => flat.slice(at(label), at(bounds[i + 1]))),
      [flat[at("750")]],
      page7,
      flat.slice(at("800"), at("900")),
      flat.slice(at("900"), at("1000")),
      flat.slice(at("1000")),
    ];
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 750");
    expect(result.text).toBe(linearReference(pages, "750"));
    expect(result.text.startsWith("§ 750\n")).toBe(true);
    expect(served.pagesFetched).toContain(6);
  });

  it("answers NOT_FOUND for a § past the act's end after two rounds, not 15 pages", async () => {
    const served = serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const error = await getSection("sb", 2012, 89, undefined, "§ 5000").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "NOT_FOUND" });
    expect((error as Error).message).toContain("the act's last § is § 1100 (fragment page 11 of 11)");
    expect(new Set(served.pagesFetched)).toEqual(new Set([0, 9, 10]));
  });

  it("answers NOT_FOUND for a § missing between ordered neighbours", async () => {
    const served = serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const error = await getSection("sb", 2012, 89, undefined, "§ 950a").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "NOT_FOUND" });
    expect((error as Error).message).toContain("would sit on fragment page 10 (§ 901 – § 1000)");
    expect(served.pagesFetched.length).toBeLessThanOrEqual(3);
  });

  it("narrows in on the § when the guess from page 0 misses", async () => {
    // Page 0 twice as dense as the rest: § 950 is predicted near page 5 but sits on page 8.
    const pages = pagesOf([[1, 200], ...Array.from({ length: 10 }, (_, p) => [201 + p * 100, 300 + p * 100] as [number, number])]);
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 950");
    expect(result.text).toBe(linearReference(pages, "950"));
    expect(served.pagesFetched).not.toContain(1);
  });

  it("falls back to the linear scan when §§ restart (non-monotonic)", async () => {
    // Body §§ 1–700 on pages 0–5, then numbering restarts at § 1 on page 6.
    const pages = pagesOf([
      [1, 200],
      [201, 300],
      [301, 400],
      [401, 500],
      [501, 600],
      [601, 700],
      [1, 100],
      [101, 200],
      [201, 300],
      [301, 400],
      [401, 500],
    ]);
    serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 650");
    expect(result.text).toBe(linearReference(pages, "650"));
  });

  it("never lets an annex restarting its own §§ stand in for the body's §", async () => {
    // Sparse page 0 (long §§): § 420 predicted near page 8 — where the annex has one.
    const pages = [
      run(1, 50, 2, "norma"),
      ...Array.from({ length: 5 }, (_, p) => run(51 + p * 200, 250 + p * 200, 2, "norma")),
      ...Array.from({ length: 5 }, (_, p) => run(1 + p * 100, 100 + p * 100, 2, "prilohy")),
    ];
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 420");
    expect(result.text).toBe(linearReference(pages, "420"));
    expect(served.pagesFetched).toContain(2);
  });

  it("stops where the § visibly ended, even when the jump already read a later page with that number", async () => {
    // § 950 ends mid-page 9 (§ 951 follows); page 10, read by the jump, opens
    // with a stray fragment numbered 950 — another §, never part of this one.
    const pages = UNIFORM.map((page) => [...page]);
    pages[10] = [
      { kodTypuFragmentu: "Odstavec_Dc", zkracenaCitace: "§ 950 odst. 9 zákona č. 89/2012 Sb.", xhtml: "(9) Stray 950/9." },
      ...pages[10],
    ];
    const served = serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 950");
    expect(served.pagesFetched).toContain(10);
    expect(result.text).toBe("§ 950\n(1) Text 950/1.\n(2) Text 950/2.");
  });

  it("in the linear fallback, a page the jump read further on does not win over an earlier one", async () => {
    // Body: § 1–10 on page 0, then 100 a page (§ 611–710 on page 7).
    // Annex from page 10: its own §§ from 1, 200 a page (§ 601–800 on page 13).
    const pages = [
      run(1, 10, 2, "norma"),
      ...Array.from({ length: 9 }, (_, p) => run(11 + p * 100, 110 + p * 100, 2, "norma")),
      ...Array.from({ length: 5 }, (_, p) => run(1 + p * 200, 200 + p * 200, 2, "prilohy")),
    ];
    serve(new Map([[89, pages]]));
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 650");
    expect(result.text).toBe(linearReference(pages, "650"));
  });
});

/** mulberry32 — a seeded generator, so a failure names its case. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("§ scan returns what the linear scan returned — randomized acts", () => {
  it("matches the reference on random acts — random §§, every § at a page boundary, absent §§", async () => {
    const random = prng(20260930);
    const acts = new Map<number, Frag[][]>();
    const cases: Array<{ number: number; target: string }> = [];
    for (let number = 1; number <= 30; number++) {
      const flat: Frag[] = [];
      const labels: string[] = [];
      const count = 20 + Math.floor(random() * 400);
      for (let n = 1; n <= count; n++) {
        if (random() < 0.05) continue; // a gap: a number the act does not use
        if (random() < 0.05) flat.push({ kodTypuFragmentu: "Nadpis_nad", zkracenaCitace: "Část 1 Hlava 2 zákona č. 89/2012 Sb.", xhtml: "HLAVA" });
        flat.push(...paragraf(String(n), Math.floor(random() * 4), { heading: random() < 0.3 }));
        labels.push(String(n));
        if (random() < 0.08) {
          flat.push(...paragraf(`${n}a`, 1 + Math.floor(random() * 2)));
          labels.push(`${n}a`);
        }
      }
      // 1–12 pages, cut anywhere (§§ run over page ends); page 0 denser or sparser.
      const pageCount = 1 + Math.floor(random() * 12);
      const starts = new Set<number>([0]);
      while (starts.size < Math.min(pageCount, flat.length)) starts.add(1 + Math.floor(random() * (flat.length - 1)));
      const pages = cut(flat, [...starts].sort((a, b) => a - b));
      acts.set(number, pages);
      for (let k = 0; k < 3; k++) cases.push({ number, target: labels[Math.floor(random() * labels.length)] });
      // Every § a page boundary cuts through — or that ends or opens a page.
      const labelOf = (fragment: Frag | undefined) => /^§ (\w+)/.exec(fragment?.zkracenaCitace ?? "")?.[1];
      for (const page of pages.slice(1)) {
        for (const target of [labelOf(page[0]), labelOf(page.find((f) => f.zkracenaCitace.startsWith("§")))]) {
          if (target) cases.push({ number, target });
        }
      }
      for (const page of pages.slice(0, -1)) {
        const target = labelOf(page.at(-1));
        if (target) cases.push({ number, target });
      }
      cases.push({ number, target: String(count + 1 + Math.floor(random() * 3000)) }); // past the end
      cases.push({ number, target: `${1 + Math.floor(random() * count)}b` }); // most likely absent
    }
    serve(acts);
    const { getSection } = await load();
    for (const { number, target } of cases) {
      const expected = linearReference(acts.get(number)!, target);
      const got = await getSection("sb", 2012, number, undefined, target).then(
        (result) => result.text,
        (error: { kind?: string }) => {
          expect(error.kind, `act ${number} § ${target}`).toBe("NOT_FOUND");
          return null;
        },
      );
      expect(got, `act ${number} § ${target} (${acts.get(number)!.length} pages)`).toBe(expected);
    }
  });
});

describe("SPARQL races the scan and is skipped while it does not help (finding 3)", () => {
  it("costs one request, then none until its breaker window passes", async () => {
    const served = serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const start = Date.now();
    expect((await getSection("sb", 2012, 89, undefined, "§ 29")).via).toBe("scan");
    expect(served.sparql).toBe(1);
    await getSection("sb", 2012, 89, undefined, "§ 30");
    expect(served.sparql).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(start + 31 * 60 * 1000);
    await getSection("sb", 2012, 89, undefined, "§ 31");
    expect(served.sparql).toBe(2);
  });

  it("never waits for a hanging SPARQL endpoint, and asks it once, without a retry", async () => {
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    let sparqlCalls = 0;
    vi.stubGlobal("fetch", async (input: string, init?: { signal?: AbortSignal }) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/sparql?")) {
        sparqlCalls++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      if (url.includes("/fragmenty")) return new Response(JSON.stringify({ pocetStranek: 11, seznam: UNIFORM[0] }));
      return new Response(JSON.stringify({ nazev: "Zákon", staleUrl: "/sb/2012/89/2026-01-01", typZneni: "AKTUALNI" }));
    });
    const { getSection } = await load();
    const began = performance.now();
    const result = await getSection("sb", 2012, 89, undefined, "§ 29");
    expect(performance.now() - began).toBeLessThan(1000);
    expect(result.via).toBe("scan");
    expect(sparqlCalls).toBe(1);
    // detail + page 0 at the default 15 s; SPARQL at its own short timeout.
    expect(timeouts).toContain(4_000);
    expect(timeouts.filter((ms) => ms === 4_000)).toHaveLength(1);
  });

  it("serves SPARQL's text when it answers first", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/sparql?")) {
        return new Response(
          JSON.stringify({ results: { bindings: [{ text: { value: "<p>§ 29</p>" } }, { text: { value: "(1) Ze SPARQL." } }] } }),
          { headers: { "content-type": "application/sparql-results+json" } },
        );
      }
      if (url.includes("/fragmenty")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response(JSON.stringify({ pocetStranek: 1, seznam: UNIFORM[0] }));
      }
      return new Response(JSON.stringify({ nazev: "Zákon", staleUrl: "/sb/2012/89/2026-01-01", typZneni: "AKTUALNI" }));
    });
    const { getSection } = await load();
    const result = await getSection("sb", 2012, 89, undefined, "§ 29");
    expect(result).toMatchObject({ via: "sparql", text: "§ 29\n(1) Ze SPARQL." });
  });

  it("stops asking once it answers empty for a § the scan finds", async () => {
    let sparqlCalls = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/sparql?")) {
        sparqlCalls++;
        return new Response(JSON.stringify({ results: { bindings: [] } }), {
          headers: { "content-type": "application/sparql-results+json" },
        });
      }
      if (url.includes("/fragmenty")) return new Response(JSON.stringify({ pocetStranek: 1, seznam: UNIFORM[0] }));
      return new Response(JSON.stringify({ nazev: "Zákon", staleUrl: "/sb/2012/89/2026-01-01", typZneni: "AKTUALNI" }));
    });
    const { getSection } = await load();
    expect((await getSection("sb", 2012, 89, undefined, "§ 29")).via).toBe("scan");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await getSection("sb", 2012, 89, undefined, "§ 30");
    expect(sparqlCalls).toBe(1);
  });

  it("does not mark e-Sbírka as down when only SPARQL is refused", async () => {
    serve(new Map([[89, UNIFORM]]));
    const { getSection } = await load();
    const { allSourceResults } = await import("@/src/sources/shared/health");
    await getSection("sb", 2012, 89, undefined, "§ 29");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const results = allSourceResults();
    expect(results.find((entry) => entry.source === "e-Sbírka")?.ok).toBe(true);
    expect(results.find((entry) => entry.source.includes("SPARQL"))?.ok).toBe(false);
  });
});
