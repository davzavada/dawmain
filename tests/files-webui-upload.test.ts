// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@/src/files/web-types";

/**
 * The uploader in a DOM (happy-dom) with a Markdown file — the real
 * browser conversion, the real preview; fetch is a fake. Covers: a
 * finished conversion registers as unsaved work (review web:Z3), a
 * § range uploaded keeps the conversion open for the next range
 * (completeness:PC-8), and a browser without CompressionStream or module
 * Workers gets a clear message instead of the dropzone (completeness:PC-14).
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

function select(label: string, value: string) {
  const el = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function selectRights() {
  const el = [...host.querySelectorAll("select")].find((s) => s.closest("label")?.textContent?.includes("Práva k textu")) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, el.options[1].value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

async function dropFile(onUploaded = vi.fn()) {
  await act(async () => root.render(createElement(Uploader, { library: LIBRARY, replace: null, onCancelReplace: () => undefined, onUploaded })));
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([DOC], "zakon.md", { type: "text/markdown" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => host.querySelector(".zd-preview") !== null, "the preview");
  return onUploaded;
}

describe("uploader", () => {
  it("a conversion is unsaved work until it is uploaded or cancelled (web:Z3)", async () => {
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    expect(store.mayDiscardWork()).toBe(true);
    await dropFile();
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    await act(async () => button("Zrušit")!.click());
    confirm.mockClear();
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("uploading a § range keeps the conversion for the next range (PC-8)", async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: FormData }) => {
        posted.push(String(init.body.get("meta")));
        return new Response(JSON.stringify({ id: `55555555-5555-4555-8555-55555555555${posted.length}` }), { status: 201 });
      }),
    );
    const onUploaded = await dropFile();
    await act(async () => button("§ / kapitoly")!.click());
    await act(async () => select("Od oddílu", host.querySelector('select[aria-label="Od oddílu"] option:nth-child(3)')!.getAttribute("value")!));
    await act(async () => selectRights());
    await act(async () => button("Nahrát")!.click());
    await until(() => onUploaded.mock.calls.length === 1, "the first upload");
    // The preview is still there, the log names the part, the same range cannot go twice.
    expect(host.querySelector(".zd-preview")).not.toBeNull();
    expect(host.querySelector(".zd-ok-line")?.textContent).toMatch(/^zakon\.md: nahráno: § 1\b.*, zpracovává se\.$/);
    expect(button("Nahrát")!.disabled).toBe(true);
    expect(host.textContent).toContain("Tento rozsah je nahraný.");
    expect(button("Zavřít převod")).toBeDefined();

    // The next section: one more upload from the same conversion.
    await act(async () => select("Od oddílu", host.querySelector('select[aria-label="Od oddílu"] option:nth-child(4)')!.getAttribute("value")!));
    expect(button("Nahrát")!.disabled).toBe(false);
    await act(async () => button("Nahrát")!.click());
    await until(() => onUploaded.mock.calls.length === 2, "the second upload");
    expect(posted).toHaveLength(2);
    const [a, b] = posted.map((m) => JSON.parse(m) as { content: { sha256: string } });
    expect(a.content.sha256).not.toBe(b.content.sha256);

    // Closing the kept conversion is explicit.
    await act(async () => button("Zavřít převod")!.click());
    expect(host.querySelector(".zd-preview")).toBeNull();
  });

  it("the whole document still finishes the preview after its upload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "55555555-5555-4555-8555-555555555555" }), { status: 201 })));
    const onUploaded = await dropFile();
    await act(async () => selectRights());
    await act(async () => button("Nahrát")!.click());
    await until(() => onUploaded.mock.calls.length === 1, "the upload");
    expect(host.querySelector(".zd-preview")).toBeNull();
    expect(host.textContent).toContain("nahráno, zpracovává se.");
  });

  it("an old browser gets a clear message instead of the dropzone (PC-14)", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    await act(async () => root.render(createElement(Uploader, { library: LIBRARY, replace: null, onCancelReplace: () => undefined, onUploaded: () => undefined })));
    expect(host.querySelector(".zd-dropzone")).toBeNull();
    expect(host.textContent).toContain("Váš prohlížeč nahrávání nepodporuje");
    expect(host.textContent).toContain("Safari 16.4");
  });
});
