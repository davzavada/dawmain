/**
 * Who may do what in which library — computed on the server from Clerk
 * (src/files/access.ts). Types only, importable from client components.
 */

export interface LibraryAccess {
  /** Clerk user id (user_…): every library is one person's own. */
  id: string;
  kind: "user";
  name: string;
  slug: string | null;
  role: "owner";
  /**
   * Vlastní soubory enabled here: Pro granted (user.publicMetadata.pro ===
   * true) and the feature not switched off (`publicMetadata.features.files
   * === false`) — see src/files/access.ts.
   */
  pro: boolean;
  /** Pro, so the owner may upload. */
  canUpload: boolean;
  /** May edit/delete every document and change library settings (the owner). */
  canManageAll: boolean;
  /** Page quota of the library (override: publicMetadata.filesQuota.pages). */
  quotaPages: number;
}

export interface Access {
  userId: string;
  banned: boolean;
  /** Pro libraries — search, read, upload (the personal one, when Pro). */
  libraries: LibraryAccess[];
  /** Every library the user owns, Pro or not — list, delete, export. */
  all: LibraryAccess[];
  /**
   * May use Zotero (zotero_*, connecting a library): Pro on the user, with
   * `features.zotero` not switched off.
   */
  zotero: boolean;
}
