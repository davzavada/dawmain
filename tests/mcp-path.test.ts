import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { CALL_BUDGET_MS, registerAllTools, runWithCallClock } from "@/src/mcp/tools";
import { registerPing } from "@/src/mcp/tools/ping";
import { registerProbe } from "@/src/mcp/tools/probe";
import { registerEsbirka } from "@/src/mcp/tools/esbirka";
import { registerNs } from "@/src/mcp/tools/ns";
import { registerNalus } from "@/src/mcp/tools/nalus";
import { registerNss } from "@/src/mcp/tools/nss";
import { registerCzCaselaw } from "@/src/mcp/tools/cz-caselaw";
import { registerJustice } from "@/src/mcp/tools/justice";
import { registerCuria } from "@/src/mcp/tools/curia";
import { registerEurlex } from "@/src/mcp/tools/eurlex";
import { registerDoctrine } from "@/src/mcp/tools/doctrine";
import { registerFiles } from "@/src/mcp/tools/files";
import { registerZotero } from "@/src/mcp/tools/zotero";

/**
 * The MCP request path (src/mcp/tools/index.ts): registrations are recorded
 * once and replayed into every per-request McpServer, and every tool answers
 * in text within the call's budget instead of being killed at maxDuration.
 */

type Handler = (...args: unknown[]) => Promise<Record<string, unknown>>;

/** The pre-recording path, verbatim in effect: every register* function run
 * per request through the text-only boundary (outputSchema and
 * structuredContent stripped). */
function registerTheOldWay(server: McpServer, zotero: boolean): void {
  const target = {
    registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
      const { outputSchema: _structured, ...rest } = config;
      return (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(
        name,
        rest,
        async (...args: unknown[]) => {
          const { structuredContent: _dropped, ...result } = await handler(...args);
          return result;
        },
      );
    },
  } as unknown as McpServer;
  for (const register of [
    registerPing,
    registerProbe,
    registerEsbirka,
    registerNs,
    registerNalus,
    registerNss,
    registerCzCaselaw,
    registerJustice,
    registerCuria,
    registerEurlex,
    registerDoctrine,
    registerFiles,
  ]) {
    register(target);
  }
  if (zotero) registerZotero(target);
}

const OPTIONS = { serverInfo: { name: "t", version: "0" }, instructions: "x", verboseLogs: false };

function rpc(id: number, method: string, params: unknown): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function body(handler: (req: Request) => Promise<Response>, req: Request): Promise<string> {
  return (await handler(req)).text();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recorded registrations", () => {
  for (const zotero of [true, false]) {
    it(`tools/list is byte-identical to the per-request registration (zotero: ${zotero})`, async () => {
      const replayed = createMcpHandler((server) => registerAllTools(server, { zotero }), OPTIONS);
      const old = createMcpHandler((server) => registerTheOldWay(server, zotero), OPTIONS);
      const before = await body(old, rpc(1, "tools/list", {}));
      const first = await body(replayed, rpc(1, "tools/list", {}));
      const second = await body(replayed, rpc(1, "tools/list", {}));
      expect(before.length).toBeGreaterThan(10_000);
      expect(first).toBe(before);
      expect(second).toBe(before);
      expect(before.includes('"zotero_search"')).toBe(zotero);
    });
  }

  it("tools/call validation errors and defaults are identical", async () => {
    const replayed = createMcpHandler((server) => registerAllTools(server, { zotero: false }), OPTIONS);
    const old = createMcpHandler((server) => registerTheOldWay(server, false), OPTIONS);
    const fetchSpy = vi.fn(async () => new Response("unused"));
    vi.stubGlobal("fetch", fetchSpy);
    for (const args of [{ fetch_url: "not a url" }, { include_raw: "yes" }, { sources: 3 }]) {
      const call = () => rpc(7, "tools/call", { name: "dawmain_probe_sources", arguments: args });
      const expected = await body(old, call());
      expect(expected).toContain("Input validation error");
      expect(await body(replayed, call())).toBe(expected);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const ping = (server: (req: Request) => Promise<Response>) =>
      body(server, rpc(8, "tools/call", { name: "dawmain_ping", arguments: {} }));
    const strip = (text: string) => text.replace(/serverTime[^,]+,/, "");
    expect(strip(await ping(replayed))).toBe(strip(await ping(old)));
  });

  it("records once: the same configs and handlers on every request, still text-only", () => {
    const capture = () => {
      const seen: Array<[string, Record<string, unknown>, unknown]> = [];
      registerAllTools({
        registerTool: (name: string, config: Record<string, unknown>, handler: unknown) =>
          void seen.push([name, config, handler]),
      } as never, { zotero: true });
      return seen;
    };
    const a = capture();
    const b = capture();
    expect(a.length).toBe(b.length);
    a.forEach(([name, config, handler], i) => {
      expect(b[i][0]).toBe(name);
      expect(b[i][1]).toBe(config);
      expect(b[i][2]).toBe(handler);
      expect(config).not.toHaveProperty("outputSchema");
    });
  });
});

describe("the call budget", () => {
  function probeHandler(): Handler {
    let found: Handler | undefined;
    registerAllTools({
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        if (name === "dawmain_probe_sources") found = handler;
      },
    } as never, { zotero: false });
    return found!;
  }

  it("answers in text when a tool outlives the budget (counted from the handler's start outside a request)", async () => {
    vi.useFakeTimers();
    // An upstream that never answers, whatever the signal says.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    let settled: Record<string, unknown> | undefined;
    void probeHandler()({ sources: ["ns"], include_raw: false, discover: false }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled?.isError).toBe(true);
    const text = (settled?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("dawmain_probe_sources: no answer within the 54 s");
    expect(text).toContain("Narrow the call");
    expect(settled).not.toHaveProperty("structuredContent");
  });

  it("counts from the request's arrival when the route put it on record", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const handler = probeHandler();
    let settled: Record<string, unknown> | undefined;
    await runWithCallClock(async () => {
      // e.g. a slow auth round trip before the tool starts
      await vi.advanceTimersByTimeAsync(10_000);
      void handler({ sources: ["ns"], include_raw: false, discover: false }).then((r) => (settled = r));
    });
    await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS - 10_000);
    expect(settled?.isError).toBe(true);
  });

  it("leaves a timely answer untouched and its timer cleared", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('"rok": 2020', { status: 200 })));
    const result = await probeHandler()({ sources: ["justice"], include_raw: false, discover: false });
    expect(result.isError).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/^1\/1 sources healthy/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the request's clock reaches the tool through mcp-handler (AsyncLocalStorage context)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-01T10:00:00Z");
    vi.setSystemTime(start);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('"rok"')), 30))),
    );
    const handler = createMcpHandler((server) => registerAllTools(server, { zotero: false }), OPTIONS);
    const call = () => rpc(9, "tools/call", { name: "dawmain_probe_sources", arguments: { sources: ["justice"] } });

    // Without a clock on record the budget starts with the handler: a normal answer.
    expect(await body(handler, call())).toContain("1/1 sources healthy");

    // The request "arrived" 60 s ago: the tool must answer over budget at once.
    const late = await runWithCallClock(() => {
      vi.setSystemTime(start.getTime() + 60_000);
      return body(handler, call());
    });
    expect(late).toContain("no answer within the 54 s");
    expect(late).toContain('"isError":true');
  });
});
