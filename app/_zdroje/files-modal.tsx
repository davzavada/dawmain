"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import type { DocStatus } from "@/src/files/types";
import type { DocumentDetail, DocumentListItem, DocumentListResponse, FolderItem, LibrarySummary } from "@/src/files/web-types";
import { api, NETWORK_ERROR } from "./api";
import { Confirm, Dialog } from "./dialog";
import { countDocuments, countPages, downloadFileName, fileLine, foldName, formatDate, plural, remainingLine, statusBadge } from "./format";
import { ZIcon } from "./icons";
import { closeFiles, refreshSummary, requestSignIn, showFile, useZdroje } from "./store";

/**
 * The Vlastní soubory modal, opened by ZdrojeModals (./modals.tsx) from
 * ?soubory=1. A file explorer: on top the libraries ("Osobní" and the
 * user's teams — shown only when there is more than one), then the path
 * of the open folder, the drop zone, and the folders and files of that
 * folder in columns (name, size, uploaded, in a team who uploaded it).
 * Clicking a folder opens it; clicking a file opens its actions in place
 * (&dokument=<id>): rename, move to another folder, download the text,
 * delete. A new file is converted in the browser and posted into the open
 * folder; its row spins ("Zpracovávám…") until the server has indexed it.
 * There is no metadata to fill in — the name is all a file has, and it is
 * what the assistant cites.
 *
 * In a team's library every member uploads and makes folders; a member
 * renames, moves and deletes what they uploaded or made, the team's admin
 * everything (the server decides: canEdit / canDelete / canManage).
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
  const subtitle = SUBTITLE;

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
// The tree: pure helpers (exported for tests)

/** The folders from the root down to `folderId` (empty at the root, or for a folder that is gone). */
export function folderTrail(folders: readonly FolderItem[], folderId: string | null): FolderItem[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: FolderItem[] = [];
  for (let at = folderId; at !== null && trail.length <= folders.length; ) {
    const folder = byId.get(at);
    if (!folder) return [];
    trail.unshift(folder);
    at = folder.parentId;
  }
  return trail;
}

/** "Komentáře / Občanské právo" — where a folder is; "" for the root. */
export function folderPathOf(folders: readonly FolderItem[], folderId: string | null): string {
  return folderTrail(folders, folderId)
    .map((f) => f.name)
    .join(" / ");
}

/** Every place a file or a folder can go: the root first, then the folders by path. `without`: a folder that cannot go into itself or below. */
export function folderChoices(folders: readonly FolderItem[], rootName: string, without?: string): Array<{ id: string | null; label: string }> {
  const inside = (id: string) => without !== undefined && folderTrail(folders, id).some((f) => f.id === without);
  const choices = folders
    .filter((f) => !inside(f.id))
    .map((f) => ({ id: f.id as string | null, label: `${rootName} / ${folderPathOf(folders, f.id)}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "cs", { numeric: true }));
  return [{ id: null, label: rootName }, ...choices];
}

type Sort = "name" | "added";

const byName = (a: string, b: string) => a.localeCompare(b, "cs", { numeric: true });

/**
 * What the list shows: without a query the folders and files of the open
 * folder; with one, everything in the library whose name matches (the row
 * then says where it is). Folders first, by name; files by name or newest first.
 */
export function visibleEntries(
  folders: readonly FolderItem[],
  documents: readonly DocumentListItem[],
  at: string | null,
  query: string,
  sort: Sort,
): { folders: FolderItem[]; files: DocumentListItem[] } {
  const q = foldName(query);
  const shownFolders = q ? folders.filter((f) => foldName(f.name).includes(q)) : folders.filter((f) => f.parentId === at);
  const shownFiles = q ? documents.filter((d) => foldName(d.fileName).includes(q)) : documents.filter((d) => (d.folderId ?? null) === at);
  return {
    folders: [...shownFolders].sort((a, b) => byName(a.name, b.name)),
    files: sort === "name" ? [...shownFiles].sort((a, b) => byName(a.fileName, b.fileName)) : [...shownFiles],
  };
}

/** How many things sit directly in a folder. */
export function folderSize(folders: readonly FolderItem[], documents: readonly DocumentListItem[], id: string): number {
  return folders.filter((f) => f.parentId === id).length + documents.filter((d) => d.folderId === id).length;
}

// ---------------------------------------------------------------------------
// The library as a file explorer

function Library({ lib, mode, openId }: { lib: LibrarySummary; mode: string; openId: string | null }) {
  const { documents, setDocuments, folders, setFolders, total, error, reload } = useDocumentList(lib.id);
  const [at, setAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const readonly = mode !== "on";
  const hasDocs = (documents?.length ?? 0) > 0;
  // A folder deleted meanwhile (by a colleague): back to the root.
  const here = at !== null && folders.some((f) => f.id === at) ? at : null;

  // A link to a file (&dokument=<id>) opens the folder it is in — once per file.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || followed.current === openId || !documents) return;
    const doc = documents.find((d) => d.id === openId);
    if (!doc) return;
    followed.current = openId;
    setAt(doc.folderId ?? null);
  }, [openId, documents]);

  const shown = useMemo(() => visibleEntries(folders, documents ?? [], here, query, sort), [folders, documents, here, query, sort]);

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

  const canWrite = lib.pro && lib.canUpload && mode === "on";
  const go = (id: string | null) => {
    showFile(null);
    setQuery("");
    setCreating(false);
    setEditing(false);
    setAt(id);
  };
  const current = here === null ? null : (folders.find((f) => f.id === here) ?? null);
  const searching = foldName(query) !== "";
  const entries = (documents?.length ?? 0) + folders.length;

  return (
    <div className="zd-files">
      {!lib.pro ? (
        <p className="zd-banner">Režim Pro tu už není aktivní. Soubory můžete smazat nebo si stáhnout jejich text, nové nahrát nejde.</p>
      ) : mode === "readonly" ? (
        <p className="zd-banner">Vlastní soubory jsou teď jen pro čtení: hledat, číst a mazat jde, nahrávat ne. Zkuste to později.</p>
      ) : mode === "off" ? (
        <p className="zd-banner">Vlastní soubory jsou teď dočasně vypnuté. Mazat soubory jde dál.</p>
      ) : null}

      <div className="zd-x-bar">
        <nav className="zd-x-path" aria-label="Cesta">
          <button type="button" className="zd-x-crumb" aria-current={here === null ? "page" : undefined} onClick={() => go(null)}>
            <ZIcon name={lib.kind === "org" ? "users" : "library"} size={14} />
            <span>{lib.name}</span>
          </button>
          {folderTrail(folders, here).map((f) => (
            <span key={f.id} className="zd-x-step">
              <ZIcon name="chevron-right" size={13} />
              <button type="button" className="zd-x-crumb" aria-current={f.id === here ? "page" : undefined} onClick={() => go(f.id)}>
                <span>{f.name}</span>
              </button>
            </span>
          ))}
        </nav>
        <span className="zd-x-tools">
          {entries >= FILTER_FROM ? (
            <>
              <input type="search" className="zd-x-filter" placeholder="Hledat podle názvu" aria-label="Hledat podle názvu" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select className="zd-x-sort" aria-label="Řazení souborů" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="name">Podle názvu</option>
                <option value="added">Nejnovější</option>
              </select>
            </>
          ) : null}
          {current?.canManage && !searching ? (
            <button type="button" className="zd-btn zd-btn-secondary zd-x-new" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
              <ZIcon name="edit" size={15} />
              Upravit složku
            </button>
          ) : null}
          {canWrite ? (
            <button type="button" className="zd-btn zd-btn-secondary zd-x-new" onClick={() => setCreating(true)} disabled={creating}>
              <ZIcon name="folder-plus" size={15} />
              Nová složka
            </button>
          ) : null}
        </span>
      </div>

      {current && editing && !searching ? (
        <FolderTools
          key={current.id}
          folder={current}
          folders={folders}
          rootName={lib.name}
          editable={current.canManage && lib.pro && !readonly}
          deletable={current.canManage}
          onChanged={(next) => setFolders((list) => list.map((f) => (f.id === next.id ? next : f)))}
          onDeleted={() => {
            setFolders((list) => list.filter((f) => f.id !== current.id));
            go(current.parentId);
          }}
        />
      ) : null}

      {canWrite ? (
        <Uploader
          library={lib}
          folderId={here}
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
        <section className="zd-x-list" aria-label="Soubory a složky" data-team={lib.kind === "org" || undefined}>
          <div className="zd-x-head" aria-hidden="true">
            <span />
            <span>Název</span>
            <span>Velikost</span>
            <span>Nahráno</span>
            {lib.kind === "org" ? <span>Nahrál</span> : null}
            <span />
          </div>
          <ul>
            {creating ? (
              <NewFolder
                libraryId={lib.id}
                parentId={here}
                onCancel={() => setCreating(false)}
                onCreated={(folder) => {
                  setFolders((list) => [...list, folder]);
                  setCreating(false);
                }}
              />
            ) : null}
            {shown.folders.map((folder) => (
              <li key={folder.id} className="zd-x-item">
                <button type="button" className="zd-x-row" onClick={() => go(folder.id)}>
                  <ZIcon name="folder" size={18} className="zd-x-icon zd-x-icon-folder" />
                  <span className="zd-x-name">
                    <span className="zd-x-title">{folder.name}</span>
                    {searching ? <span className="zd-x-where">{folderPathOf(folders, folder.parentId) || lib.name}</span> : null}
                  </span>
                  <span className="zd-x-cell">{countItems(folderSize(folders, documents, folder.id))}</span>
                  <span className="zd-x-cell" />
                  {lib.kind === "org" ? <span className="zd-x-cell" /> : null}
                  <ZIcon name="chevron-right" size={15} className="zd-x-chevron" />
                </button>
              </li>
            ))}
            {shown.files.map((doc) => (
              <FileRow
                key={doc.id}
                doc={doc}
                team={lib.kind === "org"}
                where={searching ? folderPathOf(folders, doc.folderId) || lib.name : null}
                open={openId === doc.id}
                readonly={readonly}
                choices={folderChoices(folders, lib.name)}
                onDeleted={() => {
                  setDocuments((list) => list?.filter((d) => d.id !== doc.id) ?? list);
                  if (openId === doc.id) showFile(null);
                  reload();
                  void refreshSummary();
                }}
                onChanged={(detail) =>
                  setDocuments(
                    (list) => list?.map((d) => (d.id === detail.id ? { ...d, title: detail.title, fileName: detail.fileName, folderId: detail.folderId } : d)) ?? list,
                  )
                }
              />
            ))}
          </ul>
          {shown.folders.length + shown.files.length === 0 && !creating ? (
            <p className="zd-empty">{searching ? "Nic takového tu není." : here === null ? "Zatím tu nic není." : "Složka je prázdná."}</p>
          ) : null}
          <p className="zd-x-foot">
            {countDocuments(total)} v knihovně{lib.pro && lib.pagesUsed !== null ? ` · ${remainingLine(lib.pagesUsed, lib.quotaPages)}` : ""}
          </p>
        </section>
      ) : (
        <Loading text="Načítám soubory…" />
      )}
    </div>
  );
}

/** From this many files and folders on, the bar gets its filter and sorting. */
const FILTER_FROM = 8;

/** "prázdná", "1 položka", "3 položky", "12 položek". */
export function countItems(n: number): string {
  return n === 0 ? "prázdná" : `${n} ${plural(n, "položka", "položky", "položek")}`;
}

// ---------------------------------------------------------------------------
// Folders: a new one, and the open one's tools

function NewFolder({ libraryId, parentId, onCreated, onCancel }: { libraryId: string; parentId: string | null; onCreated: (folder: FolderItem) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await api<FolderItem>("/api/files/folders", { method: "POST", json: { lib: libraryId, parentId, name: name.trim() } });
    setBusy(false);
    if (res.ok) onCreated(res.data);
    else setError(res.error);
  }

  return (
    <li className="zd-x-item">
      <form
        className="zd-x-edit"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <ZIcon name="folder" size={18} className="zd-x-icon zd-x-icon-folder" />
        <input ref={input} type="text" aria-label="Název nové složky" placeholder="Název složky" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="zd-btn zd-btn-primary" disabled={busy || !name.trim()}>
          Vytvořit
        </button>
        <button type="button" className="zd-btn zd-btn-secondary" disabled={busy} onClick={onCancel}>
          Zrušit
        </button>
      </form>
      {error ? (
        <p className="zd-error zd-x-edit-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The open folder's own actions: rename, move elsewhere, delete (only when empty — the server says so). */
function FolderTools({
  folder,
  folders,
  rootName,
  editable,
  deletable,
  onChanged,
  onDeleted,
}: {
  folder: FolderItem;
  folders: readonly FolderItem[];
  rootName: string;
  editable: boolean;
  deletable: boolean;
  onChanged: (folder: FolderItem) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editable && !deletable) return null;
  const renamed = name.trim() !== "" && name.trim() !== folder.name;

  async function patch(json: unknown) {
    setBusy(true);
    setError(null);
    const res = await api<FolderItem>(`/api/files/folders/${folder.id}`, { method: "PATCH", json });
    setBusy(false);
    if (res.ok) {
      setName(res.data.name);
      onChanged(res.data);
    } else setError(res.error);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await api(`/api/files/folders/${folder.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok || res.status === 404) onDeleted();
    else setError(res.error);
  }

  return (
    <div className="zd-x-folder">
      {editable ? (
        <form
          className="zd-x-folder-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (renamed) void patch({ action: "rename", name: name.trim() });
          }}
        >
          <input type="text" aria-label="Název složky" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="zd-btn zd-btn-secondary" disabled={busy || !renamed}>
            Přejmenovat
          </button>
          <select
            aria-label="Přesunout složku"
            value={folder.parentId ?? ""}
            disabled={busy}
            onChange={(e) => void patch({ action: "move", parentId: e.target.value || null })}
          >
            {folderChoices(folders, rootName, folder.id).map((c) => (
              <option key={c.id ?? ""} value={c.id ?? ""}>
                {c.id === folder.parentId ? `Je v: ${c.label}` : `Přesunout do: ${c.label}`}
              </option>
            ))}
          </select>
        </form>
      ) : null}
      {deletable ? (
        <button type="button" className="zd-link-button zd-danger-link" disabled={busy} onClick={() => void remove()}>
          Smazat složku
        </button>
      ) : null}
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A file: its row, and opened its actions

function FileRow({
  doc,
  team,
  where,
  open,
  readonly,
  choices,
  onDeleted,
  onChanged,
}: {
  doc: DocumentListItem;
  team: boolean;
  /** Where the file is, when the list shows search results. */
  where: string | null;
  open: boolean;
  readonly: boolean;
  choices: Array<{ id: string | null; label: string }>;
  onDeleted: () => void;
  onChanged: (detail: DocumentDetail) => void;
}) {
  const pending = PENDING.has(doc.status) || doc.status === "deleting";
  const failed = doc.status === "error";
  const pages = doc.physicalPages ?? doc.billablePages;
  const cells = (
    <>
      <ZIcon name="file" size={18} className="zd-x-icon" />
      <span className="zd-x-name">
        <span className="zd-x-title zd-file-title">{doc.fileName}</span>
        {pending ? (
          <span className="zd-x-where zd-file-line">{doc.status === "deleting" ? "Mažu…" : "Zpracovávám…"}</span>
        ) : failed ? (
          <span className="zd-x-where zd-file-line zd-file-line-bad">
            {statusBadge(doc.status, doc.statusDetail).label}
            {doc.statusDetail ? ` · ${doc.statusDetail}` : ""}
          </span>
        ) : (
          <>
            {where ? <span className="zd-x-where">{where}</span> : null}
            <span className="zd-x-where zd-x-narrow zd-file-line">{fileLine(doc, doc.uploadedAt, team ? doc.uploadedByName : null)}</span>
          </>
        )}
      </span>
      <span className="zd-x-cell">{pages > 0 ? countPages(pages) : ""}</span>
      <span className="zd-x-cell">{formatDate(doc.uploadedAt)}</span>
      {team ? <span className="zd-x-cell">{doc.uploadedByName ?? ""}</span> : null}
    </>
  );
  if (pending) {
    return (
      <li className="zd-x-item zd-file" data-pending="true">
        <div className="zd-x-row">
          {cells}
          <span className="zd-spinner zd-file-spinner" role="status" aria-label="Zpracovávám" />
        </div>
      </li>
    );
  }
  return (
    <li className="zd-x-item zd-file" data-open={open || undefined}>
      <button type="button" className="zd-x-row zd-file-row" aria-expanded={open} onClick={() => showFile(open ? null : doc.id)}>
        {cells}
        <ZIcon name="chevron" size={15} className="zd-x-chevron zd-file-chevron" />
      </button>
      {open ? <FileActions doc={doc} readonly={readonly} choices={choices} onDeleted={onDeleted} onChanged={onChanged} /> : null}
    </li>
  );
}

function FileActions({
  doc,
  readonly,
  choices,
  onDeleted,
  onChanged,
}: {
  doc: DocumentListItem;
  readonly: boolean;
  choices: Array<{ id: string | null; label: string }>;
  onDeleted: () => void;
  onChanged: (detail: DocumentDetail) => void;
}) {
  const [name, setName] = useState(doc.fileName);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"rename" | "move" | "delete" | "export" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const settled = doc.status === "review" || doc.status === "ready";
  const editable = doc.canEdit && !readonly && settled;
  const changed = name.trim() !== "" && name.trim() !== doc.fileName;

  async function patch(kind: "rename" | "move", json: unknown, done: string) {
    setBusy(kind);
    setMessage(null);
    const res = await api<DocumentDetail>(`/api/files/documents/${doc.id}`, { method: "PATCH", json });
    setBusy(null);
    if (res.ok) {
      setName(res.data.fileName);
      setMessage({ ok: true, text: done });
      onChanged(res.data);
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
        if (changed) void patch("rename", { action: "rename", name: name.trim() }, "Přejmenováno.");
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
      {editable && choices.length > 1 ? (
        <select
          className="zd-file-move"
          aria-label="Přesunout soubor"
          value={doc.folderId ?? ""}
          disabled={busy !== null}
          onChange={(e) => void patch("move", { action: "move", folderId: e.target.value || null }, "Přesunuto.")}
        >
          {choices.map((c) => (
            <option key={c.id ?? ""} value={c.id ?? ""}>
              {c.id === (doc.folderId ?? null) ? `Je v: ${c.label}` : `Přesunout do: ${c.label}`}
            </option>
          ))}
        </select>
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
