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
vi.mock("@/src/sources/nss", () => ({ searchNss: vi.fn(), getNssDecision: vi.fn() }));
vi.mock("@/src/sources/nalus", () => ({ searchNalus: vi.fn(), getNalusDecision: vi.fn(), ecliToSz: vi.fn() }));
vi.mock("@/src/sources/curia", () => ({
  searchCuria: vi.fn(),
  getCuriaDocument: vi.fn(),
  caseNumberToCelex: vi.fn(),
}));

import { searchNs } from "@/src/sources/ns";
import { searchNss } from "@/src/sources/nss";
import { searchNalus } from "@/src/sources/nalus";
import { registerCzCaselaw } from "@/src/mcp/tools/cz-caselaw";
import { registerNs } from "@/src/mcp/tools/ns";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
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
});
