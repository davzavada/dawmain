import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LIMITS } from "@/src/files/config";
import { isOperator, operatorSnapshot, type OperatorSnapshot } from "@/src/files/operator";
import { formatCount } from "@/app/_zdroje/format";
import { reindexBatchAction, setModeOverride } from "./actions";

export const dynamic = "force-dynamic";
// "Přeindexovat dávku" runs up to 200 documents in one Server Function call.
export const maxDuration = 300;

export const metadata: Metadata = { title: "Provoz · Vlastní zdroje", robots: { index: false, follow: false } };

/**
 * The operator page: the free-tier guards against their limits, the
 * libraries, documents stuck in the pipeline, the mode override and the
 * batch re-derivation. Operators only (FILES_OPERATOR_IDS) — anyone else,
 * signed in or not, gets the same 404 as a page that does not exist.
 * Counters, ids and statuses only: no titles, file names or text.
 */

const MODE_LABELS: Record<string, string> = {
  on: "zapnuto",
  readonly: "jen pro čtení",
  off: "vypnuto",
  unconfigured: "nenastaveno",
};

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function mb(bytes: number): string {
  return `${formatCount(Math.round(bytes / (1024 * 1024)))} MB`;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
}

function Meter({ label, value, limit, share }: { label: string; value: string; limit: string; share: number }) {
  const tone = share >= 0.9 ? "bad" : share >= LIMITS.readonlyAt * 0.9 ? "busy" : "ok";
  return (
    <li className="zd-meter">
      <span className="zd-meter-label">{label}</span>
      <span className="zd-quota-bar zd-meter-bar" aria-hidden="true">
        <span data-tone={tone} style={{ width: `${Math.min(100, Math.max(1, share * 100))}%` }} />
      </span>
      <span className="zd-meter-value">
        {value} z {limit} <span className="zd-muted">({percent(share)})</span>
      </span>
    </li>
  );
}

async function load(): Promise<OperatorSnapshot | string> {
  try {
    return await operatorSnapshot();
  } catch {
    return "Databázi se nepodařilo načíst (nedostupná, nebo FILES_DATABASE_URL chybí).";
  }
}

export default async function OperatorPage() {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    userId = null;
  }
  if (!isOperator(userId)) notFound();

  const data = await load();
  return (
    <div className="zd-ops">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="legal-head">
        <h1>Provoz Vlastních zdrojů</h1>
        <p className="muted">Pojistky bezplatných limitů, knihovny a fronta zpracování.</p>
      </header>
      {typeof data === "string" ? (
        <p className="zd-error">{data}</p>
      ) : (
        <Snapshot data={data} />
      )}
    </div>
  );
}

function Snapshot({ data }: { data: OperatorSnapshot }) {
  const g = data.guards;
  const aiShare = data.aiBudgetUsd > 0 ? data.aiSpentUsd / data.aiBudgetUsd : 0;
  return (
    <>
      <section className="zd-ops-section">
        <h2>Režim</h2>
        <p>
          Prostředí: <strong>{MODE_LABELS[data.env]}</strong> · přepsání: <strong>{data.override ? MODE_LABELS[data.override] : "automaticky"}</strong> ·
          platí: <strong>{MODE_LABELS[data.mode]}</strong>
        </p>
        {g.reasons.length > 0 ? <p className="zd-muted">Pojistky: {g.reasons.join("; ")}.</p> : null}
        <form action={setModeOverride} className="zd-ops-buttons">
          {(["auto", "on", "readonly", "off"] as const).map((m) => (
            <button key={m} type="submit" name="mode" value={m} className={`zd-btn ${(data.override ?? "auto") === m ? "zd-btn-primary" : "zd-btn-secondary"}`}>
              {m === "auto" ? "Automaticky" : MODE_LABELS[m]}
            </button>
          ))}
        </form>
        <p className="zd-muted zd-small">Přepsání může režim jen zpřísnit. Změna se projeví do 30 s.</p>
      </section>

      <section className="zd-ops-section">
        <h2>Pojistky a limity</h2>
        <ul className="zd-meters">
          <Meter label="Databáze" value={mb(g.dbBytes)} limit={mb(LIMITS.dbBytesCap)} share={g.dbShare} />
          <Meter label="Strany (uložené + rezervované)" value={formatCount(g.totalPages + g.reservedPages)} limit={formatCount(LIMITS.globalPages)} share={g.pagesShare} />
          <Meter label="Výpočetní hodiny (odhad, měsíc)" value={g.computeHours.toFixed(1).replace(".", ",")} limit={String(LIMITS.computeHoursPerMonth)} share={g.computeShare} />
          <Meter label="Rozpočet AI (30 dní)" value={`$${data.aiSpentUsd.toFixed(2)}`} limit={`$${data.aiBudgetUsd}`} share={aiShare} />
        </ul>
        <p className="zd-muted zd-small">
          Tento měsíc: {formatCount(data.uploadsThisMonth)} nahrání, {formatCount(data.pagesThisMonth)} stran · poslední běh cronu: {when(data.cronAt)}
        </p>
      </section>

      <section className="zd-ops-section">
        <h2>Přeindexování</h2>
        <p>
          Analyzátor v{data.analyzerVersion}: {formatCount(data.reindexBacklog)} dokumentů má index ze starší verze.
          {data.lastReindex
            ? ` Poslední dávka (${when(data.lastReindex.at)}): hotovo ${data.lastReindex.done}, přeskočeno ${data.lastReindex.skipped}, chyba ${data.lastReindex.failed}, zbývá ${data.lastReindex.remaining}.`
            : ""}
        </p>
        <form action={reindexBatchAction}>
          <button type="submit" className="zd-btn zd-btn-secondary" disabled={data.reindexBacklog === 0}>
            Přeindexovat dávku (≤ 200)
          </button>
        </form>
      </section>

      <section className="zd-ops-section">
        <h2>Zaseknuté a chybné dokumenty ({data.stuck.length})</h2>
        {data.stuck.length === 0 ? (
          <p className="zd-muted">Nic nevisí.</p>
        ) : (
          <div className="zd-table-wrap">
            <table className="zd-table">
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th>Knihovna</th>
                  <th>Stav</th>
                  <th>Pokusy</th>
                  <th>Změna</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.stuck.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.id.slice(0, 8)}</code>
                    </td>
                    <td>
                      <code>{d.library_id}</code>
                    </td>
                    <td>{d.status}</td>
                    <td>{d.attempts}</td>
                    <td>{when(d.updated_at)}</td>
                    <td>{d.status_detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="zd-ops-section">
        <h2>Knihovny ({data.libraries.length})</h2>
        <div className="zd-table-wrap">
          <table className="zd-table">
            <thead>
              <tr>
                <th>Knihovna</th>
                <th>Název</th>
                <th>Dokumenty</th>
                <th>Strany</th>
                <th>Rezervováno</th>
                <th>Pro odebráno</th>
                <th>Smazat po</th>
              </tr>
            </thead>
            <tbody>
              {data.libraries.map((l) => (
                <tr key={l.id}>
                  <td>
                    <code>{l.id}</code>
                  </td>
                  <td>{l.display_name ?? ""}</td>
                  <td>{formatCount(l.doc_count)}</td>
                  <td>{formatCount(l.page_count)}</td>
                  <td>{formatCount(l.pages_reserved)}</td>
                  <td>{when(l.pro_revoked_at)}</td>
                  <td>{when(l.purge_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
