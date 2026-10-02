// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoteroStatus } from "@/src/zotero/web-types";

/**
 * The Zotero group on the home page (ZoteroGroup in
 * app/_zdroje/own-sources.tsx, rendered by app/page.tsx only where the
 * deployment can connect Zotero): the connection state in one row, and the
 * way into the Zotero modal (?zotero=1) — or the sign-in for a visitor, who
 * never makes the status request.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const store = await import("@/app/_zdroje/store");
const { OwnSourcesGroup, ZoteroGroup } = await import("@/app/_zdroje/own-sources");
const { notifyZoteroChanged } = await import("@/app/_zdroje/zotero-status");

const NOT_CONNECTED: ZoteroStatus = { state: "ok", configured: true, pro: true, connection: null, revoked: null, unreadable: null };
const CONNECTED: ZoteroStatus = {
  ...NOT_CONNECTED,
  connection: { username: "jnovakova", userID: 12345, connectedAt: "2026-09-12T10:00:00Z", mode: "read", notes: true, groups: "all" },
};

let status: { code: number; body: unknown } = { code: 200, body: NOT_CONNECTED };
let calls: string[] = [];

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  status = { code: 200, body: NOT_CONNECTED };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/zotero/status") return json(status.body, status.code);
      return json({ error: "Nenalezeno." }, 404);
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.setAuth("loading");
  store.registerClerkActions(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const PRO_SUMMARY = {
  state: "ok",
  mode: "on",
  termsAccepted: true,
  libraries: [
    {
      id: "user_jana",
      kind: "user",
      name: "Jana",
      role: "owner",
      pro: true,
      canUpload: true,
      canManageAll: true,
      quotaPages: 1000,
      pagesUsed: 10,
      counts: { total: 2, ready: 2, review: 0, processing: 0, error: 0, searchable: 2 },
      memberCount: null,
    },
  ],
};

async function render(auth: "signed_in" | "signed_out" = "signed_in"): Promise<void> {
  store.setAuth(auth);
  await act(async () =>
    root.render(createElement("div", null, createElement(OwnSourcesGroup), createElement(ZoteroGroup))),
  );
  await settle();
}

function group(): HTMLDivElement | null {
  return [...host.querySelectorAll<HTMLDivElement>(".source-group")].find((g) => g.querySelector(".source-group-name")?.textContent === "Zotero") ?? null;
}

function statusCalls(): number {
  return calls.filter((c) => c === "/api/zotero/status").length;
}

describe("the Zotero group on the home page", () => {
  it("invites a visitor to sign in, locked, without asking the server", async () => {
    const signIn = vi.fn();
    store.registerClerkActions({ signIn, manageAccount: vi.fn(), signOut: vi.fn() });
    await render("signed_out");
    const g = group()!;
    expect(g).not.toBeNull();
    expect(g.className).toContain("locked");
    expect(g.textContent).toContain("V režimu Pro");
    expect(statusCalls()).toBe(0);
    await act(async () => g.querySelector<HTMLButtonElement>("button")!.click());
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("offers to connect, and opens the Zotero modal (?zotero=1)", async () => {
    await render();
    const g = group()!;
    expect(g.className).not.toContain("locked");
    expect(g.textContent).toContain("Připojte svou knihovnu");
    await act(async () => g.querySelector<HTMLButtonElement>("button")!.click());
    expect(new URLSearchParams(window.location.search).get("zotero")).toBe("1");
  });

  it("shows the connected account once, with the badge, not greyed out", async () => {
    status = { code: 200, body: CONNECTED };
    await render();
    const g = group()!;
    expect(g.className).not.toContain("locked");
    expect(g.textContent).toContain("Účet jnovakova");
    expect(g.textContent!.match(/Připojeno/g)).toHaveLength(1);
    expect(g.querySelector('.zd-badge[data-tone="ok"]')?.textContent).toBe("Připojeno");
  });

  it("asks for the status once, however the Vlastní zdroje summary settles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "/api/zotero/status") return json(CONNECTED);
        if (url.startsWith("/api/files/summary")) return json(PRO_SUMMARY);
        return json({ error: "Nenalezeno." }, 404);
      }),
    );
    await render();
    expect(host.textContent).toContain("Moje zdroje");
    expect(statusCalls()).toBe(1);
  });

  it("a connection without Pro is locked and says the assistant cannot see the library", async () => {
    status = { code: 200, body: { ...CONNECTED, pro: false } };
    await render();
    const g = group()!;
    expect(g.className).toContain("locked");
    expect(g.textContent).toContain("bez režimu Pro do knihovny asistent nevidí");
    expect(g.querySelector(".zd-badge")).toBeNull();
  });

  it("tells a revoked key from an unreadable one, is locked without Pro, and survives a server error", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ ...NOT_CONNECTED, pro: false }, 200, "Jen v režimu Pro"],
      [{ ...NOT_CONNECTED, revoked: { username: "jnovakova", revokedAt: "2026-09-20T10:00:00Z" } }, 200, "Klíč přestal platit"],
      [{ ...NOT_CONNECTED, unreadable: { username: "jnovakova" } }, 200, "Připojení je potřeba obnovit"],
      [{ error: "Stav připojení Zotera se teď nepodařilo zjistit." }, 503, "Stav připojení se teď nepodařilo zjistit."],
      [{ state: "signed_out" }, 200, "V režimu Pro"],
    ];
    for (const [body, code, text] of cases) {
      await act(async () => root.unmount());
      root = createRoot(host);
      status = { code, body };
      await render();
      expect(group()!.textContent).toContain(text);
    }
  });

  it("never shows the previous account after signing out and in as someone else", async () => {
    status = { code: 200, body: CONNECTED };
    await render();
    expect(group()!.textContent).toContain("jnovakova");
    await act(async () => store.setAuth("signed_out"));
    // The next user's status request hangs: whatever shows meanwhile must not be the old account.
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "/api/zotero/status") return new Promise<Response>((r) => (release = r));
        return json({ error: "Nenalezeno." }, 404);
      }),
    );
    await act(async () => store.setAuth("signed_in"));
    await settle();
    expect(group()!.textContent).not.toContain("jnovakova");
    expect(group()!.textContent).toContain("Načítám");
    await act(async () => release(json({ ...CONNECTED, connection: { ...CONNECTED.connection!, username: "pdvorak" } })));
    await settle();
    expect(group()!.textContent).toContain("Účet pdvorak");
  });

  it("reloads the status when the modal reports a change (Odpojit)", async () => {
    status = { code: 200, body: CONNECTED };
    await render();
    expect(group()!.textContent).toContain("Účet jnovakova");
    status = { code: 200, body: NOT_CONNECTED };
    await act(async () => notifyZoteroChanged());
    await settle();
    expect(group()!.textContent).toContain("Připojte svou knihovnu");
    expect(group()!.textContent).not.toContain("jnovakova");
  });
});
