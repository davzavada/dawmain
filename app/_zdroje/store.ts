"use client";

import { useSyncExternalStore } from "react";
import type { SummaryResponse } from "@/src/files/web-types";
import { hintCookie, readHint, type Hint } from "./hint";

/**
 * Client state shared by every Vlastní soubory surface — the header's
 * account menu, the home page group and the modals — so one
 * summary fetch serves them all and they never disagree.
 *
 *   auth      from Clerk (the bridge in ./clerk-bridge.tsx reports it); "none"
 *             when Clerk is not configured on this deployment
 *   summary   GET /api/files/summary, loaded once signed in and refreshed
 *             after anything that changes counts (upload, delete, accept…)
 *   clerk     actions registered by the bridge (sign in, profile, sign out),
 *             so components outside ClerkProvider's hooks can call them
 *
 * Until Clerk has loaded, auth is "loading": the header and the home page
 * group then render both the visitor's and the signed-in variant and the
 * sign-in hint (./hint.ts — a cookie applied before the first paint)
 * decides which one shows, so nothing jumps. Once Clerk says signed in, the
 * hint's summary stands in until the real one arrives; the store keeps
 * that cookie up to date.
 *
 * The modals are driven by the URL (?soubory=1, ?zotero=1): links work,
 * the back button closes them. history.pushState integrates with Next's
 * router, so useSearchParams sees the change without a navigation — but
 * only when called with our own state (null): Next ignores a call whose
 * state carries its internal marker (__NA), as window.history.state does.
 */

export type AuthState = "loading" | "signed_in" | "signed_out" | "none";

interface State {
  auth: AuthState;
  summary: SummaryResponse | null;
  /** The last summary fetch failed (network, 503). */
  failed: boolean;
}

let state: State = { auth: "loading", summary: null, failed: false };
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  const before = state;
  state = { ...state, ...patch };
  if (state.auth !== before.auth || state.summary !== before.summary) writeHint();
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// The sign-in hint (see ./hint.ts)

/** The hint as this page load found it (undefined: not read yet). Browser only. */
let loadedHint: Hint | null | undefined;

function pageHint(): Hint | null {
  if (loadedHint === undefined) {
    try {
      loadedHint = typeof document === "undefined" ? null : readHint(document.cookie);
    } catch {
      loadedHint = null;
    }
  }
  return loadedHint;
}

let hintInitials: string | null = null;

/** The account menu reports the signed-in user's initials for the next page load. */
export function rememberInitials(initials: string): void {
  if (initials === hintInitials) return;
  hintInitials = initials;
  writeHint();
}

function writeHint(): void {
  if (typeof document === "undefined" || state.auth === "loading") return;
  try {
    const secure = window.location.protocol === "https:";
    if (state.auth !== "signed_in") {
      document.cookie = hintCookie(null, secure);
      return;
    }
    const summary = state.summary?.state === "ok" || state.summary?.state === "unavailable" ? state.summary : null;
    // Before the initials and the summary are known there is nothing new to keep.
    if (hintInitials === null && summary === null) return;
    document.cookie = hintCookie({ initials: hintInitials ?? "?", summary }, secure);
  } catch {
    // Cookies blocked: the page just loads the way it did before the hint.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER_STATE: State = { auth: "loading", summary: null, failed: false };

/**
 * The shared state (server render and hydration: loading). Signed in and
 * still loading the summary, it shows the one the sign-in hint remembered —
 * what the page already showed before Clerk loaded.
 */
export function useZdroje(): State {
  const real = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  if (real.auth === "signed_in" && real.summary === null && !real.failed) {
    const hinted = pageHint()?.summary;
    if (hinted) return { ...real, summary: hinted };
  }
  return real;
}

/** The remembered initials while Clerk's user is not loaded yet (signed in only, so never during hydration). */
export function useHintInitials(): string | null {
  return pageHint()?.initials ?? null;
}

/** Tests: forget the hint read from the cookie, so the next read sees the current one. */
export function rereadHint(): void {
  loadedHint = undefined;
}

let inflight: Promise<void> | null = null;
let again: { fresh: boolean } | null = null;

/** (Re)load the summary; concurrent calls coalesce into one follow-up fetch. */
export function refreshSummary(opts: { fresh?: boolean } = {}): Promise<void> {
  if (state.auth !== "signed_in") return Promise.resolve();
  if (inflight) {
    again = { fresh: (again?.fresh ?? false) || opts.fresh === true };
    return inflight;
  }
  inflight = (async () => {
    try {
      const url = opts.fresh ? "/api/files/summary?fresh=1" : "/api/files/summary";
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      const body = (await res.json().catch(() => null)) as SummaryResponse | null;
      if (body && typeof body === "object" && "state" in body) {
        set({ summary: body, failed: false });
        followProcessing(body);
      } else set({ failed: true });
    } catch {
      set({ failed: true });
    } finally {
      inflight = null;
      if (again) {
        const next = again;
        again = null;
        void refreshSummary(next);
      }
    }
  })();
  return inflight;
}

// While a library has documents in processing, refresh the summary until they settle, so the
// home page badge and the counts do not stay on "zpracovává se" when the modal is closed
// (the modal's list polls on its own). Backs off 5 s → 60 s; a hidden tab waits until visible.
const FOLLOW_START_MS = 5_000;
const FOLLOW_MAX_MS = 60_000;
let followTimer: ReturnType<typeof setTimeout> | null = null;
let followDelay = FOLLOW_START_MS;

function followProcessing(summary: SummaryResponse): void {
  if (followTimer !== null) clearTimeout(followTimer);
  followTimer = null;
  const processing = summary.state === "ok" && summary.libraries.some((l) => (l.counts?.processing ?? 0) > 0);
  if (!processing || typeof window === "undefined") {
    followDelay = FOLLOW_START_MS;
    return;
  }
  followTimer = setTimeout(() => {
    followTimer = null;
    followDelay = Math.min(FOLLOW_MAX_MS, Math.round(followDelay * 1.5));
    if (document.visibilityState === "visible") void refreshSummary();
    else document.addEventListener("visibilitychange", () => void refreshSummary(), { once: true });
  }, followDelay);
}

/** The bridge reports Clerk's session state. */
export function setAuth(auth: AuthState): void {
  if (auth === state.auth) return;
  set({ auth, summary: auth === "signed_in" ? state.summary : null, failed: false });
  if (auth === "signed_in") void refreshSummary();
}

// ---------------------------------------------------------------------------
// Clerk actions (registered by the bridge)

export interface ClerkActions {
  signIn(): void;
  manageAccount(): void;
  signOut(): void;
}

let actions: ClerkActions | null = null;

export function registerClerkActions(next: ClerkActions | null): void {
  actions = next;
}

/** Open Clerk's sign-in (back to this page afterwards); a no-op without Clerk. */
export function requestSignIn(): void {
  actions?.signIn();
}

export function manageAccount(): void {
  actions?.manageAccount();
}

export function signOut(): void {
  actions?.signOut();
}

// ---------------------------------------------------------------------------
// URL-driven modals

/**
 * The URL parameter of the Vlastní soubory modal (?soubory=1, + &dokument=<id> for the
 * row opened in the list). ?zdroje=… is its old name, still read so links keep working.
 */
export const FILES_PARAM = "soubory";
const LEGACY_FILES_PARAM = "zdroje";

function filesParamIn(p: URLSearchParams): boolean {
  return p.has(FILES_PARAM) || p.has(LEGACY_FILES_PARAM);
}

/** A modal this page opened with pushState is closed with history.back(), so Back never reopens it. */
let pushedModal = false;
/** The URL the Vlastní soubory modal was last shown at (null while it is closed), to restore it on a refused Back. */
let modalHref: string | null = null;
/** closeModal() is popping our own entry after the user already agreed: its popstate asks nothing. */
let closingByBack = false;

function hrefOf(loc: Location): string {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

function noteLocation(): void {
  modalHref = filesParamIn(new URLSearchParams(window.location.search)) ? hrefOf(window.location) : null;
}

/**
 * Back / Forward (the browser button, Android's back gesture) is a same-document history change:
 * nothing but this listener sees ?soubory disappear before ZdrojeModals unmounts the uploader, so a
 * conversion held only in memory would be lost without the question every other exit asks.
 * Refused: the modal's URL is pushed again, over the entry the user went back to, and stays open.
 * Registered at module load, before Next's own listener (app-router's effect), so Next's traverse
 * already reads the restored URL.
 */
function onPopState(): void {
  const previous = modalHref;
  const closing = closingByBack;
  closingByBack = false;
  // The user went back (or forward) on their own: the entry we pushed is no longer ours to pop.
  pushedModal = false;
  noteLocation();
  if (closing || modalHref !== null || previous === null) return;
  // Another page entirely: its content is already on its way, only the modal's own URL is guarded.
  if (new URL(previous, window.location.href).pathname !== window.location.pathname) return;
  if (!unsavedWork?.() || window.confirm(DISCARD_QUESTION)) return;
  window.history.pushState(null, "", previous);
  pushedModal = true;
  modalHref = previous;
}

if (typeof window !== "undefined") window.addEventListener("popstate", onPopState);

/** The URL with some search params changed (path and hash kept), as pushState takes it. */
export function withParams(href: string, update: (p: URLSearchParams) => void): string {
  const url = new URL(href);
  update(url.searchParams);
  return `${url.pathname}${url.search}${url.hash}`;
}

function pushParams(update: (p: URLSearchParams) => void, replace = false): void {
  const next = withParams(window.location.href, update);
  // State null, never window.history.state: that one is Next's own entry (__NA), and Next's
  // patched pushState/replaceState skip the router for it — the URL would change, the modal not.
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  noteLocation();
}

/** ZdrojeModals reports that the Vlastní soubory modal is open. */
export function setFilesOpen(open: boolean): void {
  // A deep link (or the /vlastni-zdroje redirect) opened it without pushParams.
  if (open && modalHref === null) noteLocation();
}

// ---------------------------------------------------------------------------
// Unsaved work: a finished conversion lives only in the uploader's memory.

let unsavedWork: (() => boolean) | null = null;

/** The uploader registers a check "is there a conversion or a queue to lose?" (null on unmount). */
export function registerUnsavedWork(check: (() => boolean) | null): void {
  unsavedWork = check;
}

export const DISCARD_QUESTION = "Zahodit rozpracovaný převod? Převedený text ani vybrané soubory se neuloží.";

/** Before anything that unmounts the uploader: true when nothing is lost or the user agreed to lose it. */
export function mayDiscardWork(): boolean {
  if (!unsavedWork?.()) return true;
  return window.confirm(DISCARD_QUESTION);
}

/** Open the Vlastní soubory modal (optionally with one document's row open). Signed out: sign in first. */
export function openFiles(documentId?: string): void {
  if (state.auth === "signed_out") {
    requestSignIn();
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const already = filesParamIn(params);
  if (already) {
    showFile(documentId ?? null);
    return;
  }
  const replace = params.has("zotero");
  pushParams((p) => {
    p.set(FILES_PARAM, "1");
    p.delete(LEGACY_FILES_PARAM);
    p.delete("zotero");
    p.delete("stav");
    if (documentId) p.set("dokument", documentId);
    else p.delete("dokument");
  }, replace);
  if (!replace) pushedModal = true;
}

/**
 * Open (or, with null, close) one document's row inside the open modal, without adding a
 * history entry: the URL keeps &dokument=<id>, so a reload or a copied link opens the same row.
 */
export function showFile(documentId: string | null): void {
  const p = new URLSearchParams(window.location.search);
  if ((p.get("dokument") ?? null) === documentId && p.has(FILES_PARAM)) return;
  pushParams((q) => {
    q.set(FILES_PARAM, "1");
    q.delete(LEGACY_FILES_PARAM);
    if (documentId) q.set("dokument", documentId);
    else q.delete("dokument");
  }, true);
}

function closeModal(keys: string[]): void {
  if (pushedModal) {
    pushedModal = false;
    closingByBack = true;
    window.history.back();
    return;
  }
  pushParams((p) => {
    for (const k of keys) p.delete(k);
  }, true);
}

export function closeFiles(): void {
  if (!mayDiscardWork()) return;
  closeModal([FILES_PARAM, LEGACY_FILES_PARAM, "dokument"]);
}

/**
 * Open the Zotero modal (?zotero=1). The connect flow comes back to the same URL
 * from the server, with &stav=<outcome> for the modal's banner.
 */
export function openZotero(): void {
  const params = new URLSearchParams(window.location.search);
  const files = filesParamIn(params);
  const replace = files || params.has("zotero");
  if (files && !mayDiscardWork()) return;
  pushParams((p) => {
    p.delete(FILES_PARAM);
    p.delete(LEGACY_FILES_PARAM);
    p.delete("dokument");
    p.delete("stav");
    p.set("zotero", "1");
  }, replace);
  if (!replace) pushedModal = true;
}

export function closeZotero(): void {
  closeModal(["zotero", "stav"]);
}

/**
 * The modal took the connect outcome into its banner: drop &stav from the URL
 * (replacing the entry), so a reload or a copied link does not announce it again.
 */
export function dropZoteroStav(): void {
  if (!new URLSearchParams(window.location.search).has("stav")) return;
  pushParams((p) => p.delete("stav"), true);
}
