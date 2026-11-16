import Link from "next/link";

/**
 * The 404 for every URL no route matches (and for notFound(), e.g. the admin
 * pages to anyone but an admin). Root not-found.tsx renders inside the root
 * layout, so header, navigation and footer stay; Next answers it with status
 * 404 and adds noindex itself. Static, like the other pages.
 */
export default function NotFound() {
  return (
    <article className="legal">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="legal-head">
        <h1>Tahle stránka tu není</h1>
        <p className="muted">Chyba 404</p>
      </header>
      <p>
        Adresa je možná překlepnutá, nebo stránka zmizela. Zkuste to z <Link href="/">hlavní stránky</Link>.
      </p>
    </article>
  );
}
