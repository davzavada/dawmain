/**
 * Who may do what in which library — computed on the server from Clerk
 * (src/files/access.ts). Types only, importable from client components.
 */

export interface LibraryAccess {
  /** Clerk id: user_… (personal library) or org_… (team library). */
  id: string;
  kind: "user" | "org";
  name: string;
  slug: string | null;
  role: "owner" | "org:admin" | "org:member";
  /**
   * Vlastní zdroje enabled here: Pro granted (user.publicMetadata.pro /
   * organization.publicMetadata.pro === true) and the feature not switched
   * off (`publicMetadata.features.files === false` on the library's owner
   * or on the user) — see src/files/access.ts.
   */
  pro: boolean;
  /** Pro and allowed to upload (every member of a Pro team; the owner of a Pro personal library). */
  canUpload: boolean;
  /** May edit/delete every document and change library settings (owner, org:admin). */
  canManageAll: boolean;
  /** Page quota of the library (override: publicMetadata.filesQuota.pages). */
  quotaPages: number;
}

export interface Access {
  userId: string;
  banned: boolean;
  /** Pro libraries — search, read, upload. */
  libraries: LibraryAccess[];
  /** Every library the user owns or belongs to, Pro or not — list, delete, export. */
  all: LibraryAccess[];
  /**
   * May use Zotero (zotero_*, connecting a library): Pro on the user or on
   * one of their teams, with `features.zotero` not switched off there, and
   * not switched off on the user.
   */
  zotero: boolean;
}
