import { auth } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/src/mcp/config";
import { LIBRARIES, LIBRARY_IDS, credentialsConfigured, readerCredentialSummary } from "@/src/mcp/credentials";
import { LibraryLoginForm } from "./_forms";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Účet - Dawmain",
  description: "Přihlašovací údaje ke knihovnám, kterými Dawmain otevírá licencovanou literaturu vaším jménem.",
};

/**
 * The reader's account: which library logins are stored, and the forms to
 * store or remove them. Signed-in Clerk users only — the same login the
 * connector uses, so the MCP tools can tie a stored library login to the
 * caller. Without Clerk (local development) the page explains itself
 * instead of failing.
 */
export default async function Ucet() {
  const intro = (
    <>
      <h1 style={{ fontSize: "1.6rem", marginBottom: "0.25rem" }}>Účet</h1>
      <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 0 }}>Přihlášení ke knihovnám pro čtení licencované literatury</p>
      <p>
        Nástroj <code>doctrine_get_document</code> umí přečíst dílo, které je open access. Licencované tituly (Nomos, Brill, Kluwer,
        Oxford, Springer a další, i většina zdrojů UKAŽ) jsou za přihlášením knihovny. Uložíte-li sem své čtenářské přihlášení, server
        se jím při čtení přihlásí za vás — přes proxy knihovny, stejně jako byste to udělali v prohlížeči — a text otevře, pokud ho
        knihovna licencuje.
      </p>
      <p>
        Heslo se ukládá zašifrované klíčem, který má jen tento server; poskytovatel účtů vidí jen zašifrovaný blok. Použije se výhradně k
        přihlášení do zvolené knihovny, jen když čtete vy, a nikdy se nezobrazí. Smazat ho můžete kdykoli zde; smazáním účtu zmizí s
        ním. Podrobnosti v <a href="/soukromi">zásadách ochrany osobních údajů</a>.
      </p>
    </>
  );

  if (!clerkConfigured()) {
    return (
      <>
        {intro}
        <p style={{ color: "#b91c1c" }}>Na tomto nasazení není přihlášení nastavené, účet tu proto není k dispozici.</p>
      </>
    );
  }

  const { userId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn({ returnBackUrl: "/ucet" });

  if (!credentialsConfigured()) {
    return (
      <>
        {intro}
        <p style={{ color: "#b91c1c" }}>
          Ukládání přihlašovacích údajů není na tomto nasazení zapnuté (chybí <code>CREDENTIALS_SECRET</code>).
        </p>
      </>
    );
  }

  const summary = await readerCredentialSummary(userId);

  return (
    <>
      {intro}
      {LIBRARY_IDS.map((library) => (
        <LibraryLoginForm key={library} library={library} label={LIBRARIES[library].label} hint={LIBRARIES[library].loginHint} stored={summary[library]} />
      ))}
    </>
  );
}
