import { LegalHeader } from "./_legal";
import { Markdown } from "@/src/content/markdown";
import type { SiteTexts } from "@/src/content/texts";

/**
 * The two legal pages for given texts — apart from their routes (a page file
 * may export nothing but the page), so the tests and the editor's preview
 * render exactly what the site does. The bodies are editable texts
 * (legal.terms, legal.privacy in src/content/texts.ts; their defaults are
 * the wording kept in the repository). The signature under the terms is not.
 */

export function TermsPage({ texts }: { texts: Pick<SiteTexts, "legal.terms" | "legal.effective"> }) {
  return (
    <article className="legal">
      <LegalHeader title="Podmínky užití" effective={texts["legal.effective"]} />
      <Markdown source={texts["legal.terms"]} sections />
      <div className="signoff">
        <p>Díky a ať to šlape :)</p>
        <p className="muted">David Závada</p>
      </div>
    </article>
  );
}

export function PrivacyPage({ texts }: { texts: Pick<SiteTexts, "legal.privacy" | "legal.effective"> }) {
  return (
    <article className="legal">
      <LegalHeader title="Zásady ochrany osobních údajů" effective={texts["legal.effective"]} />
      <Markdown source={texts["legal.privacy"]} sections />
    </article>
  );
}
