import { describe, expect, it } from "vitest";
import { createMcpHandler } from "mcp-handler";
import { DEFAULT_ORIGIN, SERVER_NAME, SERVER_VERSION, serverBranding } from "@/src/mcp/config";

/** serverInfo carries title, icons and websiteUrl through mcp-handler to the client. */
describe("serverInfo branding", () => {
  it("initialize returns the icon, title and website", async () => {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION, ...serverBranding(DEFAULT_ORIGIN) };
    const handler = createMcpHandler(() => {}, { serverInfo, instructions: "x", verboseLogs: false });
    const res = await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }),
    );
    const text = await res.text();
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const info = json.result.serverInfo;
    expect(info.title).toBe("Dawmain");
    expect(info.websiteUrl).toBe("https://dawmain.davidzavada.cz");
    expect(info.icons).toEqual([
      { src: "https://dawmain.davidzavada.cz/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
      { src: "https://dawmain.davidzavada.cz/apple-icon.png", mimeType: "image/png", sizes: ["180x180"] },
    ]);
  });
});

describe("annotations.title", () => {
  it("every tool in tools/list carries its title in annotations too", async () => {
    const { registerAllTools } = await import("@/src/mcp/tools");
    const handler = createMcpHandler((server) => registerAllTools(server, { zotero: true }), {
      serverInfo: { name: "t", version: "0" },
      instructions: "x",
      verboseLogs: false,
    });
    const res = await handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const text = await res.text();
    const tools = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).result.tools as Array<{
      name: string;
      title?: string;
      annotations?: { title?: string };
    }>;
    expect(tools.length).toBeGreaterThan(30);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
    }
  });
});
