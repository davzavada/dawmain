import { headers } from "next/headers";
import { Guide } from "./_guide";
import { Mail } from "./_legal";
import { SourceList } from "./_source-status";
import { OwnSourcesGroup, ZoteroGroup } from "./_zdroje/own-sources";
import { zoteroConfigured } from "@/src/zotero/config";

export const dynamic = "force-dynamic";

/** The author's other project, linked from the intro. */
const OWL_URL = "https://owl.davidzavada.cz/";

export default async function Home() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const proto =
    headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <div className="home">
      <section id="uvod" className="intro">
        <h1>MCP server pro právní systémy</h1>
        <p className="lead">
          Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle
          mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz je v
          zásadě zdarma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)
        </p>
        <p className="lead">
          V oficiálních databázích server hledá živě – funguje jako nachytřený Google a nic si z
          nich nekopíruje. Kdo má režim Pro, může si k nim přidat vlastní dokumenty.
        </p>
        <a href={OWL_URL} className="project-card">
          <img src="/owl.svg" alt="" width={36} height={36} />
          <span className="project-text">
            <span className="project-name">Owl</span>
            <span className="project-desc">
              Pokud vás zajímá monitoring recentní rozhodovací praxe a doktrinálního vývoje,
              podívejte se na můj další projekt.
            </span>
          </span>
          <span className="project-arrow" aria-hidden="true">
            →
          </span>
        </a>
      </section>

      <section id="zdroje" className="sources">
        <h2>Zdroje</h2>
        {/* Client island: counts from GET /api/files/summary; the page stays server-rendered. */}
        <OwnSourcesGroup />
        {/* Zotero only where the deployment can connect it (the OAuth app and CREDENTIALS_SECRET). */}
        {zoteroConfigured() ? <ZoteroGroup /> : null}
        {/* Client island: the badges come from GET /api/status after the page is up. */}
        <SourceList />
      </section>

      <section id="pripojeni" className="connect">
        <h2>Jak se připojit</h2>
        <Guide endpoint={endpoint} />
        <p className="muted small">
          Kdyby cokoli nešlo, napište mi na <Mail />.
        </p>
      </section>
    </div>
  );
}
