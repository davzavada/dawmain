"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import type { DocStatus } from "@/src/files/types";
import type { DocumentDetail, DocumentListItem, DocumentListResponse, LibrarySummary } from "@/src/files/web-types";
import { api, NETWORK_ERROR } from "./api";
import { Confirm, Dialog } from "./dialog";
import { downloadFileName, fileLine, foldName, remainingLine, statusBadge } from "./format";
import { ZIcon } from "./icons";
import { closeFiles, refreshSummary, requestSignIn, showFile, useZdroje } from "./store";

/**
 * The Vlastní soubory modal, opened by ZdrojeModals (./modals.tsx) from
 * ?soubory=1. It looks and works like a folder: the libraries on top
 * ("Osobní" and the user's teams — shown only when there is more than one),
 * the drop zone, and under it the files by name. A new file is converted
 * in the browser and posted into the library shown; its row spins
 * ("Zpracovávám…") until the server has indexed it. Clicking a row opens
 * it in place (&dokument=<id>): rename, download the text, delete. There
 * is no metadata to fill in — the name is all a file has, and it is what
 * the assistant cites.
 *
 * In a team's library every member uploads; a member renames and deletes
 * what they uploaded, the team's admin everything (the server decides:
 * canEdit / canDelete on each row).
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
  const libraries = summary?.state === "ok" ? summary.libraries : NO_LIBRARIES;
  const [chosen, setChosen] = useState<string | null>(null);
  const library = pickLibrary(libraries, chosen);
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
    body = (
      <>
        <LibraryTabs libraries={libraries} active={library.id} onChoose={setChosen} />
        <Library key={library.id} lib={library} mode={mode} openId={documentId} />
      </>
    );
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

const NO_LIBRARIES: LibrarySummary[] = [];

/**
 * The library the modal shows: the one chosen, else the first the user can
 * work in (a team's member without Pro of their own lands in the team), else
 * the personal one. Pure (exported for tests).
 */
export function pickLibrary(libraries: readonly LibrarySummary[], chosen: string | null): LibrarySummary | null {
  return libraries.find((l) => l.id === chosen) ?? libraries.find((l) => l.pro) ?? libraries[0] ?? null;
}

/** "Osobní | Tým A | Tým B" — only when there is something to switch between. */
function LibraryTabs({ libraries, active, onChoose }: { libraries: readonly LibrarySummary[]; active: string; onChoose: (id: string) => void }) {
  if (libraries.length < 2) return null;
  return (
    <div className="zd-lib-tabs" role="tablist" aria-label="Knihovna">
      {libraries.map((lib) => (
        <button
          key={lib.id}
          type="button"
          role="tab"
          aria-selected={lib.id === active}
          className="zd-lib-tab"
          onClick={() => {
            showFile(null);
            onChoose(lib.id);
          }}
        >
          <ZIcon name={lib.kind === "org" ? "users" : "library"} size={14} />
          <span>{lib.name}</span>
          {lib.counts ? <span className="zd-lib-tab-count">{lib.counts.total}</span> : null}
        </button>
      ))}
    </div>
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
    if (lib.kind === "org") {
      return <Notice title="Týmová knihovna teď není aktivní" text="Tým nemá zapnuté Vlastní soubory. Obraťte se na správce týmu." />;
    }
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
      {lib.kind === "org" && lib.pro ? (
        <p className="zd-team-note">
          <ZIcon name="users" size={14} />
          Sdílená knihovna týmu {lib.name}: soubory tu vidí a asistent v nich hledá všem členům.
        </p>
      ) : null}
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
          onRenamed={(detail) =>
            setDocuments((list) => list?.map((d) => (d.id === detail.id ? { ...d, title: detail.title, fileName: detail.fileName } : d)) ?? list)
          }
        />
      ) : (
        <Loading text="Načítám soubory…" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list

/** From this many files on, the list gets its filter and sorting. */
const FILTER_FROM = 8;

type Sort = "added" | "name";

/** The files a filter leaves, in the chosen order (name: Czech collation; added: as the server sent them, newest first). Pure. */
export function visibleFiles(documents: readonly DocumentListItem[], query: string, sort: Sort): DocumentListItem[] {
  const q = foldName(query);
  const hits = q ? documents.filter((d) => foldName(d.fileName).includes(q)) : [...documents];
  return sort === "name" ? hits.sort((a, b) => a.fileName.localeCompare(b.fileName, "cs", { numeric: true })) : hits;
}

function FileList({
  documents,
  total,
  openId,
  readonly,
  onDeleted,
  onRenamed,
}: {
  documents: DocumentListItem[];
  total: number;
  openId: string | null;
  readonly: boolean;
  onChanged: () => void;
  onDeleted: (id: string) => void;
  onRenamed: (detail: DocumentDetail) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("added");
  const shown = useMemo(() => visibleFiles(documents, query, sort), [documents, query, sort]);
  const tools = documents.length >= FILTER_FROM;
  return (
    <section className="zd-files-list" aria-label="Soubory">
      <div className="zd-files-head">
        <span>Soubory</span>
        <span className="zd-files-count">{total}</span>
        {tools ? (
          <span className="zd-files-tools">
            <input type="search" className="zd-files-filter" placeholder="Hledat podle názvu" aria-label="Hledat podle názvu" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="zd-files-sort" aria-label="Řazení" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="added">Nejnovější</option>
              <option value="name">Podle názvu</option>
            </select>
          </span>
        ) : null}
      </div>
      {documents.length === 0 ? <p className="zd-empty">Zatím tu nic není.</p> : shown.length === 0 ? <p className="zd-empty">Žádný soubor neodpovídá.</p> : null}
      <ul>
        {shown.map((doc) => (
          <FileRow key={doc.id} doc={doc} open={openId === doc.id} readonly={readonly} onDeleted={() => onDeleted(doc.id)} onRenamed={onRenamed} />
        ))}
      </ul>
    </section>
  );
}

function FileRow({
  doc,
  open,
  readonly,
  onDeleted,
  onRenamed,
}: {
  doc: DocumentListItem;
  open: boolean;
  readonly: boolean;
  onDeleted: () => void;
  onRenamed: (detail: DocumentDetail) => void;
}) {
  const pending = PENDING.has(doc.status) || doc.status === "deleting";
  if (pending) {
    return (
      <li className="zd-file" data-pending="true">
        <div className="zd-file-row">
          <ZIcon name="file" size={18} />
          <span className="zd-file-text">
            <span className="zd-file-title">{doc.fileName}</span>
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
        <ZIcon name="file" size={18} />
        <span className="zd-file-text">
          <span className="zd-file-title">{doc.fileName}</span>
          {failed ? (
            <span className="zd-file-line zd-file-line-bad">
              {statusBadge(doc.status, doc.statusDetail).label}
              {doc.statusDetail ? ` · ${doc.statusDetail}` : ""}
            </span>
          ) : (
            <span className="zd-file-line">{fileLine(doc, doc.uploadedAt, doc.uploadedByName)}</span>
          )}
        </span>
        <ZIcon name="chevron" className="zd-file-chevron" />
      </button>
      {open ? <FileActions doc={doc} readonly={readonly} onDeleted={onDeleted} onRenamed={onRenamed} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The open row: rename, download, delete

function FileActions({
  doc,
  readonly,
  onDeleted,
  onRenamed,
}: {
  doc: DocumentListItem;
  readonly: boolean;
  onDeleted: () => void;
  onRenamed: (detail: DocumentDetail) => void;
}) {
  const [name, setName] = useState(doc.fileName);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"rename" | "delete" | "export" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const settled = doc.status === "review" || doc.status === "ready";
  const editable = doc.canEdit && !readonly && settled;
  const changed = name.trim() !== "" && name.trim() !== doc.fileName;

  async function rename() {
    if (!changed) return;
    setBusy("rename");
    setMessage(null);
    const res = await api<DocumentDetail>(`/api/files/documents/${doc.id}`, { method: "PATCH", json: { action: "rename", name: name.trim() } });
    setBusy(null);
    if (res.ok) {
      setName(res.data.fileName);
      setMessage({ ok: true, text: "Přejmenováno." });
      onRenamed(res.data);
      return;
    }
    setMessage({ ok: false, text: res.error });
  }

  async function remove() {
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

  return (
    <form
      className="zd-file-open"
      onSubmit={(e) => {
        e.preventDefault();
        void rename();
      }}
    >
      {doc.status === "error" && doc.statusDetail ? <p className="zd-error">{doc.statusDetail}</p> : null}
      {editable ? (
        <div className="zd-file-rename">
          <input type="text" aria-label="Název souboru" value={name} maxLength={160} disabled={busy !== null} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="zd-btn zd-btn-primary" disabled={busy !== null || !changed}>
            {busy === "rename" ? "Ukládám…" : "Přejmenovat"}
          </button>
        </div>
      ) : null}
      {doc.flags.length > 0 ? <p className="zd-muted zd-small">{doc.flags.join(" · ")}</p> : null}
      {message ? (
        <p className={message.ok ? "zd-ok-line" : "zd-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <div className="zd-file-actions">
        <span className="zd-file-actions-end">
          {doc.canDelete && settled ? (
            // Who may download is who may delete — Pro not required, as the export route checks.
            <button type="button" className="zd-link-button" onClick={() => void exportText()} disabled={busy !== null}>
              {busy === "export" ? "Stahuji…" : "Stáhnout text"}
            </button>
          ) : null}
          {doc.canDelete ? (
            // Pro not required: whoever owns the text may delete it, also after Pro was withdrawn.
            <button type="button" className="zd-link-button zd-danger-link" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
              Smazat soubor
            </button>
          ) : null}
        </span>
      </div>
      {confirmDelete ? (
        <Confirm
          question={<>Smazat „{doc.fileName}“? Text i index se odstraní natrvalo.</>}
          confirmLabel="Smazat"
          busy={busy === "delete"}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </form>
  );
}
