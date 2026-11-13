import { Guide } from "./_guide";
import { Mail } from "./_legal";
import { SourceList } from "./_source-status";
import { OwnSourcesGroup } from "./_zdroje/own-sources";
import { Markdown } from "@/src/content/markdown";
import { siteTexts } from "@/src/content/store";
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

/**
 * Static. The intro and the lines under the Pro sources are editable texts
 * (src/content/texts.ts), read at build and after an admin saves them on
 * /sprava/texty — never per visit.
 */
export default async function Home() {
  const texts = await siteTexts();
  return (
    <div className="home">
      <section id="uvod" className="intro">
        <h1>{texts["home.title"]}</h1>
        <Markdown source={texts["home.lead"]} paragraphClass="lead" />
        <a href={OWL_URL} className="project-card">
          <img src="/owl.svg" alt="" width={36} height={36} />
          <span className="project-text">
            <span className="project-name">Owl</span>
            <span className="project-desc">{texts["home.owl"]}</span>
          </span>
          <span className="project-arrow" aria-hidden="true">
            →
          </span>
        </a>
      </section>

      <section id="zdroje" className="sources">
        <h2>Zdroje</h2>
        {/*
          Client island, the Pro group: Vlastní soubory (counts from GET /api/files/summary),
          Zotero (locked where the deployment cannot connect it — no OAuth app or CREDENTIALS_SECRET)
          and UKAŽ (switched on per account).
        */}
        <OwnSourcesGroup
          zotero={zoteroConfigured()}
          texts={{ files: texts["sources.files"], zotero: texts["sources.zotero"], ukaz: texts["sources.ukaz"] }}
        />
        {/* Client island: the badges come from GET /api/status (static, checked hourly) after the page is up. */}
        <SourceList />
      </section>

      <section id="pripojeni" className="connect">
        <h2>Jak se připojit</h2>
        <Guide endpoint={endpoint()} />
        <p className="muted small guide-note">
          Kdyby cokoli nešlo, napište mi na <Mail />.
        </p>
      </section>
    </div>
  );
}
