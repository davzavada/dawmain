import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LIMITS } from "@/src/files/config";
import { NEON_STORAGE_BYTES } from "@/src/files/guards";
import { isOperator, operatorSnapshot, vacuumPlan, type OperatorSnapshot } from "@/src/files/operator";
import { batchAllowance } from "@/src/files/reindex";
import { formatCount } from "@/app/_zdroje/format";
import { reindexBatchAction, setModeOverride, takedownAction } from "./actions";

export const dynamic = "force-dynamic";
// "Přeindexovat dávku" runs up to 200 documents in one Server Function call.
export const maxDuration = 300;

export const metadata: Metadata = { title: "Provoz · Vlastní zdroje", robots: { index: false, follow: false } };

/**
 * The operator page: the free-tier guards against their limits, the
 * libraries, documents stuck in the pipeline, the mode override, the
 * batch re-derivation and notice-and-takedown. Operators only (FILES_OPERATOR_IDS) — anyone else,
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

/** CPU milliseconds as minutes, one decimal ("3,4 min"). */
function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1).replace(".", ",")} min`;
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

/** Free space inside the files worth a VACUUM FULL: a fifth of the cap. */
const VACUUM_HINT_SHARE = 0.2;

function Snapshot({ data }: { data: OperatorSnapshot }) {
  const g = data.guards;
  const aiShare = data.aiBudgetUsd > 0 ? data.aiSpentUsd / data.aiBudgetUsd : 0;
  const reindex = batchAllowance(data.mode, g.dbShare);
  const reclaimable = g.dbBytes - g.liveBytes;
  const vacuum = reclaimable >= LIMITS.dbBytesCap * VACUUM_HINT_SHARE ? vacuumPlan(data.tables, g.dbBytes, NEON_STORAGE_BYTES) : null;
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
          <Meter label="Databáze (živá data, odhad)" value={mb(g.liveBytes)} limit={mb(LIMITS.dbBytesCap)} share={g.dbShare} />
          <Meter label="Strany (uložené + rezervované)" value={formatCount(g.totalPages + g.reservedPages)} limit={formatCount(LIMITS.globalPages)} share={g.pagesShare} />
          <Meter label="Výpočetní hodiny (odhad, měsíc)" value={g.computeHours.toFixed(1).replace(".", ",")} limit={String(LIMITS.computeHoursPerMonth)} share={g.computeShare} />
          <Meter label="Rozpočet AI (30 dní)" value={`$${data.aiSpentUsd.toFixed(2)}`} limit={`$${data.aiBudgetUsd}`} share={aiShare} />
          <Meter label="CPU zpracování (dnes)" value={minutes(data.cpuMsToday)} limit={minutes(LIMITS.globalCpuMsPerDay)} share={data.cpuMsToday / LIMITS.globalCpuMsPerDay} />
          <Meter label="CPU zpracování (30 dní)" value={minutes(data.cpuMs30Days)} limit={minutes(LIMITS.globalCpuMs30Days)} share={data.cpuMs30Days / LIMITS.globalCpuMs30Days} />
        </ul>
        <p className="zd-muted zd-small">
          Tento měsíc: {formatCount(data.uploadsThisMonth)} nahrání, {formatCount(data.pagesThisMonth)} stran · poslední běh cronu: {when(data.cronAt)}
        </p>
        <p className="zd-muted zd-small">
          Soubory databáze fyzicky zabírají {mb(g.dbBytes)}; živá data odhadem {mb(g.liveBytes)}. Místo po smazaných dokumentech
          Postgres použije pro nová data, soubory se ale samy nezmenší.
          {vacuum
            ? ` Uvolnit ${mb(reclaimable)} jde jen příkazem VACUUM FULL pod vlastnickou rolí, v klidném okně (tabulka je po dobu běhu zamčená).
              Příkaz nejdřív zapíše novou kopii tabulky i s indexy a starou smaže až na konci, takže potřebuje volné místo pod limitem
              Neonu 0,5 GB zhruba ve velikosti živých dat tabulky. Spouštějte ho po jedné tabulce, v tomto pořadí:`
            : ""}
        </p>
        {vacuum && vacuum.steps.length > 0 ? (
          <ol className="zd-muted zd-small">
            {vacuum.steps.map((step) => (
              <li key={step.table}>
                <code>VACUUM FULL {step.table};</code> uvolní asi {mb(step.reclaimBytes)}, za běhu potřebuje asi {mb(step.needBytes)} volného místa
              </li>
            ))}
          </ol>
        ) : null}
        {vacuum && vacuum.blocked.length > 0 ? (
          <p className="zd-muted zd-small">
            Pro VACUUM FULL tabulek {vacuum.blocked.map((step) => `${step.table} (asi ${mb(step.needBytes)})`).join(", ")} teď místo
            nezbývá ani po předchozích krocích. Nejdřív z nich smažte dokumenty, aby se jejich živá data zmenšila.
          </p>
        ) : null}
        <p className="zd-muted zd-small">
          Když pojistky vypnou Vlastní zdroje kvůli výpočetním hodinám, každá instance si to pamatuje do konce měsíce. Databázi
          úplně přestane budit až FILES_MODE=off a nové nasazení.
        </p>
      </section>

      <section className="zd-ops-section">
        <h2>Přeindexování</h2>
        <p>
          Analyzátor v{data.analyzerVersion}: {formatCount(data.reindexBacklog)} dokumentů má index ze starší verze.
          {data.lastReindex
            ? ` Poslední dávka (${when(data.lastReindex.at)}): hotovo ${data.lastReindex.done}, přeskočeno ${data.lastReindex.skipped}, chyba ${data.lastReindex.failed}, zbývá ${data.lastReindex.remaining}.`
            : ""}
          {data.lastReindex?.limited ? ` ${data.lastReindex.limited}` : ""}
        </p>
        {reindex.reason ? <p className="zd-muted zd-small">{reindex.reason}</p> : null}
        <form action={reindexBatchAction}>
          <button type="submit" className="zd-btn zd-btn-secondary" disabled={data.reindexBacklog === 0 || reindex.max === 0}>
            Přeindexovat dávku (≤ {reindex.max || 200})
          </button>
        </form>
      </section>

      <section className="zd-ops-section">
        <h2>Oznámení a odstranění obsahu</h2>
        <p>
          Zablokuje otisk obsahu (SHA-256 převedeného textu) proti dalšímu nahrání a smaže všechny jeho kopie ve všech knihovnách,
          včetně vrácení stran do kvót. Blokace platí jen pro přesně stejný text: jiný převod téhož díla má jiný otisk.
        </p>
        {data.lastTakedown ? (
          <p className="zd-muted zd-small">
            Poslední zásah ({when(data.lastTakedown.at)}): otisk <code>{data.lastTakedown.sha256.slice(0, 12)}…</code>, smazáno{" "}
            {formatCount(data.lastTakedown.documents)} dokumentů v {formatCount(data.lastTakedown.libraries)} knihovnách.
          </p>
        ) : null}
        <form action={takedownAction} className="zd-form-grid" style={{ maxWidth: 720 }}>
          <label className="zd-field">
            <span>Dokument (id) nebo otisk obsahu</span>
            <input type="text" name="target" required pattern="[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{64}" autoComplete="off" spellCheck={false} />
          </label>
          <label className="zd-field">
            <span>Důvod (číslo oznámení)</span>
            <input type="text" name="reason" required maxLength={500} autoComplete="off" />
          </label>
          <label className="zd-check">
            <input type="checkbox" name="confirm" value="yes" required />
            <span>Rozumím, že se kopie smažou nevratně.</span>
          </label>
          <div>
            <button type="submit" className="zd-btn zd-btn-secondary">
              Zablokovat a smazat kopie
            </button>
          </div>
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
