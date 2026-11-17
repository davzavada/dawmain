/**
 * Who may do what in which library — computed on the server from Clerk
 * (src/files/access.ts). Types only, importable from client components.
 */

export interface LibraryAccess {
  /** Clerk id: `user_…` a person's own library, `org_…` a team's shared one. */
  id: string;
  kind: "user" | "org";
  /** "Osobní", or the team's name (the Clerk organization's). */
  name: string;
  slug: string | null;
  /** "owner" of the personal library; in a team "admin" (Clerk `org:admin`) or "member". */
  role: "owner" | "admin" | "member";
  /**
   * Vlastní soubory enabled here: Pro granted (`publicMetadata.pro === true`
   * on the user, or on the team's organization) and the feature not switched
   * off (`publicMetadata.features.files === false`) — see src/files/access.ts.
   */
  pro: boolean;
  /** Pro, so the owner — or any member of the team — may upload. */
  canUpload: boolean;
  /** May edit/delete every document: the owner, or a team's admin. A member manages what they uploaded. */
  canManageAll: boolean;
  /** Page quota of the library (override: publicMetadata.filesQuota.pages on the user / the organization). */
  quotaPages: number;
}

export interface Access {
  userId: string;
  banned: boolean;
  /** Pro libraries — search, read, upload: the personal one when Pro, and the Pro teams the user belongs to. */
  libraries: LibraryAccess[];
  /** Every library the user owns or belongs to, Pro or not — list, delete, export. The personal one first. */
  all: LibraryAccess[];
  /**
   * May use Zotero (zotero_*, connecting a library): Pro on the user or on
   * one of their teams (with the team's `features.zotero` not switched
   * off), unless the user's own `features.zotero` is switched off.
   */
  zotero: boolean;
  /**
   * May use the doctrine tools (doctrine_*, UKAŽ): switched on by an admin,
   * `publicMetadata.features.ukaz === true` and Pro — on the user or on one
   * of their teams. Off until then.
   * Optional so older fixtures need not mention it; absent means off.
   */
  ukaz?: boolean;
}
