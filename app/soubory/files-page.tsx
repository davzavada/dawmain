"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import type { DocumentDetail, DocumentListItem, FolderItem, LibrarySummary } from "@/src/files/web-types";
import { api } from "../_zdroje/api";
import { Confirm } from "../_zdroje/dialog";
import { PENDING, useDocumentList } from "../_zdroje/file-editor";
import { formatDate, formatStorageBytes as formatBytes, kindLabel, zBefore, plural, statusBadge } from "../_zdroje/format";
import { ZIcon } from "../_zdroje/icons";
import { Loading } from "../_zdroje/loading";
import { DocViewer } from "../_zdroje/doc-viewer";
import { FolderGlyph, LibraryMark } from "../_zdroje/library-mark";
import { refreshSummary, requestSignIn, useZdroje } from "../_zdroje/store";
import type { TeamPanel } from "@/src/admin/team-manage";
import { teamPanelAction } from "./team-actions";
import { TeamDialog } from "./team-dialog";
import { ACCEPT, useUploads } from "../_zdroje/upload";

/**
 * The Vlastní soubory page (/soubory for the personal library,
 * /soubory/<handle> for a team's): a file manager over one library. Folders
 * (blue, nested) and documents in one table; the open folder is ?slozka=<id>
 * and the open document ?dokument=<id>, so Back and a copied link work.
 *
 *   - "Nová složka" creates one and puts its name in edit mode at once;
 *     F2 or ⋯ → Přejmenovat renames inline (Enter saves, Escape cancels;
 *     a document keeps its extension).
 *   - Drag a row onto a folder or onto the breadcrumb to move it, or use
 *     ⋯ → Přesunout do…; a rename or a move can be undone from the toast.
 *   - Deleting a folder moves what was in it one level up (a folder with
 *     content asks first); deleting a document asks first (it is gone for
 *     good).
 *   - Files dropped anywhere on the list (or picked with "Nahrát soubory")
 *     upload into the open folder: the text for the assistant, then the original.
 *   - Clicking a document opens it in the large viewer (../_zdroje/doc-viewer.tsx);
 *     a folder's arrow opens it in place, a click on its row goes into it.
 *   - ⋯ on a row (and in the viewer) holds every action: the metadata form
 *     in the side panel, download, rename, move, delete. The menu is
 *     keyboard-operable (arrows, Escape returns the focus).
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

/** While the account loads: the page's own shape (header, toolbar, rows), so nothing jumps when it arrives. */
function PageLoading() {
  return (
    <div className="fp fp-skeleton" role="status">
      <span className="sr-only">Načítám…</span>
      <div className="fp-skeleton-head" aria-hidden="true">
        <span className="zd-shimmer" />
        <span className="fp-skeleton-title">
          <span className="zd-shimmer" style={{ width: 200, height: 22 }} />
          <span className="zd-shimmer" style={{ width: 120, height: 12 }} />
        </span>
      </div>
      <div className="fp-skeleton-toolbar" aria-hidden="true">
        <span className="zd-shimmer" style={{ flex: "1 1 120px", maxWidth: 160, height: 14 }} />
        <span style={{ flex: "1 1 auto" }} />
        <span className="zd-shimmer" style={{ width: 200 }} />
        <span className="zd-shimmer" style={{ width: 120 }} />
      </div>
      <div className="fp-list" aria-hidden="true">
        <Loading label="" shape="rows" count={6} />
      </div>
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
  const [confirmDelete, setConfirmDelete] = useState<Item | null>(null);
  /** Where the delete confirmation opens: next to the item (its ⋯ menu or its row), not at the bottom of the screen. */
  const [confirmAt, setConfirmAt] = useState<{ x: number; y: number } | null>(null);
  /** Folders opened in place with their disclosure arrow (kept per library in this browser). */
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(`fp-open:${lib.id}`);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleExpanded = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(`fp-open:${lib.id}`, JSON.stringify([...next]));
      } catch {
        // private window: the arrows still work for this visit
      }
      return next;
    });
  const [busy, setBusy] = useState(false);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const dragKey = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  /** The ⋯ button the menu was opened from: the focus returns to it on Escape. */
  const menuOpener = useRef<HTMLElement | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const base = lib.kind === "user" ? "/soubory" : `/soubory/${encodeURIComponent(lib.handle)}`;
  const team = lib.kind === "org";
  const writable = lib.pro && mode === "on";
  const canFolders = writable && lib.canUpload;

  /** "Spravovat tým": asked once per team page; null for anyone who may not manage the team (and for the personal library). */
  const [teamPanel, setTeamPanel] = useState<TeamPanel | null>(null);
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    setTeamPanel(null);
    if (!team) return;
    let live = true;
    teamPanelAction(lib.id)
      .then((panel) => {
        if (live) setTeamPanel(panel);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [team, lib.id]);

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
  const closeViewer = useCallback(() => go({ doc: null }, true), [go]);

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

  const searching = q.trim() !== "";
  const rows: Array<{ item: Item; depth: number }> = useMemo(() => {
    const docs = documents ?? [];
    const byName = (a: string, b: string) => a.localeCompare(b, "cs", { numeric: true });
    if (q.trim()) {
      const needle = q.trim().toLocaleLowerCase("cs");
      const f = folders.filter((x) => x.name.toLocaleLowerCase("cs").includes(needle)).map((folder): Item => ({ kind: "folder", folder }));
      const d = docs
        .filter((x) => x.fileName.toLocaleLowerCase("cs").includes(needle) || x.title.toLocaleLowerCase("cs").includes(needle))
        .map((doc): Item => ({ kind: "doc", doc }));
      return [...f, ...d]
        .sort((a, b) => (a.kind === b.kind ? byName(nameOf(a), nameOf(b)) : a.kind === "folder" ? -1 : 1))
        .map((item) => ({ item, depth: 0 }));
    }
    const out: Array<{ item: Item; depth: number }> = [];
    // A folder's content: its subfolders, then its documents; an expanded subfolder's content follows it, indented.
    const walk = (parent: string | null, depth: number) => {
      if (depth > 32) return;
      for (const folder of folders.filter((x) => x.parentId === parent).sort((a, b) => byName(a.name, b.name))) {
        out.push({ item: { kind: "folder", folder }, depth });
        if (expanded.has(folder.id)) walk(folder.id, depth + 1);
      }
      for (const doc of docs
        .filter((x) => (x.folderId ?? null) === parent || (parent === null && x.folderId && !byId.has(x.folderId)))
        .sort((a, b) => byName(a.fileName, b.fileName))) {
        out.push({ item: { kind: "doc", doc }, depth });
      }
    };
    walk(folderId, 0);
    return out;
  }, [documents, folders, folderId, q, byId, expanded]);
  const items = useMemo(() => rows.map((r) => r.item), [rows]);

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
    const done = await call<{ deletedDocuments: number }>(`/api/files/folders/${folder.id}`, "DELETE");
    setConfirmDelete(null);
    if (done === null) return;
    // The server deleted the folder with everything under it; read the library again.
    const gone = new Set([folder.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
          gone.add(f.id);
          grew = true;
        }
      }
    }
    setFolders((list) => list.filter((f) => !gone.has(f.id)));
    setDocuments((list) => list?.filter((d) => !d.folderId || !gone.has(d.folderId)) ?? list);
    if (openDoc?.folderId && gone.has(openDoc.folderId)) select(null);
    reload();
    void refreshSummary();
    if (folderId && gone.has(folderId)) openFolder(folder.parentId);
    say(`Složka „${folder.name}“ smazána${done.deletedDocuments > 0 ? ` i s ${done.deletedDocuments} ${plural(done.deletedDocuments, "dokumentem", "dokumenty", "dokumenty")}` : ""}.`);
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

  /** Delete from the menu or the keyboard: an empty folder goes at once, anything else asks first. */
  function askDelete(item: Item, anchor: { right: number; top: number }) {
    if (item.kind === "folder" && (childCount.get(item.folder.id) ?? 0) === 0) {
      void deleteFolder(item.folder);
      return;
    }
    // .fp-confirm is at most 360 px wide and about 130 px tall (globals.css).
    setConfirmAt({
      x: Math.max(8, Math.min(anchor.right - 360, window.innerWidth - 368)),
      y: Math.max(8, Math.min(anchor.top, window.innerHeight - 150)),
    });
    setConfirmDelete(item);
  }

  /** Rename in the list: the viewer closes and, if the row is not on screen, its folder opens. */
  function startRename(item: Item) {
    const key = keyOf(item);
    setMenu(null);
    if (!items.some((i) => keyOf(i) === key)) {
      setQ("");
      const parent = item.kind === "folder" ? item.folder.parentId : (item.doc.folderId ?? null);
      go({ folder: parent && byId.has(parent) ? parent : null });
    } else if (openId) select(null);
    setRenaming(key);
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
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && item.kind === "folder" && !searching) {
      e.preventDefault();
      if ((e.key === "ArrowRight") !== expanded.has(item.folder.id)) toggleExpanded(item.folder.id);
    } else if (e.key === "F2" && canManage(item)) {
      e.preventDefault();
      setRenaming(keyOf(item));
    } else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && canManage(item)) {
      e.preventDefault();
      const row = (e.currentTarget as HTMLElement).getBoundingClientRect();
      askDelete(item, { right: row.right, top: row.bottom + 4 });
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
    menuOpener.current = e.currentTarget as HTMLElement;
    const box = menuOpener.current.getBoundingClientRect();
    // .fp-menu is at most 340 px tall and 280 px wide (globals.css).
    setMenu({ key, mode: "main", x: Math.max(8, Math.min(box.right - 230, window.innerWidth - 290)), y: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 350)) });
  }
  const menuFocusKey = menu ? `${menu.key}:${menu.mode}` : null;
  useEffect(() => {
    if (menuFocusKey) menuBox.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [menuFocusKey]);
  function onMenuKey(e: KeyboardEvent) {
    const list = [...(menuBox.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Escape") {
      // Before the viewer's own Escape: only the menu closes, and the focus goes back to its ⋯.
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      menuOpener.current?.focus();
    } else if (e.key === "Tab") {
      setMenu(null);
    }
  }
  useEffect(() => {
    if (!menu) return;
    const close = (e: globalThis.MouseEvent) => {
      // The ⋯ buttons toggle the menu themselves (their click follows this mousedown).
      if (!(e.target as HTMLElement).closest(".fp-menu, .fp-more")) setMenu(null);
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
  const subtitle = lib.pro ? storage : team ? "Tým je vypnutý" : null;
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
    <div className="fp">
      <header className="fp-head">
        <LibraryMark lib={lib} size={40} />
        <div className="fp-head-text">
          <h1>{team ? lib.name : "Osobní soubory"}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {teamPanel?.canManage ? (
          <button type="button" className="zd-btn zd-btn-secondary fp-btn" onClick={() => setManaging(true)}>
            <ZIcon name="users" size={15} />
            Spravovat tým
          </button>
        ) : null}
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
            : "Režim Pro (právníky) tu už není aktivní. Soubory můžete smazat nebo si je stáhnout, nové nahrát nejde."}
        </p>
      ) : mode === "readonly" ? (
        <p className="zd-banner fp-banner">Vlastní soubory jsou teď jen pro čtení: hledat, číst a mazat jde, nahrávat a upravovat ne. Zkuste to později.</p>
      ) : mode === "off" ? (
        <p className="zd-banner fp-banner">Vlastní soubory jsou teď dočasně vypnuté. Mazat a stahovat soubory jde dál.</p>
      ) : null}

      <div className="fp-toolbar">
        <nav className="fp-crumbs" aria-label="Umístění">
          <button
            type="button"
            className="fp-crumb"
            aria-current={folderId === null && !searching ? "page" : undefined}
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
                aria-current={f.id === folderId && !searching ? "page" : undefined}
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
            <Loading label="Načítám soubory…" shape="rows" count={6} />
          ) : items.length === 0 ? (
            <div className="fp-empty">
              <FolderGlyph size={48} />
              <strong>{searching ? "Nic nenalezeno" : folderId ? "Složka je prázdná" : "Zatím tu nic není"}</strong>
            </div>
          ) : (
            rows.map(({ item, depth }) => {
              const key = keyOf(item);
              const isFolder = item.kind === "folder";
              const manage = canManage(item);
              const doc = item.kind === "doc" ? item.doc : null;
              const folder = item.kind === "folder" ? item.folder : null;
              const pending = doc ? PENDING.has(doc.status) || doc.status === "deleting" : false;
              const ext = doc ? extOf(doc.fileName) || doc.fileKind : "";
              const sub: string[] = [];
              if (searching) sub.push(where(isFolder ? item.folder.parentId : (doc!.folderId ?? null)));
              if (isFolder) sub.push(itemsLabel(childCount.get(item.folder.id) ?? 0));
              else if (doc) {
                if (pending) sub.push(doc.status === "deleting" ? "Mažu…" : "Zpracovávám…");
                else if (doc.status === "error") sub.push(statusBadge(doc.status, doc.statusDetail).label);
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
                  aria-level={searching ? undefined : depth + 1}
                  aria-expanded={isFolder && !searching ? expanded.has(item.folder.id) : undefined}
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
                    else select(doc!.id);
                  }}
                  onKeyDown={(e) => onRowKey(e, item)}
                >
                  <span className="fp-name" style={depth ? { paddingLeft: depth * 22 } : undefined}>
                    {isFolder && !searching ? (
                      <button
                        type="button"
                        className="fp-disclosure"
                        aria-label={expanded.has(item.folder.id) ? `Sbalit ${item.folder.name}` : `Rozbalit ${item.folder.name}`}
                        aria-expanded={expanded.has(item.folder.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(item.folder.id);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                          <path d="M3 1.5 7 5 3 8.5z" fill="currentColor" />
                        </svg>
                      </button>
                    ) : !searching ? (
                      <span className="fp-disclosure-space" aria-hidden="true" />
                    ) : null}
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

      </div>

      {openDoc ? (
        <DocViewer
          key={openDoc.id}
          doc={openDoc}
          onClose={closeViewer}
          actions={
            <button type="button" className="dv-tool fp-more fp-more-on" aria-label={`Akce: ${openDoc.fileName}`} aria-expanded={menu?.key === `d:${openDoc.id}`} onClick={(e) => openMenu(e, { kind: "doc", doc: openDoc })}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
          }
        />
      ) : null}

      {menu && menuItem ? (
        <div className="fp-menu" role="menu" ref={menuBox} style={{ top: menu.y, left: menu.x }} onKeyDown={onMenuKey}>
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
                  {menuItem.doc.original === "ready" ? (
                    <a role="menuitem" className="fp-mi" href={`/api/files/documents/${menuItem.doc.id}/original`} download onClick={() => setMenu(null)}>
                      <ZIcon name="download" size={15} />
                      Stáhnout
                      <span className="fp-mi-end">{formatBytes(menuItem.doc.fileBytes ?? 0)}</span>
                    </a>
                  ) : menuItem.doc.canDelete && (menuItem.doc.status === "ready" || menuItem.doc.status === "review") ? (
                    <a
                      role="menuitem"
                      className="fp-mi"
                      href={`/api/files/documents/${menuItem.doc.id}/export?lib=${encodeURIComponent(menuItem.doc.libraryId)}`}
                      download
                      onClick={() => setMenu(null)}
                    >
                      <ZIcon name="download" size={15} />
                      Stáhnout text
                      <span className="fp-mi-end">originál není</span>
                    </a>
                  ) : null}
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className="fp-mi"
                disabled={!canManage(menuItem)}
                onClick={() => startRename(menuItem)}
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
                  // Where the menu was: the confirmation takes its place.
                  askDelete(menuItem, { right: menu.x + 230, top: menu.y });
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
        <div className="fp-confirm" style={confirmAt ? { left: confirmAt.x, top: confirmAt.y } : undefined}>
          <Confirm
            question={
              confirmDelete.kind === "doc" ? <>Smazat natrvalo?</> : <>Smazat složku i s obsahem natrvalo?</>
            }
            confirmLabel="Smazat"
            busy={busy}
            onConfirm={() => void (confirmDelete.kind === "doc" ? deleteDocument(confirmDelete.doc) : deleteFolder(confirmDelete.folder))}
            onCancel={() => setConfirmDelete(null)}
          />
        </div>
      ) : null}

      {managing && teamPanel ? (
        <TeamDialog
          teamId={lib.id}
          name={lib.name}
          panel={teamPanel}
          onClose={() => setManaging(false)}
          onChanged={(panel) => {
            setTeamPanel(panel);
            void refreshSummary();
          }}
        />
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

