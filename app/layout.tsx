import { ClerkProvider } from "@clerk/nextjs";
import { csCZ } from "@clerk/localizations";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { clerkConfigured } from "@/src/mcp/config";
import { DATABASES } from "@/src/mcp/databases";
import { SiteHeader } from "./_header";
import { SiteNav } from "./_nav";
import { ClerkBridge, NoClerk } from "./_zdroje/clerk-bridge";
import { HINT_SCRIPT } from "./_zdroje/hint";
import { ZdrojeModals } from "./_zdroje/modals";
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

/**
 * Every page: the header (with the account control), the navigation, the
 * content, and the Vlastní soubory / Zotero modals, which open over any page
 * from the URL (?soubory=…, ?zotero=…). Clerk wraps the whole app so the header
 * can show who is signed in everywhere — but only when it is configured:
 * without keys ClerkProvider would throw (or start keyless mode), so the
 * site then renders without it and the account control stays hidden.
 *
 * Every page is static: built once, served from the CDN, nothing on the
 * server runs for a visit (the source checks, the summary and the Zotero
 * status are fetched by the browser afterwards). What differs for a
 * signed-in user is applied before the first paint by the sign-in hint's
 * inline script in <head> (app/_zdroje/hint.ts) — it marks <html>, which is
 * why <html> does not warn about attributes React did not render — so the
 * page does not change shape when Clerk loads.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const clerk = clerkConfigured();
  const page = (
    <>
      {clerk ? <ClerkBridge /> : <NoClerk />}
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
      {/* useSearchParams: its own Suspense boundary keeps static pages prerenderable. */}
      <Suspense fallback={null}>
        <ZdrojeModals />
      </Suspense>
    </>
  );
  return (
    <html lang="cs" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>{clerk ? <script dangerouslySetInnerHTML={{ __html: HINT_SCRIPT }} /> : null}</head>
      <body>{clerk ? <ClerkProvider afterSignOutUrl="/" localization={csCZ}>{page}</ClerkProvider> : page}</body>
    </html>
  );
}
