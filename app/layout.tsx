import { ClerkProvider } from "@clerk/nextjs";
import { csCZ } from "@clerk/localizations";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { clerkConfigured } from "@/src/mcp/config";
import { DATABASES } from "@/src/mcp/databases";
import { SiteHeader } from "./_header";
import { SiteNav } from "./_nav";
import { ClerkBridge, NoClerk } from "./_zdroje/clerk-bridge";
import { HINT_COOKIE, parseHint } from "./_zdroje/hint";
import { ZdrojeModals } from "./_zdroje/modals";
import { HintProvider } from "./_zdroje/store";
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
 * The sign-in hint cookie (app/_zdroje/hint.ts) lets the server render the
 * signed-in header, nav and home page group straight away, so the page
 * does not change shape when Clerk loads. Reading it makes every page
 * request-time, but cheap: nothing on the server side of a page waits on
 * the network (the source checks are fetched by the browser).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const clerk = clerkConfigured();
  const hint = clerk ? parseHint((await cookies()).get(HINT_COOKIE)?.value) : null;
  const page = (
    <HintProvider hint={hint}>
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
    </HintProvider>
  );
  return (
    <html lang="cs" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{clerk ? <ClerkProvider afterSignOutUrl="/" localization={csCZ}>{page}</ClerkProvider> : page}</body>
    </html>
  );
}
