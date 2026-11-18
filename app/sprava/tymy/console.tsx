"use client";

import { useMemo, useState, useTransition } from "react";
import { formatDay } from "@/src/admin/model";
import { cleanTeamName, MAX_TEAM_QUOTA_PAGES, membersLabel, validTeamQuota, type AdminTeam, type TeamChange, type TeamRole } from "@/src/admin/teams-model";
import { formatCount, initials } from "../../_zdroje/format";
import { changeTeamAction } from "./actions";

/**
 * The interactive part of the Týmy tab: the team table on the left, the
 * selected team on the right — the "click into a team" view: whether it is
 * active, its quota and library use, and its members with their roles.
 * Each change calls changeTeamAction and the team is replaced by what Clerk
 * answered.
 */

export interface TeamPerson {
  id: string;
  name: string;
  email: string;
  imageUrl: string | null;
  pro: boolean;
}

const ROLE_LABEL: Record<TeamRole, string> = { "org:admin": "Správce týmu", "org:member": "Člen" };

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export function TeamsConsole({
  teams: initial,
  people,
  statsAvailable,
  defaultQuotaPages,
}: {
  teams: AdminTeam[];
  people: TeamPerson[];
  statsAvailable: boolean;
  /** LIMITS.teamPages: the quota of a team without its own. */
  defaultQuotaPages: number;
}) {
  const [teams, setTeams] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [pending, startTransition] = useTransition();
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => {
      if (t.name.toLowerCase().includes(q)) return true;
      return t.members.some((m) => {
        const p = byId.get(m.userId);
        return p ? `${p.name} ${p.email}`.toLowerCase().includes(q) : false;
      });
    });
  }, [teams, query, byId]);

  const current = teams.find((t) => t.id === selected) ?? null;
  const memberIds = new Set(teams.flatMap((t) => t.members.map((m) => m.userId)));
  const num = (n: number) => (statsAvailable ? formatCount(n) : "—");

  function run(teamId: string | null, change: TeamChange, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await changeTeamAction(teamId, change);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (result.team === null) {
        setTeams((all) => all.filter((t) => t.id !== result.deletedId));
        setSelected((s) => (s === result.deletedId ? null : s));
      } else {
        const team = result.team;
        setTeams((all) => {
          const rest = all.filter((t) => t.id !== team.id);
          return [...rest, team].sort((a, b) => a.name.localeCompare(b.name, "cs") || a.id.localeCompare(b.id));
        });
        setSelected(team.id);
      }
      after?.();
    });
  }

  const nameOk = cleanTeamName(newName) !== null;

  return (
    <>
      <section className="adm-summary" aria-label="Přehled">
        <Stat label="Týmů" value={formatCount(teams.length)} note={`${teams.filter((t) => t.active).length} aktivních`} />
        <Stat label="Lidí v týmech" value={formatCount(memberIds.size)} note={`z ${formatCount(people.length)} účtů`} />
        <Stat label="Sdílených dokumentů" value={num(sum(teams.map((t) => t.library?.documents ?? 0)))} note="ve všech týmech" />
        <Stat label="Sdílených stran" value={num(sum(teams.map((t) => t.library?.pages ?? 0)))} note={statsAvailable ? "normostran" : "počítadla nejsou dostupná"} />
      </section>

      <div className="adm-grid">
        <section className="adm-panel" aria-label="Týmy">
          <div className="adm-panel-head">
            <h2>
              Týmy <span className="adm-count">{visible.length}</span>
            </h2>
            <input type="search" className="adm-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Hledat tým nebo člena" aria-label="Hledat tým" />
          </div>
          <form
            className="adm-team-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) run(null, { kind: "create", name: newName }, () => setNewName(""));
            }}
          >
            <input className="adm-quota-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Název nového týmu" aria-label="Název nového týmu" maxLength={60} disabled={pending} />
            <button type="submit" className="zd-btn zd-btn-primary" disabled={pending || !nameOk}>
              Založit tým
            </button>
          </form>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Tým</th>
                  <th>Stav</th>
                  <th className="r">Členů</th>
                  <th className="r">Dokumentů</th>
                  <th className="r">Stran</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((team) => (
                  <tr
                    key={team.id}
                    tabIndex={0}
                    aria-selected={team.id === selected}
                    onClick={() => setSelected(team.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(team.id);
                      }
                    }}
                  >
                    <td>
                      <div className="adm-who">
                        <span className="zd-avatar adm-team-avatar" aria-hidden="true">
                          {initials(team.name)}
                        </span>
                        <div>
                          <div className="adm-who-name">{team.name}</div>
                          <div className="adm-who-mail">{memberPreview(team, byId)}</div>
                        </div>
                      </div>
                    </td>
                    <td>{team.active ? <span className="adm-pill pro">Aktivní</span> : <span className="adm-pill off">Vypnutý</span>}</td>
                    <td className="r adm-mono">{team.members.length}</td>
                    <td className="r adm-mono">{team.library ? formatCount(team.library.documents) : "—"}</td>
                    <td className="r adm-mono">{team.library ? formatCount(team.library.pages) : "—"}</td>
                  </tr>
                ))}
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="adm-empty">
                      {teams.length === 0 ? "Zatím tu není žádný tým. Založ první nahoře." : "Nic neodpovídá hledání."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="adm-panel adm-detail" aria-live="polite">
          {current ? (
            <TeamDetail
              key={current.id}
              team={current}
              people={people}
              byId={byId}
              defaultQuotaPages={defaultQuotaPages}
              pending={pending}
              message={message}
              onChange={(change) => run(current.id, change)}
            />
          ) : (
            <>
              <p className="adm-empty">Vyber tým v tabulce.</p>
              {message ? (
                <p className="zd-error" role="alert">
                  {message}
                </p>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function memberPreview(team: AdminTeam, byId: Map<string, TeamPerson>): string {
  if (team.members.length === 0) return "bez členů";
  const names = team.members.slice(0, 3).map((m) => byId.get(m.userId)?.name ?? "neznámý účet");
  return names.join(", ") + (team.members.length > 3 ? ` a ${team.members.length - 3} další` : "");
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

function Switch({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="adm-switch" disabled={disabled} onClick={onToggle} />;
}

function Person({ person, fallbackId }: { person: TeamPerson | undefined; fallbackId: string }) {
  const name = person?.name ?? "Neznámý účet";
  return (
    <div className="adm-who">
      <span className="zd-avatar" aria-hidden="true">
        {person?.imageUrl ? <img className="zd-avatar-image" src={person.imageUrl} alt="" /> : initials(name)}
      </span>
      <div>
        <div className="adm-who-name">{name}</div>
        <div className="adm-who-mail">{person?.email ?? fallbackId}</div>
      </div>
    </div>
  );
}

function TeamDetail({
  team,
  people,
  byId,
  defaultQuotaPages,
  pending,
  message,
  onChange,
}: {
  team: AdminTeam;
  people: TeamPerson[];
  byId: Map<string, TeamPerson>;
  defaultQuotaPages: number;
  pending: boolean;
  message: string | null;
  onChange: (change: TeamChange) => void;
}) {
  const [name, setName] = useState(team.name);
  const [quota, setQuota] = useState(String(team.quotaPages ?? defaultQuotaPages));
  const [candidate, setCandidate] = useState("");
  const [role, setRole] = useState<TeamRole>("org:member");
  const [find, setFind] = useState("");

  const cleanName = cleanTeamName(name);
  const quotaPages = /^\d{1,7}$/.test(quota.trim()) ? Number(quota.trim()) : NaN;
  const quotaValid = validTeamQuota(quotaPages);
  const currentQuota = team.quotaPages ?? defaultQuotaPages;
  const inTeam = new Set(team.members.map((m) => m.userId));
  const q = find.trim().toLowerCase();
  const candidates = people.filter((p) => !inTeam.has(p.id) && (!q || `${p.name} ${p.email}`.toLowerCase().includes(q))).slice(0, 50);
  const managers = team.members.filter((m) => m.role === "org:admin").length;
  const used = team.library?.pages ?? 0;
  const share = currentQuota > 0 ? Math.min(100, Math.round((used / currentQuota) * 100)) : 0;

  return (
    <>
      <div className="adm-sec adm-detail-head">
        <div className="adm-who">
          <span className="zd-avatar zd-avatar-lg adm-team-avatar" aria-hidden="true">
            {initials(team.name)}
          </span>
          <div>
            <div className="adm-who-name">{team.name}</div>
            <div className="adm-who-mail">
              {membersLabel(team.members.length)} · {managers === 0 ? "bez správce týmu" : `${managers} ${managers === 1 ? "správce" : "správci"} týmu`}
            </div>
          </div>
        </div>
        <div className="adm-meta">
          <span>Založen {formatDay(team.createdAt)}</span>
          {team.library?.purgeAfter ? <span className="adm-pill off">Smazání souborů {formatDay(team.library.purgeAfter)}</span> : null}
        </div>
      </div>

      <div className="adm-sec">
        <h3>Nastavení</h3>
        <form
          className="adm-row adm-quota"
          onSubmit={(e) => {
            e.preventDefault();
            if (cleanName && cleanName !== team.name) onChange({ kind: "rename", name: cleanName });
          }}
        >
          <div>
            <b>Název</b>
            <span>{cleanName ? "Vidí ho členové a asistent" : "2 až 60 znaků, písmena, číslice a běžná interpunkce"}</span>
          </div>
          <div className="adm-quota-form adm-team-name-form">
            <input className="adm-quota-input adm-team-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Název týmu" aria-invalid={!cleanName} maxLength={60} disabled={pending} />
            <button type="submit" className="zd-btn" disabled={pending || !cleanName || cleanName === team.name}>
              Uložit
            </button>
          </div>
        </form>
        <div className="adm-row">
          <div>
            <b>Aktivní</b>
            <span>{team.active ? "Členové hledají ve sdílených souborech a nahrávají do nich" : "Soubory jdou jen vypsat, stáhnout a smazat; do týdne se smažou"}</span>
          </div>
          <Switch
            label="Tým aktivní"
            on={team.active}
            disabled={pending}
            onToggle={() => {
              if (team.active && !window.confirm(`Vypnout tým „${team.name}“? Asistent v jeho souborech přestane hledat a nezapnete-li ho znovu, sdílené soubory se do týdne smažou.`)) return;
              onChange({ kind: "active", on: !team.active });
            }}
          />
        </div>
        <form
          className="adm-row adm-row-sub adm-quota"
          onSubmit={(e) => {
            e.preventDefault();
            if (quotaValid && quotaPages !== currentQuota) onChange({ kind: "quota", pages: quotaPages });
          }}
        >
          <div>
            <b>Kvóta stran</b>
            <span>
              {team.quotaPages === null ? `Výchozí: ${formatCount(defaultQuotaPages)} normostran` : `Vlastní kvóta (výchozí je ${formatCount(defaultQuotaPages)})`}
              {quota.trim() !== "" && !quotaValid ? ` · zadej celé číslo 1 až ${formatCount(MAX_TEAM_QUOTA_PAGES)}` : ""}
            </span>
          </div>
          <div className="adm-quota-form">
            <input className="adm-quota-input" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} aria-label="Kvóta stran týmu" aria-invalid={!quotaValid} disabled={pending} />
            <button type="submit" className="zd-btn" disabled={pending || !quotaValid || quotaPages === currentQuota}>
              Uložit
            </button>
            {team.quotaPages !== null ? (
              <button type="button" className="zd-btn" disabled={pending} onClick={() => onChange({ kind: "quota", pages: null })}>
                Výchozí
              </button>
            ) : null}
          </div>
        </form>
      </div>

      <div className="adm-sec">
        <h3>
          Sdílené soubory <span>{team.library ? `${formatCount(team.library.documents)} dokumentů` : "počítadla nejsou dostupná"}</span>
        </h3>
        {team.library ? (
          <>
            <div className="adm-bar" aria-hidden="true">
              <i style={{ width: `${share}%` }} />
            </div>
            <p className="adm-note">
              {formatCount(used)} z {formatCount(currentQuota)} normostran ({share} %)
            </p>
          </>
        ) : (
          <p className="adm-note">Počítá se jen tehdy, když jsou Vlastní soubory zapnuté.</p>
        )}
      </div>

      <div className="adm-sec">
        <h3>
          Členové <span>{membersLabel(team.members.length)}</span>
        </h3>
        {team.members.length === 0 ? <p className="adm-note">Tým zatím nemá žádné členy.</p> : null}
        <ul className="adm-members">
          {team.members.map((m) => {
            const person = byId.get(m.userId);
            return (
              <li key={m.userId} className="adm-member">
                <Person person={person} fallbackId={m.userId} />
                <div className="adm-member-actions">
                  <select
                    className="adm-select"
                    value={m.role}
                    disabled={pending}
                    aria-label={`Role: ${person?.name ?? m.userId}`}
                    onChange={(e) => onChange({ kind: "setRole", userId: m.userId, role: e.target.value as TeamRole })}
                  >
                    <option value="org:member">{ROLE_LABEL["org:member"]}</option>
                    <option value="org:admin">{ROLE_LABEL["org:admin"]}</option>
                  </select>
                  <button
                    type="button"
                    className="zd-btn"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Odebrat ${person?.name ?? "tento účet"} z týmu ${team.name}? Soubory, které do týmu nahrál, v týmu zůstanou.`)) {
                        onChange({ kind: "removeMember", userId: m.userId });
                      }
                    }}
                  >
                    Odebrat
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <form
          className="adm-member-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (candidate) {
              onChange({ kind: "addMember", userId: candidate, role });
              setCandidate("");
              setFind("");
            }
          }}
        >
          <input type="search" className="adm-search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Najít účet" aria-label="Najít účet k přidání" disabled={pending} />
          <select className="adm-select" value={candidate} onChange={(e) => setCandidate(e.target.value)} aria-label="Účet k přidání" disabled={pending}>
            <option value="">{candidates.length ? "Vyber účet…" : "Nikdo další"}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.email && p.email !== p.name ? ` · ${p.email}` : ""}
              </option>
            ))}
          </select>
          <select className="adm-select" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} aria-label="Role nového člena" disabled={pending}>
            <option value="org:member">{ROLE_LABEL["org:member"]}</option>
            <option value="org:admin">{ROLE_LABEL["org:admin"]}</option>
          </select>
          <button type="submit" className="zd-btn zd-btn-primary" disabled={pending || !candidate}>
            Přidat
          </button>
        </form>
        <p className="adm-note">Člen nahrává do týmu a spravuje své soubory; správce týmu spravuje všechny. Změna se projeví do minuty.</p>
      </div>

      {message ? (
        <p className="zd-error" role="alert">
          {message}
        </p>
      ) : null}

      <div className="adm-sec">
        <h3>Smazání</h3>
        <div className="adm-row">
          <div>
            <b>Smazat tým</b>
            <span>Členové o přístup přijdou hned, sdílené soubory se smažou do týdne</span>
          </div>
          <button
            type="button"
            className="zd-btn zd-btn-danger"
            disabled={pending}
            onClick={() => {
              const typed = window.prompt(`Tým „${team.name}“ se smaže. Pro potvrzení napiš jeho název:`);
              if (typed !== null && typed.trim() === team.name) onChange({ kind: "delete" });
            }}
          >
            Smazat
          </button>
        </div>
      </div>
    </>
  );
}
