import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Originals and folders (0008_originals_folders.sql, src/files/originals.ts,
 * src/files/folders.ts) through their route handlers: the schema under RLS,
 * the original upload in parts (PUT ?part=N, POST finalize, GET download),
 * folders (create / rename / move / delete) and document rename / move.
 * Clerk (session) and after() are mocked; the database is PGlite with the
 * real migrations, as dawmain_app under RLS.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  after: [] as Array<() => unknown>,
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

import { GET as originalGET, POST as originalPOST, PUT as originalPUT } from "@/app/api/files/documents/[id]/original/route";
import { PATCH as docPATCH } from "@/app/api/files/documents/[id]/route";
import { GET as listGET, POST as uploadPOST } from "@/app/api/files/documents/route";
import { DELETE as folderDELETE, PATCH as folderPATCH } from "@/app/api/files/folders/[id]/route";
import { POST as folderPOST } from "@/app/api/files/folders/route";
import { storageCheck } from "@/app/_zdroje/upload-core";
import { formatBytes, zBefore } from "@/src/files/bytes";
import { quotaMessage } from "@/src/files/upload";
import { __setAccessLoaderForTests, buildAccess, type Access, type ClerkMembershipLike } from "@/src/files/access";
import { ORIGINAL_PART_BYTES, TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { folderGone, freeName } from "@/src/files/db/folders";
import { purgeLibraryContent } from "@/src/files/db/libraries";
import { abandonStaleOriginals } from "@/src/files/db/originals";
import { acceptTerms } from "@/src/files/db/usage";
import { cleanName } from "@/src/files/folders";
import { __resetGuardsForTests } from "@/src/files/guards";
import { originalDisposition, partCount, partSize } from "@/src/files/originals";
import type { ConversionQuality, FileKind, UploadMeta } from "@/src/files/types";
import { renamedFileName } from "@/src/files/web";
import type { DocumentDetail, DocumentListResponse, FolderItem } from "@/src/files/web-types";
import { createTestDb, type TestDb } from "./helpers/pglite";

// ---------------------------------------------------------------------------
// Fixtures

const ORIGIN = { origin: "https://dawmain.cz", host: "dawmain.cz" };
const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCE = "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti a její předpoklady.";

function dmd(salt: string): string {
  const out: string[] = [];
  for (let p = 0; p < 3; p++) out.push(`[s. ${p + 1}]`, "", `## § ${2913 + p} [Ustanovení]`, "", `${SENTENCE} ${SENTENCE} ${salt}`, "");
  return out.join("\n");
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

const team = (id: string, role: "org:admin" | "org:member", pro = true): ClerkMembershipLike => ({
  role,
  organization: { id, name: "Spory", slug: "spory", publicMetadata: { pro }, imageUrl: "https://img.clerk.com/logo.png", hasImage: true },
});

const ACCESS: Record<string, Access> = {
  user_a: buildAccess({ id: "user_a", publicMetadata: { pro: true } }, [team("org_t", "org:member")]),
  user_b: buildAccess({ id: "user_b", publicMetadata: { pro: true } }, [team("org_t", "org:member")]),
  user_boss: buildAccess({ id: "user_boss", publicMetadata: { pro: true } }, [team("org_t", "org:admin")]),
  user_x: buildAccess({ id: "user_x", publicMetadata: { pro: true } }),
};
let access: Record<string, Access> = { ...ACCESS };
const loadAccess = async (userId: string) => access[userId] ?? buildAccess({ id: userId });

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
  for (const user of Object.keys(ACCESS)) await t.runner([], (db) => acceptTerms(db, user, TERMS_VERSION));
});
afterEach(async () => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
  for (const table of ["documents", "folders", "libraries", "usage_daily", "audit_log", "system_state", "terms_acceptance", "db_activity"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

const signedIn = (userId: string | null) => mocks.auth.mockResolvedValue({ userId });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (path: string) => `https://dawmain.cz${path}`;
const json = (path: string, method: string, body: unknown) =>
  new Request(url(path), { method, headers: { ...ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

/** Upload the text layer as `user` into `lib`, announcing an original of `file` (or none). */
async function uploadDoc(
  user: string,
  lib: string,
  salt: string,
  opts: { file?: Uint8Array; kind?: FileKind; name?: string; folderId?: string | null } = {},
): Promise<string> {
  const text = dmd(salt);
  const kind = opts.kind ?? "pdf";
  const meta: UploadMeta = {
    library_id: lib,
    file: {
      name: opts.name ?? `komentar.${kind}`,
      bytes: opts.file?.byteLength ?? 1_000,
      sha256: opts.file ? sha256(opts.file) : "a".repeat(64),
      kind,
    },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 3, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
    ...(opts.file ? { original: true } : {}),
    ...(opts.folderId !== undefined ? { folderId: opts.folderId } : {}),
  };
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("dmd", new Blob([new Uint8Array(gzipSync(Buffer.from(text, "utf8"))) as Uint8Array<ArrayBuffer>]), "d.gz");
  signedIn(user);
  const res = await uploadPOST(new Request(url("/api/files/documents"), { method: "POST", body: form, headers: ORIGIN }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function putPart(user: string, id: string, part: number | string, body: Uint8Array, headers: Record<string, string> = ORIGIN): Promise<Response> {
  signedIn(user);
  return originalPUT(
    new Request(url(`/api/files/documents/${id}/original?part=${part}`), {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: body as Uint8Array<ArrayBuffer>,
    }),
    ctx(id),
  );
}

async function finalize(user: string, id: string): Promise<Response> {
  signedIn(user);
  return originalPOST(new Request(url(`/api/files/documents/${id}/original`), { method: "POST", headers: ORIGIN }), ctx(id));
}

async function download(user: string, id: string, query = ""): Promise<Response> {
  signedIn(user);
  return originalGET(new Request(url(`/api/files/documents/${id}/original${query}`)), ctx(id));
}

/** Send every part of `file` and finalize. */
async function sendOriginal(user: string, id: string, file: Uint8Array): Promise<Response> {
  for (let n = 0; n < partCount(file.byteLength); n++) {
    const start = n * ORIGINAL_PART_BYTES;
    expect((await putPart(user, id, n, file.subarray(start, start + partSize(file.byteLength, n)))).status).toBe(204);
  }
  return finalize(user, id);
}

const originalStatus = async (id: string) =>
  (await t.owner.query<{ original_status: string }>("SELECT original_status FROM documents WHERE id = $1", [id])).rows[0]?.original_status;
const partRows = async (id: string) => Number((await t.owner.query<{ n: string }>("SELECT count(*) AS n FROM doc_originals WHERE doc_id = $1", [id])).rows[0].n);

async function createFolder(user: string, lib: string, name: string, parentId: string | null = null): Promise<Response> {
  signedIn(user);
  return folderPOST(json("/api/files/folders", "POST", { lib, parentId, name }));
}
async function folderId(user: string, lib: string, name: string, parentId: string | null = null): Promise<string> {
  const res = await createFolder(user, lib, name, parentId);
  expect(res.status).toBe(201);
  return ((await res.json()) as FolderItem).id;
}
async function patchFolder(user: string, id: string, body: unknown): Promise<Response> {
  signedIn(user);
  return folderPATCH(json(`/api/files/folders/${id}`, "PATCH", body), ctx(id));
}
async function patchDoc(user: string, id: string, body: unknown): Promise<Response> {
  signedIn(user);
  return docPATCH(json(`/api/files/documents/${id}`, "PATCH", body), ctx(id));
}
async function list(user: string, lib: string): Promise<DocumentListResponse> {
  signedIn(user);
  const res = await listGET(new Request(url(`/api/files/documents?lib=${lib}`)));
  expect(res.status).toBe(200);
  return (await res.json()) as DocumentListResponse;
}
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

// ---------------------------------------------------------------------------

describe("schema: folders and doc_originals under RLS", () => {
  async function seed(lib: string, sha: string): Promise<{ doc: string; folder: string }> {
    await t.owner.query("INSERT INTO libraries (id) VALUES ($1) ON CONFLICT DO NOTHING", [lib]);
    const folder = (await t.owner.query<{ id: string }>("INSERT INTO folders (library_id, name, created_by) VALUES ($1, 'F', 'user_u') RETURNING id", [lib])).rows[0].id;
    const doc = (
      await t.owner.query<{ id: string }>(
        `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256,
           converter, rights, billable_pages, char_count, page_label_source, folder_id, original_status, file_bytes)
         VALUES ($1, 'ready', 'user_u', 'pdf', 'a.pdf', $2, $2, 'pdf@1', 'verejne', 1, 10, 'physical', $3, 'ready', 3) RETURNING id`,
        [lib, sha, folder],
      )
    ).rows[0].id;
    await t.owner.query("INSERT INTO doc_originals (doc_id, library_id, ord, data) VALUES ($1, $2, 0, '\\x010203')", [doc, lib]);
    return { doc, folder };
  }

  it("both tables FORCE row-level security and are granted to dawmain_app", async () => {
    const { rows } = await t.owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('folders', 'doc_originals') ORDER BY relname",
    );
    expect(rows).toEqual([
      { relname: "doc_originals", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "folders", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    for (const table of ["folders", "doc_originals"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const r = await t.owner.query<{ ok: boolean }>("SELECT has_table_privilege('dawmain_app', $1, $2) AS ok", [table, priv]);
        expect(r.rows[0].ok).toBe(true);
      }
    }
    const storage = await t.owner.query<{ attstorage: string }>(
      "SELECT attstorage FROM pg_attribute WHERE attrelid = 'doc_originals'::regclass AND attname = 'data'",
    );
    expect(storage.rows[0].attstorage).toBe("e");
  });

  it("a scope sees only its own folders and parts; writes outside it and library moves are refused", async () => {
    const a = await seed("user_a", "a".repeat(64));
    const b = await seed("user_b", "b".repeat(64));
    const seen = await t.runner(["user_a"], async (db) => ({
      folders: (await db.query<{ id: string }>("SELECT id FROM folders")).rows.map((r) => r.id),
      parts: (await db.query<{ doc_id: string }>("SELECT doc_id FROM doc_originals")).rows.map((r) => r.doc_id),
    }));
    expect(seen).toEqual({ folders: [a.folder], parts: [a.doc] });
    await expect(
      t.runner(["user_a"], (db) => db.query("INSERT INTO folders (library_id, name, created_by) VALUES ('user_b', 'X', 'user_a')")),
    ).rejects.toThrow(/row-level security/);
    await expect(
      t.runner(["user_a"], (db) => db.query("INSERT INTO doc_originals (doc_id, library_id, ord, data) VALUES ($1, 'user_b', 1, '\\x00')", [b.doc])),
    ).rejects.toThrow(/row-level security/);
    await expect(t.runner(["user_a", "user_b"], (db) => db.query("UPDATE folders SET library_id = 'user_b' WHERE library_id = 'user_a'"))).rejects.toThrow(/immutable/);
    await expect(t.runner(["user_a", "user_b"], (db) => db.query("UPDATE doc_originals SET library_id = 'user_b'"))).rejects.toThrow(/immutable/);
  });

  it("a document cannot sit in another library's folder; a folder cannot nest under another library's", async () => {
    const a = await seed("user_a", "a".repeat(64));
    const b = await seed("user_b", "b".repeat(64));
    await expect(t.owner.query("UPDATE documents SET folder_id = $1 WHERE id = $2", [b.folder, a.doc])).rejects.toThrow(/foreign key/);
    await expect(t.owner.query("INSERT INTO folders (library_id, parent_id, name, created_by) VALUES ('user_a', $1, 'Y', 'user_u')", [b.folder])).rejects.toThrow(/foreign key/);
  });

  it("sibling names are unique case-insensitively, in the root as well", async () => {
    const a = await seed("user_a", "a".repeat(64));
    await expect(t.owner.query("INSERT INTO folders (library_id, name, created_by) VALUES ('user_a', 'f', 'user_u')")).rejects.toThrow(/duplicate key/);
    await t.owner.query("INSERT INTO folders (library_id, parent_id, name, created_by) VALUES ('user_a', $1, 'f', 'user_u')", [a.folder]);
    await t.owner.query("INSERT INTO libraries (id) VALUES ('user_b')");
    await t.owner.query("INSERT INTO folders (library_id, name, created_by) VALUES ('user_b', 'F', 'user_u')");
    await expect(t.owner.query("UPDATE documents SET original_status = 'half' WHERE id = $1", [a.doc])).rejects.toThrow(/check constraint/);
  });

  it("deleting a document drops its parts; purging a library drops its folders too", async () => {
    const a = await seed("user_a", "a".repeat(64));
    await t.owner.query("INSERT INTO folders (library_id, parent_id, name, created_by) VALUES ('user_a', $1, 'Sub', 'user_u')", [a.folder]);
    await t.owner.query("DELETE FROM documents WHERE id = $1", [a.doc]);
    expect(await partRows(a.doc)).toBe(0);
    await seed("user_b", "b".repeat(64));
    await t.owner.query("UPDATE libraries SET purge_after = now() - interval '1 day' WHERE id = 'user_b'");
    expect(await t.runner(["user_b"], (db) => purgeLibraryContent(db, "user_b"))).toBe(1);
    const left = await t.owner.query<{ library_id: string }>("SELECT library_id FROM folders ORDER BY library_id");
    expect(left.rows.map((r) => r.library_id)).toEqual(["user_a", "user_a"]);
  });

  it("files_library_bytes sums the originals stored or uploading, per library (app role, system scope)", async () => {
    await seed("user_a", "a".repeat(64));
    await t.owner.query("UPDATE documents SET file_bytes = 500");
    const r = await t.runner([], (db) => db.query<{ library_id: string; bytes: string }>("SELECT library_id, bytes FROM files_library_bytes()"));
    expect(r.rows.map((x) => [x.library_id, Number(x.bytes)])).toEqual([["user_a", 500]]);
  });
});

// ---------------------------------------------------------------------------

describe("originals: PUT parts, POST finalize, GET", () => {
  it("a small original: one part, the right hash → ready, then downloadable by the whole team", async () => {
    const file = new Uint8Array(randomBytes(1_234));
    const id = await uploadDoc("user_a", "org_t", "small", { file });
    expect(await originalStatus(id)).toBe("uploading");
    const res = await sendOriginal("user_a", id, file);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ original: "ready" });
    expect(await originalStatus(id)).toBe("ready");
    const audit = await t.owner.query("SELECT 1 FROM audit_log WHERE action = 'document.original' AND doc_id = $1", [id]);
    expect(audit.rows).toHaveLength(1);

    // A colleague in the team downloads it.
    const got = await download("user_b", id);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(file);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-length")).toBe("1234");
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="komentar.pdf"; filename*=UTF-8''komentar.pdf`);
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
    expect(got.headers.get("cache-control")).toBe("private, no-store");

    const inline = await download("user_b", id, "?inline=1");
    expect(inline.headers.get("content-disposition")).toMatch(/^inline; /);
    expect(inline.headers.get("content-security-policy")).toBe("sandbox");

    // A stranger: 404, like a document that does not exist.
    expect((await download("user_x", id)).status).toBe(404);
    // Finalizing again: nothing is awaited any more.
    expect((await finalize("user_a", id)).status).toBe(409);
  });

  it("several parts are joined in order (a retried part replaces itself)", { timeout: 60_000 }, async () => {
    const file = new Uint8Array(randomBytes(ORIGINAL_PART_BYTES + 17));
    const id = await uploadDoc("user_a", "user_a", "big", { file });
    expect(partCount(file.byteLength)).toBe(2);
    // Part 1 first, part 0 twice (the first time with wrong bytes of the right size).
    expect((await putPart("user_a", id, 1, file.subarray(ORIGINAL_PART_BYTES))).status).toBe(204);
    expect((await putPart("user_a", id, 0, new Uint8Array(ORIGINAL_PART_BYTES))).status).toBe(204);
    expect((await putPart("user_a", id, 0, file.subarray(0, ORIGINAL_PART_BYTES))).status).toBe(204);
    expect((await finalize("user_a", id)).status).toBe(200);
    const got = await download("user_a", id);
    expect(got.headers.get("content-length")).toBe(String(file.byteLength));
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(file))).toBe(true);
  });

  it("a wrong hash → 422: the parts go, the original is 'missing', the text stays", async () => {
    const file = new Uint8Array(randomBytes(500));
    const id = await uploadDoc("user_a", "user_a", "bad", { file });
    const other = new Uint8Array(randomBytes(500));
    expect((await putPart("user_a", id, 0, other)).status).toBe(204);
    const res = await finalize("user_a", id);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatch(/kontrolní součet/);
    expect(await originalStatus(id)).toBe("missing");
    expect(await partRows(id)).toBe(0);
    expect((await t.owner.query("SELECT 1 FROM documents WHERE id = $1", [id])).rows).toHaveLength(1);
    expect((await download("user_a", id)).status).toBe(404);
    // No more parts are taken.
    expect((await putPart("user_a", id, 0, file)).status).toBe(409);
  });

  it("part sizes are exact, part numbers bounded, the body capped; finalize waits for every part", async () => {
    const file = new Uint8Array(randomBytes(100));
    const id = await uploadDoc("user_a", "user_a", "sizes", { file });
    const short = await putPart("user_a", id, 0, file.subarray(0, 99));
    expect(short.status).toBe(400);
    expect((await putPart("user_a", id, 0, new Uint8Array(101))).status).toBe(413);
    expect((await putPart("user_a", id, 1, file)).status).toBe(400);
    expect((await putPart("user_a", id, "x", file)).status).toBe(400);
    expect(await partRows(id)).toBe(0);
    const early = await finalize("user_a", id);
    expect(early.status).toBe(409);
    expect(await errorOf(early)).toMatch(/chybí 1 z 1/);
    expect(await originalStatus(id)).toBe("uploading");
  });

  it("only the uploader sends the original; same-origin only; not in read-only mode", async () => {
    const file = new Uint8Array(randomBytes(64));
    const id = await uploadDoc("user_a", "org_t", "rights", { file });
    // A team member — even the team's manager — sees the document but did not upload it.
    expect((await putPart("user_b", id, 0, file)).status).toBe(403);
    expect((await putPart("user_boss", id, 0, file)).status).toBe(403);
    expect((await finalize("user_b", id)).status).toBe(403);
    expect((await putPart("user_x", id, 0, file)).status).toBe(404);
    expect((await putPart("user_a", id, 0, file, { origin: "https://evil.example", host: "dawmain.cz" })).status).toBe(403);
    process.env.FILES_MODE = "readonly";
    __resetGuardsForTests();
    expect((await putPart("user_a", id, 0, file)).status).toBe(503);
    expect(await partRows(id)).toBe(0);
  });

  it("text-only uploads have no original; a DOCX is never shown inline", async () => {
    const plain = await uploadDoc("user_a", "user_a", "plain");
    expect(await originalStatus(plain)).toBe("missing");
    expect((await download("user_a", plain)).status).toBe(404);
    expect((await putPart("user_a", plain, 0, new Uint8Array(10))).status).toBe(409);

    const file = new Uint8Array(randomBytes(300));
    const docx = await uploadDoc("user_a", "user_a", "docx", { file, kind: "docx", name: "Smlouva o dílo.docx" });
    expect((await sendOriginal("user_a", docx, file)).status).toBe(200);
    const got = await download("user_a", docx, "?inline=1");
    expect(got.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="Smlouva-o-dilo.docx"; filename*=UTF-8''Smlouva%20o%20d%C3%ADlo.docx`);
  });

  it("the cron resets originals still uploading after 24 h: parts gone, no longer counted", async () => {
    const file = new Uint8Array(randomBytes(200));
    const id = await uploadDoc("user_a", "user_a", "stale", { file });
    expect((await putPart("user_a", id, 0, file)).status).toBe(204);
    expect(await t.runner(["user_a"], (db) => abandonStaleOriginals(db, "user_a", 24))).toBe(0);
    await t.owner.query("UPDATE documents SET uploaded_at = now() - interval '25 hours' WHERE id = $1", [id]);
    expect(await t.runner(["user_a"], (db) => abandonStaleOriginals(db, "user_a", 24))).toBe(1);
    expect(await originalStatus(id)).toBe("missing");
    expect(await partRows(id)).toBe(0);
  });

  it("list items carry the original's state and the folder", async () => {
    const file = new Uint8Array(randomBytes(50));
    const id = await uploadDoc("user_a", "user_a", "list", { file });
    const body = await list("user_a", "user_a");
    expect(body.documents.find((d) => d.id === id)).toMatchObject({ original: "uploading", folderId: null });
    expect(body.folders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("folders", () => {
  it("create, list, duplicate sibling names (any case) → 409", async () => {
    const res = await createFolder("user_a", "user_a", "  Smlouvy   2026 ");
    expect(res.status).toBe(201);
    const folder = (await res.json()) as FolderItem;
    expect(folder).toMatchObject({ libraryId: "user_a", parentId: null, name: "Smlouvy 2026", mine: true });
    const dup = await createFolder("user_a", "user_a", "smlouvy 2026");
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toBe("Složka s tímto názvem už tu je.");
    // The same name one level down is fine.
    expect((await createFolder("user_a", "user_a", "Smlouvy 2026", folder.id)).status).toBe(201);
    const body = await list("user_a", "user_a");
    expect(body.folders.map((f) => f.name)).toEqual(["Smlouvy 2026", "Smlouvy 2026"]);
  });

  it("names: no slashes or control characters, 1–120 characters", async () => {
    for (const bad of ["", "   ", "a/b", "a\\b", "a\u0007b", "x".repeat(121)]) {
      expect((await createFolder("user_a", "user_a", bad)).status).toBe(422);
    }
    expect(cleanName("a\tb")).toEqual({ name: "a b" });
    expect(freeName("A", new Set(["a", "a (2)"]))).toBe("A (3)");
  });

  it("rights: any member of a Pro team manages folders; a stranger gets 404; parents must exist in the library", async () => {
    const mine = await folderId("user_a", "org_t", "Spisy");
    // A colleague renames the folder somebody else made.
    const renamed = await patchFolder("user_b", mine, { name: "Spisy 2026" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Spisy 2026", mine: false });
    expect((await patchFolder("user_x", mine, { name: "X" })).status).toBe(404);
    signedIn("user_x");
    expect((await folderPOST(json("/api/files/folders", "POST", { lib: "org_t", parentId: null, name: "X" }))).status).toBe(404);
    const foreign = await folderId("user_x", "user_x", "Cizí");
    expect((await createFolder("user_a", "org_t", "Pod", foreign)).status).toBe(422);
    // A team without Pro: listed, but no folder work.
    access.user_a = buildAccess({ id: "user_a", publicMetadata: { pro: true } }, [team("org_t", "org:member", false)]);
    __setAccessLoaderForTests(loadAccess);
    expect((await createFolder("user_a", "org_t", "Nová")).status).toBe(403);
  });

  it("move: into another folder or the root; never into itself or its own subfolder; no duplicate names", async () => {
    const a = await folderId("user_a", "user_a", "A");
    const b = await folderId("user_a", "user_a", "B", a);
    const c = await folderId("user_a", "user_a", "C");
    expect((await patchFolder("user_a", a, { parentId: a })).status).toBe(422);
    expect((await patchFolder("user_a", a, { parentId: b })).status).toBe(422);
    const moved = await patchFolder("user_a", b, { parentId: c });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as FolderItem).parentId).toBe(c);
    expect((await patchFolder("user_a", b, { parentId: null })).status).toBe(200);
    // "b" lands next to a root folder "B"? It is "B" itself in the root now: a second "b" in the root is refused.
    expect((await patchFolder("user_a", c, { name: "b" })).status).toBe(409);
    expect((await patchFolder("user_a", c, {})).status).toBe(400);
  });

  it("delete: the folder goes with its subfolders and every document in them", async () => {
    const parent = await folderId("user_a", "user_a", "Rodič");
    const doomed = await folderId("user_a", "user_a", "Smazat", parent);
    const sub = await folderId("user_a", "user_a", "Pod", doomed);
    const kept = await uploadDoc("user_a", "user_a", "inparent", { folderId: parent });
    const doc = await uploadDoc("user_a", "user_a", "infolder", { folderId: doomed });
    const deep = await uploadDoc("user_a", "user_a", "insub", { folderId: sub });
    signedIn("user_a");
    const res = await folderDELETE(new Request(url(`/api/files/folders/${doomed}`), { method: "DELETE", headers: ORIGIN }), ctx(doomed));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, deletedDocuments: 2, deletedFolders: 2 });
    const body = await list("user_a", "user_a");
    const docs = new Set(body.documents.map((d) => d.id));
    expect(docs.has(doc)).toBe(false);
    expect(docs.has(deep)).toBe(false);
    expect(docs.has(kept)).toBe(true);
    const ids = new Set(body.folders.map((f) => f.id));
    expect(ids.has(doomed)).toBe(false);
    expect(ids.has(sub)).toBe(false);
    expect(ids.has(parent)).toBe(true);
  });

  it("delete in a team: a member may not delete a colleague's documents with the folder", async () => {
    const shared = await folderId("user_a", "org_t", "Společná");
    const theirs = await uploadDoc("user_a", "org_t", "colleague", { folderId: shared });
    signedIn("user_b");
    const res = await folderDELETE(new Request(url(`/api/files/folders/${shared}`), { method: "DELETE", headers: ORIGIN }), ctx(shared));
    expect(res.status).toBe(403);
    const body = await list("user_a", "org_t");
    expect(body.documents.some((d) => d.id === theirs)).toBe(true);
    expect(body.folders.some((f) => f.id === shared)).toBe(true);
    // The team's manager may.
    signedIn("user_boss");
    const boss = await folderDELETE(new Request(url(`/api/files/folders/${shared}`), { method: "DELETE", headers: ORIGIN }), ctx(shared));
    expect(boss.status).toBe(200);
    expect(await boss.json()).toEqual({ deleted: true, deletedDocuments: 1, deletedFolders: 1 });
  });
});

// ---------------------------------------------------------------------------

describe("document rename and move", () => {
  it("rename keeps the extension; move into a folder of the same library or back to the root", async () => {
    const id = await uploadDoc("user_a", "user_a", "rename", { name: "smlouva.pdf" });
    const res = await patchDoc("user_a", id, { action: "rename", name: "  Kupní   smlouva " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as DocumentDetail).fileName).toBe("Kupní smlouva.pdf");
    expect((await patchDoc("user_a", id, { action: "rename", name: "a/b" })).status).toBe(422);
    const folder = await folderId("user_a", "user_a", "Smlouvy");
    const moved = await patchDoc("user_a", id, { action: "move", folderId: folder });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as DocumentDetail).folderId).toBe(folder);
    const foreign = await folderId("user_x", "user_x", "Cizí");
    expect((await patchDoc("user_a", id, { action: "move", folderId: foreign })).status).toBe(422);
    const back = await patchDoc("user_a", id, { action: "move", folderId: null });
    expect(((await back.json()) as DocumentDetail).folderId).toBeNull();
    const audit = await t.owner.query<{ action: string }>("SELECT action FROM audit_log WHERE doc_id = $1 AND action LIKE 'document.%' ORDER BY id", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["document.upload", "document.rename", "document.move", "document.move"]);
  });

  it("rights: the uploader or the team's manager; a colleague 403, a stranger 404, a library without Pro 403", async () => {
    const id = await uploadDoc("user_a", "org_t", "rights");
    expect((await patchDoc("user_b", id, { action: "rename", name: "Moje" })).status).toBe(403);
    expect((await patchDoc("user_x", id, { action: "rename", name: "Moje" })).status).toBe(404);
    expect((await patchDoc("user_boss", id, { action: "rename", name: "Od správce" })).status).toBe(200);
    access.user_a = buildAccess({ id: "user_a", publicMetadata: { pro: true } }, [team("org_t", "org:member", false)]);
    __setAccessLoaderForTests(loadAccess);
    expect((await patchDoc("user_a", id, { action: "move", folderId: null })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("part arithmetic", () => {
    expect(partCount(0)).toBe(0);
    expect(partCount(1)).toBe(1);
    expect(partCount(ORIGINAL_PART_BYTES)).toBe(1);
    expect(partCount(ORIGINAL_PART_BYTES + 1)).toBe(2);
    expect(partSize(ORIGINAL_PART_BYTES + 1, 0)).toBe(ORIGINAL_PART_BYTES);
    expect(partSize(ORIGINAL_PART_BYTES + 1, 1)).toBe(1);
  });

  it("dispositions: ASCII fallback + RFC 5987, the kind's extension once", () => {
    expect(originalDisposition("Žaloba.pdf", "pdf", true)).toBe(`inline; filename="Zaloba.pdf"; filename*=UTF-8''%C5%BDaloba.pdf`);
    expect(originalDisposition('a"b\n.md', "md", false)).toBe(`attachment; filename="a-b.md"; filename*=UTF-8''a%20b.md`);
    expect(originalDisposition("", "txt", false)).toBe(`attachment; filename="dokument.txt"; filename*=UTF-8''dokument.txt`);
    // A long name cut in the middle of a surrogate pair: the lone half goes (encodeURIComponent would throw).
    expect(originalDisposition(`${"a".repeat(199)}😀b.pdf`, "pdf", false)).toMatch(/filename\*=UTF-8''a{199}\.pdf$/);
  });

  it("folderGone: only the foreign key of documents.folder_id (a folder deleted under a move or an upload)", () => {
    expect(folderGone({ code: "23503", constraint: "documents_folder_fk" })).toBe(true);
    expect(folderGone({ code: "23503", constraint: "doc_originals_doc_id_library_id_fkey" })).toBe(false);
    expect(folderGone({ code: "23505", constraint: "documents_folder_fk" })).toBe(false);
    expect(folderGone(null)).toBe(false);
  });

  it("renamedFileName keeps the old extension unless the new name has it", () => {
    expect(renamedFileName("Nový", "starý.docx")).toEqual({ name: "Nový.docx" });
    expect(renamedFileName("Nový.DOCX", "starý.docx")).toEqual({ name: "Nový.DOCX" });
    expect(renamedFileName("Bez", "bez-pripony")).toEqual({ name: "Bez" });
    expect(renamedFileName("x".repeat(255), "a.pdf")).toHaveProperty("error");
  });

  it("sizes in Czech, binary units; z / ze by how the number is read", () => {
    expect(formatBytes(850 * 1024)).toBe("850 kB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12,4 MB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1,2 GB");
    expect(formatBytes(1024 ** 3 - 1)).toBe("1 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(["100 MB", "1 GB", "50 MB", "2 GB", "7 MB", "1024 MB"].map(zBefore)).toEqual(["ze", "z", "z", "ze", "ze", "z"]);
    expect(quotaMessage(13 * 1024 * 1024, 97 * 1024 * 1024, 100 * 1024 * 1024)).toBe("Soubor má 13 MB, v knihovně zbývá 3 MB ze 100 MB. Smažte některý dokument.");
  });

  it("storageCheck refuses a file over the per-file cap, then over what is left", () => {
    const MB = 1024 * 1024;
    expect(storageCheck(5 * MB, 100 * MB, 10 * MB, 100 * MB)).toEqual({ fits: true });
    expect(storageCheck(101 * MB, 1024 * MB, 0, 100 * MB)).toEqual({ fits: false, reason: "file", remaining: 1024 * MB });
    expect(storageCheck(20 * MB, 100 * MB, 90 * MB, 100 * MB)).toEqual({ fits: false, reason: "quota", remaining: 10 * MB });
    expect(storageCheck(1, 100 * MB, 200 * MB, 100 * MB)).toEqual({ fits: false, reason: "quota", remaining: 0 });
  });
});
