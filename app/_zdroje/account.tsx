"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { countMembers, initials } from "./format";
import { ZIcon } from "./icons";
import { InvitationActions, InvitationText, useInvitations } from "./invitations";
import { manageAccount, openSources, openTeam, openZotero, rememberInitials, requestSignIn, signOut, useHintInitials, useZdroje } from "./store";

/**
 * The account control at the right end of the header (design 1a, 2a, 3a,
 * 3c, 2f, 3e). Signed out: a small "Přihlásit se" text button. Signed in:
 * the avatar with initials (a crown badge with Pro, a blue dot when a
 * team invitation waits),
 * opening a menu — name and e-mail, pending invitations with Přijmout /
 * Odmítnout, Vlastní zdroje, Zotero (only where the deployment has it
 * configured — `zotero`), Tým · N členů (admins of a Pro team),
 * Spravovat účet, Odhlásit se. A menu button in the WAI-ARIA sense: arrow
 * keys move between items, Escape and a click outside close it. Nothing
 * at all on a deployment without Clerk.
 */
export function AccountControl({ zotero = false }: { zotero?: boolean }) {
  const { auth } = useZdroje();
  if (auth === "none") return null;
  // Still loading without a sign-in hint: most likely a visitor — show what they will see (nothing jumps).
  if (auth === "signed_out" || auth === "loading") {
    return (
      <button type="button" className="zd-signin" onClick={requestSignIn}>
        Přihlásit se
      </button>
    );
  }
  return <AccountMenu zotero={zotero} />;
}

function AccountMenu({ zotero }: { zotero: boolean }) {
  const { user } = useUser();
  const { summary } = useZdroje();
  const invites = useInvitations();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const hinted = useHintInitials();
  const name = user?.fullName?.trim() || user?.username || user?.primaryEmailAddress?.emailAddress || "Účet";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  // Before Clerk's user loads, the initials remembered from the last visit (no jump from "Ú" to "DZ").
  const shown = user ? initials(name) : (hinted ?? initials(name));
  const pending = invites.invitations.length > 0;
  const pro = summary?.state === "ok" && summary.libraries.some((l) => l.pro);

  useEffect(() => {
    if (user) rememberInitials(initials(name));
  }, [user, name]);
  const adminTeams = summary?.state === "ok" ? summary.libraries.filter((l) => l.kind === "org" && l.pro && l.role === "org:admin") : [];

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    // Focus the first item for keyboard users.
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"], .zd-invite-actions button') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function choose(action: () => void) {
    return () => {
      setOpen(false);
      action();
    };
  }

  return (
    <span className="zd-account" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="zd-avatar zd-avatar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Účet${pro ? " (Pro)" : ""}${pending ? " — máte pozvánku do týmu" : ""}`}
        title={pro ? "Účet · Pro" : "Účet"}
        onClick={() => setOpen((o) => !o)}
      >
        {shown}
        {pro ? (
          <span className="zd-pro-badge" aria-hidden="true">
            <ZIcon name="crown" size={10} />
          </span>
        ) : null}
        {pending ? <span className="zd-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div ref={menu} id={menuId} className="zd-menu" role="menu" aria-label="Účet" onKeyDown={onMenuKey}>
          <div className="zd-menu-user">
            <span className="zd-avatar zd-avatar-lg" aria-hidden="true">
              {shown}
              {pro ? (
                <span className="zd-pro-badge" aria-hidden="true">
                  <ZIcon name="crown" size={11} />
                </span>
              ) : null}
            </span>
            <span className="zd-menu-who">
              <strong>
                {name}
                {pro ? <span className="zd-pro-tag">Pro</span> : null}
              </strong>
              {email ? <span>{email}</span> : null}
            </span>
          </div>
          {invites.invitations.map((invitation) => (
            <div key={invitation.id} className="zd-menu-invite">
              <span className="zd-invite-icon" aria-hidden="true">
                <ZIcon name="users" />
              </span>
              <span className="zd-menu-invite-body">
                <strong>Pozvánka do týmu</strong>
                <span>
                  <InvitationText invitation={invitation} suffix="Získáte přístup k týmovým zdrojům." />
                </span>
                <InvitationActions invitation={invitation} api={invites} />
              </span>
            </div>
          ))}
          <div className="zd-menu-items">
            <button type="button" role="menuitem" className="zd-menu-item" onClick={choose(() => openSources("moje"))}>
              <ZIcon name="upload" />
              <span>Vlastní zdroje</span>
            </button>
            {zotero ? (
              <button type="button" role="menuitem" className="zd-menu-item" onClick={choose(openZotero)}>
                <ZIcon name="library" />
                <span>Zotero</span>
              </button>
            ) : null}
            {adminTeams.map((team) => (
              <button key={team.id} type="button" role="menuitem" className="zd-menu-item" onClick={choose(() => openTeam(team.id))}>
                <ZIcon name="users" />
                <span>{adminTeams.length > 1 ? `Tým ${team.name}` : "Tým"}</span>
                {team.memberCount !== null ? <span className="zd-menu-note">{countMembers(team.memberCount)}</span> : null}
              </button>
            ))}
            <button type="button" role="menuitem" className="zd-menu-item" onClick={choose(manageAccount)}>
              <ZIcon name="settings" />
              <span>Spravovat účet</span>
            </button>
          </div>
          <div className="zd-menu-items zd-menu-last">
            <button type="button" role="menuitem" className="zd-menu-item" onClick={choose(signOut)}>
              <ZIcon name="logout" />
              <span>Odhlásit se</span>
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
