import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/zotero/client", async (importOriginal) => ({
  listGroups: vi.fn(),
  searchItems: vi.fn(),
  getItemsByKeys: vi.fn(),
  getItem: vi.fn(),
  getChildren: vi.fn(),
  getFulltext: vi.fn(),
  listCollections: vi.fn(),
  listTags: vi.fn(),
  scanCases: vi.fn(),
  citeItems: vi.fn(),
  bibliography: vi.fn(),
  exportItems: vi.fn(),
  listSearches: vi.fn(),
  getSettings: vi.fn(),
  getSchemaNames: vi.fn(),
  getDeleted: vi.fn(),
  getFulltextIndex: vi.fn(),
  countFulltext: vi.fn(),
  createItem: vi.fn(),
  newWriteToken: vi.fn(() => "0123456789abcdef0123456789abcdef"),
  // Pure: the real ones.
  tagColorsOf: (await importOriginal<typeof import("@/src/zotero/client")>()).tagColorsOf,
  zoteroQuery: (await importOriginal<typeof import("@/src/zotero/client")>()).zoteroQuery,
  downloadPdf: vi.fn(),
}));
vi.mock("@/src/zotero/store", () => ({ loadConnection: vi.fn(), markRevoked: vi.fn() }));
vi.mock("@/src/zotero/pdf-text", () => ({ pdfText: vi.fn() }));
vi.mock("@/src/zotero/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/zotero/http")>()),
  zoteroBreakerOpen: vi.fn(() => false),
}));

import { __setAccessLoaderForTests } from "@/src/files/access";
import type { Access, LibraryAccess } from "@/src/files/access-types";
import { __resetGuardsForTests, allowToolCall } from "@/src/files/guards";
import { registerPing } from "@/src/mcp/tools/ping";
import { canaries, registerProbe } from "@/src/mcp/tools/probe";
import { READ_ONLY } from "@/src/mcp/tools/shared";
import { ZOTERO_GATE_TEXT, __resetZoteroToolsForTests, registerZotero } from "@/src/mcp/tools/zotero";
import { buildInstructions } from "@/src/mcp/server";
import {
  bibliography,
  citeItems,
  countFulltext,
  downloadPdf,
  exportItems,
  getChildren,
  getDeleted,
  getFulltextIndex,
  getSchemaNames,
  getSettings,
  getFulltext,
  getItem,
  getItemsByKeys,
  listCollections,
  listGroups,
  listSearches,
  listTags,
  scanCases,
  searchItems,
  type CaseScanEntry,
} from "@/src/zotero/client";
import { ITEM_KEY_RE, LIMITS } from "@/src/zotero/config";
import { ZoteroKeyInvalidError, zoteroBreakerOpen } from "@/src/zotero/http";
import { pdfText } from "@/src/zotero/pdf-text";
import { loadConnection, markRevoked } from "@/src/zotero/store";
import type { ConnectionState, Fulltext, Library, ZoteroItem, ZoteroSettings } from "@/src/zotero/types";

/**
 * The rest of Zotero's read API in the tools: scopes (top, trash, My
 * Publications), tag and item-type filters, sort and direction, since,
 * the full-text reindexing warning; get_item's trash flag, reading
 * position, tag colours, annotation colours and EPUB/HTML annotations;
 * zotero_cite's collections, bibliographies and exports; zotero_list's
 * groups, tag scopes, tag colours, schema, deleted and full-text status.
 * The same harness as tests/zotero-tools.test.ts: the real handlers over a
 * mocked client.
 */

// ---------------------------------------------------------------------------
// Fixtures

const USER = "user_zot1";
const ZUSER = 475425;
const CONNECT = "https://dawmain.davidzavada.cz/?zotero=1";

const ENV: Record<string, string> = {
  ZOTERO_OAUTH_CLIENT_KEY: "consumer-key",
  ZOTERO_OAUTH_CLIENT_SECRET: "consumer-secret",
  CREDENTIALS_SECRET: "a-test-secret-that-is-long-enough-1234",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_zotero",
  CLERK_SECRET_KEY: "sk_test_zotero",
};

const PERSONAL_LIB: LibraryAccess = {
  id: USER,
  kind: "user",
  name: "Osobní",
  slug: null,
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
};
const PRO_ACCESS: Access = { userId: USER, banned: false, libraries: [PERSONAL_LIB], all: [PERSONAL_LIB], zotero: true };
const NON_PRO_ACCESS: Access = { userId: USER, banned: false, libraries: [], all: [{ ...PERSONAL_LIB, pro: false, canUpload: false }], zotero: false };
const BANNED_ACCESS: Access = { userId: USER, banned: true, libraries: [], all: [], zotero: false };

const API_KEY = "AbCdEfGhIjKlMnOpQrStUvWx";
function connection(groups: "all" | "none" | number[] = "none", notes = true): ConnectionState {
  return {
    state: "ok",
    conn: { creds: { userID: ZUSER, key: API_KEY }, username: "zuser", notes, groups, connectedAt: "2026-09-01T10:00:00Z", fp: "fp-current", mode: "read" },
  };
}

const PERSONAL: Library = { type: "user", id: ZUSER };

function item(key: string, itemType: string, data: Record<string, unknown> = {}, over: Partial<ZoteroItem> = {}): ZoteroItem {
  const title = (data.title ?? data.caseName ?? data.nameOfAct ?? "") as string;
  return {
    key,
    version: 5,
    library: PERSONAL,
    itemType,
    title,
    parentItem: typeof data.parentItem === "string" ? data.parentItem : null,
    creators: [],
    date: (data.date ?? data.dateDecided ?? null) as string | null,
    url: null,
    webLink: null,
    tags: [],
    collections: [],
    meta: { creatorSummary: null, parsedDate: null, numChildren: null },
    data: { key, itemType, ...data },
    ...over,
  };
}

function page(items: ZoteroItem[], total = items.length) {
  return { items, paging: { total, nextStart: null, libraryVersion: 1 } };
}

function pdfAttachment(key: string, parentItem: string | null, title = "Smlouva.pdf", linkMode = "imported_file"): ZoteroItem {
  return item(key, "attachment", { title, parentItem: parentItem ?? undefined, contentType: "application/pdf", linkMode, filename: title });
}

function fulltext(content: string, indexedPages: number | null, totalPages: number | null): Fulltext {
  return { content, indexedPages, totalPages, indexedChars: null, totalChars: null };
}

// ---------------------------------------------------------------------------
// Harness

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;

const tools: Record<string, { handler: Handler; config: Record<string, unknown> }> = {};
registerZotero({
  registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
    tools[name] = { handler, config };
  },
} as never);

const USER_CTX = { http: { authInfo: { token: "t", clientId: "c", scopes: [], extra: { userId: USER } } } };
const SHARED_CTX = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { method: "token" } } } };

async function call(name: string, args: Record<string, unknown>, ctx: unknown = USER_CTX): Promise<{ text: string; isError: boolean }> {
  const schema = tools[name].config.inputSchema as { parse: (v: unknown) => Record<string, unknown> };
  const result = await tools[name].handler(schema.parse(args), ctx);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

/** The fenced part of an answer, and everything outside it. */
function split(text: string): { inside: string; outside: string } {
  const m = /⟦DOC ([0-9a-f]{8})⟧\n([\s\S]*?)\n⟦\/DOC \1⟧/.exec(text);
  if (!m) throw new Error(`no fence in:\n${text}`);
  return { inside: m[2], outside: text.replace(m[0], "") };
}

/** Every key and library a hint outside the fence echoes is a validated value. */
function expectValidatedHints(outside: string): void {
  for (const m of outside.matchAll(/\bkey: "([^"]*)"/g)) expect(m[1]).toMatch(ITEM_KEY_RE);
  for (const m of outside.matchAll(/\blibrary: "([^"]*)"/g)) expect(m[1]).toMatch(/^(personal|\d+|<id>)$/);
  for (const m of outside.matchAll(/\bcollection: "([^"]*)"/g)) expect(m[1]).toMatch(/^([23456789A-NP-Z]{8}|<key>)$/);
}

const CLIENT_FNS = [
  listGroups,
  searchItems,
  getItemsByKeys,
  getItem,
  getChildren,
  getFulltext,
  listCollections,
  listTags,
  scanCases,
  citeItems,
  bibliography,
  exportItems,
  listSearches,
  getSettings,
  getSchemaNames,
  getDeleted,
  getFulltextIndex,
  countFulltext,
  downloadPdf,
];

function expectNoZoteroRequest(): void {
  for (const fn of CLIENT_FNS) expect(vi.mocked(fn)).not.toHaveBeenCalled();
  expect(vi.mocked(pdfText)).not.toHaveBeenCalled();
}

const loader = vi.fn<(userId: string) => Promise<Access>>();
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  savedEnv.VERCEL_PROJECT_PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  vi.clearAllMocks();
  __resetGuardsForTests();
  __resetZoteroToolsForTests();
  loader.mockReset();
  loader.mockImplementation(async () => PRO_ACCESS);
  __setAccessLoaderForTests(loader);
  vi.mocked(zoteroBreakerOpen).mockReturnValue(false);
  vi.mocked(loadConnection).mockResolvedValue(connection());
  vi.mocked(markRevoked).mockResolvedValue(true);
  vi.mocked(listGroups).mockResolvedValue([]);
  vi.mocked(scanCases).mockResolvedValue({ items: [], scannedPages: 1, total: 0, libraryVersion: 1 });
  vi.mocked(getItemsByKeys).mockResolvedValue([]);
  vi.mocked(getChildren).mockResolvedValue([]);
  vi.mocked(getFulltext).mockResolvedValue(null);
  vi.mocked(getSettings).mockResolvedValue({});
  vi.mocked(searchItems).mockResolvedValue(page([], 0));
  vi.mocked(getSchemaNames).mockResolvedValue([]);
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __setAccessLoaderForTests(null);
});


// ---------------------------------------------------------------------------
// zotero_search: scopes and filters

describe("zotero_search — the rest of Zotero's item parameters", () => {
  const work = item("WRKA2345", "book", { title: "Odpovědnost" });

  it("scope top / trash / publications become Zotero's paths, include_trashed its parameter", async () => {
    vi.mocked(searchItems).mockResolvedValue(page([work], 1));
    await call("zotero_search", { query: "škoda", scope: "top" });
    expect(vi.mocked(searchItems).mock.calls[0][2]).toMatchObject({ top: true, trash: undefined, publications: undefined });
    vi.mocked(searchItems).mockClear();
    const trash = await call("zotero_search", { scope: "trash", include_trashed: true });
    expect(vi.mocked(searchItems).mock.calls[0][2]).toMatchObject({ trash: true, includeTrashed: true });
    expect(trash.text).toContain("in the trash");
    vi.mocked(searchItems).mockClear();
    vi.mocked(loadConnection).mockResolvedValue(connection("all"));
    await call("zotero_search", { query: "škoda", scope: "publications" });
    // My Publications: the personal library only, no fan-out over the groups.
    expect(vi.mocked(searchItems).mock.calls).toHaveLength(1);
    expect(vi.mocked(searchItems).mock.calls[0][1]).toEqual(PERSONAL);
    expect(vi.mocked(searchItems).mock.calls[0][2]).toMatchObject({ publications: true });
    expect(listGroups).not.toHaveBeenCalled();
  });

  it("refuses scope combinations Zotero has no path for, without a request", async () => {
    for (const args of [
      { scope: "trash", collection: "KLCA2345" },
      { scope: "publications", collection: "KLCA2345" },
      { scope: "publications", library: "123" },
      { item_type: ["case"], exclude_item_type: ["note"] },
      { scope: "publications", include_trashed: true },
      { query: "x1", since: 5 },
    ]) {
      const r = await call("zotero_search", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(searchItems).not.toHaveBeenCalled();
  });

  it("tags: AND literally (a leading hyphen escaped), tags_any as one OR, exclude_tags as NOT; || is refused", async () => {
    vi.mocked(searchItems).mockResolvedValue(page([work], 1));
    await call("zotero_search", { query: "škoda", tags: ["OZ", "-pomlčka"], tags_any: ["a", "b"], exclude_tags: ["hotovo", "-x"] });
    expect(vi.mocked(searchItems).mock.calls[0][2].tags).toEqual(["OZ", "\\-pomlčka", "a || b", "-hotovo", "--x"]);
    // Zotero unescapes "\-" only at the start of the whole value: a later OR part is literal as it is.
    vi.mocked(searchItems).mockClear();
    await call("zotero_search", { tags_any: ["-x", "a", "-y"] });
    expect(vi.mocked(searchItems).mock.calls[0][2].tags).toEqual(["\\-x || a || -y"]);
    // A part ending in " ||" goes last (it would merge with the separator); one starting with "\\-" behind the first.
    vi.mocked(searchItems).mockClear();
    await call("zotero_search", { tags_any: ["a ||", "\\-z", "b"] });
    expect(vi.mocked(searchItems).mock.calls[0][2].tags).toEqual(["b || \\-z || a ||"]);
    expect((await call("zotero_search", { tags_any: ["a ||", "b ||"] })).isError).toBe(true);
    expect((await call("zotero_search", { tags_any: ["\\-z"] })).isError).toBe(true);
    expect((await call("zotero_search", { tags: ["\\-z"] })).isError).toBe(true);
    // A negated tag is taken literally after its "-": no escaping, a leading backslash kept.
    vi.mocked(searchItems).mockClear();
    await call("zotero_search", { exclude_tags: ["\\foo"] });
    expect(vi.mocked(searchItems).mock.calls[0][2].tags).toEqual(["-\\foo"]);
    // PHP's \\s is ASCII: "a || b" with no-break spaces is one tag to Zotero.
    vi.mocked(searchItems).mockClear();
    expect((await call("zotero_search", { tags: ["a\u00a0||\u00a0b"] })).isError).toBe(false);
    const r = await call("zotero_search", { tags: ["a || b"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("cannot escape");
    // Zotero splits only on " || " with whitespace around it.
    vi.mocked(searchItems).mockClear();
    expect((await call("zotero_search", { tags: ["a||b"] })).isError).toBe(false);
    expect(vi.mocked(searchItems).mock.calls[0][2].tags).toEqual(["a||b"]);
    const ex = await call("zotero_search", { query: "x1", exclude_tags: ["hotovo"] });
    expect(ex.text).toContain("Zotero then leaves out annotations too");
  });

  it("exclude_item_type negates the list; sort, direction and since pass through and page on", async () => {
    vi.mocked(searchItems).mockResolvedValue(page([work], 30));
    const r = await call("zotero_search", { query: "škoda", library: "personal", exclude_item_type: ["attachment", "note"], sort: "publicationTitle", direction: "asc", since: 1200 });
    expect(vi.mocked(searchItems).mock.calls[0][2]).toMatchObject({ itemTypes: ["-attachment", "-note"], sort: "publicationTitle", direction: "asc", since: 1200 });
    expect(r.text).toContain(
      'More: zotero_search {query: "škoda", library: "personal", exclude_item_type: ["attachment","note"], sort: "publicationTitle", direction: "asc", since: 1200, page: 2}',
    );
    expect(r.text).toContain("modified after library version 1200");
  });

  it("names the library version for since, and warns while Zotero rebuilds the full-text index", async () => {
    vi.mocked(searchItems).mockResolvedValue({ items: [work], paging: { total: 1, nextStart: null, libraryVersion: 4321, fulltextReindexing: true } });
    const r = await call("zotero_search", { query: "škoda", mode: "everything" });
    expect(r.text).toContain("Library version now: personal 4321 — each library has its own.");
    expect(r.text).toContain('zotero_search {library: "<id>", since: <its version>}');
    expect(r.text).toContain("rebuilding the full-text index of library personal");
    expect(r.text).toContain('zotero_list {list: "fulltext", library: "personal"}');
    // In title mode the full-text index plays no part: no warning.
    const title = await call("zotero_search", { query: "škoda" });
    expect(title.text).not.toContain("rebuilding");
  });

  it("a trashed note is named by its own key (zotero_get_item on its work does not list trashed children); trashed parents are found", async () => {
    const book = item("WRKA2345", "book", { title: "Kniha" });
    const note = item("NTEA2345", "note", { parentItem: "WRKA2345", note: "<p>stará poznámka</p>" }, { title: "stará poznámka", deleted: true });
    vi.mocked(searchItems).mockResolvedValue(page([note], 1));
    vi.mocked(getItemsByKeys).mockResolvedValue([book]);
    const r = await call("zotero_search", { query: "stará", scope: "trash" });
    expect(r.text).toContain('the trashed note itself → zotero_get_item {key: "NTEA2345", library: "personal"}');
    expect(vi.mocked(getItemsByKeys).mock.calls[0][4]).toEqual({ includeTrashed: true });
  });

  it("a trashed file of a live work is marked, not the work", async () => {
    const book = item("WRKA2345", "book", { title: "Kniha" });
    const old = item("ATTA2345", "attachment", { title: "old.pdf", parentItem: "WRKA2345", contentType: "application/pdf" }, { deleted: true });
    vi.mocked(searchItems).mockResolvedValue(page([old], 1));
    vi.mocked(getItemsByKeys).mockResolvedValue([book]);
    const r = await call("zotero_search", { query: "old", scope: "trash" });
    const { inside } = split(r.text);
    expect(inside).toContain("1. [book] „Kniha“\n   matched in: attachment „old.pdf“ [v koši]");
  });

  it("a trashed hit is marked, the docket scan stays off in the trash", async () => {
    vi.mocked(searchItems).mockResolvedValue(page([item("WRKA2345", "case", { caseName: "Věc" }, { deleted: true })], 1));
    const r = await call("zotero_search", { query: "25 Cdo 1234/2019", scope: "trash" });
    expect(split(r.text).inside).toContain("[v koši]");
    expect(scanCases).not.toHaveBeenCalled();
  });

  it("every schema item type is accepted", () => {
    const schema = tools.zotero_search.config.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    for (const t of ["patent", "dataset", "podcast", "annotation", "computerProgram", "tvBroadcast"]) {
      expect(schema.safeParse({ item_type: [t] }).success, t).toBe(true);
    }
    expect(schema.safeParse({ sort: "numItems" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// zotero_get_item

describe("zotero_get_item — what else Zotero knows about an item", () => {
  const work = item(
    "WRKA2345",
    "book",
    { title: "Komentář", dateAdded: "2024-05-01T10:00:00Z", dateModified: "2024-06-02T10:00:00Z" },
    { tags: ["OZ", "import"], automaticTags: ["import"], deleted: true, meta: { creatorSummary: null, parsedDate: null, numChildren: 3, createdBy: "novak", lastModifiedBy: "svoboda" } },
  );
  const pdf = item("PDFA2345", "attachment", { title: "Komentář.pdf", parentItem: "WRKA2345", contentType: "application/pdf", linkMode: "imported_file", lastRead: 1758000000 }, { file: { size: 2_500_000, contentType: "application/pdf" } });
  const epub = item("EPBA2345", "attachment", { title: "Kniha.epub", parentItem: "WRKA2345", contentType: "application/epub+zip", linkMode: "imported_file" });
  const docx = item("DCXA2345", "attachment", { title: "Smlouva.docx", parentItem: "WRKA2345", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", linkMode: "imported_file" });
  const link = item("LNKA2345", "attachment", { title: "Odkaz", parentItem: "WRKA2345", contentType: "application/pdf", linkMode: "linked_url" });
  const ann = item("ANNA2345", "annotation", { parentItem: "EPBA2345", annotationType: "highlight", annotationText: "zvýraznění", annotationColor: "#FF6666", annotationAuthorName: "Novák", annotationPageLabel: "3" });

  beforeEach(() => {
    vi.mocked(getItem).mockResolvedValue(work);
    vi.mocked(getChildren).mockImplementation(async (_c, _l, key) => (key === "WRKA2345" ? [pdf, epub, docx, link] : key === "EPBA2345" ? [ann] : []));
    vi.mocked(getSettings).mockResolvedValue({
      tagColors: { value: [{ name: "OZ", color: "#ff6666" }], version: 1 },
      lastPageIndex_u_PDFA2345: { value: 41, version: 2 },
      lastPageIndex_u_EPBA2345: { value: "epubcfi(/6/4)", version: 3 },
    });
    vi.mocked(getSchemaNames).mockResolvedValue([{ name: "book", localized: "Kniha" }]);
  });

  it("shows the trash, who added it, the Czech type, tag colours and automatic tags, reading positions, file sizes", async () => {
    const r = await call("zotero_get_item", { key: "WRKA2345" });
    const { inside, outside } = split(r.text);
    expect(outside).toContain("This item is in the user's Zotero trash.");
    expect(inside).toContain("[v koši]");
    expect(inside).toContain("Item type: Kniha (book)");
    expect(inside).toContain("added by „novak“, last modified by „svoboda“");
    expect(inside).toContain("„OZ“ (coloured tag 1 červená), „import“ (automatic)");
    expect(inside).toContain("„Komentář.pdf“ · application/pdf · file in Zotero Storage · 2,4 MB · last read");
    expect(inside).toContain("left off at PDF page 42");
    expect(inside).toContain("„Kniha.epub“ · application/epub+zip · file in Zotero Storage · a reading position is saved");
    expectValidatedHints(outside);
  });

  it("reads annotations of EPUBs too, with colour and author; never asks /children of a DOCX or a link", async () => {
    const r = await call("zotero_get_item", { key: "WRKA2345" });
    expect(split(r.text).inside).toContain("- s. 3 · highlight · červená · Novák: „zvýraznění“");
    expect(vi.mocked(getChildren).mock.calls.map((c) => c[2])).toEqual(["WRKA2345", "PDFA2345", "EPBA2345"]);
  });

  it("a DOCX attachment opened by its key: no /children call (Zotero answers 400 there), no spurious warning", async () => {
    vi.mocked(getItem).mockResolvedValue(docx);
    const r = await call("zotero_get_item", { key: "DCXA2345" });
    expect(getChildren).not.toHaveBeenCalled();
    expect(r.text).not.toContain("could not be loaded");
  });

  it("reading positions of a group item come from the personal library's settings", async () => {
    vi.mocked(loadConnection).mockResolvedValue(connection([100]));
    const group = { type: "group" as const, id: 100 };
    vi.mocked(getItem).mockResolvedValue({ ...pdf, library: group, parentItem: null, data: { ...pdf.data, parentItem: undefined } });
    vi.mocked(getChildren).mockResolvedValue([]);
    vi.mocked(getSettings).mockImplementation(async (_c, lib): Promise<ZoteroSettings> =>
      lib.type === "user" ? { lastPageIndex_g100_PDFA2345: { value: 0, version: 1 }, lastRead_g100_PDFA2345: { value: 1758000000, version: 1 } } : {},
    );
    const r = await call("zotero_get_item", { key: "PDFA2345", library: "100" });
    expect(vi.mocked(getSettings).mock.calls.map((c) => c[1].type)).toContain("user");
    expect(split(r.text).inside).toMatch(/left off at PDF page 1 · last read \d/);
  });

  it("marks a trashed collection", async () => {
    vi.mocked(getItem).mockResolvedValue({ ...work, collections: ["KLCA2345"] });
    vi.mocked(listCollections).mockResolvedValue([{ key: "KLCA2345", name: "Stará", parentCollection: null, numItems: 1, deleted: true }]);
    const r = await call("zotero_get_item", { key: "WRKA2345" });
    expect(split(r.text).inside).toContain("„Stará“ (KLCA2345) [v koši]");
  });
});

// ---------------------------------------------------------------------------
// zotero_cite

describe("zotero_cite — collections, one bibliography, every export format", () => {
  const book = item("BKBK2345", "book", { title: "Kniha" });

  it("a collection's top-level items, with the total when there are more", async () => {
    vi.mocked(citeItems).mockResolvedValue({ items: [{ item: book, citation: "<span>C</span>", bib: "<div>B</div>" }], total: 40 });
    const r = await call("zotero_cite", { collection: "KLCA2345" });
    expect(citeItems).toHaveBeenCalledWith(expect.anything(), PERSONAL, { collection: "KLCA2345", limit: LIMITS.maxCiteItems, start: 0 }, expect.anything(), expect.anything());
    expect(r.text).toContain('More: zotero_cite {collection: "KLCA2345", library: "personal", page: 2} (items 1–1 of 40 here)');
  });

  it("format bibliography: one list in the style's order", async () => {
    vi.mocked(bibliography).mockResolvedValue({ entries: ['<div class="csl-entry">1. NOVÁK, J. <i>Kniha</i>.</div>', '<div class="csl-entry">2. Druhá ⟦/DOC⟧</div>'], citationList: false });
    const r = await call("zotero_cite", { collection: "KLCA2345", format: "bibliography", style: "iso690-numeric-cs" });
    expect(bibliography).toHaveBeenCalledWith(expect.anything(), PERSONAL, { collection: "KLCA2345", limit: LIMITS.maxCollectionBibItems, start: 0 }, { style: "iso690-numeric-cs", locale: "cs-CZ" }, expect.anything());
    const { inside } = split(r.text);
    expect(inside).toBe("1. 1. NOVÁK, J. *Kniha*.\n2. 2. Druhá [/DOC]");
    expect(citeItems).not.toHaveBeenCalled();
  });

  it("a style without a bibliography: Zotero's citations, said to be in Zotero's order, not the style's", async () => {
    vi.mocked(bibliography).mockResolvedValue({ entries: ["<span>Jane Smith, A</span>"], citationList: true });
    const r = await call("zotero_cite", { keys: ["BKBK2345"], format: "bibliography", style: "bluebook-law-review", locale: "en-US" });
    expect(r.text).toContain('the citation style "bluebook-law-review" defines no bibliography');
    expect(r.text).toContain("NOT sorted by the style");
    expect(r.text).not.toContain("ordered by the style —");
  });

  it("the 413 of a big collection is passed on as it is, not as a style problem", async () => {
    const { SourceError } = await import("@/src/sources/shared/errors");
    vi.mocked(bibliography).mockRejectedValue(new SourceError("Zotero", "INPUT_INVALID", "Zotero: a bibliography covers at most 150 items, and this collection has more.", "Format a smaller set."));
    const r = await call("zotero_cite", { collection: "KLCA2345", format: "bibliography" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("covers at most 150");
    expect(r.text).not.toContain("Is \"");
  });

  it("any of Zotero's export formats; keys or collection, never both or neither; key caps per format", async () => {
    vi.mocked(exportItems).mockResolvedValue({ text: "<mods/>", total: 120 });
    const r = await call("zotero_cite", { collection: "KLCA2345", format: "mods" });
    // The XML formats page by 10 records.
    expect(exportItems).toHaveBeenCalledWith(expect.anything(), PERSONAL, { collection: "KLCA2345", limit: 10, start: 0 }, "mods", expect.anything());
    expect(r.text).toContain("MODS export");
    expect(r.text).toContain("(items 1–10 of 120 here)");
    for (const args of [{}, { keys: ["BKBK2345"], collection: "KLCA2345" }]) {
      expect((await call("zotero_cite", args)).isError).toBe(true);
    }
    const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const keys = Array.from({ length: 30 }, (_, i) => `BKBK22${A[Math.floor(i / 32)]}${A[i % 32]}`);
    const tooMany = await call("zotero_cite", { keys });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain('format: \"bibliography\"'.replace(/\\/g, ""));
  });

  it("a collection export pages by 25 records, with the next page named; a cut export is not offered as a file", async () => {
    vi.mocked(exportItems).mockResolvedValue({ text: "TY  - BOOK\nER  - \n", total: 60 });
    const r = await call("zotero_cite", { collection: "KLCA2345", format: "ris", page: 2 });
    expect(exportItems).toHaveBeenCalledWith(expect.anything(), PERSONAL, { collection: "KLCA2345", limit: 25, start: 25 }, "ris", expect.anything());
    expect(r.text).toContain('More: zotero_cite {collection: "KLCA2345", library: "personal", format: "ris", page: 3} (items 26–50 of 60 here)');
    expect(r.text).toContain("Give it to the user unchanged");
    vi.mocked(exportItems).mockResolvedValue({ text: "x".repeat(60_000), total: 1 });
    const cut = await call("zotero_cite", { keys: ["BKBK2345"], format: "ris" });
    expect(cut.text).toContain("INCOMPLETE");
    expect(cut.text).not.toContain("Give it to the user unchanged");
    // A cut collection page: no "complete page" claim and no next page (its lost records would be skipped);
    // the way on is the page's keys.
    vi.mocked(exportItems).mockResolvedValue({ text: "x".repeat(60_000), total: 60 });
    const cutPage = await call("zotero_cite", { collection: "KLCA2345", format: "ris" });
    expect(cutPage.text).not.toContain("More:");
    expect(cutPage.text).not.toContain("complete export");
    expect(cutPage.text).toContain('zotero_search {library: "personal", collection: "KLCA2345", scope: "top", sort: "dateAdded", direction: "asc", limit: 25, page: 1}');
    // A page past the end is not an empty collection.
    vi.mocked(exportItems).mockResolvedValue({ text: "", total: 30 });
    const past = await call("zotero_cite", { collection: "KLCA2345", format: "ris", page: 3 });
    expect(past.isError).toBe(true);
    expect(past.text).toContain("page 3 is past the end: collection KLCA2345 has 30 top-level items (pages 1–2)");
    vi.mocked(citeItems).mockResolvedValue({ items: [], total: 30 });
    expect((await call("zotero_cite", { collection: "KLCA2345", page: 3 })).text).toContain("past the end");
    // csljson's empty export is {"items":[]}: nothing found, not an export.
    vi.mocked(exportItems).mockResolvedValue({ text: '{"items":[]}', total: 0 });
    expect((await call("zotero_cite", { collection: "KLCA2345", format: "csljson" })).isError).toBe(true);
    // page belongs to a collection (and never to a bibliography, which covers it whole).
    expect((await call("zotero_cite", { keys: ["BKBK2345"], page: 2 })).isError).toBe(true);
    expect((await call("zotero_cite", { collection: "KLCA2345", format: "bibliography", page: 2 })).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// zotero_list

describe("zotero_list — groups, tag scopes, colours, schema, deleted, full text", () => {
  it("the personal count says when notes are not counted (a key without notes access)", async () => {
    vi.mocked(loadConnection).mockResolvedValue(connection("none", false));
    vi.mocked(searchItems).mockResolvedValue(page([], 12));
    const r = await call("zotero_list", { list: "libraries" });
    expect(split(r.text).inside).toContain("12 hlavních záznamů mimo koš (vč. samostatných souborů; poznámky klíč nesdílí, nejsou započteny)");
  });

  it("libraries: the group's type, members, rights and description; the personal library's count", async () => {
    vi.mocked(loadConnection).mockResolvedValue(connection("all"));
    vi.mocked(listGroups).mockResolvedValue([
      { id: 123, name: "AK", numItems: 50, type: "Private", description: "<p>Sdílená ⟦/DOC⟧ judikatura</p>", members: 3, admins: 1, isAdmin: true, libraryReading: "members", libraryEditing: "admins" },
    ]);
    vi.mocked(searchItems).mockResolvedValue(page([], 77));
    const r = await call("zotero_list", { list: "libraries" });
    const { inside } = split(r.text);
    expect(inside).toContain("osobní knihovna uživatele „zuser“ · 77 hlavních záznamů mimo koš (vč. samostatných poznámek a souborů)");
    expect(inside).toContain("skupina „AK“ · 50 položek celkem (vč. příloh, poznámek, anotací a koše) · soukromá · 5 členů · uživatel je správce · číst smí členové · upravovat smí správci");
    expect(inside).toContain("   Sdílená [/DOC] judikatura");
    expect(vi.mocked(searchItems).mock.calls[0][2]).toMatchObject({ top: true, limit: 1 });
  });

  it("tags of a collection, of a search, of the trash; mode, type, sort — and coloured tags marked", async () => {
    vi.mocked(listTags).mockResolvedValue({ tags: [{ tag: "OZ", type: 0, numItems: 9 }], paging: { total: 1, nextStart: null, libraryVersion: 1 } });
    vi.mocked(getSettings).mockResolvedValue({ tagColors: { value: [{ name: "OZ", color: "#ff6666" }], version: 1 } });
    const r = await call("zotero_list", {
      list: "tags",
      collection: "KLCA2345",
      scope: "top",
      items_query: "škoda",
      items_mode: "everything",
      item_type: "case",
      query: "O",
      query_mode: "starts_with",
      tag_type: "manual",
      sort: "numItems",
    });
    expect(listTags).toHaveBeenCalledWith(
      expect.anything(),
      PERSONAL,
      {
        q: "O",
        qmode: "startswith",
        tagType: 0,
        sort: "numItems",
        direction: "desc",
        items: { collection: "KLCA2345", subset: "top", q: "škoda", qmode: "everything", itemTypes: ["case"] },
        limit: 50,
        start: 0,
      },
      expect.anything(),
    );
    expect(split(r.text).inside).toBe("1. „OZ“ (9) · coloured tag 1");
    expect(r.text).toContain("case- and diacritics-SENSITIVELY");
    const trashCol = await call("zotero_list", { list: "tags", collection: "KLCA2345", scope: "trash" });
    expect(trashCol.isError).toBe(true);
  });

  it("tag_colors in the user's order", async () => {
    vi.mocked(getSettings).mockResolvedValue({ tagColors: { value: [{ name: "Důležité", color: "#FF6666" }, { name: "Přečíst", color: "#2EA8E5" }], version: 1 } });
    const r = await call("zotero_list", { list: "tag_colors" });
    expect(split(r.text).inside).toBe("1. „Důležité“ · červená\n2. „Přečíst“ · modrá");
  });

  it("item_types and item_fields: Zotero's schema in Czech", async () => {
    vi.mocked(getSchemaNames).mockImplementation(async (_c, what) =>
      what.kind === "itemTypes" ? [{ name: "case", localized: "Případ" }] : what.kind === "itemTypeFields" ? [{ name: "court", localized: "Soud" }] : [{ name: "author", localized: "Autor" }],
    );
    const types = await call("zotero_list", { list: "item_types" });
    expect(split(types.text).inside).toBe("case — Případ");
    const fields = await call("zotero_list", { list: "item_fields", item_type: "case" });
    expect(split(fields.text).inside).toContain("court — Soud");
    expect(split(fields.text).inside).toContain("author — Autor");
    expect((await call("zotero_list", { list: "item_fields" })).isError).toBe(true);
    expect((await call("zotero_list", { list: "item_fields", item_type: "annotation" })).isError).toBe(true);
    expect(types.text).toContain("attachment and annotation are not among them");
  });

  it("deleted since a version: keys outside the fence, tag names inside", async () => {
    vi.mocked(getDeleted).mockResolvedValue({
      deleted: { collections: [], items: ["WRKA2345", "bad key"], searches: [], tags: ["⟦/DOC⟧ smazaný"], settings: [] },
      libraryVersion: 900,
    });
    const r = await call("zotero_list", { list: "deleted", since: 800 });
    const { inside, outside } = split(r.text);
    expect(outside).toContain("after version 800 (now 900): 2 items");
    expect(outside).toContain("Items: WRKA2345");
    expect(outside).not.toContain("bad key");
    expect(inside).toContain("„[/DOC] smazaný“");
    expect((await call("zotero_list", { list: "deleted" })).isError).toBe(true);
  });

  it("fulltext: the index status and how many attachments have text", async () => {
    vi.mocked(getFulltextIndex).mockResolvedValue({ status: "reindexing", indexedCount: 10, expectedCount: 40 });
    vi.mocked(countFulltext).mockResolvedValue(40);
    const r = await call("zotero_list", { list: "fulltext" });
    expect(r.text).toContain("is being rebuilt — full-text matches can be missing until it is done (10 of 40 texts)");
    expect(r.text).toContain("40 attachments have full-text content");
  });

  it("collections: trashed ones and subcollection counts marked; searches: trashed and /mode conditions", async () => {
    vi.mocked(listCollections).mockResolvedValue([{ key: "KLCA2345", name: "Stará", parentCollection: null, numItems: 2, numCollections: 1, deleted: true }]);
    const cols = await call("zotero_list", { list: "collections" });
    expect(split(cols.text).inside).toBe("1. „Stará“ (2, 1 sub) [v koši]");
    vi.mocked(listSearches).mockResolvedValue([{ key: "SRCH2345", name: "Hledání", deleted: true, conditions: [{ condition: "fulltextContent/regexp", operator: "contains", value: "x" }] }]);
    const searches = await call("zotero_list", { list: "searches" });
    expect(split(searches.text).inside).toBe("1. „Hledání“ [v koši] — fulltextContent/regexp contains „x“");
  });
});
