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

/** One group from /users/{id}/groups (the optional fields: what Zotero sends besides the name). */
export interface ZoteroGroup {
  id: number;
  name: string;
  /** meta.numItems: every item of the group library, child items and the trash included. */
  numItems: number | null;
  /** "Private", "PublicClosed" or "PublicOpen". */
  type?: string | null;
  description?: string | null;
  url?: string | null;
  /** Who may read / edit the library and its files: "all", "members", "admins". */
  libraryReading?: string | null;
  libraryEditing?: string | null;
  fileEditing?: string | null;
  /** Members and admins besides the owner (counts only). */
  members?: number;
  admins?: number;
  /** meta.isAdmin: the key's user owns or administers the group. */
  isAdmin?: boolean | null;
  created?: string | null;
  lastModified?: string | null;
}

/** One collection from /collections. */
export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string | null;
  /** meta.numItems: items directly in it (not in subcollections, not trashed). */
  numItems: number | null;
  /** meta.numCollections: its direct subcollections (trashed ones included). */
  numCollections?: number | null;
  /** data.deleted: the collection is in the trash (Zotero still lists it). */
  deleted?: boolean;
}

/** One tag from a /tags listing. */
export interface ZoteroTag {
  tag: string;
  /** 0 = added by the user, 1 = automatic (imported or added by a translator). */
  type: number;
  /** meta.numItems: items carrying it, library-wide — child items and the trash included. */
  numItems: number;
}

/** GET {lib}/settings: every setting by name, each with its value and version. */
export type ZoteroSettings = Record<string, { value: unknown; version: number | null }>;

/** A coloured tag from the tagColors setting, in the order Zotero keeps them (position 1 = key 1). */
export interface TagColor {
  name: string;
  color: string;
}

/** GET {lib}/fulltext/index. */
export interface FulltextIndexStatus {
  status: "indexed" | "deindexed" | "reindexing" | "incomplete" | string;
  indexedCount: number | null;
  expectedCount: number | null;
}

/** GET {lib}/deleted?since=: keys (tag names for tags, names for settings) deleted after that version. */
export interface DeletedObjects {
  collections: string[];
  items: string[];
  searches: string[];
  tags: string[];
  settings: string[];
}

/** A localized entry of /itemTypes, /itemFields, /itemTypeFields or /itemTypeCreatorTypes. */
export interface LocalizedName {
  name: string;
  localized: string;
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
  /** The tags among `tags` that are automatic (data.tags[].type 1). */
  automaticTags?: string[];
  collections: string[];
  /** data.deleted: the item is in the trash. */
  deleted?: boolean;
  /**
   * links.enclosure of an attachment: its file in Zotero Storage (present
   * only then, and only for a key with file access); `size` is absent for a
   * file Zotero stores zipped.
   */
  file?: { size: number | null; contentType: string | null } | null;
  meta: {
    creatorSummary: string | null;
    parsedDate: string | null;
    numChildren: number | null;
    /** Group libraries: who added / last modified the item (username). */
    createdBy?: string | null;
    lastModifiedBy?: string | null;
  };
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
  /** data.deleted: the saved search is in the trash (Zotero still lists it). */
  deleted?: boolean;
}

/** Response headers that drive paging and caching. */
export interface Paging {
  /** Total-Results. */
  total: number | null;
  /** `start` of the Link rel="next" page, if any. */
  nextStart: number | null;
  /** Last-Modified-Version. */
  libraryVersion: number | null;
  /** Zotero-Full-Text-Reindexing: 1 — the library's full-text index is being rebuilt, so full-text matches may be missing. */
  fulltextReindexing?: boolean;
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
