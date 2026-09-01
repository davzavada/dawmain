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
      <h1 style={{ fontSize: "1.6rem", marginBottom: "0.25rem" }}>{title}</h1>
      <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: 0 }}>
        Účinné od {EFFECTIVE}
      </p>
    </>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 style={{ fontSize: "1.05rem", marginTop: "2rem", marginBottom: "0.5rem" }}>{heading}</h2>
      {children}
    </section>
  );
}

export const list: React.CSSProperties = {
  paddingLeft: "1.3rem",
  lineHeight: 1.8,
  marginTop: "0.4rem",
};

export function Mail() {
  return <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;
}
