#!/usr/bin/env node
/**
 * End-to-end smoke test against a running MCP endpoint.
 *
 *   npm run dev                                    # in one terminal
 *   npm run smoke                                  # in another
 *   MCP_URL=https://<deployment>/api/mcp npm run smoke
 *
 * Speaks Streamable HTTP on the wire (no client SDK) so a failure points at
 * the server rather than at the test harness, and exercises both protocol
 * generations the handler serves:
 *
 *   2026-07-28  stateless, no handshake; every request carries a `_meta`
 *               envelope plus Mcp-Method / Mcp-Name headers that must agree
 *               with the body.
 *   2025-06-18  the legacy `initialize` handshake, served statelessly.
 */

const url = process.env.MCP_URL || "http://localhost:3000/api/mcp";
const token = process.env.MCP_BEARER_TOKEN?.trim();

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "dawmain-smoke", version: "0.1.0" };

const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
};

/** Streamable HTTP may answer with plain JSON or an SSE frame — accept both. */
async function parseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) return [];

  if (contentType.includes("text/event-stream")) {
    const messages = [];
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Keep-alive or comment frame — ignore.
      }
    }
    return messages;
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

class McpClient {
  #nextId = 1;

  constructor(era) {
    this.era = era; // "modern" | "legacy"
    this.protocolVersion = era === "modern" ? MODERN_VERSION : undefined;
  }

  async request(method, params = {}) {
    const id = this.#nextId++;
    const body = { jsonrpc: "2.0", id, method, params: { ...params } };

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;

    if (this.era === "modern") {
      // The 2026 era mirrors routing fields into headers and requires them to
      // agree with the body, so a proxy can route without parsing JSON.
      headers["mcp-method"] = method;
      if (typeof params.name === "string") headers["mcp-name"] = params.name;
      body.params._meta = {
        [META.protocolVersion]: MODERN_VERSION,
        [META.clientInfo]: CLIENT_INFO,
        [META.clientCapabilities]: {},
        ...params._meta,
      };
    }

    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`${method} → HTTP ${response.status} ${response.statusText}\n${await response.text()}`);
    }

    const messages = await parseBody(response);
    const message = messages.find((m) => m.id === id) ?? messages[0];
    if (!message) throw new Error(`${method} → empty response body`);
    if (message.error) {
      throw new Error(`${method} → JSON-RPC error ${message.error.code}: ${message.error.message}`);
    }
    return message.result;
  }
}

function ok(label, detail) {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function checkTools(client) {
  const { tools } = await client.request("tools/list");
  if (!tools?.length) throw new Error("tools/list returned no tools");
  ok("tools/list", tools.map((t) => t.name).join(", "));

  const ping = await client.request("tools/call", { name: "dawmain_ping", arguments: {} });
  const info = ping.structuredContent ?? {};
  if (info.ok !== true) throw new Error(`dawmain_ping did not report ok: ${JSON.stringify(ping)}`);
  ok("dawmain_ping", `env=${info.environment} region=${info.region ?? "-"} commit=${info.commit ?? "-"}`);

  const echo = await client.request("tools/call", {
    name: "dawmain_echo",
    arguments: { text: "ahoj", transform: "upper" },
  });
  const echoed = echo.structuredContent?.text ?? echo.content?.[0]?.text;
  if (echoed !== "AHOJ") {
    throw new Error(`dawmain_echo returned ${JSON.stringify(echoed)}, expected "AHOJ"`);
  }
  ok("dawmain_echo", `"ahoj" → "${echoed}"`);
}

async function main() {
  console.log(`\nSmoke-testing ${url}${token ? " (with bearer token)" : ""}`);

  console.log(`\n${MODERN_VERSION} (stateless, no handshake)`);
  const modern = new McpClient("modern");
  const discovery = await modern.request("server/discover");
  ok("server/discover", `supports ${discovery.supportedVersions?.join(", ")}`);
  await checkTools(modern);

  console.log(`\n${LEGACY_VERSION} (legacy initialize handshake)`);
  const legacy = new McpClient("legacy");
  const init = await legacy.request("initialize", {
    protocolVersion: LEGACY_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  legacy.protocolVersion = init.protocolVersion;
  ok("initialize", `${init.serverInfo?.name} ${init.serverInfo?.version} (protocol ${init.protocolVersion})`);
  await checkTools(legacy);

  console.log("\nAll checks passed.\n");
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(1);
});
