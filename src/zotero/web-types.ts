/**
 * The contract between the Zotero web routes (app/api/zotero/*) and the
 * /zotero page (app/_zdroje/zotero-modal.tsx, mounted by app/zotero/page.tsx). Types only: safe to import
 * from client components.
 *
 *   GET  /api/zotero/status      → ZoteroStatus (JSON; signed out is a normal answer)
 *   POST /api/zotero/connect     → a navigation (HTML form POST with
 *                                   mode=read|write; anything else is read),
 *                                   always 303:
 *                                   to zotero.org's authorize page, or back to
 *                                   /zotero?stav=<ZoteroStav> on refusal
 *   GET  /api/zotero/callback    → 303 to /zotero?stav=<ZoteroStav>
 *   POST /api/zotero/disconnect  → { ok: true } (JSON, fetch with same-origin credentials)
 *   GET  /api/zotero/libraries   → ZoteroLibrariesAnswer (JSON; 401/403/404/409 { error } when not usable)
 *   POST /api/zotero/libraries   { library, on } (JSON) → ZoteroLibrariesAnswer after the change
 */

/** Outcome of a connect attempt, carried back in `?stav=` to the page's banner. */
export type ZoteroStav =
  | "pripojeno" // connected
  | "zamitnuto" // the user declined on zotero.org
  | "vyprselo" // the 10-minute state expired, the cookie is missing, it was started by another account, or the token does not match
  | "prihlaseni" // not signed in
  | "nepro" // no Pro library
  | "nedostupne" // not configured on this deployment
  | "limit" // too many connect attempts
  | "chyba"; // anything else (Zotero unreachable, malformed answer)

export const ZOTERO_STAV: readonly ZoteroStav[] = [
  "pripojeno",
  "zamitnuto",
  "vyprselo",
  "prihlaseni",
  "nepro",
  "nedostupne",
  "limit",
  "chyba",
];

/** What Dawmain may do in the library: "read", or "write" = read and save new items to the personal library. */
export type ZoteroModeView = "read" | "write";

export interface ZoteroConnectionView {
  username: string;
  userID: number;
  /** ISO timestamp. */
  connectedAt: string;
  notes: boolean;
  /**
   * The effective mode: "write" only when the user chose "Číst a ukládat"
   * AND the key may write to the personal library ("čtení a ukládání");
   * else "read" ("jen čtení").
   */
  mode: ZoteroModeView;
  /** Group read access of the key. */
  groups: "all" | "none" | number[];
  /** Names of the readable groups, best effort (omitted when Zotero did not answer). */
  groupNames?: string[];
}

export type ZoteroStatus =
  | { state: "signed_out" }
  | {
      state: "ok";
      /** False when the deployment lacks the OAuth app or CREDENTIALS_SECRET. */
      configured: boolean;
      /** Personal or team Pro — the same entitlement as Vlastní zdroje. */
      pro: boolean;
      connection: ZoteroConnectionView | null;
      /** Zotero rejected the stored key (deleted there); reconnect. */
      revoked: { username: string; revokedAt: string } | null;
      /** The stored key no longer opens (server secret rotated); reconnect. */
      unreadable: { username: string } | null;
    };

/** One library the key reads, with its switch on the /zotero page. */
export interface ZoteroLibraryView {
  /** As the tools name it: "personal" or the group id. */
  id: string;
  kind: "personal" | "group";
  /** "Moje knihovna", or the group's name. */
  name: string;
  /** Items in it, best effort (null: not known). */
  items: number | null;
  /** On: the assistant searches and reads it. */
  on: boolean;
  /** New items are saved here (only the personal library, in write mode). */
  saves: boolean;
}

export interface ZoteroLibrariesAnswer {
  libraries: ZoteroLibraryView[];
  /** The groups could not be listed right now: only the personal library is in `libraries`. */
  groupsFailed: boolean;
  mode: ZoteroModeView;
}
