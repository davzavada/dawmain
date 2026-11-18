// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Old links to what used to be the Vlastní soubory modal (app/_zdroje/modals.tsx,
 * mounted in the root layout): ?soubory=1 (and the older ?zdroje=…) now lead
 * to the /soubory page — replacing the entry, so Back does not bounce — with
 * &dokument kept only when it is a document id; ?zotero=1 leads to /zotero,
 * and when a link carries both, the files win. Then the URL and
 * unsaved-work helpers the store keeps (web:Z3).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
const routerReplace = vi.fn();
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/",
  useRouter: () => ({ replace: routerReplace, push: routerPush }),
}));

const store = await import("@/app/_zdroje/store");
const { ZdrojeModals, filesPageHref, zoteroPageHref } = await import("@/app/_zdroje/modals");

const DOC = "11111111-1111-4111-8111-111111111111";

describe("old modal links lead to the pages (web:Z8)", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    routerReplace.mockReset();
    routerPush.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    search = "";
  });

  /** Render the reader at ?<q> and return where it sent the browser (null: nowhere). */
  const visit = async (q: string): Promise<string | null> => {
    routerReplace.mockReset();
    search = q;
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(host.innerHTML).toBe("");
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace.mock.calls.length).toBeLessThanOrEqual(1);
    return (routerReplace.mock.calls[0]?.[0] as string | undefined) ?? null;
  };

  it("?soubory=1 replaces the URL with /soubory, keeping &dokument only when it is a document id", async () => {
    expect(await visit("soubory=1")).toBe("/soubory");
    expect(await visit(`soubory=1&dokument=${DOC}`)).toBe(`/soubory?dokument=${DOC}`);
    // Lower-cased, as the page's ids are.
    expect(await visit(`soubory=1&dokument=${DOC.toUpperCase()}`)).toBe(`/soubory?dokument=${DOC}`);
    expect(await visit("soubory=1&dokument=../../etc")).toBe("/soubory");
    expect(await visit("soubory=1&dokument=")).toBe("/soubory");
    expect(await visit(`soubory=1&dokument=${DOC}x`)).toBe("/soubory");
  });

  it("the older ?zdroje=… leads there too", async () => {
    expect(await visit("zdroje=moje")).toBe("/soubory");
    expect(await visit(`zdroje=1&dokument=${DOC}`)).toBe(`/soubory?dokument=${DOC}`);
  });

  it("?zotero=1 leads to /zotero with &stav; files win when a link has both", async () => {
    expect(await visit("zotero=1")).toBe("/zotero");
    expect(await visit("zotero=1&stav=pripojeno")).toBe("/zotero?stav=pripojeno");
    expect(await visit("soubory=1&zotero=1")).toBe("/soubory");
    expect(await visit(`zotero=1&stav=chyba&soubory=1&dokument=${DOC}`)).toBe(`/soubory?dokument=${DOC}`);
  });

  it("any other URL is left alone", async () => {
    expect(await visit("")).toBeNull();
    expect(await visit("soubory=")).toBeNull();
    expect(await visit("dokument=" + DOC)).toBeNull();
    expect(await visit("q=zotero")).toBeNull();
  });

  it("the targets, as pure functions", () => {
    expect(filesPageHref(null)).toBe("/soubory");
    expect(filesPageHref("nope")).toBe("/soubory");
    expect(zoteroPageHref(null)).toBe("/zotero");
    expect(zoteroPageHref("a b&c")).toBe("/zotero?stav=a%20b%26c");
  });
});

describe("store helpers", () => {
  it("withParams keeps the path and the hash", () => {
    expect(store.withParams("https://x.cz/podminky?a=1#b", (p) => p.set("soubory", "1"))).toBe("/podminky?a=1&soubory=1#b");
    expect(store.withParams("https://x.cz/zotero?stav=ok", (p) => p.delete("stav"))).toBe("/zotero");
  });

  it("mayDiscardWork asks once and answers what the user chose (web:Z3)", () => {
    window.confirm = vi.fn(() => true);
    const confirm = vi.mocked(window.confirm);
    store.registerUnsavedWork(() => true);
    expect(store.mayDiscardWork()).toBe(true);
    confirm.mockReturnValue(false);
    expect(store.mayDiscardWork()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(store.DISCARD_QUESTION);
    store.registerUnsavedWork(() => false);
    expect(store.mayDiscardWork()).toBe(true);
    store.registerUnsavedWork(null);
    expect(store.mayDiscardWork()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
