"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyField } from "./_copy";

/**
 * The setup guide with a Claude / ChatGPT picker: one numbered list per
 * platform, connector and skill together. The chosen platform lives in the
 * URL hash (#claude, #chatgpt), so a link can open the right tab directly.
 */

interface Step {
  title: string;
  body: ReactNode;
  /** Screenshot expected at public/navod/<shot>.png; until the file exists
   * the slot shows a placeholder naming it. */
  shot?: string;
  alt?: string;
}

interface Platform {
  id: string;
  label: string;
  note?: ReactNode;
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
        shot: "claude-1-konektor",
        alt: "Přidání vlastního konektoru v Nastavení → Konektory",
      },
      { ...loginStep, shot: "claude-2-prihlaseni", alt: "Přihlašovací okno Dawmain" },
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
        shot: "claude-3-skill",
        alt: "Nahrání skillu v Nastavení → Funkce",
      },
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci a v nabídce nástrojů u pole pro zprávu zkontrolujte,
            že je Dawmain zapnutý.
          </>,
        ),
        shot: "claude-4-konverzace",
        alt: "Zapnutý Dawmain v nabídce nástrojů",
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
    note: (
      <>
        Vlastní konektory ChatGPT zatím umí jen v <strong>placených tarifech</strong> (Plus, Pro,
        Business…) a nastavují se na webu <a href="https://chatgpt.com">chatgpt.com</a>, ne v
        mobilní aplikaci. Používat je pak můžete všude.
      </>
    ),
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
        shot: "chatgpt-1-rezim-vyvojare",
        alt: "Přepínač Režim vývojáře v Nastavení → Zabezpečení a přihlášení",
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
        shot: "chatgpt-2-konektor",
        alt: "Vyplněný formulář nového konektoru",
      },
      { ...loginStep, shot: "chatgpt-3-prihlaseni", alt: "Přihlašovací okno Dawmain" },
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
        shot: "chatgpt-4-skill",
        alt: "Nahrání skillu přes Skills → Vytvořit",
      },
      {
        ...firstQuestion(
          <>
            Otevřete novou konverzaci, klikněte na <strong>+</strong> vedle pole pro zprávu a
            zapněte Dawmain.
          </>,
        ),
        shot: "chatgpt-5-konverzace",
        alt: "Zapnutý Dawmain v nové konverzaci",
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

/**
 * A screenshot slot: shows public/navod/<name>.png once the file exists and
 * a labelled placeholder until then, so adding a screenshot needs no code.
 */
function Shot({ name, alt }: { name: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  // An error that fired before hydration never reaches onError - catch it here.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth === 0) setMissing(true);
  }, []);

  if (missing) {
    return (
      <div className="shot placeholder" role="img" aria-label={alt}>
        <span>Obrázek: {alt}</span>
        <code>public/navod/{name}.png</code>
      </div>
    );
  }
  const src = `/navod/${name}.png`;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="shot-link">
      <img ref={img} className="shot" src={src} alt={alt} onError={() => setMissing(true)} />
    </a>
  );
}

export function Guide({ endpoint }: { endpoint: string }) {
  const [active, setActive] = useState(PLATFORMS[0].id);

  // Open the tab a shared link names (#chatgpt), and keep the hash in step.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (PLATFORMS.some((p) => p.id === fromHash)) setActive(fromHash);
  }, []);

  function choose(id: string) {
    setActive(id);
    history.replaceState(null, "", `#${id}`);
  }

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
            onClick={() => choose(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="guide-panel" aria-labelledby={`guide-tab-${active}`}>
        {platform.note && <p className="note">{platform.note}</p>}

        <ol className="steps">
          {platform.steps(endpoint).map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              {step.body}
              {step.shot && <Shot key={step.shot} name={step.shot} alt={step.alt ?? step.title} />}
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
