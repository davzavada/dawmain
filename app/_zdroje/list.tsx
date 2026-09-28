"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocStatus } from "@/src/files/types";
import type { DocumentListItem, DocumentListResponse } from "@/src/files/web-types";
import { api } from "./api";
import { Confirm } from "./dialog";
import { formatBytes, formatDate, kindLabel, statusBadge } from "./format";
import { ZIcon } from "./icons";
import { refreshSummary } from "./store";

/**
 * "Nahrané dokumenty N" — the list of one library (design 2b, 2d): title,
 * status badge, "PDF · 2,4 MB · 12. 9. 2026" (team: "· Jana Nováková,
 * 19. 9. 2026"), the on/off switch and the trash can with a confirmation.
 *
 * While a document is still being processed the list polls
 * GET /api/files/status — only while the tab is visible, backing off from
 * 4 s to 15 s, and not at all once nothing is pending.
 */

const PENDING: ReadonlySet<DocStatus> = new Set(["queued", "processing"]);
export const POLL_START_MS = 4_000;
const POLL_MAX_MS = 15_000;

/** Next polling delay: ×1.5 per poll, capped. Pure (exported for tests). */
export function nextPollDelay(previous: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, Math.round(previous * 1.5)));
}

export function useDocumentList(libraryId: string, reloadKey: number) {
  const [documents, setDocuments] = useState<DocumentListItem[] | null>(null);
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
          setTotal(res.data.total);
          setError(null);
        } else setError(res.error);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [libraryId, reloadKey, tick]);

  // Poll the statuses of pending documents while the page is visible.
  const pendingIds = (documents ?? []).filter((d) => PENDING.has(d.status)).map((d) => d.id);
  const pendingKey = pendingIds.join(",");
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
        const settled = ids.some((id) => {
          const s = byId.get(id);
          return !s || !PENDING.has(s.status);
        });
        if (settled) {
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

  return { documents, setDocuments, total, error, reload };
}

/** The meta line under a title: kind · size · (uploader, ) date. */
export function metaLine(doc: Pick<DocumentListItem, "fileKind" | "fileBytes" | "uploadedAt" | "uploaderName">, team: boolean, now = new Date()): string {
  const date = formatDate(doc.uploadedAt, now);
  const who = team && doc.uploaderName ? `${doc.uploaderName}, ${date}` : date;
  return [kindLabel(doc.fileKind), formatBytes(doc.fileBytes), who].filter(Boolean).join(" · ");
}

export function DocumentList({
  documents,
  total,
  team,
  readonly,
  onOpen,
  onChanged,
  setDocuments,
}: {
  documents: DocumentListItem[];
  total: number;
  team: boolean;
  /** The feature is read-only: no switch (delete still works). */
  readonly: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
  setDocuments: (update: (list: DocumentListItem[] | null) => DocumentListItem[] | null) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(doc: DocumentListItem) {
    const enabled = !doc.enabled;
    setError(null);
    setDocuments((list) => list?.map((d) => (d.id === doc.id ? { ...d, enabled } : d)) ?? list);
    const res = await api(`/api/files/documents/${doc.id}`, { method: "PATCH", json: { action: "enable", enabled } });
    if (!res.ok) {
      setDocuments((list) => list?.map((d) => (d.id === doc.id ? { ...d, enabled: !enabled } : d)) ?? list);
      setError(res.error);
    } else void refreshSummary();
  }

  async function remove(doc: DocumentListItem) {
    setBusy(doc.id);
    setError(null);
    const res = await api(`/api/files/documents/${doc.id}`, { method: "DELETE" });
    setBusy(null);
    setConfirming(null);
    if (!res.ok && res.status !== 404) {
      setError(res.error);
      return;
    }
    setDocuments((list) => list?.filter((d) => d.id !== doc.id) ?? list);
    onChanged();
    void refreshSummary();
  }

  return (
    <section className="zd-docs" aria-label="Nahrané dokumenty">
      <div className="zd-section-head">
        <span className="zd-section-name">Nahrané dokumenty</span>
        <span className="zd-section-count">{total}</span>
      </div>
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
      {documents.length === 0 ? <p className="zd-empty">Zatím tu nic není.</p> : null}
      <ul className="zd-doc-list">
        {documents.map((doc) => {
          const badge = statusBadge(doc.status, doc.statusDetail);
          const switchable = doc.canEdit && !readonly && (doc.status === "ready" || doc.status === "review");
          return (
            <li key={doc.id} className="zd-doc" data-disabled={!doc.enabled || undefined}>
              <div className="zd-doc-main">
                <button type="button" className="zd-doc-title" title={doc.title} onClick={() => onOpen(doc.id)}>
                  {doc.title}
                </button>
                <span className="zd-doc-meta">
                  <span className="zd-badge" data-tone={badge.tone}>
                    {badge.label}
                  </span>
                  <span className="zd-doc-line">{metaLine(doc, team)}</span>
                </span>
                {doc.status === "review" ? (
                  <span className="zd-doc-note">Zkontrolujte metadata — asistent v dokumentu hledá až po potvrzení.</span>
                ) : doc.status === "error" && doc.statusDetail ? (
                  <span className="zd-doc-note zd-doc-note-bad">{doc.statusDetail}</span>
                ) : null}
                {confirming === doc.id ? (
                  <Confirm
                    question={<>Smazat „{doc.title}“? Text i index se odstraní natrvalo.</>}
                    confirmLabel="Smazat"
                    busy={busy === doc.id}
                    onConfirm={() => void remove(doc)}
                    onCancel={() => setConfirming(null)}
                  />
                ) : null}
              </div>
              <div className="zd-doc-actions">
                {switchable ? (
                  <label className="zd-switch" title={doc.enabled ? "Zapnuto — asistent v dokumentu hledá" : "Vypnuto — asistent dokument přeskočí"}>
                    <input type="checkbox" role="switch" checked={doc.enabled} onChange={() => void toggle(doc)} aria-label={`Hledat v „${doc.title}“`} />
                    <span className="zd-switch-track" aria-hidden="true" />
                  </label>
                ) : null}
                {doc.canDelete ? (
                  <button
                    type="button"
                    className="zd-icon-button"
                    title="Smazat"
                    aria-label={`Smazat „${doc.title}“`}
                    onClick={() => setConfirming(doc.id)}
                    disabled={busy === doc.id}
                  >
                    <ZIcon name="trash" />
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
