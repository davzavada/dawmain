import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildJusticeQuery,
  normalizeSection,
  parseJusticeSearch,
  parseSection,
  searchJustice,
  slowSearchHint,
} from "@/src/sources/justice";
import { SourceError } from "@/src/sources/shared/errors";
import { justiceSearchText, registerJustice } from "@/src/mcp/tools/justice";

// ---------- helpers ----------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

const tools: Record<string, { config: Record<string, unknown>; handler: Handler }> = {};
registerJustice({
  registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
    tools[name] = { config, handler };
  },
} as never);

/** A live /api/finaldoc item (KSOS 8 Co 60/2025-174, captured 2026-09). */
const liveItem = {
  uuid: "0de9a948-38d8-4d00-8010-cf5a2e086f73",
  metadata: {
    type: "JUDGEMENT",
    ecli: "ECLI:CZ:KSOS:2025:8.Co.60.2025.1",
    publishedAt: "2025-07-23",
    decisionAt: "2025-06-02",
    caseNumber: { senate: 8, registry: "Co", index: 60, year: 2025, pageNumber: 174 },
    courtCode: "KSOS",
    caseSubject: "o zaplacení 94.401,99 Kč s příslušenstvím",
    affectedDocs: [
      {
        caseNumber: { senate: 12, registry: "C", index: 2, year: 2024, pageNumber: 144 },
        affectedDate: "2024-11-08",
        courtCode: "OSNJ",
        affectedTypes: ["CHANGE"],
        url: null,
      },
    ],
  },
  verdictText: "I. Rozsudek okresního soudu se v napadené části mění tak, že…",
  searchMatches: null,
};

const pageBody = (items: unknown[], totalElements: number, totalPages: number, pageNumber: number) =>
  JSON.stringify({ items, numberOfItems: items.length, pageNumber, totalPages, totalElements });

/** Handler args with the schema defaults the SDK would fill in. */
const args = (extra: Record<string, unknown>) => ({
  match: "all_words",
  sort: "published",
  limit: 5,
  page: 0,
  date_from: "2026-06-01",
  date_to: "2026-06-30",
  ...extra,
});

const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

// ---------- the answer text (justice-0, justice-3) ----------

describe("justice_search text: paging in the parameter's own terms", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the next page as the parameter value, never as a 1-based label", async () => {
    vi.stubGlobal("fetch", async () => new Response(pageBody([liveItem], 234, 47, 0)));
    const result = await tools.justice_search.handler(args({ query: "zzpaging-first" }));
    const text = result.content[0].text;
    expect(text).toContain("234 decisions by publication date (zveř.), newest first — hits 1–1 (page: 0, last page: 46):");
    expect(text).toContain("More: page: 1 (same arguments).");
    expect(text).not.toMatch(/page 1\/47/);
    expect(result.structuredContent?.has_more).toBe(true);
  });

  it("says a page past the end is past the end — not 'No decisions matched' (live: 234 hits, page: 47)", async () => {
    vi.stubGlobal("fetch", async () => new Response(pageBody([], 234, 47, 47)));
    const result = await tools.justice_search.handler(args({ query: "zzpaging-past", page: 47 }));
    const text = result.content[0].text;
    expect(text).toMatch(/Page 47 is past the end: 234 decisions fill pages 0–46 at limit 5/);
    expect(text).toMatch(/page: 46 or lower/);
    expect(text).not.toMatch(/No decisions matched/);
  });

  it("answers the verifier's live body for page 1 000 000 the same way", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response('{"items":[],"pageNumber":1000000,"totalPages":1,"totalElements":2}'),
    );
    const result = await tools.justice_search.handler(
      args({ case_number: "8 Co 60/2025", date_from: undefined, date_to: undefined, limit: 50, page: 1_000_000 }),
    );
    expect(result.content[0].text).toMatch(/Page 1000000 is past the end: 2 decisions fill pages 0–0/);
  });

  it("keeps 'No decisions matched' for a search that matched nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response(pageBody([], 0, 0, 0)));
    const result = await tools.justice_search.handler(args({ query: "zzpaging-none" }));
    expect(result.content[0].text).toMatch(/^No decisions matched\. This database starts 2020-10/);
  });

  it("keeps the default-window warning in front of every variant", async () => {
    vi.stubGlobal("fetch", async () => new Response(pageBody([], 234, 47, 47)));
    const result = await tools.justice_search.handler(
      args({ query: "zzpaging-window", date_from: undefined, date_to: undefined, page: 47 }),
    );
    expect(result.content[0].text).toMatch(/^⚠ Default window: only decisions issued from \d{4}-\d{2}-\d{2}[^]*\n\nPage 47 is past the end/);
  });

  it("tells an in-range page emptied by uuid-less rows apart from the end", () => {
    const page = parseJusticeSearch({ items: [{ metadata: {} }], totalElements: 12, totalPages: 3, pageNumber: 1 });
    const text = justiceSearchText(page, { page: 1, limit: 5 });
    expect(text).toMatch(/12 decisions matched, but page 1 returned no readable rows/);
    expect(text).toMatch(/try page: 2/);
    expect(text).not.toMatch(/past the end|No decisions matched/);
  });

  it("offers no More line on the last page", () => {
    const text = justiceSearchText(parseJusticeSearch(JSON.parse(pageBody([liveItem], 6, 2, 1))), {
      page: 1,
      limit: 5,
      sort: "decided",
    });
    expect(text).toContain("6 decisions by decision date, newest first — hits 6–6 (page: 1, last page: 1):");
    expect(text).toMatch(/^6\. 8 Co 60\/2025-174/m);
    expect(text).not.toMatch(/More:/);
  });
});

describe("justice_search text: what each hit carries", () => {
  it("prints the publication date, the ECLI and the affected decision's date", () => {
    const text = justiceSearchText(parseJusticeSearch(JSON.parse(pageBody([liveItem], 8, 2, 0))), {
      page: 0,
      limit: 5,
    });
    expect(text).toContain("1. 8 Co 60/2025-174 — KSOS (rozsudek) 2025-06-02, zveř. 2025-07-23");
    expect(text).toContain("\n   ECLI:CZ:KSOS:2025:8.Co.60.2025.1\n");
    expect(text).toContain("mění/potvrzuje: CHANGE 12 C 2/2024-144 (OSNJ, 2024-11-08)");
    expect(text).toContain("uuid 0de9a948-38d8-4d00-8010-cf5a2e086f73");
  });
});

// ---------- schema (justice-5) ----------

describe("justice_search page bound", () => {
  it("refuses a page past the upstream's int range instead of letting it 500 as an 'outage'", () => {
    const schema = tools.justice_search.config.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ page: 3_000_000_000 }).success).toBe(false);
    expect(schema.safeParse({ page: 1_000_000 }).success).toBe(true);
    expect(schema.safeParse({ page: 46 }).success).toBe(true);
  });
});

// ---------- applies_section / applies_act notation (justice-6) ----------

describe("applies_section and applies_act take ordinary legal notation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lower-cases the § letter — regulationParagraph is case-sensitive (live: 14B → 0, 14b → 1 382)", () => {
    expect(normalizeSection("§ 14B")).toBe("14b");
    expect(normalizeSection("§§ 14B")).toBe("14b");
    expect(normalizeSection("2201a")).toBe("2201a");
    expect(buildJusticeQuery({ appliesAct: "177/1996", appliesSection: "14B" }, 0, 20).get("regulationParagraph")).toBe(
      "14b",
    );
  });

  it("filters on the § of an odstavec label and hands the tail back", () => {
    expect(parseSection("§ 2201 odst. 1")).toEqual({ paragraph: "2201", dropped: "odst. 1" });
    expect(parseSection("2201 odst. 1 písm. a)")).toEqual({ paragraph: "2201", dropped: "odst. 1 písm. a)" });
    expect(parseSection(" § 2201, věta první")).toEqual({ paragraph: "2201", dropped: "věta první" });
    expect(parseSection("§ 2201")).toEqual({ paragraph: "2201" });
  });

  it("still refuses what is not a section label", () => {
    expect(() => normalizeSection("občanský zákoník")).toThrowError(/not a section label/);
    expect(() => normalizeSection("2201 a násl.")).toThrowError(SourceError);
    expect(() => normalizeSection("§ 2201 odstavce")).toThrowError(SourceError);
  });

  it("reads 'zákon č. 89/2012 Sb.' and 'č. 89/2012 Sb.' as 89/2012", () => {
    for (const act of ["zákon č. 89/2012 Sb.", "č. 89/2012 Sb.", "zákona č. 89/2012 Sb.", "zák. č. 89/2012", "89 / 2012"]) {
      const params = buildJusticeQuery({ appliesAct: act }, 0, 20);
      expect([act, params.get("regulationNumber"), params.get("regulationYear")]).toEqual([act, "89", "2012"]);
    }
    expect(() => buildJusticeQuery({ appliesAct: "obcansky zakonik" }, 0, 20)).toThrowError(SourceError);
  });

  it("says in the answer that the odstavec was not filtered on", async () => {
    vi.stubGlobal("fetch", async () => new Response(pageBody([liveItem], 1, 1, 0)));
    const result = await tools.justice_search.handler(
      args({ applies_act: "89/2012", applies_section: "§ 2201 odst. 1" }),
    );
    expect(result.content[0].text).toContain(
      'applies_section filtered by § 2201 only — the index records the §, not "odst. 1"; check that part when reading.',
    );
  });
});

// ---------- timeout hints (justice-1) ----------

// Failures are never cached, so these calls need no unique keys.
describe("justice.cz search timeout hint fits the call", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function timedOut(input: Parameters<typeof searchJustice>[0]): Promise<SourceError> {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw timeoutError();
    });
    const error = await searchJustice(input, 0, 5).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toMatch(/did not answer the search within 45 s/);
    return error as SourceError;
  }

  it("points a number or act citation in query to applies_act (live: '89/2012', '2012' time out in 10 days)", async () => {
    const { hint } = await timedOut({ query: "89/2012", decidedFrom: "2026-06-01", decidedTo: "2026-06-10" });
    expect(hint).toMatch(/applies_act '89\/2012'/);
    expect(hint).not.toMatch(/ONE distinctive word/);
    expect((await timedOut({ query: "nájem § 2201" })).hint).toMatch(/applies_act/);
  });

  it("points a bare applies_act to applies_section and narrower filters, not to query words", async () => {
    const { hint } = await timedOut({ appliesAct: "89/2012", decidedFrom: "2020-10-01" });
    expect(hint).toMatch(/applies_section/);
    expect(hint).not.toMatch(/ONE distinctive word|multi-word/);
  });

  it("gives a queryless listing the narrowing hint", async () => {
    const { hint } = await timedOut({ appliesAct: "99/1963", appliesSection: "§ 142", decidedFrom: "2020-10-02" });
    expect(hint).toMatch(/court_codes, types or a date window of months/);
    expect(hint).not.toMatch(/ONE distinctive word/);
  });

  it("keeps the one-word hint for a multi-word query", () => {
    expect(slowSearchHint({ query: "určení sazby odměny" })).toMatch(/ONE distinctive word/);
  });

  it("classifies a body read cut off by the timeout like a request that never answered", async () => {
    vi.stubGlobal("fetch", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(timeoutError());
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await searchJustice({ query: "zzbody slow" }, 0, 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toMatch(/did not answer the search within 45 s/);
    expect((error as SourceError).hint).toMatch(/ONE distinctive word/);
  });
});

// ---------- one retry for a FAST transient failure (justice-4) ----------

describe("justice.cz search retries a fast 429/5xx once", () => {
  // Fake timers so the 2 s back-off costs the suite nothing.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.catch((error) => ({ __thrown: error }) as never);
    await vi.runAllTimersAsync();
    const value = (await guarded) as T & { __thrown?: unknown };
    if (value && typeof value === "object" && "__thrown" in value) throw value.__thrown;
    return value;
  }

  it("gets through a 429 on the second try, its timeout cut to what is left of 45 s", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 429 }) : new Response(pageBody([liveItem], 1, 1, 0));
    });
    const page = await settle(searchJustice({ query: "zzretry429" }, 0, 5));
    expect(calls).toBe(2);
    expect(page.hits[0].uuid).toBe(liveItem.uuid);
    const [first, second] = timeouts.mock.calls.map(([ms]) => ms);
    expect(first).toBe(45_000);
    expect(second).toBeLessThanOrEqual(45_000 - 2_000);
  });

  it("retries a 5xx and a dropped connection too", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return calls === 1 ? new Response("boom", { status: 503 }) : new Response(pageBody([], 0, 0, 0));
    });
    await settle(searchJustice({ query: "zzretry503" }, 0, 5));
    expect(calls).toBe(2);

    calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(pageBody([], 0, 0, 0));
    });
    await settle(searchJustice({ query: "zzretrynet" }, 0, 5));
    expect(calls).toBe(2);
  });

  it("gives up after the one retry with the justice-specific 429 hint", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("busy", { status: 429 });
    });
    const error = (await settle(searchJustice({ query: "zzretry429twice" }, 0, 5)).catch((e: unknown) => e)) as SourceError;
    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(SourceError);
    expect(error.kind).toBe("UPSTREAM_ERROR");
    expect(error.message).toBe("justice.cz answered HTTP 429 for the search even after a retry.");
    expect(error.hint).toMatch(/429 under load/);
  });

  it("does not retry a failure that came late — the 45 s budget has no room for it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      vi.setSystemTime(Date.now() + 6_000);
      return new Response("busy", { status: 429 });
    });
    const error = (await settle(searchJustice({ query: "zzretrylate" }, 0, 5)).catch((e: unknown) => e)) as SourceError;
    expect(calls).toBe(1);
    expect(error.message).toBe("justice.cz answered HTTP 429 for the search.");
  });

  it("never retries a timeout", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw timeoutError();
    });
    const error = (await settle(searchJustice({ query: "zzretrytimeout" }, 0, 5)).catch((e: unknown) => e)) as SourceError;
    expect(calls).toBe(1);
    expect(error.message).toMatch(/within 45 s/);
  });
});

// ---------- cache keyed on the request (justice-add0) ----------

describe("justice.cz search cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves a respelled but identical request from the cache", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(pageBody([], 0, 0, 0));
    });
    await searchJustice({ courtCodes: ["ksbr"], appliesAct: "89/2012", appliesSection: "§ 2201", query: "zzkey" }, 0, 5);
    await searchJustice({ courtCodes: [" KSBR"], appliesAct: "89/2012 Sb.", appliesSection: "2201", query: "zzkey" }, 0, 5);
    expect(urls).toHaveLength(1);
  });

  it("still refuses a bad input before any fetch", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(pageBody([], 0, 0, 0));
    });
    await expect(searchJustice({ courtCodes: ["OSXX"], query: "zzkey-bad" }, 0, 5)).rejects.toThrow(
      /not a justice\.cz court code/,
    );
    expect(calls).toBe(0);
  });
});
