import { headers } from "next/headers";
import { SERVER_NAME, SERVER_VERSION } from "@/src/mcp/config";

export const dynamic = "force-dynamic";

const code: React.CSSProperties = {
  display: "block",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  padding: "0.75rem 1rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "0.875rem",
};

export default async function Home() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const proto =
    headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <>
      <header style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark, no optimization wanted */}
        <img
          src="/logo.svg"
          alt=""
          width={52}
          height={52}
          style={{ display: "block", borderRadius: "0.75rem" }}
        />
        <div>
          <h1 style={{ fontSize: "1.75rem", margin: 0, letterSpacing: "-0.01em" }}>{SERVER_NAME}</h1>
          <p style={{ color: "#6b7280", margin: 0, fontSize: "0.95rem" }}>
            Version {SERVER_VERSION} · Model Context Protocol over Streamable HTTP
          </p>
        </div>
      </header>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Endpoint</h2>
      <code style={code}>{endpoint}</code>
      <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
        This URL only answers MCP JSON-RPC requests — opening it in a browser returns an error,
        which is expected.
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Connect from Claude Code</h2>
      <code style={code}>{`claude mcp add --transport http dawmain ${endpoint}`}</code>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Connect from a JSON config</h2>
      <code style={code}>
        {JSON.stringify({ mcpServers: { dawmain: { type: "http", url: endpoint } } }, null, 2)}
      </code>

      <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: "2rem" }}>
        Legal-research MCP server: e-Sbírka, NSS, NS, ÚS (NALUS), obecné soudy, CJEU, EUR-Lex a
        EUIPO — live queries, no local data. Call <code>dawmain_ping</code> to confirm which
        deployment is answering and <code>dawmain_probe_sources</code> to check the upstream
        databases.
      </p>
    </>
  );
}
