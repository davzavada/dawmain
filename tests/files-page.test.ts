// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentListItem, FolderItem, LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The Vlastní soubory page (app/soubory/files-page.tsx) in a DOM
 * (happy-dom): the store's summary and the API are a faked fetch, Next's
 * router a small URL store (?slozka, ?dokument). Covers: folders before
 * documents, a folder opened through ?slozka, "Nová složka" (POST, then its
 * name in edit mode), inline rename (Enter saves, Escape cancels, Vrátit
 * undoes), ⋯ → Přesunout do…, a team member's disabled actions, the detail
 * panel's "Stáhnout originál" only for a stored original, an unknown
 * library and the signed-out page.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { knihovna: undefined as string[] | undefined, search: "", pushed: [] as string[], replaced: [] as string[] };
  const go = (href: string) => {
    state.search = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    listeners.forEach((l) => l());
  };
  return {
    state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    router: {
      push: (href: string) => {
        state.pushed.push(href);
        go(href);
      },
      replace: (href: string) => {
        state.replaced.push(href);
        go(href);
      },
    },
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ knihovna: nav.state.knihovna }),
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(nav.subscribe, () => nav.state.search)),
  useRouter: () => nav.router,
  usePathname: () => "/soubory",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const store = await import("@/app/_zdroje/store");
const { FilesPage, freeName } = await import("@/app/soubory/files-page");

// ---------------------------------------------------------------------------
// Fixtures

const F_SMLOUVY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const F_VZORY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const F_NOVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const D_ZAKON = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const D_KOMENTAR = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const D_SMLOUVA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";

function library(over: Partial<LibrarySummary> = {}): LibrarySummary {
  return {
    id: "user_a",
    kind: "user",
    name: "Osobní",
    role: "owner",
    pro: true,
    canUpload: true,
    canManageAll: true,
    handle: "osobni",
    logoUrl: null,
    quotaBytes: 104_857_600,
    bytesUsed: 3_000,
    counts: { total: 3, ready: 3, review: 0, processing: 0, error: 0, searchable: 3 },
    ...over,
  };
}

function folder(id: string, name: string, parentId: string | null, over: Partial<FolderItem> = {}): FolderItem {
  return { id, libraryId: "user_a", parentId, name, createdAt: "2026-09-01T00:00:00Z", mine: true, ...over };
}

function doc(id: string, fileName: string, folderId: string | null, over: Partial<DocumentListItem> = {}): DocumentListItem {
  return {
    id,
    libraryId: "user_a",
    title: fileName.replace(/\.\w+$/, ""),
    fileName,
    fileKind: "pdf",
    fileBytes: 1_000,
    status: "ready",
    statusDetail: null,
    uploadedAt: "2026-09-01T00:00:00Z",
    mine: true,
    canEdit: true,
    canDelete: true,
    docType: "jine",
    publication: null,
    physicalPages: 3,
    billablePages: 3,
    flags: [],
    folderId,
    original: "ready",
    ...over,
  };
}

function detailOf(item: DocumentListItem) {
  return {
    ...item,
    libraryName: "Osobní",
    meta: { doc_type: item.docType, title: item.title, authors: [], editors: [], isbn: [], keywords: [], language: "cs" },
    proposed: null,
    metaVersion: 1,
    confirmedAt: "2026-09-02T00:00:00Z",
    charCount: 100,
    pageLabelSource: "printed",
    converter: "pdf/1",
    rights: "vlastni",
    quality: { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] },
    preview: "Začátek.",
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

let calls: Call[];
let host: HTMLDivElement;
let root: Root;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A small server over `libs`, `folders` and `docs` (mutated by POST and PATCH as the real one would). */
function serve(world: { libs: LibrarySummary[]; folders: FolderItem[]; docs: DocumentListItem[]; mode?: "on" | "readonly" | "off" }) {
  const summary: SummaryResponse = { state: "ok", mode: world.mode ?? "on", termsAccepted: true, libraries: world.libs, maxFileBytes: 104_857_600 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith("/api/files/summary")) return json(summary);
      if (url.startsWith("/api/files/documents?")) return json({ libraryId: "user_a", documents: world.docs, folders: world.folders, total: world.docs.length });
      if (url === "/api/files/folders" && method === "POST") {
        const made = folder(F_NOVA, String(body!.name), (body!.parentId as string | null) ?? null);
        world.folders = [...world.folders, made];
        return json(made, 201);
      }
      const f = /^\/api\/files\/folders\/([^/?]+)$/.exec(url);
      if (f && method === "PATCH") {
        const current = world.folders.find((x) => x.id === f[1])!;
        const next = { ...current, ...("name" in body! ? { name: String(body!.name) } : {}), ...("parentId" in body! ? { parentId: body!.parentId as string | null } : {}) };
        world.folders = world.folders.map((x) => (x.id === next.id ? next : x));
        return json(next);
      }
      const d = /^\/api\/files\/documents\/([^/?]+)$/.exec(url);
      if (d) {
        const current = world.docs.find((x) => x.id === d[1]);
        if (!current) return json({ error: "Dokument nenalezen." }, 404);
        if (method === "PATCH") {
          const next =
            body!.action === "rename"
              ? { ...current, fileName: String(body!.name), title: String(body!.name) }
              : body!.action === "move"
                ? { ...current, folderId: body!.folderId as string | null }
                : current;
          world.docs = world.docs.map((x) => (x.id === next.id ? next : x));
          return json(detailOf(next));
        }
        return json(detailOf(current));
      }
      return json({ error: "?" }, 404);
    }),
  );
  return world;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
  }
}

/** Sign in against the faked summary and render the page at /soubory[/<handle>]?<search>. */
async function open(opts: { handle?: string; search?: string } = {}) {
  nav.state.knihovna = opts.handle ? [opts.handle] : undefined;
  nav.state.search = opts.search ?? "";
  store.setAuth("signed_in");
  await act(async () => {
    await store.refreshSummary();
  });
  await act(async () => root.render(createElement(FilesPage)));
  await settle();
}

beforeEach(() => {
  calls = [];
  nav.state.pushed = [];
  nav.state.replaced = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.setAuth("none");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers over the DOM

const rows = () => [...host.querySelectorAll<HTMLElement>(".fp-item")];
const names = () => rows().map((r) => r.querySelector("b")?.textContent ?? "");
const row = (name: string) => rows().find((r) => r.querySelector("b")?.textContent === name)!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const menuItem = (text: string) => [...host.querySelectorAll<HTMLElement>(".fp-menu [role=menuitem]")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const renameInput = () => host.querySelector<HTMLInputElement>("input.fp-rename");
const writes = () => calls.filter((c) => c.method !== "GET");

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await settle();
}

async function openMenu(name: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Akce: ${name}"]`)!.click());
}

function standard() {
  return serve({
    libs: [library()],
    folders: [folder(F_VZORY, "Vzory", null), folder(F_SMLOUVY, "Smlouvy", null)],
    docs: [doc(D_ZAKON, "zakon.pdf", null), doc(D_KOMENTAR, "Komentar.pdf", null, { original: "missing" }), doc(D_SMLOUVA, "smlouva.docx", F_SMLOUVY, { fileKind: "docx" })],
  });
}

// ---------------------------------------------------------------------------

describe("freeName", () => {
  it("keeps the name or numbers it among the siblings, case-insensitive", () => {
    expect(freeName("Nová složka", ["Smlouvy"])).toBe("Nová složka");
    expect(freeName("Nová složka", ["nová SLOŽKA"])).toBe("Nová složka (2)");
    expect(freeName("Nová složka", ["Nová složka", "Nová složka (2)"])).toBe("Nová složka (3)");
  });
});

describe("the list", () => {
  it("shows the root: folders first (by name), then documents; a folder says how much is in it", async () => {
    standard();
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("Osobní soubory");
    expect(names()).toEqual(["Smlouvy", "Vzory", "Komentar.pdf", "zakon.pdf"]);
    expect(row("Smlouvy").getAttribute("data-folder")).toBe("true");
    expect(row("Smlouvy").textContent).toContain("1 položka");
    expect(row("Vzory").textContent).toContain("prázdná");
    // A document in a folder is not in the root.
    expect(names()).not.toContain("smlouva.docx");
  });

  it("a click on a folder opens it through ?slozka; the breadcrumb leads back", async () => {
    standard();
    await open();
    await act(async () => row("Smlouvy").click());
    await settle();
    expect(nav.state.pushed).toEqual([`/soubory?slozka=${F_SMLOUVY}`]);
    expect(names()).toEqual(["smlouva.docx"]);
    const crumbs = [...host.querySelectorAll(".fp-crumb")].map((c) => c.textContent);
    expect(crumbs).toEqual(["Všechny soubory", "Smlouvy"]);
    await act(async () => button("Všechny soubory")!.click());
    expect(nav.state.pushed.at(-1)).toBe("/soubory");
    expect(names()).toContain("Smlouvy");
  });

  it("a link with ?slozka opens that folder; an empty one says so", async () => {
    standard();
    await open({ search: `slozka=${F_VZORY}` });
    expect(names()).toEqual([]);
    expect(host.textContent).toContain("Složka je prázdná");
  });

  it("searching looks through the whole library and says where each hit is", async () => {
    standard();
    await open();
    const input = host.querySelector<HTMLInputElement>("#fp-q")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "smlouv");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names()).toEqual(["Smlouvy", "smlouva.docx"]);
    expect(row("smlouva.docx").textContent).toContain("ve složce Smlouvy");
  });
});

describe("folders and renaming", () => {
  it("Nová složka creates one in the open folder and puts its name in edit mode; Enter saves the new name", async () => {
    standard();
    await open({ search: `slozka=${F_SMLOUVY}` });
    await act(async () => button("Nová složka")!.click());
    await settle();
    expect(writes()[0]).toEqual({ url: "/api/files/folders", method: "POST", body: { lib: "user_a", parentId: F_SMLOUVY, name: "Nová složka" } });
    const input = renameInput()!;
    expect(input.value).toBe("Nová složka");
    expect(document.activeElement).toBe(input);
    input.value = "Kupní smlouvy";
    await key(input, "Enter");
    expect(writes()[1]).toEqual({ url: `/api/files/folders/${F_NOVA}`, method: "PATCH", body: { name: "Kupní smlouvy" } });
    expect(renameInput()).toBeNull();
    expect(names()).toEqual(["Kupní smlouvy", "smlouva.docx"]);
  });

  it("a taken name gets a number", async () => {
    const world = standard();
    world.folders.push(folder("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", "Nová složka", null));
    await open();
    await act(async () => button("Nová složka")!.click());
    await settle();
    expect(writes()[0].body).toMatchObject({ parentId: null, name: "Nová složka (2)" });
  });

  it("renaming a document: F2, Enter sends PATCH {action: rename}; Vrátit renames it back", async () => {
    standard();
    await open();
    await key(row("zakon.pdf"), "F2");
    const input = renameInput()!;
    expect(input.value).toBe("zakon.pdf");
    // The extension stays out of the selection.
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    input.value = "Občanský zákoník.pdf";
    await key(input, "Enter");
    expect(writes()).toEqual([{ url: `/api/files/documents/${D_ZAKON}`, method: "PATCH", body: { action: "rename", name: "Občanský zákoník.pdf" } }]);
    expect(names()).toContain("Občanský zákoník.pdf");
    expect(host.querySelector(".fp-toast")?.textContent).toContain("Přejmenováno na „Občanský zákoník.pdf“");
    await act(async () => button("Vrátit")!.click());
    await settle();
    expect(writes()[1]).toEqual({ url: `/api/files/documents/${D_ZAKON}`, method: "PATCH", body: { action: "rename", name: "zakon.pdf" } });
    expect(names()).toContain("zakon.pdf");
  });

  it("Escape cancels a rename: nothing is sent, the name stays", async () => {
    standard();
    await open();
    await openMenu("Vzory");
    await act(async () => menuItem("Přejmenovat")!.click());
    const input = renameInput()!;
    input.value = "Jiné";
    await key(input, "Escape");
    expect(renameInput()).toBeNull();
    expect(writes()).toEqual([]);
    expect(names()).toContain("Vzory");
  });

  it("an unchanged or blank name sends nothing", async () => {
    standard();
    await open();
    await key(row("zakon.pdf"), "F2");
    renameInput()!.value = "   ";
    await key(renameInput()!, "Enter");
    expect(writes()).toEqual([]);
    expect(names()).toContain("zakon.pdf");
  });

  it("deleting a folder: an empty one goes at once, one with content asks first", async () => {
    standard();
    await open();
    await key(row("Smlouvy"), "Delete");
    expect(writes()).toEqual([]);
    expect(host.querySelector(".fp-confirm")?.textContent).toContain("Smazat složku „Smlouvy“? Nic z ní se nesmaže");
    await act(async () => button("Zrušit")!.click());
    expect(host.querySelector(".fp-confirm")).toBeNull();
    await key(row("Vzory"), "Delete");
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("the menu takes the focus and moves it with the arrows; Escape closes it", async () => {
    standard();
    await open();
    await openMenu("zakon.pdf");
    expect(document.activeElement?.textContent).toContain("Upravit údaje");
    await key(document.activeElement as HTMLElement, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("Smazat");
    await key(document.activeElement as HTMLElement, "Escape");
    expect(host.querySelector(".fp-menu")).toBeNull();
  });

  it("⋯ → Přesunout do… moves a document into the folder picked", async () => {
    standard();
    await open();
    await openMenu("zakon.pdf");
    await act(async () => menuItem("Přesunout do")!.click());
    // The menu now lists the targets: the root (where it already is) and the folders.
    expect(host.querySelector(".fp-mi-head")?.textContent).toBe("Přesunout do");
    expect(menuItem("Všechny soubory")!.disabled).toBe(true);
    await act(async () => menuItem("Smlouvy")!.click());
    await settle();
    expect(writes()).toEqual([{ url: `/api/files/documents/${D_ZAKON}`, method: "PATCH", body: { action: "move", folderId: F_SMLOUVY } }]);
    expect(names()).not.toContain("zakon.pdf");
    expect(row("Smlouvy").textContent).toContain("2 položky");
    expect(host.querySelector(".fp-toast")?.textContent).toContain("„zakon.pdf“ přesunuto do „Smlouvy“");
  });

  it("a folder cannot be moved into itself: its own subtree is not offered", async () => {
    const world = standard();
    world.folders.push(folder("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8", "Kupní", F_SMLOUVY));
    await open();
    await openMenu("Smlouvy");
    await act(async () => menuItem("Přesunout do")!.click());
    const targets = [...host.querySelectorAll(".fp-menu [role=menuitem]")].map((b) => b.textContent);
    expect(targets).toEqual(["Všechny soubory", "Vzory"]);
  });
});

describe("rights", () => {
  const TEAM = library({ id: "org_t", kind: "org", name: "Spory", role: "org:member", handle: "spory", canManageAll: false });

  it("a team member may not touch another member's document: the actions are disabled and say why", async () => {
    serve({
      libs: [library(), TEAM],
      folders: [],
      docs: [doc(D_ZAKON, "cizi.pdf", null, { libraryId: "org_t", mine: false, canDelete: false, canEdit: false }), doc(D_KOMENTAR, "moje.pdf", null, { libraryId: "org_t" })],
    });
    await open({ handle: "spory" });
    expect(host.querySelector("h1")?.textContent).toBe("Spory");
    // No banner about who sees the team's files: the page says "Sdílené s týmem" in its subtitle.
    expect(host.querySelector(".zd-banner-team")).toBeNull();
    expect(host.querySelector(".fp-head p")?.textContent).toContain("Sdílené s týmem");
    await openMenu("cizi.pdf");
    for (const label of ["Přejmenovat", "Přesunout do", "Smazat"]) expect(menuItem(label)!.disabled, label).toBe(true);
    expect(host.querySelector(".fp-menu")?.textContent).toContain("Nahrál ho jiný člen týmu.");
    // No inline rename either.
    await key(row("cizi.pdf"), "F2");
    expect(renameInput()).toBeNull();
    await openMenu("cizi.pdf");
    await openMenu("moje.pdf");
    for (const label of ["Přejmenovat", "Přesunout do", "Smazat"]) expect(menuItem(label)!.disabled, label).toBe(false);
  });

  it("without upload rights: no Nová složka, no Nahrát soubory, folder actions disabled", async () => {
    serve({ libs: [library(), { ...TEAM, canUpload: false }], folders: [folder(F_VZORY, "Vzory", null, { libraryId: "org_t", mine: false })], docs: [] });
    await open({ handle: "spory" });
    expect(button("Nová složka")).toBeUndefined();
    expect(button("Nahrát soubory")).toBeUndefined();
    await openMenu("Vzory");
    expect(menuItem("Otevřít")!.disabled).toBe(false);
    for (const label of ["Přejmenovat", "Přesunout do", "Smazat"]) expect(menuItem(label)!.disabled, label).toBe(true);
    expect(host.querySelector(".fp-menu")?.textContent).toContain("Složky tu teď spravovat nejde.");
  });

  it("read-only mode: browsing and downloading only", async () => {
    serve({ libs: [library()], folders: [folder(F_VZORY, "Vzory", null)], docs: [doc(D_ZAKON, "zakon.pdf", null)], mode: "readonly" });
    await open();
    expect(host.textContent).toContain("jen pro čtení");
    expect(button("Nová složka")).toBeUndefined();
    expect(button("Nahrát soubory")).toBeUndefined();
    await openMenu("zakon.pdf");
    expect((menuItem("Stáhnout") as unknown as HTMLAnchorElement).getAttribute("href")).toBe(`/api/files/documents/${D_ZAKON}/original`);
    expect(menuItem("Zobrazit údaje")).toBeDefined();
    expect(menuItem("Přejmenovat")!.disabled).toBe(true);
  });
});

describe("the document viewer", () => {
  const viewer = () => host.querySelector<HTMLElement>(".dv-layer");

  it("a click opens the document in a large window; ⋯ → Upravit údaje opens the form beside the list", async () => {
    standard();
    await open();
    await act(async () => row("zakon.pdf").click());
    await settle();
    expect(nav.state.replaced).toEqual([`/soubory?dokument=${D_ZAKON}`]);
    const win = viewer()!;
    expect(win.getAttribute("role")).toBe("dialog");
    expect(win.querySelector(".dv-title")?.textContent).toBe("zakon.pdf");
    const download = [...win.querySelectorAll("a")].find((a) => a.textContent?.includes("Stáhnout"))!;
    expect(download.getAttribute("href")).toBe(`/api/files/documents/${D_ZAKON}/original`);
    expect(download.hasAttribute("download")).toBe(true);
    // No side panel while viewing, no form, no delete in the window itself.
    expect(host.querySelector(".fp-detail")).toBeNull();
    expect(win.textContent).not.toContain("Smazat");
    // ⋯ in the window: the row's menu.
    await act(async () => win.querySelector<HTMLButtonElement>(".fp-more")!.click());
    expect(menuItem("Smazat")).toBeDefined();
    await act(async () => menuItem("Upravit údaje")!.click());
    await settle();
    expect(nav.state.replaced.at(-1)).toBe("/soubory");
    expect(viewer()).toBeNull();
    const panel = host.querySelector(".fp-detail")!;
    expect(panel.querySelector(".zd-file-open")).not.toBeNull();
    expect(panel.textContent).not.toContain("Smazat dokument");
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Zavřít"]')!.click());
    expect(host.querySelector(".fp-detail")).toBeNull();
  });

  it("Escape and × close the window", async () => {
    standard();
    await open({ search: `dokument=${D_ZAKON}` });
    await settle();
    expect(viewer()).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(nav.state.replaced.at(-1)).toBe("/soubory");
  });

  it("without a stored original: the window shows the start of the text, the menu offers the text", async () => {
    standard();
    await open({ search: `dokument=${D_KOMENTAR}` });
    await settle();
    const win = viewer()!;
    expect(win.textContent).toContain("není uložený");
    expect(win.textContent).toContain("Začátek.");
    expect([...win.querySelectorAll("a")].some((a) => a.getAttribute("href")?.endsWith("/original"))).toBe(false);
    await openMenu("Komentar.pdf");
    expect((menuItem("Stáhnout text") as unknown as HTMLAnchorElement).getAttribute("href")).toContain(`/api/files/documents/${D_KOMENTAR}/export?lib=`);
  });

  it("an original still uploading is not offered for download", async () => {
    serve({ libs: [library()], folders: [], docs: [doc(D_ZAKON, "zakon.pdf", null, { original: "uploading" })] });
    await open({ search: `dokument=${D_ZAKON}` });
    await settle();
    expect([...viewer()!.querySelectorAll("a")].some((a) => a.getAttribute("href")?.endsWith("/original"))).toBe(false);
  });

  it("a file still being processed: its metadata cannot be opened yet", async () => {
    serve({ libs: [library()], folders: [], docs: [doc(D_ZAKON, "zakon.pdf", null, { status: "processing" })] });
    await open();
    expect(row("zakon.pdf").textContent).toContain("Zpracovávám…");
    await openMenu("zakon.pdf");
    expect(menuItem("Upravit údaje")!.disabled).toBe(true);
  });
});

describe("folders open in place (disclosure arrow)", () => {
  it("the arrow shows a folder's content indented under it, and hides it again; a click on the row still opens the folder", async () => {
    standard();
    await open();
    expect(host.textContent).not.toContain("smlouva.docx");
    const arrow = () => host.querySelector<HTMLButtonElement>('[aria-label="Rozbalit Smlouvy"], [aria-label="Sbalit Smlouvy"]')!;
    await act(async () => arrow().click());
    expect(arrow().getAttribute("aria-expanded")).toBe("true");
    expect(row("smlouva.docx").getAttribute("aria-level")).toBe("2");
    expect(row("Smlouvy").getAttribute("aria-level")).toBe("1");
    // The arrow does not navigate.
    expect(nav.state.pushed).toEqual([]);
    await act(async () => arrow().click());
    expect(host.textContent).not.toContain("smlouva.docx");
    await act(async () => row("Smlouvy").click());
    expect(nav.state.pushed.at(-1)).toBe(`/soubory?slozka=${F_SMLOUVY}`);
  });
});

describe("page states", () => {
  it("a library the user does not see: Tuhle knihovnu nevidíte", async () => {
    standard();
    await open({ handle: "cizi-tym" });
    expect(host.querySelector("h3")?.textContent).toBe("Tuhle knihovnu nevidíte");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/soubory");
    expect(calls.some((c) => c.url.startsWith("/api/files/documents"))).toBe(false);
  });

  it("signed out: Přihlaste se with a sign-in button, nothing loaded", async () => {
    vi.stubGlobal("fetch", vi.fn());
    nav.state.knihovna = undefined;
    store.setAuth("signed_out");
    await act(async () => root.render(createElement(FilesPage)));
    expect(host.querySelector("h3")?.textContent).toBe("Přihlaste se");
    expect(button("Přihlásit se")).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a personal library without Pro and without files: how to get access", async () => {
    serve({ libs: [library({ pro: false, canUpload: false, bytesUsed: null, counts: null })], folders: [], docs: [] });
    await open();
    expect(host.querySelector("h3")?.textContent).toBe("Vlastní soubory přiděluji ručně a zdarma");
    expect(host.querySelector("a")?.getAttribute("href")).toMatch(/^mailto:/);
  });
});
