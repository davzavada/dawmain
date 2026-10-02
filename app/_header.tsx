import Link from "next/link";
import { zoteroConfigured } from "@/src/zotero/config";
import { StatusSummary } from "./_source-status";
import { AccountControl } from "./_zdroje/account";

/**
 * The sticky bar across the top of every page: the name, on wide screens a
 * one-line summary of the source checks (filled in by the browser, see
 * app/_source-status.tsx), and at the right end the account control
 * (sign-in, or the avatar with the account menu — see
 * app/_zdroje/account.tsx; nothing when Clerk is not configured).
 */

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="site-name">
        <img src="/logo.svg" alt="" width={24} height={24} />
        <span>Dawmain - právní rešerše s AI</span>
      </Link>
      <span className="site-tagline">MCP server pro české a unijní právo · David Závada</span>
      <StatusSummary />
      {/* Zotero only where the deployment can connect it (the OAuth app and CREDENTIALS_SECRET). */}
      <AccountControl zotero={zoteroConfigured()} />
    </header>
  );
}
