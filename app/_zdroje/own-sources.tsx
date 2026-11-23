"use client";

import Link from "next/link";
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { Icon } from "@/app/_icons";
import { UkazRow } from "@/app/_source-status";
import type { SummaryResponse } from "@/src/files/web-types";
import { filesRowView } from "./hint";
import { ZIcon } from "./icons";
import { requestSignIn, useZdroje } from "./store";
import { DEFAULT_SOURCE_TEXTS, SourceTextsContext, useSourceTexts, type SourceTexts } from "./texts";
import { useZoteroStatus } from "./zotero-status";

/**
 * The "Pro" group at the end of the home page's source list (wireframe 01,
 * 02): Vlastní soubory, Zotero (always listed; locked where the deployment
 * cannot connect it) and UKAŽ — a hidden feature: listed only for an account an admin
 * switched it on for (app/_source-status.tsx), never for visitors.
 * Visitors see them greyed out with a lock, each with one line on what it
 * is, and nothing to click (the note above them says how to get Pro); signed in, the rows read the same
 * (no counts, no account, no lights: that lives in the sidebar's pages)
 * and the whole card links to its page, a lock only without Pro. The rows read the shared summary
 * (./store.ts) and the Zotero status, so the page itself stays
 * static and never waits for them. Until Clerk loads, the group renders
 * both the visitor's and the signed-in variant; the sign-in hint (./hint.ts)
 * decides in CSS which one shows, so the group never switches between them.
 */

/** The Vlastní soubory page. */
export const OWN_FILES_HREF = "/soubory";

/** A visitor gets the sign-in instead of the page; everyone else follows the link. */
function intercept(auth: string) {
  return (event: MouseEvent) => {
    if (auth !== "signed_out") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    requestSignIn();
  };
}

/** What Pro is and how to get it, rendered by the home page from an editable text; shown under the heading. */
const ProNoteContext = createContext<ReactNode>(null);

/** `texts`: the editable lines under the rows, as the home page read them (the defaults without). */
export function OwnSourcesGroup({ zotero, texts = DEFAULT_SOURCE_TEXTS, proNote = null }: { zotero: boolean; texts?: SourceTexts; proNote?: ReactNode }) {
  return (
    <SourceTextsContext.Provider value={texts}>
      <ProNoteContext.Provider value={proNote}>
        <OwnSources zotero={zotero} />
      </ProNoteContext.Provider>
    </SourceTextsContext.Provider>
  );
}

function OwnSources({ zotero }: { zotero: boolean }) {
  const { auth, summary } = useZdroje();
  const texts = useSourceTexts();
  if (auth === "loading") {
    return (
      <>
        <Group signedIn={false} className="zd-hint-out">
          <FilesInvite />
          {zotero ? <ZoteroRow signedIn={false} /> : <ZoteroUnavailable signedIn={false} />}
        </Group>
        <Group signedIn className="zd-hint-in">
          <HintedFilesRow />
          {zotero ? <ZoteroRowView desc={texts.zotero} /> : <ZoteroUnavailable signedIn />}
        </Group>
      </>
    );
  }
  const signedIn = auth === "signed_in";
  return (
    <Group signedIn={signedIn}>
      {signedIn ? <FilesRow auth={auth} summary={summary} /> : <FilesInvite />}
      {zotero ? <ZoteroRow signedIn={signedIn} /> : <ZoteroUnavailable signedIn={signedIn} />}
      <UkazRow signedIn={signedIn} />
    </Group>
  );
}

/** The note under the heading (what Pro is, how to get it) shows to everyone, Pro accounts included. */
function Group({ signedIn, className, children }: { signedIn: boolean; className?: string; children: ReactNode }) {
  const classes = ["source-group", signedIn ? null : "locked", "zd-own", className].filter(Boolean).join(" ");
  const note = useContext(ProNoteContext);
  return (
    <div className={classes}>
      <div className="source-group-head">
        <h3 className="source-group-name">Pro (právníky)</h3>
        {signedIn ? null : <ZIcon name="lock" size={13} className="zd-group-lock" />}
      </div>
      {note ? <div className="source-group-note-wrap">{note}</div> : null}
      <div className="source-box">
        <ul>{children}</ul>
      </div>
    </div>
  );
}

/** What Zotero is: the visitor's line, and the line of an account without Pro (the group's heading says Pro). Its default wording; the rows show the editable text (useSourceTexts). */
const ZOTERO_DESC = DEFAULT_SOURCE_TEXTS.zotero;

/** Visitors (and, until Clerk loads, the visitor's variant): what the files are; not a link. */
function FilesInvite() {
  const texts = useSourceTexts();
  return (
    <li className="source zd-own-row">
      <Icon name="upload" />
      <div className="source-name">
        <span className="source-title">Vlastní soubory</span>
        <span className="source-desc">{texts.files}</span>
      </div>
    </li>
  );
}

/** Signed in: the same line as for visitors (no counts), the whole card a link to the files page; a lock only without Pro. */
function FilesRow({ auth, summary }: { auth: string; summary: SummaryResponse | null }) {
  const locked = filesRowView(summary).locked;
  const texts = useSourceTexts();
  return (
    <li className={locked ? "source zd-own-row zd-row-locked" : "source zd-own-row"}>
      <Icon name="upload" />
      <div className="source-name">
        <Link href={OWN_FILES_HREF} className="source-title zd-row-button" onClick={intercept(auth)}>
          Vlastní soubory
          {locked ? <ZIcon name="lock" size={13} /> : null}
        </Link>
        <span className="source-desc">{texts.files}</span>
      </div>
    </li>
  );
}

/** FilesRow as the sign-in hint draws it before Clerk loads: the line and the lock come from CSS. */
function HintedFilesRow() {
  const texts = useSourceTexts();
  return (
    <li className="source zd-own-row zd-hint-files">
      <Icon name="upload" />
      <div className="source-name">
        <Link href={OWN_FILES_HREF} className="source-title zd-row-button">
          Vlastní soubory
          <ZIcon name="lock" size={13} className="zd-hint-files-lock" />
        </Link>
        <span className="source-desc">{texts.files}</span>
      </div>
    </li>
  );
}

/**
 * The Zotero row: what the user's connection is, and the way to the /zotero
 * page, which does the connecting, the libraries and the disconnecting.
 * Visitors get the sign-in and never ask for the status.
 */
function ZoteroRow({ signedIn }: { signedIn: boolean }) {
  const status = useZoteroStatus(signedIn);
  const texts = useSourceTexts();
  const ok = status?.state === "ok" ? status : null;
  // The server may know better than the client that nobody is signed in (an expired session).
  const visitor = !signedIn || status?.state === "signed_out";

  // Signed in, the row reads as for visitors (the account and the connection live on /zotero);
  // only a lock without Pro, and a broken key, which needs the user, change it.
  let desc = ZOTERO_DESC;
  let locked = false;
  if (!visitor && ok) {
    if (!ok.pro) locked = true;
    else if (!ok.connection && ok.revoked) desc = "Klíč přestal platit - připojte Zotero znovu.";
    else if (!ok.connection && ok.unreadable) desc = "Připojení je potřeba obnovit - připojte Zotero znovu.";
  }

  return <ZoteroRowView desc={desc === ZOTERO_DESC ? texts.zotero : desc} locked={locked} onClick={visitor ? null : ZOTERO_PAGE} />;
}

/**
 * Where the deployment cannot connect Zotero (no OAuth app or CREDENTIALS_SECRET): the row stays, greyed out,
 * with nothing to click; its own lock only when signed in (a visitor's group carries the lock in its head).
 */
function ZoteroUnavailable({ signedIn }: { signedIn: boolean }) {
  return <ZoteroRowView desc={useSourceTexts().zotero} locked={signedIn} onClick={null} />;
}

/** The row's link to the Zotero page (onClick: a URL is a link, a function a button, null nothing to click). */
const ZOTERO_PAGE = "/zotero";

/** The Zotero row itself; without a status yet (the hinted variant), a click opens the page, which waits for Clerk. */
function ZoteroRowView({ desc, locked = false, onClick = ZOTERO_PAGE }: { desc: string; locked?: boolean; onClick?: (() => void) | string | null }) {
  const lock = locked ? <ZIcon name="lock" size={13} /> : null;
  return (
    <li className={locked ? "source zd-own-row zd-row-locked" : "source zd-own-row"}>
      <Icon name="book" />
      <div className="source-name">
        {typeof onClick === "string" ? (
          <Link href={onClick} className="source-title zd-row-button">
            Zotero
            {lock}
          </Link>
        ) : onClick ? (
          <button type="button" className="source-title zd-row-button" onClick={onClick}>
            Zotero
            {lock}
          </button>
        ) : (
          <span className="source-title">
            Zotero
            {lock}
          </span>
        )}
        <span className="source-desc">{desc}</span>
      </div>
    </li>
  );
}
