"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { TeamView } from "@/src/files/web-types";
import { api } from "./api";
import { Confirm, Dialog } from "./dialog";
import { avatarColor, countMembers, formatDate, initials } from "./format";
import { ZIcon } from "./icons";
import { closeTeam, refreshSummary, useZdroje } from "./store";

/**
 * Team management for the admin of a Pro team (design 3d; full-screen on
 * phones, 3f): invite by e-mail, pending (and declined) invitations with
 * "Pozvat znovu" and ×, members with the "Správce" badge and "Odebrat"
 * (with a confirmation; never oneself or the last admin — the server
 * enforces both). Opened with ?tym=<org id> (or ?tym=1: the first team the
 * user administers).
 */
export function TeamModal({ orgParam }: { orgParam: string }) {
  const { summary } = useZdroje();
  const adminTeams = summary?.state === "ok" ? summary.libraries.filter((l) => l.kind === "org" && l.pro && l.role === "org:admin") : [];
  const orgId = adminTeams.find((t) => t.id === orgParam)?.id ?? adminTeams[0]?.id ?? null;
  const loading = summary === null;

  const [team, setTeam] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((r) => r + 1), []);

  useEffect(() => {
    if (!orgId) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await api<TeamView>(`/api/files/team?org=${encodeURIComponent(orgId)}`, { signal: ctrl.signal });
        if (res.ok) {
          setTeam(res.data);
          setError(null);
        } else setError(res.error);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [orgId, reload]);

  const subtitle = team ? `${team.name} · ${countMembers(team.members.length)}` : undefined;
  return (
    <Dialog
      title="Tým"
      subtitle={subtitle}
      size="narrow"
      onClose={closeTeam}
      footer={
        <button type="button" className="zd-btn zd-btn-primary zd-done" onClick={closeTeam}>
          Hotovo
        </button>
      }
    >
      <div className="zd-team">
        {!orgId ? (
          loading ? (
            <p className="zd-progress" role="status">
              <span className="zd-spinner" aria-hidden="true" />
              Načítám…
            </p>
          ) : (
            <p className="zd-muted">Tým může spravovat jen jeho správce.</p>
          )
        ) : error ? (
          <p className="zd-error" role="alert">
            {error}
          </p>
        ) : !team ? (
          <p className="zd-progress" role="status">
            <span className="zd-spinner" aria-hidden="true" />
            Načítám tým…
          </p>
        ) : (
          <>
            <InviteForm orgId={team.orgId} onInvited={refresh} />
            {team.invitations.length > 0 ? <Invitations team={team} onChanged={refresh} /> : null}
            <Members team={team} onChanged={refresh} />
          </>
        )}
      </div>
    </Dialog>
  );
}

function InviteForm({ orgId, onInvited }: { orgId: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inputId = useId();

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setMessage(null);
    const res = await api("/api/files/team/invitations", { method: "POST", json: { org: orgId, email: email.trim() } });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    setMessage({ ok: true, text: `Pozvánka odešla na ${email.trim()}.` });
    setEmail("");
    onInvited();
  }

  return (
    <form className="zd-invite-form" onSubmit={(e) => void invite(e)}>
      <label htmlFor={inputId} className="zd-section-name">
        Pozvat člena
      </label>
      <span className="zd-row">
        <input id={inputId} type="email" placeholder="jmeno@kancelar.cz" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} required />
        <button type="submit" className="zd-btn zd-btn-primary zd-btn-tall" disabled={busy}>
          {busy ? "Zvu…" : "Pozvat"}
        </button>
      </span>
      {message ? (
        <span className={message.ok ? "zd-ok-line" : "zd-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </span>
      ) : (
        <span className="zd-muted zd-small">Pozvaný dostane e-mail a po přihlášení i notifikaci v aplikaci.</span>
      )}
    </form>
  );
}

function Invitations({ team, onChanged }: { team: TeamView; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, what: "revoke" | "resend") {
    setBusy(id);
    setError(null);
    const res =
      what === "revoke"
        ? await api(`/api/files/team/invitations/${encodeURIComponent(id)}?org=${encodeURIComponent(team.orgId)}`, { method: "DELETE" })
        : await api(`/api/files/team/invitations/${encodeURIComponent(id)}/resend`, { method: "POST", json: { org: team.orgId } });
    setBusy(null);
    if (!res.ok) setError(res.error);
    onChanged();
  }

  return (
    <section className="zd-team-section" aria-label="Pozvánky">
      <div className="zd-section-head">
        <span className="zd-section-name">Pozvánky</span>
        <span className="zd-section-count">{team.invitations.length}</span>
      </div>
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="zd-people">
        {team.invitations.map((inv) => (
          <li key={inv.id} className="zd-person">
            <span className="zd-avatar zd-avatar-invite" aria-hidden="true">
              <ZIcon name="mail" size={14} />
            </span>
            <span className="zd-person-main">
              <span className="zd-person-name" title={inv.email}>
                {inv.email}
              </span>
              <span className="zd-doc-meta">
                <span className="zd-badge" data-tone={inv.state === "pending" ? "busy" : "bad"}>
                  {inv.state === "pending" ? "Čeká na přijetí" : "Odmítnuto"}
                </span>
                <span className="zd-doc-line">odesláno {formatDate(inv.sentAt)}</span>
              </span>
            </span>
            <span className="zd-doc-actions">
              {inv.state === "declined" ? (
                <button type="button" className="zd-btn zd-btn-quiet" disabled={busy === inv.id} onClick={() => void act(inv.id, "resend")}>
                  Pozvat znovu
                </button>
              ) : null}
              <button
                type="button"
                className="zd-icon-button"
                disabled={busy === inv.id}
                title={inv.state === "pending" ? "Zrušit pozvánku" : "Odebrat ze seznamu"}
                aria-label={inv.state === "pending" ? `Zrušit pozvánku pro ${inv.email}` : `Odebrat ${inv.email} ze seznamu`}
                onClick={() => void act(inv.id, "revoke")}
              >
                <ZIcon name="close" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Members({ team, onChanged }: { team: TeamView; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admins = team.members.filter((m) => m.admin).length;

  async function remove(userId: string) {
    setBusy(true);
    setError(null);
    const res = await api(`/api/files/team/members/${encodeURIComponent(userId)}?org=${encodeURIComponent(team.orgId)}`, { method: "DELETE" });
    setBusy(false);
    setConfirming(null);
    if (!res.ok) setError(res.error);
    onChanged();
    void refreshSummary();
  }

  return (
    <section className="zd-team-section" aria-label="Členové">
      <div className="zd-section-head">
        <span className="zd-section-name">Členové</span>
        <span className="zd-section-count">{team.members.length}</span>
      </div>
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="zd-people">
        {team.members.map((m) => {
          const removable = !m.self && !(m.admin && admins <= 1);
          return (
            <li key={m.userId} className="zd-person">
              <span className="zd-avatar" style={{ background: avatarColor(m.userId) }} aria-hidden="true">
                {initials(m.name)}
              </span>
              <span className="zd-person-main">
                <span className="zd-person-title">
                  <span className="zd-person-name">{m.name}</span>
                  {m.admin ? <span className="zd-badge">Správce</span> : null}
                </span>
                <span className="zd-doc-line">
                  {m.email}
                  {m.since ? ` · od ${formatDate(m.since)}` : ""}
                </span>
                {confirming === m.userId ? (
                  <Confirm
                    question={<>Odebrat {m.name} z týmu? Přijde o přístup k týmovým zdrojům; co do týmu nahrál(a), zůstane.</>}
                    confirmLabel="Odebrat"
                    busy={busy}
                    onConfirm={() => void remove(m.userId)}
                    onCancel={() => setConfirming(null)}
                  />
                ) : null}
              </span>
              {removable ? (
                <span className="zd-doc-actions">
                  <button type="button" className="zd-btn zd-btn-quiet" onClick={() => setConfirming(m.userId)} disabled={busy}>
                    Odebrat
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
