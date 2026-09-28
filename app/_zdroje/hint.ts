import type { LibraryDocCounts, LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The sign-in hint: the last account state this browser saw, kept in a
 * first-party cookie so the server renders the page the way it will look
 * once Clerk loads — the avatar instead of "Přihlásit se", the user's
 * libraries instead of the locked invitation — and nothing jumps. Clerk
 * then confirms it (or, when the session ended meanwhile, the page falls
 * back to signed out and the cookie is dropped).
 *
 * The cookie holds only what the header, the nav item and the home page
 * group show (initials, the library summary); it is never trusted for
 * access — every API call is authorized by Clerk. A value that does not
 * parse exactly is ignored. Pure: used by the layout (server) and the
 * store (browser).
 */

export const HINT_COOKIE = "dz_hint";
/** Browsers keep ~4 KB per cookie; a bigger summary is left out and the initials alone go. */
const MAX_COOKIE_CHARS = 3_000;
const MAX_AGE_S = 60 * 60 * 24 * 30;

export interface Hint {
  initials: string;
  summary: SummaryResponse | null;
}

const MODES = new Set(["on", "readonly", "off"]);
const ROLES = new Set(["owner", "org:admin", "org:member"]);
const COUNT_KEYS = ["total", "ready", "review", "processing", "error", "searchable"] as const;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function counts(v: unknown): LibraryDocCounts | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of COUNT_KEYS) {
    if (!isInt(o[k])) return undefined;
    out[k] = o[k];
  }
  return out as unknown as LibraryDocCounts;
}

function library(v: unknown): LibrarySummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const c = counts(o.counts);
  if (
    !isStr(o.id, 80) ||
    (o.kind !== "user" && o.kind !== "org") ||
    !isStr(o.name, 200) ||
    !ROLES.has(o.role as string) ||
    typeof o.pro !== "boolean" ||
    typeof o.canUpload !== "boolean" ||
    typeof o.canManageAll !== "boolean" ||
    !isInt(o.quotaPages) ||
    !(o.pagesUsed === null || isInt(o.pagesUsed)) ||
    c === undefined ||
    !(o.memberCount === null || isInt(o.memberCount))
  ) {
    return null;
  }
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    role: o.role as LibrarySummary["role"],
    pro: o.pro,
    canUpload: o.canUpload,
    canManageAll: o.canManageAll,
    quotaPages: o.quotaPages,
    pagesUsed: o.pagesUsed as number | null,
    counts: c,
    memberCount: o.memberCount as number | null,
  };
}

function summary(v: unknown): SummaryResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.state === "unavailable" && MODES.has(o.mode as string)) return { state: "unavailable", mode: o.mode as "on" };
  if (o.state !== "ok" || !MODES.has(o.mode as string) || typeof o.termsAccepted !== "boolean" || !Array.isArray(o.libraries) || o.libraries.length > 20) return null;
  const libraries = o.libraries.map(library);
  if (libraries.some((l) => l === null)) return null;
  return { state: "ok", mode: o.mode as "on", termsAccepted: o.termsAccepted, libraries: libraries as LibrarySummary[] };
}

/** The cookie value → a hint, or null for anything that is not exactly one. */
export function parseHint(raw: string | undefined | null): Hint | null {
  if (!raw || raw.length > MAX_COOKIE_CHARS * 2) return null;
  let data: unknown;
  try {
    data = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (!isStr(o.i, 4)) return null;
  const initials = o.i.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3);
  return { initials: initials || "?", summary: summary(o.s) };
}

/** A hint → the cookie value (URI-encoded JSON); the summary is dropped when it would not fit. */
export function encodeHint(hint: Hint): string {
  const full = encodeURIComponent(JSON.stringify({ i: hint.initials.slice(0, 4), s: hint.summary }));
  return full.length <= MAX_COOKIE_CHARS ? full : encodeURIComponent(JSON.stringify({ i: hint.initials.slice(0, 4), s: null }));
}

/** The Set-Cookie string for document.cookie (null hint: delete it). */
export function hintCookie(hint: Hint | null, secure: boolean): string {
  const attrs = `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return hint ? `${HINT_COOKIE}=${encodeHint(hint)}; Max-Age=${MAX_AGE_S}; ${attrs}` : `${HINT_COOKIE}=; Max-Age=0; ${attrs}`;
}
