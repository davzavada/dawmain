import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "@/src/sources/shared/errors";
import {
  __resetZoteroClientForTests,
  buildItemsPath,
  downloadPdf,
  getChildren,
  getFulltext,
  getItem,
  getItemsByKeys,
  getKeyInfo,
  libraryPrefix,
  listCollections,
  listGroups,
  listTags,
  parseCollection,
  parseFulltext,
  parseGroup,
  parseItem,
  parseKeyInfo,
  parsePaging,
  revokeKey,
  scanCases,
  searchItems,
} from "@/src/zotero/client";
import { API_ORIGIN, LIMITS, ZOTERO_UA } from "@/src/zotero/config";
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
    expect(parsePaging(headers)).toEqual({ total: 257, nextStart: 100, libraryVersion: 1201 });
  });

  it("has no next page on the last one and tolerates missing headers", () => {
    const last = new Headers({ Link: '<https://api.zotero.org/users/1/items?start=0>; rel="first", <https://www.zotero.org/u/items>; rel="alternate"' });
    expect(parsePaging(last)).toEqual({ total: null, nextStart: null, libraryVersion: null });
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

  it("flags a key that can write in ANY group as write", () => {
    const info = parseKeyInfo(fixture("keys-current-write.json"));
    expect(info.write).toBe(true);
    expect(info.groups).toBe("all");
    const allWrite = parseKeyInfo({ userID: 1, access: { user: { library: true }, groups: { all: { library: true, write: true } } } });
    expect(allWrite.write).toBe(true);
    const userWrite = parseKeyInfo({ userID: 1, access: { user: { library: true, write: true } } });
    expect(userWrite).toMatchObject({ write: true, groups: "none", files: true });
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
    expect(groups).toEqual([
      { id: 111111, name: "Advokátní kancelář – judikatura", numItems: 1234 },
      { id: 222222, name: "Seminář občanské právo", numItems: null },
    ]);
    expect(parseGroup({ id: 5 })).toEqual({ id: 5, name: "Skupina 5", numItems: null });
    expect(() => parseGroup({ data: {} })).toThrow(expect.objectContaining({ kind: "PARSE_DRIFT" }));
  });

  it("parses collections (parentCollection false → null)", () => {
    expect((fixture("collections.json") as unknown[]).map(parseCollection)).toEqual([
      { key: "CLLA2345", name: "Náhrada škody", parentCollection: null, numItems: 17 },
      { key: "CLLB2345", name: "Nemajetková újma", parentCollection: "CLLA2345", numItems: 4 },
    ]);
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
    expect(paging).toEqual({ total: 57, nextStart: 25, libraryVersion: 1201 });
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
    const groups = await listGroups(CREDS);
    expect(groups.map((g) => g.id)).toEqual([111111, 222222]);
    expect(new URL(calls[0].url).pathname).toBe("/users/475425/groups");
    await listGroups(CREDS);
    expect(calls).toHaveLength(2);
    // Another key of the same Zotero user does not see this key's cache.
    await listGroups({ ...CREDS, key: "AnotherKeyOfTheSameUser0" });
    expect(calls).toHaveLength(4);
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
      { tag: "náhrada škody", numItems: 12 },
      { tag: "nemajetková újma", numItems: 0 },
    ]);
    expect(paging.total).toBe(2);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/users/475425/tags");
    expect(url.searchParams.get("q")).toBe("náhr");
    expect(url.searchParams.get("qmode")).toBe("contains");
    expect(url.searchParams.get("limit")).toBe("50");
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
