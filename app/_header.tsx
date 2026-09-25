import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { formatTime } from "@/src/mcp/status";
import { getStatuses } from "./_status";

/**
 * The sticky bar across the top of every page: the name, and on wide screens
 * a one-line summary of the source checks.
 */

function Summary({ state, text }: { state: "ok" | "down" | "pending"; text: string }) {
  return (
    <span className="summary">
      <span className="summary-dot" data-state={state} aria-hidden="true" />
      {text}
    </span>
  );
}

async function StatusSummary() {
  await connection();
  const statuses = await getStatuses();
  const known = statuses.filter((s) => s.ok !== null);
  if (known.length === 0) return <Summary state="pending" text="Stav zdrojů neověřen" />;
  const up = known.filter((s) => s.ok).length;
  const at = formatTime(Math.max(...known.map((s) => s.at!)));
  return up === statuses.length ? (
    <Summary state="ok" text={`Všechny zdroje dostupné · ${at}`} />
  ) : (
    <Summary state="down" text={`${up} z ${statuses.length} zdrojů dostupných · ${at}`} />
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="site-name">
        <img src="/logo.svg" alt="" width={24} height={24} />
        <span>Dawmain - právní rešerše s AI</span>
      </Link>
      <span className="site-tagline">MCP server pro české a unijní právo · David Závada</span>
      <Suspense fallback={<Summary state="pending" text="Ověřuji zdroje…" />}>
        <StatusSummary />
      </Suspense>
    </header>
  );
}
