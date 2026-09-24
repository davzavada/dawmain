"use client";

import { useState, type ReactNode } from "react";

/**
 * The setup guide with a Claude / ChatGPT picker: one numbered list per
 * platform, connector and skill together. A client component only for the
 * picker's state; the steps are plain data.
 */

interface Step {
  body: ReactNode;
  /** Screenshot slot: the file expected in public/navod/ and its alt text.
   * Set `ready` once the file is there to show it instead of a placeholder. */
  shot?: { file: string; alt: string; ready?: boolean };
}

const SKILL = <a href="/dawmain-reserse.zip">dawmain-reserse.zip</a>;

const LOGIN: Step["body"] = (
  <>
    Otevře se přihlašovací okno - stačí se zaregistrovat e-mailem (nebo přihlásit, pokud už účet
    máte).
  </>
);

const PLATFORMS: Array<{ id: string; label: string; steps: Step[] }> = [
  {
    id: "claude",
    label: "Claude",
    steps: [
      {
        body: (
          <>
            V claude.ai otevřete <strong>Nastavení → Konektory</strong>, zvolte{" "}
            <strong>Přidat vlastní konektor</strong>, pojmenujte ho „Dawmain“ a vložte adresu výše.
          </>
        ),
        shot: { file: "claude-1-konektor.png", alt: "Přidání vlastního konektoru v claude.ai" },
      },
      {
        body: LOGIN,
        shot: { file: "claude-2-prihlaseni.png", alt: "Přihlašovací okno Dawmain" },
      },
      {
        body: (
          <>
            Stáhněte si skill {SKILL}, otevřete <strong>Nastavení → Funkce → Skills</strong>,
            zvolte <strong>Nahrát skill</strong> a vyberte stažený soubor.
          </>
        ),
        shot: { file: "claude-3-skill.png", alt: "Nahrání skillu v Nastavení → Funkce" },
      },
      {
        body: (
          <>
            V nové konverzaci zkontrolujte v nabídce nástrojů, že je Dawmain zapnutý, a napište, co
            potřebujete najít.
          </>
        ),
        shot: { file: "claude-4-konverzace.png", alt: "Zapnutý Dawmain v konverzaci" },
      },
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    steps: [
      {
        body: (
          <>
            Na chatgpt.com otevřete <strong>Nastavení → Zabezpečení a přihlášení</strong> a zapněte{" "}
            <strong>Režim vývojáře</strong>. Vlastní konektory jsou jen v placených tarifech.
          </>
        ),
        shot: { file: "chatgpt-1-rezim-vyvojare.png", alt: "Zapnutí režimu vývojáře" },
      },
      {
        body: (
          <>
            V postranním panelu otevřete <strong>Pluginy</strong>, klikněte na <strong>+</strong>,
            pojmenujte konektor „Dawmain“, vložte adresu výše, jako ověření ponechte{" "}
            <strong>OAuth</strong> a potvrďte.
          </>
        ),
        shot: { file: "chatgpt-2-konektor.png", alt: "Formulář nového konektoru v ChatGPT" },
      },
      {
        body: LOGIN,
        shot: { file: "chatgpt-3-prihlaseni.png", alt: "Přihlašovací okno Dawmain" },
      },
      {
        body: (
          <>
            Stáhněte si skill {SKILL}, v postranním panelu otevřete <strong>Skills</strong>, zvolte{" "}
            <strong>Vytvořit → Nahrát z počítače</strong> a vyberte stažený soubor.
          </>
        ),
        shot: { file: "chatgpt-4-skill.png", alt: "Nahrání skillu v ChatGPT" },
      },
      {
        body: (
          <>
            V nové konverzaci klikněte na <strong>+</strong>, zapněte Dawmain a napište, co
            potřebujete najít.
          </>
        ),
        shot: { file: "chatgpt-5-konverzace.png", alt: "Zapnutý Dawmain v konverzaci" },
      },
    ],
  },
];

function Shot({ file, alt, ready }: NonNullable<Step["shot"]>) {
  if (ready) return <img className="shot" src={`/navod/${file}`} alt={alt} />;
  return (
    <div className="shot placeholder" role="img" aria-label={alt}>
      <span>Obrázek: {alt}</span>
      <code>public/navod/{file}</code>
    </div>
  );
}

export function Guide() {
  const [active, setActive] = useState(PLATFORMS[0].id);
  const platform = PLATFORMS.find((p) => p.id === active)!;

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Platforma">
        {PLATFORMS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`guide-tab-${id}`}
            aria-selected={id === active}
            aria-controls="guide-panel"
            onClick={() => setActive(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <ol className="steps" role="tabpanel" id="guide-panel" aria-labelledby={`guide-tab-${active}`}>
        {platform.steps.map((step, i) => (
          <li key={i}>
            {step.body}
            {step.shot && <Shot {...step.shot} />}
          </li>
        ))}
      </ol>
    </>
  );
}
