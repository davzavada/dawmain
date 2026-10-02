import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web API of the Vlastní soubory modal (src/files/web.ts) through its
 * route handlers: GET /api/files/summary, GET /api/files/documents,
 * GET/PATCH/DELETE /api/files/documents/[id] and POST /api/files/terms.
 * Clerk (session), after() and the model call are mocked; the database is PGlite with the real migrations, as
 * dawmain_app under RLS. Documents get in the way users put them there:
 * upload route + ingest.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  after: [] as Array<() => unknown>,
  propose: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => {
    throw new Error("Clerk must not be called in these tests");
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    mocks.after.push(fn);
  },
}));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: mocks.propose }));

import { GET as exportGET } from "@/app/api/files/documents/[id]/export/route";
import { DELETE as docDELETE, GET as docGET, PATCH as docPATCH } from "@/app/api/files/documents/[id]/route";
import { GET as listGET, POST as uploadPOST } from "@/app/api/files/documents/route";
import { GET as summaryGET } from "@/app/api/files/summary/route";
import { POST as termsPOST } from "@/app/api/files/terms/route";
import { __setAccessLoaderForTests, buildAccess, type Access } from "@/src/files/access";
import { PAGE_CHARS, TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { searchChannels } from "@/src/files/db/search";
import { acceptTerms, hasAcceptedTerms, setSystemState } from "@/src/files/db/usage";
import { __resetGuardsForTests, MODE_OVERRIDE_KEY } from "@/src/files/guards";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { buildTsQuery } from "@/src/files/text/analyze";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import { EXPORTS_PER_DOC_PER_DAY, exportDisposition, exportFileNames, exportFor, exportHeader } from "@/src/files/web";
import type { DocumentDetail, DocumentListResponse, SummaryResponse } from "@/src/files/web-types";
import { createTestDb, type TestDb } from "./helpers/pglite";

// ---------------------------------------------------------------------------
// Fixtures

const ORIGIN = { origin: "https://dawmain.cz", host: "dawmain.cz" };
const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCE = "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti a její předpoklady.";

function dmd(pages: number, salt: string): string {
  const out: string[] = [];
  for (let p = 0; p < pages; p++) out.push(`[s. ${p + 1}]`, "", `## § ${2913 + p} [Ustanovení]`, "", `${SENTENCE} ${SENTENCE} ${salt}`, "");
  return out.join("\n");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function uploadRequest(lib: string, text: string): Request {
  const meta: UploadMeta = {
    library_id: lib,
    file: { name: "komentar.pdf", bytes: 2_400_000, sha256: "a".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 3, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
  };
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("dmd", new Blob([new Uint8Array(gzipSync(Buffer.from(text, "utf8"))) as Uint8Array<ArrayBuffer>]), "d.gz");
  return new Request("https://dawmain.cz/api/files/documents", { method: "POST", body: form, headers: ORIGIN });
}

const ACCESS: Record<string, Access> = {
  // The owner of a Pro library.
  user_a: buildAccess({ id: "user_a", publicMetadata: { pro: true } }),
  // A stranger with a Pro library of their own.
  user_x: buildAccess({ id: "user_x", publicMetadata: { pro: true } }),
  // Never had Pro.
  user_none: buildAccess({ id: "user_none", publicMetadata: {} }),
};
let access: Record<string, Access> = { ...ACCESS };
const loadAccess = async (userId: string) => access[userId] ?? buildAccess({ id: userId });

/** Change a user's access; re-registering the loader drops the cached one. */
function setAccess(userId: string, next: Access): void {
  access[userId] = next;
  __setAccessLoaderForTests(loadAccess);
}

// ---------------------------------------------------------------------------

let t: TestDb;
const ENV = { ...process.env };

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  await t.close();
});
beforeEach(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  access = { ...ACCESS };
  __setAccessLoaderForTests(loadAccess);
  mocks.auth.mockReset();
  mocks.after.length = 0;
  mocks.propose.mockReset();
  mocks.propose.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
  for (const user of Object.keys(ACCESS)) await t.runner([], (db) => acceptTerms(db, user, TERMS_VERSION));
});
afterEach(async () => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
  for (const table of ["documents", "libraries", "usage_daily", "audit_log", "system_state", "terms_acceptance", "db_activity"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

const signedIn = (userId: string | null) => mocks.auth.mockResolvedValue({ userId });
const runAfter = async () => {
  for (const fn of mocks.after.splice(0)) await fn();
};
const row = async (id: string) =>
  (await t.owner.query<{ status: string; title: string | null; meta_version: number; doc_type: string | null }>(
    "SELECT status, title, meta_version, doc_type FROM documents WHERE id = $1",
    [id],
  )).rows[0];

/** Upload as `user` into `lib` and run the ingest: the document ends in 'review'. */
async function uploaded(user: string, lib: string, salt: string): Promise<string> {
  signedIn(user);
  const res = await uploadPOST(uploadRequest(lib, dmd(3, salt)));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  // The review step (a library with autoConfirm: false) — what these tests exercise.
  await t.owner.query(`UPDATE libraries SET settings = settings || '{"autoConfirm": false}'::jsonb WHERE id = $1`, [lib]);
  await runAfter();
  expect((await row(id)).status).toBe("review");
  return id;
}

const ctx = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });
const get = (url: string) => new Request(`https://dawmain.cz${url}`);
const send = (url: string, method: string, body?: unknown, headers: Record<string, string> = ORIGIN) =>
  new Request(`https://dawmain.cz${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function detail(user: string, id: string): Promise<Response> {
  signedIn(user);
  return docGET(get(`/api/files/documents/${id}`), ctx("id", id));
}

async function patch(user: string, id: string, body: unknown): Promise<Response> {
  signedIn(user);
  return docPATCH(send(`/api/files/documents/${id}`, "PATCH", body), ctx("id", id));
}

async function del(user: string, id: string, headers?: Record<string, string>): Promise<Response> {
  signedIn(user);
  return docDELETE(send(`/api/files/documents/${id}`, "DELETE", undefined, headers), ctx("id", id));
}

const META = (over: Record<string, unknown> = {}) => ({
  doc_type: "kniha",
  title: "Občanský zákoník. Komentář",
  authors: ["Jan Petrov"],
  editors: [],
  isbn: [],
  keywords: [],
  language: "cs",
  ...over,
});

// ---------------------------------------------------------------------------

describe("GET /api/files/summary", () => {
  it("signed out is a normal answer, not an error", async () => {
    signedIn(null);
    const res = await summaryGET(get("/api/files/summary"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "signed_out" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("env off → unavailable without touching Clerk or the database", async () => {
    process.env.FILES_MODE = "off";
    const runner = vi.fn();
    setScopeRunner(runner as never);
    signedIn("user_a");
    const body = (await (await summaryGET(get("/api/files/summary"))).json()) as SummaryResponse;
    expect(body).toEqual({ state: "unavailable", mode: "off" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("a user without any Pro library never wakes the database", async () => {
    const runner = vi.fn();
    setScopeRunner(runner as never);
    signedIn("user_none");
    const body = (await (await summaryGET(get("/api/files/summary"))).json()) as SummaryResponse;
    expect(body.state).toBe("ok");
    if (body.state !== "ok") return;
    expect(body.libraries).toHaveLength(1);
    expect(body.libraries[0]).toMatchObject({ id: "user_none", pro: false, counts: null, pagesUsed: null });
    expect(runner).not.toHaveBeenCalled();
  });

  it("counts, pages and terms for a Pro user: one personal library, no team fields", async () => {
    const a = await uploaded("user_a", "user_a", "a");
    await uploaded("user_a", "user_a", "b");
    signedIn("user_a");
    await patch("user_a", a, { action: "confirm", version: (await row(a)).meta_version, meta: META() });
    const body = (await (await summaryGET(get("/api/files/summary"))).json()) as SummaryResponse;
    if (body.state !== "ok") throw new Error("expected ok");
    expect(body.mode).toBe("on");
    expect(body.termsAccepted).toBe(true);
    expect(body.libraries).toHaveLength(1);
    const personal = body.libraries[0];
    expect(personal).toMatchObject({ id: "user_a", kind: "user", role: "owner", name: "Osobní" });
    expect(personal).not.toHaveProperty("memberCount");
    expect(personal.counts).toMatchObject({ total: 2, ready: 1, review: 1, searchable: 1 });
    expect(personal.pagesUsed).toBeGreaterThan(0);
  });
});

describe("GET /api/files/documents?lib=", () => {
  it("lists the owner's documents with their rights, pages and publication", async () => {
    const id = await uploaded("user_a", "user_a", "m");
    signedIn("user_a");
    const res = await listGET(get("/api/files/documents?lib=user_a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentListResponse;
    expect(body.total).toBe(1);
    expect(body.documents[0]).toMatchObject({ id, mine: true, canEdit: true, canDelete: true, fileBytes: 2_400_000, status: "review", physicalPages: 3 });
    expect(body.documents[0].publication).toBeNull();
    // No on/off switch and no uploader names any more.
    expect(body.documents[0]).not.toHaveProperty("enabled");
    expect(body.documents[0]).not.toHaveProperty("uploaderName");
    // An article names where it appeared.
    await patch("user_a", id, { action: "save", version: (await row(id)).meta_version, meta: META({ doc_type: "clanek", container_title: "Právník", issue: "2", year: "2024" }) });
    signedIn("user_a");
    const after = (await (await listGET(get("/api/files/documents?lib=user_a"))).json()) as DocumentListResponse;
    expect(after.documents[0].publication).toBe("Právník 2/2024");
  });

  it("a foreign or unknown library is 404 either way", async () => {
    await uploaded("user_a", "user_a", "a");
    signedIn("user_x");
    for (const lib of ["user_a", "org_t", "user_nobody", "not-a-lib"]) {
      const res = await listGET(get(`/api/files/documents?lib=${lib}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Knihovna nenalezena." });
    }
  });

  it("a user who lost Pro still lists (and deletes) what they stored", async () => {
    const id = await uploaded("user_x", "user_x", "x");
    setAccess("user_x", buildAccess({ id: "user_x", publicMetadata: {} }));
    signedIn("user_x");
    const body = (await (await listGET(get("/api/files/documents?lib=user_x"))).json()) as DocumentListResponse;
    expect(body.documents.map((d) => d.id)).toEqual([id]);
    // Editing needs Pro; deleting (and exporting) only ownership.
    expect(body.documents[0]).toMatchObject({ canEdit: false, canDelete: true });
    expect((await del("user_x", id)).status).toBe(200);
  });
});

describe("GET /api/files/documents/[id]", () => {
  it("detail with a plain-text preview", async () => {
    const id = await uploaded("user_a", "user_a", "m");
    const res = await detail("user_a", id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentDetail;
    expect(body.libraryName).toBe("Osobní");
    expect(body.physicalPages).toBe(3);
    expect(body).not.toHaveProperty("enabled");
    expect(body.preview).toContain("Komentované ustanovení");
    // Markup is stripped: no page markers or heading hashes.
    expect(body.preview).not.toContain("[s. 1]");
    expect(body.preview).not.toContain("##");
    expect(body.preview.length).toBeLessThanOrEqual(1_501);
  });

  it("foreign, unknown and malformed ids are the same 404", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    for (const [user, docId] of [
      ["user_x", id],
      ["user_none", id],
      ["user_a", "00000000-0000-4000-8000-000000000000"],
      ["user_a", "../../etc"],
    ]) {
      const res = await detail(user, docId);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Dokument nenalezen." });
    }
  });
});

describe("PATCH /api/files/documents/[id]", () => {
  it("confirm: review → ready with the validated metadata, meta_version bumped", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    const before = await row(id);
    const res = await patch("user_a", id, { action: "confirm", version: before.meta_version, meta: META({ year: "2019", isbn: "978-80-7400-773-6" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentDetail;
    expect(body.status).toBe("ready");
    expect(body.meta.title).toBe("Občanský zákoník. Komentář");
    expect(body.meta.year).toBe(2019);
    expect((await row(id)).meta_version).toBe(before.meta_version + 1);
  });

  it("a stale version is 409; a document still processing is 409 with its own message", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    const v = (await row(id)).meta_version;
    expect((await patch("user_a", id, { action: "save", version: v, meta: META() })).status).toBe(200);
    const stale = await patch("user_a", id, { action: "save", version: v, meta: META() });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain("upravil někdo jiný");
  });

  it("another user cannot edit the owner's document: the same 404 as a missing one", async () => {
    const id = await uploaded("user_a", "user_a", "m");
    const v = (await row(id)).meta_version;
    const res = await patch("user_x", id, { action: "confirm", version: v, meta: META() });
    expect(res.status).toBe(404);
    expect((await row(id)).meta_version).toBe(v);
    expect((await patch("user_a", id, { action: "confirm", version: v, meta: META() })).status).toBe(200);
  });

  it("the metadata schema rejects oversized and unknown input with field messages", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    const v = (await row(id)).meta_version;
    const long = await patch("user_a", id, { action: "confirm", version: v, meta: META({ title: "x".repeat(301) }) });
    expect(long.status).toBe(422);
    const body = (await long.json()) as { error: string; fields: Record<string, string> };
    expect(body.fields.title).toMatch(/nejvýš 300/);
    const unknown = await patch("user_a", id, { action: "confirm", version: v, meta: META({ injected: "x" }) });
    expect(unknown.status).toBe(422);
    const authors = await patch("user_a", id, { action: "confirm", version: v, meta: META({ authors: Array.from({ length: 11 }, (_, i) => `Autor ${i}`) }) });
    expect(authors.status).toBe(422);
    // A commentary needs its act to be confirmed, not to be saved as a draft.
    expect((await patch("user_a", id, { action: "confirm", version: v, meta: META({ doc_type: "komentar" }) })).status).toBe(422);
    expect((await patch("user_a", id, { action: "save", version: v, meta: META({ doc_type: "komentar" }) })).status).toBe(200);
    expect((await row(id)).title).toBe("Občanský zákoník. Komentář");
  });

  it("a body over 64 KB is 413, malformed JSON 400, an unknown action 400", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    signedIn("user_a");
    const huge = await docPATCH(send(`/api/files/documents/${id}`, "PATCH", JSON.stringify({ action: "save", version: 0, meta: { title: "x".repeat(70_000) } })), ctx("id", id));
    expect(huge.status).toBe(413);
    expect((await docPATCH(send(`/api/files/documents/${id}`, "PATCH", "{not json"), ctx("id", id))).status).toBe(400);
    expect((await patch("user_a", id, { action: "publish" })).status).toBe(400);
  });

  it("the on/off switch is gone: an enable action is 400 and the document stays searchable", async () => {
    const id = await uploaded("user_a", "user_a", "hledej");
    await patch("user_a", id, { action: "confirm", version: (await row(id)).meta_version, meta: META() });
    const q = buildTsQuery("odpovědnost škodu");
    const search = () =>
      t.runner(["user_a"], (db) =>
        searchChannels(db, { libraryIds: ["user_a"], tsAnd: q.and, tsOr: q.or, identKeys: [], perDoc: 3, limit: 60 }),
      );
    expect((await search()).some((h) => h.docId === id)).toBe(true);
    expect((await patch("user_a", id, { action: "enable", enabled: false })).status).toBe(400);
    expect((await search()).some((h) => h.docId === id)).toBe(true);
  });

  it("read-only mode refuses edits", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    const v = (await row(id)).meta_version;
    await t.runner([], (db) => setSystemState(db, MODE_OVERRIDE_KEY, { mode: "readonly" }));
    __resetGuardsForTests();
    const res = await patch("user_a", id, { action: "save", version: v, meta: META() });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("jen pro čtení");
    expect((await row(id)).meta_version).toBe(v);
  });

  it("changing the type re-derives the index after the response", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    mocks.after.length = 0;
    await patch("user_a", id, { action: "confirm", version: (await row(id)).meta_version, meta: META({ doc_type: "komentar", commented_act: "89/2012" }) });
    expect(mocks.after).toHaveLength(1);
    await runAfter();
    const keys = (await t.owner.query<{ ident_keys: string[] }>("SELECT ident_keys FROM documents WHERE id = $1", [id])).rows[0].ident_keys;
    expect(keys).toContain("zak:89/2012");
    const chunkKeys = (await t.owner.query<{ k: string }>("SELECT unnest(ident_keys) AS k FROM chunks WHERE doc_id = $1", [id])).rows.map((r) => r.k);
    expect(chunkKeys).toContain("parz:89/2012/2913");
    expect((await row(id)).status).toBe("ready");
    // Same type again: nothing to re-derive.
    mocks.after.length = 0;
    await patch("user_a", id, { action: "confirm", version: (await row(id)).meta_version, meta: META({ doc_type: "komentar", commented_act: "89/2012", year: "2020" }) });
    expect(mocks.after).toHaveLength(0);
  });
});

describe("DELETE /api/files/documents/[id]", () => {
  it("a stranger gets 404; the owner deletes, and the pages come back", async () => {
    const id = await uploaded("user_a", "user_a", "m");
    const pages = async () => (await t.owner.query<{ page_count: number; doc_count: number }>("SELECT page_count, doc_count FROM libraries WHERE id = 'user_a'")).rows[0];
    expect((await pages()).doc_count).toBe(1);
    const refused = await del("user_x", id);
    expect(refused.status).toBe(404);
    expect(await row(id)).toBeDefined();
    expect((await del("user_a", id)).status).toBe(200);
    expect(await row(id)).toBeUndefined();
    expect(await pages()).toEqual({ page_count: 0, doc_count: 0 });
    const audit = await t.owner.query<{ actor: string; action: string }>("SELECT actor, action FROM audit_log WHERE action = 'document.delete'");
    expect(audit.rows).toEqual([{ actor: "user_a", action: "document.delete" }]);
    // Gone is gone: a second delete is 404.
    expect((await del("user_a", id)).status).toBe(404);
  });

  it("read-only mode still allows deleting", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    await t.runner([], (db) => setSystemState(db, MODE_OVERRIDE_KEY, { mode: "readonly" }));
    __resetGuardsForTests();
    expect((await del("user_a", id)).status).toBe(200);
  });

  it("cross-site requests are refused before authentication", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    mocks.auth.mockClear();
    const res = await del("user_a", id, { origin: "https://evil.example", host: "dawmain.cz" });
    expect(res.status).toBe(403);
    expect(await row(id)).toBeDefined();
  });

  it("env off answers 503 before anything else", async () => {
    process.env.FILES_MODE = "off";
    const res = await del("user_a", "00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(503);
  });
});

describe("rights after Pro is revoked (edit needs Pro, delete and export only ownership)", () => {
  it("an owner who lost Pro cannot save or confirm — no re-derivation is scheduled", async () => {
    const id = await uploaded("user_x", "user_x", "x");
    setAccess("user_x", buildAccess({ id: "user_x", publicMetadata: {} }));
    const v = (await row(id)).meta_version;
    mocks.after.length = 0;
    for (const body of [
      { action: "save", version: v, meta: META({ doc_type: "komentar" }) },
      { action: "confirm", version: v, meta: META() },
    ]) {
      const res = await patch("user_x", id, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("Pro");
    }
    expect(mocks.after).toHaveLength(0);
    expect(await row(id)).toMatchObject({ meta_version: v, status: "review" });
    const audit = await t.owner.query("SELECT 1 FROM audit_log WHERE action IN ('document.meta', 'document.confirm')");
    expect(audit.rows).toHaveLength(0);
    // Deleting still works: what they stored stays theirs.
    expect((await del("user_x", id)).status).toBe(200);
  });

});

describe("GET /api/files/documents/[id]/export?lib=", () => {
  const exportOf = (user: string, id: string, lib: string | null, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => {
    signedIn(user);
    const q = lib === null ? "" : `?lib=${lib}`;
    return exportGET(new Request(`https://dawmain.cz/api/files/documents/${id}/export${q}`, { headers }), ctx("id", id));
  };
  /** Pages an export of dmd(pages, …) spends from the user's daily budget. */
  const exportPages = (pages: number) => Math.max(1, Math.ceil(normalizeDmd(dmd(pages, "a")).text.length / PAGE_CHARS));
  const splitExport = (body: string) => {
    const end = body.indexOf("\n---\n\n");
    expect(body.startsWith("---\n")).toBe(true);
    expect(end).toBeGreaterThan(0);
    return { header: body.slice(0, end + 5), text: body.slice(end + 6) };
  };

  it("the uploader downloads the stored text with a metadata header, as an audited attachment", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    await patch("user_a", id, { action: "confirm", version: (await row(id)).meta_version, meta: META({ year: "2019", authors: ["Jan Petrov", "Eva Dvořáková"] }) });
    const res = await exportOf("user_a", id, "user_a");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Obcansky-zakonik.-Komentar.md\"; filename*=UTF-8''Ob%C4%8Dansk%C3%BD%20z%C3%A1kon%C3%ADk.%20Koment%C3%A1%C5%99.md",
    );
    const { header, text } = splitExport(await res.text());
    expect(header).toContain('title: "Občanský zákoník. Komentář"');
    expect(header).toContain('authors: ["Jan Petrov", "Eva Dvořáková"]');
    expect(header).toContain("year: 2019");
    expect(header).toMatch(/\nuploaded: \d{4}-\d{2}-\d{2}\n/);
    expect(text).toBe(normalizeDmd(dmd(3, "a")).text);
    const audit = await t.owner.query<{ actor: string; detail: Record<string, unknown> }>("SELECT actor, detail FROM audit_log WHERE action = 'document.export'");
    expect(audit.rows).toEqual([{ actor: "user_a", detail: { chars: text.length, byAdmin: false } }]);
  });

  it("ownership only: the owner exports after losing Pro, nobody else", async () => {
    const own = await uploaded("user_a", "user_a", "m");
    const foreign = await uploaded("user_x", "user_x", "n");
    setAccess("user_a", buildAccess({ id: "user_a", publicMetadata: {} }));
    expect((await exportOf("user_a", own, "user_a")).status).toBe(200);
    // A stranger, the wrong library, no library, another's document and a malformed id: the same 404 family.
    for (const [user, id, lib, error] of [
      ["user_x", own, "user_a", "Knihovna nenalezena."],
      ["user_a", own, "user_x", "Knihovna nenalezena."],
      ["user_a", own, null, "Knihovna nenalezena."],
      ["user_a", foreign, "user_a", "Dokument nenalezen."],
      ["user_a", "../../etc", "user_a", "Dokument nenalezen."],
    ] as const) {
      const res = await exportOf(user, id, lib);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error });
    }
    const audit = await t.owner.query<{ actor: string; byAdmin: boolean }>(
      "SELECT actor, (detail->>'byAdmin')::boolean AS \"byAdmin\" FROM audit_log WHERE action = 'document.export' ORDER BY id",
    );
    expect(audit.rows).toEqual([{ actor: "user_a", byAdmin: false }]);
  });

  it("works in read-only mode; a document still processing is 409", async () => {
    signedIn("user_a");
    const res = await uploadPOST(uploadRequest("user_a", dmd(3, "q")));
    const { id } = (await res.json()) as { id: string };
    mocks.after.length = 0;
    const busy = await exportOf("user_a", id, "user_a");
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("zpracovává");
    const done = await uploaded("user_a", "user_a", "r");
    await t.runner([], (db) => setSystemState(db, MODE_OVERRIDE_KEY, { mode: "readonly" }));
    __resetGuardsForTests();
    expect((await exportOf("user_a", done, "user_a")).status).toBe(200);
  });

  it("cross-site, signed out and env off are refused; a link without Sec-Fetch-Site works", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    for (const site of ["cross-site", "same-site"]) {
      mocks.auth.mockClear();
      const res = await exportOf("user_a", id, "user_a", { "sec-fetch-site": site });
      expect(res.status).toBe(403);
      expect(mocks.auth).not.toHaveBeenCalled();
    }
    expect((await exportOf("user_a", id, "user_a", {})).status).toBe(200);
    expect((await exportOf("user_a", id, "user_a", { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await exportOf(null as never, id, "user_a")).status).toBe(401);
    process.env.FILES_MODE = "off";
    expect((await exportOf("user_a", id, "user_a")).status).toBe(503);
  });

  it("a daily cap per document, separate from the MCP read cap", async () => {
    const id = await uploaded("user_a", "user_a", "a");
    for (let i = 0; i < EXPORTS_PER_DOC_PER_DAY; i++) expect((await exportOf("user_a", id, "user_a")).status).toBe(200);
    const capped = await exportOf("user_a", id, "user_a");
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: string }).error).toContain("zítra");
    const counters = await t.owner.query<{ scope: string; reads: number; pages: number }>(
      "SELECT scope, reads, pages FROM usage_daily WHERE starts_with(scope, 'read:') ORDER BY scope",
    );
    // Compared as a set: the document id is random, so ORDER BY scope puts it before or after "export".
    expect(counters.rows).toHaveLength(2);
    expect(counters.rows).toEqual(
      expect.arrayContaining([
        { scope: `read:user_a:${id}:export`, reads: EXPORTS_PER_DOC_PER_DAY, pages: 0 },
        { scope: "read:user_a:export", reads: 0, pages: EXPORTS_PER_DOC_PER_DAY * exportPages(3) },
      ]),
    );
  });

  it("a daily budget per user across documents: a second full library in one day is refused", async () => {
    const ids = [await uploaded("user_a", "user_a", "a"), await uploaded("user_a", "user_a", "b")];
    const theirs = await uploaded("user_x", "user_x", "m");
    // The budget is one library's quota; shrink it to these two documents.
    process.env.FILES_PERSONAL_PAGES = String(2 * exportPages(3));
    for (const id of ids) expect((await exportOf("user_a", id, "user_a")).status).toBe(200);
    for (const id of ids) {
      const capped = await exportOf("user_a", id, "user_a");
      expect(capped.status).toBe(429);
      expect(((await capped.json()) as { error: string }).error).toContain("zítra");
    }
    // A refusal spends nothing: neither the document's count nor the budget grew.
    const counters = await t.owner.query<{ scope: string; reads: number; pages: number }>(
      "SELECT scope, reads, pages FROM usage_daily WHERE starts_with(scope, 'read:') ORDER BY scope",
    );
    expect(counters.rows.find((r) => r.scope === "read:user_a:export")).toMatchObject({ pages: 2 * exportPages(3) });
    expect(counters.rows.filter((r) => r.scope.endsWith(":export") && r.scope !== "read:user_a:export").map((r) => r.reads)).toEqual([1, 1]);
    const audit = await t.owner.query("SELECT 1 FROM audit_log WHERE action = 'document.export'");
    expect(audit.rows).toHaveLength(2);
    // Another user has a budget of their own.
    expect((await exportOf("user_x", theirs, "user_x")).status).toBe(200);
  });

  it("streams in batches and reassembles the exact text; a document deleted mid-download errors the stream", async () => {
    // Long enough for several ~12k-char storage blocks: each batch is at least one block.
    signedIn("user_a");
    const res = await uploadPOST(uploadRequest("user_a", dmd(150, "ž")));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await runAfter();
    const blocks = await t.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_blocks WHERE doc_id = $1", [id]);
    expect(blocks.rows[0].n).toBeGreaterThanOrEqual(3);
    const want = normalizeDmd(dmd(150, "ž")).text;
    const out = await exportFor("user_a", id, "user_a", { batchChars: 7 });
    expect(out.disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.md"; filename\*=UTF-8''/);
    expect(splitExport(await new Response(out.body).text()).text).toBe(want);

    const cut = await exportFor("user_a", id, "user_a", { batchChars: 7 });
    const reader = cut.body.getReader();
    await reader.read();
    await t.owner.query("DELETE FROM documents WHERE id = $1", [id]);
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return "ended";
      })(),
    ).rejects.toThrow(/changed during the export/);
  });

  it("file names and the header are safe whatever the metadata says", () => {
    expect(exportFileNames("Smlouva o dílo: vzor / 2024 \"final\"")).toEqual({ ascii: "Smlouva-o-dilo-vzor-2024-final.md", utf8: "Smlouva o dílo vzor 2024 final.md" });
    expect(exportFileNames("...")).toEqual({ ascii: "dokument.md", utf8: "dokument.md" });
    expect(exportFileNames("Příliš žluťoučký kůň").ascii).toBe("Prilis-zlutoucky-kun.md");
    // RFC 5987 leaves ' ( ) * ! unescaped in encodeURIComponent: they are escaped here (and * is dropped as unsafe in a file name).
    expect(exportDisposition("Ať (zkouška)'s *!")).toBe("attachment; filename=\"At-zkouska-s.md\"; filename*=UTF-8''A%C5%A5%20%28zkou%C5%A1ka%29%27s%20%21.md");
    const header = exportHeader(
      {
        meta: { title: "Název\n---\n# vložené", authors: ["A\nB"], year: 2020, doc_type: "clanek" },
        file_name: "a.pdf",
        uploaded_at: "2026-09-01T10:00:00.000Z",
      } as never,
      "Osobní",
      new Date("2026-09-27T12:00:00Z"),
    );
    expect(header.split("\n").filter((l) => l === "---")).toHaveLength(2);
    expect(header).toContain('title: "Název --- # vložené"');
    expect(header).toContain('authors: ["A B"]');
    expect(header).toContain("uploaded: 2026-09-01\nexported: 2026-09-27\n");
  });
});

describe("POST /api/files/terms", () => {
  it("records the acceptance of the current version", async () => {
    await t.owner.query("DELETE FROM terms_acceptance");
    signedIn("user_x");
    const res = await termsPOST(send("/api/files/terms", "POST", { accept: true, version: TERMS_VERSION }));
    expect(res.status).toBe(200);
    expect(await t.runner([], (db) => hasAcceptedTerms(db, "user_x", TERMS_VERSION))).toBe(true);
  });

  it("refuses an old version, a user without Pro and malformed bodies", async () => {
    signedIn("user_x");
    expect((await termsPOST(send("/api/files/terms", "POST", { accept: true, version: "2020-01" }))).status).toBe(409);
    expect((await termsPOST(send("/api/files/terms", "POST", { accept: false, version: TERMS_VERSION }))).status).toBe(400);
    signedIn("user_none");
    expect((await termsPOST(send("/api/files/terms", "POST", { accept: true, version: TERMS_VERSION }))).status).toBe(403);
  });
});
