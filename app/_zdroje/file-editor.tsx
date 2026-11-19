"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocStatus } from "@/src/files/types";
import type { DocumentListItem, DocumentListResponse, FolderItem } from "@/src/files/web-types";
import { api } from "./api";
import { refreshSummary } from "./store";

/**
 * The document list of one library with its folders, for the Vlastní
 * soubory page (app/soubory): polling while a file is processed.
 */

export const PENDING: ReadonlySet<DocStatus> = new Set(["queued", "processing"]);
export const POLL_START_MS = 4_000;
const POLL_MAX_MS = 15_000;

/** Next polling delay: ×1.5 per poll, capped. Pure (exported for tests). */
export function nextPollDelay(previous: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, Math.round(previous * 1.5)));
}

/**
 * The files of the library. While a file is still being processed the list
 * polls GET /api/files/status — only while the tab is visible, backing off
 * from 4 s to 15 s, and not at all once nothing is pending.
 */
export function useDocumentList(libraryId: string) {
  const [documents, setDocuments] = useState<DocumentListItem[] | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await api<DocumentListResponse>(`/api/files/documents?lib=${encodeURIComponent(libraryId)}`, { signal: ctrl.signal });
        if (res.ok) {
          setDocuments(res.data.documents);
          setFolders(res.data.folders ?? []);
          setTotal(res.data.total);
          setError(null);
        } else setError(res.error);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [libraryId, tick]);

  const pendingKey = (documents ?? [])
    .filter((d) => PENDING.has(d.status))
    .map((d) => d.id)
    .join(",");
  const delay = useRef(POLL_START_MS);
  useEffect(() => {
    if (!pendingKey) return;
    delay.current = POLL_START_MS;
    let timer: number | undefined;
    let stopped = false;
    const ids = pendingKey.split(",");
    async function poll() {
      if (stopped) return;
      if (document.visibilityState !== "visible") return; // resumed by visibilitychange
      const res = await api<{ documents: Array<{ id: string; status: DocStatus; status_detail: string | null }> }>(
        `/api/files/status?lib=${encodeURIComponent(libraryId)}&ids=${ids.join(",")}`,
      );
      if (stopped) return;
      if (res.ok) {
        const byId = new Map(res.data.documents.map((d) => [d.id, d]));
        if (ids.some((id) => !byId.get(id) || !PENDING.has(byId.get(id)!.status))) {
          reload();
          void refreshSummary();
          return;
        }
      }
      delay.current = nextPollDelay(delay.current);
      timer = window.setTimeout(poll, delay.current);
    }
    function onVisibility() {
      if (document.visibilityState === "visible" && !stopped) {
        window.clearTimeout(timer);
        delay.current = POLL_START_MS;
        void poll();
      }
    }
    timer = window.setTimeout(poll, delay.current);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pendingKey, libraryId, reload]);

  return { documents, setDocuments, folders, setFolders, total, error, reload };
}
