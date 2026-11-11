/**
 * The admin page's model (app/sprava): what an account looks like to an
 * admin and how a change becomes Clerk publicMetadata. Pure, no server-only
 * imports, so client components can use the types and the date helper.
 *
 * Everything an admin switches lives in the account's `publicMetadata`,
 * where the access code already reads it (src/files/access.ts):
 *
 *   role      "admin" makes the account an admin; anything else is a user;
 *   pro       true = Pro (Vlastní soubory, Zotero);
 *   features  { files, zotero } switch one Pro feature off with `false`;
 *             { ukaz } switches UKAŽ (doctrine_*) on with `true`.
 */

export type AdminFeature = "files" | "zotero" | "ukaz";
export const ADMIN_FEATURES: AdminFeature[] = ["files", "zotero", "ukaz"];

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  imageUrl: string | null;
  /** Epoch ms, null where Clerk has none. */
  createdAt: number | null;
  lastSignInAt: number | null;
  role: "admin" | "user";
  /** Admin because of ADMIN_USER_IDS / FILES_OPERATOR_IDS: the role cannot be taken away here. */
  envAdmin: boolean;
  pro: boolean;
  /** What the account may use now: files and zotero are on unless switched off, ukaz only when switched on. */
  features: Record<AdminFeature, boolean>;
  banned: boolean;
}

export type AdminChange =
  | { kind: "role"; admin: boolean }
  | { kind: "pro"; on: boolean }
  | { kind: "feature"; feature: AdminFeature; on: boolean };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Strict: only the string "admin". */
export function roleFrom(metadata: unknown): "admin" | "user" {
  return record(metadata).role === "admin" ? "admin" : "user";
}

/** The subset of Clerk's User an AdminUser is built from. */
export interface ClerkAdminUserLike {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  createdAt?: number | null;
  lastSignInAt?: number | null;
  banned?: boolean;
  locked?: boolean;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
  publicMetadata?: unknown;
}

export function toAdminUser(user: ClerkAdminUserLike, envAdmin: boolean): AdminUser {
  const meta = record(user.publicMetadata);
  const features = record(meta.features);
  const emails = user.emailAddresses ?? [];
  const email = (emails.find((e) => e.id === user.primaryEmailAddressId) ?? emails[0])?.emailAddress ?? "";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email || user.id;
  return {
    id: user.id,
    name,
    email,
    imageUrl: user.imageUrl || null,
    createdAt: user.createdAt ?? null,
    lastSignInAt: user.lastSignInAt ?? null,
    role: envAdmin || roleFrom(meta) === "admin" ? "admin" : "user",
    envAdmin,
    pro: meta.pro === true,
    features: { files: features.files !== false, zotero: features.zotero !== false, ukaz: features.ukaz === true },
    banned: user.banned === true || user.locked === true,
  };
}

/**
 * The publicMetadata to send to Clerk for one change, given the account's
 * current metadata. A top-level key is merged by Clerk, so `features` is
 * always sent whole (the other switches kept as they are).
 */
export function metadataPatch(current: unknown, change: AdminChange): Record<string, unknown> {
  switch (change.kind) {
    case "role":
      return { role: change.admin ? "admin" : "user" };
    case "pro":
      return { pro: change.on };
    case "feature":
      return { features: { ...record(record(current).features), [change.feature]: change.on } };
  }
}

const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];

/** "12. března 2026" — the one date format of the page. Takes epoch ms, a Date, or a UTC day "YYYY-MM-DD". */
export function formatDay(value: number | string | Date | null | undefined): string {
  if (value === null || value === undefined) return "nikdy";
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) return "nikdy";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return `${get("day")}. ${MONTHS[get("month") - 1]} ${get("year")}`;
}

/** The UTC day `ago` days before `today` (YYYY-MM-DD). */
export function dayBefore(today: string, ago: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ago);
  return d.toISOString().slice(0, 10);
}
