import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCall, rewriteLegacyBody, withCurrentToolNames } from "@/src/mcp/legacy-tools";
import { withMcpAuth } from "mcp-handler";
import { mcpHandler as bareHandler } from "@/src/mcp/server";

/** As app/api/mcp/route.ts composes it: the rewrite first, then the handler. */
const mcpHandler = async (request: Request): Promise<Response> => bareHandler(await withCurrentToolNames(request));

/**
 * A client keeps the tools/list it read when it connected. After four read
 * tools became caselaw_get_decision, such a client still calls the old names
 * (measured: "Tool ns_get_decision not found" from a session an hour old).
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("calls by a retired tool name", () => {
  it("become the current call: the court as source, the old id parameter as id, the rest untouched", () => {
    expect(currentCall("ns_get_decision", { unid: "AB", find: "nájem", page: 2 })).toEqual({
      name: "caselaw_get_decision",
      arguments: { source: "ns", id: "AB", find: "nájem", page: 2 },
    });
    expect(currentCall("nss_get_decision", { document_id: "652443", paragraphs: "24-31" })).toEqual({
      name: "caselaw_get_decision",
      arguments: { source: "nss", id: "652443", paragraphs: "24-31" },
    });
    expect(currentCall("us_get_decision", { sz: "Pl-24-10_1" })?.arguments).toEqual({ source: "us", id: "Pl-24-10_1" });
    expect(currentCall("us_get_decision", { ecli: "ECLI:CZ:US:2026:1.US.1169.26.1" })?.arguments).toEqual({ source: "us", id: "ECLI:CZ:US:2026:1.US.1169.26.1" });
    expect(currentCall("justice_get_decision", { uuid: "u-1", outline: true })?.arguments).toEqual({ source: "justice", id: "u-1", outline: true });
    // No id at all: the current tool's own validation says what is missing.
    expect(currentCall("ns_get_decision", undefined)?.arguments).toEqual({ source: "ns" });
    expect(currentCall("caselaw_get_decision", { source: "ns", id: "AB" })).toBeNull();
    expect(currentCall("ns_search", { query: "nájem" })).toBeNull();
  });

  it("only tools/call is rewritten — one message or a batch; anything else passes as it is", () => {
    const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { progressToken: 7 } } });
    const one = JSON.parse(rewriteLegacyBody(JSON.stringify(call("ns_get_decision", { unid: "AB" }))) as string);
    expect(one).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "caselaw_get_decision", arguments: { source: "ns", id: "AB" }, _meta: { progressToken: 7 } } });
    const batch = JSON.parse(rewriteLegacyBody(JSON.stringify([call("ns_search", { query: "ns_get_decision" }, 1), call("us_get_decision", { sz: "x" }, 2)])) as string);
    expect(batch[0].params.name).toBe("ns_search");
    expect(batch[1].params).toMatchObject({ name: "caselaw_get_decision", arguments: { source: "us", id: "x" } });
    // The old name as a word in a query, in a current call or in broken JSON: nothing to rewrite.
    expect(rewriteLegacyBody(JSON.stringify(call("ns_search", { query: "ns_get_decision" })))).toBeNull();
    expect(rewriteLegacyBody(JSON.stringify(call("caselaw_get_decision", { source: "ns", id: "AB" })))).toBeNull();
    expect(rewriteLegacyBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toBeNull();
    expect(rewriteLegacyBody('{"method":"tools/call","params":{"name":"ns_get_decision"')).toBeNull();
  });

  it("the request is replaced only when it changed, and keeps its headers", async () => {
    const post = (body: string) => new Request("https://dawmain.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body });
    const untouched = post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(await withCurrentToolNames(untouched)).toBe(untouched);
    const get = new Request("https://dawmain.test/api/mcp");
    expect(await withCurrentToolNames(get)).toBe(get);
    const old = post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nss_get_decision", arguments: { document_id: "1" } } }));
    const current = await withCurrentToolNames(old);
    expect(current).not.toBe(old);
    expect(current.headers.get("authorization")).toBe("Bearer t");
    expect((await current.json()).params).toEqual({ name: "caselaw_get_decision", arguments: { source: "nss", id: "1" } });
    expect(current.headers.has("mcp-name")).toBe(false);
  });

  it("the Mcp-Name header of the 2026-07-28 transport follows the body — the SDK refuses a request where they disagree", async () => {
    // The per-request envelope the 2026-07-28 revision requires.
    const META = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const rpc = (name: string, args: unknown) =>
      new Request("https://dawmain.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": name,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } }),
      });
    expect((await withCurrentToolNames(rpc("ns_get_decision", { unid: "AB" }))).headers.get("mcp-name")).toBe("caselaw_get_decision");
    vi.stubEnv("MIRROR_API_URL", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unused")));
    const answer = await (await mcpHandler(rpc("ns_get_decision", { unid: "not-a-unid" }))).text();
    expect(answer).not.toContain("disagree");
    expect(answer).toContain("is not an NS id");
  });

  it("end to end: the server answers an old name as caselaw_get_decision does, and lists only the new one", async () => {
    vi.stubEnv("MIRROR_API_URL", "");
    const fetchSpy = vi.fn(async () => new Response("unused"));
    vi.stubGlobal("fetch", fetchSpy);
    const rpc = (method: string, params: unknown) =>
      new Request("https://dawmain.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    // An id of the wrong shape is refused by caselaw_get_decision itself, before any request to the court.
    const answer = await (await mcpHandler(rpc("tools/call", { name: "ns_get_decision", arguments: { unid: "not-a-unid" } }))).text();
    expect(answer).not.toContain("not found");
    expect(answer).toContain("is not an NS id");
    expect(fetchSpy).not.toHaveBeenCalled();
    const list = await (await mcpHandler(rpc("tools/list", {}))).text();
    expect(list).toContain('"caselaw_get_decision"');
    expect(list).not.toContain('"ns_get_decision"');
  });

  it("the caller's identity survives: the rewrite runs before authentication, so the handler sees who called", async () => {
    // withMcpAuth puts the verified caller on the request object it was given; a request rebuilt
    // AFTER that would reach the tools as nobody (no daily limit, no own sources).
    const seen: unknown[] = [];
    const inner = async (request: Request): Promise<Response> => {
      seen.push((request as Request & { auth?: { clientId?: string } }).auth?.clientId);
      return new Response(await request.text());
    };
    const authed = withMcpAuth(inner, async () => ({ token: "t", clientId: "user_1", scopes: [] }), { required: true });
    const composed = async (request: Request): Promise<Response> => authed(await withCurrentToolNames(request));
    const post = (name: string, args: unknown) =>
      new Request("https://dawmain.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
    const body = await (await composed(post("ns_get_decision", { unid: "AB" }))).json();
    expect(body.params).toEqual({ name: "caselaw_get_decision", arguments: { source: "ns", id: "AB" } });
    await composed(post("caselaw_get_decision", { source: "ns", id: "AB" }));
    expect(seen).toEqual(["user_1", "user_1"]);
  });
});
