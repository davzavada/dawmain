"use client";

import { useMemo, useState, useTransition } from "react";
import { dayBefore, formatDay, OPT_IN_FEATURES, type AdminFeature, type AdminUser } from "@/src/admin/model";
import { formatCount, initials } from "../_zdroje/format";
import { changeUserAction } from "./actions";

/**
 * The interactive part of the admin page: the account table on the left,
 * the selected account's switches and use on the right. The server renders
 * the list once; each switch calls changeUserAction and the account in the
 * list is replaced by what Clerk answered.
 */

export interface AdminRow {
  user: AdminUser;
  usage: { calls: number; calls7: number; lastDay: string; daily: number[]; tools: Array<{ tool: string; calls: number }> } | null;
}

type Filter = "all" | "admin" | "pro";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Všichni" },
  { id: "admin", label: "Správci" },
  { id: "pro", label: "Pro" },
];

const FEATURE_ROWS: Array<{ key: AdminFeature; title: string; hint: string }> = [
  { key: "files", title: "Vlastní soubory", hint: "Nahrávání a prohledávání vlastních dokumentů" },
  { key: "zotero", title: "Zotero", hint: "Připojení knihovny, čtení a ukládání" },
  { key: "ukaz", title: "Doktrína (UKAŽ)", hint: "Katalog literatury UK, zapíná se po potvrzení" },
  { key: "mirror", title: "Judikatura ze zrcadla", hint: "NS, NSS, ÚS a obecné soudy z domácího zrcadla místo živých databází soudů" },
];

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export function AdminConsole({
  rows: initial,
  me,
  today,
  windowDays,
  usageAvailable,
  noAccount,
}: {
  rows: AdminRow[];
  me: string;
  today: string;
  windowDays: number;
  usageAvailable: boolean;
  noAccount: { shared: number; anon: number };
}) {
  const [rows, setRows] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initial[0]?.user.id ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(({ user }) => {
      if (filter === "admin" && user.role !== "admin") return false;
      if (filter === "pro" && !user.pro) return false;
      return !q || `${user.name} ${user.email}`.toLowerCase().includes(q);
    });
  }, [rows, filter, query]);

  const current = rows.find((r) => r.user.id === selected) ?? null;
  const total = sum(rows.map((r) => r.usage?.calls ?? 0));
  const total7 = sum(rows.map((r) => r.usage?.calls7 ?? 0));
  const todayCalls = sum(rows.map((r) => r.usage?.daily[r.usage.daily.length - 1] ?? 0));
  const active7 = rows.filter((r) => (r.usage?.calls7 ?? 0) > 0).length;
  const admins = rows.filter((r) => r.user.role === "admin").length;
  const num = (n: number) => (usageAvailable ? formatCount(n) : "—");

  function change(user: AdminUser, change: Parameters<typeof changeUserAction>[1], done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await changeUserAction(user.id, change);
      if (result.ok) {
        setRows((all) => all.map((r) => (r.user.id === user.id ? { ...r, user: result.user } : r)));
        setMessage(done);
      } else {
        setMessage(result.error);
      }
    });
  }

  return (
    <>
      <section className="adm-summary" aria-label="Přehled">
        <Stat label="Účtů celkem" value={formatCount(rows.length)} note={`${admins} ${admins === 1 ? "správce" : admins >= 2 && admins <= 4 ? "správci" : "správců"}`} />
        <Stat label="Aktivní za 7 dní" value={num(active7)} note={`z ${formatCount(rows.length)} účtů`} />
        <Stat label={`Volání za ${windowDays} dní`} value={num(total)} note={usageAvailable ? `${formatCount(total7)} za posledních 7 dní` : "počítadla nejsou dostupná"} />
        <Stat label="Volání dnes" value={num(todayCalls)} note="všechny účty" />
      </section>

      <div className="adm-grid">
        <section className="adm-panel" aria-label="Uživatelé">
          <div className="adm-panel-head">
            <h2>
              Uživatelé <span className="adm-count">{visible.length}</span>
            </h2>
            <div className="adm-chips" role="group" aria-label="Filtr">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" className="adm-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input type="search" className="adm-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Hledat jméno nebo e-mail" aria-label="Hledat uživatele" />
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Účet</th>
                  <th>Role</th>
                  <th className="r">Volání {windowDays} dní</th>
                  <th>Trend</th>
                  <th>Poslední volání</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ user, usage }) => (
                  <tr
                    key={user.id}
                    tabIndex={0}
                    aria-selected={user.id === selected}
                    onClick={() => setSelected(user.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(user.id);
                      }
                    }}
                  >
                    <td>
                      <Who user={user} />
                    </td>
                    <td>
                      <span className={`adm-pill ${user.role}`}>{user.role === "admin" ? "Správce" : "Uživatel"}</span>
                      {user.pro ? <span className="adm-pill pro">Pro</span> : null}
                    </td>
                    <td className="r adm-mono">{usage ? formatCount(usage.calls) : usageAvailable ? "0" : "—"}</td>
                    <td>{usage ? <Spark data={usage.daily} /> : null}</td>
                    <td className="adm-dim">{usage ? formatDay(usage.lastDay) : "nikdy"}</td>
                  </tr>
                ))}
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="adm-empty">
                      Nikdo neodpovídá filtru.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {usageAvailable && (noAccount.shared > 0 || noAccount.anon > 0) ? (
            <p className="adm-note">
              Mimo účty za {windowDays} dní: {formatCount(noAccount.shared)} volání se sdíleným přístupovým kódem, {formatCount(noAccount.anon)} bez přihlášení.
            </p>
          ) : null}
        </section>

        <aside className="adm-panel adm-detail" aria-live="polite">
          {current ? (
            <Detail row={current} me={me} today={today} windowDays={windowDays} usageAvailable={usageAvailable} pending={pending} message={message} onChange={change} />
          ) : (
            <p className="adm-empty">Vyber účet v tabulce.</p>
          )}
        </aside>
      </div>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat-label">{label}</div>
      <div className="adm-stat-value">{value}</div>
      <div className="adm-stat-note">{note}</div>
    </div>
  );
}

function Who({ user, large = false }: { user: AdminUser; large?: boolean }) {
  return (
    <div className="adm-who">
      <span className={`zd-avatar${large ? " zd-avatar-lg" : ""}`} aria-hidden="true">
        {user.imageUrl ? <img className="zd-avatar-image" src={user.imageUrl} alt="" /> : initials(user.name)}
      </span>
      <div>
        <div className="adm-who-name">{user.name}</div>
        <div className="adm-who-mail">{user.email}</div>
      </div>
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  const w = 80;
  const h = 22;
  const max = Math.max(1, ...data);
  const step = w / Math.max(1, data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  const last = points[points.length - 1]?.split(",") ?? ["0", "0"];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="adm-spark">
      <polyline points={points.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

function Chart({ data, today }: { data: number[]; today: string }) {
  const W = 440;
  const H = 120;
  const left = 30;
  const bottom = 18;
  const top = Math.max(5, Math.ceil(Math.max(...data, 1) / 5) * 5);
  const bar = (W - left) / data.length;
  const y = (v: number) => H - bottom - (v / top) * (H - bottom - 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Volání za posledních ${data.length} dní`}>
      {[0, top / 2, top].map((t) => (
        <g key={t}>
          <line x1={left} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
            {Math.round(t * 10) / 10}
          </text>
        </g>
      ))}
      {data.map((v, i) => (
        <rect key={i} x={left + i * bar + 1} y={y(v)} width={bar - 2} height={Math.max(0, H - bottom - y(v))} rx="1.5" fill="var(--accent)" opacity={i === data.length - 1 ? 1 : 0.55}>
          <title>{`${formatDay(dayBefore(today, data.length - 1 - i))}: ${v} volání`}</title>
        </rect>
      ))}
      <text x={left} y={H - 4} fontSize="10" fill="var(--muted)">
        {formatDay(dayBefore(today, data.length - 1))}
      </text>
      <text x={W} y={H - 4} textAnchor="end" fontSize="10" fill="var(--muted)">
        {formatDay(today)}
      </text>
    </svg>
  );
}

function Switch({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="adm-switch" disabled={disabled} onClick={onToggle} />;
}

function Detail({
  row,
  me,
  today,
  windowDays,
  usageAvailable,
  pending,
  message,
  onChange,
}: {
  row: AdminRow;
  me: string;
  today: string;
  windowDays: number;
  usageAvailable: boolean;
  pending: boolean;
  message: string | null;
  onChange: (user: AdminUser, change: Parameters<typeof changeUserAction>[1], done: string) => void;
}) {
  const { user, usage } = row;
  const self = user.id === me;
  const roleLocked = (self && user.role === "admin") || user.envAdmin;
  const toolsMax = Math.max(1, ...(usage?.tools.map((t) => t.calls) ?? [1]));
  return (
    <>
      <div className="adm-sec adm-detail-head">
        <Who user={user} large />
        <div className="adm-meta">
          <span>Registrace {formatDay(user.createdAt)}</span>
          <span>Přihlášení {formatDay(user.lastSignInAt)}</span>
          {user.banned ? <span className="adm-pill off">Zablokovaný v Clerku</span> : null}
        </div>
      </div>

      <div className="adm-sec">
        <h3>Oprávnění</h3>
        <div className="adm-row">
          <div>
            <b>Správce</b>
            <span>{user.envAdmin ? "Správce z nastavení nasazení (Vercel)" : self && user.role === "admin" ? "Vlastní roli si tady odebrat nejde" : "Vidí Správu a spravuje účty"}</span>
          </div>
          <Switch
            label="Správce"
            on={user.role === "admin"}
            disabled={pending || roleLocked}
            onToggle={() => onChange(user, { kind: "role", admin: user.role !== "admin" }, user.role === "admin" ? "Role správce odebrána." : "Účet je nově správce.")}
          />
        </div>
        <div className="adm-row">
          <div>
            <b>Pro</b>
            <span>Základ pro Vlastní soubory a Zotero</span>
          </div>
          <Switch label="Pro" on={user.pro} disabled={pending} onToggle={() => onChange(user, { kind: "pro", on: !user.pro }, user.pro ? "Pro vypnuto." : "Pro zapnuto.")} />
        </div>
        {FEATURE_ROWS.map((f) => {
          const optIn = OPT_IN_FEATURES.includes(f.key);
          const needsPro = !optIn && !user.pro;
          const on = optIn ? user.features[f.key] : user.pro && user.features[f.key];
          return (
            <div className="adm-row" key={f.key}>
              <div>
                <b>{f.title}</b>
                <span>{needsPro ? "Nejdřív zapni Pro" : f.hint}</span>
              </div>
              <Switch
                label={f.title}
                on={on}
                disabled={pending || needsPro}
                onToggle={() => onChange(user, { kind: "feature", feature: f.key, on: !user.features[f.key] }, `${f.title}: ${user.features[f.key] ? "vypnuto" : "zapnuto"}.`)}
              />
            </div>
          );
        })}
        {message ? (
          <p className="adm-message" role="status">
            {message}
          </p>
        ) : null}
        <p className="adm-note">Změna se projeví do minuty.</p>
      </div>

      <div className="adm-sec">
        <h3>
          Využití <span>{usageAvailable ? `${formatCount(usage?.calls ?? 0)} volání za ${windowDays} dní` : "počítadla nejsou dostupná"}</span>
        </h3>
        {usage ? <Chart data={usage.daily} today={today} /> : <p className="adm-note">{usageAvailable ? "Zatím žádná volání." : "Počítá se jen tehdy, když jsou Vlastní zdroje zapnuté (zápis jde do jejich databáze)."}</p>}
      </div>

      <div className="adm-sec">
        <h3>Podle nástroje</h3>
        {usage && usage.tools.length > 0 ? (
          <div className="adm-tools">
            {usage.tools.map((t) => (
              <div className="adm-tool" key={t.tool}>
                <code>{t.tool}</code>
                <span className="adm-bar">
                  <i style={{ width: `${(t.calls / toolsMax) * 100}%` }} />
                </span>
                <span className="adm-tool-n">{formatCount(t.calls)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="adm-note">Zatím žádná volání.</p>
        )}
        <p className="adm-note">Jen počty volání, nikdy obsah dotazů.</p>
      </div>
    </>
  );
}
