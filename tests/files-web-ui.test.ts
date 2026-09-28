// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client behaviour of the Vlastní zdroje modal in a DOM (happy-dom): the
 * list's status polling (only while the tab is visible, 4 s → 15 s
 * backoff, stops when nothing is pending, reloads when something settles),
 * the dialog shell (Escape, backdrop, focus return) and the inline
 * confirmation. fetch is a fake; nothing touches Clerk or the network.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useDocumentList } = await import("@/app/_zdroje/list");
const { Dialog, Confirm } = await import("@/app/_zdroje/dialog");

let host: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function listItem(id: string, status: string) {
  return { id, libraryId: "user_a", title: id, fileName: id, fileKind: "pdf", fileBytes: 1, status, statusDetail: null, uploadedAt: "2026-09-01T00:00:00Z", uploaderName: null, mine: true, enabled: true, canEdit: true, canDelete: true, docType: "jine", billablePages: 1, flags: [] };
}

function Probe() {
  const { documents } = useDocumentList("user_a", 0);
  return createElement("output", null, (documents ?? []).map((d) => `${d.id}:${d.status}`).join(","));
}

describe("document list polling", () => {
  it("polls pending documents only while visible, backs off, reloads when one settles, then stops", async () => {
    let status = "processing";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(input.split("?")[0]);
        if (input.startsWith("/api/files/status")) return json({ documents: [{ id: "d1", status, status_detail: null }] });
        return json({ libraryId: "user_a", documents: [listItem("d1", status), listItem("d2", "ready")], total: 2 });
      }),
    );
    await act(async () => root.render(createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(host.textContent).toBe("d1:processing,d2:ready");
    const polls = () => calls.filter((c) => c === "/api/files/status").length;

    await act(async () => vi.advanceTimersByTimeAsync(3_900));
    expect(polls()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(polls()).toBe(1);
    // Backoff: the next poll comes 6 s later, not 4 s.
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(polls()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(polls()).toBe(2);

    // Hidden tab: the due poll is skipped and nothing is rescheduled.
    visibility = "hidden";
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(polls()).toBe(2);
    // Back: one immediate poll — and now the document is done: the list reloads, polling ends.
    status = "review";
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(polls()).toBe(3);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(host.textContent).toBe("d1:review,d2:ready");
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(polls()).toBe(3);
  });

  it("never polls a list without pending documents", async () => {
    const fetchMock = vi.fn(async () => json({ libraryId: "user_a", documents: [listItem("d1", "ready")], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("dialog shell", () => {
  it("Escape and the backdrop close it; focus goes in and returns to the opener", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    await act(async () =>
      root.render(createElement(Dialog, { title: "Vlastní zdroje", subtitle: "Podtitul", onClose, children: createElement("button", null, "uvnitř") })),
    );
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(host.querySelector("h2")?.id);
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => (host.querySelector(".zd-backdrop") as HTMLElement).click());
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => root.render(createElement("div")));
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
    opener.remove();
  });

  it("an open confirmation takes Escape first (cancel, not close)", async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    function WithConfirm() {
      const [open] = useState(true);
      return createElement(Dialog, {
        title: "T",
        onClose,
        children: open ? createElement(Confirm, { question: "Smazat?", confirmLabel: "Smazat", onConfirm: () => undefined, onCancel }) : null,
      });
    }
    await act(async () => root.render(createElement(WithConfirm)));
    expect(document.activeElement?.textContent).toBe("Zrušit");
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
