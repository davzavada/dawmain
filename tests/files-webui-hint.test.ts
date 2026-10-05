// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary, SummaryResponse } from "@/src/files/web-types";

/**
 * The sign-in hint (app/_zdroje/hint.ts): the cookie round-trips, anything
 * that is not exactly a hint is ignored, an oversized summary is dropped
 * but the initials stay. The pages are static, so the hint is applied in
 * the browser before the first paint: the inline script marks <html> and
 * hands the texts to CSS, and until Clerk loads the header and the home
 * page group carry both variants — so nothing jumps, and hydration finds
 * exactly the markup it renders.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let clerkUser: unknown = undefined;
vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ isLoaded: clerkUser !== undefined, user: clerkUser }) }));

const { applyHint, encodeHint, filesRowView, hintCookie, hintView, parseHint, readHint, HINT_COOKIE, HINT_SCRIPT } = await import("@/app/_zdroje/hint");
const store = await import("@/app/_zdroje/store");
const { AccountControl } = await import("@/app/_zdroje/account");
const { OwnSourcesGroup } = await import("@/app/_zdroje/own-sources");

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
    // So does a team library or role from before teams were removed (an old cookie).
    for (const lib of [{ ...LIB, id: "org_1", kind: "org" }, { ...LIB, role: "org:admin" }]) {
      expect(parseHint(encodeURIComponent(JSON.stringify({ i: "DZ", s: { ...SUMMARY, libraries: [lib] } })))).toEqual({ initials: "DZ", summary: null });
    }
    // Markup in the initials never survives.
    expect(parseHint(encodeURIComponent(JSON.stringify({ i: "<b>", s: null })))?.initials).toBe("b");
  });

  it("drops a summary too big for a cookie but keeps the initials", () => {
    const many = { ...SUMMARY, libraries: Array.from({ length: 20 }, (_, i) => ({ ...LIB, id: `user_${i}`, name: "Knihovna ".repeat(20) })) };
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

/** A fresh <html> stand-in for applyHint, with the given cookie. */
function fakeDocument(cookie: string): Document {
  const doc = document.implementation.createHTMLDocument("t");
  Object.defineProperty(doc, "cookie", { value: cookie });
  return doc;
}

function cssVar(doc: Document, name: string): string {
  return doc.documentElement.style.getPropertyValue(name);
}

describe("the cookie keeps what the hint shows", () => {
  it("the view: crown with Pro, the files line, the lock without Pro", () => {
    expect(hintView(SUMMARY)).toEqual({ pro: true, files: { desc: "2 dokumenty · 12 stran", locked: false } });
    const noPro = { ...SUMMARY, libraries: [{ ...LIB, pro: false }] };
    expect(hintView(noPro)).toEqual({ pro: false, files: { desc: "Jen v režimu Pro. Přiděluji ho ručně a zdarma.", locked: true } });
    expect(filesRowView(null)).toEqual({ desc: "Načítám…", locked: false });
    expect(filesRowView({ state: "unavailable", mode: "on" })).toEqual({ desc: "Teď dočasně vypnuté.", locked: false });
    const empty = { ...SUMMARY, libraries: [{ ...LIB, counts: { ...LIB.counts!, total: 0 } }] };
    expect(filesRowView(empty).desc).toBe("Zatím žádné dokumenty");
  });

  it("readHint finds it among other cookies", () => {
    const value = encodeHint({ initials: "DZ", summary: SUMMARY });
    expect(readHint(`a=1; ${HINT_COOKIE}=${value}; b=2`)).toEqual({ initials: "DZ", summary: SUMMARY });
    expect(readHint("a=1")).toBeNull();
    expect(readHint(`x${HINT_COOKIE}=${value}`)).toBeNull();
  });
});

describe("before the first paint (applyHint, HINT_SCRIPT)", () => {
  it("marks <html> and hands the initials and the files line to CSS", () => {
    const doc = fakeDocument(`a=1; ${HINT_COOKIE}=${encodeHint({ initials: "DZ", summary: SUMMARY })}`);
    applyHint(doc, HINT_COOKIE);
    const root = doc.documentElement;
    expect(root.getAttribute("data-hint")).toBe("in");
    expect(root.hasAttribute("data-hint-pro")).toBe(true);
    expect(root.hasAttribute("data-hint-files-locked")).toBe(false);
    expect(cssVar(doc, "--hint-initials")).toBe('"DZ"');
    expect(cssVar(doc, "--hint-files")).toBe('"2 dokumenty · 12 stran"');
  });

  it("without Pro: no crown, the lock and its line", () => {
    const doc = fakeDocument(`${HINT_COOKIE}=${encodeHint({ initials: "DZ", summary: { ...SUMMARY, libraries: [{ ...LIB, pro: false }] } })}`);
    applyHint(doc, HINT_COOKIE);
    expect(doc.documentElement.hasAttribute("data-hint-pro")).toBe(false);
    expect(doc.documentElement.hasAttribute("data-hint-files-locked")).toBe(true);
    expect(cssVar(doc, "--hint-files")).toBe('"Jen v režimu Pro. Přiděluji ho ručně a zdarma."');
  });

  it("anything that is not exactly a hint leaves the visitor's page", () => {
    const old = encodeURIComponent(JSON.stringify({ i: "DZ", s: SUMMARY })); // from before `v`
    for (const cookie of ["", "a=1", `${HINT_COOKIE}=%7Bnot json`, `${HINT_COOKIE}=${old}`, `${HINT_COOKIE}=null`]) {
      const doc = fakeDocument(cookie);
      applyHint(doc, HINT_COOKIE);
      expect(doc.documentElement.hasAttribute("data-hint")).toBe(false);
    }
  });

  it("a tampered text stays one CSS string; markup never reaches the initials", () => {
    const evil = encodeURIComponent(JSON.stringify({ i: "<b>", v: { p: false, l: false, f: 'x" ; } body { color: red } a::before { content: "\\' } }));
    const doc = fakeDocument(`${HINT_COOKIE}=${evil}`);
    applyHint(doc, HINT_COOKIE);
    expect(cssVar(doc, "--hint-initials")).toBe('"b"');
    expect(cssVar(doc, "--hint-files")).toBe('"x\\" ; } body { color: red } a::before { content: \\"\\\\"');
  });

  it("the inline script is self-contained and does the same", () => {
    const doc = fakeDocument(`${HINT_COOKIE}=${encodeHint({ initials: "JN", summary: null })}`);
    new Function("document", HINT_SCRIPT)(doc);
    expect(doc.documentElement.getAttribute("data-hint")).toBe("in");
    expect(cssVar(doc, "--hint-initials")).toBe('"JN"');
    expect(cssVar(doc, "--hint-files")).toBe('"Načítám…"');
  });
});

describe("until Clerk loads: both variants, CSS picks", () => {
  afterEach(() => {
    store.setAuth("loading");
    clerkUser = undefined;
    document.cookie = hintCookie(null, false);
    store.rereadHint();
  });

  it("the header: the sign-in button for visitors, the hinted avatar for the signed in", () => {
    const html = renderToString(createElement(AccountControl));
    expect(html).toContain('class="zd-signin zd-hint-out"');
    expect(html).toContain("zd-account zd-hint-in");
    expect(html).toContain("zd-hint-initials");
    expect(html).toContain("zd-pro-badge zd-hint-pro");
  });

  it("the home page group: the locked invitation and the hinted rows", () => {
    const html = renderToString(createElement(OwnSourcesGroup, { zotero: true }));
    expect(html).toContain("source-group locked zd-own zd-hint-out");
    expect(html).toContain("source-group zd-own zd-hint-in");
    expect(html).toContain("zd-hint-files-desc");
    expect(html).toContain("Spravovat");
  });

  it("hydrates over the hinted page without a mismatch", async () => {
    document.cookie = hintCookie({ initials: "DZ", summary: SUMMARY }, false);
    store.rereadHint();
    applyHint(document, HINT_COOKIE);
    const tree = createElement("div", null, createElement(AccountControl), createElement(OwnSourcesGroup, { zotero: true }));
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
    for (const name of ["data-hint", "data-hint-pro", "data-hint-files-locked", "style"]) document.documentElement.removeAttribute(name);
  });
});

describe("once Clerk says signed in, the hint's texts stay until the real ones come", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    document.cookie = hintCookie({ initials: "DZ", summary: SUMMARY }, false);
    store.rereadHint();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    store.setAuth("loading");
    document.cookie = hintCookie(null, false);
    store.rereadHint();
    vi.unstubAllGlobals();
  });

  it("the avatar shows the remembered initials and crown, the row the remembered line", async () => {
    store.setAuth("signed_in");
    await act(async () => root.render(createElement("div", null, createElement(AccountControl), createElement(OwnSourcesGroup, { zotero: false }))));
    const avatar = host.querySelector(".zd-avatar-button")!;
    expect(avatar.textContent).toBe("DZ");
    expect(avatar.querySelector(".zd-pro-badge")).not.toBeNull();
    expect(host.querySelector(".zd-hint-in, .zd-hint-out")).toBeNull();
    expect(host.querySelector(".source-desc")?.textContent).toBe(hintView(SUMMARY).files.desc);
  });
});
