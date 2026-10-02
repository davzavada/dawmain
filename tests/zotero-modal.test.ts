// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOTERO_STAV, type ZoteroStatus } from "@/src/zotero/web-types";

/**
 * The Zotero modal (app/_zdroje/zotero-modal.tsx) and its deep link: ?zotero=1
 * opens it through the same URL-driven machinery as the Vlastní zdroje and
 * team modals (app/_zdroje/store.ts, modals.tsx) — with Next's history patch
 * installed as in tests/files-webui-history.test.ts, so every open, close and
 * the dropped &stav reach the router. Then each state the status route can
 * answer (src/zotero/web-types.ts), rendered against a stubbed fetch, and the
 * banner for every connect outcome.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// The modal bodies are lazy chunks; here only which one ZdrojeModals asks for matters (told apart by their props).
vi.mock("next/dynamic", () => ({
  default: () =>
    function Lazy(props: Record<string, unknown>) {
      const which = "tab" in props ? String(props.tab) : "orgParam" in props ? "team" : "stav" in props ? "zotero" : "?";
      return createElement("div", { "data-lazy": which, "data-stav": String(props.stav ?? "") });
    },
}));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, user: { fullName: "Jana Nováková", primaryEmailAddress: { emailAddress: "jana@example.cz" } } }),
  useOrganizationList: () => ({ userInvitations: undefined }),
}));

const store = await import("@/app/_zdroje/store");
const { ZdrojeModals } = await import("@/app/_zdroje/modals");
const { AccountControl } = await import("@/app/_zdroje/account");
const { ZoteroModal, STAV_BANNER, PRIPOJENO_READ, bannerText } = await import("@/app/_zdroje/zotero-modal");

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

let status: { code: number; body: unknown } = { code: 200, body: NOT_CONNECTED };
let calls: { url: string; method: string }[] = [];

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  window.confirm = vi.fn(() => true);
  landOn("/");
  store.registerUnsavedWork(null);
  status = { code: 200, body: NOT_CONNECTED };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/zotero/status") return json(status.body, status.code);
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
});

/** Let the status fetch (a few awaits deep) land and React commit it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function renderModal(stav: string | null = null): Promise<void> {
  await act(async () => root.render(createElement(ZoteroModal, { stav })));
  await settle();
}

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

describe("?zotero=1 deep link", () => {
  it("renders the Zotero modal, and never together with the sources or team modal", async () => {
    const lazies = () => [...host.querySelectorAll("[data-lazy]")].map((e) => e.getAttribute("data-lazy"));
    search = "zotero=1";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual(["zotero"]);

    search = "zotero=1&stav=pripojeno";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual(["zotero"]);
    expect(host.querySelector("[data-lazy]")?.getAttribute("data-stav")).toBe("pripojeno");

    search = "zotero=1&zdroje=moje";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual(["moje"]);

    search = "zotero=1&tym=org_1";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual(["team"]);

    // ?zdroje=zotero is the sources modal's "moje" tab, not Zotero.
    search = "zdroje=zotero";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual(["moje"]);

    search = "";
    await act(async () => root.render(createElement(ZdrojeModals)));
    expect(lazies()).toEqual([]);
  });

  it("the modal stays a lazy chunk: modals.tsx imports it only dynamically", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../app/_zdroje/modals.tsx"), "utf8");
    expect(src).toMatch(/import\(\s*["']\.\/zotero-modal["']\s*\)/);
    expect(src).not.toMatch(/from\s+["']\.\/zotero-modal["']/);
  });
});

describe("openZotero / closeZotero", () => {
  it("openZotero pushes ?zotero=1; closing pops that entry", () => {
    store.openZotero();
    expect(routed).toEqual([{ kind: "push", url: "/?zotero=1" }]);
    expect(window.location.search).toBe("?zotero=1");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    store.closeZotero();
    expect(back).toHaveBeenCalledTimes(1);
    expect(skipped).toEqual([]);
  });

  it("closing a deep-linked modal (the connect flow's return) removes zotero and stav, keeps the rest", () => {
    landOn("/?zotero=1&stav=chyba&x=1#konec");
    const back = vi.spyOn(window.history, "back");
    store.closeZotero();
    expect(back).not.toHaveBeenCalled();
    expect(routed).toEqual([{ kind: "replace", url: "/?x=1#konec" }]);
    expect(skipped).toEqual([]);
  });

  it("from another modal it replaces that one; opening sources or team drops zotero and stav", () => {
    landOn("/?zdroje=moje&dokument=11111111-1111-4111-8111-111111111111");
    store.openZotero();
    expect(routed).toEqual([{ kind: "replace", url: "/?zotero=1" }]);

    landOn("/?zotero=1&stav=pripojeno");
    store.openSources("moje");
    expect(routed.at(-1)?.url).toBe("/?zdroje=moje");

    landOn("/?zotero=1");
    store.openTeam("org_1");
    expect(routed.at(-1)?.url).toBe("/?tym=org_1");
  });

  it("a conversion in progress in the sources modal is asked about first", () => {
    landOn("/?zdroje=moje");
    store.registerUnsavedWork(() => true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    store.openZotero();
    expect(routed).toEqual([]);
    expect(window.location.search).toBe("?zdroje=moje");
  });

  it("dropZoteroStav replaces the entry without &stav", () => {
    landOn("/?zotero=1&stav=chyba");
    store.dropZoteroStav();
    expect(routed).toEqual([{ kind: "replace", url: "/?zotero=1" }]);
    store.dropZoteroStav();
    expect(routed).toHaveLength(1);
  });

  it("the account menu has Zotero right after Vlastní zdroje, and it opens the modal", async () => {
    store.setAuth("signed_in");
    await act(async () => root.render(createElement(AccountControl, { zotero: true })));
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-avatar-button")!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim());
    expect(items.indexOf("Zotero")).toBe(items.indexOf("Vlastní zdroje") + 1);
    routed = [];
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((e) => e.textContent?.trim() === "Zotero")!.click());
    expect(routed).toEqual([{ kind: "push", url: "/?zotero=1" }]);
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
    expect(items).toContain("Vlastní zdroje");
    expect(items).not.toContain("Zotero");
    store.setAuth("loading");
  });
});

describe("modal states (GET /api/zotero/status)", () => {
  it("signed out: an explanation and Přihlásit se, no connect form", async () => {
    status = { code: 200, body: { state: "signed_out" } };
    await renderModal();
    expect(host.querySelector('[role="dialog"] h2')?.textContent).toBe("Zotero");
    expect(text()).toContain("Přihlaste se");
    expect(text()).toContain("když mu to povolíte, ukládá do ní nalezené dokumenty");
    expect(button("Přihlásit se")?.type).toBe("button");
    expect(connectForm()).toBeNull();
  });

  it("signed out according to Clerk: the server is not even asked", async () => {
    store.setAuth("signed_out");
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
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Vaše knihovna ze zotero.org, ve které asistent hledá, čte a případně ukládá.");
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

  it("connected: the username, since when and the mode, Připojit znovu and Odpojit behind a confirmation", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    expect(host.querySelector("h3")?.textContent).toBe("Připojeno jako jnovakova");
    const t = text();
    expect(t).toContain("od 12. 9. 2026 · čtení a ukládání");
    // The old scope table, the Odpojení heading and its texts are gone.
    expect(host.querySelector("dl")).toBeNull();
    for (const gone of ["Odpojení", "Co klíč smí", "zotero.org/settings/keys"]) expect(t, gone).not.toContain(gone);
    expect(connectForm()).toBeNull();
    expect(button("Připojit znovu")).toBeDefined();

    const changed = vi.fn();
    window.addEventListener("dz-zotero-changed", changed);
    await act(async () => button("Odpojit")!.click());
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
    expect(text()).not.toContain("Připojeno jako");
  });

  it("connected read-only: „jen čtení“", async () => {
    status = { code: 200, body: CONNECTED_READ };
    await renderModal();
    expect(text()).toContain("od 12. 9. 2026 · jen čtení");
  });

  it("Připojit znovu shows the mode choice (the current mode chosen); Zrušit brings the buttons back", async () => {
    status = { code: 200, body: CONNECTED_READ };
    await renderModal();
    await act(async () => button("Připojit znovu")!.click());
    expect(modes()).toEqual({ cards: { "Jen číst": true, "Číst a ukládat": false }, posted: "read" });
    expect(document.activeElement).toBe(host.querySelector('.zd-zotero-mode input[value="read"]'));
    expect(connectForm()!.querySelector('button[type="submit"]')?.textContent).toBe("Připojit znovu");
    expect(text()).toContain("Volbu změníte kdykoli tak, že Zotero připojíte znovu.");
    expect(button("Odpojit")).toBeUndefined();
    await act(async () => button("Zrušit")!.click());
    expect(connectForm()).toBeNull();
    expect(document.activeElement).toBe(button("Připojit znovu"));
    expect(button("Odpojit")).toBeDefined();
  });

  it("Odpojit: Zrušit returns focus to Odpojit; after success focus stays inside the modal", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    await act(async () => button("Odpojit")!.click());
    await act(async () => button("Zrušit")!.click());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Odpojit"));
    await act(async () => button("Odpojit")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it("Odpojit succeeded but the status reload fails: the old connection is not shown again", async () => {
    status = { code: 200, body: CONNECTED };
    await renderModal();
    await act(async () => button("Odpojit")!.click());
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
    expect(text()).not.toContain("Připojeno jako");
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
    await act(async () => button("Odpojit")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(text()).toContain("Připojeno jako jnovakova");
    expect(host.querySelector(".zd-zotero-disconnect [role=alert]")?.textContent).toBe("Odpojení se nepodařilo.");
    expect(document.activeElement).toBe(button("Odpojit"));
  });

  it("connected but Pro is gone: the connection stays visible and removable", async () => {
    status = { code: 200, body: { ...CONNECTED, pro: false } };
    await renderModal();
    expect(text()).toContain("Připojeno jako jnovakova");
    expect(text()).toContain("Režim Pro teď nemáte");
    expect(button("Odpojit")).toBeDefined();
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
    expect(button("Odpojit")).toBeUndefined();
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

  it("the modal makes no promise about keys, files or privacy beyond the mode cards", async () => {
    await renderModal();
    const t = text();
    expect(connectForm()?.querySelector('button[type="submit"]')?.textContent).toBe("Připojit Zotero");
    expect(t).not.toMatch(/soubor (uložím|si nechám)|zašifrovan|nepovolujte/);
  });

  for (const stav of ZOTERO_STAV) {
    it(`stav=${stav}: shown in a live region, then dropped from the URL`, async () => {
      landOn(`/?zotero=1&stav=${stav}`);
      await renderModal(stav);
      const live = host.querySelector('[aria-live="polite"]');
      const banner = live?.querySelector(".zd-zotero-banner");
      // The status here is "not connected": pripojeno says the read sentence.
      const expected = bannerText(stav, null);
      expect(banner?.textContent).toBe(expected);
      expect(banner?.getAttribute("data-tone")).toBe(STAV_BANNER[stav].tone);
      expect(routed).toEqual([{ kind: "replace", url: "/?zotero=1" }]);
      // The URL no longer has it; the banner stays.
      await act(async () => root.render(createElement(ZoteroModal, { stav: null })));
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
    landOn("/?zotero=1&stav=%3Cscript%3E");
    await renderModal("<script>");
    expect(host.querySelector(".zd-zotero-banner")).toBeNull();
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(routed).toEqual([{ kind: "replace", url: "/?zotero=1" }]);
  });

  it("after Odpojit the old outcome disappears", async () => {
    landOn("/?zotero=1&stav=pripojeno");
    status = { code: 200, body: CONNECTED };
    await renderModal("pripojeno");
    expect(host.querySelector(".zd-zotero-banner")).not.toBeNull();
    await act(async () => button("Odpojit")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".zd-confirm .zd-btn-danger")!.click());
    await settle();
    expect(host.querySelector(".zd-zotero-banner")).toBeNull();
  });
});
