// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZoteroStatus } from "@/src/zotero/web-types";

/**
 * The Zotero row on the home page (OwnSourcesGroup in
 * app/_zdroje/own-sources.tsx): shown only where the deployment can connect
 * Zotero (the `zotero` prop the server page passes), the connection state in
 * one line, and the way into the Zotero modal (?zotero=1) — or the sign-in
 * for a visitor, who never makes the status request.
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
  connection: { username: "jnovakova", userID: 12345, connectedAt: "2026-09-12T10:00:00Z", notes: true, groups: "all" },
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

async function render(zotero: boolean, auth: "signed_in" | "signed_out" = "signed_in"): Promise<void> {
  store.setAuth(auth);
  await act(async () => root.render(createElement(OwnSourcesGroup, { zotero })));
  await settle();
}

function zoteroRow(): HTMLLIElement | null {
  return [...host.querySelectorAll<HTMLLIElement>("li.source")].find((li) => li.querySelector(".source-title")?.textContent?.startsWith("Zotero")) ?? null;
}

describe("the Zotero row on the home page", () => {
  it("is absent where the deployment cannot connect Zotero, and nothing asks for its status", async () => {
    await render(false);
    expect(host.textContent).toContain("Vlastní zdroje");
    expect(zoteroRow()).toBeNull();
    expect(host.textContent).not.toMatch(/zotero/i);
    expect(calls).not.toContain("/api/zotero/status");
  });

  it("invites a visitor to sign in, locked, without asking the server", async () => {
    const signIn = vi.fn();
    store.registerClerkActions({ signIn, manageAccount: vi.fn(), signOut: vi.fn() });
    await render(true, "signed_out");
    const row = zoteroRow()!;
    expect(row).not.toBeNull();
    expect(row.className).toContain("zd-row-locked");
    expect(row.textContent).toContain("V režimu Pro");
    expect(calls).not.toContain("/api/zotero/status");
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("offers to connect, and the row opens the Zotero modal (?zotero=1)", async () => {
    await render(true);
    const row = zoteroRow()!;
    expect(row.textContent).toContain("Připojte svou knihovnu na zotero.org");
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
    expect(new URLSearchParams(window.location.search).get("zotero")).toBe("1");
  });

  it("shows the connected account with a badge", async () => {
    status = { code: 200, body: CONNECTED };
    await render(true);
    const row = zoteroRow()!;
    expect(row.textContent).toContain("Připojeno jako jnovakova");
    expect(row.querySelector('.zd-badge[data-tone="ok"]')?.textContent).toBe("Připojeno");
  });

  it("is locked without Pro, asks to reconnect after a revoked or unreadable key, and survives a server error", async () => {
    status = { code: 200, body: { ...NOT_CONNECTED, pro: false } };
    await render(true);
    expect(zoteroRow()!.className).toContain("zd-row-locked");
    expect(zoteroRow()!.textContent).toContain("Jen v režimu Pro");

    await act(async () => root.unmount());
    root = createRoot(host);
    status = { code: 200, body: { ...NOT_CONNECTED, revoked: { username: "jnovakova", revokedAt: "2026-09-20T10:00:00Z" } } };
    await render(true);
    expect(zoteroRow()!.textContent).toContain("Klíč přestal platit");

    await act(async () => root.unmount());
    root = createRoot(host);
    status = { code: 200, body: { ...NOT_CONNECTED, unreadable: { username: "jnovakova" } } };
    await render(true);
    expect(zoteroRow()!.textContent).toContain("Klíč přestal platit");

    await act(async () => root.unmount());
    root = createRoot(host);
    status = { code: 503, body: { error: "Stav připojení Zotera se teď nepodařilo zjistit." } };
    await render(true);
    expect(zoteroRow()!.textContent).toContain("nepodařilo zjistit");
  });

  it("reloads the status when the modal reports a change (Odpojit)", async () => {
    status = { code: 200, body: CONNECTED };
    await render(true);
    expect(zoteroRow()!.textContent).toContain("Připojeno jako jnovakova");
    status = { code: 200, body: NOT_CONNECTED };
    await act(async () => notifyZoteroChanged());
    await settle();
    expect(zoteroRow()!.textContent).toContain("Připojte svou knihovnu");
    expect(zoteroRow()!.textContent).not.toContain("jnovakova");
  });
});
