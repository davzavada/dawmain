"use client";

import type { MouseEvent } from "react";
import { Icon } from "@/app/_icons";
import type { LibrarySummary } from "@/src/files/web-types";
import { countDocuments, countPages } from "./format";
import { ZIcon } from "./icons";
import { openFiles, openZotero, requestSignIn, useZdroje } from "./store";
import { useZoteroStatus } from "./zotero-status";

/**
 * The "Vlastní zdroje" group at the top of the home page's source list
 * (wireframe 01, 02): two rows — Zotero (only where the deployment can
 * connect it) and Vlastní soubory. Visitors see both greyed out with a
 * lock and a click signs them in (01); signed in, Zotero shows the
 * connected account and Vlastní soubory the documents and pages, with
 * "Spravovat" opening the modal (02). The rows read the shared summary
 * (./store.ts) and the Zotero status, so the page itself stays
 * server-rendered and never waits for them.
 */

/** The stable entry point: /vlastni-zdroje redirects to /?soubory=1. */
export const OWN_FILES_HREF = "/vlastni-zdroje";

/** Open the modal instead of navigating — or sign-in for a visitor. Without Clerk (or before it loaded) the link navigates. */
function intercept(auth: string) {
  return (event: MouseEvent) => {
    if (auth !== "signed_in" && auth !== "signed_out") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (auth === "signed_out") requestSignIn();
    else openFiles();
  };
}

export function OwnSourcesGroup({ zotero }: { zotero: boolean }) {
  const { auth, summary } = useZdroje();
  const signedIn = auth === "signed_in";
  const ok = signedIn && summary?.state === "ok" ? summary : null;
  const personal = ok?.libraries.find((l) => l.kind === "user") ?? null;
  const locked = !signedIn;

  return (
    <div className={locked ? "source-group locked zd-own" : "source-group zd-own"}>
      <div className="source-group-head">
        <span className="source-group-name">Vlastní zdroje</span>
        {locked ? <ZIcon name="lock" size={13} className="zd-group-lock" /> : null}
      </div>
      <ul>
        {zotero ? <ZoteroRow signedIn={signedIn} /> : null}
        <FilesRow auth={auth} library={personal} unavailable={signedIn && summary?.state === "unavailable"} />
      </ul>
    </div>
  );
}

function FilesRow({ auth, library, unavailable }: { auth: string; library: LibrarySummary | null; unavailable: boolean }) {
  if (auth !== "signed_in") {
    return (
      <li className="source zd-own-row">
        <Icon name="upload" />
        <div className="source-name">
          <button type="button" className="source-title zd-row-button" onClick={requestSignIn} disabled={auth !== "signed_out"}>
            Vlastní soubory
          </button>
          <span className="source-desc">Nahrané knihy, články, komentáře a vzory, ve kterých asistent hledá vedle oficiálních databází. V režimu Pro.</span>
        </div>
      </li>
    );
  }
  const pro = library?.pro === true;
  let desc: string;
  if (unavailable) desc = "Teď dočasně vypnuté.";
  else if (!library) desc = "Načítám…";
  else if (!pro) desc = "Jen v režimu Pro. Přiděluji ho ručně a zdarma.";
  else if (library.counts && library.counts.total > 0) desc = `${countDocuments(library.counts.total)} · ${countPages(library.pagesUsed ?? 0)}`;
  else desc = "Zatím žádné dokumenty";
  return (
    <li className={pro || !library ? "source zd-own-row" : "source zd-own-row zd-row-locked"}>
      <Icon name="upload" />
      <div className="source-name">
        <span className="source-title">
          Vlastní soubory
          {library && !pro ? <ZIcon name="lock" size={13} /> : null}
        </span>
        <span className="source-desc">{desc}</span>
      </div>
      <div className="source-state">
        <a href={OWN_FILES_HREF} className="zd-manage" onClick={intercept(auth)}>
          Spravovat
        </a>
      </div>
    </li>
  );
}

/**
 * The Zotero row: what the user's connection is, and the way into the Zotero
 * modal (?zotero=1), which does the connecting and disconnecting. Visitors
 * get the sign-in and never ask for the status.
 */
function ZoteroRow({ signedIn }: { signedIn: boolean }) {
  const status = useZoteroStatus(signedIn);
  const ok = status?.state === "ok" ? status : null;
  // The server may know better than the client that nobody is signed in (an expired session).
  const visitor = !signedIn || status?.state === "signed_out";

  let desc: string;
  let locked = false;
  let connected = false;
  if (visitor) {
    desc = "Asistent v ní bude hledat a číst, a když povolíte, i ukládat nalezené dokumenty. V režimu Pro.";
  } else if (status === undefined) {
    desc = "Načítám…";
  } else if (!ok) {
    desc = "Stav připojení se teď nepodařilo zjistit.";
  } else if (ok.connection && ok.pro) {
    desc = `Účet ${ok.connection.username}`;
    connected = true;
  } else if (ok.connection) {
    desc = `Účet ${ok.connection.username} - bez režimu Pro do knihovny asistent nevidí.`;
    locked = true;
  } else if (!ok.pro) {
    desc = "Jen v režimu Pro. Přiděluji ho ručně a zdarma.";
    locked = true;
  } else if (ok.revoked) {
    desc = "Klíč přestal platit - připojte Zotero znovu.";
  } else if (ok.unreadable) {
    desc = "Připojení je potřeba obnovit - připojte Zotero znovu.";
  } else {
    desc = "Připojte svou knihovnu - asistent v ní bude hledat, číst, a když povolíte, i ukládat.";
  }

  return (
    <li className={locked ? "source zd-own-row zd-row-locked" : "source zd-own-row"}>
      <Icon name="book" />
      <div className="source-name">
        <button type="button" className="source-title zd-row-button" onClick={visitor ? requestSignIn : openZotero}>
          Zotero
          {locked ? <ZIcon name="lock" size={13} /> : null}
        </button>
        <span className="source-desc">{desc}</span>
      </div>
      {connected ? (
        <div className="source-state">
          <span className="zd-badge">Připojeno</span>
        </div>
      ) : null}
    </li>
  );
}
