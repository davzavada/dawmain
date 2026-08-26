import { headers } from "next/headers";
import { SERVER_NAME } from "@/src/mcp/config";

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
            Model Context Protocol přes Streamable HTTP
          </p>
        </div>
      </header>

      <p style={{ marginTop: "1.75rem" }}>
        MCP server pro české a unijní právní rešerše. Nemá vlastní databázi — funguje jako
        nachytřený Google: vyhledává živě přímo v oficiálních databázích. Právní předpisy bere přes
        API e-Sbírky, unijní legislativu z Cellaru (strojové rozhraní Úřadu pro publikace EU, které
        stojí za EUR-Lexem). Konkrétně je napojený na judikaturu:
      </p>
      <ul style={{ marginTop: "0.25rem", paddingLeft: "1.4rem", lineHeight: 1.9 }}>
        <li>Nejvyššího soudu</li>
        <li>Nejvyššího správního soudu</li>
        <li>Ústavního soudu (NALUS)</li>
        <li>obecných soudů (rozhodnuti.justice.cz)</li>
        <li>Soudního dvora EU (InfoCuria)</li>
        <li>EUIPO (rozhodovací praxe a metodika)</li>
      </ul>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Endpoint</h2>
      <code style={code}>{endpoint}</code>
      <p>
        V aplikaci claude.ai: <strong>Nastavení → Konektory → Přidat vlastní konektor</strong> a
        vložit adresu výše. V Claude Code:
      </p>
      <code style={code}>{`claude mcp add --transport http dawmain ${endpoint}`}</code>
    </>
  );
}
