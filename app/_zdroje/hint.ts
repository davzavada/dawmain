import type { LibraryDocCounts, LibrarySummary, SummaryResponse } from "@/src/files/web-types";
import { countDocuments, countPages } from "./format";

/**
 * The sign-in hint: the last account state this browser saw, kept in a
 * first-party cookie so a returning user sees the page the way it will look
 * once Clerk loads — the avatar instead of "Přihlásit se", their Vlastní
 * soubory row instead of the locked invitation — and nothing jumps. Clerk
 * then confirms it (or, when the session ended meanwhile, the page falls
 * back to signed out and the cookie is dropped).
 *
 * The pages are static (served from the CDN, nobody reads the cookie on the
 * server), so the hint is applied in the browser before the first paint:
 * the root layout inlines HINT_SCRIPT into <head>, which marks <html> and
 * hands the texts to CSS (globals.css, "The sign-in hint"); until Clerk
 * loads, the header and the home page group render both the visitor's and
 * the signed-in variant and CSS shows the one the hint says.
 *
 * The cookie holds only what the header and the home page group show
 * (initials, the account's picture, the library summary and `v`, the texts
 * derived from it by hintView — the same function the components render
 * with, so the hinted page and the real one match); it is never trusted for
 * access — every API call is authorized by Clerk. A value that does not
 * parse exactly is ignored. Pure: used by the layout (server) and the store
 * (browser).
 */

export const HINT_COOKIE = "dz_hint";
/** Browsers keep ~4 KB per cookie; a bigger summary is left out (then the picture) and the initials alone go. */
const MAX_COOKIE_CHARS = 3_000;
const MAX_AGE_S = 60 * 60 * 24 * 30;

export interface Hint {
  initials: string;
  /** The account's picture as Clerk serves it (user.imageUrl), or null. */
  image: string | null;
  summary: SummaryResponse | null;
}

/**
 * Clerk serves every account picture (an uploaded photo, the sign-in
 * provider's, or its generated default) from img.clerk.com. Only such an
 * address is kept: it has no quotes, brackets or spaces, so it is safe
 * inside url("…") in CSS.
 */
const CLERK_IMAGE = /^https:\/\/img\.clerk\.com\/[\w.~+/=%-]+$/;
const MAX_IMAGE_CHARS = 1_000;

function clerkImage(v: unknown): string | null {
  return isStr(v, MAX_IMAGE_CHARS) && CLERK_IMAGE.test(v) ? v : null;
}

/** The picture's width Clerk's own avatar asks for (2 × its 80 px), so both share the cached file. */
const AVATAR_FETCH_WIDTH = 160;

/** The address the avatar loads: a Clerk picture at the avatar's size, anything else as it is. */
export function avatarSrc(image: string): string {
  try {
    const url = new URL(image);
    if (url.hostname !== "img.clerk.com") return image;
    url.searchParams.set("width", String(AVATAR_FETCH_WIDTH));
    return url.href;
  } catch {
    return image;
  }
}

const MODES = new Set(["on", "readonly", "off"]);
const ROLES = new Set(["owner"]);
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
    o.kind !== "user" ||
    !isStr(o.name, 200) ||
    !ROLES.has(o.role as string) ||
    typeof o.pro !== "boolean" ||
    typeof o.canUpload !== "boolean" ||
    typeof o.canManageAll !== "boolean" ||
    !isInt(o.quotaPages) ||
    !(o.pagesUsed === null || isInt(o.pagesUsed)) ||
    c === undefined
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
  return { initials: initials || "?", image: clerkImage(o.m), summary: summary(o.s) };
}

/** A hint → the cookie value (URI-encoded JSON); the summary, then the picture, is dropped when it would not fit. */
export function encodeHint(hint: Hint): string {
  const encode = (image: string | null, summary: SummaryResponse | null) =>
    encodeURIComponent(
      JSON.stringify({ i: hint.initials.slice(0, 4), ...(image ? { m: image } : {}), s: summary, v: compactView(hintView(summary)) }),
    );
  const image = clerkImage(hint.image);
  const full = encode(image, hint.summary);
  if (full.length <= MAX_COOKIE_CHARS) return full;
  const lean = encode(image, null);
  return lean.length <= MAX_COOKIE_CHARS ? lean : encode(null, null);
}

/** document.cookie → the hint in it, or null. */
export function readHint(cookie: string): Hint | null {
  const match = new RegExp(`(?:^|;\\s*)${HINT_COOKIE}=([^;]*)`).exec(cookie);
  return match ? parseHint(match[1]) : null;
}

/** The Set-Cookie string for document.cookie (null hint: delete it). */
export function hintCookie(hint: Hint | null, secure: boolean): string {
  const attrs = `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return hint ? `${HINT_COOKIE}=${encodeHint(hint)}; Max-Age=${MAX_AGE_S}; ${attrs}` : `${HINT_COOKIE}=; Max-Age=0; ${attrs}`;
}

// ---------------------------------------------------------------------------
// What the hint shows

/** The Vlastní soubory row of the home page group, signed in: its line under the title, and the lock without Pro. */
export interface FilesRowView {
  desc: string;
  locked: boolean;
}

/** What a signed-in user sees in the header and the home page group before anything new is loaded. */
export interface HintView {
  /** The crown on the avatar. */
  pro: boolean;
  files: FilesRowView;
}

/** The Vlastní soubory row for a signed-in user with this summary (null: not loaded yet). */
export function filesRowView(summary: SummaryResponse | null): FilesRowView {
  if (summary?.state === "unavailable") return { desc: "Teď dočasně vypnuté.", locked: false };
  const library = summary?.state === "ok" ? (summary.libraries.find((l) => l.kind === "user") ?? null) : null;
  if (!library) return { desc: "Načítám…", locked: false };
  if (!library.pro) return { desc: "Jen v režimu Pro. Přiděluji ho ručně a zdarma.", locked: true };
  if (library.counts && library.counts.total > 0) {
    return { desc: `${countDocuments(library.counts.total)} · ${countPages(library.pagesUsed ?? 0)}`, locked: false };
  }
  return { desc: "Zatím žádné dokumenty", locked: false };
}

/** Whether the avatar wears the Pro crown. */
export function hasPro(summary: SummaryResponse | null): boolean {
  return summary?.state === "ok" && summary.libraries.some((l) => l.pro);
}

export function hintView(summary: SummaryResponse | null): HintView {
  return { pro: hasPro(summary), files: filesRowView(summary) };
}

/** The view as the cookie keeps it (short keys: p = Pro, f = the files line, l = locked). */
function compactView(view: HintView): { p: boolean; f: string; l: boolean } {
  return { p: view.pro, f: view.files.desc, l: view.files.locked };
}

// ---------------------------------------------------------------------------
// Before the first paint

/**
 * Runs in the browser while it parses <head> (inlined by the root layout as
 * HINT_SCRIPT, so it must stay self-contained: no imports, no outer names).
 * With a signed-in hint: <html data-hint="in">, data-hint-image,
 * data-hint-pro and data-hint-files-locked when they apply, the initials and
 * the files line as CSS strings in --hint-initials and --hint-files, and the
 * picture as a CSS url() in --hint-image. Anything that is not exactly a
 * hint leaves the page as the visitor's. Exported for tests.
 */
export function applyHint(doc: Document, name: string): void {
  try {
    const found = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(doc.cookie);
    if (!found) return;
    const hint = JSON.parse(decodeURIComponent(found[1]));
    const view = hint && hint.v;
    if (typeof hint.i !== "string" || hint.i.length > 4 || !view || typeof view.f !== "string" || view.f.length > 200) return;
    // As parseHint: letters and digits only, at most three.
    const initials = hint.i.replace(new RegExp("[^\\p{L}\\p{N}]", "gu"), "").slice(0, 3) || "?";
    // As parseHint: only a picture on Clerk's image host, an address that can stand in url("…") as it is.
    const image =
      typeof hint.m === "string" && hint.m.length <= 1000 && /^https:\/\/img\.clerk\.com\/[\w.~+/=%-]+$/.test(hint.m) ? hint.m : null;
    // A CSS string: quoted, with quotes, backslashes and line breaks escaped, so it never becomes anything else.
    const css = (text: string) => '"' + text.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, " ") + '"';
    const root = doc.documentElement;
    root.style.setProperty("--hint-initials", css(initials));
    root.style.setProperty("--hint-files", css(view.f));
    if (image) {
      // As avatarSrc(): the very address the avatar loads once Clerk is up, so it comes from the cache.
      root.style.setProperty("--hint-image", 'url("' + image + '?width=160")');
      root.setAttribute("data-hint-image", "");
    }
    if (view.p === true) root.setAttribute("data-hint-pro", "");
    if (view.l === true) root.setAttribute("data-hint-files-locked", "");
    root.setAttribute("data-hint", "in");
  } catch {
    // Not a hint: the visitor's page.
  }
}

/** The inline <head> script of the root layout. */
export const HINT_SCRIPT = `(${applyHint.toString()})(document, ${JSON.stringify(HINT_COOKIE)})`;
