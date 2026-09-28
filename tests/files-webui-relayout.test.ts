// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@/src/files/web-types";

/**
 * The PDF page range in a DOM (happy-dom) with the pdf.js read and the
 * layout faked: a range whose relayout fails (page 1 is a scanned cover)
 * must not leave the upload sending the previous conversion under the new
 * range — Nahrát waits and says why; an applied range goes up as that
 * range, logged in Czech ("nahráno: strana PDF 2, …").
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCAN = "PDF nemá textovou vrstvu — žádná strana neobsahuje text (sken).";

function pages(range: [number, number] | null): string {
  const [a, b] = range ?? [1, 4];
  const out: string[] = [];
  for (let p = a; p <= b; p++) out.push(`[s. ${p}]`, "", `Strana ${p} s textem o smlouvách.`, "");
  return out.join("\n");
}

vi.mock("@/src/files/convert/index", () => ({ MAX_FILE_BYTES: 1e9, convertFile: vi.fn(), sha256Hex: async () => "a".repeat(64) }));
vi.mock("@/src/files/convert/pdf/index", () => ({
  readPdf: async () => ({}),
  layoutToDmd: (_doc: unknown, opts: { pageRange: [number, number] | null }) => {
    if (opts.pageRange?.[0] === 1 && opts.pageRange[1] === 1) {
      const error = new Error(SCAN);
      error.name = "ConvertError";
      throw error;
    }
    const [a, b] = opts.pageRange ?? [1, 4];
    const quality = { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "none", mn: 0, unsure_pages: [] };
    return {
      kind: "pdf",
      converter: "pdf/test",
      dmd: pages(opts.pageRange),
      quality,
      hints: {},
      labelSource: "printed",
      physicalPages: b - a + 1,
      pageFlags: new Array(4).fill(0),
      pageLabels: ["1", "2", "3", "4"],
      warnings: [] as string[],
    };
  },
}));
vi.mock("@/app/_zdroje/pdf-canvas", () => ({ usePdfDocument: () => null, PdfPageCanvas: () => null }));

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

class ModuleWorker {
  constructor(_url: string, opts?: { type?: string }) {
    void opts?.type;
  }
  terminate() {}
}

let host: HTMLDivElement;
let root: Root;
let posted: Array<{ pages: { physical: number } }>;

beforeEach(() => {
  posted = [];
  vi.stubGlobal("Worker", ModuleWorker);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: FormData }) => {
      posted.push(JSON.parse(String(init.body.get("meta"))));
      return new Response(JSON.stringify({ id: `55555555-5555-4555-8555-55555555555${posted.length}` }), { status: 201 });
    }),
  );
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

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const input = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectRights() {
  const el = [...host.querySelectorAll("select")].find((s) => s.closest("label")?.textContent?.includes("Práva k textu")) as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, el.options[1].value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function applyRange(from: string, to: string) {
  await act(async () => type(input("Od strany PDF"), from));
  await act(async () => type(input("Do strany PDF"), to));
  await act(async () => (input("Do strany PDF").parentElement!.querySelector("button") as HTMLButtonElement).click());
  await wait(60);
}

async function dropPdf(onUploaded = vi.fn()) {
  await act(async () => root.render(createElement(Uploader, { library: LIBRARY, replace: null, onCancelReplace: () => undefined, onUploaded })));
  const picker = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(picker, "files", { configurable: true, value: [new File(["%PDF-1.7 fake"], "kniha.pdf", { type: "application/pdf" })] });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => host.querySelector(".zd-preview") !== null, "the preview");
  await act(async () => selectRights());
  await act(async () => button("strany")!.click());
  return onUploaded;
}

describe("PDF page range", () => {
  it("a range whose relayout failed blocks the upload and says why", async () => {
    await dropPdf();
    await applyRange("1", "1");
    expect(host.textContent).toContain(SCAN);
    expect(button("Nahrát")!.disabled).toBe(true);
    expect(host.querySelector(".zd-preview .zd-error[role=alert]")?.textContent).toContain("Rozsah stran 1–1 použít nejde");
    await act(async () => button("Nahrát")!.click());
    await wait(30);
    expect(posted).toHaveLength(0);

    // Another range works again and goes up as that range.
    await applyRange("2", "2");
    expect(button("Nahrát")!.disabled).toBe(false);
    await act(async () => button("Nahrát")!.click());
    await until(() => posted.length === 1, "the upload");
    expect(posted[0].pages.physical).toBe(1);
    await until(() => host.querySelector(".zd-ok-line") !== null, "the log line");
    expect(host.querySelector(".zd-ok-line")?.textContent).toBe("kniha.pdf: nahráno: strana PDF 2, zpracovává se.");
  });

  it("a failed range after an applied one keeps sending the applied range", async () => {
    await dropPdf();
    await applyRange("2", "3");
    await applyRange("1", "1");
    // The inputs still say 1–1 (failed); the conversion and its options stay 2–3.
    expect(button("Nahrát")!.disabled).toBe(true);
    await act(async () => type(input("Od strany PDF"), "2"));
    await act(async () => type(input("Do strany PDF"), "3"));
    expect(button("Nahrát")!.disabled).toBe(false);
    await applyRange("2", "3");
    expect(button("Nahrát")!.disabled).toBe(false);
    await act(async () => button("Nahrát")!.click());
    await until(() => posted.length === 1, "the upload");
    expect(posted[0].pages.physical).toBe(2);
    await until(() => host.querySelector(".zd-ok-line") !== null, "the log line");
    expect(host.querySelector(".zd-ok-line")?.textContent).toBe("kniha.pdf: nahráno: strany PDF 2–3, zpracovává se.");
  });
});
