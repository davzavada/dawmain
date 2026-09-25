import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { DATABASES } from "@/src/mcp/status";
import { SiteHeader } from "./_header";
import { SiteNav } from "./_nav";
import "./globals.css";

// Self-hosted by next/font at build time: the browser never asks Google.
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Dawmain - MCP server",
  description: "MCP server pro české a unijní právní rešerše - živé dotazy do oficiálních databází.",
};

/** Matches the top of the logo's dawn sky - tints mobile browser chrome. */
export const viewport: Viewport = { themeColor: "#0E1938" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="cs" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <SiteHeader />
        <div className="shell">
          <SiteNav sourceCount={DATABASES.length} />
          <main>
            {children}
            <footer>
              <Link href="/podminky">Podmínky užití</Link>
              <Link href="/soukromi">Ochrana osobních údajů</Link>
            </footer>
          </main>
        </div>
      </body>
    </html>
  );
}
