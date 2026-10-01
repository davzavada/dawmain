import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The tool layer over the sources: how query variants are merged and how one
 * failing variant or court is reported. Sources are mocked — these tests pin
 * what the tools do with their answers, not the scraping itself.
 */

vi.mock("@/src/sources/ns", () => ({
  searchNs: vi.fn(),
  getNsDecision: vi.fn(),
  nsBodyMissing: vi.fn(() => false),
  withHighlight: (url: string) => url,
}));
vi.mock("@/src/sources/nss", () => ({ searchNss: vi.fn(), getNssDecision: vi.fn(), getNssDecisionText: vi.fn() }));
vi.mock("@/src/sources/nalus", () => ({ searchNalus: vi.fn(), getNalusDecision: vi.fn(), ecliToSz: vi.fn() }));
vi.mock("@/src/sources/curia", async (importOriginal) => ({
  // The pure helpers (bestCuriaDocument, curiaDocKind…) stay real.
  ...(await importOriginal<typeof import("@/src/sources/curia")>()),
  searchCuria: vi.fn(),
  getCuriaDocument: vi.fn(),
  caseNumberToCelex: vi.fn(),
}));

import { getNsDecision, searchNs } from "@/src/sources/ns";
import { getNssDecisionText, searchNss } from "@/src/sources/nss";
import { getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { registerCzCaselaw } from "@/src/mcp/tools/cz-caselaw";
import { registerNs } from "@/src/mcp/tools/ns";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlerOf(register: (server: never) => void, name: string): Handler {
  const handlers: Record<string, Handler> = {};
  register({
    registerTool(toolName: string, _config: unknown, handler: Handler) {
      handlers[toolName] = handler;
    },
  } as never);
  return handlers[name];
}

const nsPage = (prefix: string, n: number, matched: number | null = null) => ({
  total: n,
  matched,
  truncated: false,
  empty: n === 0,
  hits: Array.from({ length: n }, (_, i) => ({
    unid: `${prefix}${String(i).padStart(31, "0")}`.slice(0, 32),
    caseNumbers: [`${prefix} ${i}`],
    category: "C",
    court: "Nejvyšší soud",
    url: `https://ns/${prefix}${i}`,
  })),
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ns_search merges variants round-robin", () => {
  it("shows every variant on the first page and says what each found", async () => {
    vi.mocked(searchNs).mockImplementation(async (input) =>
      input.query === "první" ? nsPage("A", 30) : nsPage("B", 30),
    );
    const handler = handlerOf(registerNs as never, "ns_search");
    const result = await handler({ queries: ["první", "druhá"], limit: 4, offset: 0, read_top: 0 });
    const items = result.structuredContent?.items as Array<{ caseNumbers: string[] }>;
    expect(items.map((item) => item.caseNumbers[0])).toEqual(["A 0", "B 0", "A 1", "B 1"]);
    expect(result.structuredContent?.variant_totals).toEqual([30, 30]);
    expect(result.content[0].text).toContain('Variants: "první" 30 · "druhá" 30');
  });

  it("keeps answering when one variant fails, and names it", async () => {
    vi.mocked(searchNs).mockImplementation(async (input) => {
      if (input.query === "chybná") throw new Error("HTTP 500");
      return nsPage("A", 3);
    });
    const handler = handlerOf(registerNs as never, "ns_search");
    const result = await handler({ queries: ["dobrá", "chybná"], limit: 20, offset: 0, read_top: 0 });
    expect((result.structuredContent?.items as unknown[]).length).toBe(3);
    expect(result.structuredContent?.failed_variants).toEqual([{ variant: "chybná", error: "HTTP 500" }]);
    expect(result.content[0].text).toContain('⚠ Variant "chybná" failed');
  });
});

describe("per-court inverted date ranges", () => {
  it("ns_search refuses one before any request", async () => {
    const handler = handlerOf(registerNs as never, "ns_search");
    const result = await handler({ query: "náhrada", date_from: "2026-01-01", date_to: "2025-01-01", limit: 5, offset: 0, read_top: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("date_from 2026-01-01 is after date_to 2025-01-01");
    const published = await handler({ query: "náhrada", published_from: "2026-01-02", published_to: "2026-01-01", limit: 5, offset: 0, read_top: 0 });
    expect(published.content[0].text).toContain("published_from 2026-01-02 is after published_to 2026-01-01");
    expect(searchNs).not.toHaveBeenCalled();
  });
});

describe("caselaw_search", () => {
  const nssHit = (id: string, court: string) => ({
    id,
    caseNumber: `${id} As 1/2026`,
    court,
    date: "2026-01-01",
    form: "rozsudek",
    url: `https://nss/${id}`,
  });

  it("asks NSS for its own decisions and NALUS for relevance by default", async () => {
    vi.mocked(searchNss).mockResolvedValue({ total: 1, hits: [nssHit("1", "Nejvyššího správního soudu")], pagination: null, blankForm: false, page: 1 } as never);
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 1) as never);
    vi.mocked(searchNalus).mockResolvedValue({ total: 0, empty: true, hits: [] } as never);
    const handler = handlerOf(registerCzCaselaw as never, "caselaw_search");
    await handler({ query: "zásahová žaloba", per_source_limit: 5, include_eu: false, include_regional: false, read_top: 0 });
    expect(vi.mocked(searchNss).mock.calls[0][0]).toMatchObject({ court: "nss" });
    expect(vi.mocked(searchNalus).mock.calls[0][0]).toMatchObject({ sort: "relevance" });
  });

  it("lets the regional courts in only on request, and then names them", async () => {
    vi.mocked(searchNss).mockResolvedValue({
      total: 1,
      hits: [nssHit("9", "Krajského soudu v Hradci Králové")],
      pagination: null,
      blankForm: false,
      page: 1,
    } as never);
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 0) as never);
    vi.mocked(searchNalus).mockResolvedValue({ total: 0, empty: true, hits: [] } as never);
    const handler = handlerOf(registerCzCaselaw as never, "caselaw_search");
    const result = await handler({ query: "zásahová žaloba", per_source_limit: 5, include_eu: false, include_regional: true, read_top: 0 });
    expect(vi.mocked(searchNss).mock.calls[0][0]).not.toHaveProperty("court");
    const items = result.structuredContent?.items as Array<{ court?: string }>;
    expect(items[0].court).toBe("Krajského soudu v Hradci Králové");
    expect(result.content[0].text).toContain("— Krajského soudu v Hradci Králové");
  });

  it("a slow variant costs only itself — the court still answers with the others", async () => {
    vi.mocked(searchNss).mockImplementation(async (input) => {
      if (input.query === "nezákonný zásah správního orgánu") throw new Error("timed out after 26000 ms");
      return { total: 129, hits: [nssHit("1", "Nejvyššího správního soudu")], pagination: null, blankForm: false, page: 1 } as never;
    });
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 1) as never);
    vi.mocked(searchNalus).mockResolvedValue({ total: 0, empty: true, hits: [] } as never);
    const handler = handlerOf(registerCzCaselaw as never, "caselaw_search");
    const result = await handler({
      queries: ["zásahová žaloba", "nezákonný zásah správního orgánu"],
      per_source_limit: 5,
      include_eu: false,
      include_regional: false,
      read_top: 0,
    });
    const statuses = result.structuredContent?.statuses as Array<{ source: string; ok: boolean; total: number; variant_totals?: unknown; note?: string }>;
    const nss = statuses.find((status) => status.source === "nss");
    expect(nss?.ok).toBe(true);
    expect(nss?.total).toBe(129);
    expect(nss?.variant_totals).toEqual([129, null]);
    expect(nss?.note).toContain('variant "nezákonný zásah správního orgánu" failed');
  });

  const caselaw = (args: Record<string, unknown>) =>
    handlerOf(registerCzCaselaw as never, "caselaw_search")({
      per_source_limit: 5,
      include_eu: false,
      include_regional: false,
      read_top: 0,
      ...args,
    });
  const nssPage = (hits: unknown[], total = hits.length) =>
    ({ total, hits, pagination: null, blankForm: false, page: 1 }) as never;
  const nalusHit = (sz: string, extra: Record<string, unknown> = {}) => ({
    sz,
    caseNumber: `Pl.ÚS ${sz}`,
    date: "2025-10-22",
    url: `https://nalus/${sz}`,
    ...extra,
  });
  const quiet = () => {
    vi.mocked(searchNss).mockResolvedValue(nssPage([]));
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 0) as never);
    vi.mocked(searchNalus).mockResolvedValue({ total: 0, empty: true, hits: [] } as never);
  };

  it("refuses an inverted date range before any upstream request", async () => {
    quiet();
    const result = await caselaw({ query: "daň z přidané hodnoty", date_from: "2026-01-01", date_to: "2025-01-01" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("date_from 2026-01-01 is after date_to 2025-01-01");
    expect(searchNss).not.toHaveBeenCalled();
    expect(searchNs).not.toHaveBeenCalled();
    expect(searchNalus).not.toHaveBeenCalled();
  });

  it("names each detail tool's real parameter, and the decision form", async () => {
    vi.mocked(searchNss).mockResolvedValue(nssPage([nssHit("1", "Nejvyššího správního soudu")]));
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 1) as never);
    vi.mocked(searchNalus).mockResolvedValue({
      total: 1,
      empty: false,
      hits: [nalusHit("Pl-6-25_1", { form: "nález", citation: "Pl.ÚS 6/25, nález ze dne 22. 10. 2025 (N 1/1 SbNU 1; 1/2025 Sb.)" })],
    } as never);
    const text = (await caselaw({ query: "zásahová žaloba" })).content[0].text;
    expect(text).toContain("1 As 1/2026 (rozsudek, 2026-01-01) → nss_get_decision document_id: 1");
    expect(text).toMatch(/ns_get_decision unid: A0+/);
    expect(text).toContain("Pl.ÚS Pl-6-25_1 (nález, 2025-10-22) — N 1/1 SbNU 1; 1/2025 Sb. → us_get_decision sz: Pl-6-25_1");
    expect(text).not.toContain("id/sz");
  });

  it("says when the NSS index states no court", async () => {
    quiet();
    vi.mocked(searchNss).mockResolvedValue(nssPage([nssHit("5", "")]));
    const result = await caselaw({ query: "kárné provinění", sources: ["nss"] });
    expect((result.structuredContent?.items as Array<{ court?: string }>)[0].court).toBe("");
    expect(result.content[0].text).toContain("— court not stated (see nss_get_decision)");
  });

  it("prints the NS relevance floor as ≥, and '?' (not ✗) for a count a variant did not report", async () => {
    quiet();
    vi.mocked(searchNs).mockImplementation(async (input) =>
      input.query === "náhrada škody"
        ? ({ ...nsPage("A", 3, 1000), total: 900, matchedIsMinimum: true, truncated: true } as never)
        : ({ ...nsPage("B", 1), total: null, matched: null } as never),
    );
    const text = (await caselaw({ queries: ["náhrada škody", "škoda vzniklá"], sources: ["ns"] })).content[0].text;
    expect(text).toContain("✓ NS: ≥1000 matches (per variant: ≥1000 · ?)");
  });

  it("marks only a failed variant with ✗", async () => {
    quiet();
    vi.mocked(searchNs).mockImplementation(async (input) => {
      if (input.query === "chybná") throw new Error("HTTP 500");
      return nsPage("A", 2) as never;
    });
    const text = (await caselaw({ queries: ["dobrá", "chybná"], sources: ["ns"] })).content[0].text;
    expect(text).toContain("(per variant: 2 · ✗)");
  });

  it("passes NS and NALUS the lane's deadline, so a request given up on is never sent", async () => {
    quiet();
    const before = Date.now();
    await caselaw({ query: "zásahová žaloba" });
    const nsOptions = vi.mocked(searchNs).mock.calls[0][3] as { deadlineAt: number };
    const nalusOptions = vi.mocked(searchNalus).mock.calls[0][3] as { deadlineAt: number };
    expect(nsOptions.deadlineAt).toBeGreaterThanOrEqual(before + 20_000);
    expect(nsOptions.deadlineAt).toBeLessThanOrEqual(Date.now() + 20_000);
    expect(nalusOptions.deadlineAt).toBe(nsOptions.deadlineAt);
  });

  it("does not advise broadening the query when a court failed, and fails when none answered", async () => {
    quiet();
    vi.mocked(searchNss).mockRejectedValue(new Error("timed out after 26000 ms"));
    const partial = await caselaw({ query: "zásahová žaloba" });
    expect(partial.isError).toBeFalsy();
    expect(partial.content[0].text).not.toContain("No hits in any court");
    expect(partial.content[0].text).toContain("NSS did not answer — retry it or use nss_search");

    vi.mocked(searchNs).mockRejectedValue(new Error("down"));
    vi.mocked(searchNalus).mockRejectedValue(new Error("down"));
    const none = await caselaw({ query: "zásahová žaloba" });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("No court answered");
    expect(none.content[0].text).not.toContain("broaden");
  });

  it("keeps 'broaden the query' for a search every court answered", async () => {
    quiet();
    const text = (await caselaw({ query: "zásahová žaloba" })).content[0].text;
    expect(text).toContain("No hits in any court — broaden the query or add variants.");
  });

  describe("the CJEU lane", () => {
    const affair = (caseNumber: string, docs: Array<Record<string, unknown>>) => ({
      key: caseNumber,
      caseNumber,
      docs: docs.map((doc) => ({ caseNumber, ...doc })),
    });
    const curiaPage = (affairs: unknown[]) =>
      ({ total: affairs.length, affairs, hits: [], filtered: 0 }) as never;

    it("lists one hit per case, by its judgment rather than the summary listed first", async () => {
      vi.mocked(searchCuria).mockResolvedValue(
        curiaPage([
          affair("T-504/19", [
            { ecli: "ECLI:EU:T:2021:185", docType: "RES", logicDocId: "id_1", date: "2021-04-14", url: "https://curia/?docid=239926" },
            { ecli: "ECLI:EU:T:2021:185", docType: "ARRET", logicDocId: "id_2", date: "2021-04-14", url: "https://curia/?docid=239865" },
            { docType: "PUB_COMM", logicDocId: "id_3", date: "2021-06-01", url: "https://curia/?docid=3" },
          ]),
        ]),
      );
      const result = await caselaw({ query: "safe harbour", sources: ["sdeu"] });
      const items = result.structuredContent?.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ url: "https://curia/?docid=239865", form: "judgment", logicDocId: "id_2", more: 2 });
      expect(result.content[0].text).toContain(
        "[SDEU] T-504/19 (judgment, 2021-04-14) → sdeu_get_document ecli: ECLI:EU:T:2021:185 (logic_doc_id: id_2) (+2 more documents: sdeu_search {case_number})",
      );
    });

    it("merges a case found by two variants into one hit", async () => {
      vi.mocked(searchCuria).mockResolvedValue(
        curiaPage([affair("C-311/18", [{ ecli: "ECLI:EU:C:2020:559", docType: "ARRET", logicDocId: "id_9" }])]),
      );
      const result = await caselaw({ queries: ["privacy shield", "safe harbour"], sources: ["sdeu"] });
      expect(result.structuredContent?.items as unknown[]).toHaveLength(1);
    });

    it("previews a Czech query in Czech, with both ids; an English one in English", async () => {
      vi.mocked(searchCuria).mockResolvedValue(
        curiaPage([affair("T-504/19", [{ ecli: "ECLI:EU:T:2021:185", docType: "ARRET", logicDocId: "id_2" }])]),
      );
      vi.mocked(getCuriaDocument).mockResolvedValue({ text: "… představují bezpečný přístav …", via: "cellar", url: "u", language: "cs", fallback: false });
      const czech = await caselaw({ query: "bezpečný přístav", sources: ["sdeu"], read_top: 1 });
      expect(vi.mocked(getCuriaDocument).mock.calls[0][0]).toMatchObject({
        ecli: "ECLI:EU:T:2021:185",
        logicDocId: "id_2",
        language: "cs",
      });
      expect(czech.content[0].text).toContain("— PREVIEW [SDEU] T-504/19 (1× query terms)");
      vi.mocked(getCuriaDocument).mockClear();
      await caselaw({ query: "safe harbour", sources: ["sdeu"], read_top: 1 });
      expect(vi.mocked(getCuriaDocument).mock.calls[0][0]).toMatchObject({ language: "en" });
    });

    it("never fetches a case with no document id, and points to sdeu_search instead", async () => {
      vi.mocked(searchCuria).mockResolvedValue(curiaPage([affair("C-1/99", [{ url: "https://curia/list" }])]));
      const result = await caselaw({ query: "safe harbour", sources: ["sdeu"], read_top: 1 });
      expect(getCuriaDocument).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('no document id — sdeu_search {case_number: "C-1/99"}');
    });
  });

  it("reads NSS previews by text alone, and starts a lane's preview as soon as that lane answers", async () => {
    let releaseNss!: () => void;
    vi.mocked(searchNss).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseNss = () => resolve(nssPage([nssHit("1", "Nejvyššího správního soudu")]));
        }),
    );
    vi.mocked(searchNs).mockResolvedValue(nsPage("A", 1) as never);
    vi.mocked(searchNalus).mockResolvedValue({ total: 0, empty: true, hits: [] } as never);
    vi.mocked(getNsDecision).mockResolvedValue({ text: "zásahová žaloba je důvodná" } as never);
    vi.mocked(getNssDecisionText).mockResolvedValue("zásahová žaloba byla zamítnuta");
    const pending = caselaw({ query: "zásahová žaloba", read_top: 2 });
    // The NS lane (index 1 < read_top) answered: its preview is under way
    // while NSS has not answered yet.
    await vi.waitFor(() => expect(getNsDecision).toHaveBeenCalledTimes(1));
    expect(getNssDecisionText).not.toHaveBeenCalled();
    releaseNss();
    const result = await pending;
    expect(getNsDecision).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNsDecision).mock.calls[0][1]).toMatchObject({ deadlineAt: expect.any(Number) });
    expect(getNssDecisionText).toHaveBeenCalledWith("1");
    const previews = result.structuredContent?.previews as Array<{ source: string }>;
    expect(previews.map((preview) => preview.source)).toEqual(["nss", "ns"]);
  });

  it("previews ÚS hits with the lane's preview deadline", async () => {
    quiet();
    vi.mocked(searchNalus).mockResolvedValue({ total: 1, empty: false, hits: [nalusHit("1-1-25_1")] } as never);
    vi.mocked(getNalusDecision).mockResolvedValue({ text: "zásahová žaloba" } as never);
    await caselaw({ query: "zásahová žaloba", sources: ["us"], read_top: 1 });
    expect(vi.mocked(getNalusDecision).mock.calls[0]).toEqual(["1-1-25_1", { deadlineAt: expect.any(Number) }]);
  });
});

