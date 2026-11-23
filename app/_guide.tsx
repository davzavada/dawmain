"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { CopyField } from "./_copy";
import { claudeInstallLink } from "./_install-link";
import { platformFromHash, setPlatform, usePlatform, type PlatformId } from "./_platform";

/**
 * The setup guide with a Claude / ChatGPT picker: one numbered list per
 * platform, connector and skill together. The chosen platform is shared with
 * the sidebar and kept in the URL hash (see _platform.ts).
 */

interface Step {
  title: string;
  body: ReactNode;
}

interface Platform {
  id: PlatformId;
  label: string;
  steps: (endpoint: string) => Step[];
}

const SAMPLE_QUESTION =
  "Najdi judikaturu Nejvyššího soudu k odpovědnosti provozovatele za škodu způsobenou psem.";

const loginStep: Step = {
  title: "Přihlaste se",
  body: (
    <p>
      Otevře se okno Dawmain. Zaregistrujte se e-mailem, nebo se přihlaste, pokud už účet máte. Pak
      se vrátíte zpět do aplikace.
    </p>
  ),
};

const firstQuestion = (how: ReactNode): Step => ({
  title: "Zeptejte se",
  body: (
    <>
      <p>{how} Pro vyzkoušení můžete použít třeba tento dotaz:</p>
      <CopyField value={SAMPLE_QUESTION} label="Zkopírovat ukázkový dotaz" />
    </>
  ),
});

const PLATFORMS: Platform[] = [
  {
    id: "claude",
    label: "Claude",
    steps: (endpoint) => [
      {
        title: "Přidejte konektor",
        body: (
          <>
            <p>
              Klikněte na tlačítko. Na claude.ai se otevře okno{" "}
              <strong>Přidat vlastní konektor</strong> s vyplněným názvem i adresou – stačí je
              potvrdit.
            </p>
            <a className="button" href={claudeInstallLink(endpoint)} target="_blank" rel="noopener noreferrer">
              Přidat Dawmain do Claude
            </a>
          </>
        ),
      },
      loginStep,
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci a v nabídce nástrojů u pole pro zprávu zkontrolujte,
            že je Dawmain zapnutý.
          </>,
        ),
      },
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    steps: (endpoint) => [
      {
        title: "Kdo může Dawmain přidat",
        body: (
          <>
            <p>
              Vlastní MCP konektory umí ChatGPT jen ve firemních tarifech{" "}
              <strong>Business</strong>, <strong>Enterprise</strong> a <strong>Edu</strong>, a to
              ve webové verzi (chatgpt.com), ne v mobilní aplikaci.
            </p>
            <ul>
              <li>
                <strong>Business:</strong> přidat a zveřejnit ho může jen{" "}
                <strong>vlastník nebo správce</strong> pracovního prostoru. Kdo to u vás je, uvidíte
                v <strong>Nastavení pracovního prostoru → Členové</strong>.
              </li>
              <li>
                <strong>Enterprise / Edu:</strong> vlastník nebo správce, případně člen, kterému
                správce přes role (RBAC) povolí oprávnění <em>Create plugins with MCPs</em>.
                Zveřejnit pro celou firmu ho ale smí jen vlastník nebo správce.
              </li>
            </ul>
            <p>
              Ostatní kolegové nic nastavovat nemusí – jakmile správce Dawmain zveřejní, jen se do
              něj jednou přihlásí (krok 4).
            </p>
          </>
        ),
      },
      {
        title: "Správce přidá konektor",
        body: (
          <>
            <p>
              V postranním panelu otevřete <strong>Pluginy</strong>, klikněte na{" "}
              <strong>+</strong> a zvolte <strong>Add custom MCP server</strong>. Režim vývojáře
              už zapínat nemusíte. Jako název napište <em>Dawmain</em>, v části{" "}
              <strong>Connection</strong> vložte adresu níže, ověření nastavte na{" "}
              <strong>OAuth</strong>, potvrďte upozornění (
              <em>I understand and want to continue</em>) a klikněte na{" "}
              <strong>Create as a plugin</strong>.
            </p>
            <CopyField value={endpoint} label="Zkopírovat adresu" />
            <p>
              Tím je konektor zatím jen pro vás – můžete si ho nejdřív vyzkoušet.
            </p>
          </>
        ),
      },
      {
        title: "Správce ho zveřejní pro firmu",
        body: (
          <p>
            V administraci pracovního prostoru (<strong>Nastavení pracovního prostoru → Pluginy</strong>)
            najděte koncept Dawmain a zvolte <strong>Publish</strong>. Pak se objeví mezi
            schválenými pluginy a kolegové ho najdou v <strong>Nastavení → Pluginy</strong>. V
            Enterprise/Edu jsou nástroje nově zveřejněného pluginu ve výchozím stavu vypnuté –
            zapněte je u Dawmainu přes <strong>••• → Action control</strong>.
          </p>
        ),
      },
      {
        ...loginStep,
        body: (
          <p>
            Každý uživatel (i správce) se při prvním použití přihlásí svým vlastním účtem Dawmain:
            otevře se okno Dawmain, zaregistrujte se e-mailem, nebo se přihlaste, pokud už účet
            máte. Pak se vrátíte zpět do ChatGPT.
          </p>
        ),
      },
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci a do pole pro zprávu napište <strong>@</strong> a vyberte
            Dawmain (nebo ho zapněte přes <strong>+</strong> vedle pole).
          </>,
        ),
      },
    ],
  },
];

const noSubscription = () => () => {};

/**
 * The MCP address on the origin the browser is on. The static page carries the production
 * address (`fallback`), which is also what hydration renders; on production the two are the
 * same, so only a preview or localhost ever sees it change.
 */
function useEndpoint(fallback: string): string {
  const origin = useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,
  );
  return origin ? `${origin}/api/mcp` : fallback;
}

export function Guide({ endpoint: fallback }: { endpoint: string }) {
  const active = usePlatform();
  const endpoint = useEndpoint(fallback);

  // Open the guide a shared link names (#chatgpt) and bring it into view.
  useEffect(() => {
    function follow() {
      if (platformFromHash()) document.getElementById("pripojeni")?.scrollIntoView();
    }
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const platform = PLATFORMS.find((p) => p.id === active)!;

  return (
    <div className="guide">
      <div className="tabs" role="tablist" aria-label="Kterého asistenta používáte?">
        {PLATFORMS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`guide-tab-${id}`}
            aria-selected={id === active}
            aria-controls="guide-panel"
            onClick={() => setPlatform(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="guide-panel" aria-labelledby={`guide-tab-${active}`}>

        <ol className="steps">
          {platform.steps(endpoint).map((step, index) => (
            <li key={step.title}>
              <span className="step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="step-body">
                <h3>{step.title}</h3>
                {step.body}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
