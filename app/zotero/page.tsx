import type { Metadata } from "next";
import { Suspense } from "react";
import { ZoteroPage } from "./zotero-page";

export const metadata: Metadata = {
  title: "Zotero - Dawmain",
  description: "Připojení knihovny ze zotero.org: v jakých knihovnách asistent hledá a čte, zda do Zotera smí ukládat, a odpojení.",
};

/**
 * The Zotero settings (./zotero-page.tsx). Static like every page: the
 * connection and the libraries are fetched by the browser once Clerk has
 * loaded. useSearchParams (the connect flow's ?stav=) needs its own
 * Suspense boundary to keep the page prerenderable.
 */
export default function Zotero() {
  return (
    <Suspense fallback={null}>
      <ZoteroPage />
    </Suspense>
  );
}
