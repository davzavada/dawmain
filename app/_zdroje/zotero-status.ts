"use client";

import { useEffect, useState } from "react";
import type { ZoteroStatus } from "@/src/zotero/web-types";
import { api } from "./api";

/**
 * The Zotero connection status for client components: the modal
 * (./zotero-modal.tsx) and the home page row (./own-sources.tsx). Both read
 * GET /api/zotero/status (contract: src/zotero/web-types.ts); the modal
 * announces a change it made (Odpojit) so the row does not keep showing a
 * connection that is gone.
 */

export const STATUS_URL = "/api/zotero/status";

/** The status route's answer, or null for anything else (an HTML error page, a proxy's JSON). */
export function asStatus(body: unknown): ZoteroStatus | null {
  if (!body || typeof body !== "object") return null;
  const state = (body as { state?: unknown }).state;
  return state === "signed_out" || state === "ok" ? (body as ZoteroStatus) : null;
}

const CHANGED = "dz-zotero-changed";

/** Tell every mounted useZoteroStatus that the connection changed (connected or removed). */
export function notifyZoteroChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/**
 * The status while `enabled` (a signed-in user on a deployment with Zotero):
 * undefined while loading, null when the server did not answer as it
 * should, the status otherwise. Refetches after notifyZoteroChanged().
 */
export function useZoteroStatus(enabled: boolean): ZoteroStatus | null | undefined {
  const [status, setStatus] = useState<ZoteroStatus | null | undefined>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(CHANGED, bump);
    return () => window.removeEventListener(CHANGED, bump);
  }, []);

  useEffect(() => {
    // Signed out: forget the last answer, so the next account never sees the previous one's.
    if (!enabled) {
      setStatus(undefined);
      return;
    }
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await api<unknown>(STATUS_URL, { signal: ctrl.signal });
        // api() can come back from an abort that landed while reading the body: ignore it.
        if (!ctrl.signal.aborted) setStatus(res.ok ? asStatus(res.data) : null);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [enabled, version]);

  return enabled ? status : undefined;
}
