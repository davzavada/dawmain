"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import type { DocumentDetail, DocumentListItem, FolderItem, LibrarySummary } from "@/src/files/web-types";
import { api } from "../_zdroje/api";
import { Confirm } from "../_zdroje/dialog";
import { FileEditor, PENDING, useDocumentList } from "../_zdroje/file-editor";
import { formatDate, formatStorageBytes as formatBytes, kindLabel, zBefore, plural, statusBadge, typeLabel } from "../_zdroje/format";
import { ZIcon } from "../_zdroje/icons";
import { FolderGlyph, LibraryMark } from "../_zdroje/library-mark";
import { refreshSummary, requestSignIn, useZdroje } from "../_zdroje/store";
import { ACCEPT, useUploads } from "../_zdroje/upload";

/**
 * The Vlastní soubory page (/soubory for the personal library,
 * /soubory/<handle> for a team's): a file manager over one library. Folders
 * (blue, nested) and documents in one table; the open folder is ?slozka=<id>
 * and the open document ?dokument=<id>, so Back and a copied link work.
 *
 *   - "Nová složka" creates one and puts its name in edit mode at once;
 *     double-click, F2 or ⋯ → Přejmenovat renames inline (Enter saves,
 *     Escape cancels; a document keeps its extension).
 *   - Drag a row onto a folder or onto the breadcrumb to move it, or use
 *     ⋯ → Přesunout do…; a rename or a move can be undone from the toast.
 *   - Deleting a folder moves what was in it one level up; deleting a
 *     document asks first (it is gone for good).
 *   - Files dropped anywhere on the list (or picked with "Nahrát soubory")
 *     upload into the open folder: the text for the assistant, then the original.
 *   - Clicking a document opens the side panel: open or download the
 *     original, the text the assistant reads, and the metadata form.
 *
 * Rights follow the API: folders are managed by anyone who may upload
 * there; a document is renamed, moved and deleted by its uploader or the
 * library's owner / team manager.
 */

const MAIL_PRO = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - Vlastní soubory (Pro)")}`;
const DEFAULT_MAX_FILE = 100 * 1024 * 1024;

type Item = { kind: "folder"; folder: FolderItem } | { kind: "doc"; doc: DocumentListItem };
type MenuState = { key: string; x: number; y: number; mode: "main" | "move" };
type Toast = { text: string; undo?: () => Promise<void> | void };

const keyOf = (item: Item) => (item.kind === "folder" ? `f:${item.folder.id}` : `d:${item.doc.id}`);
const nameOf = (item: Item) => (item.kind === "folder" ? item.folder.name : item.doc.fileName);

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** "Nová složka", or "Nová složka (2)" when that name is taken among the siblings (case-insensitive). */
export function freeName(base: string, taken: string[]): string {
  const set = new Set(taken.map((n) => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!set.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

function itemsLabel(n: number): string {
  return n === 0 ? "prázdná" : `${n} ${plural(n, "položka", "položky", "položek")}`;
}

export function FilesPage() {
  const params = useParams<{ knihovna?: string[] }>();
  const handle = params.knihovna?.[0] ? decodeURIComponent(params.knihovna[0]) : "osobni";
  const { auth, summary, failed } = useZdroje();

  if (auth === "none") return <PageNotice title="Vlastní soubory tu nejsou k dispozici" text="Na tomto nasazení není zapnuté přihlašování." />;
  if (auth === "signed_out" || summary?.state === "signed_out") {
    return (
      <PageNotice title="Přihlaste se" text="Vlastní soubory patří k vašemu účtu. Po přihlášení je uvidíte tady.">
        <button type="button" className="zd-btn zd-btn-primary" onClick={requestSignIn}>
          Přihlásit se
        </button>
      </PageNotice>
    );
  }
  if (!summary) {
    return failed ? (
      <PageNotice title="Vlastní soubory se nepodařilo načíst" text="Zkuste to prosím za chvíli.">
        <button type="button" className="zd-btn zd-btn-secondary" onClick={() => void refreshSummary()}>
          Zkusit znovu
        </button>
      </PageNotice>
    ) : (
      <PageLoading />
    );
  }
  if (summary.state === "unavailable") return <PageNotice title="Vlastní soubory jsou teď vypnuté" text="Oficiální databáze fungují dál. Zkuste to prosím později." />;
  const lib = summary.libraries.find((l) => l.handle === handle) ?? (handle === "osobni" ? summary.libraries.find((l) => l.kind === "user") : undefined);
  if (!lib) {
    return (
      <PageNotice title="Tuhle knihovnu nevidíte" text="Buď neexistuje, nebo v tomto týmu nejste. Členy týmů přiděluje správce.">
        <Link className="zd-btn zd-btn-secondary" href="/soubory">
          Na osobní soubory
        </Link>
      </PageNotice>
    );
  }
  return <LibraryPage key={lib.id} lib={lib} mode={summary.mode} maxFileBytes={summary.maxFileBytes ?? DEFAULT_MAX_FILE} />;
}

function PageNotice({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="fp fp-notice">
      <div className="zd-locked">
        <span className="zd-locked-icon" aria-hidden="true">
          <ZIcon name="lock" size={18} />
        </span>
        <h3>{title}</h3>
        <p>{text}</p>
        {children}
      </div>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="fp fp-notice">
      <p className="zd-progress" role="status">
        <span className="zd-spinner" aria-hidden="true" />
        Načítám…
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LibraryPage({ lib, mode, maxFileBytes }: { lib: LibrarySummary; mode: string; maxFileBytes: number }) {
  const router = useRouter();
  const search = useSearchParams();
  const { documents, setDocuments, folders, setFolders, error, reload } = useDocumentList(lib.id);
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const dragKey = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const base = lib.kind === "user" ? "/soubory" : `/soubory/${encodeURIComponent(lib.handle)}`;
  const team = lib.kind === "org";
  const writable = lib.pro && mode === "on";
  const canFolders = writable && lib.canUpload;

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const rawFolder = search.get("slozka");
  const folderId = rawFolder && (byId.has(rawFolder) || folders.length === 0) ? rawFolder : null;
  const openId = search.get("dokument");
  const openDoc = documents?.find((d) => d.id === openId) ?? null;

  const uploads = useUploads({
    library: lib,
    folderId: byId.has(folderId ?? "") ? folderId : null,
    maxFileBytes,
    onUploaded: () => {
      reload();
      void refreshSummary();
    },
  });

  // ---- navigation (URL) ----
  const go = useCallback(
    (next: { folder?: string | null; doc?: string | null }, replace = false) => {
      const p = new URLSearchParams(search.toString());
      if (next.folder !== undefined) {
        if (next.folder) p.set("slozka", next.folder);
        else p.delete("slozka");
        p.delete("dokument");
      }
      if (next.doc !== undefined) {
        if (next.doc) p.set("dokument", next.doc);
        else p.delete("dokument");
      }
      const qs = p.toString();
      const href = qs ? `${base}?${qs}` : base;
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [base, router, search],
  );
  const openFolder = (id: string | null) => {
    setQ("");
    setMenu(null);
    go({ folder: id });
  };
  const select = (id: string | null) => go({ doc: id }, true);

  // ---- toast ----
  const say = useCallback((text: string, undo?: Toast["undo"]) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), 6_000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // ---- derived ----
  const path = useMemo(() => {
    const out: FolderItem[] = [];
    let cur = folderId ? byId.get(folderId) : undefined;
    for (let guard = 0; cur && guard < 64; guard++) {
      out.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  }, [byId, folderId]);

  const where = useCallback(
    (parentId: string | null): string => {
      if (!parentId) return "v kořeni knihovny";
      const names: string[] = [];
      let cur = byId.get(parentId);
      for (let guard = 0; cur && guard < 64; guard++) {
        names.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return `ve složce ${names.join(" › ")}`;
    },
    [byId],
  );

  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of folders) if (f.parentId) counts.set(f.parentId, (counts.get(f.parentId) ?? 0) + 1);
    for (const d of documents ?? []) if (d.folderId) counts.set(d.folderId, (counts.get(d.folderId) ?? 0) + 1);
    return counts;
  }, [folders, documents]);

  const items: Item[] = useMemo(() => {
    const docs = documents ?? [];
    const byName = (a: string, b: string) => a.localeCompare(b, "cs", { numeric: true });
    if (q.trim()) {
      const needle = q.trim().toLocaleLowerCase("cs");
      const f = folders.filter((x) => x.name.toLocaleLowerCase("cs").includes(needle)).map((folder): Item => ({ kind: "folder", folder }));
      const d = docs
        .filter((x) => x.fileName.toLocaleLowerCase("cs").includes(needle) || x.title.toLocaleLowerCase("cs").includes(needle))
        .map((doc): Item => ({ kind: "doc", doc }));
      return [...f, ...d].sort((a, b) => (a.kind === b.kind ? byName(nameOf(a), nameOf(b)) : a.kind === "folder" ? -1 : 1));
    }
    const f = folders
      .filter((x) => x.parentId === folderId)
      .sort((a, b) => byName(a.name, b.name))
      .map((folder): Item => ({ kind: "folder", folder }));
    const d = docs
      .filter((x) => (x.folderId ?? null) === folderId || (x.folderId && !byId.has(x.folderId) && folderId === null))
      .sort((a, b) => byName(a.fileName, b.fileName))
      .map((doc): Item => ({ kind: "doc", doc }));
    return [...f, ...d];
  }, [documents, folders, folderId, q, byId]);

  const canManageDoc = (doc: DocumentListItem) => writable && doc.canDelete;
  const canManage = (item: Item) => (item.kind === "folder" ? canFolders : canManageDoc(item.doc));

  // ---- server calls ----
  async function call<T>(url: string, method: string, json?: unknown): Promise<T | null> {
    setBusy(true);
    const res = await api<T>(url, { method, json });
    setBusy(false);
    if (!res.ok) {
      say(res.error);
      return null;
    }
    return res.data;
  }

  async function createFolder() {
    const name = freeName(
      "Nová složka",
      folders.filter((f) => f.parentId === folderId).map((f) => f.name),
    );
    const made = await call<FolderItem>("/api/files/folders", "POST", { lib: lib.id, parentId: folderId, name });
    if (!made) return;
    setQ("");
    setFolders((list) => [...list, made]);
    setRenaming(`f:${made.id}`);
  }

  async function renameItem(item: Item, raw: string) {
    setRenaming(null);
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name || name === nameOf(item)) return;
    if (item.kind === "folder") {
      const old = item.folder.name;
      const done = await call<FolderItem>(`/api/files/folders/${item.folder.id}`, "PATCH", { name });
      if (!done) return;
      setFolders((list) => list.map((f) => (f.id === done.id ? done : f)));
      say(`Přejmenováno na „${done.name}“`, async () => {
        const back = await call<FolderItem>(`/api/files/folders/${done.id}`, "PATCH", { name: old });
        if (back) setFolders((list) => list.map((f) => (f.id === back.id ? back : f)));
      });
    } else {
      const old = item.doc.fileName;
      const done = await call<DocumentDetail>(`/api/files/documents/${item.doc.id}`, "PATCH", { action: "rename", name });
      if (!done) return;
      setDocuments((list) => list?.map((d) => (d.id === done.id ? { ...d, fileName: done.fileName, title: done.title } : d)) ?? list);
      say(`Přejmenováno na „${done.fileName}“`, async () => {
        const back = await call<DocumentDetail>(`/api/files/documents/${done.id}`, "PATCH", { action: "rename", name: old });
        if (back) setDocuments((list) => list?.map((d) => (d.id === back.id ? { ...d, fileName: back.fileName, title: back.title } : d)) ?? list);
      });
    }
  }

  function isInside(id: string, ancestor: string): boolean {
    let cur = byId.get(id);
    for (let guard = 0; cur && guard < 64; guard++) {
      if (cur.id === ancestor) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  }

  async function moveItem(item: Item, target: string | null, quiet = false): Promise<boolean> {
    const targetName = target ? (byId.get(target)?.name ?? "složky") : "kořene knihovny";
    if (item.kind === "folder") {
      if (item.folder.parentId === target || item.folder.id === target) return false;
      if (target && isInside(target, item.folder.id)) {
        say("Složku nejde přesunout do ní samé.");
        return false;
      }
      const old = item.folder.parentId;
      const done = await call<FolderItem>(`/api/files/folders/${item.folder.id}`, "PATCH", { parentId: target });
      if (!done) return false;
      setFolders((list) => list.map((f) => (f.id === done.id ? done : f)));
      if (!quiet) say(`„${done.name}“ přesunuto do ${targetName === "kořene knihovny" ? targetName : `„${targetName}“`}`, () => void moveItem({ kind: "folder", folder: done }, old, true));
    } else {
      if ((item.doc.folderId ?? null) === target) return false;
      const old = item.doc.folderId ?? null;
      const done = await call<DocumentDetail>(`/api/files/documents/${item.doc.id}`, "PATCH", { action: "move", folderId: target });
      if (!done) return false;
      const moved = { ...item.doc, folderId: target };
      setDocuments((list) => list?.map((d) => (d.id === moved.id ? moved : d)) ?? list);
      if (!quiet) say(`„${moved.fileName}“ přesunuto do ${targetName === "kořene knihovny" ? targetName : `„${targetName}“`}`, () => void moveItem({ kind: "doc", doc: moved }, old, true));
    }
    return true;
  }

  async function deleteFolder(folder: FolderItem) {
    const done = await call<unknown>(`/api/files/folders/${folder.id}`, "DELETE");
    if (done === null) return;
    const had = (childCount.get(folder.id) ?? 0) > 0;
    // The server moved its content one level up; read the library again.
    setFolders((list) => list.filter((f) => f.id !== folder.id));
    reload();
    if (folderId === folder.id) openFolder(folder.parentId);
    say(`Složka „${folder.name}“ smazána${had ? ", její obsah je o úroveň výš" : ""}.`);
  }

  async function deleteDocument(doc: DocumentListItem) {
    setBusy(true);
    const res = await api(`/api/files/documents/${doc.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirmDelete(null);
    if (!res.ok && res.status !== 404) {
      say(res.error);
      return;
    }
    setDocuments((list) => list?.filter((d) => d.id !== doc.id) ?? list);
    if (openId === doc.id) select(null);
    reload();
    void refreshSummary();
    say(`„${doc.fileName}“ smazán.`);
  }

  // ---- drag & drop ----
  const findItem = (key: string): Item | null => {
    if (key.startsWith("f:")) {
      const folder = byId.get(key.slice(2));
      return folder ? { kind: "folder", folder } : null;
    }
    const doc = documents?.find((d) => d.id === key.slice(2));
    return doc ? { kind: "doc", doc } : null;
  };
  const dropProps = (target: string | null, id: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragKey.current || dragKey.current === `f:${target}`) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropOver !== id) setDropOver(id);
    },
    onDragLeave: () => setDropOver((cur) => (cur === id ? null : cur)),
    onDrop: (e: DragEvent) => {
      if (!dragKey.current) return;
      e.preventDefault();
      e.stopPropagation();
      const item = findItem(dragKey.current);
      dragKey.current = null;
      setDropOver(null);
      if (item) void moveItem(item, target);
    },
  });

  function onListDragOver(e: DragEvent) {
    if (dragKey.current || !e.dataTransfer.types.includes("Files")) return;
    if (!writable || !lib.canUpload) return;
    e.preventDefault();
    setFileDrag(true);
  }
  function onListDrop(e: DragEvent) {
    if (dragKey.current || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setFileDrag(false);
    if (writable && lib.canUpload) uploads.add(e.dataTransfer.files);
  }

  // ---- keyboard on rows ----
  function onRowKey(e: KeyboardEvent, item: Item) {
    if (renaming) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (item.kind === "folder") openFolder(item.folder.id);
      else select(item.doc.id);
    } else if (e.key === "F2" && canManage(item)) {
      e.preventDefault();
      setRenaming(keyOf(item));
    } else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && canManage(item)) {
      e.preventDefault();
      if (item.kind === "folder") void deleteFolder(item.folder);
      else setConfirmDelete(item.doc);
    }
  }

  // ---- menu ----
  const menuItem = menu ? findItem(menu.key) : null;
  function openMenu(e: MouseEvent, item: Item) {
    e.stopPropagation();
    const key = keyOf(item);
    if (menu?.key === key) {
      setMenu(null);
      return;
    }
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ key, mode: "main", x: Math.max(8, Math.min(box.right - 230, window.innerWidth - 250)), y: Math.min(box.bottom + 4, window.innerHeight - 280) });
  }
  useEffect(() => {
    if (!menu) return;
    const close = (e: globalThis.MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".fp-menu")) setMenu(null);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const scroll = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [menu]);

  // ---- render ----
  const used = lib.bytesUsed;
  const storage = used !== null ? `${formatBytes(used)} ${zBefore(formatBytes(lib.quotaBytes))} ${formatBytes(lib.quotaBytes)}` : null;
  const roleLabel = lib.role === "org:admin" ? "jste správce týmu" : lib.role === "org:member" ? "jste člen týmu" : null;
  const subtitle = [team ? "Sdílené s týmem" : "Jen pro vás", roleLabel, lib.pro ? storage : team ? "tým je vypnutý" : null].filter(Boolean).join(" · ");
  const fullShare = used !== null && lib.quotaBytes > 0 ? Math.min(1, used / lib.quotaBytes) : 0;

  if (!lib.pro && documents !== null && documents.length === 0 && folders.length === 0) {
    return team ? (
      <PageNotice title={`Tým ${lib.name} je teď vypnutý`} text="Sdílené soubory týmu zapíná a vypíná správce. Své osobní soubory máte dál v Osobních." />
    ) : (
      <PageNotice
        title="Vlastní soubory přiděluji ručně a zdarma"
        text="Nahrajete knihy, články, komentáře a vzory. Asistent v nich pak hledá vedle oficiálních databází a originály máte po ruce tady."
      >
        <a className="zd-btn zd-btn-primary" href={MAIL_PRO}>
          Napsat o přístup
        </a>
      </PageNotice>
    );
  }

  return (
    <div className="fp" data-detail={openDoc ? "true" : undefined}>
      <header className="fp-head">
        <LibraryMark lib={lib} size={40} />
        <div className="fp-head-text">
          <h1>{team ? lib.name : "Osobní soubory"}</h1>
          <p>{subtitle}</p>
        </div>
        {lib.pro && used !== null ? (
          <div className="fp-meter" title={`Využito ${storage}`} aria-hidden="true">
            <span style={{ width: `${Math.round(fullShare * 100)}%` }} data-full={fullShare > 0.9 || undefined} />
          </div>
        ) : null}
      </header>

      {!lib.pro ? (
        <p className="zd-banner fp-banner">
          {team
            ? `Tým ${lib.name} je teď vypnutý. Soubory si můžete stáhnout nebo je smazat, nové nahrát nejde, a do týdne se smažou.`
            : "Režim Pro tu už není aktivní. Soubory můžete smazat nebo si je stáhnout, nové nahrát nejde."}
        </p>
      ) : mode === "readonly" ? (
        <p className="zd-banner fp-banner">Vlastní soubory jsou teď jen pro čtení: hledat, číst a mazat jde, nahrávat a upravovat ne. Zkuste to později.</p>
      ) : mode === "off" ? (
        <p className="zd-banner fp-banner">Vlastní soubory jsou teď dočasně vypnuté. Mazat a stahovat soubory jde dál.</p>
      ) : team ? (
        <p className="zd-banner zd-banner-team fp-banner">
          Soubory tady vidí všichni členové týmu {lib.name} a asistent v nich hledá i pro ně.{" "}
          {lib.canManageAll ? "Jako správce týmu můžete upravit a smazat kterýkoli z nich." : "Upravit a smazat můžete ty, které jste nahráli vy."}
        </p>
      ) : null}

      <div className="fp-toolbar">
        <nav className="fp-crumbs" aria-label="Umístění">
          <button
            type="button"
            className="fp-crumb"
            aria-current={folderId === null && !q ? "page" : undefined}
            data-drop={dropOver === "crumb:root" || undefined}
            onClick={() => openFolder(null)}
            {...dropProps(null, "crumb:root")}
          >
            Všechny soubory
          </button>
          {path.map((f) => (
            <span key={f.id} className="fp-crumb-wrap">
              <span className="fp-sep" aria-hidden="true">
                ›
              </span>
              <button
                type="button"
                className="fp-crumb"
                aria-current={f.id === folderId && !q ? "page" : undefined}
                data-drop={dropOver === `crumb:${f.id}` || undefined}
                onClick={() => openFolder(f.id)}
                {...dropProps(f.id, `crumb:${f.id}`)}
              >
                {f.name}
              </button>
            </span>
          ))}
        </nav>
        <label className="fp-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4-4" />
          </svg>
          <input id="fp-q" type="search" placeholder="Hledat v knihovně" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Hledat v názvech souborů a složek" />
        </label>
        {canFolders ? (
          <button type="button" className="zd-btn zd-btn-secondary fp-btn" onClick={() => void createFolder()} disabled={busy}>
            <FolderGlyph size={16} />
            Nová složka
          </button>
        ) : null}
        {writable && lib.canUpload ? (
          <>
            <button type="button" className="zd-btn zd-btn-primary fp-btn" onClick={() => picker.current?.click()} disabled={uploads.unsupported}>
              <ZIcon name="upload" size={15} />
              Nahrát soubory
            </button>
            <input
              ref={picker}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                uploads.add(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>

      {uploads.unsupported ? <p className="zd-banner fp-banner">{uploads.unsupportedText}</p> : null}
      {uploads.current || uploads.queue.length > 0 || uploads.log.length > 0 ? (
        <div className="fp-uploads" aria-live="polite">
          {uploads.current ? (
            <p className="zd-progress" role="status">
              <span className="zd-spinner" aria-hidden="true" />
              <strong className="zd-ellipsis">{uploads.current.file.name}</strong>
              <span>{uploads.current.progress}</span>
              {uploads.queue.length > 0 ? <span className="zd-muted">· ve frontě {uploads.queue.length}</span> : null}
            </p>
          ) : null}
          {uploads.log.map((entry, i) => (
            <p key={`${entry.name}-${i}`} className="zd-error fp-upload-error" role="alert">
              <span>
                <strong>{entry.name}:</strong> {entry.message}
              </span>
              <button type="button" className="fp-x" aria-label="Skrýt" onClick={() => uploads.dismiss(i)}>
                <ZIcon name="close" size={14} />
              </button>
            </p>
          ))}
        </div>
      ) : null}

      <div className="fp-split">
        <section
          className="fp-list"
          aria-label="Soubory"
          data-files-over={fileDrag || undefined}
          onDragOver={onListDragOver}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setFileDrag(false);
          }}
          onDrop={onListDrop}
        >
          <div className="fp-row fp-cols" role="row">
            <span>Název</span>
            <span className="fp-num fp-c-hide">Stran</span>
            <span className="fp-c-hide">Nahrál</span>
            <span className="fp-c-hide">Přidáno</span>
            <span />
          </div>
          {error ? (
            <p className="zd-error fp-pad" role="alert">
              {error}
            </p>
          ) : documents === null ? (
            <p className="zd-progress fp-pad" role="status">
              <span className="zd-spinner" aria-hidden="true" />
              Načítám soubory…
            </p>
          ) : items.length === 0 ? (
            <div className="fp-empty">
              <FolderGlyph size={48} />
              <strong>{q ? "Nic nenalezeno" : folderId ? "Složka je prázdná" : "Zatím tu nic není"}</strong>
              <span>
                {q
                  ? "Hledá se v názvech souborů a složek v celé knihovně."
                  : writable && lib.canUpload
                    ? "Přetáhněte sem soubory, nebo je nahrajte tlačítkem nahoře. PDF, DOCX, TXT nebo MD."
                    : "Nic sem teď nahrát nejde."}
              </span>
            </div>
          ) : (
            items.map((item) => {
              const key = keyOf(item);
              const isFolder = item.kind === "folder";
              const manage = canManage(item);
              const doc = item.kind === "doc" ? item.doc : null;
              const folder = item.kind === "folder" ? item.folder : null;
              const pending = doc ? PENDING.has(doc.status) || doc.status === "deleting" : false;
              const ext = doc ? extOf(doc.fileName) || doc.fileKind : "";
              const sub: string[] = [];
              if (q) sub.push(where(isFolder ? item.folder.parentId : (doc!.folderId ?? null)));
              if (isFolder) sub.push(itemsLabel(childCount.get(item.folder.id) ?? 0));
              else if (doc) {
                if (pending) sub.push(doc.status === "deleting" ? "Mažu…" : "Zpracovávám…");
                else if (doc.status === "error") sub.push(statusBadge(doc.status, doc.statusDetail).label);
                else {
                  sub.push(typeLabel(doc.docType));
                  if (doc.status === "review") sub.push("ke kontrole");
                }
                if (doc.fileBytes) sub.push(formatBytes(doc.fileBytes));
              }
              return (
                <div
                  key={key}
                  role="row"
                  tabIndex={0}
                  className="fp-row fp-item"
                  data-folder={isFolder || undefined}
                  aria-selected={doc ? doc.id === openId : undefined}
                  data-drop={dropOver === key || undefined}
                  data-bad={doc?.status === "error" || undefined}
                  draggable={manage && renaming !== key && !pending}
                  onDragStart={(e) => {
                    dragKey.current = key;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", nameOf(item));
                  }}
                  onDragEnd={() => {
                    dragKey.current = null;
                    setDropOver(null);
                  }}
                  {...(isFolder ? dropProps(item.folder.id, key) : {})}
                  onClick={() => {
                    if (renaming === key) return;
                    if (isFolder) openFolder(item.folder.id);
                    else select(doc!.id === openId ? null : doc!.id);
                  }}
                  onDoubleClick={() => {
                    if (!isFolder && manage) setRenaming(key);
                  }}
                  onKeyDown={(e) => onRowKey(e, item)}
                >
                  <span className="fp-name">
                    {isFolder ? <FolderGlyph /> : <span className={`fp-doc fp-doc-${ext}`}>{(ext || kindLabel(doc!.fileKind)).toUpperCase().slice(0, 4)}</span>}
                    {renaming === key ? (
                      <RenameInput item={item} onDone={(value) => void renameItem(item, value)} onCancel={() => setRenaming(null)} />
                    ) : (
                      <span className="fp-name-text">
                        <b title={nameOf(item)}>{nameOf(item)}</b>
                        {sub.length ? <span>{sub.join(" · ")}</span> : null}
                      </span>
                    )}
                    {pending ? <span className="zd-spinner" aria-label="Zpracovávám" /> : null}
                  </span>
                  <span className="fp-meta fp-num fp-c-hide">{doc ? (doc.physicalPages ?? doc.billablePages) : ""}</span>
                  <span className="fp-meta fp-c-hide">{(doc ?? folder)!.mine ? "Vy" : team ? "Člen týmu" : ""}</span>
                  <span className="fp-meta fp-c-hide">{formatDate(doc ? doc.uploadedAt : folder!.createdAt)}</span>
                  <button
                    type="button"
                    className="fp-more"
                    aria-label={`Akce: ${nameOf(item)}`}
                    aria-expanded={menu?.key === key}
                    onClick={(e) => openMenu(e, item)}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="19" cy="12" r="1.6" />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
          {fileDrag ? <div className="fp-dropcover">Pusťte soubory sem{folderId ? ` do složky „${byId.get(folderId)?.name ?? ""}“` : ""}</div> : null}
        </section>

        {openDoc ? (
          <DetailPanel
            key={openDoc.id}
            doc={openDoc}
            readonly={!writable}
            canManage={canManageDoc(openDoc)}
            location={where(openDoc.folderId ?? null)}
            onClose={() => select(null)}
            onRename={() => setRenaming(`d:${openDoc.id}`)}
            onDelete={() => setConfirmDelete(openDoc)}
            onChanged={reload}
            onDeleted={() => {
              setDocuments((list) => list?.filter((d) => d.id !== openDoc.id) ?? list);
              select(null);
              reload();
              void refreshSummary();
            }}
            onSaved={(detail) =>
              setDocuments((list) => list?.map((d) => (d.id === detail.id ? { ...d, title: detail.title, docType: detail.docType, status: detail.status, statusDetail: detail.statusDetail } : d)) ?? list)
            }
          />
        ) : null}
      </div>

      <p className="zd-muted zd-small fp-rules">
        Nahráním potvrzujete, že k souboru máte právo a že nejde o spisy klientů ani neveřejné osobní údaje (
        <a href="/podminky" target="_blank" rel="noopener">
          pravidla
        </a>
        ). Asistent pracuje s textem souboru, originál máte uložený tady.
      </p>

      {menu && menuItem ? (
        <div className="fp-menu" role="menu" style={{ top: menu.y, left: menu.x }}>
          {menu.mode === "move" ? (
            <MoveMenu
              item={menuItem}
              folders={folders}
              isInside={isInside}
              rootLabel="Všechny soubory"
              onPick={(target) => {
                setMenu(null);
                void moveItem(menuItem, target);
              }}
            />
          ) : (
            <>
              {menuItem.kind === "folder" ? (
                <button type="button" role="menuitem" className="fp-mi" onClick={() => openFolder(menuItem.folder.id)}>
                  <FolderGlyph size={15} />
                  Otevřít
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="fp-mi"
                    onClick={() => {
                      setMenu(null);
                      select(menuItem.doc.id);
                    }}
                  >
                    <ZIcon name="file" size={15} />
                    Zobrazit podrobnosti
                  </button>
                  {menuItem.doc.original === "ready" ? (
                    <a role="menuitem" className="fp-mi" href={`/api/files/documents/${menuItem.doc.id}/original`} download onClick={() => setMenu(null)}>
                      <ZIcon name="download" size={15} />
                      Stáhnout originál
                      <span className="fp-mi-end">{formatBytes(menuItem.doc.fileBytes ?? 0)}</span>
                    </a>
                  ) : null}
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className="fp-mi"
                disabled={!canManage(menuItem)}
                onClick={() => {
                  setMenu(null);
                  setRenaming(menu.key);
                }}
              >
                <ZIcon name="edit" size={15} />
                Přejmenovat
                <span className="fp-mi-end">F2</span>
              </button>
              <button type="button" role="menuitem" className="fp-mi" disabled={!canManage(menuItem)} onClick={() => setMenu({ ...menu, mode: "move" })}>
                <FolderGlyph size={15} />
                Přesunout do…
              </button>
              <div className="fp-mi-sep" />
              <button
                type="button"
                role="menuitem"
                className="fp-mi fp-mi-danger"
                disabled={!canManage(menuItem)}
                onClick={() => {
                  setMenu(null);
                  if (menuItem.kind === "folder") void deleteFolder(menuItem.folder);
                  else setConfirmDelete(menuItem.doc);
                }}
              >
                <ZIcon name="trash" size={15} />
                Smazat
              </button>
              {!canManage(menuItem) && writable ? (
                <p className="fp-mi-note">{menuItem.kind === "doc" ? "Nahrál ho jiný člen týmu. Upravit ho může on nebo správce týmu." : "Složky tu teď spravovat nejde."}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="fp-confirm">
          <Confirm
            question={<>Smazat „{confirmDelete.fileName}“? Originál, text i index se odstraní natrvalo.</>}
            confirmLabel="Smazat"
            busy={busy}
            onConfirm={() => void deleteDocument(confirmDelete)}
            onCancel={() => setConfirmDelete(null)}
          />
        </div>
      ) : null}

      {toast ? (
        <div className="fp-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo ? (
            <button
              type="button"
              onClick={() => {
                const undo = toast.undo;
                setToast(null);
                void undo?.();
              }}
            >
              Vrátit
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RenameInput({ item, onDone, onCancel }: { item: Item; onDone: (value: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const name = input.value;
    const dot = item.kind === "doc" ? name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [item.kind]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value === null) onCancel();
    else onDone(value);
  };
  return (
    <input
      ref={ref}
      className="fp-rename"
      defaultValue={nameOf(item)}
      maxLength={item.kind === "folder" ? 120 : 255}
      aria-label="Nový název"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function MoveMenu({
  item,
  folders,
  isInside,
  rootLabel,
  onPick,
}: {
  item: Item;
  folders: FolderItem[];
  isInside: (id: string, ancestor: string) => boolean;
  rootLabel: string;
  onPick: (target: string | null) => void;
}) {
  const current = item.kind === "folder" ? item.folder.parentId : (item.doc.folderId ?? null);
  const allowed = folders.filter((f) => item.kind !== "folder" || (f.id !== item.folder.id && !isInside(f.id, item.folder.id)));
  const rows: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of allowed.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, "cs", { numeric: true }))) {
      rows.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return (
    <>
      <p className="fp-mi-head">Přesunout do</p>
      <button type="button" role="menuitem" className="fp-mi" disabled={current === null} onClick={() => onPick(null)}>
        <ZIcon name="library" size={15} />
        {rootLabel}
      </button>
      {rows.map((r) => (
        <button key={r.id} type="button" role="menuitem" className="fp-mi" disabled={r.id === current} style={{ paddingLeft: 10 + r.depth * 14 }} onClick={() => onPick(r.id)}>
          <FolderGlyph size={15} />
          <span className="zd-ellipsis">{r.name}</span>
        </button>
      ))}
      {rows.length === 0 ? <p className="fp-mi-note">Zatím tu nejsou žádné složky.</p> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The side panel of one document

function DetailPanel({
  doc,
  readonly,
  canManage,
  location,
  onClose,
  onRename,
  onDelete,
  onChanged,
  onDeleted,
  onSaved,
}: {
  doc: DocumentListItem;
  readonly: boolean;
  canManage: boolean;
  location: string;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onSaved: (detail: DocumentDetail) => void;
}) {
  const [tab, setTab] = useState<"meta" | "text">("meta");
  const [preview, setPreview] = useState<string | null>(null);
  const ext = extOf(doc.fileName) || doc.fileKind;
  const pending = PENDING.has(doc.status) || doc.status === "deleting";
  const inline = doc.original === "ready" && (doc.fileKind === "pdf" || doc.fileKind === "txt" || doc.fileKind === "md");
  const originalUrl = `/api/files/documents/${encodeURIComponent(doc.id)}/original`;

  useEffect(() => {
    if (tab !== "text" || preview !== null || pending) return;
    const ctrl = new AbortController();
    void api<DocumentDetail>(`/api/files/documents/${encodeURIComponent(doc.id)}`, { signal: ctrl.signal })
      .then((res) => setPreview(res.ok ? res.data.preview : res.error))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [tab, preview, pending, doc.id]);

  return (
    <aside className="fp-detail" aria-label="Podrobnosti souboru">
      <div className="fp-detail-head">
        <span className={`fp-doc fp-doc-${ext}`}>{ext.toUpperCase().slice(0, 4)}</span>
        <b title={doc.fileName}>{doc.fileName}</b>
        <button type="button" className="fp-x" aria-label="Zavřít podrobnosti" onClick={onClose}>
          <ZIcon name="close" size={16} />
        </button>
      </div>

      <div className="fp-detail-actions">
        {inline ? (
          <a className="zd-btn zd-btn-primary fp-btn" href={`${originalUrl}?inline=1`} target="_blank" rel="noopener">
            Otevřít
          </a>
        ) : null}
        {doc.original === "ready" ? (
          <a className={`zd-btn ${inline ? "zd-btn-secondary" : "zd-btn-primary"} fp-btn`} href={originalUrl} download>
            <ZIcon name="download" size={15} />
            Stáhnout originál
          </a>
        ) : null}
        {canManage ? (
          <button type="button" className="zd-btn zd-btn-secondary fp-btn" onClick={onRename}>
            <ZIcon name="edit" size={15} />
            Přejmenovat
          </button>
        ) : null}
      </div>

      <dl className="fp-facts">
        <div>
          <dt>Originál</dt>
          <dd>
            {doc.original === "ready"
              ? `${kindLabel(doc.fileKind)}, ${formatBytes(doc.fileBytes ?? 0)}`
              : doc.original === "uploading"
                ? "Nahrává se, nebo se nahrávání nedokončilo."
                : "Neuložený. Soubor se nahrál dřív, než se originály ukládaly; je tu jen text."}
          </dd>
        </div>
        <div>
          <dt>Pro asistenta</dt>
          <dd>
            {pending ? "Zpracovává se…" : doc.status === "error" ? statusBadge(doc.status, doc.statusDetail).label : doc.status === "review" ? "Čeká na kontrolu údajů" : `Text připraven · ${doc.billablePages} ${plural(doc.billablePages, "strana", "strany", "stran")}`}
          </dd>
        </div>
        <div>
          <dt>Umístění</dt>
          <dd>{location.replace(/^ve složce /, "").replace(/^v kořeni knihovny$/, "Všechny soubory")}</dd>
        </div>
        <div>
          <dt>Nahrál</dt>
          <dd>
            {doc.mine ? "Vy" : "Člen týmu"}, {formatDate(doc.uploadedAt)}
          </dd>
        </div>
      </dl>

      <div className="fp-detail-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "meta"} onClick={() => setTab("meta")}>
          Údaje
        </button>
        <button type="button" role="tab" aria-selected={tab === "text"} onClick={() => setTab("text")}>
          Text pro asistenta
        </button>
      </div>

      {tab === "meta" ? (
        pending ? (
          <p className="zd-progress fp-pad" role="status">
            <span className="zd-spinner" aria-hidden="true" />
            Soubor se zpracovává, údaje půjde upravit za chvíli.
          </p>
        ) : (
          <FileEditor doc={doc} readonly={readonly} onChanged={onChanged} onDeleted={onDeleted} onSaved={onSaved} onClose={onClose} />
        )
      ) : (
        <div className="fp-text">
          {pending ? (
            <p className="zd-muted">Text bude k dispozici po zpracování.</p>
          ) : preview === null ? (
            <p className="zd-progress" role="status">
              <span className="zd-spinner" aria-hidden="true" />
              Načítám text…
            </p>
          ) : (
            <>
              <pre>{preview}</pre>
              <p className="zd-muted zd-small">Začátek textu, se kterým pracuje asistent. Celý si stáhnete v Údajích tlačítkem Stáhnout text.</p>
            </>
          )}
        </div>
      )}
      {pending && canManage ? (
        <button type="button" className="zd-link-button zd-danger-link fp-detail-delete" onClick={onDelete}>
          Smazat soubor
        </button>
      ) : null}
    </aside>
  );
}
