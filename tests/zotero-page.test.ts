// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOTERO_STAV, type ZoteroLibrariesAnswer, type ZoteroStatus } from "@/src/zotero/web-types";

/**
 * The /zotero page (app/zotero/zotero-page.tsx), which replaced the Zotero
 * modal: the old deep link ?zotero=1 leads to it (app/_zdroje/modals.tsx),
 * the account menu links to it, and the dropped &stav reaches the router
 * (Next's history patch installed as in tests/files-webui-history.test.ts).
 * Then each state the status route can answer (src/zotero/web-types.ts),
 * rendered against a stubbed fetch, the library switches
 * (/api/zotero/libraries), and the banner for every connect outcome.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/",
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// Nothing in the layout's reader is lazy any more; a lazy chunk would show up here.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Lazy(props: Record<string, unknown>) {
      const which = "documentId" in props ? "soubory" : "stav" in props ? "zotero" : "?";
      return createElement("div", { "data-lazy": which, "data-stav": String(props.stav ?? "") });
    },
}));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, user: { fullName: "Jana Nováková", primaryEmailAddress: { emailAddress: "jana@example.cz" } } }),
}));

const store = await import("@/app/_zdroje/store");
const { ZdrojeModals } = await import("@/app/_zdroje/modals");
const { AccountControl } = await import("@/app/_zdroje/account");
const { ZoteroPanel, STAV_BANNER, PRIPOJENO_READ, bannerText } = await import("@/app/zotero/zotero-page");

/** URLs the router saw (Next's applyUrlFromHistoryPushReplace), with the call that carried them. */
let routed: { kind: "push" | "replace"; url: string }[] = [];
let skipped: string[] = [];

beforeAll(() => {
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  // Next's patch, reduced: its own calls (__NA) bypass the router, others are routed and get __NA copied in.
  const patch = (original: typeof push, kind: "push" | "replace") =>
    function (data: unknown, unused: string, url?: string | URL | null) {
      if ((data as { __NA?: boolean } | null)?.__NA) {
        skipped.push(String(url));
        return original(data, unused, url);
      }
      if (url) routed.push({ kind, url: String(url) });
      return original({ ...(data as object | null), __NA: true }, unused, url);
    };
  window.history.pushState = patch(push, "push");
  window.history.replaceState = patch(replace, "replace");
});

/** A page Next rendered at `href`: its entry carries __NA; the store forgets any modal it pushed. */
function landOn(href: string): void {
  window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] }, "", href);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  routed = [];
  skipped = [];
}

// ---------------------------------------------------------------------------
// A stubbed server: the status route answers `status`, disconnect succeeds and empties it.

const NOT_CONNECTED: ZoteroStatus = { state: "ok", configured: true, pro: true, connection: null, revoked: null, unreadable: null };
const CONNECTED: ZoteroStatus = {
  ...NOT_CONNECTED,
  connection: {
    username: "jnovakova",
    userID: 12345,
    connectedAt: "2026-09-12T10:00:00Z",
    mode: "write",
    notes: true,
    groups: "all",
    groupNames: ["Katedra obchodního práva"],
  },
};
const CONNECTED_READ: ZoteroStatus = { ...CONNECTED, connection: { ...CONNECTED.connection!, mode: "read" } };

const LIBRARIES: ZoteroLibrariesAnswer = {
  mode: "write",
  groupsFailed: false,
  libraries: [
    { id: "personal", kind: "personal", name: "Moje knihovna", items: 1200, on: true, saves: true },
    { id: "111", kind: "group", name: "Katedra obchodního práva", items: 3, on: true, saves: false },
    { id: "222", kind: "group", name: "Seminář", items: null, on: false, saves: false },
  ],
};

let status: { code: number; body: unknown } = { code: 200, body: NOT_CONNECTED };
let libraries: { code: number; body: unknown } = { code: 200, body: LIBRARIES };
let posted: unknown[] = [];
let calls: { url: string; method: string }[] = [];

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  window.confirm = vi.fn(() => true);
  landOn("/");
  store.registerUnsavedWork(null);
  status = { code: 200, body: NOT_CONNECTED };
  libraries = { code: 200, body: LIBRARIES };
  posted = [];
  routerReplace.mockReset();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/zotero/status") return json(status.body, status.code);
      if (url === "/api/zotero/libraries" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { library: string; on: boolean };
        posted.push(body);
        const current = libraries.body as ZoteroLibrariesAnswer;
        libraries = { code: 200, body: { ...current, libraries: current.libraries.map((l) => (l.id === body.library ? { ...l, on: body.on } : l)) } };
        return json(libraries.body);
      }
      if (url === "/api/zotero/libraries") return json(libraries.body, libraries.code);
      if (url === "/api/zotero/disconnect") {
        status = { code: 200, body: NOT_CONNECTED };
        return json({ ok: true });
      }
      return json({ error: "Nenalezeno." }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  signedOut = false;
  store.setAuth("loading");
});

/** Let the status fetch (a few awaits deep) land and React commit it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

/** The page for a signed-in user (Clerk loaded), unless the test said otherwise. */
async function renderModal(stav: string | null = null): Promise<void> {
  if (!signedOut) store.setAuth("signed_in");
  await act(async () => root.render(createElement(ZoteroPanel, { stav })));
  await settle();
}
let signedOut = false;

/** Zotero counts come with narrow no-break spaces ("1 234"): compared with plain ones. */
const norm = (s: string | null | undefined) => s?.replace(/\s+/g, " ");

function text(): string {
  return (host.textContent ?? "").replace(/\s+/g, " ");
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

function connectForm(): HTMLFormElement | null {
  return host.querySelector<HTMLFormElement>('form[action="/api/zotero/connect"]');
}

/** The mode cards of the connect form: title → checked, and what the form would POST as `mode`. */
function modes(): { cards: Record<string, boolean>; posted: string | null } {
  const form = connectForm();
  if (!form) return { cards: {}, posted: null };
  const cards = Object.fromEntries(
    [...form.querySelectorAll<HTMLLabelElement>(".zd-zotero-mode")].map((card) => [
      card.querySelector(".zd-zotero-mode-title")?.textContent,
      card.querySelector<HTMLInputElement>('input[type="radio"]')!.checked,
    ]),
  );
  return { cards, posted: new FormData(form).get("mode") as string | null };
}

// ---------------------------------------------------------------------------

describe("?zotero=1 leads to the /zotero page", () => {
  it("replaces the URL with /zotero (keeping stav), and the files page still wins", async () => {
    const lazies = () => [...host.querySelectorAll("[data-lazy]")].map((e) => e.getAttribute("data-lazy"));
    search = "zotero=1";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual([]);
    expect(routerReplace).toHaveBeenLastCalledWith("/zotero");

    search = "zotero=1&stav=pripojeno";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(routerReplace).toHaveBeenLastCalledWith("/zotero?stav=pripojeno");

    routerReplace.mockReset();
    search = "zotero=1&soubory=1";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenLastCalledWith("/soubory");

    // ?zdroje=… is the files modal's old name, never Zotero.
    routerReplace.mockReset();
    search = "zdroje=zotero";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenLastCalledWith("/soubory");

    routerReplace.mockReset();
    search = "";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual([]);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("the root layout's reader no longer pulls in any Zotero UI", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../app/_zdroje/modals.tsx"), "utf8");
    expect(src).not.toMatch(/zotero-modal|zotero-page/);
  });

  it("dropZoteroStav replaces the entry without &stav", () => {
    landOn("/zotero?stav=chyba");
    store.dropZoteroStav();
    expect(routed).toEqual([{ kind: "replace", url: "/zotero" }]);
    store.dropZoteroStav();
    expect(routed).toHaveLength(1);
  });

  it("the account menu leads to Vlastní soubory and Zotero, before Spravovat účet, as links", async () => {
    store.setAuth("signed_in");
    await act(async () => root.render(createElement(AccountControl, { zotero: true })));
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-avatar-button")!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim());
    expect(items.slice(0, 3)).toEqual(["Vlastní soubory", "Zotero", "Spravovat účet"]);
    const files = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent?.trim() === "Vlastní soubory")!;
    expect(files.getAttribute("href")).toBe("/soubory");
    const zotero = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent?.trim() === "Zotero")!;
    expect(zotero.getAttribute("href")).toBe("/zotero");
    await act(async () => zotero.click());
    // The menu closed behind it.
    expect(host.querySelector('[role="menu"]')).toBeNull();
    store.setAuth("loading");
  });
});

describe("account menu without Zotero configured", () => {
  it("offers no Zotero item (the deployment cannot connect one)", async () => {
    store.setAuth("signed_in");
    await act(async () => root.render(createElement(AccountControl)));
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-avatar-button")!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim());
    expect(items).toContain("Spravovat účet");
    expect(items).not.toContain("Zotero");
    store.setAuth("loading");
  });
});

describe("page states (GET /api/zotero/status)", () => {
  it("signed out: an explanation and Přihlásit se, no connect form", async () => {
    status = { code: 200, body: { state: "signed_out" } };
    await renderModal();
    expect(host.querySelector(".zp-head h1")?.textContent).toBe("Zotero");
    expect(text()).toContain("Přihlaste se");
    expect(text()).toContain("když mu to povolíte, ukládá do ní nalezené dokumenty");
    expect(button("Přihlásit se")?.type).toBe("button");
    expect(connectForm()).toBeNull();
  });

  it("before Clerk has loaded: Načítám…, and the server is not asked with a session cookie that may be stale", async () => {
    signedOut = true; // keep "loading"
    await renderModal();
    expect(calls.filter((c) => c.url.startsWith("/api/zotero"))).toEqual([]);
    expect(text()).toContain("Načítám…");
    store.setAuth("signed_in");
    await settle();
    expect(calls.filter((c) => c.url.startsWith("/api/zotero"))).toEqual([{ url: "/api/zotero/status", method: "GET" }]);
    expect(connectForm()).not.toBeNull();
  });

  it("signed out according to Clerk: the server is not even asked", async () => {
    store.setAuth("signed_out");
    signedOut = true;
    try {
      await renderModal();
      expect(calls.filter((c) => c.url.startsWith("/api/zotero"))).toEqual([]);
      expect(button("Přihlásit se")).toBeDefined();
    } finally {
      store.setAuth("loading");
    }
  });

  it("not configured on this deployment", async () => {
    status = { code: 200, body: { ...NOT_CONNECTED, configured: false } };
    await renderModal();
    expect(text()).toContain("Připojení Zotera není na tomto webu zapnuté.");
    expect(connectForm()).toBeNull();
  });

  it("without Pro: the locked panel with a mailto, no connect form", async () => {
    status = { code: 200, body: { ...NOT_CONNECTED, pro: false } };
    await renderModal();
    expect(text()).toContain("Režim Pro přiděluji ručně a zdarma");
    const mail = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(mail?.textContent).toBe("Napsat o přístup");
    expect(decodeURIComponent(mail!.getAttribute("href")!)).toContain("subject=Dawmain - Zotero (Pro)");
    expect(connectForm()).toBeNull();
  });

  it("not connected: the heading, two mode cards (Číst a ukládat preselected), and a real form POST to /api/zotero/connect", async () => {
    await renderModal();
    expect(calls).toContainEqual({ url: "/api/zotero/status", method: "GET" });
    expect(host.querySelector(".zp-head")?.textContent).toContain("Vaše knihovna ze zotero.org, ve které asistent hledá, čte a případně ukládá.");
    expect(host.querySelector(".zd-zotero h3")?.textContent).toBe("Připojte svou knihovnu Zotero");
    const t = text();
    expect(t).toContain("včetně skupin, kterých jste členem – vedle oficiálních databází.");
    expect(t).toContain("Co smí Dawmain v knihovně dělat");
    expect(t).toContain("Asistent v knihovně hledá a čte. Nic v ní nezapíše, nezmění ani nesmaže.");
    expect(t).toContain("Asistent může i rovnou do Zotera ukládat nalezené dokumenty.");
    expect(t).toContain("Volbu změníte kdykoli tak, že Zotero připojíte znovu.");
    // What the wireframe dropped.
    for (const gone of ["Zápis nepovolujte", "Po kliknutí přejdete na zotero.org", "zašifrovaný", "Jen čte."]) expect(t, gone).not.toContain(gone);
    expect(host.querySelector('a[href="/soukromi"]')).toBeNull();

    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(modes()).toEqual({ cards: { "Jen číst": false, "Číst a ukládat": true }, posted: "write" });
    expect(host.querySelector('.zd-zotero-mode[data-selected="true"] .zd-zotero-mode-title')?.textContent).toBe("Číst a ukládat");

    // Choosing "Jen číst" changes what the form posts.
    await act(async () => host.querySelector<HTMLInputElement>('.zd-zotero-mode input[value="read"]')!.click());
    expect(modes()).toEqual({ cards: { "Jen číst": true, "Číst a ukládat": false }, posted: "read" });

    const form = connectForm()!;
    expect(form.getAttribute("method")).toBe("post");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.textContent).toBe("Připojit Zotero");
    // A navigation, not fetch: submitting only marks the button, nothing is fetched.
    const before = calls.length;
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(submit.disabled).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("connected: the username and the mode, the numbers, Změnit oprávnění and Odpojit behind a confirmation", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    const t = text();
    expect(host.querySelector(".zp-badge")?.textContent).toBe("Připojeno");
    expect(t).toContain("Účet jnovakova · čtení a ukládání");
    // Beside the heading: who, the mode, since when. Above the list: how many are on and their items.
    expect(t).toContain("připojeno od 12. 9. 2026");
    expect(norm(host.querySelector(".zp-sum")?.textContent)).toBe("zapnuto 2 z 3 · 1 203 položek");
    for (const gone of ["Odpojení", "Co klíč smí", "zotero.org/settings/keys"]) expect(t, gone).not.toContain(gone);
    expect(t).toContain("Asistent může i rovnou do Zotera ukládat nalezené dokumenty. Změnit to jde opětovným připojením.");
    expect(t).toContain("Dawmain zapomene klíč ke knihovně. Ve vašem Zoteru se nic nesmaže.");
    expect(connectForm()).toBeNull();
    expect(button("Změnit oprávnění")).toBeDefined();

    const changed = vi.fn();
    window.addEventListener("dz-zotero-changed", changed);
    await act(async () => button("Odpojit Zotero")!.click());
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("Odpojit Zotero?");
    expect(calls.some((c) => c.url === "/api/zotero/disconnect")).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(calls).toContainEqual({ url: "/api/zotero/disconnect", method: "POST" });
    // The home page's Zotero group hears about it and reloads its status too.
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener("dz-zotero-changed", changed);
    // The status is loaded again: now not connected.
    expect(calls.filter((c) => c.url === "/api/zotero/status")).toHaveLength(2);
    expect(connectForm()).not.toBeNull();
    expect(host.querySelector(".zp-badge")).toBeNull();
  });

  it("connected read-only: „jen čtení“", async () => {
    status = { code: 200, body: CONNECTED_READ };
    await renderModal();
    expect(text()).toContain("Účet jnovakova · jen čtení");
    expect(text()).toContain("Asistent v knihovně hledá a čte. Nic v ní nezapíše, nezmění ani nesmaže. Změnit to jde opětovným připojením.");
  });

  it("Změnit oprávnění shows the mode choice (the current mode chosen); Zrušit brings the button back", async () => {
    status = { code: 200, body: CONNECTED_READ };
    await renderModal();
    await act(async () => button("Změnit oprávnění")!.click());
    expect(modes()).toEqual({ cards: { "Jen číst": true, "Číst a ukládat": false }, posted: "read" });
    expect(document.activeElement).toBe(host.querySelector('.zd-zotero-mode input[value="read"]'));
    expect(connectForm()!.querySelector('button[type="submit"]')?.textContent).toBe("Připojit znovu");
    expect(text()).toContain("Volbu změníte kdykoli tak, že Zotero připojíte znovu.");
    await act(async () => button("Zrušit")!.click());
    expect(connectForm()).toBeNull();
    expect(document.activeElement).toBe(button("Změnit oprávnění"));
  });

  it("Odpojit: Zrušit returns focus to Odpojit; after success focus stays inside the page", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    await act(async () => button("Odpojit Zotero")!.click());
    await act(async () => button("Zrušit")!.click());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Odpojit Zotero"));
    await act(async () => button("Odpojit Zotero")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it("Odpojit succeeded but the status reload fails: the old connection is not shown again", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    await act(async () => button("Odpojit Zotero")!.click());
    // The stub empties the status on disconnect; make the reload fail instead.
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const res = await inner(input, init);
      if (String(input) === "/api/zotero/disconnect") status = { code: 503, body: { error: "Server teď neodpovídá." } };
      return res;
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(host.querySelector(".zp-badge")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Server teď neodpovídá.");
    expect(button("Zkusit znovu")).toBeDefined();
  });

  it("a failed Odpojit keeps the connection, says why, and focus returns to Odpojit", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === "/api/zotero/disconnect" ? json({ error: "Odpojení se nepodařilo." }, 502) : inner(input, init),
    );
    await act(async () => button("Odpojit Zotero")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(text()).toContain("Účet jnovakova");
    expect(host.querySelector(".zd-zotero-disconnect [role=alert]")?.textContent).toBe("Odpojení se nepodařilo.");
    expect(document.activeElement).toBe(button("Odpojit Zotero"));
  });

  it("connected but Pro is gone: the connection stays visible and removable", async () => {
    status = { code: 200, body: { ...CONNECTED, pro: false } };
    await renderModal();
    expect(text()).toContain("Účet jnovakova");
    expect(text()).toContain("Režim Pro teď nemáte");
    expect(button("Odpojit Zotero")).toBeDefined();
    // The libraries are not asked for: the route refuses without Pro.
    expect(calls.some((c) => c.url === "/api/zotero/libraries")).toBe(false);
    expect(host.querySelector(".zp-libs")).toBeNull();
  });

  it("revoked: the key stopped working; ONE Připojit znovu, which leads to the mode choice", async () => {
    status = { code: 200, body: { ...NOT_CONNECTED, revoked: { username: "jnovakova", revokedAt: "2026-09-20T08:00:00Z" } } };
    await renderModal();
    expect(host.querySelector("h3")?.textContent).toBe("Klíč přestal platit");
    expect(text()).toContain("Zotero jnovakova · neplatí od 20. 9. 2026");
    expect(text()).toContain("Klíč přestal platit (smazali jste ho v Zoteru?). Připojte Zotero znovu.");
    expect(host.querySelector('.zd-zotero-mark[data-tone="bad"]')).not.toBeNull();
    // Only Připojit znovu: no Připojit Zotero, no old-keys link, no Odpojit.
    expect([...host.querySelectorAll(".zd-zotero button")].map((b) => b.textContent)).toEqual(["Připojit znovu"]);
    expect(host.querySelector('a[href*="settings/keys"]')).toBeNull();
    expect(connectForm()).toBeNull();
    await act(async () => button("Připojit znovu")!.click());
    expect(modes()).toEqual({ cards: { "Jen číst": false, "Číst a ukládat": true }, posted: "write" });
  });

  it("unreadable: connect again, delete the old key in Zotero", async () => {
    status = { code: 200, body: { ...NOT_CONNECTED, unreadable: { username: "jnovakova" } } };
    await renderModal();
    expect(text()).toContain("Připojte Zotero znovu");
    expect(text()).toContain("Starý klíč pak smažte v nastavení Zotera");
    expect(button("Připojit znovu")).toBeDefined();
    expect(button("Odpojit Zotero")).toBeUndefined();
  });

  it("the status route fails: the error and Zkusit znovu, which asks again", async () => {
    status = { code: 503, body: { error: "Server teď neodpovídá." } };
    await renderModal();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Server teď neodpovídá.");
    status = { code: 200, body: NOT_CONNECTED };
    // While asking again: "Načítám…", not the old error (the answer is held back until checked).
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (input, init) => {
      await held;
      return inner(input, init);
    });
    await act(async () => button("Zkusit znovu")!.click());
    expect(host.querySelector(".zd-error")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Načítám");
    release();
    await settle();
    expect(connectForm()).not.toBeNull();
  });

  it("an answer that is not a status is not trusted", async () => {
    status = { code: 200, body: { state: "connected", username: "x" } };
    await renderModal();
    expect(connectForm()).toBeNull();
    expect(host.querySelector(".zd-error")).not.toBeNull();
  });
});

describe("the ?stav= banner", () => {
  it("one Czech sentence per outcome; success and errors styled apart", () => {
    expect(Object.keys(STAV_BANNER).sort()).toEqual([...ZOTERO_STAV].sort());
    expect(STAV_BANNER.pripojeno.tone).toBe("ok");
    for (const stav of ZOTERO_STAV) {
      const { text: sentence, tone } = STAV_BANNER[stav];
      expect(sentence, stav).toMatch(/^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ].*\.$/u);
      if (stav !== "pripojeno") expect(tone, stav).not.toBe("ok");
    }
    expect(Object.keys(STAV_BANNER)).not.toContain("zapis");
    expect(STAV_BANNER.pripojeno.text).toBe("Zotero je připojené. Asistent teď může hledat a číst ve vaší knihovně a ukládat do ní nalezené dokumenty.");
    expect(PRIPOJENO_READ).toBe("Zotero je připojené. Asistent teď může hledat a číst ve vaší knihovně.");
    expect(bannerText("pripojeno", "write")).toBe(STAV_BANNER.pripojeno.text);
    expect(bannerText("pripojeno", "read")).toBe(PRIPOJENO_READ);
    expect(bannerText("pripojeno", null)).toBe(PRIPOJENO_READ);
    expect(bannerText("chyba", "write")).toBe(STAV_BANNER.chyba.text);
    expect(STAV_BANNER.nedostupne.text).toBe("Připojení Zotera není na tomto webu zapnuté.");
    // web.ts: another account than the one that started gets vyprselo, never prihlaseni.
    expect(STAV_BANNER.prihlaseni.text).not.toContain("jiným účtem");
    expect(STAV_BANNER.vyprselo.text).toContain("pod tímtéž účtem");
    // web.ts answers chyba also to a key that cannot read the personal library.
    expect(STAV_BANNER.chyba.text).toContain("čtení knihovny");
  });

  it("the page makes no promise about keys, files or privacy beyond the mode cards", async () => {
    await renderModal();
    const t = text();
    expect(connectForm()?.querySelector('button[type="submit"]')?.textContent).toBe("Připojit Zotero");
    expect(t).not.toMatch(/soubor (uložím|si nechám)|zašifrovan|nepovolujte/);
  });

  for (const stav of ZOTERO_STAV) {
    it(`stav=${stav}: shown in a live region, then dropped from the URL`, async () => {
      landOn(`/zotero?stav=${stav}`);
      await renderModal(stav);
      const live = host.querySelector('[aria-live="polite"]');
      const banner = live?.querySelector(".zd-zotero-banner");
      // The status here is "not connected": pripojeno says the read sentence.
      const expected = bannerText(stav, null);
      expect(banner?.textContent).toBe(expected);
      expect(banner?.getAttribute("data-tone")).toBe(STAV_BANNER[stav].tone);
      expect(routed).toEqual([{ kind: "replace", url: "/zotero" }]);
      // The URL no longer has it; the banner stays.
      await act(async () => root.render(createElement(ZoteroPanel, { stav: null })));
      expect(host.querySelector(".zd-zotero-banner")?.textContent).toBe(expected);
    });
  }

  it("stav=pripojeno follows the connection's mode", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal("pripojeno");
    expect(host.querySelector(".zd-zotero-banner")?.textContent).toBe(STAV_BANNER.pripojeno.text);
    await act(async () => root.unmount());
    root = createRoot(host);
    status = { code: 200, body: CONNECTED_READ };
    await renderModal("pripojeno");
    expect(host.querySelector(".zd-zotero-banner")?.textContent).toBe(PRIPOJENO_READ);
  });

  it("an unknown stav shows nothing but is dropped too", async () => {
    landOn("/zotero?stav=%3Cscript%3E");
    await renderModal("<script>");
    expect(host.querySelector(".zd-zotero-banner")).toBeNull();
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(routed).toEqual([{ kind: "replace", url: "/zotero" }]);
  });

  it("after Odpojit the old outcome disappears", async () => {
    landOn("/zotero?stav=pripojeno");
    status = { code: 200, body: CONNECTED };
    await renderModal("pripojeno");
    expect(host.querySelector(".zd-zotero-banner")).not.toBeNull();
    await act(async () => button("Odpojit Zotero")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(host.querySelector(".zd-zotero-banner")).toBeNull();
  });
});

describe("Knihovny a skupiny (/api/zotero/libraries)", () => {
  const rows = () =>
    [...host.querySelectorAll<HTMLLIElement>(".zp-lib")].map((li) => ({
      name: li.querySelector("b")?.textContent,
      sub: norm(li.querySelector(".zp-lib-text > span")?.textContent),
      on: li.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
      disabled: li.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled,
    }));
  const toggle = (name: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Používat ${name}"]`)!;

  it("lists every library with its switch; in write mode the personal one is where new items go", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    expect(text()).toContain("Asistent hledá jen v zapnutých. Vypnutím se v Zoteru nic nesmaže, jen ji Dawmain přestane používat.");
    expect(rows()).toEqual([
      { name: "Moje knihovna", sub: "osobní knihovna · 1 200 položek · sem asistent ukládá nové položky", on: "true", disabled: false },
      { name: "Katedra obchodního práva", sub: "skupina · 3 položky · jen čtení", on: "true", disabled: false },
      { name: "Seminář", sub: "skupina · jen čtení", on: "false", disabled: false },
    ]);
    // No select of a save target: zotero_save writes to the personal library only.
    expect(host.querySelector("select")).toBeNull();
  });

  it("read-only: no word about saving", async () => {
    status = { code: 200, body: CONNECTED_READ };
    libraries = { code: 200, body: { ...LIBRARIES, mode: "read" } };
    await renderModal();
    expect(rows()[0].sub).toBe("osobní knihovna · 1 200 položek");
  });

  it("a switch posts { library, on } and shows the answer; the last one on cannot be switched off", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    await act(async () => toggle("Seminář").click());
    await settle();
    expect(posted).toEqual([{ library: "222", on: true }]);
    expect(rows().map((r) => r.on)).toEqual(["true", "true", "true"]);
    await act(async () => toggle("Katedra obchodního práva").click());
    await settle();
    await act(async () => toggle("Seminář").click());
    await settle();
    expect(rows().map((r) => [r.on, r.disabled])).toEqual([
      ["true", true],
      ["false", false],
      ["false", false],
    ]);
    expect(toggle("Moje knihovna").title).toBe("Aspoň jedna knihovna musí zůstat zapnutá.");
    // The personal library off in write mode: said plainly.
    await act(async () => toggle("Seminář").click());
    await settle();
    await act(async () => toggle("Moje knihovna").click());
    await settle();
    expect(text()).toContain("Osobní knihovna je vypnutá, a tak do Zotera asistent nic neuloží.");
  });

  it("a switch the server refuses keeps the list and says why", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === "/api/zotero/libraries" && init?.method === "POST" ? json({ error: "Změnu se teď nepodařilo uložit." }, 503) : inner(input, init),
    );
    await act(async () => toggle("Katedra obchodního práva").click());
    await settle();
    expect(rows()[1].on).toBe("true");
    expect(host.querySelector(".zp-sec [role=alert]")?.textContent).toBe("Změnu se teď nepodařilo uložit.");
  });

  it("groups that did not list: a warning, and nothing can be switched", async () => {
    status = { code: 200, body: CONNECTED };
    libraries = { code: 200, body: { ...LIBRARIES, groupsFailed: true, libraries: [LIBRARIES.libraries[0]] } };
    await renderModal();
    expect(text()).toContain("Skupiny se teď nepodařilo načíst ze Zotera.");
    expect(rows().map((r) => r.disabled)).toEqual([true]);
  });

  it("the list fails to load: the error and Zkusit znovu", async () => {
    status = { code: 200, body: CONNECTED };
    libraries = { code: 503, body: { error: "Knihovny Zotera se teď nepodařilo načíst." } };
    await renderModal();
    expect(text()).toContain("Knihovny Zotera se teď nepodařilo načíst.");
    libraries = { code: 200, body: LIBRARIES };
    await act(async () => button("Zkusit znovu")!.click());
    await settle();
    expect(rows()).toHaveLength(3);
  });
});
