import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared furniture for the two legal pages. Underscore-prefixed, so Next
 * never routes it: a component file that happens to live in app/.
 */

/** Both documents state the same effective date; bump it when they change. */
export const EFFECTIVE = "1. 9. 2026";

/** Where the controller / operator is reachable: the one contact for both. */
export const CONTACT = "davzavada@gmail.com";

export function LegalHeader({ title }: { title: string }) {
  return (
    <>
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="legal-head">
        <h1>{title}</h1>
        <p className="muted">Účinné od {EFFECTIVE}</p>
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
