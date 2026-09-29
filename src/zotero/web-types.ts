/**
 * The contract between the Zotero web routes (app/api/zotero/*) and the
 * Zotero modal (app/_zdroje/zotero-modal.tsx). Types only: safe to import
 * from client components.
 *
 *   GET  /api/zotero/status      → ZoteroStatus (JSON; signed out is a normal answer)
 *   POST /api/zotero/connect     → a navigation (HTML form POST), always 303:
 *                                   to zotero.org's authorize page, or back to
 *                                   /?zotero=1&stav=<ZoteroStav> on refusal
 *   GET  /api/zotero/callback    → 303 to /?zotero=1&stav=<ZoteroStav>
 *   POST /api/zotero/disconnect  → { ok: true } (JSON, fetch with same-origin credentials)
 */

/** Outcome of a connect attempt, carried back in `?stav=` to the modal's banner. */
export type ZoteroStav =
  | "pripojeno" // connected
  | "zamitnuto" // the user declined on zotero.org
  | "vyprselo" // the 10-minute state expired or the cookie is missing
  | "zapis" // the key had write access: revoked and refused
  | "prihlaseni" // not signed in (or signed in as someone else than who started)
  | "nepro" // no Pro library
  | "nedostupne" // not configured on this deployment
  | "limit" // too many connect attempts
  | "chyba"; // anything else (Zotero unreachable, malformed answer)

export const ZOTERO_STAV: readonly ZoteroStav[] = [
  "pripojeno",
  "zamitnuto",
  "vyprselo",
  "zapis",
  "prihlaseni",
  "nepro",
  "nedostupne",
  "limit",
  "chyba",
];

export interface ZoteroConnectionView {
  username: string;
  userID: number;
  /** ISO timestamp. */
  connectedAt: string;
  notes: boolean;
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
