import { Suspense } from "react";
import { headers } from "next/headers";
import { DATABASES, databaseStatuses, formatTime } from "@/src/mcp/status";
import { Guide } from "./_guide";
import { Mail } from "./_legal";

export const dynamic = "force-dynamic";

/**
 * The database list with its status lights. Its own async component so the
 * page shell streams immediately - a slow upstream check can then only delay
 * the lights, never the text around them.
 */
async function SourceList() {
  const statuses = await databaseStatuses();
  return (
    <ul className="sources">
      {statuses.map((status) => (
        <li key={status.label}>
          <span aria-hidden="true" className="light" data-ok={status.ok ?? undefined} />
          <a href={status.href}>{status.label}</a>
          <span className="when">
            {status.ok === null
              ? "neověřeno"
              : `${status.ok ? "dostupné" : (status.detail ?? "nedostupné")} · ${formatTime(status.at!)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What stands in while the lights are still being checked. The names come
 * from the same list the real rows do - a hand-kept copy would go on
 * promising a database the server no longer queries. */
function SourceListFallback() {
  return (
    <ul className="sources">
      {DATABASES.map(({ label: name }) => (
        <li key={name}>
          <span aria-hidden="true" className="light" data-ok="pending" />
          <span>{name}</span>
          <span className="when">zjišťuji…</span>
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
      <header className="brand">
        <img src="/logo.svg" alt="" width={52} height={52} />
        <div>
          <h1>Dawmain</h1>
          <p className="muted">David Závada</p>
        </div>
      </header>

      <p>
        Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle
        mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz je v zásadě
        zdarma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)
      </p>

      <h2>Jak to funguje?</h2>
      <p>
        Server nemá vlastní databázi - funguje jako nachytřený Google: vyhledává živě přímo v
        oficiálních databázích. Konkrétně je napojený na tyto zdroje:
      </p>
      <Suspense fallback={<SourceListFallback />}>
        <SourceList />
      </Suspense>

      <h2>Jak se připojit?</h2>
      <p>
        Nastavení zabere asi pět minut a dělá se jen jednou. Přidáte <strong>konektor</strong>, který
        asistentovi zpřístupní databáze, a <strong>skill</strong>, který ho naučí s nimi pracovat - jak
        se ptát, co projít a jak výsledek citovat. Vyberte, kterého asistenta používáte:
      </p>
      <Guide endpoint={endpoint} />
      <p>
        Kdyby cokoli nešlo, napište mi na <Mail />.
      </p>
    </>
  );
}
