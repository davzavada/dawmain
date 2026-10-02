import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "@/src/sources/shared/errors";
import {
  __resetZoteroClientForTests,
  bibliography,
  buildItemsPath,
  buildTagsPath,
  citeItems,
  countFulltext,
  createItem,
  downloadPdf,
  exportItems,
  getChildren,
  getFulltext,
  getItem,
  getItemsByKeys,
  getDeleted,
  getFulltextIndex,
  getKeyInfo,
  getSchemaNames,
  getSettings,
  libraryPrefix,
  listCollections,
  listGroups,
  listSearches,
  listTags,
  newWriteToken,
  parseCollection,
  parseFulltext,
  parseGroup,
  parseItem,
  parseKeyInfo,
  parsePaging,
  parseSavedSearch,
  parseSettings,
  parseTag,
  revokeKey,
  scanCases,
  searchItems,
  tagColorsOf,
  zoteroQuery,
} from "@/src/zotero/client";
import { API_ORIGIN, LIMITS, ZOTERO_UA, isAllowedStorageHost } from "@/src/zotero/config";
import { __resetZoteroHttpForTests } from "@/src/zotero/http";
import { fulltextComplete, type Library, type ZoteroItem } from "@/src/zotero/types";

/**
 * The Zotero API client (src/zotero/client.ts): path builders, parsers and
 * every call the tools make.
 *
 * FIXTURES — tests/fixtures/zotero/*.json are BUILT BY HAND FROM THE
 * DOCUMENTATION (zotero.org/support/dev/web_api/v3: basics, oauth,
 * fulltext_content, file_upload, syncing; the dataserver source), because
 * api.zotero.org is unreachable from the development container. They must
 * be REPLACED BY LIVE CAPTURES (a real key on a Preview deployment, secrets
 * removed) before the parsers are trusted: the exact shape of `groups` in
 * /keys/current, the 403 body, full-text page separators and the storage
 * redirect host are still unverified.
 *
 * fetch is stubbed; nothing leaves the process.
 */

const DIR = path.resolve(import.meta.dirname, "fixtures/zotero");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));

const CREDS = { userID: 475425, key: "SecretKeyValue1234567890" };
const ME: Library = { type: "user", id: 475425 };
const GROUP: Library = { type: "group", id: 111111 };

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(answer: (call: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call, calls.length);
  });
  return calls;
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const headerOf = (call: Call, name: string) => new Headers(call.init.headers).get(name);

/** The item fixtures by key. */
function items(): Record<string, unknown> {
  return Object.fromEntries((fixture("items-search.json") as Array<{ key: string }>).map((x) => [x.key, x]));
}

function parsedItem(key: string): ZoteroItem {
  return parseItem(items()[key]);
}

async function rejection(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p;
  } catch (e) {
    return e as SourceError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  __resetZoteroHttpForTests();
  __resetZoteroClientForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("paths", () => {
  it("prefixes user and group libraries", () => {
    expect(libraryPrefix(ME)).toBe("/users/475425");
    expect(libraryPrefix(GROUP)).toBe("/groups/111111");
    expect(() => libraryPrefix({ type: "user", id: 0 })).toThrow();
  });

  it("builds an items search with every parameter", () => {
    const p = buildItemsPath(ME, {
      top: true,
      q: "  náhrada újmy ",
      qmode: "everything",
      itemTypes: ["case", "statute"],
      tags: ["náhrada škody", "-k přečtení", " "],
      sort: "dateModified",
      direction: "desc",
      limit: 500,
      start: 25,
      since: 1200,
    });
    const url = new URL(p, API_ORIGIN);
    expect(url.pathname).toBe("/users/475425/items/top");
    expect(url.searchParams.get("q")).toBe("náhrada újmy");
    expect(url.searchParams.get("qmode")).toBe("everything");
    expect(url.searchParams.get("itemType")).toBe("case || statute");
    expect(url.searchParams.getAll("tag")).toEqual(["náhrada škody", "-k přečtení"]);
    expect(url.searchParams.get("sort")).toBe("dateModified");
    expect(url.searchParams.get("direction")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe(String(LIMITS.pageSize));
    expect(url.searchParams.get("start")).toBe("25");
    expect(url.searchParams.get("since")).toBe("1200");
    expect(p).not.toMatch(/key=/i);
  });

  it("searches inside a collection and by item keys; omits empty q and qmode without q", () => {
    const url = new URL(buildItemsPath(GROUP, { collection: "CLLA2345", q: " ", qmode: "everything", itemKeys: ["CASE2345", "JART7789"], limit: 10, start: 0 }), API_ORIGIN);
    expect(url.pathname).toBe("/groups/111111/collections/CLLA2345/items");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("qmode")).toBe(false);
    expect(url.searchParams.get("itemKey")).toBe("CASE2345,JART7789");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("negates a whole item-type list and refuses a mixed one", () => {
    const url = new URL(buildItemsPath(ME, { itemTypes: ["-attachment", "-note", "-annotation"], limit: 25, start: 0 }), API_ORIGIN);
    expect(url.searchParams.get("itemType")).toBe("-attachment || note || annotation");
    expect(() => buildItemsPath(ME, { itemTypes: ["case", "-note"], limit: 25, start: 0 })).toThrow(SourceError);
  });

  it("rejects malformed keys and parameters as INPUT_INVALID", () => {
    const bad = [
      { collection: "../../keys", limit: 1, start: 0 },
      { itemKeys: ["abcd2345"], limit: 1, start: 0 },
      { itemKeys: Array.from({ length: LIMITS.maxItemKeys + 1 }, () => "CASE2345"), limit: 1, start: 0 },
      { sort: "title;drop", limit: 1, start: 0 },
      { itemTypes: ["case&key=x"], limit: 1, start: 0 },
      { since: -1, limit: 1, start: 0 },
    ];
    for (const params of bad) {
      let error: unknown;
      try {
        buildItemsPath(ME, params);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(params)).toBeInstanceOf(SourceError);
      expect((error as SourceError).kind).toBe("INPUT_INVALID");
    }
  });
});

describe("parsePaging", () => {
  it("reads Total-Results, the start of rel=next and Last-Modified-Version", () => {
    const headers = new Headers({
      "Total-Results": "257",
      "Last-Modified-Version": "1201",
      Link: '<https://api.zotero.org/users/475425/items?itemKey=CASE2345,JART7789&limit=100&start=100>; rel="next", <https://api.zotero.org/users/475425/items?itemKey=CASE2345,JART7789&limit=100&start=200>; rel="last", <https://www.zotero.org/zuser/items>; rel="alternate"',
    });
    expect(parsePaging(headers)).toEqual({ total: 257, nextStart: 100, libraryVersion: 1201, fulltextReindexing: false });
    expect(parsePaging(new Headers({ "Zotero-Full-Text-Reindexing": "1" })).fulltextReindexing).toBe(true);
  });

  it("has no next page on the last one and tolerates missing headers", () => {
    const last = new Headers({ Link: '<https://api.zotero.org/users/1/items?start=0>; rel="first", <https://www.zotero.org/u/items>; rel="alternate"' });
    expect(parsePaging(last)).toEqual({ total: null, nextStart: null, libraryVersion: null, fulltextReindexing: false });
    expect(parsePaging(new Headers({ "Total-Results": "abc" })).total).toBeNull();
    // A next link without start= is the first page.
    expect(parsePaging(new Headers({ Link: "<https://api.zotero.org/users/1/items?limit=25>; rel=next" })).nextStart).toBe(0);
  });
});

describe("parseKeyInfo", () => {
  it("reads a read-only key with all groups", () => {
    expect(parseKeyInfo(fixture("keys-current.json"))).toEqual({
      userID: 475425,
      username: "zuser",
      displayName: "Z User",
      library: true,
      files: true,
      notes: true,
      write: false,
      userWrite: false,
      groups: "all",
    });
  });

  it("reads per-group access (only groups with library access), a missing files flag as library, no notes", () => {
    const info = parseKeyInfo(fixture("keys-current-groups.json"));
    expect(info.groups).toEqual([111111, 222222]);
    expect(info.files).toBe(true);
    expect(info.notes).toBe(false);
    expect(info.displayName).toBeNull();
    expect(info.write).toBe(false);
  });

  it("flags a key that can write in ANY group as write, and one that can write the personal library as userWrite", () => {
    const info = parseKeyInfo(fixture("keys-current-write.json"));
    expect(info.write).toBe(true);
    // A group's write right is not the personal library's: zotero_save writes only there.
    expect(info.userWrite).toBe(false);
    expect(info.groups).toBe("all");
    const allWrite = parseKeyInfo({ userID: 1, access: { user: { library: true }, groups: { all: { library: true, write: true } } } });
    expect(allWrite.write).toBe(true);
    const userWrite = parseKeyInfo({ userID: 1, access: { user: { library: true, write: true } } });
    expect(userWrite).toMatchObject({ write: true, userWrite: true, groups: "none", files: true });
  });

  it("never returns the key itself", () => {
    expect(JSON.stringify(parseKeyInfo(fixture("keys-current.json")))).not.toContain("P9NiFoyLeZu2bZNvvuQPDWsd");
  });

  it("treats a missing access block as no access and a broken envelope as PARSE_DRIFT", () => {
    expect(parseKeyInfo({ userID: "475425" })).toMatchObject({ userID: 475425, library: false, files: false, write: false, groups: "none" });
    for (const bad of [null, [], "x", { username: "z" }, { userID: -3 }]) {
      expect(() => parseKeyInfo(bad)).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
    }
  });
});

describe("parseGroup / parseCollection / parseFulltext", () => {
  it("parses groups", () => {
    const groups = (fixture("groups.json") as unknown[]).map(parseGroup);
    expect(groups[0]).toEqual({
      id: 111111,
      name: "Advokátní kancelář – judikatura",
      numItems: 1234,
      type: "Private",
      description: "<p>Sdílená judikatura</p>",
      url: null,
      libraryReading: "members",
      libraryEditing: "members",
      fileEditing: "members",
      members: 0,
      admins: 0,
      isAdmin: null,
      created: "2021-03-01T10:00:00Z",
      lastModified: "2026-09-01T08:30:00Z",
    });
    expect(groups[1]).toMatchObject({ id: 222222, name: "Seminář občanské právo", numItems: null, type: "PublicClosed", libraryEditing: "admins" });
    expect(parseGroup({ id: 5 })).toMatchObject({ id: 5, name: "Skupina 5", numItems: null, type: null, members: 0 });
    expect(parseGroup({ id: 5, meta: { isAdmin: true }, data: { members: [1, 2], admins: [3] } })).toMatchObject({ members: 2, admins: 1, isAdmin: true });
    expect(() => parseGroup({ data: {} })).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
  });

  it("parses collections (parentCollection false → null)", () => {
    expect((fixture("collections.json") as unknown[]).map(parseCollection)).toMatchObject([
      { key: "CLLA2345", name: "Náhrada škody", parentCollection: null, numItems: 17, deleted: false },
      { key: "CLLB2345", name: "Nemajetková újma", parentCollection: "CLLA2345", numItems: 4, deleted: false },
    ]);
    // A trashed collection is still listed by Zotero, with data.deleted; meta.numCollections counts its subcollections.
    expect(parseCollection({ key: "CLLC2345", meta: { numCollections: 3 }, data: { name: "Stará", parentCollection: false, deleted: true } })).toMatchObject({
      deleted: true,
      numCollections: 3,
    });
    expect(() => parseCollection({ key: "bad", data: {} })).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
  });

  it("parses complete and partial full texts", () => {
    const full = parseFulltext(fixture("fulltext-pdf.json"));
    expect(full).toMatchObject({ indexedPages: 3, totalPages: 3, indexedChars: null, totalChars: null });
    expect(full.content).toContain("Nejvyšší soud");
    expect(fulltextComplete(full)).toBe(true);
    const partial = parseFulltext(fixture("fulltext-partial.json"));
    expect(partial).toMatchObject({ indexedPages: 100, totalPages: 250 });
    expect(fulltextComplete(partial)).toBe(false);
    const html = parseFulltext({ content: "text", indexedChars: 4, totalChars: 4 });
    expect(fulltextComplete(html)).toBe(true);
    expect(() => parseFulltext({ indexedPages: 1 })).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
  });
});

describe("parseItem", () => {
  it("parses a case: title from caseName, date from dateDecided, a single-field creator", () => {
    const item = parsedItem("CASE2345");
    expect(item).toMatchObject({
      key: "CASE2345",
      version: 1201,
      library: { type: "user", id: 475425 },
      itemType: "case",
      title: "Rozsudek o náhradě nemajetkové újmy",
      parentItem: null,
      creators: [{ creatorType: "author", name: "Nejvyšší soud" }],
      date: "2019-11-26",
      url: "https://nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/1",
      webLink: "https://www.zotero.org/zuser/items/CASE2345",
      tags: ["náhrada škody", "nemajetková újma"],
      collections: ["CLLA2345"],
      meta: { creatorSummary: "Nejvyšší soud", parsedDate: "2019-11-26", numChildren: 0 },
    });
    expect(item.data.docketNumber).toBe("25 Cdo 1234/2019");
  });

  it("parses a journal article: 'Last, First' creators and a half-empty name", () => {
    const item = parsedItem("JART7789");
    expect(item.title).toBe("Náhrada nemajetkové újmy v judikatuře");
    expect(item.creators).toEqual([
      { creatorType: "author", name: "Nováková, Jana" },
      { creatorType: "author", name: "Beran" },
      { creatorType: "editor", name: "Redakce PR" },
    ]);
    expect(item.date).toBe("prosinec 2019");
    expect(item.url).toBeNull();
    expect(item.tags).toEqual([]);
  });

  it("parses an attachment, a note (first line of the stripped HTML) and an annotation", () => {
    const pdf = parsedItem("PDFA2345");
    expect(pdf).toMatchObject({ itemType: "attachment", title: "Full Text PDF", parentItem: "JART7789", creators: [], date: null });
    expect(pdf.data).toMatchObject({ linkMode: "imported_file", contentType: "application/pdf" });
    const note = parsedItem("NTAB3456");
    expect(note).toMatchObject({ itemType: "note", title: "Shrnutí & závěry", parentItem: "JART7789" });
    const annotation = parsedItem("ANNT4567");
    expect(annotation).toMatchObject({ itemType: "annotation", title: "Výše náhrady musí odpovídat okolnostem případu.", parentItem: "PDFA2345" });
  });

  it("cuts a long note title and falls back to the comment of an annotation", () => {
    const long = parseItem({ key: "NTLG2345", data: { itemType: "note", note: `<p>${"slovo ".repeat(60)}</p><p>druhý</p>` } }, ME);
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.title.endsWith("…")).toBe(true);
    const comment = parseItem({ key: "ANCM2345", data: { itemType: "annotation", annotationType: "note", annotationComment: "jen komentář" } }, ME);
    expect(comment.title).toBe("jen komentář");
  });

  it("takes statute titles from nameOfAct and survives missing optional fields", () => {
    const statute = parseItem({ key: "STAT2345", data: { itemType: "statute", nameOfAct: "Občanský zákoník", dateEnacted: "2012-02-03" } }, ME);
    expect(statute).toMatchObject({
      title: "Občanský zákoník",
      date: "2012-02-03",
      version: 0,
      library: ME,
      creators: [],
      tags: [],
      collections: [],
      webLink: null,
      meta: { creatorSummary: null, parsedDate: null, numChildren: null },
    });
    const bare = parseItem({ key: "BARE2345", data: { itemType: "book", creators: [null, { creatorType: "author" }], tags: [{ nope: 1 }], collections: ["bad"] } }, GROUP);
    expect(bare).toMatchObject({ title: "", creators: [], tags: [], collections: [], library: GROUP });
  });

  it("keeps only zotero.org web links", () => {
    const item = parseItem({ key: "LINK2345", links: { alternate: { href: "javascript:alert(1)" } }, data: { itemType: "book" } }, ME);
    expect(item.webLink).toBeNull();
  });

  it("throws PARSE_DRIFT on a broken envelope", () => {
    for (const bad of [null, [], { key: "CASE2345" }, { key: "lower123", data: { itemType: "case" } }, { key: "CASE2345", data: {} }, { key: "CASE2345", data: { itemType: "case" } }]) {
      expect(() => parseItem(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
    }
  });
});

// ---------------------------------------------------------------------------

describe("calls", () => {
  it("getKeyInfo reads /keys/current with the key in the header only", async () => {
    const calls = stubFetch(() => json(fixture("keys-current.json")));
    const info = await getKeyInfo(CREDS.key);
    expect(info.userID).toBe(475425);
    expect(calls[0].url).toBe(`${API_ORIGIN}/keys/current`);
    expect(headerOf(calls[0], "zotero-api-key")).toBe(CREDS.key);
  });

  it("searchItems returns parsed items and the paging headers", async () => {
    const calls = stubFetch(() =>
      json(fixture("items-search.json"), {
        "Total-Results": "57",
        "Last-Modified-Version": "1201",
        Link: '<https://api.zotero.org/users/475425/items?q=n%C3%A1hrada&limit=25&start=25>; rel="next"',
      }),
    );
    const { items: found, paging } = await searchItems(CREDS, ME, { q: "náhrada", limit: 25, start: 0 });
    expect(found.map((i) => i.key)).toEqual(["CASE2345", "JART7789", "PDFA2345", "NTAB3456", "ANNT4567"]);
    expect(paging).toEqual({ total: 57, nextStart: 25, libraryVersion: 1201, fulltextReindexing: false });
    expect(new URL(calls[0].url).pathname).toBe("/users/475425/items");
  });

  it("searchItems: a missing collection is NOT_FOUND, a non-array body PARSE_DRIFT, another user's library INPUT_INVALID", async () => {
    stubFetch(() => new Response("Collection not found", { status: 404 }));
    expect((await rejection(searchItems(CREDS, ME, { collection: "CLLA2345", limit: 25, start: 0 }))).kind).toBe("NOT_FOUND");
    stubFetch(() => json({ not: "an array" }));
    expect((await rejection(searchItems(CREDS, ME, { limit: 25, start: 0 }))).kind).toBe("PARSE_DRIFT");
    const calls = stubFetch(() => json([]));
    expect((await rejection(searchItems(CREDS, { type: "user", id: 1 }, { limit: 25, start: 0 }))).kind).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("searchItems passes a 400 reason on as INPUT_INVALID without long tokens", async () => {
    stubFetch(() => new Response("Invalid 'sort' value 'SecretKeyValue1234567890'", { status: 400 }));
    const e = await rejection(searchItems(CREDS, ME, { sort: "bogus", limit: 25, start: 0 }));
    expect(e.kind).toBe("INPUT_INVALID");
    expect(e.message).toContain("Invalid 'sort' value");
    expect(e.message).not.toContain(CREDS.key);
  });

  it("getItemsByKeys chunks itemKey by LIMITS.maxItemKeys and keeps the order asked", async () => {
    const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const keys = Array.from({ length: 120 }, (_, i) => `ITEM${alphabet[Math.floor(i / 33)]}${alphabet[i % 33]}22`);
    const calls = stubFetch(({ url }) => {
      const asked = new URL(url).searchParams.get("itemKey")!.split(",");
      // Zotero returns them in its own order; one key is missing.
      return json(
        asked
          .filter((k) => k !== keys[7])
          .reverse()
          .map((key) => ({ key, version: 1, library: { type: "user", id: 475425 }, data: { key, itemType: "book", title: key } })),
      );
    });
    const got = await getItemsByKeys(CREDS, ME, [...keys, keys[0]]);
    expect(calls).toHaveLength(3);
    const sizes = calls.map((c) => new URL(c.url).searchParams.get("itemKey")!.split(",").length);
    expect(sizes).toEqual([50, 50, 20]);
    for (const c of calls) expect(Number(new URL(c.url).searchParams.get("limit"))).toBeGreaterThanOrEqual(50);
    expect(got.map((i) => i.key)).toEqual(keys.filter((k) => k !== keys[7]));
    expect(await getItemsByKeys(CREDS, ME, [])).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("getItem and getFulltext return null on 404", async () => {
    stubFetch(() => new Response("Not found", { status: 404 }));
    expect(await getItem(CREDS, ME, "CASE2345")).toBeNull();
    expect(await getFulltext(CREDS, ME, "PDFA2345")).toBeNull();
  });

  it("getItem and getFulltext parse a 200", async () => {
    const calls = stubFetch(({ url }) => (url.endsWith("/fulltext") ? json(fixture("fulltext-partial.json")) : json(items().CASE2345)));
    expect((await getItem(CREDS, GROUP, "CASE2345"))?.title).toBe("Rozsudek o náhradě nemajetkové újmy");
    expect((await getFulltext(CREDS, GROUP, "PDFA2345"))?.totalPages).toBe(250);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/groups/111111/items/CASE2345", "/groups/111111/items/PDFA2345/fulltext"]);
    await expect(getItem(CREDS, ME, "../keys")).rejects.toThrow(SourceError);
  });

  it("getChildren follows rel=next and returns [] for a missing parent", async () => {
    const all = items();
    const calls = stubFetch(({ url }) => {
      const start = new URL(url).searchParams.get("start");
      return start === "0"
        ? json([all.PDFA2345, all.NTAB3456], { Link: '<https://api.zotero.org/users/475425/items/JART7789/children?limit=100&start=100>; rel="next"' })
        : json([all.ANNT4567]);
    });
    const children = await getChildren(CREDS, ME, "JART7789");
    expect(children.map((c) => c.itemType)).toEqual(["attachment", "note", "annotation"]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("start"))).toEqual(["0", "100"]);
    stubFetch(() => new Response("Not found", { status: 404 }));
    expect(await getChildren(CREDS, ME, "JART7789")).toEqual([]);
  });

  it("revokeKey: true on 204; false on 403 (invalid or forbidden) and 404; never throws on those", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    expect(await revokeKey(CREDS)).toBe(true);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(`${API_ORIGIN}/keys/current`);
    stubFetch(() => new Response("Invalid key", { status: 403 }));
    expect(await revokeKey(CREDS)).toBe(false);
    // Zotero already rejected that key: a second revoke never sends it again.
    const again = stubFetch(() => new Response(null, { status: 204 }));
    expect(await revokeKey(CREDS)).toBe(false);
    expect(again).toHaveLength(0);
    __resetZoteroHttpForTests();
    stubFetch(() => new Response("Forbidden", { status: 403 }));
    expect(await revokeKey(CREDS)).toBe(false);
    stubFetch(() => new Response("Not found", { status: 404 }));
    expect(await revokeKey(CREDS)).toBe(false);
    stubFetch(() => new Response("down", { status: 500 }));
    await expect(revokeKey(CREDS)).rejects.toThrow(SourceError);
  });

  it("listGroups reads every page and caches per user and key", async () => {
    const [g1, g2] = fixture("groups.json") as unknown[];
    const calls = stubFetch(({ url }) =>
      new URL(url).searchParams.get("start") === "0"
        ? json([g1], { Link: '<https://api.zotero.org/users/475425/groups?limit=100&start=100>; rel="next"' })
        : json([g2]),
    );
    const groups = await listGroups(CREDS, "all");
    expect(groups.map((g) => g.id)).toEqual([111111, 222222]);
    expect(new URL(calls[0].url).pathname).toBe("/users/475425/groups");
    await listGroups(CREDS, "all");
    expect(calls).toHaveLength(2);
    // Another key of the same Zotero user does not see this key's cache.
    await listGroups({ ...CREDS, key: "AnotherKeyOfTheSameUser0" }, "all");
    expect(calls).toHaveLength(4);
  });

  it("listGroups keeps only the groups a per-group key may read (Zotero also lists public groups it may not)", async () => {
    // The key of keys-current-groups.json reads 111111 and 222222; 333333 is listed without library access.
    const access = parseKeyInfo(fixture("keys-current-groups.json")).groups;
    const listed = [...(fixture("groups.json") as unknown[]), { id: 333333, data: { id: 333333, name: "Veřejná skupina" } }, { id: 444444, data: { id: 444444, name: "Jiná" } }];
    const calls = stubFetch(() => json(listed));
    expect((await listGroups(CREDS, access)).map((g) => g.id)).toEqual([111111, 222222]);
    expect((await listGroups(CREDS, [222222])).map((g) => g.id)).toEqual([222222]);
    expect((await listGroups(CREDS, "all")).map((g) => g.id)).toEqual([111111, 222222, 333333, 444444]);
    expect(calls).toHaveLength(1);
    // A key without group access asks nothing.
    __resetZoteroClientForTests();
    expect(await listGroups(CREDS, "none")).toEqual([]);
    expect(await listGroups(CREDS, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("listCollections reads every page and caches per library", async () => {
    const calls = stubFetch(() => json(fixture("collections.json")));
    expect((await listCollections(CREDS, ME)).map((c) => c.name)).toEqual(["Náhrada škody", "Nemajetková újma"]);
    await listCollections(CREDS, ME);
    expect(calls).toHaveLength(1);
    await listCollections(CREDS, GROUP);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).pathname).toBe("/groups/111111/collections");
  });

  it("listTags filters with contains and reads numItems", async () => {
    const calls = stubFetch(() =>
      json(
        [
          { tag: "náhrada škody", links: {}, meta: { type: 0, numItems: 12 } },
          { tag: "nemajetková újma", links: {}, meta: { type: 1 } },
          { links: {} },
        ],
        { "Total-Results": "2" },
      ),
    );
    const { tags, paging } = await listTags(CREDS, ME, { q: "náhr", limit: 50, start: 0 });
    expect(tags).toEqual([
      { tag: "náhrada škody", type: 0, numItems: 12 },
      { tag: "nemajetková újma", type: 1, numItems: 0 },
    ]);
    expect(paging.total).toBe(2);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/users/475425/tags");
    expect(url.searchParams.get("q")).toBe("náhr");
    expect(url.searchParams.get("qmode")).toBe("contains");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("buildTagsPath: every tag scope and parameter Zotero takes", () => {
    const u = (path: string) => new URL(path, API_ORIGIN);
    const lib = u(buildTagsPath(ME, { q: "OZ", qmode: "startswith", tagType: 0, sort: "numItems", direction: "desc", limit: 20, start: 40 }));
    expect(lib.pathname).toBe("/users/475425/tags");
    expect(Object.fromEntries(lib.searchParams)).toEqual({ q: "OZ", qmode: "startswith", tagType: "0", sort: "numItems", direction: "desc", limit: "20", start: "40" });
    const col = u(buildTagsPath(GROUP, { items: { collection: "CLCL2222", subset: "top" }, limit: 50, start: 0 }));
    expect(col.pathname).toBe("/groups/111111/collections/CLCL2222/items/top/tags");
    const facets = u(buildTagsPath(ME, { items: { q: "škoda", qmode: "everything", itemTypes: ["case"], tag: "OZ" }, limit: 50, start: 0 }));
    expect(facets.pathname).toBe("/users/475425/items/tags");
    expect(facets.searchParams.get("itemQ")).toBe("škoda");
    // The proxy compares the mode exactly: lower-case "everything".
    expect(facets.searchParams.get("itemQMode")).toBe("everything");
    expect(facets.searchParams.get("itemType")).toBe("case");
    expect(facets.searchParams.get("itemTag")).toBe("OZ");
    expect(u(buildTagsPath(ME, { items: { subset: "trash" }, limit: 50, start: 0 })).pathname).toBe("/users/475425/items/trash/tags");
    expect(() => buildTagsPath(ME, { items: { collection: "CLCL2222", subset: "trash" }, limit: 50, start: 0 })).toThrow(SourceError);
    expect(parseTag({ tag: " x ", meta: { type: 1, numItems: 4 } })).toEqual({ tag: "x", type: 1, numItems: 4 });
    expect(parseTag({ meta: {} })).toBeNull();
  });
});

describe("scopes, settings, schema, sync", () => {
  it("buildItemsPath: top, trash, My Publications and includeTrashed", () => {
    expect(buildItemsPath(ME, { trash: true, limit: 25, start: 0 })).toMatch(/^\/users\/475425\/items\/trash\?/);
    expect(buildItemsPath(ME, { publications: true, top: true, limit: 25, start: 0 })).toMatch(/^\/users\/475425\/publications\/items\/top\?/);
    expect(buildItemsPath(ME, { collection: "CLCL2222", top: true, limit: 25, start: 0 })).toMatch(/^\/users\/475425\/collections\/CLCL2222\/items\/top\?/);
    expect(new URL(buildItemsPath(ME, { includeTrashed: true, limit: 25, start: 0 }), API_ORIGIN).searchParams.get("includeTrashed")).toBe("1");
    for (const bad of [
      { trash: true, collection: "CLCL2222" },
      { trash: true, top: true },
      { publications: true, collection: "CLCL2222" },
    ]) {
      expect(() => buildItemsPath(ME, { ...bad, limit: 25, start: 0 })).toThrow(SourceError);
    }
    expect(() => buildItemsPath(GROUP, { publications: true, limit: 25, start: 0 })).toThrow(SourceError);
  });

  it("parseItem: trash flag, automatic tags, the stored file and who added it", () => {
    const item = parseItem({
      key: "ATTA2345",
      version: 3,
      library: { type: "group", id: 111111, name: "AK" },
      links: { enclosure: { type: "application/pdf", href: "https://api.zotero.org/groups/111111/items/ATTA2345/file/view", length: 123456 } },
      meta: { createdByUser: { id: 1, username: "novak" }, lastModifiedByUser: { id: 2, username: "svoboda" } },
      data: { itemType: "attachment", deleted: 1, tags: [{ tag: "OZ" }, { tag: "import", type: 1 }], issueDate: "2020" },
    });
    expect(item.deleted).toBe(true);
    expect(item.automaticTags).toEqual(["import"]);
    expect(item.file).toEqual({ size: 123456, contentType: "application/pdf" });
    expect(item.meta.createdBy).toBe("novak");
    expect(item.meta.lastModifiedBy).toBe("svoboda");
    expect(item.date).toBe("2020");
    const plain = parseItem({ key: "WRKA2345", library: { type: "user", id: 1 }, data: { itemType: "book" } });
    expect(plain.deleted).toBe(false);
    expect(plain.file).toBeNull();
  });

  it("settings: parsed, cached, and the tag colours read in order", async () => {
    const body = {
      tagColors: { value: [{ name: "OZ", color: "#FF6666" }, { name: "bad" }, { name: "Nové", color: "#5FB236" }], version: 7 },
      lastPageIndex_u_ATTA2345: { value: 11, version: 8 },
      junk: 5,
    };
    const calls = stubFetch(() => json(body));
    const settings = await getSettings(CREDS, ME);
    await getSettings(CREDS, ME);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/users/475425/settings");
    expect(settings.lastPageIndex_u_ATTA2345).toEqual({ value: 11, version: 8 });
    expect(settings).not.toHaveProperty("junk");
    expect(tagColorsOf(settings)).toEqual([
      { name: "OZ", color: "#ff6666" },
      { name: "Nové", color: "#5fb236" },
    ]);
    expect(tagColorsOf(parseSettings({}))).toEqual([]);
  });

  it("the schema: localized item types and a type's fields and creator types, cached per request", async () => {
    const calls = stubFetch((call) => {
      const u = new URL(call.url);
      if (u.pathname === "/itemTypes") return json([{ itemType: "case", localized: "Případ" }, { itemType: "" }]);
      if (u.pathname === "/itemTypeFields") return json([{ field: "court", localized: "Soud" }]);
      return json([{ creatorType: "author", localized: "Autor" }]);
    });
    expect(await getSchemaNames(CREDS, { kind: "itemTypes" }, "cs-CZ")).toEqual([{ name: "case", localized: "Případ" }]);
    await getSchemaNames(CREDS, { kind: "itemTypes" }, "cs-CZ");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get("locale")).toBe("cs-CZ");
    expect(await getSchemaNames(CREDS, { kind: "itemTypeFields", itemType: "case" }, "cs-CZ")).toEqual([{ name: "court", localized: "Soud" }]);
    expect(new URL(calls[1].url).searchParams.get("itemType")).toBe("case");
    expect(await getSchemaNames(CREDS, { kind: "itemTypeCreatorTypes", itemType: "case" }, "cs-CZ")).toEqual([{ name: "author", localized: "Autor" }]);
    expect((await rejection(getSchemaNames(CREDS, { kind: "itemTypeFields", itemType: "x&y" }, "cs-CZ"))).kind).toBe("INPUT_INVALID");
  });

  it("deleted, the full-text index status and the full-text count", async () => {
    const calls = stubFetch((call) => {
      const u = new URL(call.url);
      if (u.pathname.endsWith("/deleted")) return json({ collections: ["CLCL2222"], items: ["WRKA2345", 5], searches: [], tags: ["OZ"], settings: [] }, { "Last-Modified-Version": "900" });
      if (u.pathname.endsWith("/fulltext/index")) return json({ status: "reindexing", indexedCount: 10, expectedCount: 40 });
      return json({ ATTA2345: 3, ATTB2345: 4 });
    });
    const { deleted, libraryVersion } = await getDeleted(CREDS, GROUP, 800);
    expect(deleted).toEqual({ collections: ["CLCL2222"], items: ["WRKA2345"], searches: [], tags: ["OZ"], settings: [] });
    expect(libraryVersion).toBe(900);
    expect(new URL(calls[0].url).searchParams.get("since")).toBe("800");
    expect(await getFulltextIndex(CREDS, ME)).toEqual({ status: "reindexing", indexedCount: 10, expectedCount: 40 });
    expect(await countFulltext(CREDS, ME, 0)).toBe(2);
    expect(new URL(calls[2].url).pathname).toBe("/users/475425/fulltext");
    expect((await rejection(getDeleted(CREDS, ME, -1))).kind).toBe("INPUT_INVALID");
  });
});

describe("scanCases", () => {
  const caseJson = (n: number) => ({
    key: `CAS${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[n % 31]}${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(n / 31) % 31]}222`,
    version: 1000 + n,
    library: { type: "user", id: 475425 },
    data: { itemType: "case", caseName: `Věc ${n}`, docketNumber: `25 Cdo ${n}/2019`, court: "Nejvyšší soud", dateDecided: "2019-11-26", extra: "" },
  });

  function library(pages: number, version: number) {
    return ({ url, init }: Call) => {
      const u = new URL(url);
      if (new Headers(init.headers).get("if-modified-since-version") === String(version)) {
        return new Response(null, { status: 304, headers: { "Last-Modified-Version": String(version) } });
      }
      const start = Number(u.searchParams.get("start"));
      const page = start / 100;
      const body = Array.from({ length: 100 }, (_, i) => caseJson(start + i));
      const next = page + 1 < pages ? `<https://api.zotero.org/users/475425/items?itemType=case&limit=100&start=${start + 100}>; rel="next"` : "";
      return json(body, { "Total-Results": String(pages * 100), "Last-Modified-Version": String(version), ...(next ? { Link: next } : {}) });
    };
  }

  it("scans case items newest first, page by page, up to maxPages", async () => {
    const calls = stubFetch(library(4, 1201));
    const scan = await scanCases(CREDS, ME, { maxPages: 2 });
    expect(scan.scannedPages).toBe(2);
    expect(scan.items).toHaveLength(200);
    expect(scan.total).toBe(400);
    expect(scan.libraryVersion).toBe(1201);
    expect(scan.items[5]).toEqual({
      key: scan.items[5].key,
      title: "Věc 5",
      docketNumber: "25 Cdo 5/2019",
      extra: "",
      date: "2019-11-26",
      court: "Nejvyšší soud",
      version: 1005,
    });
    const first = new URL(calls[0].url);
    expect(first.searchParams.get("itemType")).toBe("case");
    expect(first.searchParams.get("sort")).toBe("dateModified");
    expect(first.searchParams.get("direction")).toBe("desc");
    expect(first.searchParams.get("limit")).toBe("100");
    expect(calls).toHaveLength(2);
  });

  it("revalidates a cached scan with If-Modified-Since-Version and reuses it on 304", async () => {
    const calls = stubFetch(library(2, 1201));
    const scan = await scanCases(CREDS, ME, { maxPages: 5 });
    expect(calls).toHaveLength(2);
    const again = await scanCases(CREDS, ME, { maxPages: 5 });
    expect(calls).toHaveLength(3);
    expect(headerOf(calls[2], "if-modified-since-version")).toBe("1201");
    expect(again).toEqual(scan);
    // A smaller request is served from the same scan.
    const one = await scanCases(CREDS, ME, { maxPages: 1 });
    expect(one.scannedPages).toBe(1);
    expect(one.items).toHaveLength(100);
    expect(calls).toHaveLength(4);
  });

  it("rescans when the library changed (200 instead of 304)", async () => {
    stubFetch(library(1, 1201));
    await scanCases(CREDS, ME, { maxPages: 5 });
    const calls = stubFetch(library(2, 1300));
    const scan = await scanCases(CREDS, ME, { maxPages: 5 });
    expect(headerOf(calls[0], "if-modified-since-version")).toBe("1201");
    expect(scan.libraryVersion).toBe(1300);
    expect(scan.items).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  it("does not reuse a scan that read fewer pages than now asked", async () => {
    stubFetch(library(4, 1201));
    await scanCases(CREDS, ME, { maxPages: 1 });
    const calls = stubFetch(library(4, 1201));
    const scan = await scanCases(CREDS, ME, { maxPages: 3 });
    expect(headerOf(calls[0], "if-modified-since-version")).toBeNull();
    expect(scan.scannedPages).toBe(3);
  });
});

describe("citations, exports, saved searches", () => {
  it("citeItems asks for citation and bib in the style and locale, and keeps the order asked", async () => {
    const entry = (key: string) => ({
      key,
      version: 1,
      library: { type: "user", id: 475425 },
      data: { itemType: "book", title: `Kniha ${key}` },
      citation: `<span>${key} cit</span>`,
      bib: `<div class="csl-bib-body"><div class="csl-entry">${key} bib</div></div>`,
    });
    const calls = stubFetch(() => json([entry("BKBK3333"), entry("BKBK2222")]));
    const { items: cited } = await citeItems(CREDS, ME, { keys: ["BKBK2222", "BKBK3333", "BKBK4444"] }, { style: "iso690-full-note-cs", locale: "cs-CZ" });
    expect(cited.map((c) => c.item.key)).toEqual(["BKBK2222", "BKBK3333"]);
    expect(cited[0].citation).toBe("<span>BKBK2222 cit</span>");
    expect(cited[0].bib).toContain("BKBK2222 bib");
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("itemKey")).toBe("BKBK2222,BKBK3333,BKBK4444");
    expect(u.searchParams.get("include")).toBe("data,citation,bib");
    expect(u.searchParams.get("style")).toBe("iso690-full-note-cs");
    expect(u.searchParams.get("locale")).toBe("cs-CZ");
    // Style and locale are validated before any request.
    const before = calls.length;
    expect((await rejection(citeItems(CREDS, ME, { keys: ["BKBK2222"] }, { style: "../evil", locale: "cs-CZ" }))).kind).toBe("INPUT_INVALID");
    expect((await rejection(citeItems(CREDS, ME, { keys: ["BKBK2222"] }, { style: "apa", locale: "cs_CZ&x=1" }))).kind).toBe("INPUT_INVALID");
    // The citation server reads only "xx-XX": a bare language would reach it as garbage.
    expect((await rejection(citeItems(CREDS, ME, { keys: ["BKBK2222"] }, { style: "apa", locale: "cs" }))).kind).toBe("INPUT_INVALID");
    expect(calls.length).toBe(before);
    // An unknown style: Zotero's 400 becomes INPUT_INVALID.
    stubFetch(() => new Response("Invalid style", { status: 400 }));
    expect((await rejection(citeItems(CREDS, ME, { keys: ["BKBK2222"] }, { style: "no-such-style", locale: "cs-CZ" }))).kind).toBe("INPUT_INVALID");
  });

  it("citeItems of a collection reads its top-level items with a limit and returns the total", async () => {
    const calls = stubFetch(() =>
      json([{ key: "BKBK2222", version: 1, library: { type: "user", id: 475425 }, data: { itemType: "book", title: "K" }, citation: "<span>c</span>", bib: null }], { "Total-Results": "40" }),
    );
    const result = await citeItems(CREDS, ME, { collection: "CLCL2222", limit: 10 }, { style: "apa", locale: "en-US" });
    expect(result.total).toBe(40);
    expect(result.items[0].bib).toBeNull();
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/users/475425/collections/CLCL2222/items/top");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("itemKey")).toBeNull();
    // Pages of a collection follow the order the items were added: an edit between two pages moves nothing.
    expect(u.searchParams.get("sort")).toBe("dateAdded");
    expect(u.searchParams.get("direction")).toBe("asc");
  });

  it("bibliography asks for format=bib and returns the entries in the style's order; 413 says to cite fewer", async () => {
    const html = '<?xml version="1.0"?><div class="csl-bib-body"><div class="csl-entry">A <i>Kniha</i></div><div class="csl-entry">B</div></div>';
    const calls = stubFetch(() => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    const { entries, citationList } = await bibliography(CREDS, ME, { collection: "CLCL2222", limit: 150 }, { style: "iso690-numeric-cs", locale: "cs-CZ" });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("<i>Kniha</i>");
    expect(citationList).toBe(false);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/users/475425/collections/CLCL2222/items/top");
    expect(u.searchParams.get("format")).toBe("bib");
    // format=bib takes no limit, start or sort (Zotero answers 400).
    expect(u.searchParams.get("limit")).toBeNull();
    const byKeys = stubFetch(() => new Response(html, { status: 200 }));
    await bibliography(CREDS, ME, { keys: ["BKBK2222"] }, { style: "apa", locale: "en-US" });
    expect(new URL(byKeys[0].url).searchParams.get("itemKey")).toBe("BKBK2222");
    // A style without a bibliography (Bluebook): Zotero sends the citations as <ol><li> — they are the entries.
    stubFetch(() => new Response('<ol>\n\t<li><span style="font-variant:small-caps;">Jane Smith</span>, A</li>\n\t<li>B</li>\n</ol>', { status: 200 }));
    const cites = await bibliography(CREDS, ME, { keys: ["BKBK2222", "BKBK3333"] }, { style: "bluebook-law-review", locale: "en-US" });
    expect(cites.entries).toHaveLength(2);
    expect(cites.entries[0]).toContain("Jane Smith");
    expect(cites.citationList).toBe(true);
    // Nothing at all (an empty csl-bib-body after the XML prolog): no entries.
    stubFetch(() => new Response('<?xml version="1.0"?>\n<div class="csl-bib-body"></div>', { status: 200 }));
    expect(await bibliography(CREDS, ME, { keys: ["BKBK2222"] }, { style: "apa", locale: "en-US" })).toEqual({ entries: [], citationList: false });
    // format=bib takes no start: a collection's start is not sent.
    const noStart = stubFetch(() => new Response(html, { status: 200 }));
    await bibliography(CREDS, ME, { collection: "CLCL2222", limit: 150, start: 25 }, { style: "apa", locale: "en-US" });
    expect(new URL(noStart[0].url).searchParams.get("start")).toBeNull();
    stubFetch(() => new Response("Too many", { status: 413 }));
    const e = await rejection(bibliography(CREDS, ME, { collection: "CLCL2222", limit: 150 }, { style: "apa", locale: "en-US" }));
    expect(e.kind).toBe("INPUT_INVALID");
    expect(e.message).toContain("covers at most 150");
    // More than 100 distinct keys are refused before any request.
    const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const many = Array.from({ length: 101 }, (_, i) => `BKBK22${A[Math.floor(i / 32)]}${A[i % 32]}`);
    const before = stubFetch(() => new Response("x", { status: 200 }));
    const tooMany = await rejection(bibliography(CREDS, ME, { keys: many }, { style: "apa", locale: "en-US" }));
    expect(tooMany.kind).toBe("INPUT_INVALID");
    expect(tooMany.message).toContain("at most 100 item keys");
    expect(before).toHaveLength(0);
  });

  it("exportItems returns Zotero's export text and refuses an unknown format", async () => {
    const calls = stubFetch(() => new Response("TY  - BOOK\nTI  - Kniha\nER  - \n", { status: 200, headers: { "content-type": "application/x-research-info-systems" } }));
    expect((await exportItems(CREDS, GROUP, { keys: ["BKBK2222"] }, "ris")).text).toContain("TY  - BOOK");
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/groups/111111/items");
    expect(u.searchParams.get("format")).toBe("ris");
    expect((await rejection(exportItems(CREDS, GROUP, { keys: ["BKBK2222"] }, "keys" as never))).kind).toBe("INPUT_INVALID");
    expect((await rejection(exportItems(CREDS, GROUP, { keys: [] }, "ris"))).kind).toBe("INPUT_INVALID");
    // Every format of Zotero's own export list passes.
    for (const format of ["mods", "endnote_xml", "refworks_tagged", "rdf_zotero", "tei", "wikipedia", "csv"] as const) {
      stubFetch(() => new Response("x", { status: 200 }));
      await exportItems(CREDS, GROUP, { collection: "CLCL2222", limit: 100 }, format);
    }
  });

  it("parses saved searches, lists them (cached) and reads one", async () => {
    const raw = {
      key: "SRCH2222",
      version: 5,
      data: {
        key: "SRCH2222",
        name: " Náhrada škody ",
        conditions: [
          { condition: "tag", operator: "is", value: "škoda" },
          { condition: "joinMode", operator: "any", value: "all" },
          { condition: "", operator: "is", value: "x" },
          "junk",
        ],
      },
    };
    expect(parseSavedSearch(raw)).toEqual({
      key: "SRCH2222",
      name: "Náhrada škody",
      conditions: [
        { condition: "tag", operator: "is", value: "škoda" },
        { condition: "joinMode", operator: "any", value: "all" },
      ],
      deleted: false,
    });
    expect(parseSavedSearch({ ...raw, data: { ...raw.data, deleted: true } }).deleted).toBe(true);
    expect(() => parseSavedSearch({ data: {} })).toThrow(SourceError);
    const calls = stubFetch(() => json([raw]));
    expect((await listSearches(CREDS, ME)).map((x) => x.key)).toEqual(["SRCH2222"]);
    await listSearches(CREDS, ME);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/users/475425/searches");
  });
});

describe("downloadPdf", () => {
  const S3 = "https://zoteroupload.s3.amazonaws.com/abc123?Signature=sig&Expires=1";
  const pdfBytes = new TextEncoder().encode("%PDF-1.7\n…\n%%EOF");

  function attachment(data: Record<string, unknown>): ZoteroItem {
    return parseItem({ ...(items().PDFA2345 as object), data: { ...(items().PDFA2345 as { data: object }).data, ...data } });
  }

  /** /file on the API redirects to storage; storage serves `storage`. */
  function flow(storage: () => Response, fileHeaders: Record<string, string> = {}): Call[] {
    return stubFetch(({ url }) =>
      url.startsWith(API_ORIGIN) ? new Response(null, { status: 302, headers: { location: S3, ...fileHeaders } }) : storage(),
    );
  }

  it("downloads an imported PDF: the API hop carries the key, the storage hop no Zotero header at all", async () => {
    const calls = flow(() => new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } }));
    const got = await downloadPdf(CREDS, ME, parsedItem("PDFA2345"));
    expect("bytes" in got && new Uint8Array(got.bytes)).toEqual(pdfBytes);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${API_ORIGIN}/users/475425/items/PDFA2345/file`);
    expect(headerOf(calls[0], "zotero-api-key")).toBe(CREDS.key);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[1].url).toBe(S3);
    const storageHeaders = new Headers(calls[1].init.headers);
    expect(storageHeaders.get("zotero-api-key")).toBeNull();
    expect(storageHeaders.get("zotero-api-version")).toBeNull();
    expect(storageHeaders.get("authorization")).toBeNull();
    expect(storageHeaders.get("user-agent")).toBe(ZOTERO_UA);
    expect(JSON.stringify(calls[1].init)).not.toContain(CREDS.key);
    expect(calls[1].init.redirect).toBe("manual");
  });

  it("refuses what is not an imported PDF without any request", async () => {
    const calls = stubFetch(() => new Response(null, { status: 500 }));
    expect(await downloadPdf(CREDS, ME, parsedItem("JART7789"))).toEqual({ unavailable: "not-pdf" });
    expect(await downloadPdf(CREDS, ME, parsedItem("NTAB3456"))).toEqual({ unavailable: "not-pdf" });
    expect(await downloadPdf(CREDS, ME, attachment({ contentType: "text/html" }))).toEqual({ unavailable: "not-pdf" });
    expect(await downloadPdf(CREDS, ME, attachment({ linkMode: "embedded_image", contentType: "image/png" }))).toEqual({ unavailable: "not-pdf" });
    expect(await downloadPdf(CREDS, ME, attachment({ linkMode: "linked_file" }))).toEqual({ unavailable: "linked" });
    expect(await downloadPdf(CREDS, ME, attachment({ linkMode: "linked_url" }))).toEqual({ unavailable: "linked" });
    expect(calls).toHaveLength(0);
  });

  it("imported_url PDFs are downloaded too", async () => {
    flow(() => new Response(pdfBytes, { status: 200 }));
    expect("bytes" in (await downloadPdf(CREDS, ME, attachment({ linkMode: "imported_url" })))).toBe(true);
  });

  it("404 on /file → webdav-or-missing", async () => {
    const calls = stubFetch(() => new Response("Not found", { status: 404 }));
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "webdav-or-missing" });
    expect(calls).toHaveLength(1);
  });

  it("Zotero-File-Compressed: Yes → compressed, without touching storage", async () => {
    const calls = flow(() => new Response(pdfBytes), { "Zotero-File-Compressed": "Yes" });
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "compressed" });
    expect(calls).toHaveLength(1);
  });

  it("a redirect to any other host (or plain http) → storage-host, without following it", async () => {
    for (const location of ["https://evil.example/file.pdf", "http://zoteroupload.s3.amazonaws.com/abc", "https://s3.amazonaws.com.evil.example/x", "/relative/on/api"]) {
      const calls = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
      expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345")), location).toEqual({ unavailable: "storage-host" });
      expect(calls).toHaveLength(1);
    }
  });

  it("the storage allowlist takes every S3 URL style (the host Zotero uses is still unverified) and nothing else", () => {
    const allowed = [
      "s3.amazonaws.com",
      "zoteroupload.s3.amazonaws.com",
      "s3.us-east-1.amazonaws.com",
      "s3-us-west-2.amazonaws.com",
      "zoterofilestorage.s3.us-east-1.amazonaws.com",
      "zoterofilestorage.s3-us-west-2.amazonaws.com",
      "zoterofilestorage.s3.dualstack.us-east-1.amazonaws.com",
      "s3.dualstack.eu-central-1.amazonaws.com",
      "zotero.files.s3.eu-central-1.amazonaws.com",
    ];
    const refused = [
      "evil.example",
      "s3.amazonaws.com.evil.example",
      "zoteroupload.s3.amazonaws.com.evil.example",
      "evils3.amazonaws.com",
      "s3.evil.example",
      "ec2.us-east-1.amazonaws.com",
      "amazonaws.com",
      "s3.us-east-1.amazonaws.com.cn",
      "zotero.org",
      "api.zotero.org",
    ];
    for (const host of allowed) expect(isAllowedStorageHost(new URL(`https://${host}/abc?sig=1`)), host).toBe(true);
    for (const host of refused) expect(isAllowedStorageHost(new URL(`https://${host}/abc?sig=1`)), host).toBe(false);
    expect(isAllowedStorageHost(new URL("http://zoterofilestorage.s3.us-east-1.amazonaws.com/abc"))).toBe(false);
  });

  it("follows a redirect to a regional virtual-hosted S3 URL", async () => {
    const regional = "https://zoterofilestorage.s3.us-east-1.amazonaws.com/abc123?X-Amz-Signature=sig";
    const calls = stubFetch(({ url }) =>
      url.startsWith(API_ORIGIN) ? new Response(null, { status: 302, headers: { location: regional } }) : new Response(pdfBytes, { status: 200 }),
    );
    expect("bytes" in (await downloadPdf(CREDS, ME, parsedItem("PDFA2345")))).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${API_ORIGIN}/users/475425/items/PDFA2345/file`, regional]);
  });

  it("never follows a second redirect from storage", async () => {
    const calls = flow(() => new Response(null, { status: 302, headers: { location: "https://s3.amazonaws.com/other" } }));
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "storage-host" });
    expect(calls).toHaveLength(2);
  });

  it("too-large by Zotero-File-Size, by Content-Length and by counting a streamed body", async () => {
    let calls = flow(() => new Response(pdfBytes), { "Zotero-File-Size": String(LIMITS.maxPdfBytes + 1) });
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "too-large" });
    expect(calls).toHaveLength(1);

    calls = flow(() => new Response(pdfBytes, { status: 200, headers: { "content-length": String(LIMITS.maxPdfBytes + 1) } }));
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "too-large" });
    expect(calls).toHaveLength(2);

    let sent = 0;
    flow(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent > LIMITS.maxPdfBytes) return controller.close();
              sent += 1024 * 1024;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "too-large" });
    expect(sent).toBeLessThanOrEqual(LIMITS.maxPdfBytes + 2 * 1024 * 1024);
  });

  it("storage 404 → webdav-or-missing; storage 403 and network errors are SourceErrors without the signed URL", async () => {
    flow(() => new Response("NoSuchKey", { status: 404 }));
    expect(await downloadPdf(CREDS, ME, parsedItem("PDFA2345"))).toEqual({ unavailable: "webdav-or-missing" });

    flow(() => new Response("AccessDenied", { status: 403 }));
    const denied = await rejection(downloadPdf(CREDS, ME, parsedItem("PDFA2345")));
    expect(denied.kind).toBe("UPSTREAM_ERROR");
    expect(denied.message).not.toContain("Signature");

    stubFetch(({ url }) => {
      if (url.startsWith(API_ORIGIN)) return new Response(null, { status: 302, headers: { location: S3 } });
      throw new TypeError(`connect failed ${S3}`);
    });
    const down = await rejection(downloadPdf(CREDS, ME, parsedItem("PDFA2345")));
    expect(down.kind).toBe("UPSTREAM_UNREACHABLE");
    expect(`${down.message} ${down.hint}`).not.toContain("Signature");
  });

  it("an attachment the key may not download (403) is NOT_ENTITLED", async () => {
    stubFetch(() => new Response("File access denied", { status: 403 }));
    expect((await rejection(downloadPdf(CREDS, ME, parsedItem("PDFA2345")))).kind).toBe("NOT_ENTITLED");
  });
});

// ---------------------------------------------------------------------------
// Search fixes: quotes, parallel pages, loads shared in flight, conditional search pages

describe("the q Zotero is sent", () => {
  const q = (path: string) => new URL(path, API_ORIGIN).searchParams;

  it("title mode takes no quotes (Zotero's title part then finds nothing); everything mode keeps ASCII ones (a phrase in the full text)", () => {
    const title = q(buildItemsPath(ME, { q: '"energetický nápoj"', qmode: "titleCreatorYear", limit: 20, start: 0 }));
    expect(title.get("q")).toBe("energetický nápoj");
    expect(buildItemsPath(ME, { q: '"energetický nápoj"', qmode: "titleCreatorYear", limit: 20, start: 0 })).not.toContain("%22");
    // No qmode is Zotero's default, titleCreatorYear.
    expect(q(buildItemsPath(ME, { q: '"a b" c', limit: 20, start: 0 })).get("q")).toBe("a b c");
    const everything = buildItemsPath(ME, { q: '"energetický nápoj"', qmode: "everything", limit: 20, start: 0 });
    expect(q(everything).get("q")).toBe('"energetický nápoj"');
    expect(everything).toContain("%22");
  });

  it("typographic quotes are no operator anywhere: dropped in both modes", () => {
    expect(zoteroQuery("„Obchodní smlouvy“", "everything")).toBe("Obchodní smlouvy");
    expect(zoteroQuery("„Obchodní  smlouvy“ Dohnal", "titleCreatorYear")).toBe("Obchodní smlouvy Dohnal");
    expect(zoteroQuery('»a« "b c"', "everything")).toBe('a "b c"');
    expect(zoteroQuery("  25 Cdo 1234/2019 ", "titleCreatorYear")).toBe("25 Cdo 1234/2019");
  });

  it("a q of quotes alone is refused — sent without q it would list the whole library", () => {
    for (const bad of ['""', "„“", '" "']) {
      let error: unknown;
      try {
        buildItemsPath(ME, { q: bad, qmode: "titleCreatorYear", limit: 20, start: 0 });
      } catch (e) {
        error = e;
      }
      expect((error as SourceError).kind, bad).toBe("INPUT_INVALID");
    }
  });

  it("a tag listing's items_query follows the same rule", () => {
    const u = (qmode: "titleCreatorYear" | "everything") => q(buildTagsPath(ME, { items: { q: '"náhrada škody"', qmode }, limit: 50, start: 0 }));
    expect(u("titleCreatorYear").get("itemQ")).toBe("náhrada škody");
    expect(u("everything").get("itemQ")).toBe('"náhrada škody"');
  });
});

/** A fetch stub answering after `ms`, counting the requests in flight at once. */
function stubSlowFetch(ms: number, answer: (call: Call) => Response): { calls: Call[]; peak: () => number } {
  const calls: Call[] = [];
  let open = 0;
  let peak = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    open++;
    peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, ms));
    open--;
    return answer(call);
  });
  return { calls, peak: () => peak };
}

const caseRaw = (n: number) => ({
  key: `CAS${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[n % 31]}${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(n / 31) % 31]}222`,
  version: 1000 + n,
  library: { type: "user", id: 475425 },
  data: { itemType: "case", caseName: `Věc ${n}`, docketNumber: `25 Cdo ${n}/2019`, court: "Nejvyšší soud", dateDecided: "2019-11-26", extra: "" },
});

/** The case items of a library of `total` cases at `version`: Total-Results on every page, 304 for the current version. */
function caseLibrary(total: number, version: number, opts: { totalHeader?: boolean } = {}) {
  return ({ url, init }: Call): Response => {
    if (new Headers(init.headers).get("if-modified-since-version") === String(version)) return new Response(null, { status: 304 });
    const start = Number(new URL(url).searchParams.get("start"));
    const body = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => caseRaw(start + i));
    const headers: Record<string, string> = { "Last-Modified-Version": String(version) };
    if (opts.totalHeader !== false) headers["Total-Results"] = String(total);
    if (start + 100 < total) headers.Link = `<https://api.zotero.org/users/475425/items?itemType=case&limit=100&start=${start + 100}>; rel="next"`;
    return json(body, headers);
  };
}

describe("scanCases: pages together, one scan per library in flight", () => {
  it("reads pages 2..k together once page 1 names the total, keeps their order, and says how many pages first", async () => {
    const { calls, peak } = stubSlowFetch(20, caseLibrary(350, 1201));
    const seen: number[] = [];
    const scan = await scanCases(CREDS, ME, { maxPages: 5, onPages: (p) => seen.push(p) });
    expect(calls.map((c) => new URL(c.url).searchParams.get("start"))).toEqual(["0", "100", "200", "300"]);
    expect(peak()).toBeGreaterThanOrEqual(2);
    expect(peak()).toBeLessThanOrEqual(LIMITS.concurrencyPerUser);
    expect(scan.items.map((e) => e.title)).toEqual(Array.from({ length: 350 }, (_, i) => `Věc ${i}`));
    expect(scan).toMatchObject({ scannedPages: 4, total: 350 });
    expect(seen).toEqual([4]);
    // Complete: a repeat with a bigger budget is revalidated, not rescanned.
    const again = await scanCases(CREDS, ME, { maxPages: 10 });
    expect(calls).toHaveLength(5);
    expect(headerOf(calls[4], "if-modified-since-version")).toBe("1201");
    expect(again.items).toHaveLength(350);
  });

  it("follows Link rel=next one page at a time when page 1 has no total", async () => {
    const { calls, peak } = stubSlowFetch(5, caseLibrary(250, 1201, { totalHeader: false }));
    const seen: number[] = [];
    const scan = await scanCases(CREDS, ME, { maxPages: 2, onPages: (p) => seen.push(p) });
    expect(calls).toHaveLength(2);
    expect(peak()).toBe(1);
    expect(scan.items).toHaveLength(200);
    expect(seen).toEqual([2]);
  });

  it("concurrent scans of one library share one set of pages; a smaller one joins a bigger one, not the other way round", async () => {
    const { calls } = stubSlowFetch(20, caseLibrary(350, 1201));
    const [a, b, c] = await Promise.all([scanCases(CREDS, ME, { maxPages: 5 }), scanCases(CREDS, ME, { maxPages: 5 }), scanCases(CREDS, ME, { maxPages: 2 })]);
    expect(calls).toHaveLength(4);
    expect(b).toEqual(a);
    expect(c.scannedPages).toBe(2);
    expect(c.items).toHaveLength(200);
    __resetZoteroClientForTests();
    const bigger = stubSlowFetch(20, caseLibrary(350, 1201));
    await Promise.all([scanCases(CREDS, ME, { maxPages: 1 }), scanCases(CREDS, ME, { maxPages: 3 })]);
    // The one-page scan cannot serve three pages: 1 + 3 requests.
    expect(bigger.calls).toHaveLength(4);
  });

  it("a failure reaches every joined caller and is not kept: the next call scans again", async () => {
    stubSlowFetch(10, () => new Response("down", { status: 500 }));
    const both = await Promise.all([rejection(scanCases(CREDS, ME, { maxPages: 5 })), rejection(scanCases(CREDS, ME, { maxPages: 5 }))]);
    expect(both.every((e) => e instanceof SourceError && e.kind === "UPSTREAM_ERROR")).toBe(true);
    const { calls } = stubSlowFetch(1, caseLibrary(50, 1201));
    expect((await scanCases(CREDS, ME, { maxPages: 5 })).items).toHaveLength(50);
    expect(calls).toHaveLength(1);
  });

  it("one caller giving up does not cut the others off; when all have, the shared requests are cancelled", async () => {
    const aborted: boolean[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(caseLibrary(50, 1201)({ url: String(_url), init })), 40);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted.push(true);
          reject(init.signal?.reason);
        });
      }),
    );
    const quitter = new AbortController();
    const stays = scanCases(CREDS, ME, { maxPages: 5 });
    const leaves = rejection(scanCases(CREDS, ME, { maxPages: 5 }, { signal: quitter.signal }));
    quitter.abort();
    expect(((await leaves) as SourceError).message).toContain("cancelled");
    expect((await stays).items).toHaveLength(50);
    expect(aborted).toHaveLength(0);

    __resetZoteroClientForTests();
    const one = new AbortController();
    const two = new AbortController();
    const first = rejection(scanCases(CREDS, ME, { maxPages: 5 }, { signal: one.signal }));
    const second = rejection(scanCases(CREDS, ME, { maxPages: 5 }, { signal: two.signal }));
    one.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toHaveLength(0);
    two.abort();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(aborted).toHaveLength(1));
  });
});

describe("lists read in full: pages together, one load in flight", () => {
  it("listCollections reads the pages after the first together when Total-Results names them", async () => {
    const col = (n: number) => ({ key: `CL${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[n % 31]}${"23456789ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(n / 31) % 31]}2222`, data: { name: `Sbírka ${n}`, parentCollection: false } });
    const { calls, peak } = stubSlowFetch(20, ({ url }) => {
      const start = Number(new URL(url).searchParams.get("start"));
      return json(Array.from({ length: Math.min(100, 250 - start) }, (_, i) => col(start + i)), { "Total-Results": "250" });
    });
    const cols = await listCollections(CREDS, ME);
    expect(calls.map((c) => new URL(c.url).searchParams.get("start"))).toEqual(["0", "100", "200"]);
    expect(peak()).toBe(2);
    expect(cols.map((c) => c.name)).toEqual(Array.from({ length: 250 }, (_, i) => `Sbírka ${i}`));
  });

  it("concurrent calls share one groups listing, one collections listing, one settings read", async () => {
    const [g1] = fixture("groups.json") as unknown[];
    const { calls } = stubSlowFetch(20, ({ url }) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/groups")) return json([g1]);
      if (path.endsWith("/settings")) return json({ tagColors: { value: [], version: 1 } });
      return json(fixture("collections.json"));
    });
    const groups = await Promise.all([listGroups(CREDS, "all"), listGroups(CREDS, "all"), listGroups(CREDS, [111111])]);
    expect(groups.map((l) => l.map((g) => g.id))).toEqual([[111111], [111111], [111111]]);
    await Promise.all([listCollections(CREDS, ME), listCollections(CREDS, ME), getSettings(CREDS, ME), getSettings(CREDS, ME), listSearches(CREDS, GROUP)]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/users/475425/groups", "/users/475425/collections", "/users/475425/settings", "/groups/111111/searches"]);
    // Another key of the same user shares nothing.
    await listGroups({ ...CREDS, key: "AnotherKeyOfTheSameUser0" }, "all");
    expect(calls).toHaveLength(5);
  });

  it("a shared listing that fails fails every caller, and the next call asks again", async () => {
    stubSlowFetch(10, () => new Response("down", { status: 502 }));
    const both = await Promise.all([rejection(listGroups(CREDS, "all")), rejection(listGroups(CREDS, "all"))]);
    expect(both.every((e) => e instanceof SourceError)).toBe(true);
    const { calls } = stubSlowFetch(1, () => json(fixture("groups.json")));
    expect(await listGroups(CREDS, "all")).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

describe("searchItems: a repeated page is revalidated, not re-run", () => {
  const page = (version: string, extra: Record<string, string> = {}) => json(fixture("items-search.json"), { "Total-Results": "5", "Last-Modified-Version": version, ...extra });

  it("asks again with If-Modified-Since-Version and reuses the page on 304", async () => {
    const calls = stubFetch(({ init }) => (new Headers(init.headers).get("if-modified-since-version") === "1201" ? new Response(null, { status: 304 }) : page("1201")));
    const params = { q: "náhrada", qmode: "everything" as const, limit: 25, start: 0 };
    const first = await searchItems(CREDS, ME, params);
    const again = await searchItems(CREDS, ME, params);
    expect(headerOf(calls[0], "if-modified-since-version")).toBeNull();
    expect(headerOf(calls[1], "if-modified-since-version")).toBe("1201");
    expect(again).toEqual(first);
    // Another page, another library, another key: nothing to revalidate.
    await searchItems(CREDS, ME, { ...params, start: 25 });
    await searchItems(CREDS, GROUP, params);
    await searchItems({ ...CREDS, key: "AnotherKeyOfTheSameUser0" }, ME, params);
    expect(calls.slice(2).map((c) => headerOf(c, "if-modified-since-version"))).toEqual([null, null, null]);
  });

  it("a changed library answers 200: that page is used and kept", async () => {
    let version = "1201";
    const calls = stubFetch(({ init }) => (new Headers(init.headers).get("if-modified-since-version") === version ? new Response(null, { status: 304 }) : page(version)));
    const params = { q: "náhrada", limit: 25, start: 0 };
    await searchItems(CREDS, ME, params);
    version = "1300";
    const changed = await searchItems(CREDS, ME, params);
    expect(changed.paging.libraryVersion).toBe(1300);
    await searchItems(CREDS, ME, params);
    expect(headerOf(calls[2], "if-modified-since-version")).toBe("1300");
  });

  it("keeps no page of an index being rebuilt, none without a version and none too big", async () => {
    const params = { q: "náhrada", qmode: "everything" as const, limit: 25, start: 0 };
    for (const answer of [
      () => page("1201", { "Zotero-Full-Text-Reindexing": "1" }),
      () => json(fixture("items-search.json")),
      () => json([...Array(400)].map(() => items().CASE2345), { "Last-Modified-Version": "1201" }),
    ]) {
      __resetZoteroClientForTests();
      const calls = stubFetch(answer);
      await searchItems(CREDS, ME, params);
      await searchItems(CREDS, ME, params);
      expect(headerOf(calls[1], "if-modified-since-version")).toBeNull();
    }
  });
});

describe("createItem: the one write", () => {
  const DATA = { itemType: "case", caseName: "Rozsudek NS 25 Cdo 1234/2019", court: "Nejvyšší soud" };
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const created = (key = "ABCD2345") =>
    json({
      successful: { "0": { key, version: 12, links: { alternate: { href: `https://www.zotero.org/zuser/items/${key}` } }, data: { key, ...DATA } } },
      success: { "0": key },
      unchanged: {},
      failed: {},
    });

  it("POSTs one item as a JSON array to the personal library under the write token, and returns its key and page", async () => {
    const calls = stubFetch(() => created());
    const result = await createItem(CREDS, DATA, TOKEN);
    expect(result).toEqual({ key: "ABCD2345", version: 12, webLink: "https://www.zotero.org/zuser/items/ABCD2345" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_ORIGIN}/users/475425/items`);
    expect(calls[0].init.method).toBe("POST");
    expect(headerOf(calls[0], "zotero-write-token")).toBe(TOKEN);
    expect(headerOf(calls[0], "content-type")).toBe("application/json");
    expect(headerOf(calls[0], "zotero-api-key")).toBe(CREDS.key);
    expect(JSON.parse(String(calls[0].init.body))).toEqual([DATA]);
    expect(newWriteToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(newWriteToken()).not.toBe(newWriteToken());
  });

  it("only creates: refuses data with a key, version or parent before any request", async () => {
    const calls = stubFetch(() => created());
    for (const bad of [{ ...DATA, key: "ABCD2345" }, { ...DATA, version: 3 }, { ...DATA, parentItem: "ABCD2345" }, { title: "no type" }]) {
      await expect(createItem(CREDS, bad as never, TOKEN)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("retries after a short 429 with the SAME token and body (Zotero applies a token once)", async () => {
    const calls = stubFetch((_c, n) => (n === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : created()));
    await expect(createItem(CREDS, DATA, TOKEN)).resolves.toMatchObject({ key: "ABCD2345" });
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[1], "zotero-write-token")).toBe(TOKEN);
    expect(calls[1].init.body).toBe(calls[0].init.body);
  });

  it("never repeats a POST without a write token, and never sends a malformed one", async () => {
    const { zoteroFetch } = await import("@/src/zotero/http");
    const calls = stubFetch(() => new Response(null, { status: 429, headers: { "retry-after": "0" } }));
    await expect(zoteroFetch(CREDS, "/users/475425/items", { method: "POST", json: [DATA] })).rejects.toThrow(SourceError);
    expect(calls).toHaveLength(1);
    await expect(zoteroFetch(CREDS, "/users/475425/items", { method: "POST", json: [DATA], headers: { "Zotero-Write-Token": "x" } })).rejects.toThrow(/32 hex/);
    await expect(zoteroFetch(CREDS, "/users/475425/items", { method: "GET", json: [DATA] })).rejects.toThrow(/POST/);
  });

  it("412 (the token was used) says the save may have gone through; a failed object names Zotero's reason", async () => {
    stubFetch(() => new Response("Write token already used", { status: 412 }));
    const used = await rejection(createItem(CREDS, DATA, TOKEN));
    expect(used.message).toMatch(/412/);
    expect(used.hint).toMatch(/zotero_search/);

    stubFetch(() => json({ successful: {}, success: {}, unchanged: {}, failed: { "0": { key: null, code: 400, message: "'foo' is not a valid field for type 'case'" } } }));
    const failed = await rejection(createItem(CREDS, DATA, TOKEN));
    expect(failed.kind).toBe("INPUT_INVALID");
    expect(failed.message).toContain("is not a valid field");
  });

  it("a key without write access: 403 is NOT_ENTITLED and says nothing was saved; Invalid key stays ZoteroKeyInvalidError", async () => {
    stubFetch(() => new Response("Write access denied", { status: 403 }));
    const denied = await rejection(createItem(CREDS, DATA, TOKEN));
    expect(denied.kind).toBe("NOT_ENTITLED");
    expect(denied.hint).toContain("Nothing was saved");
    stubFetch(() => new Response("Invalid key", { status: 403 }));
    await expect(createItem(CREDS, DATA, TOKEN)).rejects.toMatchObject({ name: "ZoteroKeyInvalidError" });
  });

  it("an answer without a valid new key is drift; a missing page link is null", async () => {
    stubFetch(() => json({ successful: {}, success: { "0": "not-a-key" }, failed: {} }));
    await expect(createItem(CREDS, DATA, TOKEN)).rejects.toMatchObject({ kind: "PARSE_DRIFT" });
    stubFetch(() => json({ success: { "0": "WXYZ6789" }, failed: {} }));
    await expect(createItem(CREDS, DATA, TOKEN)).resolves.toEqual({ key: "WXYZ6789", version: null, webLink: null });
    stubFetch(() => json({ successful: { "0": { key: "WXYZ6789", version: 3, links: { alternate: { href: "https://evil.example/x" } } } }, failed: {} }));
    await expect(createItem(CREDS, DATA, TOKEN)).resolves.toMatchObject({ webLink: null });
  });
});
