import { headers } from "next/headers";

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
        <img
          src="/logo.svg"
          alt=""
          width={52}
          height={52}
          style={{ display: "block", borderRadius: "0.75rem" }}
        />
        <div>
          <h1 style={{ fontSize: "1.75rem", margin: 0, letterSpacing: "-0.01em" }}>Dawmain</h1>
          <p style={{ color: "#6b7280", margin: 0, fontSize: "0.95rem" }}>David Závada</p>
        </div>
      </header>

      <p style={{ marginTop: "1.75rem" }}>
        Přístup k judikatuře a právním předpisům s AI by podle mě neměl vést jen přes komerční
        nástroje. Data jsou dnes dobře dostupná a provoz je v zásadě zdarma. Proto jsem vytvořil
        nekomerční alternativu. Budu rád, když ji vyzkoušíte :)
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Jak to funguje?</h2>
      <p>
        Server nemá vlastní databázi - funguje jako nachytřený Google: vyhledává živě přímo v
        oficiálních databázích. Právní předpisy bere přes API e-Sbírky, unijní legislativu z
        Cellaru (strojové rozhraní Úřadu pro publikace EU, které stojí za EUR-Lexem). Konkrétně je
        napojený na judikaturu:
      </p>
      <ul style={{ marginTop: "0.25rem", paddingLeft: "1.4rem", lineHeight: 1.9 }}>
        <li>Nejvyššího soudu</li>
        <li>Nejvyššího správního soudu</li>
        <li>Ústavního soudu (NALUS)</li>
        <li>obecných soudů</li>
        <li>Soudního dvora EU (InfoCuria)</li>
      </ul>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Jak se připojit?</h2>
      <code style={code}>{endpoint}</code>
      <ol style={{ paddingLeft: "1.4rem", lineHeight: 1.9 }}>
        <li>
          V aplikaci claude.ai otevřete <strong>Nastavení → Konektory</strong>.
        </li>
        <li>
          Zvolte <strong>Přidat vlastní konektor</strong> a vložte adresu výše. Pole pro
          přístupový kód nechte prázdné.
        </li>
        <li>
          Otevře se přihlašovací okno - stačí se zaregistrovat e-mailem (nebo přihlásit, pokud už
          účet máte).
        </li>
        <li>V nové konverzaci pak stačí napsat, co potřebujete najít.</li>
      </ol>
      <p>
        Kdyby vás přihlášení nepustilo, ozvěte se mi.
      </p>
    </>
  );
}
