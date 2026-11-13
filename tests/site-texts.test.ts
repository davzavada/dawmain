import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setScopeRunner, withScope } from "@/src/files/db/client";
import { setSystemState } from "@/src/files/db/usage";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * The texts an admin edits on /sprava/texty: the Markdown they are written
 * in (src/content/markdown.tsx), the field list with its checks
 * (src/content/texts.ts), the store in system_state (src/content/store.ts,
 * against a real Postgres) and the Server Function that guards it.
 */

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, "data-internal": "", ...rest }, children),
}));
const admin = vi.hoisted(() => ({ id: null as string | null, revalidated: [] as string[] }));
vi.mock("@/src/admin/server", () => ({ requireAdmin: async () => admin.id }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => void admin.revalidated.push(path) }));

const { Markdown, Inline, parseBlocks, safeHref } = await import("@/src/content/markdown");
const { DEFAULT_TEXTS, TEXT_FIELDS, checkText, cleanOverrides, resolveTexts, textField } = await import("@/src/content/texts");
const { SITE_TEXTS_KEY, loadSiteTexts, saveSiteText, siteTexts } = await import("@/src/content/store");
const { saveTextAction } = await import("@/app/sprava/texty/actions");
const { CONTACT } = await import("@/src/content/contact");

const html = (source: string, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(Markdown as never, { source, ...props } as never));

describe("the Markdown of the editable texts", () => {
  it("paragraphs, headings, lists, and a single line break as a line break", () => {
    expect(parseBlocks("první\nřádek\n\n\n## Nadpis\n\n- a\n- b\n  pokračuje\n\nposlední")).toEqual([
      { kind: "paragraph", text: "první\nřádek" },
      { kind: "heading", text: "Nadpis" },
      { kind: "list", items: ["a", "b\npokračuje"] },
      { kind: "paragraph", text: "poslední" },
    ]);
    expect(html("a\nb")).toBe("<p>a<br/>b</p>");
    // A heading with its text right under it, no blank line between.
    expect(parseBlocks("## N\ntext")).toEqual([
      { kind: "heading", text: "N" },
      { kind: "paragraph", text: "text" },
    ]);
  });

  it("bold, italic and links — internal ones through the router", () => {
    expect(html("**tučně** a *kurzíva*, [web](https://uoou.gov.cz), [zásady](/soukromi), [mail](mailto:a@b.cz).")).toBe(
      '<p><strong>tučně</strong> a <em>kurzíva</em>, <a href="https://uoou.gov.cz">web</a>, <a href="/soukromi" data-internal="">zásady</a>, <a href="mailto:a@b.cz">mail</a>.</p>',
    );
  });

  it("sections: every heading opens one, what stands before the first stays outside", () => {
    expect(html("úvod\n\n## A\n\na\n\n## B\n\n- b", { sections: true })).toBe(
      "<p>úvod</p><section><h2>A</h2><p>a</p></section><section><h2>B</h2><ul><li>b</li></ul></section>",
    );
  });

  it("nothing an admin types becomes markup, and a link leads only to http(s), mailto or this site", () => {
    expect(html('<script>alert(1)</script> <img src=x onerror="x">')).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;x&quot;&gt;</p>");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "vbscript:x", " JaVaScRiPt:alert(1)", "mailto:x", "ftp://x.cz"]) {
      expect(safeHref(bad), bad).toBeNull();
      expect(html(`[klik](${bad.trim()})`)).not.toContain("<a");
    }
    expect(safeHref("/#zdroje")).toBe("/#zdroje");
    expect(renderToStaticMarkup(createElement(Inline as never, { text: "a **b" } as never))).toBe("a **b");
  });
});

describe("the fields", () => {
  it("every field has a unique key and a default that passes its own check", () => {
    expect(new Set(TEXT_FIELDS.map((field) => field.key)).size).toBe(TEXT_FIELDS.length);
    for (const field of TEXT_FIELDS) {
      const checked = checkText(field.key, field.default);
      expect(checked, field.key).toMatchObject({ ok: true, text: field.default });
    }
    expect(DEFAULT_TEXTS["legal.terms"]).toContain(`[${CONTACT}](mailto:${CONTACT})`);
    expect(DEFAULT_TEXTS["legal.privacy"].startsWith("## 1. Správce osobních údajů")).toBe(true);
  });

  it("refuses an unknown field, an empty text, another type and a text over the limit", () => {
    expect(checkText("home.nope", "x")).toEqual({ ok: false, error: "Neznámé pole." });
    expect(checkText("home.title", "   ").ok).toBe(false);
    expect(checkText("home.title", 5).ok).toBe(false);
    expect(checkText("home.title", "x".repeat(121)).ok).toBe(false);
    expect(checkText("home.title", " Dva\r\nřádky ")).toMatchObject({ ok: true, text: "Dva řádky" });
    expect(checkText("home.lead", " a\r\n\r\nb ")).toMatchObject({ ok: true, text: "a\n\nb" });
    expect(textField("legal.terms")?.kind).toBe("document");
  });

  it("stored values are reduced to known fields that differ from the default", () => {
    expect(cleanOverrides({ "home.title": "Nový nadpis", "home.owl": DEFAULT_TEXTS["home.owl"], gone: "x", "home.lead": 7 })).toEqual({ "home.title": "Nový nadpis" });
    for (const junk of [null, "text", 3, ["a"]]) expect(cleanOverrides(junk)).toEqual({});
    expect(resolveTexts({ "home.title": "Nový nadpis" })).toEqual({ ...DEFAULT_TEXTS, "home.title": "Nový nadpis" });
  });
});

describe("the store", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    setScopeRunner(null);
    await t.close();
  });
  beforeEach(async () => {
    setScopeRunner(t.runner);
    process.env.FILES_DATABASE_URL = "postgres://app@localhost/files";
    await t.owner.query("DELETE FROM system_state WHERE key = $1", [SITE_TEXTS_KEY]);
    admin.id = null;
    admin.revalidated = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.FILES_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it("nothing stored: the defaults, and the store is available", async () => {
    expect(await loadSiteTexts()).toEqual({ texts: DEFAULT_TEXTS, overrides: {}, available: true });
  });

  it("saves a field, shows it, and removes it when it is saved back to the default or reset", async () => {
    expect(await saveSiteText("home.title", "  Právo s AI  ")).toEqual({ ok: true, overrides: { "home.title": "Právo s AI" } });
    await saveSiteText("sources.ukaz", "Katalog UK.");
    expect((await siteTexts())["home.title"]).toBe("Právo s AI");
    expect((await loadSiteTexts()).overrides).toEqual({ "home.title": "Právo s AI", "sources.ukaz": "Katalog UK." });

    expect(await saveSiteText("home.title", DEFAULT_TEXTS["home.title"])).toEqual({ ok: true, overrides: { "sources.ukaz": "Katalog UK." } });
    expect(await saveSiteText("sources.ukaz", null)).toEqual({ ok: true, overrides: {} });
    expect(await siteTexts()).toEqual(DEFAULT_TEXTS);
  });

  it("refuses what the checks refuse, and stores nothing", async () => {
    expect((await saveSiteText("home.nope", "x")).ok).toBe(false);
    expect((await saveSiteText("home.nope", null)).ok).toBe(false);
    expect((await saveSiteText("home.title", "")).ok).toBe(false);
    expect((await loadSiteTexts()).overrides).toEqual({});
  });

  it("a stored value that is not what was saved does not reach the pages", async () => {
    await withScope([], (db) => setSystemState(db, SITE_TEXTS_KEY, { "home.title": { evil: true }, "home.owl": "Sova.", other: "x" }));
    expect((await loadSiteTexts()).overrides).toEqual({ "home.owl": "Sova." });
    await withScope([], (db) => setSystemState(db, SITE_TEXTS_KEY, "not an object"));
    expect(await siteTexts()).toEqual(DEFAULT_TEXTS);
  });

  it("no database, or one that does not answer: the defaults, never an error — and nothing can be saved", async () => {
    setScopeRunner(() => {
      throw new Error("database unreachable");
    });
    expect(await loadSiteTexts()).toEqual({ texts: DEFAULT_TEXTS, overrides: {}, available: false });
    expect(await saveSiteText("home.title", "x")).toMatchObject({ ok: false });

    setScopeRunner(t.runner);
    delete process.env.FILES_DATABASE_URL;
    expect((await loadSiteTexts()).available).toBe(false);
    expect(await saveSiteText("home.title", "x")).toEqual({ ok: false, error: "Databáze není nastavená, texty tady upravit nejde." });
  });

  it("the Server Function saves for an admin only, and revalidates the pages that show the texts", async () => {
    expect(await saveTextAction("home.title", "Cizí nadpis")).toEqual({ ok: false, error: "Nemáš oprávnění správce." });
    expect((await loadSiteTexts()).overrides).toEqual({});
    expect(admin.revalidated).toEqual([]);

    admin.id = "user_2abcDEF123456789";
    expect(await saveTextAction("home.title", "Náš nadpis")).toEqual({ ok: true, overrides: { "home.title": "Náš nadpis" } });
    expect(admin.revalidated).toEqual(["/", "/podminky", "/soukromi", "/sprava/texty"]);

    admin.revalidated = [];
    expect((await saveTextAction("home.title", 5 as never)).ok).toBe(false);
    expect((await saveTextAction("home.nope", "x")).ok).toBe(false);
    expect(admin.revalidated).toEqual([]);
    expect(await saveTextAction("home.title", null)).toEqual({ ok: true, overrides: {} });
  });
});
