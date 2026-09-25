"use client";

import { useEffect, type ReactNode } from "react";
import { CopyField } from "./_copy";
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
  help: Array<{ q: string; a: ReactNode }>;
}

const SAMPLE_QUESTION =
  "Najdi judikaturu Nejvyššího soudu k odpovědnosti provozovatele za škodu způsobenou psem.";

const skillDownload = (
  <a className="button" href="/dawmain-reserse.md" download>
    Stáhnout skill (SKILL.md)
  </a>
);

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
              Na <a href="https://claude.ai/settings/connectors">claude.ai</a> otevřete{" "}
              <strong>Nastavení → Konektory</strong> a zvolte{" "}
              <strong>Přidat vlastní konektor</strong>. Jako název napište <em>Dawmain</em> a do
              pole s adresou vložte:
            </p>
            <CopyField value={endpoint} label="Zkopírovat adresu" />
          </>
        ),
      },
      loginStep,
      {
        title: "Nahrajte skill",
        body: (
          <>
            <p>
              Skill asistenta naučí, jak s databázemi pracovat a jak citovat. Stáhněte si ho:
            </p>
            {skillDownload}
            <p>
              Pak otevřete <strong>Nastavení → Funkce</strong>, v části <strong>Skills</strong>{" "}
              zvolte <strong>Nahrát skill</strong> a vyberte stažený soubor.
            </p>
          </>
        ),
      },
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci a v nabídce nástrojů u pole pro zprávu zkontrolujte,
            že je Dawmain zapnutý.
          </>,
        ),
      },
    ],
    help: [
      {
        q: "V nabídce nástrojů Dawmain nevidím.",
        a: (
          <>
            V <strong>Nastavení → Konektory</strong> zkontrolujte, že u Dawmain svítí{" "}
            <em>Připojeno</em>. Pokud ne, klikněte na <strong>Připojit</strong> a přihlaste se znovu.
          </>
        ),
      },
      {
        q: "Asistent databáze nepoužívá.",
        a: <>Napište mu to přímo: „Použij Dawmain a najdi…“. Se zapnutým skillem to dělá sám.</>,
      },
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    steps: (endpoint) => [
      {
        title: "Zapněte režim vývojáře",
        body: (
          <p>
            Klikněte vlevo dole na své jméno, otevřete{" "}
            <strong>Nastavení → Zabezpečení a přihlášení</strong> a zapněte{" "}
            <strong>Režim vývojáře</strong>. Bez něj vlastní konektor přidat nejde.
          </p>
        ),
      },
      {
        title: "Přidejte konektor",
        body: (
          <>
            <p>
              V postranním panelu otevřete <strong>Pluginy</strong> a klikněte na{" "}
              <strong>+</strong>. Jako název napište <em>Dawmain</em>, do pole s adresou vložte
              adresu níže, ověření nechte na <strong>OAuth</strong> a potvrďte.
            </p>
            <CopyField value={endpoint} label="Zkopírovat adresu" />
          </>
        ),
      },
      loginStep,
      {
        title: "Nahrajte skill",
        body: (
          <>
            <p>
              Skill asistenta naučí, jak s databázemi pracovat a jak citovat. Stáhněte si ho:
            </p>
            {skillDownload}
            <p>
              Pak v postranním panelu otevřete <strong>Skills</strong>, zvolte{" "}
              <strong>Vytvořit → Nahrát z počítače</strong> a vyberte stažený soubor.
            </p>
          </>
        ),
      },
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci, klikněte na <strong>+</strong> vedle pole pro zprávu a
            zapněte Dawmain.
          </>,
        ),
      },
    ],
    help: [
      {
        q: "Režim vývojáře v nastavení nemám.",
        a: <>Je jen v placených tarifech a jen na webu. Ve firemním účtu ho musí povolit správce.</>,
      },
      {
        q: "Přihlášení proběhlo, ale Dawmain v konverzaci nevidím.",
        a: (
          <>
            Obnovte stránku. Pokud to nepomůže, konektor v <strong>Pluginech</strong> odeberte a
            přidejte znovu.
          </>
        ),
      },
    ],
  },
];

export function Guide({ endpoint }: { endpoint: string }) {
  const active = usePlatform();

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

        <h3 className="help-title">Něco nefunguje?</h3>
        {platform.help.map(({ q, a }) => (
          <details key={q} className="help">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
