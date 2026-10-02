import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { TtlCache } from "@/src/sources/shared/cache";
import { SourceError } from "@/src/sources/shared/errors";
import { htmlToText, loadHtml } from "@/src/sources/shared/html";
import { API_ORIGIN, CACHE_TTL_MS, EXPORT_FORMATS, ITEM_KEY_RE, LIMITS, LOCALE_RE, SOURCE, STYLE_RE, ZOTERO_UA, isAllowedStorageHost, type ExportFormat } from "./config";
import { ZoteroBodyTooLargeError, ZoteroKeyInvalidError, cancelled, readBody, zoteroFetch, type ZoteroResponse } from "./http";
import type {
  DeletedObjects,
  Fulltext,
  FulltextIndexStatus,
  KeyInfo,
  Library,
  LocalizedName,
  Paging,
  SavedSearch,
  SavedSearchCondition,
  TagColor,
  ZoteroCollection,
  ZoteroCreator,
  ZoteroCreds,
  ZoteroGroup,
  ZoteroItem,
  ZoteroSettings,
  ZoteroTag,
} from "./types";

/**
 * The Zotero Web API v3: pure path builders and parsers first, then the
 * calls (all through zoteroFetch, ./http.ts). Everything reads, except
 * createItem — the one write, which only ever ADDS an item to the personal
 * library (POST, never PATCH, PUT or DELETE of an existing object) — and
 * revokeKey, which deletes Dawmain's own key. The parsers turn the
 * API's JSON into the shapes of ./types.ts and are the only code that knows
 * the raw objects: a broken envelope (no key, no data, not an array) is
 * PARSE_DRIFT, a missing optional field is simply absent.
 *
 * Caches (per instance, TtlCache): groups, collections, saved searches,
 * settings and the case scan; search pages only conditionally — a repeat is
 * sent with If-Modified-Since-Version and reuses the page on a 304, so a
 * search is never answered from memory without Zotero confirming that the
 * library is unchanged. Every cache key carries the Zotero user id AND a
 * hash of the key, because two Dawmain accounts can connect the same Zotero
 * user with keys of different reach. Concurrent calls that miss the same
 * cache share one load in flight (shared(), below).
 */

export interface IoOptions {
  /** The tool call's budget; aborting it cancels the request. */
  signal?: AbortSignal;
}

/** Query of /items (or /collections/{key}/items). Zotero caps `limit` at 100 and `itemKey` at 50. */
export interface ItemsQuery {
  /** /items/top: top-level items only (no child attachments, notes or annotations). */
  top?: boolean;
  /** /items/trash: the items in the trash only. Not with a collection or My Publications. */
  trash?: boolean;
  /** /users/{id}/publications/items: My Publications of the personal library. */
  publications?: boolean;
  /** includeTrashed=1: the trash too. */
  includeTrashed?: boolean;
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
const DATE_FIELDS = ["date", "dateDecided", "dateEnacted", "issueDate"] as const;
const MAX_SETTINGS_BYTES = LIMITS.maxJsonBytes;

// ---------------------------------------------------------------------------
// Pure: paths

/** Typographic double quotes — an operator nowhere in Zotero's quick search. */
const TYPOGRAPHIC_QUOTES = /[„“”«»]/g;

/**
 * The q Zotero is sent for a quick search in `qmode` (absent: Zotero's
 * default, titleCreatorYear). Measured on the live API: titleCreatorYear
 * has no phrase search — `"Obchodní smlouvy"` matched nothing there, not
 * even the book of exactly that title — so title mode gets the words
 * without the quotes; everything mode keeps ASCII quotes, which make its
 * full-text part match the phrase (8 items against 198 for the bare words).
 * Typographic quotes („Obchodní smlouvy“) are no operator in either mode:
 * the full-text part ignores them and the title part looks for them
 * literally (197 items, the title hit lost), so they are dropped in both.
 * Pure.
 */
export function zoteroQuery(q: string, qmode: ItemsQuery["qmode"]): string {
  const bare = q.replace(TYPOGRAPHIC_QUOTES, " ");
  return (qmode === "everything" ? bare : bare.replace(/"/g, " ")).replace(/\s+/g, " ").trim();
}

/** zoteroQuery, refusing a q that was only quotes (sending none would list the whole library instead). */
function queryParam(raw: string, qmode: ItemsQuery["qmode"]): string {
  const q = zoteroQuery(raw, qmode);
  if (!q) throw invalid("the query has no words to search for (quotes alone are not a query)");
  return q;
}

/** "/users/475425" or "/groups/123". */
export function libraryPrefix(lib: Library): string {
  if (!Number.isSafeInteger(lib.id) || lib.id <= 0) throw new Error("A Zotero library id is a positive integer.");
  return lib.type === "user" ? `/users/${lib.id}` : `/groups/${lib.id}`;
}

/** Path + query of an items search; the key is never part of it. Invalid input is INPUT_INVALID. */
export function buildItemsPath(lib: Library, p: ItemsQuery): string {
  const collection = p.collection !== undefined ? objectKey(p.collection, "collection") : null;
  if (p.trash && (p.top || collection || p.publications)) throw invalid("the trash is a scope of its own (not with top, a collection or My Publications)");
  if (p.publications && (collection || lib.type !== "user")) throw invalid("My Publications belong to the personal library (no collection)");
  const scope = p.publications ? "/publications" : collection ? `/collections/${collection}` : "";
  const base = `${libraryPrefix(lib)}${scope}/items${p.top ? "/top" : p.trash ? "/trash" : ""}`;
  const qs = new URLSearchParams();
  const q = p.q?.trim();
  if (q) {
    qs.set("q", queryParam(q, p.qmode));
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
  if (p.includeTrashed) qs.set("includeTrashed", "1");
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
    fulltextReindexing: headers.get("zotero-full-text-reindexing")?.trim() === "1",
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
 * ANYWHERE (the personal library, any group, all groups); `userWrite` only
 * for the personal library, the one zotero_save writes to. `files`
 * defaults to `library` when absent (Zotero grants files with the library).
 */
export function parseKeyInfo(json: unknown): KeyInfo {
  const o = envelope(json, "the key information");
  const userID = positiveInt(o.userID);
  if (userID === null) throw drift("the key information has no user id");
  const access = isObject(o.access) ? o.access : {};
  const user = isObject(access.user) ? access.user : {};
  const library = user.library === true;
  const userWrite = user.write === true;
  let write = userWrite;
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
    userWrite,
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
  return {
    id,
    name: str(data.name)?.trim() || `Skupina ${id}`,
    numItems: nonNegInt(meta.numItems),
    type: str(data.type)?.trim() || null,
    description: str(data.description)?.trim() || null,
    url: str(data.url)?.trim() || null,
    libraryReading: str(data.libraryReading)?.trim() || null,
    libraryEditing: str(data.libraryEditing)?.trim() || null,
    fileEditing: str(data.fileEditing)?.trim() || null,
    members: Array.isArray(data.members) ? data.members.length : 0,
    admins: Array.isArray(data.admins) ? data.admins.length : 0,
    isAdmin: typeof meta.isAdmin === "boolean" ? meta.isAdmin : null,
    created: str(meta.created)?.trim() || null,
    lastModified: str(meta.lastModified)?.trim() || null,
  };
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
    numCollections: nonNegInt(meta.numCollections),
    deleted: isDeleted(data.deleted),
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
  return { key, name: str(data.name)?.trim() ?? "", conditions, deleted: isDeleted(data.deleted) };
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
  const tagObjects = Array.isArray(data.tags) ? data.tags.filter(isObject) : [];
  const enclosure = isObject(links.enclosure) ? links.enclosure : null;
  const username = (u: unknown) => (isObject(u) ? str(u.username)?.trim() || null : null);
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
    tags: tagObjects.flatMap((t) => (str(t.tag)?.trim() ? [str(t.tag)!.trim()] : [])),
    automaticTags: tagObjects.flatMap((t) => (str(t.tag)?.trim() && Number(t.type) === 1 ? [str(t.tag)!.trim()] : [])),
    collections: Array.isArray(data.collections) ? data.collections.filter((c): c is string => typeof c === "string" && ITEM_KEY_RE.test(c)) : [],
    deleted: isDeleted(data.deleted),
    file: enclosure ? { size: nonNegInt(enclosure.length), contentType: str(enclosure.type)?.trim() || null } : null,
    meta: {
      creatorSummary: str(meta.creatorSummary)?.trim() || null,
      parsedDate: str(meta.parsedDate)?.trim() || null,
      numChildren: nonNegInt(meta.numChildren),
      createdBy: username(meta.createdByUser),
      lastModifiedBy: username(meta.lastModifiedByUser),
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

/** data.deleted is 1 (items) or true (collections, searches) in the trash, absent otherwise. */
function isDeleted(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

/** GET {lib}/settings: `{name: {value, version}}`. */
export function parseSettings(json: unknown): ZoteroSettings {
  const o = envelope(json, "the settings");
  const out: ZoteroSettings = {};
  for (const [name, entry] of Object.entries(o)) {
    if (!isObject(entry) || !("value" in entry)) continue;
    out[name] = { value: entry.value, version: nonNegInt(entry.version) };
  }
  return out;
}

/** The tagColors setting: `[{name, color}]`, in Zotero's order; malformed entries dropped. */
export function tagColorsOf(settings: ZoteroSettings): TagColor[] {
  const value = settings.tagColors?.value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) => {
    if (!isObject(c)) return [];
    const name = str(c.name)?.trim();
    const color = str(c.color)?.trim();
    return name && color && /^#[0-9A-Fa-f]{3,8}$/.test(color) ? [{ name, color: color.toLowerCase() }] : [];
  });
}

/** One entry of a tag listing. */
export function parseTag(json: unknown): ZoteroTag | null {
  if (!isObject(json)) return null;
  const tag = str(json.tag)?.trim();
  if (!tag) return null;
  const meta = isObject(json.meta) ? json.meta : {};
  return { tag, type: nonNegInt(meta.type) ?? 0, numItems: nonNegInt(meta.numItems) ?? 0 };
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
 * Revoke the key on zotero.org ("Odpojit", a key the callback refuses, or the one a reconnect replaces).
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

/** What createItem made: the new item's key and version, and its zotero.org page when Zotero named it. */
export interface CreatedItem {
  key: string;
  version: number | null;
  webLink: string | null;
}

/** A fresh Zotero-Write-Token: 32 hex characters, one per new item. */
export function newWriteToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Zotero's reason for a failed object, safe to echo: one printable line,
 * long tokens dropped (a value Zotero quotes could be anything).
 */
function writeFailureReason(raw: unknown): string | null {
  if (!isObject(raw)) return null;
  const message = str(raw.message)?.trim().split("\n")[0].replace(/[A-Za-z0-9]{20,}/g, "***").slice(0, 200) ?? "";
  return message && /^[\x20-\x7E]+$/.test(message) ? message : null;
}

/**
 * Create ONE new item in the personal library (POST /users/{id}/items) —
 * the only write the integration makes. `data` is the item's Zotero JSON
 * (itemType, fields, creators, tags) and must carry no key or version: a
 * key would make the POST update that item. Sent with a fresh
 * Zotero-Write-Token (`writeToken`, the caller's, so one tool call keeps
 * one token): Zotero applies a token at most once, so zoteroFetch's single
 * retry after a short 429/503 cannot create a second item — a repeat of a
 * write Zotero had applied answers 412, reported here as "maybe saved".
 * Never anything to a group library.
 */
export async function createItem(
  creds: ZoteroCreds,
  data: Record<string, unknown>,
  writeToken: string = newWriteToken(),
  io: IoOptions = {},
): Promise<CreatedItem> {
  if (!isObject(data) || typeof data.itemType !== "string") throw new Error("createItem needs an item object with an itemType.");
  if ("key" in data || "version" in data || "parentItem" in data) throw new Error("createItem only creates: no key, version or parentItem.");
  const path = `${libraryPrefix({ type: "user", id: creds.userID })}/items`;
  const res = await zoteroFetch(creds, path, {
    method: "POST",
    json: [data],
    headers: { "Zotero-Write-Token": writeToken },
    signal: io.signal,
  });
  if (res.status === 412) {
    throw new SourceError(
      SOURCE,
      "UPSTREAM_ERROR",
      `${SOURCE}: the write was answered 412 — its write token was already used, so an earlier attempt of this same save may have gone through.`,
      "Do not save again blindly: look the item up with zotero_search (title) first, and save only if it is not there.",
    );
  }
  if (res.status === 413) {
    throw new SourceError(SOURCE, "INPUT_INVALID", `${SOURCE} refused the item as too large (HTTP 413).`, "Shorten the abstract or extra and save again.");
  }
  if (res.status !== 200) throw unexpected(res, "saving the item");
  const body = envelope(res.json(), "the write result");
  const failed = isObject(body.failed) ? body.failed["0"] : undefined;
  if (failed !== undefined) {
    const reason = writeFailureReason(failed);
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `${SOURCE} did not save the item${reason ? `: ${reason}` : ""}.`,
      "Nothing was saved. Correct the field Zotero names (zotero_list {list: \"item_fields\", item_type: …} lists the valid fields) and save again.",
    );
  }
  const successful = isObject(body.successful) ? body.successful["0"] : undefined;
  const key = isObject(successful) ? str(successful.key) : isObject(body.success) ? str(body.success["0"]) : null;
  if (!key || !ITEM_KEY_RE.test(key)) throw drift("a write result without the new item's key");
  let webLink: string | null = null;
  let version: number | null = null;
  if (isObject(successful)) {
    version = nonNegInt(successful.version);
    const links = isObject(successful.links) ? successful.links : {};
    const href = isObject(links.alternate) ? str(links.alternate.href) : null;
    webLink = href && isZoteroWebLink(href) ? href : null;
  }
  return { key, version, webLink };
}

type FullScan = CaseScan & { complete: boolean };
type SearchPage = { items: ZoteroItem[]; paging: Paging };

let groupsCache = new TtlCache<ZoteroGroup[]>(CACHE_TTL_MS.groups, 200);
let collectionsCache = new TtlCache<ZoteroCollection[]>(CACHE_TTL_MS.collections, 400);
let scanCache = new TtlCache<FullScan>(CACHE_TTL_MS.caseScan, 100);
let searchesCache = new TtlCache<SavedSearch[]>(CACHE_TTL_MS.searches, 200);
let searchCache = new TtlCache<SearchPage>(CACHE_TTL_MS.search, LIMITS.searchCacheEntries);

export function __resetZoteroClientForTests(): void {
  groupsCache = new TtlCache<ZoteroGroup[]>(CACHE_TTL_MS.groups, 200);
  collectionsCache = new TtlCache<ZoteroCollection[]>(CACHE_TTL_MS.collections, 400);
  scanCache = new TtlCache<FullScan>(CACHE_TTL_MS.caseScan, 100);
  searchesCache = new TtlCache<SavedSearch[]>(CACHE_TTL_MS.searches, 200);
  searchCache = new TtlCache<SearchPage>(CACHE_TTL_MS.search, LIMITS.searchCacheEntries);
  settingsCache = new TtlCache<ZoteroSettings>(CACHE_TTL_MS.settings, 200);
  schemaCache = new TtlCache<LocalizedName[]>(CACHE_TTL_MS.schema, 200);
  flights.clear();
  scanRuns.clear();
}

// ---------------------------------------------------------------------------
// Loads shared while in flight

/**
 * One load on behalf of every concurrent call that wants the same thing.
 * Claude often fires several zotero_search calls at once and on Fluid they
 * land on one instance: each would otherwise list the groups and scan the
 * case items on its own (3 parallel docket searches: 15 scan pages where 5
 * do), all queued behind the same 3 slots of the user. The load runs under
 * its own signal, aborted only when EVERY joined caller has given up — no
 * caller's budget cuts the others off, and nothing runs on once nobody
 * waits. A caller that gives up gets the usual cancellation; a failure
 * reaches every joined caller and is not kept (the next call loads again).
 * Keys carry the user id and the key's hash (cacheKey), so a load — and a
 * rejected key's error — is only ever shared by calls of the same key.
 */
interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  /** Callers still waiting; one without a signal never leaves. */
  waiting: number;
}

const flights = new Map<string, Flight<unknown>>();

/** Start `load` (synchronously, so its first request takes its slot now) or join the one in flight. */
function shared<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  let flight = flights.get(key) as Flight<T> | undefined;
  if (!flight) {
    const f: Flight<T> = { promise: Promise.resolve(undefined as T), controller: new AbortController(), waiting: 0 };
    f.promise = load(f.controller.signal);
    const done = () => {
      if (flights.get(key) === f) flights.delete(key);
    };
    f.promise.then(done, done);
    flights.set(key, f);
    flight = f;
  }
  const f = flight;
  return join(f, signal, () => {
    if (flights.get(key) === f) flights.delete(key);
  });
}

/** Wait for a flight under the caller's own signal; the last caller to give up aborts it (`gone` detaches it first). */
function join<T>(flight: Flight<T>, signal: AbortSignal | undefined, gone: () => void): Promise<T> {
  flight.waiting++;
  if (!signal) return flight.promise;
  return new Promise<T>((resolve, reject) => {
    const leave = () => {
      if (--flight.waiting > 0) return;
      gone();
      flight.controller.abort();
    };
    if (signal.aborted) {
      leave();
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      leave();
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A cached read: the cache, else one shared load (stored when it succeeds). */
function cachedShared<T>(cache: TtlCache<T>, name: string, key: string, load: (io: IoOptions) => Promise<T>, io: IoOptions): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return shared(
    `${name}|${key}`,
    async (signal) => {
      const value = await load({ signal });
      cache.set(key, value);
      return value;
    },
    io.signal,
  );
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
  const groups = await cachedShared(
    groupsCache,
    "groups",
    cacheKey(creds, null),
    async (shared) => (await allPages(creds, (start) => `/users/${userIdOf(creds)}/groups?${pageQuery(start)}`, parseGroup, MAX_GROUP_PAGES, "throw", shared)).items,
    io,
  );
  return readableGroups(groups, access);
}

/** Pure: "all" keeps every group, "none" none, a list of ids only those groups. */
export function readableGroups(groups: ZoteroGroup[], access: KeyInfo["groups"]): ZoteroGroup[] {
  if (access === "all") return groups;
  if (access === "none") return [];
  const ids = new Set(access);
  return groups.filter((g) => ids.has(g.id));
}

/**
 * One page of an items search. A page read before (the same key, library
 * and path — agents re-run identical searches after reading a document) is
 * asked for with If-Modified-Since-Version: an unchanged library answers an
 * empty 304 before Zotero runs the query, and the kept page is returned.
 * Not kept: a page without a library version, one from a full-text index
 * being rebuilt (Zotero-Full-Text-Reindexing: its version would keep
 * confirming a page that misses text matches), and a big one.
 */
export async function searchItems(
  creds: ZoteroCreds,
  lib: Library,
  params: ItemsQuery,
  io: IoOptions = {},
): Promise<{ items: ZoteroItem[]; paging: Paging }> {
  const path = buildItemsPath(checkedLibrary(creds, lib), params);
  const key = `${cacheKey(creds, lib)}|${path}`;
  const kept = searchCache.get(key);
  const res = await zoteroFetch(
    creds,
    path,
    kept ? { headers: { "If-Modified-Since-Version": String(kept.paging.libraryVersion) }, signal: io.signal } : io,
  );
  if (kept && res.status === 304) {
    // Re-inserted, so the most recently used pages are the last to be dropped.
    searchCache.delete(key);
    searchCache.set(key, kept);
    return kept;
  }
  if (res.status === 404) {
    throw new SourceError(
      SOURCE,
      "NOT_FOUND",
      `${SOURCE}: ${params.collection ? "the collection" : "the library"} was not found.`,
      "List the libraries and collections the key can read, then search one of those.",
    );
  }
  if (res.status !== 200) throw unexpected(res, "searching items");
  const page: SearchPage = { items: array(res.json(), "an item list").map((x) => parseItem(x, lib)), paging: parsePaging(res.headers) };
  searchCache.delete(key);
  if (page.paging.libraryVersion !== null && !page.paging.fulltextReindexing && res.bytes.byteLength <= LIMITS.searchCacheMaxBytes) {
    searchCache.set(key, page);
  }
  return page;
}

/** Items by key, in the order asked (missing ones left out), LIMITS.maxItemKeys per request. */
export async function getItemsByKeys(
  creds: ZoteroCreds,
  lib: Library,
  keys: string[],
  io: IoOptions = {},
  opts: { includeTrashed?: boolean } = {},
): Promise<ZoteroItem[]> {
  const unique = [...new Set(keys.map((k) => objectKey(k, "item")))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += LIMITS.maxItemKeys) chunks.push(unique.slice(i, i + LIMITS.maxItemKeys));
  // In parallel: zoteroFetch's per-user slots keep it polite. itemKey leaves out the trash unless includeTrashed.
  const pages = await Promise.all(
    chunks.map((itemKeys) => searchItems(creds, lib, { itemKeys, limit: LIMITS.pageSize, start: 0, includeTrashed: opts.includeTrashed || undefined }, io)),
  );
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
  return cachedShared(
    collectionsCache,
    "collections",
    cacheKey(creds, lib),
    async (shared) => (await allPages(creds, (start) => `${prefix}/collections?${pageQuery(start)}`, parseCollection, MAX_COLLECTION_PAGES, "throw", shared)).items,
    io,
  );
}

/** A tag listing: the library's tags, or those of the items in a scope (Zotero's /items/tags proxy parameters). */
export interface TagsQuery {
  /** Tag names containing (or starting with) this — Zotero compares tag names case- and diacritics-SENSITIVELY. */
  q?: string;
  qmode?: "contains" | "startswith";
  /** 0 = the user's own tags, 1 = automatic ones. */
  tagType?: 0 | 1;
  sort?: "title" | "numItems" | "dateAdded" | "dateModified";
  direction?: "asc" | "desc";
  /**
   * Only tags of these items: those in a collection (and their child notes
   * and attachments), the top-level ones, the trash, and/or those a quick
   * search, item types or item tags select.
   */
  items?: {
    collection?: string;
    subset?: "top" | "trash";
    q?: string;
    qmode?: "titleCreatorYear" | "everything";
    itemTypes?: string[];
    tag?: string;
  };
  limit: number;
  start: number;
}

/** Path + query of a tag listing. Pure. */
export function buildTagsPath(lib: Library, p: TagsQuery): string {
  const qs = new URLSearchParams();
  let path = `${libraryPrefix(lib)}/tags`;
  if (p.items) {
    const collection = p.items.collection !== undefined ? objectKey(p.items.collection, "collection") : null;
    if (collection && p.items.subset === "trash") throw invalid("the trash has no collections");
    path = `${libraryPrefix(lib)}${collection ? `/collections/${collection}` : ""}/items${p.items.subset ? `/${p.items.subset}` : ""}/tags`;
    const q = p.items.q?.trim();
    if (q) {
      qs.set("itemQ", queryParam(q, p.items.qmode === "everything" ? "everything" : "titleCreatorYear"));
      // The proxy compares the mode exactly: lower case.
      if (p.items.qmode === "everything") qs.set("itemQMode", "everything");
    }
    if (p.items.itemTypes?.length) qs.set("itemType", itemTypeParam(p.items.itemTypes));
    if (p.items.tag?.trim()) qs.set("itemTag", p.items.tag.trim());
  }
  const q = p.q?.trim();
  if (q) {
    qs.set("q", q);
    qs.set("qmode", p.qmode === "startswith" ? "startswith" : "contains");
  }
  if (p.tagType !== undefined) qs.set("tagType", String(p.tagType === 1 ? 1 : 0));
  if (p.sort) qs.set("sort", p.sort);
  if (p.direction) qs.set("direction", p.direction === "asc" ? "asc" : "desc");
  qs.set("limit", String(clampInt(p.limit, 1, LIMITS.pageSize)));
  qs.set("start", String(clampInt(p.start, 0, Number.MAX_SAFE_INTEGER)));
  return `${path}?${qs.toString()}`;
}

/** One page of a tag listing (see TagsQuery). */
export async function listTags(creds: ZoteroCreds, lib: Library, params: TagsQuery, io: IoOptions = {}): Promise<{ tags: ZoteroTag[]; paging: Paging }> {
  const res = await zoteroFetch(creds, buildTagsPath(checkedLibrary(creds, lib), params), io);
  if (res.status === 404 && params.items?.collection) {
    throw new SourceError(SOURCE, "NOT_FOUND", `${SOURCE}: the collection was not found.`, "List the collections of the library, then use one of those keys.");
  }
  if (res.status !== 200) throw unexpected(res, "listing tags");
  const tags = array(res.json(), "a tag list").flatMap((entry) => parseTag(entry) ?? []);
  return { tags, paging: parsePaging(res.headers) };
}

/** A case scan in flight: how many pages it may read, and — once its first answer is in — how many it reads. */
interface ScanRun {
  maxPages: number;
  flight: Flight<FullScan>;
  plan: Promise<number>;
}

const scanRuns = new Map<string, ScanRun>();

/**
 * The newest case items of a library, `maxPages` pages of 100, for a
 * docket-number lookup (Zotero's q never searches docketNumber). Cached;
 * a cached scan is revalidated with If-Modified-Since-Version on every
 * call, so an unchanged library costs one empty 304 and a changed one is
 * rescanned (a case added a minute ago is found). A scan of the same
 * library already running for another call, over at least as many pages,
 * serves this one too (the scan does not depend on the query).
 * `onPages` learns how many pages this call's scan covers as soon as the
 * first answer fixes it — before the other pages arrive — so a caller
 * sharing a page budget among libraries can start the next one.
 */
export async function scanCases(
  creds: ZoteroCreds,
  lib: Library,
  opts: { maxPages: number; onPages?: (pages: number) => void },
  io: IoOptions = {},
): Promise<CaseScan> {
  checkedLibrary(creds, lib);
  const maxPages = clampInt(opts.maxPages, 1, LIMITS.scanPagesTotal);
  const key = cacheKey(creds, lib);
  const running = scanRuns.get(key);
  const run = running && running.maxPages >= maxPages ? running : startScan(creds, lib, key, maxPages);
  if (opts.onPages) {
    const onPages = opts.onPages;
    run.plan.then((pages) => onPages(Math.min(pages, maxPages)), () => undefined);
  }
  const scan = await join(run.flight, io.signal, () => {
    if (scanRuns.get(key) === run) scanRuns.delete(key);
  });
  return scanView(scan, maxPages);
}

function startScan(creds: ZoteroCreds, lib: Library, key: string, maxPages: number): ScanRun {
  let fix: (pages: number) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const plan = new Promise<number>((resolve, reject) => {
    fix = resolve;
    fail = reject;
  });
  plan.catch(() => undefined);
  const flight: Flight<FullScan> = { promise: Promise.resolve(undefined as unknown as FullScan), controller: new AbortController(), waiting: 0 };
  const run: ScanRun = { maxPages, flight, plan };
  flight.promise = readScan(creds, lib, key, maxPages, flight.controller.signal, fix);
  const done = () => {
    if (scanRuns.get(key) === run) scanRuns.delete(key);
  };
  flight.promise.then(done, (error: unknown) => {
    fail(error);
    done();
  });
  scanRuns.set(key, run);
  return run;
}

async function readScan(creds: ZoteroCreds, lib: Library, key: string, maxPages: number, signal: AbortSignal, plan: (pages: number) => void): Promise<FullScan> {
  const path = (start: number) =>
    buildItemsPath(lib, { itemTypes: ["case"], sort: "dateModified", direction: "desc", limit: LIMITS.pageSize, start });
  const cached = scanCache.get(key);
  let first: ZoteroResponse;
  if (cached && cached.libraryVersion !== null && (cached.complete || cached.scannedPages >= maxPages)) {
    first = await zoteroFetch(creds, path(0), { headers: { "If-Modified-Since-Version": String(cached.libraryVersion) }, signal });
    if (first.status === 304) {
      scanCache.set(key, cached);
      plan(Math.min(cached.scannedPages, maxPages));
      return cached;
    }
  } else {
    first = await zoteroFetch(creds, path(0), { signal });
  }
  const page = (res: ZoteroResponse): unknown[] => {
    if (res.status !== 200) throw unexpected(res, "scanning case items");
    return array(res.json(), "an item list");
  };

  const pages = [page(first)];
  const firstPaging = parsePaging(first.headers);
  let complete: boolean;
  if (firstPaging.total !== null) {
    // Page 1's Total-Results fixes every other start: they go out together, not one Link at a time (the user's
    // slots keep it polite, the request count is the same). 350 cases were 4 round trips in a row, now 2.
    const count = Math.min(maxPages, Math.max(1, Math.ceil(firstPaging.total / LIMITS.pageSize)));
    plan(count);
    const rest = await Promise.all(Array.from({ length: count - 1 }, async (_, i) => page(await zoteroFetch(creds, path((i + 1) * LIMITS.pageSize), { signal }))));
    pages.push(...rest);
    complete = count * LIMITS.pageSize >= firstPaging.total;
  } else {
    // No total: follow Link rel="next".
    let next = firstPaging.nextStart;
    while (next !== null && pages.length < maxPages) {
      const res = await zoteroFetch(creds, path(next), { signal });
      pages.push(page(res));
      next = parsePaging(res.headers).nextStart;
    }
    complete = next === null;
    plan(pages.length);
  }
  const scan: FullScan = {
    items: pages.flat().map((raw) => caseEntry(parseItem(raw, lib))),
    scannedPages: pages.length,
    total: firstPaging.total,
    // Page 1's version: if the library changed mid-scan, the next revalidation sees it as changed and rescans.
    libraryVersion: firstPaging.libraryVersion,
    complete,
  };
  scanCache.set(key, scan);
  return scan;
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
 * Which items a citation or export call covers: keys (in the order asked),
 * or the top-level items of a collection (`limit` of them from `start`).
 */
export type CiteTarget = { keys: string[] } | { collection: string; limit: number; start?: number };

function citePath(lib: Library, target: CiteTarget, qs: URLSearchParams, maxKeys: number): string {
  if ("keys" in target) {
    const unique = [...new Set(target.keys.map((k) => objectKey(k, "item")))];
    if (!unique.length) throw invalid("no item key");
    if (unique.length > maxKeys) throw invalid(`at most ${maxKeys} item keys per request`);
    qs.set("itemKey", unique.join(","));
    return `${libraryPrefix(lib)}/items`;
  }
  // format=bib takes no start, sort or direction (400); the others page through the collection in the order the
  // items were added — an edit between two pages does not move a record (Zotero's default is dateModified desc).
  if (qs.get("format") !== "bib") {
    qs.set("sort", "dateAdded");
    qs.set("direction", "asc");
    if (target.start) qs.set("start", String(clampInt(target.start, 0, Number.MAX_SAFE_INTEGER)));
  }
  return `${libraryPrefix(lib)}/collections/${objectKey(target.collection, "collection")}/items/top`;
}

function checkStyle(opts: { style: string; locale: string }): void {
  if (!STYLE_RE.test(opts.style) || opts.style.length > 100) throw invalid(`"${opts.style.slice(0, 40)}" is not a citation style id (like iso690-full-note-cs)`);
  if (!LOCALE_RE.test(opts.locale)) throw invalid(`"${opts.locale.slice(0, 20)}" is not a locale (like cs-CZ)`);
}

function collectionMissing(target: CiteTarget): SourceError | null {
  return "collection" in target
    ? new SourceError(SOURCE, "NOT_FOUND", `${SOURCE}: the collection was not found.`, "List the collections of the library, then use one of those keys.")
    : null;
}

/**
 * Items formatted by Zotero's citation server (CSL, include=citation,bib):
 * each item's in-text citation (for a note style: the footnote) and
 * bibliography entry, as HTML. Keys come back in the order asked (missing
 * ones left out); a collection's in Zotero's order. A style Zotero does not
 * know answers 400 (INPUT_INVALID).
 */
export async function citeItems(
  creds: ZoteroCreds,
  lib: Library,
  target: CiteTarget,
  opts: { style: string; locale: string },
  io: IoOptions = {},
): Promise<{ items: CitedItem[]; total: number | null }> {
  checkStyle(opts);
  const qs = new URLSearchParams({ include: "data,citation,bib", style: opts.style, locale: opts.locale });
  const path = citePath(checkedLibrary(creds, lib), target, qs, LIMITS.maxCiteItems);
  qs.set("limit", String("keys" in target ? LIMITS.maxCiteItems : clampInt(target.limit, 1, LIMITS.maxCiteItems)));
  const res = await zoteroFetch(creds, `${path}?${qs.toString()}`, io);
  if (res.status === 404) throw collectionMissing(target) ?? unexpected(res, "formatting citations");
  if (res.status !== 200) throw unexpected(res, "formatting citations");
  const cited: CitedItem[] = array(res.json(), "an item list").map((raw) => {
    const o = raw as Record<string, unknown>;
    return { item: parseItem(raw, lib), citation: str(o.citation), bib: str(o.bib) };
  });
  if (!("keys" in target)) return { items: cited, total: parsePaging(res.headers).total };
  const byKey = new Map(cited.map((c) => [c.item.key, c]));
  return { items: [...new Set(target.keys)].flatMap((k) => byKey.get(k) ?? []), total: null };
}

/**
 * One bibliography of the items (format=bib), formatted and ordered by the
 * style — one call to the citation server for all of them. The entries'
 * HTML, in the style's order. A style without a bibliography (Bluebook,
 * many note styles): Zotero sends each item's citation instead, in its own
 * default order (last modified first) — `citationList` says so. Zotero
 * allows 150 items (413 above that); with keys, 100 (itemKey caps the page).
 */
export async function bibliography(
  creds: ZoteroCreds,
  lib: Library,
  target: CiteTarget,
  opts: { style: string; locale: string },
  io: IoOptions = {},
): Promise<{ entries: string[]; citationList: boolean }> {
  checkStyle(opts);
  const qs = new URLSearchParams({ format: "bib", style: opts.style, locale: opts.locale });
  const path = citePath(checkedLibrary(creds, lib), target, qs, LIMITS.maxBibItems);
  const res = await zoteroFetch(creds, `${path}?${qs.toString()}`, io);
  if (res.status === 404) throw collectionMissing(target) ?? unexpected(res, "formatting a bibliography");
  if (res.status === 413) {
    throw new SourceError(
      SOURCE,
      "INPUT_INVALID",
      `${SOURCE}: a bibliography covers at most ${LIMITS.maxCollectionBibItems} items, and this collection has more.`,
      "Format a smaller set: pass the keys of the items to cite (up to 100).",
    );
  }
  if (res.status !== 200) throw unexpected(res, "formatting a bibliography");
  const body = res.text();
  const $ = loadHtml(body);
  const entries: string[] = [];
  $(".csl-entry").each((_, el) => {
    entries.push($.html(el) ?? "");
  });
  if (entries.length) return { entries, citationList: false };
  // A style without a bibliography (Bluebook, many note styles): Zotero sends the citations as <ol><li>.
  $("li").each((_, el) => {
    entries.push($(el).html() ?? "");
  });
  if (!entries.length && htmlToText(body).trim()) entries.push(body);
  return { entries, citationList: entries.length > 0 };
}

/** Items in one of Zotero's export formats, as the text Zotero sends (keys, or `limit` top-level items of a collection from `start`). */
export async function exportItems(
  creds: ZoteroCreds,
  lib: Library,
  target: CiteTarget,
  format: ExportFormat,
  io: IoOptions = {},
): Promise<{ text: string; total: number | null }> {
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw invalid(`unknown export format "${String(format).slice(0, 20)}"`);
  const qs = new URLSearchParams({ format });
  const path = citePath(checkedLibrary(creds, lib), target, qs, LIMITS.maxBibItems);
  qs.set("limit", String("keys" in target ? LIMITS.pageSize : clampInt(target.limit, 1, LIMITS.pageSize)));
  const res = await zoteroFetch(creds, `${path}?${qs.toString()}`, io);
  if (res.status === 404) throw collectionMissing(target) ?? unexpected(res, "exporting items");
  if (res.status !== 200) throw unexpected(res, "exporting items");
  return { text: res.text(), total: parsePaging(res.headers).total };
}

/** The saved searches of a library (all pages; cached). */
export async function listSearches(creds: ZoteroCreds, lib: Library, io: IoOptions = {}): Promise<SavedSearch[]> {
  const prefix = libraryPrefix(checkedLibrary(creds, lib));
  return cachedShared(
    searchesCache,
    "searches",
    cacheKey(creds, lib),
    async (shared) => (await allPages(creds, (start) => `${prefix}/searches?${pageQuery(start)}`, parseSavedSearch, MAX_SEARCH_PAGES, "throw", shared)).items,
    io,
  );
}

let settingsCache = new TtlCache<ZoteroSettings>(CACHE_TTL_MS.settings, 200);
let schemaCache = new TtlCache<LocalizedName[]>(CACHE_TTL_MS.schema, 200);

/**
 * A library's settings (GET {lib}/settings; cached): tagColors, and in the
 * personal library also the reading positions (lastPageIndex_u_<key>,
 * lastPageIndex_g<group>_<key>) and group items' lastRead_g<group>_<key>.
 */
export async function getSettings(creds: ZoteroCreds, lib: Library, io: IoOptions = {}): Promise<ZoteroSettings> {
  const prefix = libraryPrefix(checkedLibrary(creds, lib));
  return cachedShared(
    settingsCache,
    "settings",
    cacheKey(creds, lib),
    async (shared) => {
      const res = await zoteroFetch(creds, `${prefix}/settings`, { signal: shared.signal, maxBytes: MAX_SETTINGS_BYTES });
      if (res.status !== 200) throw unexpected(res, "reading the library settings");
      return parseSettings(res.json());
    },
    io,
  );
}

/** GET {lib}/fulltext/index: whether Zotero's full-text search index of the library is complete. */
export async function getFulltextIndex(creds: ZoteroCreds, lib: Library, io: IoOptions = {}): Promise<FulltextIndexStatus> {
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/fulltext/index`, io);
  if (res.status !== 200) throw unexpected(res, "reading the full-text index status");
  const o = envelope(res.json(), "the full-text index status");
  return { status: str(o.status) ?? "?", indexedCount: nonNegInt(o.indexedCount), expectedCount: nonNegInt(o.expectedCount) };
}

/** GET {lib}/fulltext?since=N: how many attachments got full-text content after library version N (0: all that have any). */
export async function countFulltext(creds: ZoteroCreds, lib: Library, since: number, io: IoOptions = {}): Promise<number> {
  if (!Number.isSafeInteger(since) || since < 0) throw invalid("`since` is a library version (a non-negative integer)");
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/fulltext?since=${since}`, io);
  if (res.status !== 200) throw unexpected(res, "listing the attachments with full text");
  return Object.keys(envelope(res.json(), "the full-text versions")).length;
}

/** GET {lib}/deleted?since=N: what was deleted after library version N. */
export async function getDeleted(creds: ZoteroCreds, lib: Library, since: number, io: IoOptions = {}): Promise<{ deleted: DeletedObjects; libraryVersion: number | null }> {
  if (!Number.isSafeInteger(since) || since < 0) throw invalid("`since` is a library version (a non-negative integer)");
  const res = await zoteroFetch(creds, `${libraryPrefix(checkedLibrary(creds, lib))}/deleted?since=${since}`, io);
  if (res.status !== 200) throw unexpected(res, "listing deleted objects");
  const o = envelope(res.json(), "the deleted objects");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    deleted: { collections: list(o.collections), items: list(o.items), searches: list(o.searches), tags: list(o.tags), settings: list(o.settings) },
    libraryVersion: parsePaging(res.headers).libraryVersion,
  };
}

/**
 * Zotero's schema, localized (no library involved; cached a day):
 * item types, all fields, the fields and the creator types of one item type.
 */
export async function getSchemaNames(
  creds: ZoteroCreds,
  what: { kind: "itemTypes" | "itemFields" } | { kind: "itemTypeFields" | "itemTypeCreatorTypes"; itemType: string },
  locale: string,
  io: IoOptions = {},
): Promise<LocalizedName[]> {
  if (!LOCALE_RE.test(locale)) throw invalid(`"${locale.slice(0, 20)}" is not a locale (like cs-CZ)`);
  const qs = new URLSearchParams({ locale });
  if ("itemType" in what) {
    if (!/^[A-Za-z]{1,40}$/.test(what.itemType)) throw invalid(`unknown item type "${what.itemType.slice(0, 40)}"`);
    qs.set("itemType", what.itemType);
  }
  const path = `/${what.kind}?${qs.toString()}`;
  return schemaCache.through(path, async () => {
    const res = await zoteroFetch(creds, path, io);
    if (res.status !== 200) throw unexpected(res, "reading Zotero's item types and fields");
    const nameKey = what.kind === "itemTypes" ? "itemType" : what.kind === "itemTypeCreatorTypes" ? "creatorType" : "field";
    return array(res.json(), "a schema list").flatMap((e) => {
      if (!isObject(e)) return [];
      const name = str(e[nameKey])?.trim();
      return name ? [{ name, localized: str(e.localized)?.trim() || name }] : [];
    });
  });
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
 * Every page up to `maxPages`: when page 1 names Total-Results, the other
 * pages go out together (the user's slots keep it polite); else Link
 * rel="next" is followed page by page. `on404`: "empty" for a parent that
 * no longer exists, "throw" where the path must exist.
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
  const read = (res: ZoteroResponse): T[] => {
    if (res.status !== 200) throw unexpected(res, "listing");
    return array(res.json(), "a list").map(parse);
  };
  const first = await zoteroFetch(creds, pathAt(0), io);
  if (first.status === 404 && on404 === "empty") return { items, complete: true };
  items.push(...read(first));
  const paging = parsePaging(first.headers);
  if (paging.total !== null) {
    const count = Math.min(maxPages, Math.max(1, Math.ceil(paging.total / LIMITS.pageSize)));
    const rest = await Promise.all(Array.from({ length: count - 1 }, async (_, i) => read(await zoteroFetch(creds, pathAt((i + 1) * LIMITS.pageSize), io))));
    for (const list of rest) items.push(...list);
    return { items, complete: count * LIMITS.pageSize >= paging.total };
  }
  let start = 0;
  let next = paging.nextStart;
  for (let page = 1; ; page++) {
    // A "next" that does not move forward would loop forever.
    if (next === null || next <= start) return { items, complete: true };
    if (page >= maxPages) return { items, complete: false };
    start = next;
    const res = await zoteroFetch(creds, pathAt(start), io);
    items.push(...read(res));
    next = parsePaging(res.headers).nextStart;
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
