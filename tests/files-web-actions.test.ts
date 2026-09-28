import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The operator page's Server Functions (app/vlastni-zdroje/provoz/actions.ts),
 * its data (src/files/operator.ts), the re-derivation of stored documents
 * (src/files/reindex.ts) and the web repository functions
 * (src/files/db/documents-web.ts). Clerk, after(), next/cache and the model
 * call are mocked; the database is PGlite with the real migrations.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  after: [] as Array<() => unknown>,
  propose: vi.fn(),
  revalidatePath: vi.fn(),
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
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: mocks.propose }));

import { reindexBatchAction, setModeOverride } from "@/app/vlastni-zdroje/provoz/actions";
import OperatorPage from "@/app/vlastni-zdroje/provoz/page";
import { POST as uploadPOST } from "@/app/api/files/documents/route";
import { __setAccessLoaderForTests, buildAccess } from "@/src/files/access";
import { ANALYZER_VERSION, TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import {
  clipText,
  documentPreviewText,
  finishReindex,
  invitationMarks,
  leaseForReindex,
  libraryDocCounts,
  mergeIdentKeys,
  metaContext,
  reindexBacklog,
  reindexCandidates,
  setDocumentEnabled,
  stuckDocuments,
} from "@/src/files/db/documents-web";
import { acceptTerms, audit, getSystemState } from "@/src/files/db/usage";
import { __resetGuardsForTests, effectiveMode, MODE_OVERRIDE_KEY } from "@/src/files/guards";
import { isOperator, operatorSnapshot, REINDEX_STATE_KEY } from "@/src/files/operator";
import { reindexBatch, reindexDocument } from "@/src/files/reindex";
import { __setTeamClientForTests } from "@/src/files/team";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

const ORIGIN = { origin: "https://dawmain.cz", host: "dawmain.cz" };
const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCE = "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti.";

function dmd(salt: string): string {
  return ["[s. 1]", "", "# Úvod", "", "## § 2913 [Porušení povinnosti]", "", `${SENTENCE} ${salt}`, "", "[s. 2]", "", "## § 2914", "", `${SENTENCE} ${salt}`, ""].join("\n");
}

function uploadRequest(lib: string, text: string): Request {
  const meta: UploadMeta = {
    library_id: lib,
    file: { name: "a.pdf", bytes: 1_000, sha256: "b".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: createHash("sha256").update(text).digest("hex"), chars: text.length },
    pages: { physical: 2, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
  };
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("dmd", new Blob([new Uint8Array(gzipSync(Buffer.from(text))) as Uint8Array<ArrayBuffer>]), "d.gz");
  return new Request("https://dawmain.cz/api/files/documents", { method: "POST", body: form, headers: ORIGIN });
}

let t: TestDb;
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
  process.env.FILES_OPERATOR_IDS = "user_op, ,user_op2";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  __setAccessLoaderForTests(async (userId) => buildAccess({ id: userId, publicMetadata: { pro: true } }, []));
  mocks.auth.mockReset();
  mocks.after.length = 0;
  mocks.revalidatePath.mockReset();
  mocks.propose.mockReset();
  mocks.propose.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
  for (const user of ["user_a", "user_b"]) await t.runner([], (db) => acceptTerms(db, user, TERMS_VERSION));
});
afterEach(async () => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
  for (const table of ["documents", "libraries", "usage_daily", "audit_log", "system_state", "terms_acceptance", "db_activity"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

const signedIn = (userId: string | null) => mocks.auth.mockResolvedValue({ userId });

async function uploaded(user: string, salt: string): Promise<string> {
  signedIn(user);
  const res = await uploadPOST(uploadRequest(user, dmd(salt)));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  for (const fn of mocks.after.splice(0)) await fn();
  return id;
}

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

// ---------------------------------------------------------------------------

describe("operator actions", () => {
  it("isOperator: only listed, well-formed user ids", () => {
    expect(isOperator("user_op")).toBe(true);
    expect(isOperator("user_op2")).toBe(true);
    expect(isOperator("user_a")).toBe(false);
    expect(isOperator("")).toBe(false);
    expect(isOperator(null)).toBe(false);
    process.env.FILES_OPERATOR_IDS = "";
    expect(isOperator("user_op")).toBe(false);
  });

  it("setModeOverride is refused for a non-operator, signed out, or when Clerk fails", async () => {
    for (const setup of [() => signedIn("user_a"), () => signedIn(null), () => mocks.auth.mockRejectedValue(new Error("no clerk"))]) {
      setup();
      await expect(setModeOverride(form({ mode: "off" }))).rejects.toThrow("Not allowed.");
    }
    expect(await t.runner([], (db) => getSystemState(db, MODE_OVERRIDE_KEY))).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("the operator restricts the mode, and 'auto' lifts the override again", async () => {
    signedIn("user_op");
    await setModeOverride(form({ mode: "readonly" }));
    __resetGuardsForTests();
    expect(await effectiveMode()).toBe("readonly");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/vlastni-zdroje/provoz");
    await setModeOverride(form({ mode: "auto" }));
    __resetGuardsForTests();
    expect(await effectiveMode()).toBe("on");
    await expect(setModeOverride(form({ mode: "maximum" }))).rejects.toThrow("Invalid mode.");
    const logged = await t.owner.query<{ actor: string; action: string }>("SELECT actor, action FROM audit_log ORDER BY id");
    expect(logged.rows).toEqual([
      { actor: "user_op", action: "mode.override" },
      { actor: "user_op", action: "mode.override" },
    ]);
  });

  it("an override can never lift env off", async () => {
    process.env.FILES_MODE = "off";
    signedIn("user_op");
    await setModeOverride(form({ mode: "on" }));
    __resetGuardsForTests();
    expect(await effectiveMode()).toBe("off");
  });

  it("reindexBatchAction: operator only; re-derives stale documents and records the result", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET analyzer_version = 0 WHERE id = $1", [id]);
    signedIn("user_a");
    await expect(reindexBatchAction()).rejects.toThrow("Not allowed.");
    signedIn("user_op");
    await reindexBatchAction();
    const doc = (await t.owner.query<{ analyzer_version: number; status: string }>("SELECT analyzer_version, status FROM documents WHERE id = $1", [id])).rows[0];
    expect(doc).toEqual({ analyzer_version: ANALYZER_VERSION, status: "review" });
    const last = await t.runner([], (db) => getSystemState<{ done: number; remaining: number }>(db, REINDEX_STATE_KEY));
    expect(last).toMatchObject({ done: 1, remaining: 0 });
  });
});

describe("operator page guard", () => {
  it("anyone but an operator gets the same 404 as a missing page", async () => {
    for (const setup of [() => signedIn("user_a"), () => signedIn(null), () => mocks.auth.mockRejectedValue(new Error("no clerk"))]) {
      setup();
      await expect(OperatorPage()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
  });

  it("an operator gets the page", async () => {
    signedIn("user_op");
    const page = await OperatorPage();
    expect(page).toBeTruthy();
  });
});

describe("operatorSnapshot", () => {
  it("guards, usage, libraries, stuck documents and the backlog — no titles or file names", async () => {
    const id = await uploaded("user_a", "x");
    await uploaded("user_b", "y");
    await t.owner.query("UPDATE documents SET status = 'error', status_detail = 'Zpracování selhalo.' WHERE id = $1", [id]);
    const snap = await operatorSnapshot();
    expect(snap.env).toBe("on");
    expect(snap.mode).toBe("on");
    expect(snap.override).toBeNull();
    expect(snap.uploadsThisMonth).toBe(2);
    expect(snap.pagesThisMonth).toBeGreaterThan(0);
    expect(snap.libraries.map((l) => l.id).sort()).toEqual(["user_a", "user_b"]);
    expect(snap.stuck.map((s) => s.id)).toEqual([id]);
    expect(snap.reindexBacklog).toBe(0);
    // The shared CPU allowance (uploads book their own parse/hash work).
    expect(snap.cpuMs30Days).toBeGreaterThanOrEqual(snap.cpuMsToday);
    expect(snap.cpuMsToday).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toContain("a.pdf");
  });
});

describe("reindex", () => {
  it("re-derives one document from its stored text, keeping its status and metadata", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET doc_type = 'komentar', commented_act = 'zak:89/2012', status = 'ready' WHERE id = $1", [id]);
    const chunksBefore = (await t.owner.query("SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1", [id])).rows[0];
    expect(await reindexDocument(id, "user_a")).toBe("done");
    const after = (await t.owner.query<{ status: string; run_token: string | null; ident_keys: string[]; section_range: string | null }>(
      "SELECT status, run_token, ident_keys, section_range FROM documents WHERE id = $1",
      [id],
    )).rows[0];
    expect(after.status).toBe("ready");
    expect(after.run_token).toBeNull();
    expect(after.ident_keys).toContain("zak:89/2012");
    expect(after.section_range).toBe("§ 2913–2914");
    const keys = (await t.owner.query<{ k: string }>("SELECT DISTINCT unnest(ident_keys) AS k FROM chunks WHERE doc_id = $1", [id])).rows.map((r) => r.k);
    expect(keys).toContain("parz:89/2012/2913");
    expect((await t.owner.query("SELECT count(*)::int AS n FROM chunks WHERE doc_id = $1", [id])).rows[0]).toEqual(chunksBefore);
  });

  it("skips documents in other states, foreign libraries and malformed ids; rolls back on a broken text", async () => {
    const id = await uploaded("user_a", "x");
    expect(await reindexDocument(id, "user_b")).toBe("skipped");
    expect(await reindexDocument("nope", "user_a")).toBe("skipped");
    await t.owner.query("UPDATE documents SET status = 'error' WHERE id = $1", [id]);
    expect(await reindexDocument(id, "user_a")).toBe("skipped");
    await t.owner.query("UPDATE documents SET status = 'review' WHERE id = $1", [id]);
    // A text shorter than char_count claims: fail, and leave the document untouched.
    await t.owner.query("UPDATE documents SET char_count = char_count + 50000 WHERE id = $1", [id]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await reindexDocument(id, "user_a")).toBe("failed");
    const doc = (await t.owner.query<{ status: string; run_token: string | null }>("SELECT status, run_token FROM documents WHERE id = $1", [id])).rows[0];
    expect(doc).toEqual({ status: "review", run_token: null });
  });

  it("reindexBatch: only stale documents, across libraries, at most `limit`", async () => {
    const a = await uploaded("user_a", "x");
    const b = await uploaded("user_b", "y");
    const c = await uploaded("user_a", "z");
    await t.owner.query("UPDATE documents SET analyzer_version = NULL WHERE id = ANY($1::uuid[])", [[a, b]]);
    const first = await reindexBatch(1);
    expect(first).toEqual({ done: 1, skipped: 0, failed: 0, remaining: 1 });
    const second = await reindexBatch(200);
    expect(second).toEqual({ done: 1, skipped: 0, failed: 0, remaining: 0 });
    const versions = (await t.owner.query<{ id: string; analyzer_version: number }>("SELECT id, analyzer_version FROM documents")).rows;
    expect(versions.every((v) => v.analyzer_version === ANALYZER_VERSION)).toBe(true);
    expect(versions.map((v) => v.id).sort()).toEqual([a, b, c].sort());
  });

  it("stops starting documents when the time budget is spent", async () => {
    const a = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET analyzer_version = NULL WHERE id = $1", [a]);
    let now = 0;
    const clock = () => {
      now += 300_000;
      return now;
    };
    expect(await reindexBatch(200, clock)).toEqual({ done: 0, skipped: 0, failed: 0, remaining: 1 });
  });
});

describe("documents-web repository", () => {
  it("setDocumentEnabled and libraryDocCounts respect the library", async () => {
    const id = await uploaded("user_a", "x");
    expect(await t.runner(["user_b"], (db) => setDocumentEnabled(db, id, "user_b", false))).toBe(false);
    expect(await t.runner(["user_a"], (db) => setDocumentEnabled(db, id, "user_a", false))).toBe(true);
    expect(await t.runner(["user_a"], (db) => setDocumentEnabled(db, "bad-id", "user_a", false))).toBe(false);
    await t.owner.query("UPDATE documents SET status = 'ready' WHERE id = $1", [id]);
    const counts = await t.runner(["user_a"], (db) => libraryDocCounts(db, ["user_a", "user_b"]));
    expect(counts.user_a).toEqual({ total: 1, ready: 1, review: 0, processing: 0, error: 0, searchable: 0 });
    expect(counts.user_b.total).toBe(0);
    // RLS: a scope without the library sees nothing even when asked for it.
    const hidden = await t.runner(["user_b"], (db) => libraryDocCounts(db, ["user_a"]));
    expect(hidden.user_a.total).toBe(0);
  });

  it("metaContext, preview text and clipText", async () => {
    const id = await uploaded("user_a", "x");
    const ctx = await t.runner(["user_a"], (db) => metaContext(db, id, "user_a"));
    expect(ctx?.sections.map((s) => s.heading)).toEqual(["Úvod", "§ 2913 [Porušení povinnosti]", "§ 2914"]);
    expect(ctx?.identKeys).toContain("par:2913");
    expect(await t.runner(["user_b"], (db) => metaContext(db, id, "user_b"))).toBeNull();
    const preview = await t.runner(["user_a"], (db) => documentPreviewText(db, id, "user_a", 60));
    expect(preview.length).toBeLessThanOrEqual(61);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toMatch(/\[s\. |#/);
    expect(clipText("krátké", 100)).toBe("krátké");
    expect(clipText("jedna dva tři čtyři pět", 12)).toBe("jedna dva…");
    expect(clipText("x".repeat(20), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("mergeIdentKeys replaces the metadata keys and keeps the text keys", () => {
    expect(mergeIdentKeys(["isbn:1", "par:2913", "sz:x"], ["isbn:1"], ["isbn:2", "par:2913"])).toEqual(["isbn:2", "par:2913", "sz:x"]);
    expect(mergeIdentKeys([], [], [])).toEqual([]);
    expect(mergeIdentKeys(Array.from({ length: 1_200 }, (_, i) => `k:${i}`), [], ["isbn:9"])).toHaveLength(1_000);
    expect(mergeIdentKeys(["", "x".repeat(201), "ok"], [], [])).toEqual(["ok"]);
  });

  it("stuck documents, reindex candidates and the backlog", async () => {
    const id = await uploaded("user_a", "x");
    await t.owner.query("UPDATE documents SET status = 'processing', updated_at = now() - interval '3 hours' WHERE id = $1", [id]);
    const stuck = await t.runner(["user_a"], (db) => stuckDocuments(db, ["user_a"], 60));
    expect(stuck.map((s) => [s.id, s.status])).toEqual([[id, "processing"]]);
    expect(await t.runner(["user_a"], (db) => stuckDocuments(db, ["user_a"], 600))).toEqual([]);
    await t.owner.query("UPDATE documents SET status = 'ready', analyzer_version = 0 WHERE id = $1", [id]);
    expect(await t.runner(["user_a"], (db) => reindexCandidates(db, ["user_a"], ANALYZER_VERSION, 10))).toEqual([{ id, libraryId: "user_a" }]);
    expect(await t.runner(["user_a"], (db) => reindexBacklog(db, ["user_a"], ANALYZER_VERSION))).toBe(1);
    expect(await t.runner(["user_b"], (db) => reindexBacklog(db, ["user_a"], ANALYZER_VERSION))).toBe(0);
  });

  it("the reindex lease: exclusive, and invisible outside its transaction", async () => {
    const id = await uploaded("user_a", "x");
    await t.runner(["user_a"], async (db) => {
      const lease = await leaseForReindex(db, id, "user_a");
      expect(lease?.previous).toBe("review");
      expect(await leaseForReindex(db, id, "user_a")).toBeNull();
      expect(await finishReindex(db, { id, libraryId: "user_a", runToken: "00000000-0000-4000-8000-000000000000", previous: "review", metaTsv: "", identKeys: [] })).toBe(false);
      expect(await finishReindex(db, { id, libraryId: "user_a", runToken: lease!.runToken, previous: "review", metaTsv: "", identKeys: ["a"] })).toBe(true);
    });
    expect((await t.owner.query<{ status: string }>("SELECT status FROM documents WHERE id = $1", [id])).rows[0].status).toBe("review");
  });

  it("invitationMarks reads declines and dismissals of one team", async () => {
    await t.runner([], async (db) => {
      await audit(db, { libraryId: "org_t", actor: "user_x", action: "invitation.declined", detail: { invitation: "orginv_1" } });
      await audit(db, { libraryId: "org_t", actor: "user_admin", action: "invitation.dismissed", detail: { invitation: "orginv_2" } });
      await audit(db, { libraryId: "org_other", actor: "user_x", action: "invitation.declined", detail: { invitation: "orginv_3" } });
    });
    const marks = await t.runner([], (db) => invitationMarks(db, "org_t"));
    expect([...marks.declined]).toEqual(["orginv_1"]);
    expect([...marks.dismissed]).toEqual(["orginv_2"]);
  });
});
