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
  /** owner of a personal library; a team's manager (org:admin) or member (org:member). */
  role: "owner" | "org:admin" | "org:member";
  /**
   * Vlastní soubory enabled here: Pro granted (user / organization
   * publicMetadata.pro === true) and the feature not switched off
   * (`publicMetadata.features.files === false` on the library's owner or on
   * the user) — see src/files/access.ts.
   */
  pro: boolean;
  /** Pro, so the owner (personal) or any member (team) may upload. */
  canUpload: boolean;
  /** May edit/delete every document and change library settings (the owner; a team's org:admin). */
  canManageAll: boolean;
  /** Page quota of the library (override: publicMetadata.filesQuota.pages). */
  quotaPages: number;
}

export interface Access {
  userId: string;
  banned: boolean;
  /** Pro libraries — search, read, upload (personal first, then teams by name). */
  libraries: LibraryAccess[];
  /** Every library the user owns or belongs to, Pro or not — list, delete, export. */
  all: LibraryAccess[];
  /**
   * May use Zotero (zotero_*, connecting a library): Pro on the user, with
   * `features.zotero` not switched off.
   */
  zotero: boolean;
  /**
   * May use the doctrine tools (doctrine_*, UKAŽ): switched on by an admin,
   * `publicMetadata.features.ukaz === true` and Pro. Off until then.
   * Optional so older fixtures need not mention it; absent means off.
   */
  ukaz?: boolean;
}
