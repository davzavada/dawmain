// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The document detail in a DOM (happy-dom), fetch faked: "Exportovat text"
 * downloads GET /api/files/documents/{id}/export?lib=<library> for whoever
 * may delete the document (canDelete: uploader, owner/admin — the export
 * route's own rule), also after Pro was withdrawn (canEdit false), and
 * shows the server's Czech refusal in place; the quality line uses
 * Czech plurals (review web:Z4); delete follows canDelete, not canEdit.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DocumentPanel } = await import("@/app/_zdroje/detail");

const ID = "11111111-1111-4111-8111-111111111111";

function detail(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    libraryId: "org_team1",
    libraryName: "Kancelář",
    title: "Komentář k OZ",
    fileName: "k.pdf",
    fileKind: "pdf",
    fileBytes: 1000,
    status: "ready",
    statusDetail: null,
    uploadedAt: "2026-09-01T00:00:00Z",
    uploaderName: null,
    mine: true,
    enabled: true,
    canEdit: false,
    canDelete: true,
    docType: "jine",
    billablePages: 3,
    flags: [],
    meta: { doc_type: "jine", title: "Komentář k OZ", authors: [], editors: [] },
    proposed: null,
    metaVersion: 1,
    confirmedAt: "2026-09-02T00:00:00Z",
    physicalPages: 1,
    charCount: 100,
    pageLabelSource: "printed",
    converter: "pdf/1",
    rights: "own",
    quality: { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [7, 8] },
    preview: "Začátek.",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
let calls: string[];

beforeEach(() => {
  calls = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(doc: ReturnType<typeof detail>, exportResponse: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/export")) return exportResponse();
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

async function render(doc: ReturnType<typeof detail>) {
  await act(async () =>
    root.render(createElement(DocumentPanel, { id: ID, readonly: false, team: true, onBack: () => undefined, onReupload: () => undefined, onDeleted: () => undefined })),
  );
  for (let i = 0; i < 50 && !host.querySelector(".zd-detail-title"); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  expect(host.querySelector(".zd-detail-title")?.textContent).toBe(doc.title);
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe("document detail", () => {
  it("exports the text of a document whose library lost Pro (download named by the server)", async () => {
    const doc = detail();
    stubFetch(
      doc,
      () =>
        new Response("---\ntitle: Komentář\n---\ntext", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="Komentar.md"; filename*=UTF-8''Koment%C3%A1%C5%99.md` },
        }),
    );
    const created = vi.fn(() => "blob:x");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    let downloaded: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await render(doc);
    expect(button("Nahrát znovu")).toBeUndefined();
    expect(button("Smazat")).toBeDefined();
    await act(async () => button("Exportovat text")!.click());
    for (let i = 0; i < 50 && downloaded === null; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(calls.at(-1)).toBe(`/api/files/documents/${ID}/export?lib=org_team1`);
    expect(created).toHaveBeenCalledTimes(1);
    expect(downloaded).toBe("Komentář.md");
  });

  it("a team member who cannot manage the document gets no export button (the server would refuse)", async () => {
    const doc = detail({ canDelete: false, mine: false });
    stubFetch(doc, () => new Response("", { status: 500 }));
    await render(doc);
    expect(button("Smazat")).toBeUndefined();
    expect(button("Exportovat text")).toBeUndefined();
  });

  it("a refusal shows the server's message", async () => {
    const doc = detail();
    stubFetch(doc, () => new Response(JSON.stringify({ error: "Dokument se ještě zpracovává — text půjde stáhnout, až bude hotový." }), { status: 409 }));
    await render(doc);
    await act(async () => button("Exportovat text")!.click());
    for (let i = 0; i < 50 && !host.querySelector(".zd-detail-more .zd-error"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(host.querySelector(".zd-detail-more .zd-error")?.textContent).toContain("ještě zpracovává");
  });

  it("no export while the text is still being processed", async () => {
    const doc = detail({ status: "processing" });
    stubFetch(doc, () => new Response("", { status: 500 }));
    await render(doc);
    expect(button("Exportovat text")).toBeUndefined();
  });

  it("the quality line agrees with its numbers (web:Z4)", async () => {
    const doc = detail({ billablePages: 3 });
    stubFetch(doc, () => new Response("", { status: 500 }));
    await render(doc);
    const line = host.querySelector(".zd-quality")?.textContent ?? "";
    expect(line).toContain("3 účtované strany");
    expect(line).toContain("2 sporné strany");
  });

  it("metadata show read-only; the pencil opens the form, Zrušit closes it", async () => {
    const doc = detail({ canEdit: true, meta: { doc_type: "kniha", title: "Komentář k OZ", authors: ["Jan Novák"], editors: [], year: 2024, isbn: ["978-80-7400-000-0"] } });
    stubFetch(doc, () => new Response("", { status: 500 }));
    await render(doc);
    expect(host.querySelector("form.zd-meta-form")).toBeNull();
    const list = host.querySelector(".zd-meta-list")?.textContent ?? "";
    expect(list).toContain("Jan Novák");
    expect(list).toContain("2024");
    expect(host.textContent).not.toContain("Práva:");
    await act(async () => (host.querySelector('button[aria-label="Upravit metadata"]') as HTMLButtonElement).click());
    expect(host.querySelector("form.zd-meta-form")).not.toBeNull();
    // ISBN waits under "Další údaje".
    const extra = host.querySelector("details.zd-meta-extra");
    expect(extra?.textContent).toContain("ISBN");
    expect(extra?.hasAttribute("open")).toBe(false);
    await act(async () => button("Zrušit")!.click());
    expect(host.querySelector("form.zd-meta-form")).toBeNull();
  });

  it("no pencil for who may not edit", async () => {
    const doc = detail();
    stubFetch(doc, () => new Response("", { status: 500 }));
    await render(doc);
    expect(host.querySelector(".zd-meta-list")).not.toBeNull();
    expect(host.querySelector('button[aria-label="Upravit metadata"]')).toBeNull();
  });

  it("a document still processing reloads by itself until it is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let status = "processing";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          calls.push(url);
          return new Response(JSON.stringify(detail({ status })), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
      await render(detail({ status: "processing" }));
      expect(host.textContent).toContain("Dokument se zpracovává");
      status = "ready";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      for (let i = 0; i < 50 && host.textContent?.includes("Dokument se zpracovává"); i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
      expect(host.textContent).not.toContain("Dokument se zpracovává");
      expect(host.textContent).toContain("Připraveno");
      // Ready: no more reloads.
      const n = calls.filter((c) => c.startsWith("/api/files/documents/")).length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(calls.filter((c) => c.startsWith("/api/files/documents/")).length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});
