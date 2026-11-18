// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@/src/files/web-types";

/**
 * The upload queue of the Vlastní soubory page (useUploads,
 * app/_zdroje/upload.tsx, with app/_zdroje/upload-process.ts loaded for the
 * first file) in a DOM (happy-dom) with Markdown files — the real browser
 * conversion; fetch is a fake. Covers: a file goes up by itself (only the
 * converted text, rights "jine", no type hint, into the open folder, with
 * `original: true`), then its original in parts (PUT …/original?part=N,
 * POST …/original to finish); several files go one after another; a file in
 * progress is unsaved work (review web:Z3); a refusal ends in a Czech log
 * line and the next file still goes; a storage refusal is decided before
 * any request; a failed original only adds a note; a browser without
 * CompressionStream or module Workers is flagged (completeness:PC-14).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Small original parts, so a short Markdown file travels in several.
const PART = 64;
vi.mock("@/src/files/config", async (importOriginal) => ({ ...(await importOriginal<object>()), ORIGINAL_PART_BYTES: 64 }));

const store = await import("@/app/_zdroje/store");
const { useUploads } = await import("@/app/_zdroje/upload");

const LIBRARY: LibrarySummary = {
  id: "user_a",
  kind: "user",
  name: "Já",
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  handle: "osobni",
  logoUrl: null,
  quotaBytes: 104_857_600,
  bytesUsed: 0,
  counts: { total: 0, ready: 0, review: 0, processing: 0, error: 0, searchable: 0 },
};

const FOLDER = "22222222-2222-4222-8222-222222222222";
const DOC = ["# Zákon o pokusech", "", "## § 1", "", "První paragraf o pokusech a jejich pravidlech.", "", "## § 2", "", "Druhý paragraf o pokusech.", "", "## § 3", "", "Třetí paragraf, poslední."].join("\n");
const DOC2 = DOC.replace("pokusech", "zkouškách");
const id = (n: number) => `55555555-5555-4555-8555-55555555555${n}`;

class ModuleWorker {
  constructor(_url: string, opts?: { type?: string }) {
    void opts?.type;
  }
  terminate() {}
}

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useUploads>;

beforeEach(() => {
  vi.stubGlobal("Worker", ModuleWorker);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.registerUnsavedWork(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Call = { url: string; method: string; meta?: Record<string, unknown>; gz?: Blob; part?: Blob };

/** The server: POST /api/files/documents answers `post(n)`, a part PUT answers `put`, the finish POST 200. */
function stubServer(opts: { post?: (n: number) => Response | Promise<Response>; put?: () => Response; finish?: () => Response } = {}) {
  const calls: Call[] = [];
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
      const method = init.method ?? "GET";
      if (url === "/api/files/documents" && method === "POST") {
        const form = init.body as FormData;
        calls.push({ url, method, meta: JSON.parse(String(form.get("meta"))), gz: form.get("dmd") as Blob });
        posts++;
        return opts.post ? opts.post(posts) : new Response(JSON.stringify({ id: id(posts) }), { status: 201 });
      }
      calls.push({ url, method, part: init.body instanceof Blob ? init.body : undefined });
      if (method === "PUT") return opts.put ? opts.put() : new Response(null, { status: 204 });
      return opts.finish ? opts.finish() : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return calls;
}

function Probe(props: { library: LibrarySummary; folderId: string | null; onUploaded: (id: string) => void }) {
  hook = useUploads({ ...props, maxFileBytes: 104_857_600 });
  return createElement(
    "div",
    null,
    createElement("output", { id: "current" }, hook.current ? `${hook.current.file.name}: ${hook.current.progress}` : ""),
    createElement("output", { id: "queue" }, String(hook.queue.length)),
    createElement("ul", null, ...hook.log.map((e, i) => createElement("li", { key: i }, `${e.name}: ${e.message}`))),
  );
}

async function upload(files: File[], opts: { library?: LibrarySummary; folderId?: string | null } = {}) {
  const onUploaded = vi.fn();
  await act(async () => root.render(createElement(Probe, { library: opts.library ?? LIBRARY, folderId: opts.folderId ?? null, onUploaded })));
  await act(async () => hook.add(files));
  return onUploaded;
}

const log = () => [...host.querySelectorAll("li")].map((li) => li.textContent);
const md = (text: string, name: string) => new File([text], name, { type: "text/markdown" });

describe("upload queue (useUploads)", () => {
  it("a file goes up by itself into the open folder: the text, then the original in parts and a finish", async () => {
    const calls = stubServer();
    const file = md(DOC, "zakon.md");
    const onUploaded = await upload([file], { folderId: FOLDER });
    await until(() => onUploaded.mock.calls.length === 1, "the upload");
    expect(onUploaded).toHaveBeenCalledWith(id(1));

    const [post, ...rest] = calls;
    expect(post.meta).toMatchObject({ library_id: "user_a", rights: "jine", file: { name: "zakon.md", kind: "md" }, original: true, folderId: FOLDER });
    expect(post.meta).not.toHaveProperty("doc_type_hint");
    // Only the converted text travels in the form, gzipped.
    const text = await new Response(post.gz!.stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(text).toContain("První paragraf o pokusech");

    // Then the original: every part PUT in order, then one POST to finish.
    const parts = Math.ceil(file.size / PART);
    expect(parts).toBeGreaterThan(1);
    const base = `/api/files/documents/${id(1)}/original`;
    expect(rest.map((c) => `${c.method} ${c.url}`)).toEqual([...Array.from({ length: parts }, (_, n) => `PUT ${base}?part=${n}`), `POST ${base}`]);
    const sent = await new Blob(rest.filter((c) => c.method === "PUT").map((c) => c.part!)).arrayBuffer();
    expect(new Uint8Array(sent)).toEqual(new Uint8Array(await file.arrayBuffer()));

    // Nothing to report: the row in the list shows the file.
    await until(() => host.querySelector("#current")!.textContent === "", "the queue to settle");
    expect(log()).toEqual([]);
  });

  it("several files go one after another (the second only after the first's original is finished)", async () => {
    const calls = stubServer();
    const onUploaded = await upload([md(DOC, "a.md"), md(DOC2, "b.md")]);
    expect(host.querySelector("#current")!.textContent).toMatch(/^a\.md: /);
    expect(host.querySelector("#queue")!.textContent).toBe("1");
    await until(() => onUploaded.mock.calls.length === 2, "both uploads");
    expect(onUploaded.mock.calls.map((c) => c[0])).toEqual([id(1), id(2)]);
    const textPosts = calls.map((c, i) => (c.meta ? i : -1)).filter((i) => i >= 0);
    expect(calls.filter((c) => c.meta).map((c) => (c.meta!.file as { name: string }).name)).toEqual(["a.md", "b.md"]);
    const finishFirst = calls.findIndex((c) => c.method === "POST" && c.url === `/api/files/documents/${id(1)}/original`);
    expect(finishFirst).toBeGreaterThan(textPosts[0]);
    expect(textPosts[1]).toBeGreaterThan(finishFirst);
  });

  it("a file in progress is unsaved work (web:Z3)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    stubServer({
      post: async (n) => {
        await gate;
        return new Response(JSON.stringify({ id: id(n) }), { status: 201 });
      },
    });
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    expect(store.mayDiscardWork()).toBe(true);
    const onUploaded = await upload([md(DOC, "zakon.md")]);
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    release();
    await until(() => onUploaded.mock.calls.length === 1 && hook.current === null, "the upload");
    confirm.mockClear();
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a refusal ends in a Czech log line and the next file still goes", async () => {
    const calls = stubServer({
      post: (n) =>
        n === 1
          ? new Response(JSON.stringify({ duplicate: { id: "x", title: "Zákon o pokusech" } }), { status: 409 })
          : new Response(JSON.stringify({ id: id(n) }), { status: 201 }),
    });
    const onUploaded = await upload([md(DOC, "a.md"), md(DOC2, "b.md")]);
    await until(() => onUploaded.mock.calls.length === 1, "the second upload");
    expect(onUploaded).toHaveBeenCalledWith(id(2));
    expect(calls.filter((c) => c.meta)).toHaveLength(2);
    // The refused document sent no original.
    expect(calls.some((c) => c.url.includes(`${id(1)}/original`))).toBe(false);
    expect(log()).toEqual(["a.md: Tento dokument už v knihovně je („Zákon o pokusech“)."]);
  });

  it("over the storage quota: a Czech message before any request, and the next file still goes", async () => {
    const calls = stubServer();
    const big = md(DOC, "velky.md");
    const small = md("# Malý\n\nKrátký text.", "maly.md");
    const library = { ...LIBRARY, quotaBytes: 1_000, bytesUsed: 1_000 - small.size };
    const onUploaded = await upload([big, small], { library });
    await until(() => onUploaded.mock.calls.length === 1, "the small upload");
    expect(calls.filter((c) => c.meta).map((c) => (c.meta!.file as { name: string }).name)).toEqual(["maly.md"]);
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatch(/^velky\.md: Soubor má .+, v knihovně zbývá .+ z .+\. Smažte některý dokument\.$/);
  });

  it("a failed original only adds a note: the document still counts as uploaded", async () => {
    const calls = stubServer({ put: () => new Response(JSON.stringify({ error: "Originál je větší, než bylo ohlášeno." }), { status: 400 }) });
    const onUploaded = await upload([md(DOC, "zakon.md")]);
    await until(() => onUploaded.mock.calls.length === 1 && hook.current === null, "the upload");
    expect(onUploaded).toHaveBeenCalledWith(id(1));
    // Stopped at the first refused part; no finish.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/original"))).toBe(false);
    expect(log()).toEqual(["zakon.md: Text je nahraný a asistent v něm hledá, jen se neuložil originál. Originál je větší, než bylo ohlášeno."]);
  });

  it("sendWithRetry: 5xx and network errors are retried with the waits; the last 5xx speaks with the server's message", async () => {
    const { sendWithRetry } = await import("@/app/_zdroje/upload-process");
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const answers: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError("network")),
      () => Promise.resolve(new Response(null, { status: 502 })),
      () => Promise.resolve(new Response(null, { status: 204 })),
    ];
    let n = 0;
    expect((await sendWithRetry(() => answers[n++](), [10, 20, 30], sleep)).status).toBe(204);
    expect(slept).toEqual([10, 20]);
    // A 4xx is an answer, not a reason to retry.
    expect((await sendWithRetry(() => Promise.resolve(new Response(null, { status: 409 })), [10], sleep)).status).toBe(409);
    const readonly = () => Promise.resolve(new Response(JSON.stringify({ error: "Vlastní soubory jsou teď jen pro čtení." }), { status: 503 }));
    await expect(sendWithRetry(readonly, [1, 1], sleep)).rejects.toMatchObject({ name: "UploadStop", message: "Vlastní soubory jsou teď jen pro čtení." });
    await expect(sendWithRetry(() => Promise.reject(new TypeError("network")), [1], sleep)).rejects.toMatchObject({ message: "Spojení se přerušilo při ukládání originálu." });
  });

  it("a finalize whose first answer got lost: the retry's 409 'already stored' counts as done", async () => {
    let n = 0;
    stubServer({
      finish: () =>
        ++n === 1 ? new Response(null, { status: 502 }) : new Response(JSON.stringify({ error: "Původní soubor už je nahraný." }), { status: 409 }),
    });
    const onUploaded = await upload([md(DOC, "zakon.md")]);
    await until(() => onUploaded.mock.calls.length === 1 && hook.current === null, "the upload");
    expect(n).toBe(2);
    expect(log()).toEqual([]);
  });

  it("a part that fails on the server is tried again", async () => {
    let n = 0;
    const calls = stubServer({ put: () => (++n === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 })) });
    const onUploaded = await upload([md(DOC, "zakon.md")]);
    await until(() => onUploaded.mock.calls.length === 1 && hook.current === null, "the upload");
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.url.split("?")[1]);
    expect(puts.slice(0, 3)).toEqual(["part=0", "part=0", "part=1"]);
    expect(log()).toEqual([]);
  });

  it("an old browser is flagged (PC-14)", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    await act(async () => root.render(createElement(Probe, { library: LIBRARY, folderId: null, onUploaded: () => undefined })));
    expect(hook.unsupported).toBe(true);
    expect(hook.unsupportedText).toContain("Váš prohlížeč nahrávání nepodporuje");
    expect(hook.unsupportedText).toContain("Safari 16.4");
  });

  it("a current browser is not", async () => {
    await act(async () => root.render(createElement(Probe, { library: LIBRARY, folderId: null, onUploaded: () => undefined })));
    expect(hook.unsupported).toBe(false);
  });
});
