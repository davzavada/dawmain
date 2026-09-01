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

const EXPECTED_TOOLS = [
  "dawmain_ping",
  "dawmain_probe_sources",
  "esbirka_search",
  "esbirka_get_act",
  "esbirka_get_text",
  "ns_search",
  "ns_get_decision",
  "nalus_search",
  "nalus_get_decision",
  "nss_search",
  "nss_get_decision",
  "cz_caselaw_search",
  "justice_list_decisions",
  "justice_get_decision",
  "curia_search",
  "curia_get_document",
  "eurlex_search",
  "eurlex_get_document",
  "eurlex_legislative_history",
  // Deliberately unregistered (see src/mcp/tools/index.ts): the EUIPO tools
  // (their legal notices opt out of automated access) and the ÚPV tools (the
  // portal drops datacenter connections).
];

async function checkTools(client) {
  const { tools } = await client.request("tools/list");
  if (!tools?.length) throw new Error("tools/list returned no tools");
  const names = tools.map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  const missing = expected.filter((name) => !names.includes(name));
  const surplus = names.filter((name) => !expected.includes(name));
  if (missing.length || surplus.length) {
    throw new Error(
      `tools/list mismatch — missing: [${missing.join(", ")}], unexpected: [${surplus.join(", ")}]`,
    );
  }
  ok("tools/list", `${names.length} tools, roster matches`);

  const ping = await client.request("tools/call", { name: "dawmain_ping", arguments: {} });
  const info = ping.structuredContent ?? {};
  if (info.ok !== true) throw new Error(`dawmain_ping did not report ok: ${JSON.stringify(ping)}`);
  ok("dawmain_ping", `env=${info.environment} region=${info.region ?? "-"} commit=${info.commit ?? "-"}`);

  // Input validation must reject bad arguments without touching any upstream.
  let validationRejected = false;
  try {
    const bad = await client.request("tools/call", {
      name: "esbirka_search",
      arguments: { query: "x", limit: 9999 },
    });
    validationRejected = bad.isError === true;
  } catch {
    validationRejected = true; // JSON-RPC invalid-params is equally fine
  }
  if (!validationRejected) throw new Error("esbirka_search accepted limit=9999 — schema validation is off");
  ok("input validation", "esbirka_search rejected limit=9999");
}

/** SMOKE_LIVE=1: exercise real upstreams — meaningful only against a deployment. */
async function checkLive(client) {
  const probe = await client.request("tools/call", {
    name: "dawmain_probe_sources",
    arguments: {},
  });
  const probes = probe.structuredContent?.probes ?? [];
  const healthy = probes.filter((p) => p.ok).length;
  for (const p of probes) {
    ok(`probe ${p.id}`, `${p.ok ? "OK" : "FAIL"} http=${p.http_status ?? "ERR"} ${p.latency_ms}ms marker=${p.marker_found}`);
  }
  if (!healthy) throw new Error("no upstream source is reachable from this deployment");

  const act = await client.request("tools/call", {
    name: "esbirka_get_act",
    arguments: { year: 2012, number: 89 },
  });
  if (act.isError) throw new Error(`esbirka_get_act 89/2012 failed: ${act.content?.[0]?.text}`);
  ok("esbirka_get_act", act.structuredContent?.nazev ?? "(no name)");

  const nalus = await client.request("tools/call", {
    name: "nalus_get_decision",
    arguments: { sz: "1-709-05" },
  });
  if (nalus.isError) throw new Error(`nalus_get_decision failed: ${nalus.content?.[0]?.text}`);
  ok("nalus_get_decision", `sz=1-709-05, ${nalus.structuredContent?.total_pages} text pages`);

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const ns = await client.request("tools/call", {
    name: "ns_search",
    arguments: { date_from: weekAgo, limit: 5 },
  });
  if (ns.isError) throw new Error(`ns_search failed: ${ns.content?.[0]?.text}`);
  ok("ns_search", `last 7 days → ${ns.structuredContent?.count} hits of ${ns.structuredContent?.total ?? "?"}`);
}

/**
 * OAuth discovery (RFC 9728). Passes in both states: 404 = OAuth not
 * configured (the Clerk keys unset), 200 = metadata must name the /api/mcp
 * resource and at least one authorization server.
 */
async function checkOAuthMetadata() {
  const origin = new URL(url).origin;
  const response = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  if (response.status === 404) {
    ok("oauth discovery", "not configured (Clerk keys unset)");
    return;
  }
  if (!response.ok) {
    throw new Error(`oauth-protected-resource → HTTP ${response.status}`);
  }
  const metadata = await response.json();
  if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0) {
    throw new Error(`oauth-protected-resource lists no authorization_servers: ${JSON.stringify(metadata)}`);
  }
  if (typeof metadata.resource !== "string" || !metadata.resource.endsWith("/api/mcp")) {
    throw new Error(`oauth-protected-resource resource is not the MCP endpoint: ${JSON.stringify(metadata)}`);
  }
  ok("oauth discovery", `${metadata.resource} → ${metadata.authorization_servers.join(", ")}`);
}

async function main() {
  console.log(`\nSmoke-testing ${url}${token ? " (with bearer token)" : ""}`);

  await checkOAuthMetadata();

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

  if (process.env.SMOKE_LIVE === "1") {
    console.log("\nLive upstream checks (SMOKE_LIVE=1)");
    await checkLive(modern);
  }

  console.log("\nAll checks passed.\n");
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(1);
});
