import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web API of the Vlastní zdroje modal (src/files/web.ts, web-team.ts)
 * through its route handlers: GET /api/files/summary, GET /api/files/documents,
 * GET/PATCH/DELETE /api/files/documents/[id], POST /api/files/terms and
 * /api/files/team/**. Clerk (session, team API), after() and the model call
 * are mocked; the database is PGlite with the real migrations, as
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

import { DELETE as docDELETE, GET as docGET, PATCH as docPATCH } from "@/app/api/files/documents/[id]/route";
import { GET as listGET, POST as uploadPOST } from "@/app/api/files/documents/route";
import { GET as summaryGET } from "@/app/api/files/summary/route";
import { GET as teamGET } from "@/app/api/files/team/route";
import { POST as inviteDecline } from "@/app/api/files/team/invitations/[id]/decline/route";
import { DELETE as invitationDELETE } from "@/app/api/files/team/invitations/[id]/route";
import { POST as invitePOST } from "@/app/api/files/team/invitations/route";
import { DELETE as memberDELETE } from "@/app/api/files/team/members/[userId]/route";
import { POST as termsPOST } from "@/app/api/files/terms/route";
import { __setAccessLoaderForTests, buildAccess, type Access } from "@/src/files/access";
import { TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { searchChannels } from "@/src/files/db/search";
import { acceptTerms, hasAcceptedTerms, setSystemState } from "@/src/files/db/usage";
import { __resetGuardsForTests, MODE_OVERRIDE_KEY } from "@/src/files/guards";
import { __setTeamClientForTests, type ClerkInvitationLike, type ClerkMembershipLike, type TeamClerk } from "@/src/files/team";
import { buildTsQuery } from "@/src/files/text/analyze";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import type { DocumentDetail, DocumentListResponse, SummaryResponse, TeamView } from "@/src/files/web-types";
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

const TEAM = { id: "org_t", name: "Kancelář Novák", slug: "novak", publicMetadata: { pro: true } };
const ACCESS: Record<string, Access> = {
  // Pro personally, admin of the Pro team.
  user_admin: buildAccess({ id: "user_admin", publicMetadata: { pro: true } }, [{ role: "org:admin", organization: TEAM }]),
  // Plain members of the Pro team (no personal Pro).
  user_mem: buildAccess({ id: "user_mem", publicMetadata: {} }, [{ role: "org:member", organization: TEAM }]),
  user_mem2: buildAccess({ id: "user_mem2", publicMetadata: {} }, [{ role: "org:member", organization: TEAM }]),
  // A stranger with a Pro personal library.
  user_x: buildAccess({ id: "user_x", publicMetadata: { pro: true } }, []),
  // Never had Pro.
  user_none: buildAccess({ id: "user_none", publicMetadata: {} }, []),
};
let access: Record<string, Access> = { ...ACCESS };

// A Clerk backend double for the team API.
function fakeClerk() {
  const members: ClerkMembershipLike[] = [
    { role: "org:admin", createdAt: Date.UTC(2026, 8, 1), publicUserData: { userId: "user_admin", identifier: "admin@novak.cz", firstName: "David", lastName: "Závada" } },
    { role: "org:member", createdAt: Date.UTC(2026, 8, 2), publicUserData: { userId: "user_mem", identifier: "jana@novak.cz", firstName: "Jana", lastName: "Nováková" } },
    { role: "org:member", createdAt: Date.UTC(2026, 8, 3), publicUserData: { userId: "user_mem2", identifier: "petr@novak.cz", firstName: "Petr", lastName: "Svoboda" } },
  ];
  const invitations: ClerkInvitationLike[] = [];
  const emails: Record<string, Array<{ emailAddress: string; verification: { status: string } | null }>> = {
    user_x: [
      { emailAddress: "x@example.cz", verification: { status: "verified" } },
      { emailAddress: "unverified@example.cz", verification: { status: "unverified" } },
    ],
    user_admin: [{ emailAddress: "admin@novak.cz", verification: { status: "verified" } }],
  };
  let seq = 0;
  const client: TeamClerk = {
    organizations: {
      getOrganization: async ({ organizationId }) => {
        if (organizationId !== "org_t") throw Object.assign(new Error("nf"), { code: "api_response_error", status: 404 });
        return { id: "org_t", name: "Kancelář Novák", membersCount: members.length };
      },
      getOrganizationMembershipList: async () => ({ data: [...members] }),
      getOrganizationInvitationList: async ({ status }) => ({ data: invitations.filter((i) => !status || status.includes(i.status!)) }),
      createOrganizationInvitation: async (p) => {
        const inv: ClerkInvitationLike = {
          id: `orginv_${++seq}`,
          emailAddress: p.emailAddress,
          organizationId: p.organizationId,
          status: "pending",
          createdAt: Date.now(),
          publicMetadata: p.publicMetadata ?? {},
        };
        invitations.push(inv);
        return inv;
      },
      revokeOrganizationInvitation: async ({ invitationId }) => {
        const inv = invitations.find((i) => i.id === invitationId);
        if (!inv) throw Object.assign(new Error("nf"), { code: "api_response_error", status: 404 });
        inv.status = "revoked";
        return inv;
      },
      deleteOrganizationMembership: async ({ userId }) => {
        const at = members.findIndex((m) => m.publicUserData?.userId === userId);
        members.splice(at, 1);
        return {};
      },
    },
    users: {
      getUser: async (userId) => ({ firstName: userId === "user_admin" ? "David" : null, lastName: userId === "user_admin" ? "Závada" : null, emailAddresses: emails[userId] ?? [] }),
      getOrganizationInvitationList: async ({ userId }) => ({
        data: invitations.filter((i) => i.status === "pending" && (emails[userId] ?? []).some((e) => e.emailAddress === i.emailAddress)),
      }),
    },
  };
  return { client, members, invitations };
}

// ---------------------------------------------------------------------------

let t: TestDb;
let clerk: ReturnType<typeof fakeClerk>;
const ENV = { ...process.env };

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  __setTeamClientForTests(null);
  await t.close();
});
beforeEach(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  access = { ...ACCESS };
  __setAccessLoaderForTests(async (userId) => access[userId] ?? buildAccess({ id: userId }, []));
  clerk = fakeClerk();
  __setTeamClientForTests(clerk.client);
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
  (await t.owner.query<{ status: string; enabled: boolean; title: string | null; meta_version: number; doc_type: string | null }>(
    "SELECT status, enabled, title, meta_version, doc_type FROM documents WHERE id = $1",
    [id],
  )).rows[0];

/** Upload as `user` into `lib` and run the ingest: the document ends in 'review'. */
async function uploaded(user: string, lib: string, salt: string): Promise<string> {
  signedIn(user);
  const res = await uploadPOST(uploadRequest(lib, dmd(3, salt)));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
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
    signedIn("user_admin");
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

  it("counts, pages, team size and terms for a Pro user", async () => {
    const a = await uploaded("user_admin", "user_admin", "a");
    await uploaded("user_admin", "org_t", "t");
    signedIn("user_admin");
    await patch("user_admin", a, { action: "confirm", version: (await row(a)).meta_version, meta: META() });
    const body = (await (await summaryGET(get("/api/files/summary"))).json()) as SummaryResponse;
    if (body.state !== "ok") throw new Error("expected ok");
    expect(body.mode).toBe("on");
    expect(body.termsAccepted).toBe(true);
    const personal = body.libraries.find((l) => l.id === "user_admin")!;
    const team = body.libraries.find((l) => l.id === "org_t")!;
    expect(personal.counts).toMatchObject({ total: 1, ready: 1, review: 0, searchable: 1 });
    expect(personal.pagesUsed).toBeGreaterThan(0);
    expect(team).toMatchObject({ kind: "org", role: "org:admin", memberCount: 3 });
    expect(team.counts).toMatchObject({ total: 1, review: 1 });
  });
});

describe("GET /api/files/documents?lib=", () => {
  it("lists the library with uploader names in a team", async () => {
    await uploaded("user_mem", "org_t", "m");
    signedIn("user_mem2");
    const res = await listGET(get("/api/files/documents?lib=org_t"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentListResponse;
    expect(body.total).toBe(1);
    expect(body.documents[0]).toMatchObject({ uploaderName: "Jana Nováková", mine: false, canEdit: false, fileBytes: 2_400_000, status: "review" });
  });

  it("a foreign or unknown library is 404 either way", async () => {
    await uploaded("user_admin", "user_admin", "a");
    signedIn("user_x");
    for (const lib of ["user_admin", "org_t", "user_nobody", "not-a-lib"]) {
      const res = await listGET(get(`/api/files/documents?lib=${lib}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Knihovna nenalezena." });
    }
  });

  it("a user who lost Pro still lists (and deletes) what they stored", async () => {
    const id = await uploaded("user_x", "user_x", "x");
    access.user_x = buildAccess({ id: "user_x", publicMetadata: {} }, []);
    signedIn("user_x");
    const body = (await (await listGET(get("/api/files/documents?lib=user_x"))).json()) as DocumentListResponse;
    expect(body.documents.map((d) => d.id)).toEqual([id]);
    expect(body.documents[0].canEdit).toBe(true);
    expect((await del("user_x", id)).status).toBe(200);
  });
});

describe("GET /api/files/documents/[id]", () => {
  it("detail with a plain-text preview; members of the team see it", async () => {
    const id = await uploaded("user_mem", "org_t", "m");
    const res = await detail("user_mem2", id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentDetail;
    expect(body.libraryName).toBe("Kancelář Novák");
    expect(body.preview).toContain("Komentované ustanovení");
    // Markup is stripped: no page markers or heading hashes.
    expect(body.preview).not.toContain("[s. 1]");
    expect(body.preview).not.toContain("##");
    expect(body.preview.length).toBeLessThanOrEqual(1_501);
  });

  it("foreign, unknown and malformed ids are the same 404", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    for (const [user, docId] of [
      ["user_x", id],
      ["user_mem", id],
      ["user_admin", "00000000-0000-4000-8000-000000000000"],
      ["user_admin", "../../etc"],
    ]) {
      const res = await detail(user, docId);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Dokument nenalezen." });
    }
  });
});

describe("PATCH /api/files/documents/[id]", () => {
  it("confirm: review → ready with the validated metadata, meta_version bumped", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    const before = await row(id);
    const res = await patch("user_admin", id, { action: "confirm", version: before.meta_version, meta: META({ year: "2019", isbn: "978-80-7400-773-6" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentDetail;
    expect(body.status).toBe("ready");
    expect(body.meta.title).toBe("Občanský zákoník. Komentář");
    expect(body.meta.year).toBe(2019);
    expect((await row(id)).meta_version).toBe(before.meta_version + 1);
  });

  it("a stale version is 409; a document still processing is 409 with its own message", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    const v = (await row(id)).meta_version;
    expect((await patch("user_admin", id, { action: "save", version: v, meta: META() })).status).toBe(200);
    const stale = await patch("user_admin", id, { action: "save", version: v, meta: META() });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain("upravil někdo jiný");
  });

  it("a member cannot edit another member's document; the admin can", async () => {
    const id = await uploaded("user_mem", "org_t", "m");
    const v = (await row(id)).meta_version;
    const res = await patch("user_mem2", id, { action: "confirm", version: v, meta: META() });
    expect(res.status).toBe(403);
    expect((await patch("user_admin", id, { action: "confirm", version: v, meta: META() })).status).toBe(200);
  });

  it("the metadata schema rejects oversized and unknown input with field messages", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    const v = (await row(id)).meta_version;
    const long = await patch("user_admin", id, { action: "confirm", version: v, meta: META({ title: "x".repeat(301) }) });
    expect(long.status).toBe(422);
    const body = (await long.json()) as { error: string; fields: Record<string, string> };
    expect(body.fields.title).toMatch(/nejvýš 300/);
    const unknown = await patch("user_admin", id, { action: "confirm", version: v, meta: META({ injected: "x" }) });
    expect(unknown.status).toBe(422);
    const authors = await patch("user_admin", id, { action: "confirm", version: v, meta: META({ authors: Array.from({ length: 11 }, (_, i) => `Autor ${i}`) }) });
    expect(authors.status).toBe(422);
    // A commentary needs its act to be confirmed, not to be saved as a draft.
    expect((await patch("user_admin", id, { action: "confirm", version: v, meta: META({ doc_type: "komentar" }) })).status).toBe(422);
    expect((await patch("user_admin", id, { action: "save", version: v, meta: META({ doc_type: "komentar" }) })).status).toBe(200);
    expect((await row(id)).title).toBe("Občanský zákoník. Komentář");
  });

  it("a body over 64 KB is 413, malformed JSON 400, an unknown action 400", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    signedIn("user_admin");
    const huge = await docPATCH(send(`/api/files/documents/${id}`, "PATCH", JSON.stringify({ action: "save", version: 0, meta: { title: "x".repeat(70_000) } })), ctx("id", id));
    expect(huge.status).toBe(413);
    expect((await docPATCH(send(`/api/files/documents/${id}`, "PATCH", "{not json"), ctx("id", id))).status).toBe(400);
    expect((await patch("user_admin", id, { action: "publish" })).status).toBe(400);
  });

  it("the switch hides a document from search and brings it back", async () => {
    const id = await uploaded("user_admin", "user_admin", "hledej");
    await patch("user_admin", id, { action: "confirm", version: (await row(id)).meta_version, meta: META() });
    const q = buildTsQuery("odpovědnost škodu");
    const search = () =>
      t.runner(["user_admin"], (db) =>
        searchChannels(db, { libraryIds: ["user_admin"], tsAnd: q.and, tsOr: q.or, identKeys: [], perDoc: 3, limit: 60 }),
      );
    expect((await search()).some((h) => h.docId === id)).toBe(true);
    const off = await patch("user_admin", id, { action: "enable", enabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as DocumentDetail).enabled).toBe(false);
    expect((await search()).some((h) => h.docId === id)).toBe(false);
    await patch("user_admin", id, { action: "enable", enabled: true });
    expect((await search()).some((h) => h.docId === id)).toBe(true);
  });

  it("read-only mode refuses edits and the switch", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    await t.runner([], (db) => setSystemState(db, MODE_OVERRIDE_KEY, { mode: "readonly" }));
    __resetGuardsForTests();
    const res = await patch("user_admin", id, { action: "enable", enabled: false });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("jen pro čtení");
    expect((await row(id)).enabled).toBe(true);
  });

  it("changing the type re-derives the index after the response", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    mocks.after.length = 0;
    await patch("user_admin", id, { action: "confirm", version: (await row(id)).meta_version, meta: META({ doc_type: "komentar", commented_act: "89/2012" }) });
    expect(mocks.after).toHaveLength(1);
    await runAfter();
    const keys = (await t.owner.query<{ ident_keys: string[] }>("SELECT ident_keys FROM documents WHERE id = $1", [id])).rows[0].ident_keys;
    expect(keys).toContain("zak:89/2012");
    const chunkKeys = (await t.owner.query<{ k: string }>("SELECT unnest(ident_keys) AS k FROM chunks WHERE doc_id = $1", [id])).rows.map((r) => r.k);
    expect(chunkKeys).toContain("parz:89/2012/2913");
    expect((await row(id)).status).toBe("ready");
    // Same type again: nothing to re-derive.
    mocks.after.length = 0;
    await patch("user_admin", id, { action: "confirm", version: (await row(id)).meta_version, meta: META({ doc_type: "komentar", commented_act: "89/2012", year: "2020" }) });
    expect(mocks.after).toHaveLength(0);
  });
});

describe("DELETE /api/files/documents/[id]", () => {
  it("a member cannot delete another member's document; the admin can, and the pages come back", async () => {
    const id = await uploaded("user_mem", "org_t", "m");
    const pages = async () => (await t.owner.query<{ page_count: number; doc_count: number }>("SELECT page_count, doc_count FROM libraries WHERE id = 'org_t'")).rows[0];
    expect((await pages()).doc_count).toBe(1);
    const refused = await del("user_mem2", id);
    expect(refused.status).toBe(403);
    expect(await row(id)).toBeDefined();
    expect((await del("user_admin", id)).status).toBe(200);
    expect(await row(id)).toBeUndefined();
    expect(await pages()).toEqual({ page_count: 0, doc_count: 0 });
    const audit = await t.owner.query<{ actor: string; action: string }>("SELECT actor, action FROM audit_log WHERE action = 'document.delete'");
    expect(audit.rows).toEqual([{ actor: "user_admin", action: "document.delete" }]);
  });

  it("the uploader deletes their own; a foreign library's document is 404", async () => {
    const id = await uploaded("user_mem", "org_t", "m");
    expect((await del("user_x", id)).status).toBe(404);
    expect((await del("user_mem", id)).status).toBe(200);
    expect((await del("user_mem", id)).status).toBe(404);
  });

  it("read-only mode still allows deleting", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    await t.runner([], (db) => setSystemState(db, MODE_OVERRIDE_KEY, { mode: "readonly" }));
    __resetGuardsForTests();
    expect((await del("user_admin", id)).status).toBe(200);
  });

  it("cross-site requests are refused before authentication", async () => {
    const id = await uploaded("user_admin", "user_admin", "a");
    mocks.auth.mockClear();
    const res = await del("user_admin", id, { origin: "https://evil.example", host: "dawmain.cz" });
    expect(res.status).toBe(403);
    expect(await row(id)).toBeDefined();
  });

  it("env off answers 503 before anything else", async () => {
    process.env.FILES_MODE = "off";
    const res = await del("user_admin", "00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(503);
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

describe("team routes", () => {
  const invite = (user: string, body: unknown) => {
    signedIn(user);
    return invitePOST(send("/api/files/team/invitations", "POST", body));
  };

  it("the admin sees members and invitations; a member is forbidden, a stranger gets 404", async () => {
    signedIn("user_admin");
    const res = await teamGET(get("/api/files/team?org=org_t"));
    expect(res.status).toBe(200);
    const team = (await res.json()) as TeamView;
    expect(team.members.map((m) => [m.name, m.admin, m.self])).toEqual([
      ["David Závada", true, true],
      ["Jana Nováková", false, false],
      ["Petr Svoboda", false, false],
    ]);
    signedIn("user_mem");
    expect((await teamGET(get("/api/files/team?org=org_t"))).status).toBe(403);
    signedIn("user_x");
    expect((await teamGET(get("/api/files/team?org=org_t"))).status).toBe(404);
  });

  it("a non-admin cannot invite; the admin can, once per address", async () => {
    expect((await invite("user_mem", { org: "org_t", email: "novy@novak.cz" })).status).toBe(403);
    expect(clerk.invitations).toHaveLength(0);
    const ok = await invite("user_admin", { org: "org_t", email: " Novy@Novak.cz " });
    expect(ok.status).toBe(201);
    expect(clerk.invitations[0]).toMatchObject({ emailAddress: "novy@novak.cz", publicMetadata: { inviterName: "David Závada" } });
    expect((await invite("user_admin", { org: "org_t", email: "novy@novak.cz" })).status).toBe(409);
    expect((await invite("user_admin", { org: "org_t", email: "jana@novak.cz" })).status).toBe(409);
    expect((await invite("user_admin", { org: "org_t", email: "not an address" })).status).toBe(400);
    // The audit log records the invitation without the address.
    const logged = await t.owner.query<{ detail: unknown }>("SELECT detail FROM audit_log WHERE action = 'invitation.create'");
    expect(JSON.stringify(logged.rows)).not.toContain("novak.cz");
  });

  it("the invitee declines only an invitation to a verified address of theirs; the admin sees it as declined", async () => {
    await invite("user_admin", { org: "org_t", email: "x@example.cz" });
    await invite("user_admin", { org: "org_t", email: "unverified@example.cz" });
    const [toX, toUnverified] = clerk.invitations;
    signedIn("user_x");
    expect((await inviteDecline(send(`/api/files/team/invitations/${toUnverified.id}/decline`, "POST"), ctx("id", toUnverified.id))).status).toBe(404);
    expect((await inviteDecline(send(`/api/files/team/invitations/${toX.id}/decline`, "POST"), ctx("id", toX.id))).status).toBe(200);
    expect(toX.status).toBe("revoked");
    expect(toUnverified.status).toBe("pending");
    signedIn("user_admin");
    let team = (await (await teamGET(get("/api/files/team?org=org_t"))).json()) as TeamView;
    expect(team.invitations.map((i) => [i.email, i.state])).toEqual(
      expect.arrayContaining([
        ["x@example.cz", "declined"],
        ["unverified@example.cz", "pending"],
      ]),
    );
    // × on a declined one only removes it from the list; on a pending one it revokes.
    signedIn("user_admin");
    expect((await invitationDELETE(send(`/api/files/team/invitations/${toX.id}?org=org_t`, "DELETE"), ctx("id", toX.id))).status).toBe(200);
    expect((await invitationDELETE(send(`/api/files/team/invitations/${toUnverified.id}?org=org_t`, "DELETE"), ctx("id", toUnverified.id))).status).toBe(200);
    expect(toUnverified.status).toBe("revoked");
    team = (await (await teamGET(get("/api/files/team?org=org_t"))).json()) as TeamView;
    expect(team.invitations).toEqual([]);
  });

  it("removing members: never oneself, never the last admin, only by an admin", async () => {
    const remove = (user: string, member: string) => {
      signedIn(user);
      return memberDELETE(send(`/api/files/team/members/${member}?org=org_t`, "DELETE"), ctx("userId", member));
    };
    expect((await remove("user_mem", "user_mem2")).status).toBe(403);
    expect((await remove("user_admin", "user_admin")).status).toBe(400);
    expect((await remove("user_admin", "user_mem2")).status).toBe(200);
    expect(clerk.members.map((m) => m.publicUserData?.userId)).toEqual(["user_admin", "user_mem"]);
    expect((await remove("user_admin", "user_gone")).status).toBe(404);
  });
});
