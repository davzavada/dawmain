"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { Icon } from "@/app/_icons";
import type { LibrarySummary } from "@/src/files/web-types";
import { countDocuments, enabledOf, libraryBadge } from "./format";
import { ZIcon } from "./icons";
import { openSources, requestSignIn, useZdroje } from "./store";

/**
 * The Vlastní zdroje entries outside the modal: the "Vlastní zdroje N ·
 * Spravovat" group on the home page (design 2a, 3c; locked for visitors,
 * 1a) and the nav item (sidebar and tab strip). Both read the shared
 * summary (./store.ts), so the page itself stays server-rendered and never
 * waits for it.
 */

/** The stable entry point: /vlastni-zdroje redirects to /?zdroje=moje. */
export const OWN_SOURCES_HREF = "/vlastni-zdroje";
export const OWN_SOURCES_TITLE = "Vlastní zdroje — v režimu Pro, přiděluji zdarma";

/** Documents in the Pro libraries the user can use. */
function totalDocuments(libraries: LibrarySummary[]): number {
  return libraries.filter((l) => l.pro).reduce((n, l) => n + (l.counts?.total ?? 0), 0);
}

/**
 * Open the modal instead of navigating — or sign-in for a visitor. Without
 * Clerk (or before it loaded) the link simply navigates.
 */
function intercept(auth: string, tab: "moje" | "tym" = "moje") {
  return (event: MouseEvent) => {
    if (auth !== "signed_in" && auth !== "signed_out") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (auth === "signed_out") requestSignIn();
    else openSources(tab);
  };
}

/** The nav item: sidebar (`variant="sidebar"`) or tab strip; current while the modal is open too (design 2b). */
export function OwnSourcesNavItem({ variant, current }: { variant: "sidebar" | "tab"; current: boolean }) {
  const { auth, summary, sourcesOpen } = useZdroje();
  const aria = current || sourcesOpen ? { "aria-current": "location" as const } : {};
  const className = variant === "sidebar" ? "nav-item" : "tab-item";
  const signedIn = auth === "signed_in";
  const count = signedIn && summary?.state === "ok" ? totalDocuments(summary.libraries) : null;
  // Visitors see the locked invitation of design 1a; so does the server
  // render and the moment before Clerk loads (most visitors are signed out,
  // and nothing jumps when they are).
  const locked = !signedIn;

  return (
    <Link href={OWN_SOURCES_HREF} className={locked ? `${className} zd-nav-locked` : className} title={OWN_SOURCES_TITLE} onClick={intercept(auth)} {...aria}>
      {variant === "sidebar" ? <Icon name="upload" /> : null}
      {/* Design 1a / 1b: the sidebar invites to upload, the narrow tab strip just names it. */}
      <span className={variant === "sidebar" ? "nav-ellipsis" : undefined}>{locked && variant === "sidebar" ? "Nahrát vlastní zdroje" : "Vlastní zdroje"}</span>
      {locked ? (
        <ZIcon name="lock" size={13} className="zd-nav-lock" />
      ) : count !== null && variant === "sidebar" ? (
        <span className="nav-count">{count}</span>
      ) : null}
    </Link>
  );
}

/** The home page group (design 2a / 3c; 1a when signed out). */
export function OwnSourcesGroup() {
  const { auth, summary } = useZdroje();
  const ok = auth === "signed_in" && summary?.state === "ok" ? summary : null;

  if (!ok) {
    const clickable = auth === "signed_out";
    return (
      <div className="source-group locked zd-own">
        <div className="source-group-head">
          <span className="source-group-name">Vlastní zdroje</span>
          <ZIcon name="lock" size={13} className="zd-group-lock" />
          {auth === "signed_in" && summary?.state === "unavailable" ? <span className="source-group-count">teď vypnuté</span> : null}
        </div>
        <ul>
          <li className="source">
            <Icon name="upload" />
            <div className="source-name">
              {clickable ? (
                <button type="button" className="source-title zd-row-button" onClick={requestSignIn}>
                  Nahrát vlastní zdroje
                </button>
              ) : (
                <span className="source-title">Nahrát vlastní zdroje</span>
              )}
              <span className="source-desc">Vlastní dokumenty, ve kterých bude asistent hledat vedle oficiálních databází.</span>
            </div>
          </li>
        </ul>
      </div>
    );
  }

  const personal = ok.libraries.find((l) => l.kind === "user") ?? null;
  const teams = ok.libraries.filter((l) => l.kind === "org" && l.pro);
  return (
    <div className="source-group zd-own">
      <div className="source-group-head">
        <span className="source-group-name">Vlastní zdroje</span>
        <span className="source-group-count">{totalDocuments(ok.libraries)}</span>
        <a href={`${OWN_SOURCES_HREF}`} className="zd-manage" onClick={intercept(auth)}>
          Spravovat
        </a>
      </div>
      <ul>
        {personal ? <LibraryRow lib={personal} tab="moje" title="Moje zdroje" icon="file" /> : null}
        {teams.length > 0 ? (
          teams.map((t) => <LibraryRow key={t.id} lib={t} tab="tym" title="Týmové zdroje" icon="users" />)
        ) : (
          <li className="source zd-row-locked" title="Jen pro členy týmu">
            <ZIcon name="users" />
            <div className="source-name">
              <button type="button" className="source-title zd-row-button" onClick={() => openSources("tym")}>
                Týmové zdroje <ZIcon name="lock" size={13} />
              </button>
              <span className="source-desc">Sdílené dokumenty kanceláře. Jen pro členy týmu.</span>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

function LibraryRow({ lib, tab, title, icon }: { lib: LibrarySummary; tab: "moje" | "tym"; title: string; icon: "file" | "users" }) {
  const badge = libraryBadge(lib.counts);
  const sub = !lib.pro
    ? "Režim Pro přiděluji ručně a zdarma."
    : lib.kind === "org"
      ? `${lib.name} · ${countDocuments(lib.counts?.total ?? 0)}`
      : lib.counts && lib.counts.total > 0
        ? enabledOf(lib.counts.searchable, lib.counts.total)
        : "Zatím žádné dokumenty";
  return (
    <li className={lib.pro ? "source" : "source zd-row-locked"}>
      <ZIcon name={icon} />
      <div className="source-name">
        <button type="button" className="source-title zd-row-button" onClick={() => openSources(tab)}>
          {title}
          {!lib.pro ? <ZIcon name="lock" size={13} /> : null}
        </button>
        {/* The team's name may be long: that one line is cut; descriptions wrap (design 1b). */}
        <span className={lib.pro && lib.kind === "org" ? "source-desc zd-desc-line" : "source-desc"}>{sub}</span>
      </div>
      {badge ? (
        <div className="source-state">
          <span className="zd-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
        </div>
      ) : null}
    </li>
  );
}
