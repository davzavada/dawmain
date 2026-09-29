import "server-only";
import { createHash } from "node:crypto";
import { TtlCache } from "@/src/sources/shared/cache";
import { SourceError } from "@/src/sources/shared/errors";
import { htmlToText } from "@/src/sources/shared/html";
import { API_ORIGIN, CACHE_TTL_MS, EXPORT_FORMATS, ITEM_KEY_RE, LIMITS, LOCALE_RE, SOURCE, STYLE_RE, ZOTERO_UA, isAllowedStorageHost, type ExportFormat } from "./config";
import { ZoteroBodyTooLargeError, ZoteroKeyInvalidError, readBody, zoteroFetch, type ZoteroResponse } from "./http";
import type {
  Fulltext,
  KeyInfo,
  Library,
  Paging,
  SavedSearch,
  SavedSearchCondition,
  ZoteroCollection,
  ZoteroCreator,
  ZoteroCreds,
  ZoteroGroup,
  ZoteroItem,
} from "./types";

/**
 * The Zotero Web API v3, read-only: pure path builders and parsers first,
 * then the calls (all through zoteroFetch, ./http.ts). The parsers turn the
 * API's JSON into the shapes of ./types.ts and are the only code that knows
 * the raw objects: a broken envelope (no key, no data, not an array) is
 * PARSE_DRIFT, a missing optional field is simply absent.
 *
 * Caches (per instance, TtlCache): groups, collections, saved searches and the case scan —
 * never searches. Every cache key carries the Zotero user id AND a hash of
 * the key, because two Dawmain accounts can connect the same Zotero user
 * with keys of different reach.
 */

export interface IoOptions {
  /** The tool call's budget; aborting it cancels the request. */
  signal?: AbortSignal;
}

/** Query of /items (or /collections/{key}/items). Zotero caps `limit` at 100 and `itemKey` at 50. */
export interface ItemsQuery {
  /** /items/top: top-level items only (no child attachments, notes or annotations). */
  top?: boolean;
  q?: string;
  qmode?: "titleCreatorYear" | "everything";
  /**
   * Item types, OR-ed ("case", "statute"); a leading "-" excludes. Zotero
   * negates the whole list or nothing, so all entries must be positive or
   * all negative ("-attachment", "-note").
   */
  itemTypes?: string[];
  /** Each entry is its own `tag` parameter (AND); inside one, " || " is OR and a leading "-" is NOT. */
  tags?: string[];
  /** A collection key: search inside that collection only. */
  collection?: string;
  itemKeys?: string[];
  sort?: string;
  direction?: "asc" | "desc";
  limit: number;
  start: number;
  /** Only objects modified after this library version. */
  since?: number;
}

/** A case item as the docket-number scan needs it (Zotero's q does not search docketNumber). */
export interface CaseScanEntry {
  key: string;
  title: string;
  docketNumber: string;
  extra: string;
  date: string | null;
  court: string;
  version: number;
}

export interface CaseScan {
  items: CaseScanEntry[];
  /** Pages of 100 read (or reused). */
  scannedPages: number;
  /** Total-Results: how many case items the library has. */
  total: number | null;
  libraryVersion: number | null;
}

/** One item formatted by Zotero's citation server (HTML, as Zotero sends it). */
export interface CitedItem {
  item: ZoteroItem;
  citation: string | null;
  bib: string | null;
}

export type PdfUnavailable = "not-pdf" | "linked" | "webdav-or-missing" | "compressed" | "too-large" | "storage-host";
export type PdfDownload = { bytes: ArrayBuffer } | { unavailable: PdfUnavailable };

const JSON_HINT = "Try again later; if it keeps failing, the Zotero API changed and src/zotero/client.ts needs updating.";
/** Paging caps for the "all pages" reads (100 per page). */
const MAX_GROUP_PAGES = 10;
const MAX_COLLECTION_PAGES = 20;
const MAX_CHILD_PAGES = 5;
/** Zotero's own note titles are the note's first line, cut at 120 characters. */
const NOTE_TITLE_CHARS = 120;
/** Notes are HTML; the title needs only its start, not a parse of a 100 kB note. */
const NOTE_TITLE_HTML = 4_000;
const MAX_SEARCH_PAGES = 5;
const TITLE_FIELDS = ["title", "caseName", "nameOfAct", "subject"] as const;
const DATE_FIELDS = ["date", "dateDecided", "dateEnacted"] as const;

// ---------------------------------------------------------------------------
// Pure: paths

/** "/users/475425" or "/groups/123". */
export function libraryPrefix(lib: Library): string {
  if (!Number.isSafeInteger(lib.id) || lib.id <= 0) throw new Error("A Zotero library id is a positive integer.");
  return lib.type === "user" ? `/users/${lib.id}` : `/groups/${lib.id}`;
}

/** Path + query of an items search; the key is never part of it. Invalid input is INPUT_INVALID. */
export function buildItemsPath(lib: Library, p: ItemsQuery): string {
  const collection = p.collection !== undefined ? objectKey(p.collection, "collection") : null;
  const base = `${libraryPrefix(lib)}${collection ? `/collections/${collection}` : ""}/items${p.top ? "/top" : ""}`;
  const qs = new URLSearchParams();
  const q = p.q?.trim();
  if (q) {
    qs.set("q", q);
    if (p.qmode) qs.set("qmode", p.qmode);
  }
  if (p.itemTypes?.length) qs.set("itemType", itemTypeParam(p.itemTypes));
  for (const tag of p.tags ?? []) {
    const t = tag.trim();
    if (t) qs.append("tag", t);
  }
  if (p.itemKeys?.length) {
    if (p.itemKeys.length > LIMITS.maxItemKeys) throw invalid(`at most ${LIMITS.maxItemKeys} item keys per request`);
    qs.set("itemKey", p.itemKeys.map((k) => objectKey(k, "item")).join(","));
  }
  if (p.sort) {
    if (!/^[A-Za-z]{1,40}$/.test(p.sort)) throw invalid(`unknown sort "${p.sort.slice(0, 40)}"`);
    qs.set("sort", p.sort);
  }
  if (p.direction) qs.set("direction", p.direction === "asc" ? "asc" : "desc");
  if (p.since !== undefined) {
    if (!Number.isSafeInteger(p.since) || p.since < 0) throw invalid("`since` is a library version (a non-negative integer)");
    qs.set("since", String(p.since));
  }
  qs.set("limit", String(clampInt(p.limit, 1, LIMITS.pageSize)));
  qs.set("start", String(clampInt(p.start, 0, Number.MAX_SAFE_INTEGER)));
  return `${base}?${qs.toString()}`;
}

/** Zotero's itemType parameter: "a || b" or "-a || b" (the "-" negates the whole list). */
function itemTypeParam(types: string[]): string {
  const cleaned = types.map((t) => t.trim()).filter(Boolean);
  for (const t of cleaned) if (!/^-?[A-Za-z]{1,40}$/.test(t)) throw invalid(`unknown item type "${t.slice(0, 40)}"`);
  const negative = cleaned.filter((t) => t.startsWith("-"));
  if (negative.length && negative.length !== cleaned.length) {
    throw invalid("item types must all be included or all excluded (Zotero negates the whole list)");
  }
  const names = cleaned.map((t) => t.replace(/^-/, ""));
  return `${negative.length ? "-" : ""}${names.join(" || ")}`;
}

// ---------------------------------------------------------------------------
// Pure: parsers

/** Total-Results, the `start` of Link rel="next", Last-Modified-Version. */
export function parsePaging(headers: Headers): Paging {
  return {
    total: headerInt(headers.get("total-results")),
    nextStart: nextStart(headers.get("link")),
    libraryVersion: headerInt(headers.get("last-modified-version")),
  };
}

function nextStart(link: string | null): number | null {
  if (!link) return null;
  // `<url>; rel="next", <url>; rel="last"` — split on the angle brackets,
  // not on commas: an itemKey list inside a URL has commas of its own.
  for (const m of link.matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(m[2])?.[1];
    if (!rel || !rel.toLowerCase().split(/\s+/).includes("next")) continue;
    try {
      const start = new URL(m[1], API_ORIGIN).searchParams.get("start");
      return start !== null && /^\d{1,15}$/.test(start) ? Number(start) : 0;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * GET /keys/current → KeyInfo. `write` is true when the key can write
 * ANYWHERE (the personal library, any group, all groups) — such a key is
 * refused. `files` defaults to `library` when absent (Zotero grants files
 * with the library).
 */
export function parseKeyInfo(json: unknown): KeyInfo {
  const o = envelope(json, "the key information");
  const userID = positiveInt(o.userID);
  if (userID === null) throw drift("the key information has no user id");
  const access = isObject(o.access) ? o.access : {};
  const user = isObject(access.user) ? access.user : {};
  const library = user.library === true;
  let write = user.write === true;
  let all = false;
  const ids: number[] = [];
  if (isObject(access.groups)) {
    for (const [name, entry] of Object.entries(access.groups)) {
      if (!isObject(entry)) continue;
      if (entry.write === true) write = true;
      if (entry.library !== true) continue;
      if (name === "all") all = true;
      else {
        const id = positiveInt(name);
        if (id !== null) ids.push(id);
      }
    }
  }
  return {
    userID,
    username: str(o.username) ?? "",
    displayName: str(o.displayName)?.trim() || null,
    library,
    files: typeof user.files === "boolean" ? user.files : library,
    notes: user.notes === true,
    write,
    groups: all ? "all" : ids.length ? [...new Set(ids)].sort((a, b) => a - b) : "none",
  };
}

/** One entry of /users/{id}/groups. */
export function parseGroup(json: unknown): ZoteroGroup {
  const o = envelope(json, "a group");
  const data = isObject(o.data) ? o.data : {};
  const id = positiveInt(o.id) ?? positiveInt(data.id);
  if (id === null) throw drift("a group without an id");
  const meta = isObject(o.meta) ? o.meta : {};
  return { id, name: str(data.name)?.trim() || `Skupina ${id}`, numItems: nonNegInt(meta.numItems) };
}

/** One entry of /collections (`parentCollection` is false at the top level). */
export function parseCollection(json: unknown): ZoteroCollection {
  const o = envelope(json, "a collection");
  const data = isObject(o.data) ? o.data : {};
  const key = str(o.key) ?? str(data.key);
  if (!key || !ITEM_KEY_RE.test(key)) throw drift("a collection without a valid key");
  const parent = str(data.parentCollection);
  const meta = isObject(o.meta) ? o.meta : {};
  return {
    key,
    name: str(data.name)?.trim() ?? "",
    parentCollection: parent && ITEM_KEY_RE.test(parent) ? parent : null,
    numItems: nonNegInt(meta.numItems),
  };
}

/** One entry of /searches: a condition without a name or an operator is dropped, a missing value is "". */
export function parseSavedSearch(json: unknown): SavedSearch {
  const o = envelope(json, "a saved search");
  const data = isObject(o.data) ? o.data : {};
  const key = str(o.key) ?? str(data.key);
  if (!key || !ITEM_KEY_RE.test(key)) throw drift("a saved search without a valid key");
  const conditions: SavedSearchCondition[] = Array.isArray(data.conditions)
    ? data.conditions.flatMap((c) => {
        if (!isObject(c)) return [];
        const condition = str(c.condition)?.trim();
        const operator = str(c.operator)?.trim();
        if (!condition || !operator) return [];
        return [{ condition, operator, value: str(c.value) ?? (typeof c.value === "number" ? String(c.value) : "") }];
      })
    : [];
  return { key, name: str(data.name)?.trim() ?? "", conditions };
}

/**
 * One item (a work, an attachment, a note, an annotation). `library` is
 * taken from the object; `fallback` (the library that was queried) covers
 * an object without one.
 */
export function parseItem(json: unknown, fallback?: Library): ZoteroItem {
  const o = envelope(json, "an item");
  const data = o.data;
  if (!isObject(data)) throw drift("an item without data");
  const key = str(o.key) ?? str(data.key);
  if (!key || !ITEM_KEY_RE.test(key)) throw drift("an item without a valid key");
  const itemType = str(data.itemType);
  if (!itemType) throw drift("an item without an item type");
  const library = parseLibrary(o.library) ?? fallback;
  if (!library) throw drift("an item without its library");
  const meta = isObject(o.meta) ? o.meta : {};
  const links = isObject(o.links) ? o.links : {};
  const alternate = isObject(links.alternate) ? str(links.alternate.href) : null;
  const parent = str(data.parentItem);
  return {
    key,
    version: nonNegInt(o.version) ?? nonNegInt(data.version) ?? 0,
    library,
    itemType,
    title: itemTitle(itemType, data),
    parentItem: parent && ITEM_KEY_RE.test(parent) ? parent : null,
    creators: parseCreators(data.creators),
    date: firstText(data, DATE_FIELDS),
    url: str(data.url)?.trim() || null,
    webLink: alternate && isZoteroWebLink(alternate) ? alternate : null,
    tags: Array.isArray(data.tags) ? data.tags.flatMap((t) => (isObject(t) && str(t.tag)?.trim() ? [str(t.tag)!.trim()] : [])) : [],
    collections: Array.isArray(data.collections) ? data.collections.filter((c): c is string => typeof c === "string" && ITEM_KEY_RE.test(c)) : [],
    meta: {
      creatorSummary: str(meta.creatorSummary)?.trim() || null,
      parsedDate: str(meta.parsedDate)?.trim() || null,
      numChildren: nonNegInt(meta.numChildren),
    },
    data,
  };
}

/** GET /items/{key}/fulltext: PDFs report pages, text/HTML snapshots characters. */
export function parseFulltext(json: unknown): Fulltext {
  const o = envelope(json, "the full text");
  if (typeof o.content !== "string") throw drift("a full text without content");
  return {
    content: o.content,
    indexedPages: nonNegInt(o.indexedPages),
    totalPages: nonNegInt(o.totalPages),
    indexedChars: nonNegInt(o.indexedChars),
    totalChars: nonNegInt(o.totalChars),
  };
}

function parseLibrary(raw: unknown): Library | null {
  if (!isObject(raw)) return null;
  const id = positiveInt(raw.id);
  if (id === null) return null;
  if (raw.type === "user") return { type: "user", id };
  if (raw.type === "group") {
    const name = str(raw.name)?.trim();
    return name ? { type: "group", id, name } : { type: "group", id };
  }
  return null;
}

/** Display title: the title-type field, a note's first line, an annotation's text. */
function itemTitle(itemType: string, data: Record<string, unknown>): string {
  if (itemType === "note") return firstLine(htmlToText((str(data.note) ?? "").slice(0, NOTE_TITLE_HTML)));
  if (itemType === "annotation") return firstLine(str(data.annotationText)?.trim() || str(data.annotationComment) || "");
  return firstText(data, TITLE_FIELDS) ?? firstText(data, ["shortTitle", "filename"]) ?? "";
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > NOTE_TITLE_CHARS ? `${line.slice(0, NOTE_TITLE_CHARS - 1).trimEnd()}…` : line;
}

/** "Last, First", a single-field "name", or whichever half exists. */
function parseCreators(raw: unknown): ZoteroCreator[] {
  if (!Array.isArray(raw)) return [];
  const out: ZoteroCreator[] = [];
  for (const c of raw) {
    if (!isObject(c)) continue;
    const last = str(c.lastName)?.trim() ?? "";
    const first = str(c.firstName)?.trim() ?? "";
    const name = str(c.name)?.trim() || (last && first ? `${last}, ${first}` : last || first);
    if (name) out.push({ creatorType: str(c.creatorType) ?? "author", name });
  }
  return out;
}

function isZoteroWebLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && (url.hostname === "www.zotero.org" || url.hostname === "zotero.org");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// I/O

/** What the key may do. Called with the bare key right after OAuth (no user id yet). */
export async function getKeyInfo(key: string, io: IoOptions = {}): Promise<KeyInfo> {
  const res = await zoteroFetch({ key }, "/keys/current", io);
  if (res.status !== 200) throw unexpected(res, "reading the key's permissions");
  return parseKeyInfo(res.json());
}

/**
 * Revoke the key on zotero.org ("Odpojit", or a key that can write).
 * true when Zotero deleted it; false when it was already gone or not ours
 * to delete (403/404) — never an error in those cases.
 */
export async function revokeKey(creds: ZoteroCreds, io: IoOptions = {}): Promise<boolean> {
  try {
    const res = await zoteroFetch(creds, "/keys/current", { method: "DELETE", signal: io.signal });
    if (res.status >= 200 && res.status < 300) return true;
    if (res.status === 404) return false;
    throw unexpected(res, "revoking the key");
  } catch (error) {
    if (error instanceof ZoteroKeyInvalidError) return false;
    if (error instanceof SourceError && error.kind === "NOT_ENTITLED") return false;
    throw error;
  }
}

let groupsCache = new TtlCache<ZoteroGroup[]>(CACHE_TTL_MS.groups, 200);
let collectionsCache = new TtlCache<ZoteroCollection[]>(CACHE_TTL_MS.collections, 400);
let scanCache = new TtlCache<CaseScan & { complete: boolean }>(CACHE_TTL_MS.caseScan, 100);
let searchesCache = new TtlCache<SavedSearch[]>(CACHE_TTL_MS.searches, 200);

export function __resetZoteroClientForTests(): void {
  groupsCache = new TtlCache<ZoteroGroup[]>(CACHE_TTL_MS.groups, 200);
  collectionsCache = new TtlCache<ZoteroCollection[]>(CACHE_TTL_MS.collections, 400);
  scanCache = new TtlCache<CaseScan & { complete: boolean }>(CACHE_TTL_MS.caseScan, 100);
  searchesCache = new TtlCache<SavedSearch[]>(CACHE_TTL_MS.searches, 200);
}

/**
 * The groups whose library the key may read (all pages; cached), given the
 * key's group access as stored with the connection (KeyInfo.groups).
 * /users/{id}/groups alone is not that list: it also names public groups
 * the key owner belongs to even when the key has no permission for them,
 * and a members-only library of such a group answers 403 — which would
 * fail a search fanned out over every group as a whole.
 */
export async function listGroups(creds: ZoteroCreds, access: KeyInfo["groups"], io: IoOptions = {}): Promise<ZoteroGroup[]> {
  if (access === "none" || (Array.isArray(access) && !access.length)) return [];
  const groups = await groupsCache.through(cacheKey(creds, null), async () => {
    const { items } = await allPages(creds, (start) => `/users/${userIdOf(creds)}/groups?${pageQuery(start)}`, parseGroup, MAX_GROUP_PAGES, "throw", io);
    return items;
  });
  return readableGroups(groups, access);
}

/** Pure: "all" keeps every group, "none" none, a list of ids only those groups. */
export function readableGroups(groups: ZoteroGroup[], access: KeyInfo["groups"]): ZoteroGroup[] {
  if (access === "all") return groups;
  if (access === "none") return [];
  const ids = new Set(access);
  return groups.filter((g) => ids.has(g.id));
}

/** One page of an items search. */
export async function searchItems(
  creds: ZoteroCreds,
  lib: Library,
  params: ItemsQuery,
  io: IoOptions = {},
): Promise<{ items: ZoteroItem[]; paging: Paging }> {
  const res = await zoteroFetch(creds, buildItemsPath(checkedLibrary(creds, lib), params), io);
  if (res.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `${SOURCE}: ${params.collection ? "the collection" : "the library"} was not found.`,
      "List the libraries and collections the key can read, then search one of those.",
    );
  }
  if (res.status !== 200) throw unexpected(res, "searching items");
  return { items: array(res.json(), "an item list").map((x) => parseItem(x, lib)), paging: parsePaging(res.headers) };
}

/** Items by key, in the order asked (missing ones left out), LIMITS.maxItemKeys per request. */
export async function getItemsByKeys(creds: ZoteroCreds, lib: Library, keys: string[], io: IoOptions = {}): Promise<ZoteroItem[]> {
  const unique = [...new Set(keys.map((k) => objectKey(k, "item")))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += LIMITS.maxItemKeys) chunks.push(unique.slice(i, i + LIMITS.maxItemKeys));
  // In parallel: zoteroFetch's per-user slots keep it polite.
  const pages = await Promise.all(chunks.map((itemKeys) => searchItems(creds, lib, { itemKeys, limit: LIMITS.pageSize, start: 0 }, io)));
  const byKey = new Map(pages.flatMap((p) => p.items).map((item) => [item.key, item]));
  return unique.flatMap((k) => byKey.get(k) ?? []);
}

/** One item, or null when the library has no such key. */
export async function getItem(creds: ZoteroCreds, lib: Library, key: string, io: IoOptions = {}): Promise<ZoteroItem | null> {
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/items/${objectKey(key, "item")}`, io);
  if (res.status === 404) return null;
  if (res.status !== 200) throw unexpected(res, "reading an item");
  return parseItem(res.json(), lib);
}

/** Attachments and notes of a work, or annotations of an attachment (all pages up to a cap). */
export async function getChildren(creds: ZoteroCreds, lib: Library, key: string, io: IoOptions = {}): Promise<ZoteroItem[]> {
  const path = `${libraryPrefix(checkedLibrary(creds, lib))}/items/${objectKey(key, "item")}/children`;
  const { items } = await allPages(creds, (start) => `${path}?${pageQuery(start)}`, (x) => parseItem(x, lib), MAX_CHILD_PAGES, "empty", io);
  return items;
}

/** Zotero's full-text index of an attachment, or null when it has none (not indexed by a desktop client, not synced). */
export async function getFulltext(creds: ZoteroCreds, lib: Library, key: string, io: IoOptions = {}): Promise<Fulltext | null> {
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/items/${objectKey(key, "item")}/fulltext`, io);
  if (res.status === 404) return null;
  if (res.status !== 200) throw unexpected(res, "reading the full text");
  return parseFulltext(res.json());
}

/** Every collection of a library (all pages; cached). */
export async function listCollections(creds: ZoteroCreds, lib: Library, io: IoOptions = {}): Promise<ZoteroCollection[]> {
  const prefix = libraryPrefix(checkedLibrary(creds, lib));
  return collectionsCache.through(cacheKey(creds, lib), async () => {
    const { items } = await allPages(creds, (start) => `${prefix}/collections?${pageQuery(start)}`, parseCollection, MAX_COLLECTION_PAGES, "throw", io);
    return items;
  });
}

/** One page of a library's tags, optionally those containing `q`. */
export async function listTags(
  creds: ZoteroCreds,
  lib: Library,
  params: { q?: string; limit: number; start: number },
  io: IoOptions = {},
): Promise<{ tags: Array<{ tag: string; numItems: number }>; paging: Paging }> {
  const qs = new URLSearchParams();
  const q = params.q?.trim();
  if (q) {
    qs.set("q", q);
    qs.set("qmode", "contains");
  }
  qs.set("limit", String(clampInt(params.limit, 1, LIMITS.pageSize)));
  qs.set("start", String(clampInt(params.start, 0, Number.MAX_SAFE_INTEGER)));
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/tags?${qs.toString()}`, io);
  if (res.status !== 200) throw unexpected(res, "listing tags");
  const tags = array(res.json(), "a tag list").flatMap((entry) => {
    if (!isObject(entry)) return [];
    const tag = str(entry.tag)?.trim();
    if (!tag) return [];
    const meta = isObject(entry.meta) ? entry.meta : {};
    return [{ tag, numItems: nonNegInt(meta.numItems) ?? 0 }];
  });
  return { tags, paging: parsePaging(res.headers) };
}

/**
 * The newest case items of a library, `maxPages` pages of 100, for a
 * docket-number lookup (Zotero's q never searches docketNumber). Cached;
 * a cached scan is revalidated with If-Modified-Since-Version on every
 * call, so an unchanged library costs one empty 304 and a changed one is
 * rescanned (a case added a minute ago is found).
 */
export async function scanCases(creds: ZoteroCreds, lib: Library, opts: { maxPages: number }, io: IoOptions = {}): Promise<CaseScan> {
  checkedLibrary(creds, lib);
  const maxPages = clampInt(opts.maxPages, 1, LIMITS.scanPagesTotal);
  const key = cacheKey(creds, lib);
  const path = (start: number) =>
    buildItemsPath(lib, { itemTypes: ["case"], sort: "dateModified", direction: "desc", limit: LIMITS.pageSize, start });

  const cached = scanCache.get(key);
  let first: ZoteroResponse;
  if (cached && cached.libraryVersion !== null && (cached.complete || cached.scannedPages >= maxPages)) {
    first = await zoteroFetch(creds, path(0), { headers: { "If-Modified-Since-Version": String(cached.libraryVersion) }, signal: io.signal });
    if (first.status === 304) {
      scanCache.set(key, cached);
      return scanView(cached, maxPages);
    }
  } else {
    first = await zoteroFetch(creds, path(0), io);
  }

  const entries: CaseScanEntry[] = [];
  const firstPaging = parsePaging(first.headers);
  let res = first;
  let paging = firstPaging;
  let pages = 0;
  for (;;) {
    if (res.status !== 200) throw unexpected(res, "scanning case items");
    pages++;
    for (const raw of array(res.json(), "an item list")) entries.push(caseEntry(parseItem(raw, lib)));
    if (paging.nextStart === null || pages >= maxPages) break;
    res = await zoteroFetch(creds, path(paging.nextStart), io);
    paging = parsePaging(res.headers);
  }
  const scan = {
    items: entries,
    scannedPages: pages,
    total: firstPaging.total,
    // Page 1's version: if the library changed mid-scan, the next revalidation sees it as changed and rescans.
    libraryVersion: firstPaging.libraryVersion,
    complete: paging.nextStart === null,
  };
  scanCache.set(key, scan);
  return scanView(scan, maxPages);
}

function caseEntry(item: ZoteroItem): CaseScanEntry {
  return {
    key: item.key,
    title: item.title,
    docketNumber: str(item.data.docketNumber)?.trim() ?? "",
    extra: str(item.data.extra) ?? "",
    date: item.date,
    court: str(item.data.court)?.trim() ?? "",
    version: item.version,
  };
}

function scanView(scan: CaseScan & { complete: boolean }, maxPages: number): CaseScan {
  const pages = Math.min(scan.scannedPages, maxPages);
  return {
    items: pages < scan.scannedPages ? scan.items.slice(0, pages * LIMITS.pageSize) : scan.items,
    scannedPages: pages,
    total: scan.total,
    libraryVersion: scan.libraryVersion,
  };
}

/**
 * Items formatted by Zotero's citation server (CSL): each item's in-text
 * citation (for a note style: the footnote) and bibliography entry, as
 * HTML. In the order asked; keys the library does not have are left out.
 * A style Zotero does not know answers 400 (INPUT_INVALID).
 */
export async function citeItems(
  creds: ZoteroCreds,
  lib: Library,
  keys: string[],
  opts: { style: string; locale: string },
  io: IoOptions = {},
): Promise<CitedItem[]> {
  if (!STYLE_RE.test(opts.style) || opts.style.length > 100) throw invalid(`"${opts.style.slice(0, 40)}" is not a citation style id (like iso690-full-note-cs)`);
  if (!LOCALE_RE.test(opts.locale)) throw invalid(`"${opts.locale.slice(0, 20)}" is not a locale (like cs-CZ)`);
  const unique = citeKeys(keys);
  const qs = new URLSearchParams({ itemKey: unique.join(","), include: "data,citation,bib", style: opts.style, locale: opts.locale, limit: String(LIMITS.maxItemKeys) });
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/items?${qs.toString()}`, io);
  if (res.status !== 200) throw unexpected(res, "formatting citations");
  const byKey = new Map<string, CitedItem>();
  for (const raw of array(res.json(), "an item list")) {
    const item = parseItem(raw, lib);
    const o = raw as Record<string, unknown>;
    byKey.set(item.key, { item, citation: str(o.citation), bib: str(o.bib) });
  }
  return unique.flatMap((k) => byKey.get(k) ?? []);
}

/** Items in one of Zotero's export formats (RIS, BibTeX, BibLaTeX, CSL JSON), as the text Zotero sends. */
export async function exportItems(creds: ZoteroCreds, lib: Library, keys: string[], format: ExportFormat, io: IoOptions = {}): Promise<string> {
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw invalid(`unknown export format "${String(format).slice(0, 20)}"`);
  const qs = new URLSearchParams({ itemKey: citeKeys(keys).join(","), format, limit: String(LIMITS.maxItemKeys) });
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/items?${qs.toString()}`, io);
  if (res.status !== 200) throw unexpected(res, "exporting items");
  return res.text();
}

function citeKeys(keys: string[]): string[] {
  const unique = [...new Set(keys.map((k) => objectKey(k, "item")))];
  if (!unique.length) throw invalid("no item key");
  if (unique.length > LIMITS.maxItemKeys) throw invalid(`at most ${LIMITS.maxItemKeys} item keys per request`);
  return unique;
}

/** The saved searches of a library (all pages; cached). */
export async function listSearches(creds: ZoteroCreds, lib: Library, io: IoOptions = {}): Promise<SavedSearch[]> {
  const prefix = libraryPrefix(checkedLibrary(creds, lib));
  return searchesCache.through(cacheKey(creds, lib), async () => {
    const { items } = await allPages(creds, (start) => `${prefix}/searches?${pageQuery(start)}`, parseSavedSearch, MAX_SEARCH_PAGES, "throw", io);
    return items;
  });
}

/** One saved search, or null when the library has no such key. */
export async function getSearch(creds: ZoteroCreds, lib: Library, key: string, io: IoOptions = {}): Promise<SavedSearch | null> {
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/searches/${objectKey(key, "saved search")}`, io);
  if (res.status === 404) return null;
  if (res.status !== 200) throw unexpected(res, "reading a saved search");
  return parseSavedSearch(res.json());
}

/**
 * The PDF of an attachment stored in Zotero Storage — the fallback when the
 * full-text index is missing or incomplete. GET /items/{key}/file answers
 * with a redirect to a short-lived signed URL on the storage host; that one
 * hop is followed here only to an allowed host and WITHOUT any Zotero
 * header (the key never leaves api.zotero.org). No further redirect is
 * followed. Capped at LIMITS.maxPdfBytes (Content-Length and bytes counted
 * while streaming). WebDAV and linked files never reach the API.
 */
export async function downloadPdf(creds: ZoteroCreds, lib: Library, item: ZoteroItem, io: IoOptions = {}): Promise<PdfDownload> {
  if (item.itemType !== "attachment") return { unavailable: "not-pdf" };
  const linkMode = str(item.data.linkMode) ?? "";
  if (linkMode === "linked_file" || linkMode === "linked_url") return { unavailable: "linked" };
  if (str(item.data.contentType)?.toLowerCase() !== "application/pdf") return { unavailable: "not-pdf" };
  if (linkMode !== "imported_file" && linkMode !== "imported_url") return { unavailable: "not-pdf" };

  const path = `${libraryPrefix(checkedLibrary(creds, lib))}/items/${objectKey(item.key, "item")}/file`;
  let res: ZoteroResponse;
  try {
    res = await zoteroFetch(creds, path, { signal: io.signal, maxBytes: LIMITS.maxPdfBytes });
  } catch (error) {
    if (error instanceof ZoteroBodyTooLargeError) return { unavailable: "too-large" };
    throw error;
  }
  if (res.status === 404) return { unavailable: "webdav-or-missing" };
  if (/^yes$/i.test(res.headers.get("zotero-file-compressed")?.trim() ?? "")) return { unavailable: "compressed" };
  const size = headerInt(res.headers.get("zotero-file-size"));
  if (size !== null && size > LIMITS.maxPdfBytes) return { unavailable: "too-large" };
  // Should the API ever serve the file itself, it came through zoteroFetch's cap already.
  if (res.status === 200) return { bytes: toArrayBuffer(res.bytes) };
  if (res.status < 300 || res.status > 399 || res.status === 304) throw unexpected(res, "locating the attachment file");

  const location = res.headers.get("location");
  if (!location) throw drift("a file redirect without a Location");
  let target: URL;
  try {
    target = new URL(location, API_ORIGIN);
  } catch {
    return { unavailable: "storage-host" };
  }
  if (!isAllowedStorageHost(target)) return { unavailable: "storage-host" };
  return fetchStorage(target, io.signal);
}

/**
 * The storage hop: a plain request with only our UA — no Zotero header —
 * that follows nothing further. The signed URL is itself a credential for
 * the file, so it never appears in an error either.
 */
async function fetchStorage(target: URL, callerSignal: AbortSignal | undefined): Promise<PdfDownload> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new DOMException("Zotero storage timed out", "TimeoutError")), LIMITS.requestTimeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timer.signal]) : timer.signal;
  try {
    const res = await fetch(target.href, { method: "GET", headers: { "user-agent": ZOTERO_UA }, redirect: "manual", signal });
    if (res.status !== 200) await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) return { unavailable: "storage-host" };
    if (res.status === 404) return { unavailable: "webdav-or-missing" };
    if (res.status !== 200) {
      throw new SourceError(
        SOURCE,
        "UPSTREAM_ERROR",
        `${SOURCE} storage answered HTTP ${res.status} for the attachment file.`,
        "The download link may have expired. Try again in a minute.",
      );
    }
    try {
      return { bytes: toArrayBuffer(await readBody(res, LIMITS.maxPdfBytes, "throw")) };
    } catch (error) {
      if (error instanceof ZoteroBodyTooLargeError) return { unavailable: "too-large" };
      throw error;
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const name = error instanceof Error ? error.name : "";
    const label = callerSignal?.aborted || name === "AbortError" ? "cancelled" : name === "TimeoutError" ? "timed out" : name || "network error";
    throw new SourceError(
      SOURCE,
      "UPSTREAM_UNREACHABLE",
      `${SOURCE} storage did not deliver the attachment file (${label}).`,
      "Try again in a minute.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Follow Link rel="next" up to `maxPages`. `on404`: "empty" for a parent
 * that no longer exists, "throw" where the path must exist.
 */
async function allPages<T>(
  creds: ZoteroCreds,
  pathAt: (start: number) => string,
  parse: (json: unknown) => T,
  maxPages: number,
  on404: "empty" | "throw",
  io: IoOptions,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let start = 0;
  for (let page = 1; ; page++) {
    const res = await zoteroFetch(creds, pathAt(start), io);
    if (res.status === 404 && page === 1 && on404 === "empty") return { items, complete: true };
    if (res.status !== 200) throw unexpected(res, "listing");
    for (const raw of array(res.json(), "a list")) items.push(parse(raw));
    const next = parsePaging(res.headers).nextStart;
    // A "next" that does not move forward would loop forever.
    if (next === null || next <= start) return { items, complete: true };
    if (page >= maxPages) return { items, complete: false };
    start = next;
  }
}

function pageQuery(start: number): string {
  return new URLSearchParams({ limit: String(LIMITS.pageSize), start: String(start) }).toString();
}

/** A user library must be the key owner's own; the key cannot read anyone else's anyway. */
function checkedLibrary(creds: ZoteroCreds, lib: Library): Library {
  if (lib.type === "user" && lib.id !== creds.userID) throw invalid("a personal library other than the connected user's");
  return lib;
}

function userIdOf(creds: ZoteroCreds): number {
  if (!Number.isSafeInteger(creds.userID) || creds.userID <= 0) throw new Error("Zotero credentials without a user id.");
  return creds.userID;
}

/** userID + a hash of the key (+ the library): never the key itself. */
function cacheKey(creds: ZoteroCreds, lib: Library | null): string {
  const tag = createHash("sha256").update(creds.key).digest("hex").slice(0, 16);
  return `${userIdOf(creds)}:${tag}${lib ? `:${lib.type}:${lib.id}` : ""}`;
}

function objectKey(key: string, what: string): string {
  if (typeof key !== "string" || !ITEM_KEY_RE.test(key)) throw invalid(`"${String(key).slice(0, 20)}" is not a Zotero ${what} key (8 characters like ABCD2345)`);
  return key;
}

/** Status the calling function did not expect, as a SourceError without the body or the URL. */
function unexpected(res: ZoteroResponse, doing: string): SourceError {
  if (res.status === 400) {
    // Zotero explains a bad parameter in one short plain-text line; long tokens are dropped in case one is a secret.
    const reason = res.text().trim().split("\n")[0].replace(/[A-Za-z0-9]{20,}/g, "***").slice(0, 160);
    return new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `${SOURCE} rejected the request ${doing} (HTTP 400${/^[\x20-\x7E]+$/.test(reason) ? `: ${reason}` : ""}).`,
      "Check the query parameters (search words, item type, tag, sort) and try again.",
    );
  }
  if (res.status === 404) {
    return new SourceError(SOURCE, "NOT_FOUND", `${SOURCE}: nothing found when ${doing} (HTTP 404).`, "List the libraries and collections the key can read, then use one of those.");
  }
  return new SourceError(SOURCE, "UPSTREAM_ERROR", `${SOURCE} answered HTTP ${res.status} when ${doing}.`, JSON_HINT);
}

function drift(what: string): SourceError {
  return new SourceError(SOURCE, "PARSE_DRIFT", `${SOURCE} answered with ${what}.`, JSON_HINT);
}

function invalid(what: string): SourceError {
  return new SourceError(SOURCE, "INPUT_INVALID", `${SOURCE}: ${what}.`, "Correct the parameter and call again.");
}

function envelope(json: unknown, what: string): Record<string, unknown> {
  if (!isObject(json)) throw drift(`${what} that is not an object`);
  return json;
}

function array(json: unknown, what: string): unknown[] {
  if (!Array.isArray(json)) throw drift(`${what} that is not an array`);
  return json;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function firstText(data: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const v = str(data[field])?.trim();
    if (v) return v;
  }
  return null;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nonNegInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function headerInt(v: string | null): number | null {
  return v !== null && /^\s*\d{1,15}\s*$/.test(v) ? Number(v.trim()) : null;
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : min;
  return Math.min(max, Math.max(min, n));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
