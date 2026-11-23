// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoteroStatus } from "@/src/zotero/web-types";

/**
 * The Zotero row of the home page's "Pro" group (OwnSourcesGroup
 * in app/_zdroje/own-sources.tsx, with `zotero` only where the deployment
 * can connect Zotero): the connection state in one row, and the
 * way to the /zotero page — or the sign-in for a visitor, who
 * never makes the status request.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const store = await import("@/app/_zdroje/store");
const { OwnSourcesGroup } = await import("@/app/_zdroje/own-sources");
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
      handle: "osobni",
      logoUrl: null,
      quotaBytes: 104_857_600,
      bytesUsed: 10 * 1024 * 1024,
      counts: { total: 2, ready: 2, review: 0, processing: 0, error: 0, searchable: 2 },
    },
  ],
  maxFileBytes: 104_857_600,
};

async function render(auth: "signed_in" | "signed_out" = "signed_in"): Promise<void> {
  store.setAuth(auth);
  await act(async () =>
    root.render(createElement(OwnSourcesGroup, { zotero: true })),
  );
  await settle();
}

/** The Zotero row; `locked` reads its own lock or, for a visitor, the whole group's. */
function group(): (HTMLLIElement & { locked: boolean }) | null {
  const row = [...host.querySelectorAll<HTMLLIElement>(".source")].find((r) => r.querySelector(".source-title")?.textContent?.trim() === "Zotero");
  if (!row) return null;
  const locked = row.className.includes("zd-row-locked") || (row.closest(".source-group")?.className.includes("locked") ?? false);
  return Object.assign(row, { locked });
}

function statusCalls(): number {
  return calls.filter((c) => c === "/api/zotero/status").length;
}

describe("the Zotero row on the home page", () => {
  it("shows a visitor the row locked and not clickable, without asking the server", async () => {
    await render("signed_out");
    const g = group()!;
    expect(g).not.toBeNull();
    expect(g.locked).toBe(true);
    expect(g.textContent).toContain("Vaše knihovna");
    expect(statusCalls()).toBe(0);
    expect(g.querySelector("button")).toBeNull();
    expect(g.querySelector("a.source-title")).toBeNull();
  });

  it("stays in the group, locked and without a button, where the deployment cannot connect Zotero", async () => {
    store.setAuth("signed_in");
    await act(async () => root.render(createElement(OwnSourcesGroup, { zotero: false })));
    await settle();
    const g = group()!;
    expect(g).not.toBeNull();
    expect(g.locked).toBe(true);
    expect(g.textContent).toContain("Vaše knihovna");
    expect(g.querySelector("button")).toBeNull();
    expect(statusCalls()).toBe(0);
  });

  it("signed in with Pro: the same line as for visitors, no lock, the card links to /zotero", async () => {
    await render();
    const g = group()!;
    expect(g.locked).toBe(false);
    expect(g.textContent).toContain("Vaše knihovna");
    expect(g.querySelector<HTMLAnchorElement>("a.source-title")?.getAttribute("href")).toBe("/zotero");
  });

  it("never shows the connected account or a light: that lives on /zotero", async () => {
    status = { code: 200, body: CONNECTED };
    await render();
    const g = group()!;
    expect(g.locked).toBe(false);
    expect(g.textContent).toContain("Vaše knihovna");
    expect(g.textContent).not.toContain("jnovakova");
    expect(g.querySelector(".source-dot")).toBeNull();
  });

  it("asks for the status once, and the Vlastní soubory card shows no counts", async () => {
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
    expect(host.textContent).not.toContain("2 dokumenty");
    expect(host.textContent).not.toContain("Spravovat");
    expect(statusCalls()).toBe(1);
  });

  it("without Pro the card is locked, with the same line", async () => {
    status = { code: 200, body: { ...CONNECTED, pro: false } };
    await render();
    const g = group()!;
    expect(g.locked).toBe(true);
    expect(g.textContent).toContain("Vaše knihovna");
  });

  it("only a broken key changes the line; a server error keeps the usual one", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ ...NOT_CONNECTED, pro: false }, 200, "Vaše knihovna"],
      [{ ...NOT_CONNECTED, revoked: { username: "jnovakova", revokedAt: "2026-09-20T10:00:00Z" } }, 200, "Klíč přestal platit"],
      [{ ...NOT_CONNECTED, unreadable: { username: "jnovakova" } }, 200, "Připojení je potřeba obnovit"],
      [{ error: "Stav připojení Zotera se teď nepodařilo zjistit." }, 503, "Vaše knihovna"],
      [{ state: "signed_out" }, 200, "Vaše knihovna"],
    ];
    for (const [body, code, text] of cases) {
      await act(async () => root.unmount());
      root = createRoot(host);
      status = { code, body };
      await render();
      expect(group()!.textContent).toContain(text);
    }
  });

  it("reloads the status when the Zotero page reports a change", async () => {
    status = { code: 200, body: CONNECTED };
    await render();
    expect(group()!.textContent).toContain("Vaše knihovna");
    status = { code: 200, body: { ...NOT_CONNECTED, revoked: { username: "jnovakova", revokedAt: "2026-09-20T10:00:00Z" } } };
    await act(async () => notifyZoteroChanged());
    await settle();
    expect(group()!.textContent).toContain("Klíč přestal platit");
  });
});
