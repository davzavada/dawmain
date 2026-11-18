// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentListItem, FolderItem, LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * Unsaved work on the Vlastní soubory page (web:Z3): the upload queue lives
 * in the page, so moving between folders and opening a document keeps it
 * and asks nothing; leaving the page while a file waits or is converted is
 * held by the browser's beforeunload question, and only then. The page in a
 * DOM (happy-dom) with the summary and the API faked, a real Markdown file
 * picked with "Nahrát soubory".
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { search: "" };
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
    router: { push: go, replace: go },
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(nav.subscribe, () => nav.state.search)),
  useRouter: () => nav.router,
}));

const store = await import("@/app/_zdroje/store");
const { FilesPage } = await import("@/app/soubory/files-page");

const DOC = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const NEW = "55555555-5555-4555-8555-555555555555";

const LIBRARY: LibrarySummary = {
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
  bytesUsed: 12,
  counts: { total: 1, ready: 1, review: 0, processing: 0, error: 0, searchable: 1 },
};
const SUMMARY: SummaryResponse = { state: "ok", mode: "on", termsAccepted: true, libraries: [LIBRARY], maxFileBytes: 104_857_600 };
const FOLDERS: FolderItem[] = [{ id: FOLDER, libraryId: "user_a", parentId: null, name: "Smlouvy", createdAt: "2026-09-01T00:00:00Z", mine: true }];
const ITEM: DocumentListItem = {
  id: DOC,
  libraryId: "user_a",
  title: "Komentář k OZ",
  fileName: "k.pdf",
  fileKind: "pdf",
  fileBytes: 1000,
  status: "ready",
  statusDetail: null,
  uploadedAt: "2026-09-01T00:00:00Z",
  mine: true,
  canEdit: true,
  canDelete: true,
  docType: "komentar",
  publication: null,
  physicalPages: 12,
  billablePages: 12,
  flags: [],
  folderId: null,
  original: "missing",
};
const MD = ["# Zákon o pokusech", "", "## § 1", "", "První paragraf o pokusech a jejich pravidlech."].join("\n");

class ModuleWorker {
  constructor(_url: string, opts?: { type?: string }) {
    void opts?.type;
  }
  terminate() {}
}

let host: HTMLDivElement;
let root: Root;
let confirm: ReturnType<typeof vi.fn>;
let release: () => void;

beforeEach(async () => {
  let gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal("Worker", ModuleWorker);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (url === "/api/files/documents" && method === "POST") {
        // The text upload waits until the test lets it through.
        await gate;
        gate = Promise.resolve();
        return new Response(JSON.stringify({ id: NEW }), { status: 201 });
      }
      if (method !== "GET") return new Response(null, { status: 204 });
      const body = url.startsWith("/api/files/summary")
        ? SUMMARY
        : url.startsWith("/api/files/documents?")
          ? { libraryId: "user_a", documents: [ITEM], folders: FOLDERS, total: 1 }
          : { error: "Dokument nenalezen." };
      return new Response(JSON.stringify(body), { status: url.startsWith("/api/files/documents/") ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
  confirm = vi.fn(() => false);
  window.confirm = confirm as unknown as typeof window.confirm;
  nav.state.search = "";
  store.setAuth("signed_in");
  await act(async () => {
    await store.refreshSummary();
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  release();
  await act(async () => root.unmount());
  host.remove();
  store.registerUnsavedWork(null);
  store.setAuth("none");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".fp-item")].find((r) => r.querySelector("b")?.textContent === name)!;

/** Would the browser ask before leaving? (a cancelable beforeunload that the page prevents) */
function leaveIsHeld(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("unsaved uploads on the page (web:Z3)", () => {
  it("folders and documents open without a question while a file uploads; leaving the page is held until it is done", async () => {
    await act(async () => root.render(createElement(FilesPage)));
    await until(() => row("k.pdf") !== undefined, "the list");
    expect(leaveIsHeld()).toBe(false);
    expect(store.mayDiscardWork()).toBe(true);

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([MD], "zakon.md", { type: "text/markdown" })] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => host.querySelector(".fp-uploads")?.textContent?.includes("zakon.md") === true, "the upload to start");
    expect(leaveIsHeld()).toBe(true);

    // Moving around the library keeps the queue: nothing is asked, the upload goes on.
    await act(async () => row("Smlouvy").click());
    expect(nav.state.search).toBe(`slozka=${FOLDER}`);
    await act(async () => host.querySelector<HTMLButtonElement>(".fp-crumb")!.click());
    await act(async () => row("k.pdf").click());
    expect(nav.state.search).toBe(`dokument=${DOC}`);
    expect(confirm).not.toHaveBeenCalled();
    expect(host.querySelector(".fp-uploads")?.textContent).toContain("zakon.md");
    // Anything that would unmount the page asks first.
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);

    release();
    await until(() => !host.querySelector(".fp-uploads .zd-progress"), "the upload to finish");
    expect(leaveIsHeld()).toBe(false);
    confirm.mockClear();
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("the page registers its check and drops it when it unmounts", async () => {
    store.registerUnsavedWork(() => true);
    await act(async () => root.render(createElement(FilesPage)));
    await until(() => row("k.pdf") !== undefined, "the list");
    // The page's own queue (empty) replaced the stale check.
    expect(store.mayDiscardWork()).toBe(true);
    store.registerUnsavedWork(() => true);
    await act(async () => root.render(createElement("div")));
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
