"use client";

import { useState, type FormEvent } from "react";
import type { TeamPanel, TeamPanelMember } from "@/src/admin/team-manage";
import type { TeamRole } from "@/src/admin/teams-model";
import { Confirm, Dialog } from "../_zdroje/dialog";
import { initials } from "../_zdroje/format";
import { ZIcon } from "../_zdroje/icons";
import { teamManageAction } from "./team-actions";

const ROLE_LABEL: Record<TeamRole, string> = { "org:admin": "Správce", "org:member": "Člen" };

/**
 * "Spravovat tým": a pop-up over the team's files page for its manager (or
 * a site admin): members with their role, adding one by e-mail, removing
 * one; a site admin also renames the team here. Every change goes through
 * teamManageAction, which checks the rights again on the server.
 */
export function TeamDialog({
  teamId,
  name,
  panel: initial,
  onClose,
  onChanged,
}: {
  teamId: string;
  name: string;
  panel: TeamPanel;
  onClose: () => void;
  /** After a change: the page refreshes the summary (name, sidebar). */
  onChanged: (panel: TeamPanel) => void;
}) {
  const [panel, setPanel] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState(name);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("org:member");
  const [removing, setRemoving] = useState<TeamPanelMember | null>(null);

  async function run(change: Parameters<typeof teamManageAction>[1]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await teamManageAction(teamId, change);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setPanel(result.panel);
      onChanged(result.panel);
      return true;
    } catch {
      setError("Změnu se nepodařilo uložit. Zkuste to znovu.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run({ kind: "addByEmail", email, role })) setEmail("");
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    const clean = teamName.replace(/\s+/g, " ").trim();
    if (!clean || clean === name) return;
    await run({ kind: "rename", name: clean });
  }

  return (
    <Dialog title="Spravovat tým" subtitle={name} onClose={onClose} size="medium">
      <div className="tm">
        {error ? (
          <p className="zd-error" role="alert">
            {error}
          </p>
        ) : null}

        {panel.canRename ? (
          <form className="tm-row-form" onSubmit={(e) => void rename(e)}>
            <label className="tm-label" htmlFor="tm-name">
              Název týmu
            </label>
            <div className="tm-inline">
              <input id="tm-name" className="tm-input" value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={60} disabled={busy} />
              <button type="submit" className="zd-btn zd-btn-secondary" disabled={busy || teamName.replace(/\s+/g, " ").trim() === name}>
                Přejmenovat
              </button>
            </div>
          </form>
        ) : null}

        <h3 className="tm-label">Členové</h3>
        <ul className="tm-members">
          {panel.members.map((m) => {
            const self = m.userId === panel.me;
            const locked = self && !panel.canRename;
            return (
              <li key={m.userId} className="tm-member">
                {m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Clerk-hosted avatar
                  <img className="tm-avatar" src={m.imageUrl} alt="" width={28} height={28} />
                ) : (
                  <span className="tm-avatar" aria-hidden="true">
                    {initials(m.name)}
                  </span>
                )}
                <span className="tm-who">
                  <b>
                    {m.name}
                    {self ? " (vy)" : ""}
                  </b>
                  {m.email && m.email !== m.name ? <span>{m.email}</span> : null}
                </span>
                <select
                  className="tm-select"
                  value={m.role}
                  aria-label={`Role: ${m.name}`}
                  disabled={busy || locked}
                  onChange={(e) => void run({ kind: "setRole", userId: m.userId, role: e.target.value as TeamRole })}
                >
                  {(Object.keys(ROLE_LABEL) as TeamRole[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="zd-icon-button"
                  aria-label={`Odebrat z týmu: ${m.name}`}
                  title="Odebrat z týmu"
                  disabled={busy || locked}
                  onClick={() => setRemoving(m)}
                >
                  <ZIcon name="trash" size={15} />
                </button>
              </li>
            );
          })}
        </ul>

        {removing ? (
          <Confirm
            question={<>Odebrat {removing.name} z týmu? Jeho nahrané soubory v týmu zůstanou.</>}
            confirmLabel="Odebrat"
            busy={busy}
            onConfirm={() => void run({ kind: "removeMember", userId: removing.userId }).then(() => setRemoving(null))}
            onCancel={() => setRemoving(null)}
          />
        ) : null}

        <form className="tm-row-form" onSubmit={(e) => void add(e)}>
          <label className="tm-label" htmlFor="tm-email">
            Přidat člena
          </label>
          <div className="tm-inline">
            <input
              id="tm-email"
              className="tm-input"
              type="email"
              placeholder="e-mail účtu v Dawmainu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
            <select className="tm-select" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} aria-label="Role nového člena" disabled={busy}>
              {(Object.keys(ROLE_LABEL) as TeamRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button type="submit" className="zd-btn zd-btn-primary" disabled={busy || email.trim() === ""}>
              Přidat
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
