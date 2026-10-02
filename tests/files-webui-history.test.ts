// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Vlastní soubory and Zotero modals are driven by the URL through history.pushState
 * / replaceState. Next's app router patches both and forwards a call to
 * useSearchParams only when its state is not Next's own entry (__NA) —
 * passing window.history.state made every open, tab switch and close a
 * no-op (review web:Z1). This file installs the same patch Next does
 * (node_modules/next/dist/client/components/app-router.js) and checks that
 * every store action reaches the router (?soubory=1, &dokument=<id>); then
 * the guard that asks before a finished conversion is thrown away (web:Z3),
 * Back included, and which modal the URL reader mounts.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// The modal bodies are lazy chunks; here only whether ZdrojeModals asks for one (and with what) matters.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Lazy(props: { documentId?: string | null; stav?: string | null }) {
      return "documentId" in props
        ? createElement("div", { "data-lazy": "files", "data-doc": props.documentId ?? "" })
        : createElement("div", { "data-lazy": "zotero", "data-stav": props.stav ?? "" });
    },
}));

const store = await import("@/app/_zdroje/store");
const { ZdrojeModals } = await import("@/app/_zdroje/modals");

/** URLs the router saw (Next's applyUrlFromHistoryPushReplace), and calls it skipped. */
let routed: string[] = [];
let skipped: string[] = [];

beforeAll(() => {
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  // Next's patch, reduced: its own calls (__NA) bypass the router, others are routed and get __NA copied in.
  const patch = (original: typeof push) =>
    function (data: unknown, unused: string, url?: string | URL | null) {
      if ((data as { __NA?: boolean } | null)?.__NA) {
        skipped.push(String(url));
        return original(data, unused, url);
      }
      if (url) routed.push(String(url));
      return original({ ...(data as object | null), __NA: true }, unused, url);
    };
  window.history.pushState = patch(push);
  window.history.replaceState = patch(replace);
});

beforeEach(() => {
  // happy-dom has no window.confirm; the guard's question goes through it.
  window.confirm = vi.fn(() => true);
  routed = [];
  skipped = [];
  // A page Next rendered: its entry carries __NA.
  window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] }, "", "/");
  routed = [];
  skipped = [];
  store.registerUnsavedWork(null);
  // Forget the previous test's modal (its URL, its pushed entry, a mocked history.back()).
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
});

/** The browser's Back to `href`: the entry changes under the page (no router call), then popstate. */
function goBackTo(href: string): void {
  window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] }, "", href);
  skipped = [];
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const DOC = "11111111-1111-4111-8111-111111111111";

describe("URL-driven modals reach Next's router (web:Z1)", () => {
  it("open, open a row, close the row and close all go through the router", () => {
    expect(window.history.state?.__NA).toBe(true);
    store.openFiles();
    expect(window.location.search).toBe("?soubory=1");
    store.showFile(DOC);
    expect(window.location.search).toBe(`?soubory=1&dokument=${DOC}`);
    // The same row again changes nothing.
    store.showFile(DOC);
    store.showFile(null);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    store.closeFiles();
    // Opened with pushState here: closing pops that entry, so Back never reopens the modal.
    expect(back).toHaveBeenCalledTimes(1);
    expect(skipped).toEqual([]);
    expect(routed).toEqual(["/?soubory=1", `/?soubory=1&dokument=${DOC}`, "/?soubory=1"]);
  });

  it("openFiles with a document opens the modal at that row; when already open it only switches the row", () => {
    store.openFiles(DOC);
    expect(window.location.search).toBe(`?soubory=1&dokument=${DOC}`);
    store.openFiles();
    expect(window.location.search).toBe("?soubory=1");
    expect(routed).toEqual([`/?soubory=1&dokument=${DOC}`, "/?soubory=1"]);
  });

  it("closing a modal that came from a link (/vlastni-zdroje redirect, the old ?zdroje) replaces the entry", () => {
    window.history.replaceState({ __NA: true }, "", `/?soubory=1&dokument=${DOC}#pripojeni`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    routed = [];
    skipped = [];
    store.closeFiles();
    expect(skipped).toEqual([]);
    expect(routed).toEqual(["/#pripojeni"]);

    window.history.replaceState({ __NA: true }, "", "/podminky?zdroje=moje");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    routed = [];
    store.closeFiles();
    expect(routed).toEqual(["/podminky"]);
  });

  it("the Zotero modal opens and closes through the router too", () => {
    store.openZotero();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    store.closeZotero();
    expect(back).toHaveBeenCalledTimes(1);
    expect(routed).toEqual(["/?zotero=1"]);
    expect(skipped).toEqual([]);
  });

  it("withParams keeps the path and the hash", () => {
    expect(store.withParams("https://x.cz/podminky?a=1#b", (p) => p.set("soubory", "1"))).toBe("/podminky?a=1&soubory=1#b");
  });
});

describe("unsaved conversion guard (web:Z3)", () => {
  it("asks before closing or switching to Zotero; refusing changes nothing; a row opens without asking", () => {
    window.history.replaceState({ __NA: true }, "", "/?soubory=1");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    routed = [];
    let work = true;
    store.registerUnsavedWork(() => work);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    store.closeFiles();
    store.openZotero();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(store.DISCARD_QUESTION);
    expect(routed).toEqual([]);
    expect(window.location.search).toBe("?soubory=1");

    // Opening a row keeps the uploader mounted: nothing to ask.
    store.showFile(DOC);
    store.openFiles();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(routed).toEqual([`/?soubory=1&dokument=${DOC}`, "/?soubory=1"]);

    // Nothing to lose: no question.
    work = false;
    confirm.mockClear();
    store.closeFiles();
    expect(confirm).not.toHaveBeenCalled();
    expect(routed.at(-1)).toBe("/");
  });

  it("mayDiscardWork asks once and answers what the user chose", () => {
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(store.mayDiscardWork()).toBe(true);
    confirm.mockReturnValue(false);
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    store.registerUnsavedWork(null);
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("Back with a conversion open asks too (web:Z3, final review)", () => {
  it("refused: the modal's URL comes back and closing pops it later", () => {
    store.openFiles();
    store.showFile(DOC);
    routed = [];
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    goBackTo("/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    // Pushed again through the router, so useSearchParams keeps ?soubory and the uploader stays mounted.
    expect(routed).toEqual([`/?soubory=1&dokument=${DOC}`]);
    expect(window.location.search).toBe(`?soubory=1&dokument=${DOC}`);

    // The re-pushed entry is ours: closing (agreed) pops it, and that pop is not asked about again.
    confirm.mockReturnValue(true);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => goBackTo("/"));
    store.closeFiles();
    expect(back).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe("");
  });

  it("agreed: the modal closes; nothing to lose: no question", () => {
    store.openFiles();
    routed = [];
    let work = true;
    store.registerUnsavedWork(() => work);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    goBackTo("/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(routed).toEqual([]);
    expect(window.location.search).toBe("");

    store.openFiles();
    work = false;
    confirm.mockClear();
    goBackTo("/");
    expect(confirm).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("a deep-linked modal is guarded too; Back within the modal's URLs or to another page is not asked", () => {
    window.history.replaceState({ __NA: true }, "", `/?soubory=1&dokument=${DOC}`);
    store.setFilesOpen(true);
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    goBackTo("/?soubory=1");
    expect(confirm).not.toHaveBeenCalled();
    goBackTo("/podminky");
    expect(confirm).not.toHaveBeenCalled();
    expect(routed).toEqual([]);

    window.history.replaceState({ __NA: true }, "", "/?soubory=1");
    store.setFilesOpen(false);
    store.setFilesOpen(true);
    goBackTo("/#pripojeni");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search).toBe("/?soubory=1");
  });
});

describe("the modal reader (web:Z8)", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    search = "";
  });

  const lazy = () => host.querySelector("[data-lazy]");

  it("mounts the files modal for ?soubory (and the old ?zdroje), with a well-formed &dokument only", async () => {
    const show = async (q: string) => {
      search = q;
      await act(async () => root.render(createElement(ZdrojeModals)));
    };
    await show("soubory=1");
    expect(lazy()?.getAttribute("data-lazy")).toBe("files");
    expect(lazy()?.getAttribute("data-doc")).toBe("");
    await show(`soubory=1&dokument=${DOC.toUpperCase()}`);
    expect(lazy()?.getAttribute("data-doc")).toBe(DOC);
    await show("soubory=1&dokument=../../etc");
    expect(lazy()?.getAttribute("data-doc")).toBe("");
    await show("zdroje=moje");
    expect(lazy()?.getAttribute("data-lazy")).toBe("files");
    // At most one modal: files first.
    await show("soubory=1&zotero=1");
    expect(host.querySelectorAll("[data-lazy]")).toHaveLength(1);
    expect(lazy()?.getAttribute("data-lazy")).toBe("files");
    await show("zotero=1&stav=ok");
    expect(lazy()?.getAttribute("data-lazy")).toBe("zotero");
    expect(lazy()?.getAttribute("data-stav")).toBe("ok");
    await show("soubory=");
    expect(lazy()).toBeNull();
    await show("");
    expect(lazy()).toBeNull();
  });
});
