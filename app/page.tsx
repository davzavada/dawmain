import { Guide } from "./_guide";
import { Mail } from "./_legal";
import { SourceList } from "./_source-status";
import { OwnSourcesGroup } from "./_zdroje/own-sources";
import { zoteroConfigured } from "@/src/zotero/config";

/** The author's other project, linked from the intro. */
const OWL_URL = "https://owl.davidzavada.cz/";

/**
 * The MCP address the guide offers, fixed at build (the page is static): the
 * production domain Vercel names. The guide swaps in the address the browser
 * is actually on (a preview, localhost) — on production it is the same.
 */
function endpoint(): string {
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const origin = production && /^[a-z0-9.-]+$/i.test(production) ? `https://${production}` : "https://dawmain.davidzavada.cz";
  return `${origin}/api/mcp`;
}

export default function Home() {
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
          nich nekopíruje. Kdo má režim Pro, může připojit svou knihovnu Zotero a nahrát vlastní
          soubory.
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
        {/*
          Client island: Zotero (only where the deployment can connect it — the OAuth app and
          CREDENTIALS_SECRET) and Vlastní soubory, counts from GET /api/files/summary.
        */}
        <OwnSourcesGroup zotero={zoteroConfigured()} />
        {/* Client island: the badges come from GET /api/status (static, checked daily) after the page is up. */}
        <SourceList />
      </section>

      <section id="pripojeni" className="connect">
        <h2>Jak se připojit</h2>
        <Guide endpoint={endpoint()} />
        <p className="muted small">
          Kdyby cokoli nešlo, napište mi na <Mail />.
        </p>
      </section>
    </div>
  );
}
