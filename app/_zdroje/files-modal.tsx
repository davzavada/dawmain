"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/app/_icons";
import { CONTACT } from "@/app/_legal";
import { DOC_TYPES, type DocStatus, type DocType } from "@/src/files/types";
import type { DocumentDetail, DocumentListItem, DocumentListResponse, LibrarySummary } from "@/src/files/web-types";
import { api, NETWORK_ERROR } from "./api";
import { Confirm, Dialog } from "./dialog";
import { downloadFileName, fileLine, remainingLine, statusBadge, typeLabel } from "./format";
import { ZIcon } from "./icons";
import { compactFields, formFromMeta, lineToList, listToLine, MAIN_DOC_TYPES, payloadFromForm, type FieldDef, type FieldWidth, type FormValues } from "./meta-form";
import { closeFiles, refreshSummary, requestSignIn, showFile, useZdroje } from "./store";

/**
 * The Vlastní soubory modal (wireframe 04, 05), opened by ZdrojeModals
 * (./modals.tsx) from ?soubory=1. One library, the user's own: the drop
 * zone on top, the list of files under it. A new file is converted in the
 * browser and posted; the server converts it further and the AI proposes
 * its type and metadata — the row just spins ("Zpracovávám…") until the
 * type badge appears. Clicking a row opens it in place (&dokument=<id>):
 * the type switch (Komentář / Článek / Kniha, the rest under "Jiný typ"),
 * saved at once, and a short form per type saved with Uložit; Smazat
 * dokument and Stáhnout text sit at its end.
 *
 * The uploader — and with it the DMD parser — loads only where someone may
 * upload.
 */

const Uploader = dynamic(() => import("./upload").then((m) => m.Uploader), {
  ssr: false,
  loading: () => (
    <p className="zd-progress" role="status">
      <span className="zd-spinner" aria-hidden="true" />
      Načítám nahrávání…
    </p>
  ),
});

const MAIL_PRO = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - Vlastní soubory (Pro)")}`;
const SUBTITLE = "Dokumenty, ve kterých asistent hledá vedle oficiálních databází.";

export function FilesModal({ documentId }: { documentId: string | null }) {
  const { auth, summary, failed } = useZdroje();
  const library = summary?.state === "ok" ? (summary.libraries.find((l) => l.kind === "user") ?? null) : null;
  const mode = summary?.state === "ok" ? summary.mode : "off";
  const subtitle =
    library?.pro && library.pagesUsed !== null ? `${SUBTITLE} ${remainingLine(library.pagesUsed, library.quotaPages)}` : SUBTITLE;

  let body: ReactNode;
  if (auth === "none") {
    body = <Notice title="Vlastní soubory tu nejsou k dispozici" text="Na tomto nasazení není zapnuté přihlašování." />;
  } else if (auth === "signed_out") {
    body = (
      <Notice title="Přihlaste se" text="Vlastní soubory patří k vašemu účtu. Po přihlášení je uvidíte tady.">
        <button type="button" className="zd-btn zd-btn-primary" onClick={requestSignIn}>
          Přihlásit se
        </button>
      </Notice>
    );
  } else if (!summary) {
    body = failed ? (
      <Notice title="Vlastní soubory se nepodařilo načíst" text="Zkuste to prosím za chvíli.">
        <button type="button" className="zd-btn zd-btn-secondary" onClick={() => void refreshSummary()}>
          Zkusit znovu
        </button>
      </Notice>
    ) : (
      <Loading text="Načítám…" />
    );
  } else if (summary.state === "unavailable") {
    body = <Notice title="Vlastní soubory jsou teď vypnuté" text="Oficiální databáze fungují dál. Zkuste to prosím později." />;
  } else if (summary.state === "signed_out" || !library) {
    body = <Notice title="Přihlaste se" text="Vlastní soubory patří k vašemu účtu." />;
  } else {
    body = <Library key={library.id} lib={library} mode={mode} openId={documentId} />;
  }

  return (
    <Dialog
      title="Vlastní soubory"
      subtitle={subtitle}
      size="medium"
      onClose={closeFiles}
      footer={
        <button type="button" className="zd-btn zd-btn-primary zd-done" onClick={closeFiles}>
          Hotovo
        </button>
      }
    >
      {body}
    </Dialog>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="zd-locked">
      <span className="zd-locked-icon" aria-hidden="true">
        <ZIcon name="lock" size={18} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <p className="zd-progress zd-pad" role="status">
      <span className="zd-spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The library: upload on top, the files under it

const PENDING: ReadonlySet<DocStatus> = new Set(["queued", "processing"]);
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

  return { documents, setDocuments, total, error, reload };
}

function Library({ lib, mode, openId }: { lib: LibrarySummary; mode: string; openId: string | null }) {
  const { documents, setDocuments, total, error, reload } = useDocumentList(lib.id);
  const readonly = mode !== "on";
  const hasDocs = (documents?.length ?? 0) > 0;

  if (!lib.pro && !hasDocs) {
    if (documents === null && !error) return <Loading text="Načítám…" />;
    return (
      <Notice
        title="Vlastní soubory přiděluji ručně a zdarma"
        text="Nahrajete knihy, články, komentáře a vzory; převedou se na text přímo ve vašem prohlížeči. Asistent v nich pak hledá vedle oficiálních databází."
      >
        <a className="zd-btn zd-btn-primary" href={MAIL_PRO}>
          Napsat o přístup
        </a>
      </Notice>
    );
  }

  return (
    <div className="zd-files">
      {!lib.pro ? (
        <p className="zd-banner">Režim Pro tu už není aktivní. Soubory můžete smazat nebo si stáhnout jejich text, nové nahrát nejde.</p>
      ) : mode === "readonly" ? (
        <p className="zd-banner">Vlastní soubory jsou teď jen pro čtení: hledat, číst a mazat jde, nahrávat ne. Zkuste to později.</p>
      ) : mode === "off" ? (
        <p className="zd-banner">Vlastní soubory jsou teď dočasně vypnuté. Mazat soubory jde dál.</p>
      ) : null}
      {lib.pro && lib.canUpload && mode === "on" ? (
        <Uploader
          library={lib}
          onUploaded={() => {
            reload();
            void refreshSummary();
          }}
        />
      ) : null}
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : documents ? (
        <FileList
          documents={documents}
          total={total}
          openId={openId}
          readonly={readonly}
          onChanged={reload}
          onDeleted={(id) => {
            setDocuments((list) => list?.filter((d) => d.id !== id) ?? list);
            if (openId === id) showFile(null);
            reload();
            void refreshSummary();
          }}
          onSaved={(detail) => setDocuments((list) => list?.map((d) => (d.id === detail.id ? { ...d, ...pickListFields(detail) } : d)) ?? list)}
        />
      ) : (
        <Loading text="Načítám soubory…" />
      )}
    </div>
  );
}

/** The list fields of a saved detail, so the row shows the new title and type at once. */
function pickListFields(d: DocumentDetail): Partial<DocumentListItem> {
  return { title: d.title, docType: d.docType, publication: d.publication, status: d.status, statusDetail: d.statusDetail };
}

// ---------------------------------------------------------------------------
// The list

function FileList({
  documents,
  total,
  openId,
  readonly,
  onChanged,
  onDeleted,
  onSaved,
}: {
  documents: DocumentListItem[];
  total: number;
  openId: string | null;
  readonly: boolean;
  onChanged: () => void;
  onDeleted: (id: string) => void;
  onSaved: (detail: DocumentDetail) => void;
}) {
  return (
    <section className="zd-files-list" aria-label="Soubory">
      <div className="zd-files-head">
        <span>Soubory</span>
        <span className="zd-files-count">{total}</span>
      </div>
      {documents.length === 0 ? <p className="zd-empty">Zatím tu nic není.</p> : null}
      <ul>
        {documents.map((doc) => (
          <FileRow
            key={doc.id}
            doc={doc}
            open={openId === doc.id}
            readonly={readonly}
            onChanged={onChanged}
            onDeleted={() => onDeleted(doc.id)}
            onSaved={onSaved}
          />
        ))}
      </ul>
    </section>
  );
}

/** Badge colours per type (wireframe 04): komentář indigo, článek teal, kniha amber, the rest neutral. */
const TYPE_TONE: Partial<Record<DocType, string>> = { komentar: "indigo", clanek: "teal", kniha: "amber" };

function FileRow({
  doc,
  open,
  readonly,
  onChanged,
  onDeleted,
  onSaved,
}: {
  doc: DocumentListItem;
  open: boolean;
  readonly: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onSaved: (detail: DocumentDetail) => void;
}) {
  const pending = PENDING.has(doc.status) || doc.status === "deleting";
  if (pending) {
    return (
      <li className="zd-file" data-pending="true">
        <div className="zd-file-row">
          <Icon name="book" />
          <span className="zd-file-text">
            <span className="zd-file-title">{doc.title}</span>
            <span className="zd-file-line">{doc.status === "deleting" ? "Mažu…" : "Zpracovávám…"}</span>
          </span>
          <span className="zd-spinner zd-file-spinner" role="status" aria-label="Zpracovávám" />
        </div>
      </li>
    );
  }
  const failed = doc.status === "error";
  return (
    <li className="zd-file" data-open={open || undefined}>
      <button type="button" className="zd-file-row" aria-expanded={open} onClick={() => showFile(open ? null : doc.id)}>
        <Icon name="book" />
        <span className="zd-file-text">
          <span className="zd-file-title">{doc.title}</span>
          {failed ? (
            <span className="zd-file-line zd-file-line-bad">
              {statusBadge(doc.status, doc.statusDetail).label}
              {doc.statusDetail ? ` · ${doc.statusDetail}` : ""}
            </span>
          ) : (
            <span className="zd-file-line">{fileLine(doc, open ? doc.uploadedAt : undefined)}</span>
          )}
        </span>
        {failed ? null : (
          <span className="zd-type-badge" data-tone={TYPE_TONE[doc.docType] ?? "neutral"}>
            {typeLabel(doc.docType)}
          </span>
        )}
        <ZIcon name="chevron" className="zd-file-chevron" />
      </button>
      {open ? <FileEditor doc={doc} readonly={readonly} onChanged={onChanged} onDeleted={onDeleted} onSaved={onSaved} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The open row: type, metadata, delete

const WIDTH_CLASS: Record<FieldWidth, string> = { full: "w-full", wide: "w-wide", half: "w-half", mid: "w-mid", narrow: "w-narrow" };

function FileEditor({
  doc: item,
  readonly,
  onChanged,
  onDeleted,
  onSaved,
}: {
  doc: DocumentListItem;
  readonly: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onSaved: (detail: DocumentDetail) => void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<"type" | "save" | "delete" | "export" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const aiType = !doc.confirmedAt && doc.proposed?.doc_type?.source === "ai" && doc.proposed.doc_type.value === doc.meta.doc_type;

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

  async function remove() {
    if (!doc) return;
    setBusy("delete");
    const res = await api(`/api/files/documents/${doc.id}`, { method: "DELETE" });
    setBusy(null);
    setConfirmDelete(false);
    if (!res.ok && res.status !== 404) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    onDeleted();
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
      {doc.status === "error" && doc.statusDetail ? <p className="zd-error">{doc.statusDetail}</p> : null}
      {doc.status === "review" ? <p className="zd-banner zd-banner-info">Zkontrolujte údaje a uložte je. Dokud je neuložíte, asistent v souboru nehledá.</p> : null}
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
              {aiType ? "Zařadila AI při nahrání. Změna se uloží hned." : "Změna typu se uloží hned."}
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
                showFile(null);
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
          {doc.canDelete ? (
            // Pro not required: whoever owns the text may delete it, also after Pro was withdrawn.
            <button type="button" className="zd-link-button zd-danger-link" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
              Smazat dokument
            </button>
          ) : null}
        </span>
      </div>
      {confirmDelete ? (
        <Confirm
          question={<>Smazat „{doc.title}“? Text i index se odstraní natrvalo.</>}
          confirmLabel="Smazat"
          busy={busy === "delete"}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
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
