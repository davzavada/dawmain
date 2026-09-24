import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dawmain - MCP server",
  description: "MCP server pro české a unijní právní rešerše - živé dotazy do oficiálních databází.",
};

/** Matches the top of the logo's dawn sky - tints mobile browser chrome. */
export const viewport: Viewport = { themeColor: "#0E1938" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="cs">
      <body>
        <main>{children}</main>
        <footer>
          <a href="/">Hlavní stránka</a> ·{" "}
          <a href="/podminky">Podmínky užití</a> ·{" "}
          <a href="/soukromi">Zásady ochrany osobních údajů</a>
        </footer>
      </body>
    </html>
  );
}
