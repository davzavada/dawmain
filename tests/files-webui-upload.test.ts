// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@/src/files/web-types";

/**
 * The uploader in a DOM (happy-dom) with Markdown files — the real browser
 * conversion; fetch is a fake. Covers: a dropped file goes up by itself,
 * with no preview and no choices (only the converted text, rights "jine",
 * no type hint); several files go one after another; a file in progress is
 * unsaved work (review web:Z3); a refusal ends in a Czech log line; a
 * browser without CompressionStream or module Workers gets a clear message
 * instead of the dropzone (completeness:PC-14).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = await import("@/app/_zdroje/store");
const { Uploader } = await import("@/app/_zdroje/upload");

const LIBRARY: LibrarySummary = {
  id: "user_a",
  kind: "user",
  name: "Já",
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
  pagesUsed: 0,
  counts: { total: 0, ready: 0, review: 0, processing: 0, error: 0, searchable: 0 },
  memberCount: null,
};

const DOC = ["# Zákon o pokusech", "", "## § 1", "", "První paragraf o pokusech a jejich pravidlech.", "", "## § 2", "", "Druhý paragraf o pokusech.", "", "## § 3", "", "Třetí paragraf, poslední."].join("\n");

class ModuleWorker {
  constructor(_url: string, opts?: { type?: string }) {
    void opts?.type;
  }
  terminate() {}
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("Worker", ModuleWorker);
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const DOC2 = DOC.replace("pokusech", "zkouškách");

function stubUpload(respond: (n: number) => Response = (n) => new Response(JSON.stringify({ id: `55555555-5555-4555-8555-55555555555${n}` }), { status: 201 })) {
  const posted: Array<{ meta: Record<string, unknown>; gz: Blob }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: FormData }) => {
      posted.push({ meta: JSON.parse(String(init.body.get("meta"))), gz: init.body.get("dmd") as Blob });
      return respond(posted.length);
    }),
  );
  return posted;
}

async function drop(files: File[], onUploaded = vi.fn()) {
  await act(async () => root.render(createElement(Uploader, { library: LIBRARY, replace: null, onCancelReplace: () => undefined, onUploaded })));
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return onUploaded;
}

describe("uploader", () => {
  it("a dropped file goes up by itself: no preview, no choices", async () => {
    const posted = stubUpload();
    const onUploaded = await drop([new File([DOC], "zakon.md", { type: "text/markdown" })]);
    await until(() => onUploaded.mock.calls.length === 1, "the upload");
    expect(host.querySelector("select")).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0].meta).toMatchObject({ library_id: "user_a", rights: "jine", file: { name: "zakon.md", kind: "md" } });
    expect(posted[0].meta).not.toHaveProperty("doc_type_hint");
    // Only the converted text travels, gzipped.
    const text = await new Response(posted[0].gz.stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(text).toContain("První paragraf o pokusech");
    await until(() => host.querySelector(".zd-ok-line") !== null, "the log line");
    expect(host.querySelector(".zd-ok-line")?.textContent).toBe("zakon.md: nahráno, zpracovává se — metadata se doplní sama.");
    expect(host.querySelector(".zd-dropzone")).not.toBeNull();
    expect(host.textContent).toContain("Nahráním potvrzujete");
  });

  it("several files go one after another", async () => {
    const posted = stubUpload();
    const onUploaded = await drop([new File([DOC], "a.md", { type: "text/markdown" }), new File([DOC2], "b.md", { type: "text/markdown" })]);
    await until(() => onUploaded.mock.calls.length === 2, "both uploads");
    expect(posted.map((p) => (p.meta.file as { name: string }).name)).toEqual(["a.md", "b.md"]);
    expect(host.querySelectorAll(".zd-ok-line")).toHaveLength(2);
  });

  it("a file in progress is unsaved work (web:Z3)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ id: "55555555-5555-4555-8555-555555555555" }), { status: 201 });
      }),
    );
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    expect(store.mayDiscardWork()).toBe(true);
    const onUploaded = await drop([new File([DOC], "zakon.md", { type: "text/markdown" })]);
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    release();
    await until(() => onUploaded.mock.calls.length === 1, "the upload");
    confirm.mockClear();
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a refusal ends in a Czech log line and the next file still goes", async () => {
    const posted = stubUpload((n) =>
      n === 1 ? new Response(JSON.stringify({ duplicate: { id: "x", title: "Zákon o pokusech" } }), { status: 409 }) : new Response(JSON.stringify({ id: "55555555-5555-4555-8555-555555555552" }), { status: 201 }),
    );
    const onUploaded = await drop([new File([DOC], "a.md", { type: "text/markdown" }), new File([DOC2], "b.md", { type: "text/markdown" })]);
    await until(() => onUploaded.mock.calls.length === 1, "the second upload");
    expect(posted).toHaveLength(2);
    expect(host.querySelector(".zd-error")?.textContent).toBe("a.md: Tento dokument už v knihovně je („Zákon o pokusech“).");
  });

  it("an old browser gets a clear message instead of the dropzone (PC-14)", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    await act(async () => root.render(createElement(Uploader, { library: LIBRARY, replace: null, onCancelReplace: () => undefined, onUploaded: () => undefined })));
    expect(host.querySelector(".zd-dropzone")).toBeNull();
    expect(host.textContent).toContain("Váš prohlížeč nahrávání nepodporuje");
    expect(host.textContent).toContain("Safari 16.4");
  });
});
