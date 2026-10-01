import { afterEach, describe, expect, it, vi } from "vitest";
import { canaries, registerProbe } from "@/src/mcp/tools/probe";

/**
 * dawmain_probe_sources (src/mcp/tools/probe.ts): unknown canary ids are
 * named instead of reported as a clean "0/0 sources healthy", and discover
 * runs side by side with the canaries.
 */

type Result = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function probe(): { handler: Handler; description: string } {
  let handler: Handler | undefined;
  let description = "";
  registerProbe({
    registerTool: (_name: string, config: { inputSchema: { shape: Record<string, { description?: string }> } }, h: Handler) => {
      handler = h;
      description = config.inputSchema.shape.sources.description ?? "";
    },
  } as never);
  return { handler: handler!, description };
}

const DEFAULTS = { include_raw: false, discover: false };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("unknown canary ids", () => {
  it("only unknown ids: an error naming them and the valid ids, no request made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await probe().handler({ ...DEFAULTS, sources: ["eurlex", "cellar_sparql"] });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain("0/0 sources healthy");
    expect(text).toContain("Unknown source id(s): eurlex, cellar_sparql");
    expect(text).toContain(`valid ids: ${canaries().map((c) => c.id).join(", ")}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("known and unknown ids: probes the known ones and names the rest", async () => {
    const fetchSpy = vi.fn(async () => new Response("<p>Výsledky</p>", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await probe().handler({ ...DEFAULTS, sources: ["ns", "nope"] });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("1/1 sources healthy");
    expect(lines[1]).toMatch(/^Unknown source id\(s\): nope — valid ids: esbirka-api, /);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("valid ids answer as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>Výsledky</p>", { status: 200 })));
    const result = await probe().handler({ ...DEFAULTS, sources: ["ns"] });
    expect(result.content[0].text).toMatch(/^1\/1 sources healthy\n\n✓ ns /);
  });

  it("the sources field names every canary id", () => {
    const { description } = probe();
    for (const { id } of canaries()) expect(description).toContain(id);
  });
});

describe("discover", () => {
  it("runs beside the canaries, justice beside NSS — and keeps the key order", async () => {
    // discover loads the HTML parser lazily; load it now, so no real-time
    // module load sits between the fake-timer steps.
    await import("@/src/sources/shared/html");
    vi.useFakeTimers();
    const answer = (text: string, ms: number) =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(text, { status: 200 })), ms));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL) => {
        const href = String(url);
        if (href === "https://rozhodnuti.justice.cz/") return answer('<script src="/main.js"></script>', 5_000);
        if (href === "https://rozhodnuti.justice.cz/main.js") return answer('fetch("/api/finaldoc/x")', 5_000);
        if (href === "https://vyhledavac.nssoud.cz/") return answer("<form></form>", 5_000);
        return answer('"rok": 2024', 5_000); // the justice canary
      }),
    );
    let result: Result | undefined;
    void probe()
      .handler({ ...DEFAULTS, discover: true, sources: ["justice"] })
      .then((r) => (result = r));
    // Sequentially: canary 5 s, then home 5 s + bundle 5 s, then the NSS form 5 s = 20 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBeDefined();
    const text = result!.content[0].text;
    expect(text).toContain("1/1 sources healthy");
    const json = JSON.parse(text.slice(text.indexOf("Discoveries:\n") + "Discoveries:\n".length));
    // NSS answered first; the JSON still reads justice, then nss.
    expect(Object.keys(json)).toEqual(["justice", "nss"]);
    expect(json.justice).toEqual({ scripts_scanned: 1, api_paths: ["/api/finaldoc/x"] });
    expect(json.nss).toEqual({ conditions: [] });
  });

  it("an error in one part does not stop the other", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("justice")) throw new Error("boom");
        return new Response("<form></form>", { status: 200 });
      }),
    );
    const result = await probe().handler({ ...DEFAULTS, discover: true, sources: ["nss"] });
    const text = result.content[0].text;
    const json = JSON.parse(text.slice(text.indexOf("Discoveries:\n") + "Discoveries:\n".length));
    expect(json).toEqual({ justice: { error: "boom" }, nss: { conditions: [] } });
  });
});
