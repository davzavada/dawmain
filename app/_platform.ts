"use client";

import { useSyncExternalStore } from "react";

/**
 * Which assistant the setup guide shows. The guide's picker and the sidebar's
 * "Návod pro" links both read and set it, so it lives here rather than in
 * either component. It is mirrored in the URL hash (#claude, #chatgpt), so a
 * shared link opens the right guide.
 */

export const PLATFORM_IDS = ["claude", "chatgpt"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

let current: PlatformId = "claude";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function isPlatform(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

export function setPlatform(id: PlatformId) {
  current = id;
  history.replaceState(null, "", `#${id}`);
  notify();
}

/** Adopt the platform a hash names; true when it named one. */
export function platformFromHash(): boolean {
  const hash = window.location.hash.slice(1);
  if (!isPlatform(hash)) return false;
  if (hash !== current) {
    current = hash;
    notify();
  }
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePlatform(): PlatformId {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => "claude",
  );
}
