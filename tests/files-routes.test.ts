import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Vlastní zdroje route handlers, called directly with Request objects:
 * POST /api/files/documents, GET /api/files/status, POST /api/webhooks/clerk
 * and GET /api/cron/files. Clerk (session auth, webhook verification,
 * owner lookups), next/server's after() and the model call are mocked; the
 * database is PGlite with the real migrations, as dawmain_app under RLS.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  verifyWebhook: vi.fn(),
  after: [] as Array<() => unknown>,
  propose: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => {
    throw new Error("Clerk must not be called in these tests");
  },
}));
vi.mock("@clerk/nextjs/webhooks", () => ({ verifyWebhook: mocks.verifyWebhook }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    mocks.after.push(fn);
  },
}));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: mocks.propose }));

import { GET as cronGET } from "@/app/api/cron/files/route";
import { POST as documentsPOST } from "@/app/api/files/documents/route";
import { GET as statusGET } from "@/app/api/files/status/route";
import { POST as webhookPOST } from "@/app/api/webhooks/clerk/route";
import { __setAccessLoaderForTests, __setOwnerLookupForTests, buildAccess, type Access } from "@/src/files/access";
import { TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { acceptTerms } from "@/src/files/db/usage";
import { __resetGuardsForTests, GUARDS_STATE_KEY } from "@/src/files/guards";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

// ---------------------------------------------------------------------------
// Fixtures

const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCE = "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti a její předpoklady.";

function dmd(pages: number, salt: string): string {
  const out: string[] = [];
  for (let p = 0; p < pages; p++) out.push(`[s. ${p + 1}]`, "", `## § ${2913 + p} [Ustanovení]`, "", `${SENTENCE} ${SENTENCE} ${salt}`, "");
  return out.join("\n");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const gz = (s: string) => new Uint8Array(gzipSync(Buffer.from(s, "utf8")));

function uploadMeta(lib: string, text: string): UploadMeta {
  return {
    library_id: lib,
    file: { name: "a.pdf", bytes: 10, sha256: "a".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 3, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
  };
}

function uploadRequest(lib: string, text: string, headers: Record<string, string> = { origin: "https://dawmain.cz", host: "dawmain.cz" }): Request {
  const form = new FormData();
  form.append("meta", JSON.stringify(uploadMeta(lib, text)));
  form.append("dmd", new Blob([gz(text) as Uint8Array<ArrayBuffer>]), "d.gz");
  return new Request("https://dawmain.cz/api/files/documents", { method: "POST", body: form, headers });
}

const ACCESS: Record<string, Access> = {
  user_a: buildAccess({ id: "user_a", publicMetadata: { pro: true } }),
  user_m: buildAccess({ id: "user_m", publicMetadata: { pro: true } }),
  user_lapsed: buildAccess({ id: "user_lapsed", publicMetadata: {} }),
};

// ---------------------------------------------------------------------------

let t: TestDb;
const ENV = { ...process.env };

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  __setOwnerLookupForTests(null);
  await t.close();
});
beforeEach(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_test";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  __setAccessLoaderForTests(async (userId) => ACCESS[userId] ?? buildAccess({ id: userId }));
  __setOwnerLookupForTests(null);
  mocks.auth.mockReset();
  mocks.verifyWebhook.mockReset();
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
  const queued = mocks.after.splice(0);
  for (const fn of queued) await fn();
};
const statusOf = async (id: string) => (await t.owner.query<{ status: string }>("SELECT status FROM documents WHERE id = $1", [id])).rows[0]?.status;

async function uploaded(user: string, lib: string, salt: string): Promise<string> {
  signedIn(user);
  const res = await documentsPOST(uploadRequest(lib, dmd(3, salt)));
  expect(res.status).toBe(201);
  mocks.after.length = 0;
  return ((await res.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------

describe("POST /api/files/documents", () => {
  it("201: queued, never cached, and ingest runs in after()", async () => {
    signedIn("user_a");
    const res = await documentsPOST(uploadRequest("user_a", dmd(3, "x")));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    expect(mocks.after).toHaveLength(1);
    expect(await statusOf(body.id)).toBe("queued");
    await runAfter();
    expect(await statusOf(body.id)).toBe("ready");
  });

  it("a cross-site request is refused before authentication", async () => {
    signedIn("user_a");
    for (const headers of [{ host: "dawmain.cz" }, { origin: "https://evil.example", host: "dawmain.cz" }] as Array<Record<string, string>>) {
      const res = await documentsPOST(uploadRequest("user_a", dmd(3, "x"), headers));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Požadavek nepřišel z tohoto webu." });
    }
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.after).toHaveLength(0);
  });

  it("signed out → 401; Clerk failing → 503", async () => {
    signedIn(null);
    expect((await documentsPOST(uploadRequest("user_a", dmd(3, "x")))).status).toBe(401);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockRejectedValue(new Error("clerkMiddleware not detected"));
    expect((await documentsPOST(uploadRequest("user_a", dmd(3, "x")))).status).toBe(503);
    expect(log.mock.calls.flat().join(" ")).not.toContain("clerkMiddleware");
  });

  it("another Pro user cannot upload into user_a's library", async () => {
    signedIn("user_m");
    const res = await documentsPOST(uploadRequest("user_a", dmd(3, "x")));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Do této knihovny nemůžete nahrávat." });
    expect(mocks.after).toHaveLength(0);
  });

  it("duplicate → 409 naming the existing document", async () => {
    const id = await uploaded("user_a", "user_a", "dup");
    signedIn("user_a");
    const res = await documentsPOST(uploadRequest("user_a", dmd(3, "dup")));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Tento dokument už v knihovně je.", duplicate: { id, title: "a.pdf" } });
  });
});

describe("GET /api/files/status", () => {
  const statusReq = (query: string) => new Request(`https://dawmain.cz/api/files/status?${query}`);

  it("statuses of the caller's documents; foreign and malformed ids are absent; a waiting one kicks ingest", async () => {
    const theirs = await uploaded("user_m", "user_m", "theirs");
    const mine = await uploaded("user_a", "user_a", "mine");
    signedIn("user_a");
    const res = await statusGET(statusReq(`lib=user_a&ids=${mine},${theirs},nonsense,${mine}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: Array<{ id: string; status: string }> };
    expect(body.documents.map((d) => [d.id, d.status])).toEqual([[mine, "queued"]]);
    expect(mocks.after).toHaveLength(1);
    await runAfter();
    expect(await statusOf(mine)).toBe("ready");

    const again = (await (await statusGET(statusReq(`lib=user_a&ids=${mine}`))).json()) as { documents: Array<{ status: string }> };
    expect(again.documents[0].status).toBe("ready");
    expect(mocks.after).toHaveLength(0);
  });

  it("a foreign library answers exactly like a nonexistent one", async () => {
    await uploaded("user_a", "user_a", "p");
    signedIn("user_m");
    const foreign = await statusGET(statusReq("lib=user_a&ids="));
    const missing = await statusGET(statusReq("lib=org_nothing&ids="));
    const malformed = await statusGET(statusReq("lib=user_a%3Bdrop"));
    for (const r of [foreign, missing, malformed]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "Knihovna nenalezena." });
    }
  });

  it("an owner who lost Pro still sees their documents' status", async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ('user_lapsed')");
    signedIn("user_lapsed");
    const res = await statusGET(statusReq("lib=user_lapsed"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: [] });
  });

  it("signed out → 401; feature off → 503 without touching Clerk", async () => {
    signedIn(null);
    expect((await statusGET(statusReq("lib=user_a"))).status).toBe(401);
    process.env.FILES_MODE = "off";
    mocks.auth.mockClear();
    expect((await statusGET(statusReq("lib=user_a"))).status).toBe(503);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/clerk", () => {
  const hook = () => webhookPOST(new Request("https://dawmain.cz/api/webhooks/clerk", { method: "POST", body: "{}" }) as never);
  const purgeAfter = async (id: string) =>
    (await t.owner.query<{ purge_after: Date | null }>("SELECT purge_after FROM libraries WHERE id = $1", [id])).rows[0]?.purge_after;

  it("user.deleted schedules the purge in 7 days, drops terms, audits — idempotently", async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ('user_a')");
    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_a", deleted: true, object: "user" } });
    const res = await hook();
    expect(res.status).toBe(200);
    const first = await purgeAfter("user_a");
    expect(first!.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(first!.getTime() - Date.now()).toBeLessThan(7.1 * 86_400_000);
    expect((await t.owner.query("SELECT 1 FROM terms_acceptance WHERE user_id = 'user_a'")).rows).toHaveLength(0);
    expect((await hook()).status).toBe(200);
    expect((await purgeAfter("user_a"))!.getTime()).toBe(first!.getTime());
    const audit = await t.owner.query<{ action: string }>("SELECT action FROM audit_log WHERE library_id = 'user_a'");
    expect(audit.rows.map((r) => r.action)).toEqual(["user.deleted", "user.deleted"]);
  });

  it("organization.deleted marks the team library; accounts without a library are a no-op", async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ('org_b')");
    mocks.verifyWebhook.mockResolvedValue({ type: "organization.deleted", data: { id: "org_b", deleted: true, object: "organization" } });
    expect((await hook()).status).toBe(200);
    expect(await purgeAfter("org_b")).toBeInstanceOf(Date);
    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_never", deleted: true, object: "user" } });
    expect((await hook()).status).toBe(200);
    expect((await t.owner.query("SELECT 1 FROM libraries WHERE id = 'user_never'")).rows).toHaveLength(0);
  });

  it("malformed ids, a user id in organization.deleted and unrelated events are ignored with 2xx", async () => {
    for (const event of [
      { type: "user.deleted", data: { id: undefined } },
      { type: "user.deleted", data: { id: "org_b" } },
      { type: "organization.deleted", data: { id: "user_a" } },
      { type: "organization.deleted", data: { id: "org_b'; DROP TABLE libraries;--" } },
      { type: "user.created", data: { id: "user_new", email_addresses: [{ email_address: "jana@firma.cz" }] } },
    ]) {
      mocks.verifyWebhook.mockResolvedValue(event);
      const res = await hook();
      expect(res.status).toBe(200);
    }
    expect((await t.owner.query("SELECT 1 FROM audit_log")).rows).toHaveLength(0);
  });

  it("membership removal is logged without payload", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.verifyWebhook.mockResolvedValue({ type: "organizationMembership.deleted", data: { public_user_data: { identifier: "jana@firma.cz" } } });
    expect((await hook()).status).toBe(200);
    expect(info.mock.calls.flat().join(" ")).not.toContain("jana");
  });

  it("bad signature → 400; unset secret → 503; DB failure → 503 (Svix retries)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.verifyWebhook.mockRejectedValue(new Error("svix: no matching signature for jana@firma.cz"));
    expect((await hook()).status).toBe(400);
    expect([...warn.mock.calls, ...error.mock.calls].flat().join(" ")).not.toContain("jana");

    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    expect((await hook()).status).toBe(503);
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_test";

    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_a" } });
    setScopeRunner((() => Promise.reject(new Error("down"))) as never);
    expect((await hook()).status).toBe(503);
  });

  it("without the feature's database there is nothing to mark", async () => {
    delete process.env.FILES_DATABASE_URL;
    const runner = vi.fn();
    setScopeRunner(runner as never);
    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_a" } });
    expect((await hook()).status).toBe(200);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/files", () => {
  const cron = (auth?: string) =>
    cronGET(new Request("https://dawmain.cz/api/cron/files", { headers: auth === undefined ? {} : { authorization: auth } }));

  it("fails closed: no secret configured → 503; missing or wrong bearer → 401", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong")).status).toBe(401);
    expect((await cron("cron-secret-value")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await cron("Bearer undefined")).status).toBe(503);
    expect((await cron("Bearer ")).status).toBe(503);
    error.mockRestore();
  });

  it("unconfigured deployment → skipped", async () => {
    delete process.env.FILES_DATABASE_URL;
    expect(await (await cron("Bearer cron-secret-value")).json()).toEqual({ ok: true, skipped: "unconfigured" });
  });

  it("runs every maintenance task and reports counts", async () => {
    // Libraries in every state the cron cares about.
    await t.owner.query(`INSERT INTO libraries (id, purge_after) VALUES ('user_due', now() - interval '1 day')`);
    await t.owner.query(`INSERT INTO libraries (id) VALUES ('user_gone'), ('org_lost'), ('user_a')`);
    await t.owner.query(`INSERT INTO libraries (id, pro_revoked_at) VALUES ('org_old', now() - interval '91 days'), ('org_back', now() - interval '3 days')`);
    const doomed = await uploaded("user_a", "user_a", "doomed");
    // A document in the library due for purge (moved there by the owner role).
    const { rows: dueDoc } = await t.owner.query<{ id: string }>(
      `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter, rights,
         billable_pages, char_count, page_label_source) VALUES ('user_due', 'ready', 'user_due', 'pdf', 'x.pdf', $1, $1, 'pdf@1', 'vlastni', 1, 10, 'none')
       RETURNING id`,
      ["d".repeat(64)],
    );
    // A crashed ingest over its attempts, and an old failed upload still holding its text.
    const crashed = await uploaded("user_a", "user_a", "crashed");
    await t.owner.query("UPDATE documents SET status = 'processing', attempts = 3, lease_until = now() - interval '1 hour' WHERE id = $1", [crashed]);
    const failed = await uploaded("user_a", "user_a", "failed");
    await t.owner.query("UPDATE documents SET status = 'error', updated_at = now() - interval '8 days' WHERE id = $1", [failed]);

    const states: Record<string, "pro" | "not_pro" | "gone"> = {
      user_gone: "gone",
      org_lost: "not_pro",
      org_old: "not_pro",
      org_back: "pro",
      user_a: "pro",
    };
    const lookups: string[] = [];
    __setOwnerLookupForTests(async (id) => {
      lookups.push(id);
      return states[id] ?? "pro";
    });

    const res = await cron("Bearer cron-secret-value");
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary).toMatchObject({
      ok: true,
      mode: "on",
      purged: 1,
      purgedDocuments: 1,
      ownersChecked: 5,
      proRevoked: 1,
      proRestored: 1,
      scheduledPurges: 2,
      ingestsFailed: 1,
      ingestsRun: 1,
      pendingCleared: 1,
      errors: [],
    });
    expect(summary.dbBytes).toBeGreaterThan(0);
    expect(lookups).not.toContain("user_due");

    const lib = async (id: string) =>
      (await t.owner.query<{ purge_after: Date | null; pro_revoked_at: Date | null; purged_at: Date | null }>(
        "SELECT purge_after, pro_revoked_at, purged_at FROM libraries WHERE id = $1",
        [id],
      )).rows[0];
    expect((await lib("user_due")).purged_at).toBeInstanceOf(Date);
    expect(await statusOf(dueDoc[0].id)).toBeUndefined();
    expect((await lib("user_gone")).purge_after).toBeInstanceOf(Date);
    expect((await lib("org_lost")).pro_revoked_at).toBeInstanceOf(Date);
    expect((await lib("org_old")).purge_after!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await lib("org_back")).pro_revoked_at).toBeNull();
    expect(await statusOf(doomed)).toBe("ready");
    expect(await statusOf(crashed)).toBe("error");
    const pending = await t.owner.query<{ cleared: boolean }>("SELECT pending_gz IS NULL AS cleared FROM documents WHERE id = $1", [failed]);
    expect(pending.rows[0].cleared).toBe(true);
    const guards = await t.owner.query<{ value: { dbBytes: number; mode: string; at: string } }>("SELECT value FROM system_state WHERE key = $1", [GUARDS_STATE_KEY]);
    expect(guards.rows[0].value).toMatchObject({ mode: "on", dbBytes: expect.any(Number), at: expect.any(String) });
  });

  it("a purge-marked library revived meanwhile keeps its counters and gets no purge record; restored Pro revives a revoked_expired mark", async () => {
    // Listed as due, but revived by an upload after the cron read its list and before the purge ran.
    await t.owner.query(`INSERT INTO libraries (id, purge_after, pro_revoked_at) VALUES ('org_soon', now() - interval '1 hour', now() - interval '95 days')`);
    await t.owner.query(`INSERT INTO usage_daily (scope, day, uploads) VALUES ('org_soon', current_date, 3)`);
    // Marked after 90 days without Pro; Pro is back before the purge date.
    await t.owner.query(`INSERT INTO libraries (id, purge_after, pro_revoked_at) VALUES ('org_back2', now() + interval '1 day', now() - interval '92 days')`);
    // Marked because the owner was deleted: never looked up again.
    await t.owner.query(`INSERT INTO libraries (id, purge_after) VALUES ('user_del', now() + interval '6 days')`);
    const lookups: string[] = [];
    __setOwnerLookupForTests(async (id) => {
      lookups.push(id);
      return "pro";
    });
    let revived = false;
    setScopeRunner(async (scope, fn, options) => {
      if (!revived && scope.length === 1 && scope[0] === "org_soon") {
        revived = true;
        await t.owner.query("UPDATE libraries SET purge_after = NULL, pro_revoked_at = NULL WHERE id = 'org_soon'");
      }
      return t.runner(scope, fn, options);
    });
    const summary = await (await cron("Bearer cron-secret-value")).json();
    expect(summary).toMatchObject({ ok: true, purged: 0, purgedDocuments: 0, proRestored: 1, errors: [] });
    expect(lookups).toContain("org_back2");
    expect(lookups).not.toContain("user_del");
    const row = async (id: string) =>
      (await t.owner.query<{ purge_after: Date | null; pro_revoked_at: Date | null; purged_at: Date | null }>(
        "SELECT purge_after, pro_revoked_at, purged_at FROM libraries WHERE id = $1",
        [id],
      )).rows[0];
    expect((await row("org_soon")).purged_at).toBeNull();
    expect((await t.owner.query("SELECT 1 FROM usage_daily WHERE scope = 'org_soon'")).rows).toHaveLength(1);
    const audits = await t.owner.query<{ library_id: string; action: string }>("SELECT library_id, action FROM audit_log ORDER BY id");
    expect(audits.rows.filter((a) => a.action === "library.purged")).toEqual([]);
    expect(audits.rows).toContainEqual({ library_id: "org_back2", action: "library.revived" });
    expect(await row("org_back2")).toMatchObject({ purge_after: null, pro_revoked_at: null, purged_at: null });
    expect((await row("user_del")).purge_after).toBeInstanceOf(Date);
  });

  it("read-only: waiting ingests stay queued, over-attempt ones are still failed; Clerk errors are counted, not fatal", async () => {
    const waiting = await uploaded("user_a", "user_a", "waiting");
    const crashed = await uploaded("user_a", "user_a", "crashed");
    await t.owner.query("UPDATE documents SET status = 'processing', attempts = 3, lease_until = now() - interval '1 hour' WHERE id = $1", [crashed]);
    process.env.FILES_MODE = "readonly";
    __resetGuardsForTests();
    __setOwnerLookupForTests(async () => {
      throw Object.assign(new Error("rate limited"), { code: "api_response_error", status: 429 });
    });
    const summary = await (await cron("Bearer cron-secret-value")).json();
    expect(summary).toMatchObject({ mode: "readonly", ingestsRun: 0, ingestsFailed: 1, ownersChecked: 0 });
    expect(summary.errors).toContain("owner:clerk:429");
    expect(await statusOf(waiting)).toBe("queued");
    expect(await statusOf(crashed)).toBe("error");
  });
});
