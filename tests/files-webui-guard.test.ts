// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentListItem, LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The discard question (web:Z3) is asked only when something would be
 * thrown away: opening or closing a file's row keeps the uploader mounted,
 * so it asks nothing; closing the modal still asks. The Vlastní soubory
 * modal in a DOM (happy-dom) with the summary and the list faked.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The uploader is a lazy chunk; here only the guard around it matters.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const store = await import("@/app/_zdroje/store");
const { FilesModal } = await import("@/app/_zdroje/files-modal");

const DOC = "11111111-1111-4111-8111-111111111111";

const LIBRARY: LibrarySummary = {
  id: "user_a",
  kind: "user",
  name: "Osobní",
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
  pagesUsed: 12,
  counts: { total: 1, ready: 1, review: 0, processing: 0, error: 0, searchable: 1 },
};

const SUMMARY: SummaryResponse = { state: "ok", mode: "on", termsAccepted: true, libraries: [LIBRARY] };

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
};

let host: HTMLDivElement;
let root: Root;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/files/summary")
        ? SUMMARY
        : url.startsWith("/api/files/documents?")
          ? { libraryId: "user_a", documents: [ITEM], total: 1 }
          : { error: "Dokument nenalezen." };
      return new Response(JSON.stringify(body), { status: url.startsWith("/api/files/documents/") ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
  confirm = vi.fn(() => false);
  window.confirm = confirm as unknown as typeof window.confirm;
  store.setAuth("signed_in");
  await act(async () => {
    await store.refreshSummary();
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.registerUnsavedWork(null);
  store.setAuth("none");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
  }
}

const row = () => host.querySelector(".zd-file-row") as HTMLButtonElement;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

describe("discard question only when something is lost (web:Z3)", () => {
  it("opening and closing a row asks nothing; closing the modal asks, and refusing keeps it", async () => {
    window.history.replaceState(null, "", "/?soubory=1");
    await act(async () => root.render(createElement(FilesModal, { documentId: null })));
    await settle();
    expect(row().textContent).toContain("Komentář k OZ");
    expect(host.textContent).toMatch(/Zbývá 2\s988 z 3\s000 stran\./);
    store.registerUnsavedWork(() => true);

    await act(async () => row().click());
    expect(window.location.search).toBe(`?soubory=1&dokument=${DOC}`);
    await act(async () => root.render(createElement(FilesModal, { documentId: DOC })));
    expect(row().getAttribute("aria-expanded")).toBe("true");
    await act(async () => row().click());
    expect(window.location.search).toBe("?soubory=1");
    store.openFiles();
    expect(confirm).not.toHaveBeenCalled();

    // Closing the modal would unmount the uploader: asked, and refusing keeps everything as it was.
    await act(async () => button("Hotovo").click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    expect(window.location.search).toBe("?soubory=1");
  });
});
