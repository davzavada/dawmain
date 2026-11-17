// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * A file's open row in the Vlastní soubory modal (&dokument=<id>) in a DOM
 * (happy-dom), fetch faked: "Stáhnout text" downloads GET
 * /api/files/documents/{id}/export?lib=<library> for whoever may delete the
 * document (the export route's own rule), also after Pro was withdrawn
 * (canEdit false), and shows the server's Czech refusal in place; the type
 * switch saves at once, Uložit confirms the short form; a file still being
 * processed only spins and does not open.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The uploader is a lazy chunk, not under test here.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const store = await import("@/app/_zdroje/store");
const { FilesModal } = await import("@/app/_zdroje/files-modal");

const ID = "11111111-1111-4111-8111-111111111111";

function library(pro: boolean): LibrarySummary {
  return {
    id: "user_a",
    kind: "user",
    name: "Osobní",
    role: "owner",
    pro,
    canUpload: pro,
    canManageAll: true,
    quotaPages: 3000,
    pagesUsed: pro ? 3 : null,
    counts: pro ? { total: 1, ready: 1, review: 0, processing: 0, error: 0, searchable: 1 } : null,
  };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    libraryId: "user_a",
    libraryName: "Osobní",
    title: "Komentář k OZ",
    fileName: "k.pdf",
    fileKind: "pdf",
    fileBytes: 1000,
    status: "ready",
    statusDetail: null,
    uploadedAt: "2026-09-01T00:00:00Z",
    mine: true,
    canEdit: false,
    canDelete: true,
    docType: "jine",
    publication: null,
    physicalPages: 3,
    billablePages: 3,
    flags: [],
    meta: { doc_type: "jine", title: "Komentář k OZ", authors: [], editors: [], isbn: [], keywords: [], language: "cs" },
    proposed: null,
    metaVersion: 1,
    confirmedAt: "2026-09-02T00:00:00Z",
    charCount: 100,
    pageLabelSource: "printed",
    converter: "pdf/1",
    rights: "vlastni",
    quality: { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] },
    preview: "Začátek.",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.history.replaceState(null, "", `/?soubory=1&dokument=${ID}`);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.setAuth("none");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake the API: summary, the list (the document as its list item), its detail, PATCH and the export. */
async function setup(doc: ReturnType<typeof detail>, opts: { pro?: boolean; team?: boolean; exportResponse?: () => Response } = {}) {
  const team = { ...library(true), id: "org_t", kind: "org" as const, name: "Kancelář", role: "member" as const, canManageAll: false, counts: null };
  const summary: SummaryResponse = { state: "ok", mode: "on", termsAccepted: true, libraries: opts.team ? [{ ...library(false), counts: null }, team] : [library(opts.pro ?? true)] };
  let current = doc;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith("/api/files/summary")) return json(summary);
      if (url.startsWith("/api/files/documents?")) return json({ libraryId: "user_a", documents: [current], total: 1 });
      if (url.includes("/export")) return (opts.exportResponse ?? (() => new Response("", { status: 500 })))();
      if (method === "PATCH") {
        const name = (body as { name: string }).name;
        current = { ...current, fileName: name, title: name, metaVersion: current.metaVersion + 1 };
        return json(current);
      }
      return json(current);
    }),
  );
  store.setAuth("signed_in");
  await act(async () => {
    await store.refreshSummary();
  });
  await act(async () => root.render(createElement(FilesModal, { documentId: ID })));
  await waitFor(() => host.querySelector(".zd-file-open .zd-file-actions") !== null || host.querySelector('[data-pending="true"]') !== null);
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("a file's open row", () => {
  it("downloads the text of a file whose library lost Pro (named by the server); no editing", async () => {
    let downloaded: string | null = null;
    const created = vi.fn(() => "blob:x");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await setup(detail(), {
      pro: false,
      exportResponse: () =>
        new Response("---\ntitle: Komentář\n---\ntext", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="Komentar.md"; filename*=UTF-8''Koment%C3%A1%C5%99.md` },
        }),
    });
    expect(host.textContent).toContain("Režim Pro tu už není aktivní");
    expect(button("Přejmenovat")).toBeUndefined();
    expect(button("Smazat soubor")).toBeDefined();
    await act(async () => button("Stáhnout text")!.click());
    await waitFor(() => downloaded !== null);
    expect(calls.at(-1)?.url).toBe(`/api/files/documents/${ID}/export?lib=user_a`);
    expect(created).toHaveBeenCalledTimes(1);
    expect(downloaded).toBe("Komentář.md");
  });

  it("a refusal shows the server's message in the row", async () => {
    await setup(detail(), {
      exportResponse: () => json({ error: "Dnes už jste si text tohoto dokumentu stáhli několikrát. Zkuste to zítra." }, 429),
    });
    await act(async () => button("Stáhnout text")!.click());
    await waitFor(() => host.querySelector(".zd-file-open .zd-error") !== null);
    expect(host.querySelector(".zd-file-open .zd-error")?.textContent).toContain("Zkuste to zítra");
  });

  it("who may not delete gets neither download nor delete (the server would refuse)", async () => {
    await setup(detail({ canDelete: false, mine: false }));
    expect(button("Smazat soubor")).toBeUndefined();
    expect(button("Stáhnout text")).toBeUndefined();
  });

  it("like a folder: the row shows the file's name, and renaming is the only edit", async () => {
    await setup(detail({ canEdit: true, fileName: "scan_final.pdf" }));
    expect(host.querySelector(".zd-file-title")?.textContent).toBe("scan_final.pdf");
    // No type switch, no metadata form.
    expect(host.querySelector('[role="radio"]')).toBeNull();
    expect(host.querySelector(".zd-file-field")).toBeNull();
    const input = host.querySelector(".zd-file-rename input") as HTMLInputElement;
    expect(input.value).toBe("scan_final.pdf");
    expect(button("Přejmenovat")!.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Komentář OZ.pdf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Přejmenovat")!.click());
    await waitFor(() => calls.some((c) => c.method === "PATCH"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ action: "rename", name: "Komentář OZ.pdf" });
    await waitFor(() => host.querySelector(".zd-ok-line") !== null);
    expect(host.querySelector(".zd-ok-line")?.textContent).toBe("Přejmenováno.");
    expect(host.querySelector(".zd-file-title")?.textContent).toBe("Komentář OZ.pdf");
  });

  it("a team's library: tabs to switch, who uploaded a file, and a member cannot touch a colleague's file", async () => {
    await setup(detail({ libraryId: "org_t", mine: false, canEdit: false, canDelete: false, uploadedByName: "Jana Nová" }), { team: true });
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Osobní", "Kancelář"]);
    // A member without Pro of their own lands in the team's library.
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(calls.some((c) => c.url === "/api/files/documents?lib=org_t")).toBe(true);
    expect(host.querySelector(".zd-file-line")?.textContent).toContain("Jana Nová");
    expect(button("Přejmenovat")).toBeUndefined();
    expect(button("Smazat soubor")).toBeUndefined();
  });

  it("a file still being processed only spins: no row to open", async () => {
    await setup(detail({ status: "processing" }));
    const pending = host.querySelector('[data-pending="true"]');
    expect(pending?.textContent).toContain("Zpracovávám…");
    expect(pending?.querySelector("button")).toBeNull();
    expect(host.querySelector(".zd-file-open")).toBeNull();
  });
});
