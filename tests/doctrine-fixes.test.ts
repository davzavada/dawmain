import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRIMO_MAX_RESULTS,
  buildPrimoQuery,
  getPrimoRecord,
  mapPrimoDoc,
  primoLanguage,
  searchPrimo,
} from "@/src/sources/primo";
import { mergeDoiDuplicates, type BibHit } from "@/src/sources/shared/bib";
import { registerDoctrine } from "@/src/mcp/tools/doctrine";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(path.dirname(__dirname), "tests", "fixtures", name), "utf8")) as Record<string, unknown>;

type Result = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function tool(name: "doctrine_search" | "doctrine_get_record"): Handler {
  let handler: Handler | undefined;
  registerDoctrine({
    registerTool(registered: string, _config: unknown, callback: Handler) {
      if (registered === name) handler = callback;
    },
  } as never);
  if (!handler) throw new Error(`${name} did not register`);
  return handler;
}

const bookDoc = (fixture("primo/search-local-book.json") as { docs: Array<Record<string, unknown>> }).docs[0];

interface Catalogue {
  total: number;
  local?: number;
  central?: number;
  status?: number;
}

/**
 * A catalogue per keyword: the variant is the `any,contains,<word>` value
 * of q; record ids are `alma<word>-<rank>`, so the paging reads off the ids.
 * Offsets ≥ 500 are refused with 403, as Primo does live.
 */
function stub(catalogues: Record<string, Catalogue>) {
  const calls: Array<{ q: string; offset: number }> = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const q = u.searchParams.get("q") ?? "";
    const offset = Number(u.searchParams.get("offset") ?? "0");
    calls.push({ q, offset });
    if (offset >= 500) return new Response("forbidden", { status: 403 });
    const word = /any,contains,([^,]+),AND/.exec(q)?.[1] ?? "field";
    const cat = catalogues[word] ?? { total: 0 };
    if (cat.status) return new Response("nope", { status: cat.status });
    const count = Math.max(0, Math.min(10, cat.total - offset));
    const docs = Array.from({ length: count }, (_, i) => {
      const doc = JSON.parse(JSON.stringify(bookDoc)) as { pnx: { control: Record<string, unknown> } };
      doc.pnx.control.recordid = [`alma${word}-${offset + i}`];
      return doc;
    });
    const local = cat.local ?? cat.total;
    const central = cat.central ?? cat.total - local;
    return new Response(JSON.stringify({ info: { total: cat.total, totalResultsLocal: local, totalResultsPC: central }, docs }), { status: 200 });
  });
  return calls;
}

const ids = (r: Result) => ((r.structuredContent as { items: BibHit[] }).items ?? []).map((h) => h.id);
const out = (r: Result) => r.structuredContent as { has_more: boolean; total: number | null; items: BibHit[] } & Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------- doctrine-0: one year bound alone ----------

describe("year bounds (doctrine-0)", () => {
  it("always sends the pair, filling the missing side with the default bound", () => {
    expect(buildPrimoQuery({ query: "x", yearFrom: 2015 })).toBe("any,contains,x,AND;dr_s,exact,20150101,AND;dr_e,exact,21001231,AND");
    expect(buildPrimoQuery({ query: "x", yearTo: 2010 })).toBe("any,contains,x,AND;dr_s,exact,15000101,AND;dr_e,exact,20101231,AND");
    expect(buildPrimoQuery({ query: "x" })).toBe("any,contains,x,AND");
  });

  it("doctrine_search with year_from alone asks Primo for an open-ended range", async () => {
    const calls = stub({ rokyod: { total: 3 } });
    const result = await tool("doctrine_search")({ query: "rokyod", year_from: 2015, limit: 10, page: 1 });
    expect(result.isError).toBeUndefined();
    expect(calls[0].q).toContain("dr_s,exact,20150101,AND");
    expect(calls[0].q).toContain("dr_e,exact,21001231,AND");
  });
});

// ---------- doctrine-add0: language codes ----------

describe("language codes (doctrine-add0)", () => {
  it("maps terminology and two-letter codes onto the MARC codes Primo indexes", () => {
    expect(buildPrimoQuery({ query: "x", language: "ces" })).toBe("any,contains,x,AND;lang,exact,cze,AND");
    expect(primoLanguage("DEU")).toBe("ger");
    expect(primoLanguage("fra")).toBe("fre");
    expect(primoLanguage("cs")).toBe("cze");
    expect(primoLanguage("slk")).toBe("slo");
    expect(primoLanguage("cze")).toBe("cze");
    expect(primoLanguage("eng")).toBe("eng");
    expect(primoLanguage("xyz")).toBe("xyz");
  });

  it("doctrine_search sends the mapped code", async () => {
    const calls = stub({ jazyk: { total: 1 } });
    await tool("doctrine_search")({ query: "jazyk", language: "ces", limit: 10, page: 1 });
    expect(calls[0].q).toContain("lang,exact,cze,AND");
  });
});

// ---------- doctrine-1: the 500-record paging cap ----------

describe("the 500-record cap (doctrine-1)", () => {
  it("refuses an offset past the cap before the network, with advice to narrow", async () => {
    const calls = stub({});
    await expect(searchPrimo({ query: "capped" }, PRIMO_MAX_RESULTS)).rejects.toMatchObject({ kind: "INPUT_INVALID" });
    await expect(searchPrimo({ query: "capped" }, PRIMO_MAX_RESULTS)).rejects.toThrow(/first 500 records/);
    expect(calls).toHaveLength(0);
  });

  it("page 50 of 10 is the last one and the text names the cap", async () => {
    stub({ velky: { total: 10789, local: 443 } });
    const result = await tool("doctrine_search")({ query: "velky", limit: 10, page: 50 });
    expect(out(result).has_more).toBe(false);
    expect(ids(result)[0]).toBe("almavelky-490");
    expect(result.content[0].text).toContain("showing 491–500");
    expect(result.content[0].text).not.toContain("more: page 51");
    expect(result.content[0].text).toContain("Only the first 500 records of a list can be paged");
    // Below the cap the next page is advertised as before.
    const earlier = await tool("doctrine_search")({ query: "velky", limit: 10, page: 49 });
    expect(out(earlier).has_more).toBe(true);
  });

  it("a page wholly past the cap fetches nothing and says to narrow (not a token problem)", async () => {
    const calls = stub({ velky2: { total: 10789 } });
    const result = await tool("doctrine_search")({ query: "velky2", limit: 10, page: 51 });
    expect(calls).toHaveLength(0);
    expect(result.isError).toBeUndefined();
    expect(out(result)).toMatchObject({ has_more: false, items: [] });
    expect(result.content[0].text).toContain("only the first 500 records");
    expect(result.content[0].text).toMatch(/Narrow the search/);
    expect(result.content[0].text).not.toMatch(/token/i);
  });

  it("a window straddling the cap keeps its reachable records", async () => {
    const calls = stub({ velky3: { total: 10789 } });
    // limit 13, page 39 → ranks 494..506; only catalogue page 490–499 is reachable.
    const result = await tool("doctrine_search")({ query: "velky3", limit: 13, page: 39 });
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.offset)).toEqual([490]);
    expect(ids(result)).toEqual([494, 495, 496, 497, 498, 499].map((n) => `almavelky3-${n}`));
    expect(out(result).has_more).toBe(false);
  });

  it("a list within the cap is unchanged", async () => {
    stub({ maly: { total: 25 } });
    const p2 = await tool("doctrine_search")({ query: "maly", limit: 10, page: 2 });
    expect(out(p2).has_more).toBe(true);
    expect(p2.content[0].text).not.toContain("Only the first 500");
    const p3 = await tool("doctrine_search")({ query: "maly", limit: 10, page: 3 });
    expect(ids(p3)).toEqual(["almamaly-20", "almamaly-21", "almamaly-22", "almamaly-23", "almamaly-24"]);
    expect(out(p3).has_more).toBe(false);
  });
});

// ---------- doctrine-2 / doctrine-add1: multi-variant paging ----------

describe("multi-variant paging (doctrine-2, doctrine-add1)", () => {
  it("3 variants at limit 10 take 4, 3, 3 and no rank is ever skipped", async () => {
    stub({ va: { total: 100 }, vb: { total: 100 }, vc: { total: 100 } });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await tool("doctrine_search")({ queries: ["va", "vb", "vc"], limit: 10, page });
      expect(ids(result)).toHaveLength(10);
      seen.push(...ids(result));
    }
    expect(seen.slice(0, 10)).toEqual([
      "almava-0", "almavb-0", "almavc-0", "almava-1", "almavb-1", "almavc-1", "almava-2", "almavb-2", "almavc-2", "almava-3",
    ]);
    const ranks = (word: string) => seen.filter((id) => id.startsWith(`alma${word}-`)).map((id) => Number(id.split("-")[1]));
    expect(ranks("va")).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(ranks("vb")).toEqual(Array.from({ length: 9 }, (_, i) => i));
    expect(ranks("vc")).toEqual(Array.from({ length: 9 }, (_, i) => i));
  });

  it("2 variants of 30 keep has_more until every record has been shown", async () => {
    stub({ wa: { total: 30 }, wb: { total: 30 } });
    const all: string[] = [];
    for (let page = 1; page <= 6; page++) {
      const result = await tool("doctrine_search")({ queries: ["wa", "wb"], limit: 10, page });
      all.push(...ids(result));
      expect(out(result).has_more).toBe(page < 6);
    }
    expect(new Set(all).size).toBe(60);
  });

  it("a thin variant does not end the paging while the other still has records", async () => {
    stub({ hmA: { total: 12 }, hmB: { total: 3 } });
    const p2 = await tool("doctrine_search")({ queries: ["hmA", "hmB"], limit: 10, page: 2 });
    expect(out(p2).has_more).toBe(true);
    expect(p2.content[0].text).toContain("(more: page 3)");
    const p3 = await tool("doctrine_search")({ queries: ["hmA", "hmB"], limit: 10, page: 3 });
    expect(ids(p3)).toEqual(["almahmA-10", "almahmA-11"]);
    expect(out(p3).has_more).toBe(false);
  });

  it("a limit below the variant count leaves the last variant unsearched and says so", async () => {
    const calls = stub({ xa: { total: 50 }, xb: { total: 50 }, xc: { total: 50 } });
    const result = await tool("doctrine_search")({ queries: ["xa", "xb", "xc"], limit: 2, page: 1 });
    expect(ids(result)).toEqual(["almaxa-0", "almaxb-0"]);
    expect(calls.some((c) => c.q.includes("xc"))).toBe(false);
    expect(result.content[0].text).toContain('"xc" not searched (limit 2 is below the 3 variants — raise limit)');
  });
});

// ---------- doctrine-3: one failing variant ----------

describe("a failing variant (doctrine-3)", () => {
  it("costs only itself: the other variant's hits stay and the failure is named", async () => {
    stub({ Fx: { total: 5 }, Gx: { total: 0, status: 500 } });
    const result = await tool("doctrine_search")({ queries: ["Fx", "Gx"], limit: 10, page: 1 });
    expect(result.isError).toBeUndefined();
    expect(ids(result)).toEqual(["almaFx-0", "almaFx-1", "almaFx-2", "almaFx-3", "almaFx-4"]);
    expect(result.content[0].text).toContain('⚠ Variant "Gx" failed');
    expect(result.content[0].text).toContain('"Gx" ✗');
    expect(out(result).failed_variants).toEqual([expect.objectContaining({ variant: "Gx" })]);
    expect(out(result).variant_totals).toEqual([5, null]);
  });

  it("fails the call only when every variant fails", async () => {
    stub({ Hx: { total: 0, status: 500 }, Ix: { total: 0, status: 500 } });
    const result = await tool("doctrine_search")({ queries: ["Hx", "Ix"], limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 500/);
  });
});

// ---------- doctrine-8: totals from one variant ----------

describe("the header's totals (doctrine-8)", () => {
  it("take total, catalogue and CDI counts from the same variant and list each variant", async () => {
    stub({ genocidaT: { total: 266, local: 171, central: 95 }, genocideT: { total: 204, local: 92, central: 112 } });
    const result = await tool("doctrine_search")({ queries: ["genocidaT", "genocideT"], limit: 4, page: 1 });
    expect(out(result)).toMatchObject({ total: 266, total_local: 171, total_central: 95, variant_totals: [266, 204] });
    const text = result.content[0].text;
    expect(text).toContain("266 records (best variant) — 171 in the UK catalogue, 95 in the Central Discovery Index");
    expect(text).toContain('"genocidaT" 266 (171 + 95) · "genocideT" 204 (92 + 112)');
  });
});

// ---------- doctrine-4: container markers ----------

describe("container (doctrine-4)", () => {
  it("drops the PNX subfield tail of display.ispartof", () => {
    const hit = mapPrimoDoc({
      pnx: {
        control: { recordid: ["alma1"] },
        display: { title: ["T"], ispartof: ["Gosudarstvo i pravo Roč. -, č. 5 (2008), s. 64-72$$QGosudarstvo i pravo$$92008$$Z990005235240106986"] },
      },
    });
    expect(hit.container).toBe("Gosudarstvo i pravo Roč. -, č. 5 (2008), s. 64-72");
  });

  it("falls back to the OpenURL journal when ispartof is only markers", () => {
    const hit = mapPrimoDoc({
      pnx: { control: { recordid: ["alma2"] }, display: { title: ["T"], ispartof: ["$$QX$$Z1"] }, addata: { jtitle: ["Právník"] } },
    });
    expect(hit.container).toBe("Právník");
  });
});

// ---------- doctrine-5: the full record is whole ----------

describe("the full record (doctrine-5)", () => {
  const nineAuthors = {
    pnx: {
      control: { recordid: ["alma9authors"] },
      display: { title: ["Komentář"], creator: Array.from({ length: 9 }, (_, i) => `Autor${i + 1}, A.$$QAutor${i + 1}`) },
      addata: { isbn: ["978-80-1", "978-80-2"] },
    },
  };

  it("keeps every subject, author and identifier in the record view, the list caps in the list", () => {
    const record = fixture("primo/record-local-book.json");
    expect(mapPrimoDoc(record, true).subjects).toHaveLength(8);
    expect(mapPrimoDoc(record, false).subjects).toHaveLength(6);
    expect(mapPrimoDoc(nineAuthors, true).authors).toHaveLength(9);
    expect(mapPrimoDoc(nineAuthors, false).authors).toHaveLength(6);
  });

  it("checks the link cap before pushing a delivery link", () => {
    const hit = mapPrimoDoc({
      pnx: {
        control: { recordid: ["cdi_links"] },
        display: { title: ["T"] },
        links: { linktorsrc: ["$$Uhttps://a.test/1", "$$Uhttps://a.test/2"] },
      },
      delivery: { link: [{ linkType: "linktorsrc", linkURL: "https://a.test/3" }] },
    });
    expect(hit.links).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("doctrine_get_record prints all of it", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url.includes("alma9authors") ? nineAuthors : fixture("primo/record-local-book.json")), { status: 200 }),
    );
    const book = await tool("doctrine_get_record")({ id: "alma990020025980106986" });
    expect(book.content[0].text).toMatch(/Subjects: .*Arménie; Turecko\n/);
    const commentary = await tool("doctrine_get_record")({ id: "alma9authors" });
    const text = commentary.content[0].text;
    expect(text).toContain(`Authors: ${Array.from({ length: 9 }, (_, i) => `Autor${i + 1}, A.`).join("; ")}`);
    expect(text).toContain("Identifiers: ISBN 978-80-1, 978-80-2");
  });
});

// ---------- doctrine-6: a missing record ----------

describe("a missing record (doctrine-6)", () => {
  it("is NOT_FOUND when the body carries no record, PARSE_DRIFT when the record lacks its display", async () => {
    const bodies: Record<string, unknown> = {
      alma_missing1: { beaconO22: "x" },
      alma_missing2: { pnx: {} },
      alma_drift: { pnx: { control: { recordid: ["alma_drift"] } } },
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const id = Object.keys(bodies).find((key) => url.includes(`/${key}?`)) as string;
      return new Response(JSON.stringify(bodies[id]), { status: 200 });
    });
    await expect(getPrimoRecord("alma_missing1")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(getPrimoRecord("alma_drift")).rejects.toMatchObject({ kind: "PARSE_DRIFT" });
    const result = await tool("doctrine_get_record")({ id: "alma_missing2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no record alma_missing2/);
    expect(result.content[0].text).not.toMatch(/from memory/);
  });
});

// ---------- doctrine-7: no outer deadline on the record ----------

describe("record retry (doctrine-7)", () => {
  it("a first attempt that times out is retried and its answer returned", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on its own clock; tie it to the faked one.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    let calls = 0;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      return Promise.resolve(new Response(JSON.stringify(fixture("primo/record-local-book.json")), { status: 200 }));
    });
    const pending = tool("doctrine_get_record")({ id: "alma990020025980106986x" });
    await vi.advanceTimersByTimeAsync(20_000 + 1_600);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("100 rokov ticha");
    expect(calls).toBe(2);
  });
});

// ---------- doctrine-9: same work under two CDI ids ----------

describe("same-DOI duplicates (doctrine-9)", () => {
  const base = { source: "cuni" as const, title: "Aplikovaný výzkum fenoménu dehumanizace ve Rwandě", url: null };
  const unpaywall: BibHit = {
    ...base,
    id: "cdi_unpaywall_primary_10_21104_cl_2024_1_03",
    authors: [],
    doi: ["10.21104/cl.2024.1.03"],
    open_access: true,
    links: ["https://toolkit.ecn.cz/kolman_novy.pdf"],
    url: "https://x.test/unpaywall",
  };
  const crossref: BibHit = {
    ...base,
    title: "Aplikovaný výzkum fenoménu dehumanizace ve Rwandě.",
    id: "cdi_crossref_primary_10_21104_CL_2024_1_03",
    authors: ["Kolman, Ondřej"],
    year: "2024",
    abstract: "Abstrakt",
    doi: ["10.21104/CL.2024.1.03"],
    url: "https://x.test/crossref",
  };

  it("merges into the richer record, keeping its id and gaining the other's access", () => {
    const other: BibHit = { ...base, id: "alma1", authors: ["X"] };
    const merged = mergeDoiDuplicates([unpaywall, other, crossref]);
    expect(merged.map((h) => h.id)).toEqual(["cdi_crossref_primary_10_21104_CL_2024_1_03", "alma1"]);
    expect(merged[0]).toMatchObject({ authors: ["Kolman, Ondřej"], abstract: "Abstrakt", open_access: true });
    expect(merged[0].links).toEqual(["https://toolkit.ecn.cz/kolman_novy.pdf", "https://x.test/unpaywall"]);
  });

  it("keeps two works that share a DOI but not a title", () => {
    const chapter: BibHit = { ...crossref, id: "cdi_chapter", title: "Kapitola 3: Rwanda" };
    expect(mergeDoiDuplicates([crossref, chapter])).toHaveLength(2);
  });
});

// ---------- doctrine-10: cache key ----------

describe("search cache key (doctrine-10)", () => {
  it("inputs that make the same request share one upstream call", async () => {
    const calls = stub({ "klic a b": { total: 1 } });
    await searchPrimo({ query: "klic a, b", language: "CZE" }, 0, 10);
    await searchPrimo({ query: "klic a b", language: "cze" }, 0, 10);
    expect(calls).toHaveLength(1);
    await searchPrimo({ query: "klic a b", language: "cze" }, 10, 10);
    expect(calls).toHaveLength(2);
  });
});

// ---------- review: errors the variant bookkeeping must not swallow ----------

describe("review follow-ups", () => {
  it("fails the call when every searched variant fails, though another was not searched (limit below the variants)", async () => {
    const calls = stub({ Jx: { total: 0, status: 500 }, Kx: { total: 0, status: 500 }, Lx: { total: 50 } });
    const result = await tool("doctrine_search")({ queries: ["Jx", "Kx", "Lx"], limit: 2, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 500/);
    expect(calls.some((c) => c.q.includes("Lx"))).toBe(false);
  });

  it("refuses an unknown two-letter language code instead of silently matching nothing", async () => {
    const calls = stub({ Mx: { total: 5 } });
    const result = await tool("doctrine_search")({ query: "Mx", language: "sv", limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("3-letter code");
    expect(calls).toHaveLength(0);
    const mapped = await tool("doctrine_search")({ query: "Mx", language: "cs", limit: 10, page: 1 });
    expect(mapped.isError).toBeUndefined();
  });
});
