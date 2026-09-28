// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Vlastní zdroje modals are driven by the URL through history.pushState
 * / replaceState. Next's app router patches both and forwards a call to
 * useSearchParams only when its state is not Next's own entry (__NA) —
 * passing window.history.state made every open, tab switch and close a
 * no-op (review web:Z1). This file installs the same patch Next does
 * (node_modules/next/dist/client/components/app-router.js) and checks that
 * every store action reaches the router; then the guard that asks before a
 * finished conversion is thrown away (web:Z3) and the nav item that stays
 * current while the modal is open (web:Z5).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// The modal bodies are lazy chunks; here only whether ZdrojeModals asks for one matters.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Lazy(props: { tab?: string }) {
      return createElement("div", { "data-lazy": props.tab ?? "team" });
    },
}));

const store = await import("@/app/_zdroje/store");
const { ZdrojeModals } = await import("@/app/_zdroje/modals");
const { OwnSourcesNavItem } = await import("@/app/_zdroje/own-sources");

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

describe("URL-driven modals reach Next's router (web:Z1)", () => {
  it("open, switch tab, open a document and close all go through the router", () => {
    expect(window.history.state?.__NA).toBe(true);
    store.openSources("moje");
    expect(window.location.search).toBe("?zdroje=moje");
    store.showInSources("tym", null);
    store.showInSources("tym", "11111111-1111-4111-8111-111111111111");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    store.closeSources();
    // Opened with pushState here: closing pops that entry, so Back never reopens the modal.
    expect(back).toHaveBeenCalledTimes(1);
    expect(skipped).toEqual([]);
    expect(routed).toEqual(["/?zdroje=moje", "/?zdroje=tym", "/?zdroje=tym&dokument=11111111-1111-4111-8111-111111111111"]);
  });

  it("closing a modal that came from a link (/vlastni-zdroje redirect) replaces the entry", () => {
    window.history.replaceState({ __NA: true }, "", "/?zdroje=moje&dokument=x#pripojeni");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    routed = [];
    skipped = [];
    store.closeSources();
    expect(skipped).toEqual([]);
    expect(routed).toEqual(["/#pripojeni"]);
  });

  it("the team modal opens and closes through the router too", () => {
    store.openTeam("org_1");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    store.closeTeam();
    expect(back).toHaveBeenCalledTimes(1);
    expect(routed).toEqual(["/?tym=org_1"]);
    expect(skipped).toEqual([]);
  });

  it("withParams keeps the path and the hash", () => {
    expect(store.withParams("https://x.cz/podminky?a=1#b", (p) => p.set("zdroje", "moje"))).toBe("/podminky?a=1&zdroje=moje#b");
  });
});

describe("unsaved conversion guard (web:Z3)", () => {
  it("asks before close, tab switch, opening a document or the team modal; refusing changes nothing", () => {
    window.history.replaceState({ __NA: true }, "", "/?zdroje=moje");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    routed = [];
    let work = true;
    store.registerUnsavedWork(() => work);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    store.closeSources();
    store.showInSources("tym", null);
    store.showInSources("moje", "11111111-1111-4111-8111-111111111111");
    store.openTeam("org_1");
    store.openSources("tym");
    expect(confirm).toHaveBeenCalledTimes(5);
    expect(confirm).toHaveBeenLastCalledWith(store.DISCARD_QUESTION);
    expect(routed).toEqual([]);
    expect(window.location.search).toBe("?zdroje=moje");

    confirm.mockReturnValue(true);
    store.showInSources("tym", null);
    expect(routed).toEqual(["/?zdroje=tym"]);

    // Nothing to lose: no question.
    work = false;
    confirm.mockClear();
    store.closeSources();
    expect(confirm).not.toHaveBeenCalled();
    expect(routed.at(-1)).toBe("/");
  });

  it("the caller that asked already is not asked twice", () => {
    window.history.replaceState({ __NA: true }, "", "/?zdroje=moje");
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(store.mayDiscardWork()).toBe(true);
    store.showInSources("tym", null, true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("Back with a conversion open asks too (web:Z3, final review)", () => {
  it("refused: the modal's URL comes back and closing pops it later", () => {
    store.openSources("moje");
    store.showInSources("moje", "11111111-1111-4111-8111-111111111111");
    routed = [];
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    goBackTo("/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(store.DISCARD_QUESTION);
    // Pushed again through the router, so useSearchParams keeps ?zdroje and the uploader stays mounted.
    expect(routed).toEqual(["/?zdroje=moje&dokument=11111111-1111-4111-8111-111111111111"]);
    expect(window.location.search).toBe("?zdroje=moje&dokument=11111111-1111-4111-8111-111111111111");

    // The re-pushed entry is ours: closing (agreed) pops it, and that pop is not asked about again.
    confirm.mockReturnValue(true);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => goBackTo("/"));
    store.closeSources();
    expect(back).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe("");
  });

  it("agreed: the modal closes; nothing to lose: no question", () => {
    store.openSources("moje");
    routed = [];
    let work = true;
    store.registerUnsavedWork(() => work);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    goBackTo("/");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(routed).toEqual([]);
    expect(window.location.search).toBe("");

    store.openSources("tym");
    work = false;
    confirm.mockClear();
    goBackTo("/");
    expect(confirm).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("a deep-linked modal is guarded too; Back within the modal's URLs or to another page is not asked", () => {
    window.history.replaceState({ __NA: true }, "", "/?zdroje=moje");
    store.setSourcesOpen(true);
    store.registerUnsavedWork(() => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    goBackTo("/?zdroje=tym");
    expect(confirm).not.toHaveBeenCalled();
    goBackTo("/podminky");
    expect(confirm).not.toHaveBeenCalled();
    expect(routed).toEqual([]);

    window.history.replaceState({ __NA: true }, "", "/?zdroje=moje");
    store.setSourcesOpen(false);
    store.setSourcesOpen(true);
    goBackTo("/#pripojeni");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search).toBe("/?zdroje=moje");
  });
});

describe("modal reader and nav item (web:Z5, web:Z8)", () => {
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

  it("the nav item is current while the modal is open, not otherwise", async () => {
    store.setAuth("signed_out");
    const tree = () => createElement("div", null, createElement(ZdrojeModals), createElement(OwnSourcesNavItem, { variant: "sidebar", current: false }));
    search = "zdroje=moje";
    await act(async () => root.render(tree()));
    expect(host.querySelector("[data-lazy]")?.getAttribute("data-lazy")).toBe("moje");
    expect(host.querySelector('a[href="/vlastni-zdroje"]')?.getAttribute("aria-current")).toBe("location");

    search = "tym=org_1";
    await act(async () => root.render(tree()));
    expect(host.querySelector("[data-lazy]")?.getAttribute("data-lazy")).toBe("team");
    expect(host.querySelector('a[href="/vlastni-zdroje"]')?.hasAttribute("aria-current")).toBe(false);

    search = "";
    await act(async () => root.render(tree()));
    expect(host.querySelector("[data-lazy]")).toBeNull();
    expect(host.querySelector('a[href="/vlastni-zdroje"]')?.hasAttribute("aria-current")).toBe(false);
  });
});
