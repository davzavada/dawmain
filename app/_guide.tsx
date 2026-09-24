"use client";

import { useState, type ReactNode } from "react";

/**
 * The step-by-step setup guide with a Claude / ChatGPT picker. A client
 * component only for the picker's state; the steps themselves are static.
 */

type Platform = "claude" | "chatgpt";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
];

/**
 * A screenshot slot. Without `src` it renders a placeholder naming the file
 * it expects - drop the image into public/navod/ under that name and pass
 * `src` to swap the placeholder for the picture.
 */
function Shot({ file, alt, src }: { file: string; alt: string; src?: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          margin: "0.6rem 0 1rem",
          border: "1px solid #e5e7eb",
          borderRadius: "0.5rem",
        }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={alt}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.25rem",
        aspectRatio: "16 / 9",
        margin: "0.6rem 0 1rem",
        border: "2px dashed #d1d5db",
        borderRadius: "0.5rem",
        background: "#f9fafb",
        color: "#9ca3af",
        fontSize: "0.85rem",
        textAlign: "center",
        padding: "1rem",
      }}
    >
      <span>Obrázek: {alt}</span>
      <code style={{ fontSize: "0.75rem" }}>public/navod/{file}</code>
    </div>
  );
}

function Step({ children }: { children: ReactNode }) {
  return <li style={{ marginBottom: "0.75rem" }}>{children}</li>;
}

const stepList: React.CSSProperties = { paddingLeft: "1.4rem", lineHeight: 1.7 };
const subheading: React.CSSProperties = { fontSize: "1rem", marginTop: "1.75rem" };

function ClaudeGuide() {
  return (
    <>
      <ol style={stepList}>
        <Step>
          V aplikaci claude.ai otevřete <strong>Nastavení → Konektory</strong>.
          <Shot file="claude-1-konektory.png" alt="Nastavení → Konektory v claude.ai" />
        </Step>
        <Step>
          Zvolte <strong>Přidat vlastní konektor</strong>, pojmenujte ho (třeba „Dawmain“) a vložte
          adresu výše.
          <Shot file="claude-2-pridat.png" alt="Formulář Přidat vlastní konektor s vyplněnou adresou" />
        </Step>
        <Step>
          Otevře se přihlašovací okno - stačí se zaregistrovat e-mailem (nebo přihlásit, pokud už
          účet máte).
          <Shot file="claude-3-prihlaseni.png" alt="Přihlašovací okno Dawmain" />
        </Step>
        <Step>
          V nové konverzaci zkontrolujte v nabídce nástrojů, že je Dawmain zapnutý, a napište, co
          potřebujete najít.
          <Shot file="claude-4-konverzace.png" alt="Zapnutý konektor Dawmain v konverzaci" />
        </Step>
      </ol>

      <h3 style={subheading}>Přidání skillu</h3>
      <ol style={stepList}>
        <Step>
          Stáhněte si <a href="/dawmain-reserse.md">skill</a>.
        </Step>
        <Step>
          Otevřete <strong>Nastavení → Funkce</strong> a v části <strong>Skills</strong> zvolte{" "}
          <strong>Nahrát skill</strong>.
          <Shot file="claude-5-skill.png" alt="Nahrání skillu v Nastavení → Funkce" />
        </Step>
        <Step>Vyberte stažený soubor a skill zapněte.</Step>
      </ol>
    </>
  );
}

function ChatGPTGuide() {
  return (
    <>
      <p>
        Vlastní konektory jsou v ChatGPT dostupné na webu (chatgpt.com) v placených tarifech a
        zapínají se přes <strong>režim vývojáře</strong>.
      </p>
      <ol style={stepList}>
        <Step>
          Otevřete <strong>Nastavení → Aplikace a konektory → Pokročilá nastavení</strong> a zapněte{" "}
          <strong>Režim vývojáře</strong> (Developer mode).
          <Shot file="chatgpt-1-rezim-vyvojare.png" alt="Zapnutí režimu vývojáře v ChatGPT" />
        </Step>
        <Step>
          Vraťte se do <strong>Aplikace a konektory</strong> a zvolte <strong>Vytvořit</strong>{" "}
          (Create).
          <Shot file="chatgpt-2-vytvorit.png" alt="Tlačítko Vytvořit v Aplikace a konektory" />
        </Step>
        <Step>
          Vyplňte název (třeba „Dawmain“), do pole <strong>MCP Server URL</strong> vložte adresu
          výše, jako ověření ponechte <strong>OAuth</strong>, potvrďte, že aplikaci důvěřujete, a
          klikněte na <strong>Vytvořit</strong>.
          <Shot file="chatgpt-3-formular.png" alt="Vyplněný formulář nového konektoru" />
        </Step>
        <Step>
          Otevře se přihlašovací okno - stačí se zaregistrovat e-mailem (nebo přihlásit, pokud už
          účet máte).
          <Shot file="chatgpt-4-prihlaseni.png" alt="Přihlašovací okno Dawmain" />
        </Step>
        <Step>
          V nové konverzaci klikněte na <strong>+</strong>, zvolte <strong>Režim vývojáře</strong>{" "}
          a zapněte Dawmain. Pak napište, co potřebujete najít.
          <Shot file="chatgpt-5-konverzace.png" alt="Zapnutý konektor Dawmain v konverzaci" />
        </Step>
      </ol>

      <h3 style={subheading}>Přidání skillu</h3>
      <p>
        ChatGPT skilly jako Claude nenačítá, stejnou práci ale udělá projekt, který má soubor se
        skillem u sebe.
      </p>
      <ol style={stepList}>
        <Step>
          Stáhněte si <a href="/dawmain-reserse.md">skill</a>.
        </Step>
        <Step>
          V postranním panelu založte <strong>Nový projekt</strong> (třeba „Rešerše“) a do jeho
          souborů nahrajte stažený soubor.
          <Shot file="chatgpt-6-projekt.png" alt="Nahrání souboru se skillem do projektu" />
        </Step>
        <Step>
          Do pokynů projektu vložte: <em>„Při každé rešerši postupuj podle souboru SKILL.md.“</em>
          <Shot file="chatgpt-7-pokyny.png" alt="Pokyny projektu odkazující na SKILL.md" />
        </Step>
        <Step>Rešerše pak zakládejte jako konverzace v tomto projektu.</Step>
      </ol>
    </>
  );
}

export function Guide() {
  const [platform, setPlatform] = useState<Platform>("claude");

  return (
    <div style={{ marginTop: "1.25rem" }}>
      <div
        role="tablist"
        aria-label="Platforma"
        style={{
          display: "inline-flex",
          gap: "0.25rem",
          padding: "0.25rem",
          background: "#f3f4f6",
          borderRadius: "0.5rem",
        }}
      >
        {PLATFORMS.map(({ id, label }) => {
          const selected = id === platform;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`guide-tab-${id}`}
              aria-selected={selected}
              aria-controls={`guide-panel-${id}`}
              onClick={() => setPlatform(id)}
              style={{
                border: "none",
                borderRadius: "0.375rem",
                background: selected ? "#ffffff" : "transparent",
                boxShadow: selected ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                color: selected ? "#111827" : "#6b7280",
                font: "inherit",
                fontSize: "0.9rem",
                fontWeight: selected ? 600 : 400,
                padding: "0.35rem 1rem",
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`guide-panel-${platform}`}
        aria-labelledby={`guide-tab-${platform}`}
        style={{ marginTop: "1rem" }}
      >
        {platform === "claude" ? <ClaudeGuide /> : <ChatGPTGuide />}
      </div>
    </div>
  );
}
