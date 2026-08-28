import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Dawmain - MCP server",
  description: "MCP server pro české a unijní právní rešerše - živé dotazy do oficiálních databází.",
};

/** Matches the top of the logo's dawn sky - tints mobile browser chrome. */
export const viewport: Viewport = { themeColor: "#0E1938" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="cs">
      <body
        style={{
          margin: 0,
          padding: "3rem 1.5rem",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          lineHeight: 1.6,
          color: "#111827",
          background: "#ffffff",
        }}
      >
        {/* Justified text only where lines are long enough - on narrow
            phone columns block justification produces ugly word gaps. */}
        <style>{`
          main { text-align: justify; }
          @media (max-width: 640px) { main { text-align: left; } }
          footer a { color: #6b7280; text-decoration: none; }
          footer a:hover { text-decoration: underline; }
        `}</style>
        <main style={{ maxWidth: "44rem", margin: "0 auto" }}>{children}</main>
        <footer
          style={{
            maxWidth: "44rem",
            margin: "3rem auto 0",
            paddingTop: "1rem",
            borderTop: "1px solid #e5e7eb",
            fontSize: "0.78rem",
            color: "#9ca3af",
          }}
        >
          <a href="/">Hlavní stránka</a> ·{" "}
          <a href="/podminky">Podmínky užití</a> ·{" "}
          <a href="/soukromi">Zásady ochrany osobních údajů</a>
        </footer>
      </body>
    </html>
  );
}
