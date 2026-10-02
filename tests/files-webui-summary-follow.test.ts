// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The shared summary follows documents in processing on its own (so the
 * home page badge does not stay on "zpracovává se" with the modal closed)
 * and stops once nothing is processing.
 */

const store = await import("@/app/_zdroje/store");

const LIB: LibrarySummary = {
  id: "user_a",
  kind: "user",
  name: "Já",
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
  pagesUsed: 3,
  counts: { total: 1, ready: 0, review: 0, processing: 1, error: 0, searchable: 0 },
};
const summary = (processing: number): SummaryResponse => ({
  state: "ok",
  mode: "on",
  termsAccepted: true,
  libraries: [{ ...LIB, counts: { ...LIB.counts!, processing, ready: 1 - processing, searchable: 1 - processing } }],
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("summary follows processing", () => {
  it("refreshes until nothing is processing, then stops", async () => {
    vi.useFakeTimers();
    const answers = [summary(1), summary(1), summary(0)];
    const fetch = vi.fn(async () => new Response(JSON.stringify(answers.shift() ?? summary(0)), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    store.setAuth("signed_in");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    store.setAuth("signed_out");
  });
});
