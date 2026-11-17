"use client";

import { useState, useTransition } from "react";
import { formatCount } from "@/app/_zdroje/format";
import { MAX_QUOTA_PAGES, validQuotaPages, type AdminFeature } from "@/src/admin/model";
import { isLastAdmin, TEAM_NAME_MAX, type AdminTeam, type TeamChange, type TeamRole } from "@/src/admin/teams";
import type { TeamResult } from "@/src/admin/teams-server";
import { changeTeamAction, createTeamAction, deleteTeamAction, renameTeamAction, setTeamMemberAction } from "./actions";

/**
 * The Týmy page: the list of teams on the left, the chosen one on the
 * right — its switches (the team's own Pro and features, as on an
 * account), the shared library's quota, the members with their roles, and
 * deleting the team. Each change is one Server Function call; the answer
 * replaces the team shown.
 */

export interface TeamCandidate {
  id: string;
  name: string;
  email: string;
  banned: boolean;
}

const FEATURE_ROWS: Array<{ key: AdminFeature; title: string; hint: string }> = [
  { key: "files", title: "Sdílená knihovna", hint: "Vlastní soubory týmu: členové nahrávají a asistent v nich hledá všem" },
  { key: "zotero", title: "Zotero", hint: "Každý člen si může připojit svou knihovnu Zotero" },
  { key: "ukaz", title: "Doktrína (UKAŽ)", hint: "Členové hledají v katalogu UKAŽ" },
];

export function TeamsConsole({ teams: initial, people, defaultQuotaPages }: { teams: AdminTeam[]; people: TeamCandidate[]; defaultQuotaPages: number }) {
  // Whom a team can take: every account that is not blocked.
  const candidates = people.filter((p) => !p.banned);
  const [teams, setTeams] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const team = teams.find((t) => t.id === selected) ?? null;

  /** Run one change; on success put the answered team in place (null: it was deleted). */
  function apply(teamId: string | null, work: () => Promise<TeamResult>) {
    setMessage(null);
    start(async () => {
      const result = await work();
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      const next = result.team;
      if (next) {
        setTeams((list) => (list.some((t) => t.id === next.id) ? list.map((t) => (t.id === next.id ? next : t)) : [...list, next]));
        setSelected(next.id);
      } else if (teamId) {
        setTeams((list) => list.filter((t) => t.id !== teamId));
        setSelected(null);
      }
    });
  }

  return (
    <div className="adm-grid">
      <section className="adm-panel">
        <div className="adm-panel-head">
          <h2>
            Týmy <span className="adm-count">{teams.length}</span>
          </h2>
        </div>
        {teams.length === 0 ? <p className="adm-empty">Zatím žádný tým. Založ první níže.</p> : null}
        <div className="adm-table-wrap">
          <table className="adm-table">
            <tbody>
              {teams.map((t) => (
                <tr key={t.id} tabIndex={0} aria-selected={t.id === selected} onClick={() => setSelected(t.id)} onKeyDown={(e) => (e.key === "Enter" ? setSelected(t.id) : undefined)}>
                  <td>
                    <span className="adm-who-name">{t.name}</span>
                  </td>
                  <td className="adm-dim">{t.members.length} {t.members.length === 1 ? "člen" : t.members.length < 5 && t.members.length > 0 ? "členové" : "členů"}</td>
                  <td className="r">{t.pro ? <span className="adm-pill pro">Zapnutý</span> : <span className="adm-pill off">Vypnutý</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <NewTeam candidates={candidates} pending={pending} onCreate={(name, adminId) => apply(null, () => createTeamAction(name, adminId))} />
      </section>

      <section className="adm-panel adm-detail">
        {team ? (
          <TeamDetail
            key={team.id}
            team={team}
            candidates={candidates}
            people={people}
            defaultQuotaPages={defaultQuotaPages}
            pending={pending}
            message={message}
            onChange={(change) => apply(team.id, () => changeTeamAction(team.id, change))}
            onRename={(name) => apply(team.id, () => renameTeamAction(team.id, name))}
            onMember={(userId, role) => apply(team.id, () => setTeamMemberAction(team.id, userId, role))}
            onDelete={() => apply(team.id, () => deleteTeamAction(team.id))}
          />
        ) : (
          <p className="adm-empty">{message ?? "Vyber tým, nebo založ nový."}</p>
        )}
      </section>
    </div>
  );
}

function UserSelect({ candidates, value, onChange, label, disabled }: { candidates: TeamCandidate[]; value: string; onChange: (id: string) => void; label: string; disabled?: boolean }) {
  return (
    <select className="adm-select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {candidates.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.email && c.email !== c.name ? ` (${c.email})` : ""}
        </option>
      ))}
    </select>
  );
}

function NewTeam({ candidates, pending, onCreate }: { candidates: TeamCandidate[]; pending: boolean; onCreate: (name: string, adminId: string) => void }) {
  const [name, setName] = useState("");
  const [adminId, setAdminId] = useState("");
  const ready = name.trim().length >= 2 && adminId !== "";
  return (
    <form
      className="adm-sec adm-team-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onCreate(name, adminId);
        setName("");
        setAdminId("");
      }}
    >
      <h3>Nový tým</h3>
      <input className="adm-input" value={name} maxLength={TEAM_NAME_MAX} placeholder="Název týmu" aria-label="Název týmu" disabled={pending} onChange={(e) => setName(e.target.value)} />
      <UserSelect candidates={candidates} value={adminId} onChange={setAdminId} label="Správce týmu…" disabled={pending} />
      <button type="submit" className="zd-btn zd-btn-primary" disabled={pending || !ready}>
        Založit tým
      </button>
    </form>
  );
}

function Switch({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="adm-switch" disabled={disabled} onClick={onToggle} />;
}

function TeamDetail({
  team,
  candidates,
  people,
  defaultQuotaPages,
  pending,
  message,
  onChange,
  onRename,
  onMember,
  onDelete,
}: {
  team: AdminTeam;
  candidates: TeamCandidate[];
  people: TeamCandidate[];
  defaultQuotaPages: number;
  pending: boolean;
  message: string | null;
  onChange: (change: TeamChange) => void;
  onRename: (name: string) => void;
  onMember: (userId: string, role: TeamRole | null) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(team.name);
  const [newMember, setNewMember] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const outside = candidates.filter((c) => !team.members.some((m) => m.userId === c.id));
  const renamed = name.trim().length >= 2 && name.trim() !== team.name;

  return (
    <>
      <form
        className="adm-sec"
        onSubmit={(e) => {
          e.preventDefault();
          if (renamed) onRename(name);
        }}
      >
        <h3>Tým</h3>
        <div className="adm-quota-form">
          <input className="adm-input" value={name} maxLength={TEAM_NAME_MAX} aria-label="Název týmu" disabled={pending} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="zd-btn" disabled={pending || !renamed}>
            Přejmenovat
          </button>
        </div>
      </form>

      <div className="adm-sec">
        <h3>Funkce týmu</h3>
        <div className="adm-row">
          <div>
            <b>Zapnutý</b>
            <span>Členové mají funkce týmu, i když sami Pro nemají</span>
          </div>
          <Switch label="Zapnutý" on={team.pro} disabled={pending} onToggle={() => onChange({ kind: "pro", on: !team.pro })} />
        </div>
        {FEATURE_ROWS.map((f) => (
          <div className="adm-row adm-row-sub" key={f.key}>
            <div>
              <b>{f.title}</b>
              <span>{team.pro ? f.hint : "Nejdřív tým zapni"}</span>
            </div>
            <Switch
              label={f.title}
              on={team.pro && team.features[f.key]}
              disabled={pending || !team.pro}
              onToggle={() => onChange({ kind: "feature", feature: f.key, on: !team.features[f.key] })}
            />
          </div>
        ))}
        {team.pro && team.features.files ? (
          <TeamQuota key={`${team.id}:${team.quotaPages ?? "default"}`} team={team} defaultPages={defaultQuotaPages} pending={pending} onChange={onChange} />
        ) : null}
        {message ? (
          <p className="zd-error" role="alert">
            {message}
          </p>
        ) : null}
      </div>

      <div className="adm-sec">
        <h3>
          Členové <span>{team.members.length}</span>
        </h3>
        {team.members.map((m) => {
          const last = isLastAdmin(team, m.userId);
          // An account deleted since (its membership goes with the next webhook or cron) has no name any more.
          const who = people.find((p) => p.id === m.userId);
          const name = who?.name ?? "Smazaný účet";
          return (
            <div className="adm-row" key={m.userId}>
              <div>
                <b>{name}</b>
                <span>{who?.email ?? m.userId}</span>
              </div>
              <span className="adm-member-tools">
                <select
                  className="adm-select"
                  aria-label={`Role: ${name}`}
                  value={m.role}
                  disabled={pending || last}
                  title={last ? "Jediný správce týmu" : undefined}
                  onChange={(e) => onMember(m.userId, e.target.value as TeamRole)}
                >
                  <option value="admin">Správce</option>
                  <option value="member">Člen</option>
                </select>
                <button type="button" className="zd-btn" disabled={pending || last} title={last ? "Jediný správce týmu" : undefined} onClick={() => onMember(m.userId, null)}>
                  Odebrat
                </button>
              </span>
            </div>
          );
        })}
        <form
          className="adm-quota-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newMember) return;
            onMember(newMember, "member");
            setNewMember("");
          }}
        >
          <UserSelect candidates={outside} value={newMember} onChange={setNewMember} label="Přidat člena…" disabled={pending} />
          <button type="submit" className="zd-btn" disabled={pending || !newMember}>
            Přidat
          </button>
        </form>
        <p className="adm-note">Přidat jde účet, který se už na webu registroval.</p>
      </div>

      <div className="adm-sec">
        <h3>Zrušení týmu</h3>
        {confirmDelete ? (
          <div className="adm-quota-form">
            <span className="adm-note">Tým zanikne hned, jeho knihovna se smaže do týdne. Nejde to vrátit.</span>
            <button type="button" className="zd-btn zd-btn-danger" disabled={pending} onClick={onDelete}>
              Opravdu zrušit
            </button>
            <button type="button" className="zd-btn" disabled={pending} onClick={() => setConfirmDelete(false)}>
              Ne
            </button>
          </div>
        ) : (
          <button type="button" className="zd-btn" disabled={pending} onClick={() => setConfirmDelete(true)}>
            Zrušit tým…
          </button>
        )}
      </div>
    </>
  );
}

/** The shared library's page quota: the team's own number, or the installation's default for teams. */
function TeamQuota({ team, defaultPages, pending, onChange }: { team: AdminTeam; defaultPages: number; pending: boolean; onChange: (change: TeamChange) => void }) {
  const current = team.quotaPages ?? defaultPages;
  const [text, setText] = useState(String(current));
  const pages = /^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  const valid = validQuotaPages(pages);
  const changed = valid && pages !== current;
  return (
    <div className="adm-row adm-row-sub adm-quota">
      <div>
        <b>Kvóta stran</b>
        <span>
          {team.quotaPages === null ? `Výchozí: ${formatCount(defaultPages)} normostran` : `Vlastní kvóta (výchozí je ${formatCount(defaultPages)})`}
          {text.trim() !== "" && !valid ? ` · zadej celé číslo 1 až ${formatCount(MAX_QUOTA_PAGES)}` : ""}
        </span>
      </div>
      <form
        className="adm-quota-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) onChange({ kind: "quota", pages });
        }}
      >
        <input className="adm-quota-input" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Kvóta stran týmu ${team.name}`} aria-invalid={text.trim() !== "" && !valid} disabled={pending} />
        <button type="submit" className="zd-btn" disabled={pending || !changed}>
          Uložit
        </button>
        {team.quotaPages !== null ? (
          <button type="button" className="zd-btn" disabled={pending} onClick={() => onChange({ kind: "quota", pages: null })}>
            Výchozí
          </button>
        ) : null}
      </form>
    </div>
  );
}
