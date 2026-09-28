// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The sign-in hint (app/_zdroje/hint.ts): the cookie round-trips, anything
 * that is not exactly a hint is ignored, an oversized summary is dropped
 * but the initials stay; and the header renders from it before Clerk
 * loads — the remembered initials and the Pro crown on the server already,
 * the "Přihlásit se" button without a hint — so nothing jumps.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ isLoaded: false, user: undefined }), useOrganizationList: () => ({ userInvitations: undefined }) }));

const { encodeHint, hintCookie, parseHint, HINT_COOKIE } = await import("@/app/_zdroje/hint");
const { HintProvider } = await import("@/app/_zdroje/store");
const { AccountControl } = await import("@/app/_zdroje/account");

const LIB: LibrarySummary = {
  id: "user_a",
  kind: "user",
  name: "Já",
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
  pagesUsed: 12,
  counts: { total: 2, ready: 2, review: 0, processing: 0, error: 0, searchable: 2 },
  memberCount: null,
};
const SUMMARY: SummaryResponse = { state: "ok", mode: "on", termsAccepted: true, libraries: [LIB] };

describe("hint cookie", () => {
  it("round-trips the initials and the summary", () => {
    expect(parseHint(encodeHint({ initials: "DZ", summary: SUMMARY }))).toEqual({ initials: "DZ", summary: SUMMARY });
    expect(parseHint(encodeHint({ initials: "DZ", summary: null }))).toEqual({ initials: "DZ", summary: null });
  });

  it("ignores anything that is not exactly a hint", () => {
    expect(parseHint(undefined)).toBeNull();
    expect(parseHint("")).toBeNull();
    expect(parseHint("%7Bnot json")).toBeNull();
    expect(parseHint(encodeURIComponent(JSON.stringify({ s: SUMMARY })))).toBeNull();
    // A tampered library drops the summary, not the page.
    const bad = { ...SUMMARY, libraries: [{ ...LIB, pro: "yes" }] };
    expect(parseHint(encodeURIComponent(JSON.stringify({ i: "DZ", s: bad })))).toEqual({ initials: "DZ", summary: null });
    // Markup in the initials never survives.
    expect(parseHint(encodeURIComponent(JSON.stringify({ i: "<b>", s: null })))?.initials).toBe("b");
  });

  it("drops a summary too big for a cookie but keeps the initials", () => {
    const many = { ...SUMMARY, libraries: Array.from({ length: 20 }, (_, i) => ({ ...LIB, id: `org_${i}`, kind: "org" as const, name: "Tým ".repeat(40) })) };
    const value = encodeHint({ initials: "DZ", summary: many });
    expect(value.length).toBeLessThanOrEqual(3_000);
    expect(parseHint(value)).toEqual({ initials: "DZ", summary: null });
  });

  it("the cookie string: a month, the whole site, Lax; deletion with Max-Age=0", () => {
    const set = hintCookie({ initials: "DZ", summary: null }, true);
    expect(set).toMatch(new RegExp(`^${HINT_COOKIE}=`));
    expect(set).toContain("Max-Age=2592000; Path=/; SameSite=Lax; Secure");
    expect(hintCookie(null, false)).toBe(`${HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`);
  });
});

describe("header before Clerk loads", () => {
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
  });

  it("the server renders the remembered initials with the Pro crown", () => {
    const html = renderToString(createElement(HintProvider, { children: null, hint: { initials: "DZ", summary: SUMMARY } }, createElement(AccountControl)));
    expect(html).toContain("DZ");
    expect(html).toContain("zd-pro-badge");
    expect(html).toContain("Účet (Pro)");
    expect(html).not.toContain("Přihlásit se");
  });

  it("no crown without Pro; without a hint the visitor's sign-in button", () => {
    const plain = renderToString(
      createElement(HintProvider, { children: null, hint: { initials: "DZ", summary: { ...SUMMARY, libraries: [{ ...LIB, pro: false }] } } }, createElement(AccountControl)),
    );
    expect(plain).toContain("DZ");
    expect(plain).not.toContain("zd-pro-badge");
    expect(renderToString(createElement(HintProvider, { children: null, hint: null }, createElement(AccountControl)))).toContain("Přihlásit se");
  });

  it("hydrates to the same markup (no jump)", async () => {
    const tree = createElement(HintProvider, { children: null, hint: { initials: "DZ", summary: SUMMARY } }, createElement(AccountControl));
    const box = document.createElement("div");
    document.body.appendChild(box);
    box.innerHTML = renderToString(tree);
    const before = box.innerHTML;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hydrateRoot } = await import("react-dom/client");
    let hydrated: Root | null = null;
    await act(async () => {
      hydrated = hydrateRoot(box, tree);
    });
    expect(errors.mock.calls.map((c) => String(c[0]).slice(0, 300))).toEqual([]);
    expect(box.innerHTML).toBe(before);
    await act(async () => hydrated!.unmount());
    box.remove();
  });
});
