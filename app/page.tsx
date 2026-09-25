import { Suspense } from "react";
import { headers } from "next/headers";
import {
  DATABASE_GROUPS,
  DATABASES,
  formatTime,
  type DatabaseStatus,
} from "@/src/mcp/status";
import { getStatuses } from "./_status";
import { Guide } from "./_guide";
import { Icon, type IconName } from "./_icons";
import { Mail } from "./_legal";

export const dynamic = "force-dynamic";

/** The author's other project, linked from the intro. */
const OWL_URL = "https://owl.davidzavada.cz/";

/** Each database's icon and tint, keyed by its canary id. */
const LOOK: Record<string, { icon: IconName; color: string }> = {
  ns: { icon: "court", color: "var(--indigo)" },
  nss: { icon: "scale", color: "var(--teal)" },
  nalus: { icon: "shield", color: "var(--rose)" },
  justice: { icon: "court", color: "#52525b" },
  curia: { icon: "eu", color: "var(--blue)" },
  "esbirka-api": { icon: "list", color: "var(--green)" },
  "cellar-sparql": { icon: "eu", color: "var(--blue)" },
  primo: { icon: "book", color: "var(--amber)" },
};

/** What a row needs to render; the pending fallback has no status yet. */
type Row = Pick<DatabaseStatus, "id" | "label" | "group" | "href"> & {
  state: "ok" | "down" | "pending" | "unknown";
  badge: string;
  at?: string;
};

function toRow(status: DatabaseStatus): Row {
  const { id, label, group, href } = status;
  if (status.ok === null) return { id, label, group, href, state: "unknown", badge: "neověřeno" };
  return {
    id,
    label,
    group,
    href,
    state: status.ok ? "ok" : "down",
    badge: status.ok ? "dostupné" : (status.detail ?? "nedostupné"),
    at: formatTime(status.at!),
  };
}

function host(href: string): string {
  return new URL(href).host;
}

function Sources({ rows }: { rows: Row[] }) {
  return DATABASE_GROUPS.map((group) => {
    const items = rows.filter((row) => row.group === group);
    return (
      <div key={group} className="source-group">
        <div className="source-group-head">
          <span className="source-group-name">{group}</span>
          <span className="source-group-count">{items.length}</span>
        </div>
        <ul>
          {items.map((row) => {
            const look = LOOK[row.id] ?? { icon: "list", color: "#52525b" };
            return (
              <li key={row.id} className="source">
                <Icon name={look.icon} style={{ color: look.color }} />
                <div className="source-name">
                  <a href={row.href}>{row.label}</a>
                  <span className="source-host">{host(row.href)}</span>
                </div>
                <div className="source-state">
                  {row.at && <span className="source-at">{row.at}</span>}
                  <span className="badge" data-state={row.state}>
                    {row.badge}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  });
}

/**
 * The databases with their status badges. Its own async component so the
 * page shell streams immediately - a slow upstream check can then only delay
 * the badges, never the text around them.
 */
async function SourceList() {
  const statuses = await getStatuses();
  return <Sources rows={statuses.map(toRow)} />;
}

/** What stands in while the badges are still being checked. The names come
 * from the same list the real rows do - a hand-kept copy would go on
 * promising a database the server no longer queries. */
function SourceListFallback() {
  return (
    <Sources
      rows={DATABASES.map(({ canaryId, label, group, href }) => ({
        id: canaryId,
        label,
        group,
        href,
        state: "pending",
        badge: "zjišťuji…",
      }))}
    />
  );
}

/** Uploading one's own documents - shown locked, not offered yet. */
function OwnSources() {
  return (
    <div className="source-group locked">
      <div className="source-group-head">
        <span className="source-group-name">Vlastní zdroje</span>
        <Icon name="lock" size={13} label="zamčeno" />
      </div>
      <div className="source" aria-disabled="true" title="Dostupné v placené verzi">
        <Icon name="upload" />
        <div className="source-name">
          <span className="source-title">Nahrát vlastní zdroje</span>
          <span className="source-desc">
            Vlastní dokumenty, ve kterých bude asistent hledat vedle oficiálních databází.
          </span>
        </div>
      </div>
    </div>
  );
}

export default async function Home() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const proto =
    headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <div className="home">
      <section id="uvod" className="intro">
        <h1>MCP server pro právní systémy</h1>
        <p className="lead">
          Právní rešerše s AI jsou super. Přístup k judikatuře a právním předpisům s AI by ale podle
          mě neměl vést jen přes komerční nástroje. Data jsou dnes dobře dostupná a provoz je v
          zásadě zdarma. Proto jsem vytvořil nekomerční alternativu. Budu rád, když ji vyzkoušíte :)
        </p>
        <p className="lead">
          Server nemá vlastní databázi – funguje jako nachytřený Google: vyhledává živě přímo v
          oficiálních databázích.
        </p>
        <a href={OWL_URL} className="project-card">
          <img src="/owl.svg" alt="" width={36} height={36} />
          <span className="project-text">
            <span className="project-name">Owl</span>
            <span className="project-desc">
              Pokud vás zajímá monitoring recentní rozhodovací praxe a doktrinálního vývoje,
              podívejte se na můj další projekt.
            </span>
          </span>
          <span className="project-arrow" aria-hidden="true">
            →
          </span>
        </a>
      </section>

      <section id="zdroje" className="sources">
        <h2>Zdroje</h2>
        <OwnSources />
        <Suspense fallback={<SourceListFallback />}>
          <SourceList />
        </Suspense>
      </section>

      <section id="pripojeni" className="connect">
        <h2>Jak se připojit</h2>
        <Guide endpoint={endpoint} />
        <p className="muted small">
          Kdyby cokoli nešlo, napište mi na <Mail />.
        </p>
      </section>
    </div>
  );
}
