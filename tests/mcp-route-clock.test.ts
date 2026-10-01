import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * app/api/mcp/route.ts puts the request's arrival on record before auth
 * (runWithCallClock around withMcpAuth), and that clock is what the tools'
 * budget counts from. Proven on the real route module: with Date.now()
 * jumping 60 s after the route's first read, a tool answers over budget at
 * once — which it can only do if the route's clock reached the handler
 * through withMcpAuth and mcp-handler.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const NATIVE = "2026-07-28";

/** A tools/call in either client generation: 2025-era stateless Streamable
 * HTTP, or the native revision with its Mcp-Method header and envelope. */
function call(version: string): Request {
  const native = version === NATIVE;
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      ...(native ? { "mcp-method": "tools/call", "mcp-name": "dawmain_probe_sources" } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "dawmain_probe_sources",
        arguments: { sources: ["justice"] },
        ...(native
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": NATIVE,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : {}),
      },
    }),
  });
}

async function loadRoute() {
  // Anonymous local mode: no Vercel, no access code, no Clerk.
  for (const name of ["VERCEL", "MCP_BEARER_TOKEN", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]) {
    vi.stubEnv(name, "");
  }
  return import("@/app/api/mcp/route");
}

describe.each(["2025-06-18", NATIVE])("the route's call clock (%s)", (version) => {
  it("answers normally while the budget lasts", async () => {
    const { POST } = await loadRoute();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('"rok": 2024', { status: 200 })));
    const text = await (await POST(call(version))).text();
    expect(text).toContain("1/1 sources healthy");
  });

  it("counts from the route, through withMcpAuth and mcp-handler", async () => {
    const { POST } = await loadRoute();
    const start = Date.now();
    let firstReader: string | undefined;
    // The request's first Date.now() read must be the route's
    // runWithCallClock (asserted below); every later read is 60 s on.
    vi.spyOn(Date, "now").mockImplementation(() => {
      if (firstReader === undefined) {
        firstReader = new Error().stack ?? "";
        return start;
      }
      return start + 60_000;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('"rok"')), 50))),
    );
    const text = await (await POST(call(version))).text();
    expect(text).toContain("dawmain_probe_sources: no answer within the 54 s");
    expect(text).toContain('"isError":true');
    expect(firstReader).toContain("runWithCallClock");
  });
});
