import { Guide } from "./_guide";
import { Mail } from "./_legal";
import { SourceList } from "./_source-status";
import { OwnSourcesGroup } from "./_zdroje/own-sources";
import { Markdown } from "@/src/content/markdown";
import { siteTexts } from "@/src/content/store";
import { productionOrigin } from "@/src/runtime";
import { zoteroConfigured } from "@/src/zotero/config";

/** The author's other project, linked at the end of the page. */
const OWL_URL = "https://owl.davidzavada.cz/";

/**
 * The MCP address the guide offers, fixed at build (the page is static): the
 * production domain (PUBLIC_URL). The guide swaps in the address the browser
 * is actually on (a test instance, localhost) — on
 * production it is the same.
 */
function endpoint(): string {
  return `${productionOrigin() ?? "https://dawmain.davidzavada.cz"}/api/mcp`;
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
      </section>

      <section id="zdroje" className="sources">
        <h2>Zdroje</h2>
        {/* Client island: the status lights come from GET /api/status (static, checked hourly) after the page is up. */}
        {/* Two columns on wide screens: case law on the left, legislation and Slovakia on the right. */}
        <div className="sources-cols">
          <div className="sources-col">
            <SourceList groups={["Judikatura"]} />
          </div>
          <div className="sources-col">
            <SourceList groups={["Předpisy", "Slovensko"]} />
          </div>
        </div>
        {/*
          Client island, the Pro group: Vlastní soubory (counts from GET /api/files/summary),
          Zotero (locked where the deployment cannot connect it — no OAuth app or CREDENTIALS_SECRET)
          and UKAŽ (hidden: only for accounts an admin switched it on for).
        */}
        <OwnSourcesGroup
          zotero={zoteroConfigured()}
          texts={{ files: texts["sources.files"], zotero: texts["sources.zotero"], ukaz: texts["sources.ukaz"] }}
          proNote={<Markdown source={texts["sources.pro"]} paragraphClass="source-group-note" />}
        />
      </section>

      {/*
        The last section and what follows it fill at least a screen, so the
        nav's "Jak se připojit" brings the section to the top like the others.
      */}
      <div className="home-end">
        <section id="pripojeni" className="connect">
          <h2>Jak se připojit</h2>
          <Guide endpoint={endpoint()} />
          <p className="muted small guide-note">
            Kdyby cokoli nešlo, napište mi na <Mail />.
          </p>
        </section>

        <aside className="more" aria-label="Další projekt">
          <a href={OWL_URL} className="project-card">
            <img src="/owl.svg" alt="" width={32} height={32} />
            <span className="project-text">
              <span className="project-name">Owl</span>
              <span className="project-desc">{texts["home.owl"]}</span>
            </span>
            <span className="project-arrow" aria-hidden="true">
              →
            </span>
          </a>
        </aside>
      </div>
    </div>
  );
}
