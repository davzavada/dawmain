import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_BUDGET_MS, SOURCE_MARGIN_MS, callDeadline, runWithCallClock } from "@/src/sources/shared/clock";
import { CELLAR_CALL_BUDGET_MS, cellarDeadline } from "@/src/sources/cellar";
import { assertDateRange, continuationHint, dateRangeError, isoDate } from "@/src/mcp/tools/shared";
import { buildPreviews, noTermsNote } from "@/src/mcp/tools/previews";
import { sectionWordsNote } from "@/src/mcp/tools/files";
import { getPrimoRecord } from "@/src/sources/primo";
import { SourceError } from "@/src/sources/shared/errors";

/**
 * The shared pieces the per-source fixes deferred: the one call clock the
 * per-source budgets read, calendar-checked dates and inverted ranges, the
 * excerpt-mode continuation, query-less previews, and the bounded Primo
 * guest-token path. Pure or with fetch mocked — no network.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the call clock", () => {
  it("caps a source budget by the request's arrival, less the margin", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const end = runWithCallClock(() => {
      // The handler starts 6 s after the request arrived (a slow auth).
      now += 6_000;
      return callDeadline(50_000);
    });
    expect(end).toBe(1_000_000 + CALL_BUDGET_MS - SOURCE_MARGIN_MS);
  });

  it("keeps a short budget as it is", () => {
    const now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(runWithCallClock(() => callDeadline(20_000))).toBe(now + 20_000);
  });

  it("outside the route counts from now, still under the boundary", () => {
    const now = 3_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(callDeadline(55_000)).toBe(now + CALL_BUDGET_MS - SOURCE_MARGIN_MS);
  });

  it("Cellar's budget ends before the boundary the registry answers at", () => {
    let now = 4_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const end = runWithCallClock(() => {
      now += 5_000;
      return cellarDeadline();
    });
    expect(end).toBeLessThan(4_000_000 + CALL_BUDGET_MS);
    expect(end).toBeLessThanOrEqual(now + CELLAR_CALL_BUDGET_MS);
  });
});

describe("dates", () => {
  it("isoDate refuses days that do not exist, and keeps its regex", () => {
    expect(isoDate.safeParse("2025-02-30").success).toBe(false);
    expect(isoDate.safeParse("2025-06-31").success).toBe(false);
    expect(isoDate.safeParse("2025-13-01").success).toBe(false);
    expect(isoDate.safeParse("2025-02-29").success).toBe(false);
    expect(isoDate.safeParse("2024-02-29").success).toBe(true);
    expect(isoDate.safeParse("2025-1-1").success).toBe(false);
    expect(isoDate.optional().safeParse(undefined).success).toBe(true);
    const schema = JSON.stringify(isoDate.toJSONSchema?.() ?? {});
    expect(schema).toContain("\\\\d{4}-\\\\d{2}-\\\\d{2}");
  });

  it("names an inverted range, and lets a valid or half-open one through", () => {
    expect(dateRangeError("2026-01-01", "2025-01-01")).toContain("date_from 2026-01-01 is after date_to 2025-01-01");
    expect(dateRangeError("2025-01-01", "2025-01-01")).toBeNull();
    expect(dateRangeError("2025-01-01", undefined)).toBeNull();
    expect(dateRangeError("2026-01-02", "2026-01-01", "published")).toContain("published_from");
    expect(() => assertDateRange("X", "2026-01-02", "2026-01-01")).toThrow(SourceError);
    try {
      assertDateRange("X", "2026-01-02", "2026-01-01");
    } catch (error) {
      expect((error as SourceError).kind).toBe("INPUT_INVALID");
    }
  });
});

describe("continuationHint", () => {
  it("says nothing in excerpt (find) mode — the excerpt tail already says how to go on", () => {
    expect(continuationHint({ mode: "excerpt", page: 1, total_pages: 1, has_more: true })).toBe("");
    expect(continuationHint({ mode: "page", page: 1, total_pages: 3, has_more: true })).toContain("page: 2");
    expect(continuationHint({ page: 1, total_pages: 3, has_more: true })).toContain("page: 2");
  });
});

describe("query-less previews", () => {
  it("fetch nothing without query terms, and the tool says why", async () => {
    const getText = vi.fn(async () => "text");
    expect(await buildPreviews([{ id: "1", caseNumber: "A" }], getText, [])).toBeUndefined();
    expect(getText).not.toHaveBeenCalled();
    expect(noTermsNote(2, [], "nss_get_decision").join("\n")).toContain("read_top previews need query/queries");
    expect(noTermsNote(2, ["azyl"], "nss_get_decision")).toEqual([]);
    expect(noTermsNote(0, [], "nss_get_decision")).toEqual([]);
  });
});

describe("files_search: a section with words that found nothing", () => {
  it("points to the section alone, which lists its passages", () => {
    expect(sectionWordsNote("§ 2913", ["prodlení"], "OZ")).toBe(
      'No passage inside § 2913 holds these words — the § itself may still be in the documents: files_search {section: "§ 2913", act: "OZ"} without a query lists its passages.',
    );
    expect(sectionWordsNote("§ 2913", [], undefined)).toBeNull();
    expect(sectionWordsNote(undefined, ["prodlení"], undefined)).toBeNull();
  });
});

describe("Primo's guest-token path", () => {
  it("is bounded by the call's budget: no token request once too little is left", async () => {
    let offset = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(String(url));
      // The refused unsigned request "takes" 46 s.
      offset += 46_000;
      return new Response("", { status: 401 });
    });
    const error = (await getPrimoRecord("alma9912345").catch((e: unknown) => e)) as SourceError;
    expect(error).toBeInstanceOf(SourceError);
    expect(error.message).toContain("time budget ran out");
    expect(sent).toHaveLength(1);
  });
});
