"use client";

import { useSyncExternalStore } from "react";
import type { SummaryResponse } from "@/src/files/web-types";

/**
 * Client state shared by every Vlastní zdroje surface — the header's
 * account menu, the nav item, the home page group and the modals — so one
 * summary fetch serves them all and they never disagree.
 *
 *   auth      from Clerk (the bridge in ./clerk-bridge.tsx reports it); "none"
 *             when Clerk is not configured on this deployment
 *   summary   GET /api/files/summary, loaded once signed in and refreshed
 *             after anything that changes counts (upload, delete, accept…)
 *   clerk     actions registered by the bridge (sign in, profile, sign out),
 *             so components outside ClerkProvider's hooks can call them
 *
 * The modals are driven by the URL (?zdroje=moje|tym, ?tym=1): links work,
 * the back button closes them. history.pushState integrates with Next's
 * router, so useSearchParams sees the change without a navigation.
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
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER_STATE: State = { auth: "loading", summary: null, failed: false };

/** The shared state (server render: loading). */
export function useZdroje(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
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
      if (body && typeof body === "object" && "state" in body) set({ summary: body, failed: false });
      else set({ failed: true });
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

export type SourcesTab = "moje" | "tym";

/** A modal this page opened with pushState is closed with history.back(), so Back never reopens it. */
let pushedModal = false;
if (typeof window !== "undefined") {
  // The user went back (or forward) on their own: the entry we pushed is no longer ours to pop.
  window.addEventListener("popstate", () => {
    pushedModal = false;
  });
}

function pushParams(update: (p: URLSearchParams) => void, replace = false): void {
  const url = new URL(window.location.href);
  update(url.searchParams);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState(window.history.state, "", next);
  else window.history.pushState(window.history.state, "", next);
}

/** Open the Vlastní zdroje modal on a tab (and optionally a document's detail). Signed out: sign in first. */
export function openSources(tab: SourcesTab = "moje", documentId?: string): void {
  if (state.auth === "signed_out") {
    requestSignIn();
    return;
  }
  const already = new URLSearchParams(window.location.search).has("zdroje");
  pushParams(
    (p) => {
      p.set("zdroje", tab);
      p.delete("tym");
      if (documentId) p.set("dokument", documentId);
      else p.delete("dokument");
    },
    already,
  );
  if (!already) pushedModal = true;
}

/** Switch tab / document inside an open modal without adding history entries. */
export function showInSources(tab: SourcesTab, documentId: string | null): void {
  pushParams((p) => {
    p.set("zdroje", tab);
    if (documentId) p.set("dokument", documentId);
    else p.delete("dokument");
  }, true);
}

function closeModal(keys: string[]): void {
  if (pushedModal) {
    pushedModal = false;
    window.history.back();
    return;
  }
  pushParams((p) => {
    for (const k of keys) p.delete(k);
  }, true);
}

export function closeSources(): void {
  closeModal(["zdroje", "dokument"]);
}

/** Open the team management modal (for the admin of `orgId`, or the first team administered). */
export function openTeam(orgId?: string): void {
  const params = new URLSearchParams(window.location.search);
  const replace = params.has("zdroje") || params.has("tym");
  pushParams((p) => {
    p.delete("zdroje");
    p.delete("dokument");
    p.set("tym", orgId ?? "1");
  }, replace);
  if (!replace) pushedModal = true;
}

export function closeTeam(): void {
  closeModal(["tym"]);
}
