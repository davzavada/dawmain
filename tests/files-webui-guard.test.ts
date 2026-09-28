// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The discard question (web:Z3) is asked only when something would be
 * thrown away: clicking the tab, team or rail item already shown changes
 * nothing, so it asks nothing; going elsewhere still asks. The modal in a
 * DOM (happy-dom) with the summary and the list faked.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The uploader is a lazy chunk; here only the guard around it matters.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const store = await import("@/app/_zdroje/store");
const { SourcesModal } = await import("@/app/_zdroje/sources-modal");

function library(id: string, name: string): LibrarySummary {
  return {
    id,
    kind: id.startsWith("org_") ? "org" : "user",
    name,
    role: "owner",
    pro: true,
    canUpload: true,
    canManageAll: true,
    quotaPages: 3000,
    pagesUsed: 0,
    counts: { total: 0, ready: 0, review: 0, processing: 0, error: 0, searchable: 0 },
    memberCount: id.startsWith("org_") ? 3 : null,
  };
}

const SUMMARY: SummaryResponse = {
  state: "ok",
  mode: "on",
  termsAccepted: true,
  libraries: [library("user_a", "Já"), library("org_1", "Kancelář A"), library("org_2", "Kancelář B")],
};

let host: HTMLDivElement;
let root: Root;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/files/summary") ? SUMMARY : { documents: [], total: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  confirm = vi.fn(() => false);
  window.confirm = confirm as unknown as typeof window.confirm;
  store.setAuth("signed_in");
  await act(async () => {
    await store.refreshSummary();
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.registerUnsavedWork(null);
  store.setAuth("none");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rail = (title: string) => [...host.querySelectorAll(".zd-rail-item")].find((b) => b.querySelector(".zd-rail-title")?.textContent === title) as HTMLButtonElement;
const tab = (text: string) => [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === text) as HTMLButtonElement;

describe("discard question only when something changes (web:Z3)", () => {
  it("the current tab, team or rail item asks nothing; another one still asks", async () => {
    window.history.replaceState(null, "", "/?zdroje=tym");
    await act(async () => root.render(createElement(SourcesModal, { tab: "tym", documentId: null })));
    expect(rail("Kancelář A").getAttribute("aria-current")).toBe("true");
    store.registerUnsavedWork(() => true);

    await act(async () => rail("Kancelář A").click());
    await act(async () => tab("Týmové").click());
    // The team picker, set to the team it shows.
    const picker = host.querySelector(".zd-panel select") as HTMLSelectElement;
    expect(picker.value).toBe("org_1");
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    store.openSources("tym");
    expect(confirm).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?zdroje=tym");

    // Elsewhere: asked, and refusing keeps everything as it was.
    await act(async () => rail("Kancelář B").click());
    await act(async () => rail("Moje zdroje").click());
    await act(async () => tab("Moje").click());
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(rail("Kancelář A").getAttribute("aria-current")).toBe("true");
    expect(window.location.search).toBe("?zdroje=tym");
  });
});
