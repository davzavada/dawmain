import Link from "next/link";
import type { ReactNode } from "react";
import { CONTACT } from "@/src/content/contact";
import { DEFAULT_TEXTS } from "@/src/content/texts";

/**
 * Shared furniture for the two legal pages. Underscore-prefixed, so Next
 * never routes it: a component file that happens to live in app/.
 */

/** Both documents state the same effective date (an editable text, legal.effective); this is its default. */
export const EFFECTIVE = DEFAULT_TEXTS["legal.effective"];

export { CONTACT };

export function LegalHeader({ title, effective = EFFECTIVE }: { title: string; effective?: string }) {
  return (
    <>
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="legal-head">
        <h1>{title}</h1>
        <p className="muted">Účinné od {effective}</p>
      </header>
    </>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  );
}

export function Mail() {
  return <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;
}
