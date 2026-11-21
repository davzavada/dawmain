import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/src/admin/server";
import { UPSTREAM_DAYS, systemSnapshot, type SystemSnapshot, type UpstreamRow } from "@/src/admin/system";
import { loadDailyLimit, type LoadedDailyLimit } from "@/src/admin/daily-limit";
import { DEFAULT_DAILY_CALL_LIMIT } from "@/src/mcp/daily-limit";
import { formatCount, plural } from "../../_zdroje/format";
import { AdminTabs } from "../_tabs";
import { DailyLimitField } from "./limit-field";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Systém · Správa · Dawmain", robots: { index: false, follow: false } };

/**
 * The Systém tab of the admin area: how long this web process has been up,
 * what it runs on, how big the databases are, what the case-law mirror holds
 * and when the regular jobs last ran (src/admin/system.ts). Read on every
 * visit. The one thing set here is the daily limit of tool calls per
 * account (src/mcp/daily-limit.ts) — a figure only admins ever see. Admins
 * only — anyone else gets the same 404 as a page that does not exist.
 */

const COURTS: Array<{ id: string; label: string }> = [
  { id: "ns", label: "Nejvyšší soud" },
  { id: "nss", label: "Nejvyšší správní soud" },
  { id: "us", label: "Ústavní soud" },
  { id: "justice", label: "Obecné soudy" },
];

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
  return `${formatCount(Math.round(n / 1024 ** 2))} MB`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("cs-CZ", { timeZone: "Europe/Prague", dateStyle: "medium", timeStyle: "short" });
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("cs-CZ", { timeZone: "Europe/Prague" });
}

/** "12 dní 4 h", "3 h 12 min", "8 min". */
function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} ${plural(d, "den", "dny", "dní")} ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export default async function AdminSystemPage() {
  const me = await requireAdmin();
  if (!me) notFound();
  const [data, limit] = await Promise.all([systemSnapshot(), loadDailyLimit()]);

  return (
    <div className="adm">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="adm-head">
        <h1>Správa</h1>
        <p className="muted">Stav serveru, databází a pravidelných úloh.</p>
      </header>
      <AdminTabs active="system" />
      <System data={data} />
      <Limits limit={limit} />
    </div>
  );
}

function System({ data }: { data: SystemSnapshot }) {
  const { server, disk, files, mirror } = data;
  const mirrorBytes = typeof mirror.status?.databaseBytes === "number" ? mirror.status.databaseBytes : null;
  const sources = mirror.status?.sources ?? [];
  const decisions = COURTS.reduce((n, c) => n + (sources.find((s) => s.source === c.id)?.decisions ?? 0), 0);
  const total = (mirrorBytes ?? 0) + (files?.dbBytes ?? 0);
  const biggest = Math.max(1, mirrorBytes ?? 0, files?.dbBytes ?? 0);
  const lastMirrorRun = sources
    .map((s) => s.lastRun?.finishedAt ?? null)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  const mirrorErrors = sources.filter((s) => s.lastRun?.error);

  return (
    <>
      <section className="adm-summary adm-summary-3" aria-label="Přehled">
        <Stat label="Online" value={duration(server.uptimeSec)} note={`od ${when(server.startedAt)}`} dot />
        <Stat
          label="Databáze celkem"
          value={mirrorBytes !== null || files ? bytes(total) : "—"}
          note={mirrorBytes !== null && files ? "zrcadlo judikatury a Vlastní soubory" : mirrorBytes !== null ? "zrcadlo judikatury" : files ? "Vlastní soubory" : "nedostupné"}
        />
        <Stat label="Volné místo na disku" value={disk ? bytes(disk.freeBytes) : "—"} note={disk ? `z ${bytes(disk.totalBytes)}` : "nezjištěno"} />
      </section>

      <div className="adm-grid adm-grid-even">
        <section className="adm-panel" aria-label="Server">
          <div className="adm-panel-head">
            <h2>Server</h2>
          </div>
          <dl className="adm-kv">
            <dt>Stav</dt>
            <dd>
              <span className="adm-state" data-state="ok">
                Běží
              </span>
            </dd>
            <dt>Běží od</dt>
            <dd>
              {when(server.startedAt)} ({duration(server.uptimeSec)})
            </dd>
            <dt>Nasazená verze</dt>
            <dd>{server.commit ? <code>{server.commit}</code> : "—"}</dd>
            <dt>Prostředí</dt>
            <dd>
              {server.environment}
              {server.region ? ` · ${server.region}` : ""}
            </dd>
            <dt>Hostitel</dt>
            <dd>{server.hostname}</dd>
            <dt>Node.js</dt>
            <dd>
              <code>{server.node}</code>
            </dd>
            <dt>Paměť procesu</dt>
            <dd>
              {bytes(server.rssBytes)} z {bytes(server.totalMemBytes)}
            </dd>
            <dt>Zátěž CPU</dt>
            <dd>
              {server.load15.toFixed(2).replace(".", ",")} (průměr 15 min, {server.cpus} {plural(server.cpus, "jádro", "jádra", "jader")})
            </dd>
          </dl>
        </section>

        <section className="adm-panel" aria-label="Databáze">
          <div className="adm-panel-head">
            <h2>Databáze</h2>
          </div>
          <div className="adm-dbs">
            <DbRow
              name="Zrcadlo judikatury"
              size={mirrorBytes}
              share={(mirrorBytes ?? 0) / biggest}
              note={mirror.problem ?? `NS, NSS, ÚS a obecné soudy · ${formatCount(decisions)} rozhodnutí`}
            />
            <DbRow
              name="Vlastní soubory"
              size={files?.dbBytes ?? null}
              share={(files?.dbBytes ?? 0) / biggest}
              note={
                files
                  ? `${formatCount(files.libraries)} ${plural(files.libraries, "knihovna", "knihovny", "knihoven")} · ${formatCount(files.documents)} dokumentů · ${formatCount(files.pages)} stran · i texty webu`
                  : "Databáze není dostupná (nebo není nastavená)."
              }
            />
          </div>
        </section>
      </div>

      <section className="adm-panel" aria-label="Zrcadlo judikatury">
        <div className="adm-panel-head">
          <h2>Zrcadlo judikatury</h2>
          {mirror.status ? <span className="adm-count">stav k {when(mirror.status.asOf)}</span> : null}
        </div>
        {mirror.problem ? (
          <p className="adm-empty">{mirror.problem}</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table adm-table-static">
              <thead>
                <tr>
                  <th>Soud</th>
                  <th className="r">Rozhodnutí</th>
                  <th>Nejnovější rozhodnutí</th>
                  <th>Poslední aktualizace</th>
                </tr>
              </thead>
              <tbody>
                {COURTS.map((c) => {
                  const s = sources.find((x) => x.source === c.id);
                  return (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td className="r adm-mono">{s ? formatCount(s.decisions ?? 0) : "—"}</td>
                      <td className="adm-dim">{day(s?.newestDecidedOn)}</td>
                      <td className="adm-dim">
                        {when(s?.lastRun?.finishedAt)}
                        {s?.lastRun?.error ? <span className="zd-error"> · {s.lastRun.error}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Upstream rows={data.upstream} />

      <section className="adm-panel" aria-label="Pravidelné úlohy">
        <div className="adm-panel-head">
          <h2>Pravidelné úlohy</h2>
        </div>
        <div className="adm-table-wrap">
          <table className="adm-table adm-table-static">
            <thead>
              <tr>
                <th>Úloha</th>
                <th>Stav</th>
                <th>Poslední běh</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Web</td>
                <td>
                  <span className="adm-state" data-state="ok">
                    běží
                  </span>
                </td>
                <td className="adm-dim">—</td>
              </tr>
              <tr>
                <td>Cron (pojistky, úklid, kontrola zdrojů)</td>
                <td>
                  <span className="adm-state" data-state={files?.cronAt ? "ok" : "idle"}>
                    {files?.cronAt ? "v pořádku" : "nezjištěno"}
                  </span>
                </td>
                <td className="adm-dim">{when(files?.cronAt)}</td>
              </tr>
              <tr>
                <td>Aktualizace zrcadla judikatury</td>
                <td>
                  <span className="adm-state" data-state={mirrorErrors.length ? "down" : lastMirrorRun ? "ok" : "idle"}>
                    {mirrorErrors.length ? `chyba (${mirrorErrors.length})` : lastMirrorRun ? "v pořádku" : "nezjištěno"}
                  </span>
                </td>
                <td className="adm-dim">{when(lastMirrorRun)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ms(n: number | null): string {
  if (n === null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",")} s` : `${formatCount(n)} ms`;
}

/** How the live sources answered: the numbers to tune the per-source limits (src/sources/shared/limits.ts) by. */
function Upstream({ rows }: { rows: UpstreamRow[] | null }) {
  return (
    <section className="adm-panel" aria-label="Živé zdroje">
      <div className="adm-panel-head">
        <h2>Živé zdroje</h2>
        <span className="adm-count">posledních {UPSTREAM_DAYS} dní</span>
      </div>
      {rows === null ? (
        <p className="adm-empty">Databáze Vlastních souborů není dostupná, statistiky se nedají načíst.</p>
      ) : rows.length === 0 ? (
        <p className="adm-empty">Zatím žádné dotazy na živé zdroje (zapisuje se jednou za minutu).</p>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table adm-table-static">
            <thead>
              <tr>
                <th>Zdroj</th>
                <th className="r" title="Kolik dotazů na zdroj smí být otevřených najednou">Limit</th>
                <th className="r" title="Nejvíc dotazů otevřených najednou">Max. souběžně</th>
                <th className="r">Dotazů</th>
                <th className="r" title="Zdroj nás odmítl: HTTP 429 (příliš mnoho dotazů) a 403 (zakázáno)">429 / 403</th>
                <th className="r" title="HTTP 5xx, vypršený čas, chyba spojení">5xx · čas · síť</th>
                <th className="r" title="Průměrná odezva; 95 % dotazů doběhlo pod hranici">Průměr / p95</th>
                <th className="r" title="Dotazy, které čekaly na volný slot, a průměrné čekání">Ve frontě</th>
                <th className="r" title="Fronta se nepohnula 20 s, dotaz jsme vůbec neposlali">Odmítnuto námi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const refused = r.http429 + r.http403;
                return (
                  <tr key={r.source}>
                    <td>
                      {r.source}
                      {r.lastRefusalDay ? <span className="zd-error"> · naposledy odmítl {day(r.lastRefusalDay)}</span> : null}
                    </td>
                    <td className="r adm-mono">{r.limit ?? "—"}</td>
                    <td className="r adm-mono">{formatCount(r.maxInflight)}</td>
                    <td className="r adm-mono">{formatCount(r.requests)}</td>
                    <td className={`r adm-mono${refused ? " zd-error" : ""}`}>
                      {formatCount(r.http429)} / {formatCount(r.http403)}
                    </td>
                    <td className="r adm-mono">
                      {formatCount(r.http5xx)} · {formatCount(r.timeouts)} · {formatCount(r.network)}
                    </td>
                    <td className="r adm-mono">
                      {ms(r.avgMs)} / {r.p95UnderMs === null ? (r.requests ? "> 10 s" : "—") : `< ${ms(r.p95UnderMs)}`}
                    </td>
                    <td className="r adm-mono">
                      {formatCount(r.queued)}
                      {r.queued ? <span className="adm-dim"> · {ms(r.avgQueueMs)}</span> : null}
                    </td>
                    <td className={`r adm-mono${r.busy ? " zd-error" : ""}`}>{formatCount(r.busy)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
        Jen počty ze skutečného provozu, žádné dotazy navíc. Limity zatím nejsou nastavené, jen se měří: „Max. souběžně“ ukazuje, kolik dotazů
        zdroj dostal najednou, a 429 / 403, jestli se někdy bránil. Limit by se nastavil v kódu (<code>src/sources/shared/limits.ts</code>).
      </p>
    </section>
  );
}

function Limits({ limit }: { limit: LoadedDailyLimit }) {
  return (
    <section className="adm-panel" aria-label="Omezení">
      <div className="adm-panel-head">
        <h2>Omezení</h2>
      </div>
      <DailyLimitField own={limit.own} defaultLimit={DEFAULT_DAILY_CALL_LIMIT} available={limit.available} />
      <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
        Nejvyšší počet volání nástrojů, který jeden účet za den provede (den se počítá v UTC, všechny nástroje dohromady kromě dawmain_ping a
        dawmain_guide). Sdíleného přístupového kódu se limit netýká. Uživatelům se číslo nikde neukazuje; po vyčerpání dostanou jen odmítnutí do
        dalšího dne.
      </p>
    </section>
  );
}

function Stat({ label, value, note, dot = false }: { label: string; value: string; note: string; dot?: boolean }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat-label">
        {dot ? <span className="adm-dot" aria-hidden="true" /> : null}
        {label}
      </div>
      <div className="adm-stat-value">{value}</div>
      <div className="adm-stat-note">{note}</div>
    </div>
  );
}

function DbRow({ name, size, share, note }: { name: string; size: number | null; share: number; note: string }) {
  return (
    <div className="adm-db">
      <b>{name}</b>
      <span className="adm-db-size">{size === null ? "—" : bytes(size)}</span>
      <span className="adm-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(1, Math.min(100, share * 100))}%` }} />
      </span>
      <span className="adm-db-note">{note}</span>
    </div>
  );
}
