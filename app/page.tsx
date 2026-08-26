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
          <p style={{ color: "#6b7280", margin: 0, fontSize: "0.95rem" }}>David Závada</p>
        </div>
      </header>

      <p style={{ marginTop: "1.75rem" }}>
        Přístup k judikatuře a právním předpisům s AI by podle mě neměl být možný jen přes komerční
        nástroje, ale v době, kdy jsou ta data dobře přístupná a provoz je v zásadě zdarma, mi
        přišlo, že by měla existovat nekomerční alternativa. Budu rád, pokud nástroj vyzkoušíte a
        dáte mi zpětnou vazbu :)
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Jak to funguje?</h2>
      <p>
        Server nemá vlastní databázi - funguje jako nachytřený Google: vyhledává živě přímo v
        oficiálních databázích. Právní předpisy bere přes API e-Sbírky, unijní legislativu z
        Cellaru (strojové rozhraní Úřadu pro publikace EU, které stojí za EUR-Lexem). Konkrétně je
        napojený na judikaturu:
      </p>
      <ul style={{ marginTop: "0.25rem", paddingLeft: "1.4rem", lineHeight: 1.9 }}>
        <li>
          Nejvyššího soudu - dostupné{" "}
          <a href="https://rozhodnuti.nsoud.cz" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
        <li>
          Nejvyššího správního soudu - dostupné{" "}
          <a href="https://vyhledavac.nssoud.cz" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
        <li>
          Ústavního soudu (NALUS) - dostupné{" "}
          <a href="https://nalus.usoud.cz" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
        <li>
          obecných soudů - dostupné{" "}
          <a href="https://rozhodnuti.justice.cz" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
        <li>
          Soudního dvora EU (InfoCuria) - dostupné{" "}
          <a href="https://infocuria.curia.europa.eu" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
        <li>
          EUIPO - rozhodovací praxe dostupná{" "}
          <a href="https://euipo.europa.eu/eSearchCLW/" target="_blank" rel="noreferrer">
            zde
          </a>
          , metodika{" "}
          <a href="https://guidelines.euipo.europa.eu" target="_blank" rel="noreferrer">
            zde
          </a>
        </li>
      </ul>
      <p style={{ fontSize: "0.9rem", color: "#6b7280" }}>
        Právní předpisy:{" "}
        <a href="https://www.e-sbirka.cz" target="_blank" rel="noreferrer">
          e-Sbírka
        </a>
        , unijní legislativa a judikatura:{" "}
        <a href="https://eur-lex.europa.eu" target="_blank" rel="noreferrer">
          EUR-Lex
        </a>
        .
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Endpoint</h2>
      <code style={code}>{endpoint}</code>
      <p>
        V aplikaci claude.ai: <strong>Nastavení → Konektory → Přidat vlastní konektor</strong> a
        vložit adresu výše.
      </p>
      <p>
        Při autentizaci je potřeba vložit vlastní přístupový kód - pokud byste chtěli nástroj
        vyzkoušet, napište mi na <a href="mailto:davzavada@gmail.com">davzavada@gmail.com</a>.
      </p>
    </>
  );
}
