"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/app/_icons";
import { DOC_TYPES, type DocStatus, type DocType } from "@/src/files/types";
import type { DocumentDetail, DocumentListItem, DocumentListResponse, FolderItem } from "@/src/files/web-types";
import { api, NETWORK_ERROR } from "./api";
import { downloadFileName, typeLabel } from "./format";
import { compactFields, formFromMeta, lineToList, listToLine, MAIN_DOC_TYPES, payloadFromForm, type FieldDef, type FieldWidth, type FormValues } from "./meta-form";
import { refreshSummary } from "./store";

/**
 * The pieces of a library the Vlastní soubory page (app/soubory) is built
 * from: the document list of one library with its folders (polling while a
 * file is processed), and the metadata form of one document (type switch
 * saved at once, a short form per type saved with Uložit, Stáhnout text and
 * Smazat dokument at its end).
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

// ---------------------------------------------------------------------------
// The detail panel's form: type and metadata (deleting is in the row's ⋯ menu)

const WIDTH_CLASS: Record<FieldWidth, string> = { full: "w-full", wide: "w-wide", half: "w-half", mid: "w-mid", narrow: "w-narrow" };

export function FileEditor({
  doc: item,
  readonly,
  onChanged,
  onDeleted,
  onSaved,
  onClose,
}: {
  doc: DocumentListItem;
  readonly: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onSaved: (detail: DocumentDetail) => void;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<"type" | "save" | "export" | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    void (async () => {
      try {
        const res = await api<DocumentDetail>(`/api/files/documents/${encodeURIComponent(item.id)}`, { signal: ctrl.signal });
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        setDoc(res.data);
        setValues(formFromMeta(res.data.meta));
        setFieldErrors({});
        setConflict(false);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [item.id, reload]);

  if (loadError) {
    return (
      <div className="zd-file-open">
        <p className="zd-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="zd-file-open">
        <p className="zd-progress" role="status">
          <span className="zd-spinner" aria-hidden="true" />
          Načítám…
        </p>
      </div>
    );
  }

  const settled = doc.status === "review" || doc.status === "ready";
  const editable = doc.canEdit && !readonly && settled;
  const docType = (values.doc_type as DocType) || doc.meta.doc_type;

  function failed(res: { status: number; error: string; body: { fields?: Record<string, string> } | null }) {
    if (res.status === 409) setConflict(true);
    if (res.body?.fields) setFieldErrors(res.body.fields);
    setMessage({ ok: false, text: res.error });
  }

  /** The type is saved at once — over the stored metadata, so unsaved field edits stay in the form only. */
  async function changeType(next: DocType) {
    if (!doc || next === docType) return;
    setBusy("type");
    setMessage(null);
    setFieldErrors({});
    const previous = docType;
    setValues((v) => ({ ...v, doc_type: next }));
    const res = await api<DocumentDetail>(`/api/files/documents/${doc.id}`, {
      method: "PATCH",
      json: { action: "save", version: doc.metaVersion, meta: payloadFromForm({ ...formFromMeta(doc.meta), doc_type: next }) },
    });
    setBusy(null);
    if (res.ok) {
      setDoc(res.data);
      onSaved(res.data);
      return;
    }
    setValues((v) => ({ ...v, doc_type: previous }));
    failed(res);
  }

  async function save() {
    if (!doc) return;
    setBusy("save");
    setMessage(null);
    setFieldErrors({});
    // "confirm": the metadata must be complete (a commentary keeps its act); a file in review becomes searchable.
    const res = await api<DocumentDetail>(`/api/files/documents/${doc.id}`, {
      method: "PATCH",
      json: { action: "confirm", version: doc.metaVersion, meta: payloadFromForm(values) },
    });
    setBusy(null);
    if (res.ok) {
      setDoc(res.data);
      setValues(formFromMeta(res.data.meta));
      setMessage({ ok: true, text: "Uloženo." });
      onSaved(res.data);
      void refreshSummary();
      return;
    }
    failed(res);
  }

  /** Download the stored text (GET …/export): fetched first, so a refusal shows its Czech message here. */
  async function exportText() {
    if (!doc) return;
    setBusy("export");
    setMessage(null);
    try {
      const res = await fetch(`/api/files/documents/${encodeURIComponent(doc.id)}/export?lib=${encodeURIComponent(doc.libraryId)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setMessage({ ok: false, text: typeof body?.error === "string" ? body.error : "Text se nepodařilo stáhnout. Zkuste to prosím znovu." });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadFileName(res.headers.get("content-disposition"), "dokument.md");
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setMessage({ ok: false, text: NETWORK_ERROR });
    } finally {
      setBusy(null);
    }
  }

  const otherTypes = DOC_TYPES.filter((t) => !MAIN_DOC_TYPES.includes(t));
  const other = !MAIN_DOC_TYPES.includes(docType);

  return (
    <form
      className="zd-file-open"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {settled ? (
        <fieldset className="zd-file-fields" disabled={!editable || busy !== null}>
          <div className="zd-file-type">
            <span className="zd-file-label" id={`typ-${doc.id}`}>
              Typ
            </span>
            <div className="zd-segmented-pill" role="radiogroup" aria-labelledby={`typ-${doc.id}`}>
              {MAIN_DOC_TYPES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={docType === t} onClick={() => void changeType(t)}>
                  {typeLabel(t)}
                </button>
              ))}
              <select
                aria-label="Jiný typ"
                data-checked={other || undefined}
                value={other ? docType : ""}
                onChange={(e) => e.target.value && void changeType(e.target.value as DocType)}
              >
                {other ? null : <option value="">Jiný typ</option>}
                {otherTypes.map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            <span className="zd-file-hint">
              <Icon name="sparkles" size={13} />
              Změna typu se uloží hned.
            </span>
          </div>
          <div className="zd-file-grid">
            {compactFields(docType).map(({ field, width }) => (
              <CompactField
                key={field.key + field.label}
                field={field}
                width={width}
                value={values[field.key] ?? ""}
                error={fieldErrors[field.key] ?? null}
                onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {!doc.canEdit && settled ? (
        <p className="zd-muted zd-small">Režim Pro tu už není aktivní: údaje upravit nejde. Text si můžete stáhnout a soubor smazat.</p>
      ) : readonly && settled ? (
        <p className="zd-muted zd-small">Vlastní soubory jsou teď jen pro čtení — údaje upravit nejde.</p>
      ) : null}
      {message ? (
        <p className={message.ok ? "zd-ok-line" : "zd-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
          {conflict ? (
            <>
              {" "}
              <button
                type="button"
                className="zd-link-button"
                onClick={() => {
                  setMessage(null);
                  setReload((r) => r + 1);
                  onChanged();
                }}
              >
                Načíst znovu
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="zd-file-actions">
        {editable ? (
          <>
            <button type="submit" className="zd-btn zd-btn-primary" disabled={busy !== null}>
              {busy === "save" ? "Ukládám…" : "Uložit"}
            </button>
            <button
              type="button"
              className="zd-btn zd-btn-secondary"
              disabled={busy !== null}
              onClick={() => {
                setValues(formFromMeta(doc.meta));
                setFieldErrors({});
                setMessage(null);
                onClose();
              }}
            >
              Zrušit
            </button>
          </>
        ) : null}
        <span className="zd-file-actions-end">
          {doc.canDelete && settled ? (
            // Who may download is who may delete (the owner) — Pro not required, as the export route checks.
            <button type="button" className="zd-link-button" onClick={() => void exportText()} disabled={busy !== null}>
              {busy === "export" ? "Stahuji…" : "Stáhnout text"}
            </button>
          ) : null}
        </span>
      </div>
    </form>
  );
}

function CompactField({
  field,
  width,
  value,
  error,
  onChange,
}: {
  field: FieldDef;
  width: FieldWidth;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const list = field.kind === "list";
  return (
    <label className={`zd-field zd-file-field ${WIDTH_CLASS[width]}`} data-error={error ? true : undefined}>
      <span>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      {field.kind === "select" ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea rows={3} maxLength={600} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          type="text"
          value={list ? listToLine(value) : value}
          placeholder={field.placeholder}
          inputMode={field.kind === "year" ? "numeric" : undefined}
          maxLength={field.kind === "year" ? 4 : list ? 1_200 : 400}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(list ? lineToList(e.target.value) : e.target.value)}
        />
      )}
      {error ? <small className="zd-field-error">{error}</small> : null}
    </label>
  );
}
