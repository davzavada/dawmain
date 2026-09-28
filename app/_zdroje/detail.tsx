"use client";

import { useEffect, useState } from "react";
import { DOC_TYPE_LABELS, type DocType } from "@/src/files/types";
import type { DocumentDetail } from "@/src/files/web-types";
import { api, NETWORK_ERROR } from "./api";
import { Confirm } from "./dialog";
import { countPages, downloadFileName, formatCount, plural, statusBadge } from "./format";
import { ZIcon } from "./icons";
import { metaLine } from "./list";
import { DOC_TYPE_OPTIONS, formFromMeta, payloadFromForm, proposalBadge, splitFields, type FieldDef, type FormValues } from "./meta-form";
import { refreshSummary } from "./store";

/**
 * The detail panel of one document inside the modal: status and conversion
 * quality, the metadata read-only with a pencil to edit them (the form for
 * the document's type: the essential fields up front, the rest under
 * "Další údaje"; a source badge per proposed field, low-confidence fields
 * highlighted), Potvrdit (a library with the review step) / Uložit /
 * Nahrát znovu / Smazat, Exportovat text (the stored text as a Markdown
 * download — also after Pro was withdrawn), and the first ~1,500
 * characters of the text as plain text. Saves send the meta_version the form was loaded with; a
 * concurrent change answers 409 and the form offers to reload.
 */

const LABEL_SOURCES: Record<string, string> = {
  pdf_labels: "čísla stran z PDF",
  printed: "tištěná čísla stran",
  physical: "pořadí stran v PDF",
  none: "bez stran",
};

export function DocumentPanel({
  id,
  readonly,
  team,
  onBack,
  onReupload,
  onDeleted,
}: {
  id: string;
  /** The feature is read-only: no edits (delete still works). */
  readonly: boolean;
  team: boolean;
  onBack: () => void;
  /** creditPages: the pages the server credits when the new version replaces this one (review or ready). */
  onReupload: (doc: { id: string; title: string; libraryId: string; creditPages: number }) => void;
  onDeleted: () => void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState<"confirm" | "save" | "delete" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    void (async () => {
      try {
        const res = await api<DocumentDetail>(`/api/files/documents/${encodeURIComponent(id)}`, { signal: ctrl.signal });
        if (!res.ok) {
          setLoadError(res.error);
          return;
        }
        setDoc(res.data);
        setValues(formFromMeta(res.data.meta));
        setFieldErrors({});
        setConflict(false);
        // A document waiting for review opens straight in the form.
        setEditing(res.data.status === "review");
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [id, reload]);

  if (loadError) {
    return (
      <div className="zd-detail">
        <BackButton onBack={onBack} />
        <p className="zd-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="zd-detail">
        <BackButton onBack={onBack} />
        <p className="zd-progress" role="status">
          <span className="zd-spinner" aria-hidden="true" />
          Načítám dokument…
        </p>
      </div>
    );
  }

  const badge = statusBadge(doc.status, doc.statusDetail);
  const editable = doc.canEdit && !readonly && (doc.status === "review" || doc.status === "ready");
  const docType = (values.doc_type as DocType) || doc.meta.doc_type;
  const fields = splitFields(docType);

  async function save(action: "confirm" | "save") {
    if (!doc) return;
    setSaving(action);
    setMessage(null);
    setFieldErrors({});
    const res = await api<DocumentDetail>(`/api/files/documents/${doc.id}`, {
      method: "PATCH",
      json: { action, version: doc.metaVersion, meta: payloadFromForm(values) },
    });
    setSaving(null);
    if (res.ok) {
      setDoc(res.data);
      setValues(formFromMeta(res.data.meta));
      const confirmedNow = action === "confirm" && doc.status === "review";
      setMessage({ ok: true, text: confirmedNow ? "Potvrzeno — asistent v dokumentu teď hledá." : "Uloženo." });
      if (res.data.status === "ready") setEditing(false);
      void refreshSummary();
      return;
    }
    if (res.status === 409) setConflict(true);
    if (res.body?.fields) setFieldErrors(res.body.fields);
    setMessage({ ok: false, text: res.error });
  }

  async function remove() {
    if (!doc) return;
    setSaving("delete");
    const res = await api(`/api/files/documents/${doc.id}`, { method: "DELETE" });
    setSaving(null);
    setConfirmDelete(false);
    if (!res.ok && res.status !== 404) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    void refreshSummary();
    onDeleted();
  }

  /** Download the stored text (GET …/export): fetched first, so a refusal shows its Czech message here. */
  async function exportText() {
    if (!doc) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/files/documents/${encodeURIComponent(doc.id)}/export?lib=${encodeURIComponent(doc.libraryId)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setExportError(typeof body?.error === "string" ? body.error : "Text se nepodařilo stáhnout. Zkuste to prosím znovu.");
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
      setExportError(NETWORK_ERROR);
    } finally {
      setExporting(false);
    }
  }

  const q = doc.quality;
  const qualityItems = [
    doc.physicalPages ? `${countPages(doc.physicalPages)} v PDF` : null,
    `${formatCount(doc.billablePages)} ${plural(doc.billablePages, "účtovaná strana", "účtované strany", "účtovaných stran")}`,
    LABEL_SOURCES[doc.pageLabelSource] ?? null,
    q.footnotes === "none" ? "bez poznámek" : `poznámky: svázáno ${Math.round((q.linked_ratio ?? 0) * 100)} %`,
    q.mn > 0 ? `${formatCount(q.mn)} m. č.` : null,
    q.unsure_pages?.length ? `${formatCount(q.unsure_pages.length)} ${plural(q.unsure_pages.length, "sporná strana", "sporné strany", "sporných stran")}` : null,
    ...doc.flags,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="zd-detail">
      <BackButton onBack={onBack} />
      <div className="zd-detail-head">
        <h3 className="zd-detail-title">{doc.title}</h3>
        <span className="zd-doc-meta">
          <span className="zd-badge" data-tone={badge.tone}>
            {badge.label}
          </span>
          <span className="zd-doc-line">{metaLine(doc, team)}</span>
        </span>
        {doc.status === "review" ? (
          <p className="zd-banner zd-banner-info">Zkontrolujte a potvrďte metadata. Dokud je nepotvrdíte, asistent v dokumentu nehledá.</p>
        ) : null}
        {doc.status === "error" && doc.statusDetail ? <p className="zd-error">{doc.statusDetail}</p> : null}
        {doc.status === "queued" || doc.status === "processing" ? (
          <p className="zd-progress" role="status">
            <span className="zd-spinner" aria-hidden="true" />
            Dokument se zpracovává, metadata se doplní sama.
            <button type="button" className="zd-link-button" onClick={() => setReload((r) => r + 1)}>
              Obnovit
            </button>
          </p>
        ) : null}
        <p className="zd-quality">{qualityItems.join(" · ")}</p>
        <p className="zd-muted zd-small">
          Převodník {doc.converter} · knihovna {doc.libraryName}
        </p>
      </div>

      {(doc.status === "review" || doc.status === "ready") && !editing ? (
        <section className="zd-meta-view" aria-label="Metadata">
          <div className="zd-meta-view-head">
            <span className="zd-section-name">Metadata</span>
            {editable ? (
              <button type="button" className="zd-icon-button" onClick={() => setEditing(true)} aria-label="Upravit metadata" title="Upravit metadata">
                <ZIcon name="edit" size={16} />
              </button>
            ) : null}
          </div>
          <dl className="zd-meta-list">
            <div>
              <dt>Typ</dt>
              <dd>{DOC_TYPE_LABELS[doc.meta.doc_type]}</dd>
            </div>
            {[...fields.essential, ...fields.extra]
              .filter((f) => (values[f.key] ?? "").trim() !== "" && !(f.key === "language" && values[f.key] === "cs"))
              .map((f) => (
                <div key={f.key + f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.kind === "select" ? (f.options?.find(([v]) => v === values[f.key])?.[1] ?? values[f.key]) : (values[f.key] ?? "").split("\n").join(", ")}</dd>
                </div>
              ))}
          </dl>
          {message ? (
            <p className={message.ok ? "zd-ok-line" : "zd-error"} role={message.ok ? "status" : "alert"}>
              {message.text}
            </p>
          ) : null}
        </section>
      ) : null}

      {(doc.status === "review" || doc.status === "ready") && editing ? (
        <form
          className="zd-meta-form"
          onSubmit={(e) => {
            e.preventDefault();
            // A confirmed document is saved through "confirm" too: its metadata must stay complete (a commentary keeps its act).
            void save("confirm");
          }}
        >
          <fieldset disabled={!editable || saving !== null}>
            <legend className="zd-section-name">Metadata</legend>
            {!doc.canEdit ? (
              <p className="zd-muted zd-small">
                {doc.canDelete
                  ? "Režim Pro tu už není aktivní: metadata upravit nejde. Text můžete exportovat a dokument smazat."
                  : "Upravit je může ten, kdo dokument nahrál, nebo správce týmu."}
              </p>
            ) : null}
            {readonly ? <p className="zd-muted zd-small">Vlastní zdroje jsou teď jen pro čtení — metadata upravit nejde.</p> : null}
            <label className="zd-field">
              <span>Typ dokumentu</span>
              <select value={docType} onChange={(e) => setValues((v) => ({ ...v, doc_type: e.target.value }))}>
                {DOC_TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <SourceBadge doc={doc} field={{ key: "doc_type", label: DOC_TYPE_LABELS[docType], kind: "select" }} />
            </label>
            {fields.essential.map((field) => (
              <MetaField
                key={field.key + field.label}
                field={field}
                doc={doc}
                value={values[field.key] ?? ""}
                error={fieldErrors[field.key] ?? null}
                onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
              />
            ))}
            {fields.extra.length > 0 ? (
              <details className="zd-meta-extra" open={fields.extra.some((f) => fieldErrors[f.key]) || undefined}>
                <summary>Další údaje</summary>
                <div className="zd-meta-extra-grid">
                  {fields.extra.map((field) => (
                    <MetaField
                      key={field.key + field.label}
                      field={field}
                      doc={doc}
                      value={values[field.key] ?? ""}
                      error={fieldErrors[field.key] ?? null}
                      onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
                    />
                  ))}
                </div>
              </details>
            ) : null}
            {doc.meta.section_range ? (
              <p className="zd-muted zd-small">Rozsah komentáře podle textu: {doc.meta.section_range}</p>
            ) : null}
          </fieldset>
          {message ? (
            <p className={message.ok ? "zd-ok-line" : "zd-error"} role={message.ok ? "status" : "alert"}>
              {message.text}
              {conflict ? (
                <>
                  {" "}
                  <button type="button" className="zd-link-button" onClick={() => setReload((r) => r + 1)}>
                    Načíst znovu
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {editable ? (
            <div className="zd-card-actions zd-detail-actions">
              {doc.status === "review" ? (
                <>
                  <button type="button" className="zd-btn zd-btn-secondary" onClick={() => void save("save")} disabled={saving !== null}>
                    {saving === "save" ? "Ukládám…" : "Uložit"}
                  </button>
                  <button type="submit" className="zd-btn zd-btn-primary" disabled={saving !== null}>
                    {saving === "confirm" ? "Potvrzuji…" : "Potvrdit"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="zd-btn zd-btn-quiet"
                    disabled={saving !== null}
                    onClick={() => {
                      setValues(formFromMeta(doc.meta));
                      setFieldErrors({});
                      setMessage(null);
                      setEditing(false);
                    }}
                  >
                    Zrušit
                  </button>
                  <button type="submit" className="zd-btn zd-btn-primary" disabled={saving !== null}>
                    {saving === "confirm" ? "Ukládám…" : "Uložit"}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </form>
      ) : null}

      {doc.canEdit || doc.canDelete ? (
        <div className="zd-detail-more">
          {doc.canDelete && (doc.status === "review" || doc.status === "ready") ? (
            // Who may download is who may delete (uploader, owner/admin) — Pro not required, as the export route checks.
            <button type="button" className="zd-btn zd-btn-secondary" onClick={() => void exportText()} disabled={exporting}>
              <ZIcon name="download" size={14} /> {exporting ? "Stahuji…" : "Exportovat text"}
            </button>
          ) : null}
          {doc.canEdit && !readonly ? (
            <button type="button" className="zd-btn zd-btn-secondary" onClick={() =>
                onReupload({
                  id: doc.id,
                  title: doc.title,
                  libraryId: doc.libraryId,
                  creditPages: doc.status === "review" || doc.status === "ready" ? doc.billablePages : 0,
                })
              }>
              Nahrát znovu
            </button>
          ) : null}
          {doc.canDelete ? (
            // Pro not required: whoever owns the text may delete it, also after Pro was withdrawn.
            <button type="button" className="zd-btn zd-btn-danger-quiet" onClick={() => setConfirmDelete(true)} disabled={saving !== null}>
              <ZIcon name="trash" size={14} /> Smazat
            </button>
          ) : null}
          {exportError ? (
            <p className="zd-error zd-detail-note" role="alert">
              {exportError}
            </p>
          ) : null}
          {confirmDelete ? (
            <Confirm
              question={<>Smazat „{doc.title}“? Text i index se odstraní natrvalo.</>}
              confirmLabel="Smazat"
              busy={saving === "delete"}
              onConfirm={() => void remove()}
              onCancel={() => setConfirmDelete(false)}
            />
          ) : null}
        </div>
      ) : null}

      {doc.preview ? (
        <section className="zd-text-preview" aria-label="Začátek textu">
          <span className="zd-section-name">Začátek textu</span>
          <pre className="zd-page-text zd-page-text-solo">{doc.preview}</pre>
        </section>
      ) : null}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="zd-link-button zd-back" onClick={onBack}>
      <ZIcon name="back" size={14} /> Seznam dokumentů
    </button>
  );
}

function SourceBadge({ doc, field }: { doc: DocumentDetail; field: FieldDef }) {
  // Once confirmed, the values are the user's own: no proposal badges.
  if (doc.confirmedAt) return null;
  const badge = proposalBadge(doc.proposed, field.key);
  return badge ? (
    <span className="zd-source" data-low={badge.low || undefined} title={badge.low ? "Nejistý návrh — zkontrolujte" : undefined}>
      {badge.label}
    </span>
  ) : null;
}

function MetaField({
  field,
  doc,
  value,
  error,
  onChange,
}: {
  field: FieldDef;
  doc: DocumentDetail;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const low = !doc.confirmedAt && proposalBadge(doc.proposed, field.key)?.low === true;
  const common = {
    value,
    "aria-invalid": error ? true : undefined,
    placeholder: field.placeholder,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <label className="zd-field" data-low={low || undefined} data-error={error ? true : undefined}>
      <span>
        {field.label}
        {field.required ? " *" : ""}
        <SourceBadge doc={doc} field={field} />
      </span>
      {field.kind === "textarea" ? (
        <textarea rows={3} maxLength={600} {...common} />
      ) : field.kind === "list" ? (
        <textarea rows={Math.min(6, Math.max(2, value.split("\n").length + 1))} {...common} />
      ) : field.kind === "select" ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" inputMode={field.kind === "year" ? "numeric" : undefined} maxLength={field.kind === "year" ? 4 : 400} {...common} />
      )}
      {field.hint && !error ? <small className="zd-muted">{field.hint}</small> : null}
      {error ? <small className="zd-field-error">{error}</small> : null}
    </label>
  );
}
