/**
 * Shared shapes of the Zotero integration. The parsers in client.ts turn the
 * Web API's JSON into these; the tools, the web routes and the store work
 * only with these, never with raw API objects.
 */

/** What every API call needs: the numeric Zotero user id and the (unsealed) key. */
export interface ZoteroCreds {
  userID: number;
  key: string;
}

/** A library the key can read: the personal one or a group. */
export type Library = { type: "user"; id: number } | { type: "group"; id: number; name?: string };

/** GET /keys/current, normalized. */
export interface KeyInfo {
  userID: number;
  username: string;
  displayName: string | null;
  /** Read access to the personal library (files come with it). */
  library: boolean;
  files: boolean;
  notes: boolean;
  /** True if the key can write ANYWHERE — the personal library or any group. Such a key is refused. */
  write: boolean;
  /** Group read access: all current and future groups, none, or these group ids. */
  groups: "all" | "none" | number[];
}

/** One group from /users/{id}/groups. */
export interface ZoteroGroup {
  id: number;
  name: string;
  numItems: number | null;
}

/** One collection from /collections. */
export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string | null;
  numItems: number | null;
}

export interface ZoteroCreator {
  creatorType: string;
  /** "Last, First" or the single-field name. */
  name: string;
}

/** One item (a work, an attachment, a note or an annotation). */
export interface ZoteroItem {
  key: string;
  version: number;
  library: Library;
  itemType: string;
  /** Display title: title / caseName / nameOfAct / subject… ; notes get their first line. */
  title: string;
  /** Parent work for attachments, notes and annotations. */
  parentItem: string | null;
  creators: ZoteroCreator[];
  /** data.date / dateDecided / dateEnacted as entered. */
  date: string | null;
  /** The item's own web link (e.g. the court's page), not zotero.org. */
  url: string | null;
  /** zotero.org web-library link (links.alternate.href). */
  webLink: string | null;
  tags: string[];
  collections: string[];
  meta: { creatorSummary: string | null; parsedDate: string | null; numChildren: number | null };
  /** The raw `data` object for field rendering (fields vary by item type). */
  data: Record<string, unknown>;
}

/** One condition of a saved search, as Zotero stores it ("tag" "is" "smlouvy"). */
export interface SavedSearchCondition {
  condition: string;
  operator: string;
  value: string;
}

/** A saved search of a library (/searches): its name and conditions — the API returns no results for it. */
export interface SavedSearch {
  key: string;
  name: string;
  conditions: SavedSearchCondition[];
}

/** Response headers that drive paging and caching. */
export interface Paging {
  /** Total-Results. */
  total: number | null;
  /** `start` of the Link rel="next" page, if any. */
  nextStart: number | null;
  /** Last-Modified-Version. */
  libraryVersion: number | null;
}

/** GET /items/{key}/fulltext. */
export interface Fulltext {
  content: string;
  indexedPages: number | null;
  totalPages: number | null;
  indexedChars: number | null;
  totalChars: number | null;
}

/** Whether a fulltext covers the whole attachment. */
export function fulltextComplete(ft: Fulltext): boolean {
  if (ft.totalPages !== null) return ft.indexedPages !== null && ft.indexedPages >= ft.totalPages;
  if (ft.totalChars !== null) return ft.indexedChars !== null && ft.indexedChars >= ft.totalChars;
  return ft.content.length > 0;
}

/** What `loadConnection` finds for a Clerk user. */
export type ConnectionState =
  | { state: "none" }
  | {
      state: "ok";
      conn: {
        creds: ZoteroCreds;
        username: string;
        notes: boolean;
        groups: "all" | "none" | number[];
        connectedAt: string;
        /** Fingerprint of the key (for a race-free markRevoked). */
        fp: string;
      };
    }
  /** Zotero rejected the key (revoked there); the sealed key is gone. */
  | { state: "revoked"; username: string; revokedAt: string }
  /** The sealed key no longer opens (CREDENTIALS_SECRET rotated). */
  | { state: "unreadable"; username: string };
