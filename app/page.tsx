import { Suspense } from "react";
import { headers } from "next/headers";
import { databaseStatuses, formatTime } from "@/src/mcp/status";
import { Endpoint } from "./_endpoint";

export const dynamic = "force-dynamic";


const sourceRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.35rem 0",
  borderBottom: "1px solid #f3f4f6",
  fontSize: "0.95rem",
};

/**
 * The database list with its status lights. Its own async component so the
 * page shell streams immediately - a slow upstream check can then only delay
 * the lights, never the text around them.
 */
async function SourceList() {
  const statuses = await databaseStatuses();
  return (
    <ul style={{ padding: 0, margin: "0.5rem 0 0", listStyle: "none", textAlign: "left" }}>
      {statuses.map((status) => (
        <li key={status.label} style={sourceRow}>
          <span
            aria-hidden="true"
            style={{
              width: "0.6rem",
              height: "0.6rem",
              borderRadius: "50%",
              flexShrink: 0,
              background: status.ok === null ? "#d1d5db" : status.ok ? "#16a34a" : "#dc2626",
            }}
          />
          <a href={status.href} style={{ color: "#111827", textDecoration: "none" }}>
            {status.label}
          </a>
          <span style={{ marginLeft: "auto", color: "#9ca3af", fontSize: "0.8rem" }}>
            {status.ok === null
              ? "neověřeno"
              : `${status.ok ? "dostupné" : (status.detail ?? "nedostupné")} · ${formatTime(status.at!)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What stands in while the lights are still being checked. */
function SourceListFallback() {
  const names = [
    "Nejvyšší soud",
    "Nejvyšší správní soud",
    "Ústavní soud (NALUS)",
    "obecné soudy",
    "Soudní dvůr EU (InfoCuria)",
    "e-Sbírka",
    "EUR-Lex (Cellar)",
  ];
  return (
    <ul style={{ padding: 0, margin: "0.5rem 0 0", listStyle: "none", textAlign: "left" }}>
      {names.map((name) => (
        <li key={name} style={sourceRow}>
          <span
            aria-hidden="true"
            style={{
              width: "0.6rem",
              height: "0.6rem",
              borderRadius: "50%",
              flexShrink: 0,
              background: "#e5e7eb",
            }}
          />
          <span>{name}</span>
          <span style={{ marginLeft: "auto", color: "#d1d5db", fontSize: "0.8rem" }}>zjišťuji…</span>
        </li>
      ))}
    </ul>
  );
}

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
        Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle
        mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz je v zásadě
        zdarma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Jak to funguje?</h2>
      <p>
        Server nemá vlastní databázi - funguje jako nachytřený Google: vyhledává živě přímo v
        oficiálních databázích. Právní předpisy bere přes API e-Sbírky, unijní legislativu z
        Cellaru (strojové rozhraní Úřadu pro publikace EU, které stojí za EUR-Lexem). Konkrétně je
        napojený na tyto zdroje:
      </p>
      <Suspense fallback={<SourceListFallback />}>
        <SourceList />
      </Suspense>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Jak se připojit?</h2>
      <Endpoint endpoint={endpoint} />
      <ol style={{ paddingLeft: "1.4rem", lineHeight: 1.9 }}>
        <li>
          V aplikaci claude.ai otevřete <strong>Nastavení → Konektory</strong>.
        </li>
        <li>
          Zvolte <strong>Přidat vlastní konektor</strong> a vložte adresu výše.
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
