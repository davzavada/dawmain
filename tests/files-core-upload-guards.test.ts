import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests of the upload and ingest paths on PGlite (as dawmain_app
 * under RLS), for the review findings of the core area:
 *   - a purged or purge-marked library is used again by a Pro owner
 *     (core:F2 / completeness:PC-1);
 *   - takedown block and duplicate check on the normalized text (core:F7);
 *   - a re-upload (`replaces`) reserves only the difference (completeness:PC-2);
 *   - the per-library daily upload limit is atomic (security:F5);
 *   - global daily caps on uploads and CPU (ops:FT-5).
 * PGlite runs one transaction at a time, so two uploads started together
 * interleave transaction by transaction — exactly the race of a check in
 * one transaction and a bump in another.
 */

const propose = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: propose.fn }));

import { __setAccessLoaderForTests, buildAccess, type Access } from "@/src/files/access";
import { LIMITS, TERMS_VERSION } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { globalUsage, markLibraryForPurge, purgeLibraryContent } from "@/src/files/db/libraries";
import { acceptTerms } from "@/src/files/db/usage";
import { billablePages } from "@/src/files/dmd/billing";
import { parseDmd } from "@/src/files/dmd/parse";
import { __resetGuardsForTests } from "@/src/files/guards";
import { ingestDocument } from "@/src/files/ingest";
import { handleDocumentUpload, UPLOAD_GUARDS, type UploadOutcome } from "@/src/files/upload";
import type { ConversionQuality, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCES = [
  "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti.",
  "Jde o objektivní odpovědnost, u níž se zavinění škůdce nevyžaduje a liberace je možná jen výjimečně.",
  "Předpokladem vzniku povinnosti k náhradě je porušení povinnosti, vznik škody a příčinná souvislost.",
  "Soudní praxe dovodila, že mimořádná překážka musí být nepředvídatelná a nepřekonatelná.",
];

function paged(pages: number, salt = "", body = (p: number) => `${SENTENCES[p % 4]} ${SENTENCES[(p + 1) % 4]}`): string {
  const out: string[] = [];
  for (let p = 0; p < pages; p++) out.push(`[s. ${p + 1}]`, "", p === 0 ? `# Odpovědnost za škodu ${salt}` : "", "", `${body(p)} ${salt}`, "");
  return out.join("\n");
}
/** ~1,150 counted chars per page — several billed pages. */
const long = (pages: number, salt: string) => paged(pages, salt, () => SENTENCES.join(" ").repeat(3));
const pagesOf = (text: string) => billablePages(parseDmd(text).stats.countedChars);

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const gz = (s: string) => new Uint8Array(gzipSync(Buffer.from(s, "utf8")));

function meta(libraryId: string, text: string, over: Partial<UploadMeta> = {}): UploadMeta {
  return {
    library_id: libraryId,
    file: { name: "komentar.pdf", bytes: 99_000, sha256: "a".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 6, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
    ...over,
  };
}

function request(m: UploadMeta, dmd: Uint8Array): Request {
  const form = new FormData();
  form.append("meta", JSON.stringify(m));
  form.append("dmd", new Blob([dmd as Uint8Array<ArrayBuffer>]), "d.gz");
  return new Request("https://dawmain.cz/api/files/documents", { method: "POST", body: form });
}

const upload = (userId: string, lib: string, text: string, over: Partial<UploadMeta> = {}) =>
  handleDocumentUpload(request(meta(lib, text, over), gz(text)), userId);

const idOf = (o: UploadOutcome) => {
  if (o.status !== 201) throw new Error(`expected 201, got ${JSON.stringify(o)}`);
  return o.id;
};

// ---------------------------------------------------------------------------

let t: TestDb;
const ENV = { ...process.env };
/** Quota of user_q: set per test through the access loader. */
let quotaQ = 3_000;

const access = (userId: string): Access => {
  if (userId === "user_q") return buildAccess({ id: "user_q", publicMetadata: { pro: true, filesQuota: { pages: quotaQ } } }, []);
  if (userId === "user_a" || userId === "user_back") return buildAccess({ id: userId, publicMetadata: { pro: true } }, []);
  return buildAccess({ id: userId }, []);
};

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
  __setAccessLoaderForTests(async (userId) => access(userId));
  propose.fn.mockReset();
  propose.fn.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
  for (const user of ["user_a", "user_q", "user_back"]) await t.runner([], (db) => acceptTerms(db, user, TERMS_VERSION));
});
afterEach(async () => {
  process.env = { ...ENV };
  quotaQ = 3_000;
  for (const table of ["documents", "libraries", "usage_daily", "audit_log", "system_state", "terms_acceptance", "blocked_content"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

const libRow = async (id: string) =>
  (
    await t.owner.query<{ page_count: number; pages_reserved: number; doc_count: number; purge_after: unknown; purged_at: unknown; pro_revoked_at: unknown }>(
      "SELECT page_count, pages_reserved, doc_count, purge_after, purged_at, pro_revoked_at FROM libraries WHERE id = $1",
      [id],
    )
  ).rows[0];
const docStatus = async (id: string) =>
  (await t.owner.query<{ status: string; status_detail: string | null; content_sha256: string }>(
    "SELECT status, status_detail, content_sha256 FROM documents WHERE id = $1",
    [id],
  )).rows[0];
const todayUsage = async (scope: string, value: Record<string, number>, daysAgo = 0) => {
  const cols = Object.keys(value);
  await t.owner.query(
    `INSERT INTO usage_daily (day, scope, ${cols.join(", ")}) VALUES ((now() AT TIME ZONE 'UTC')::date - $1::int, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")})`,
    [daysAgo, scope, ...Object.values(value)],
  );
};

// ---------------------------------------------------------------------------

describe("a purged or purge-marked library used again (core:F2, completeness:PC-1)", () => {
  it("after the purge: the Pro owner's upload revives the library, ingest succeeds, the global sums count it", async () => {
    const first = idOf(await upload("user_back", "user_back", paged(3, "stará")));
    expect(await ingestDocument(first, "user_back")).toBe("done");
    await t.runner(["user_back"], async (db) => {
      await markLibraryForPurge(db, "user_back", new Date(Date.now() - 1000));
      await purgeLibraryContent(db, "user_back");
    });
    expect(await libRow("user_back")).toMatchObject({ page_count: 0, doc_count: 0 });

    const id = idOf(await upload("user_back", "user_back", paged(3, "nová")));
    expect(await libRow("user_back")).toMatchObject({ purge_after: null, purged_at: null, pro_revoked_at: null });
    expect(await ingestDocument(id, "user_back")).toBe("done");
    expect((await docStatus(id)).status).toBe("ready");
    // Purged content and counters stay gone: only the new document counts.
    expect(await libRow("user_back")).toMatchObject({ doc_count: 1, page_count: pagesOf(paged(3, "nová")), pages_reserved: 0 });
    const usage = await t.runner([], (db) => globalUsage(db));
    expect(usage).toMatchObject({ libraries: 1, totalPages: pagesOf(paged(3, "nová")) });
    const audit = await t.owner.query<{ action: string }>("SELECT action FROM audit_log WHERE library_id = 'user_back' AND action = 'library.revived'");
    expect(audit.rows).toHaveLength(1);
  });

  it("marked (revoked Pro, before the purge ran): the upload clears the mark and the purge no longer applies", async () => {
    const kept = idOf(await upload("user_back", "user_back", paged(3, "zůstane")));
    expect(await ingestDocument(kept, "user_back")).toBe("done");
    await t.owner.query("UPDATE libraries SET pro_revoked_at = now() - interval '91 days', purge_after = now() WHERE id = 'user_back'");

    const id = idOf(await upload("user_back", "user_back", paged(3, "nová")));
    expect(await ingestDocument(id, "user_back")).toBe("done");
    expect(await libRow("user_back")).toMatchObject({ purge_after: null, pro_revoked_at: null, doc_count: 2 });
    // A cron run working from a list read before the revival purges nothing.
    expect(await t.runner(["user_back"], (db) => purgeLibraryContent(db, "user_back"))).toBe(0);
    expect(await docStatus(kept)).toMatchObject({ status: "ready" });
    expect(await libRow("user_back")).toMatchObject({ purged_at: null, doc_count: 2 });
  });
});

describe("takedown and duplicates compare the normalized text (core:F7)", () => {
  it("an invisible change (U+200B, CRLF) neither evades the block nor stores the text twice", async () => {
    const text = paged(3, "blok");
    const tricked = text.replace("Odpovědnost", "Odpo​vědnost").replace(/\n/g, "\r\n");
    await t.owner.query("INSERT INTO blocked_content (content_sha256, reason) VALUES ($1, 'DSA notice')", [sha256(text)]);
    const blocked = await upload("user_a", "user_a", tricked);
    expect(blocked.status).toBe(422);

    await t.owner.query("DELETE FROM blocked_content");
    const id = idOf(await upload("user_a", "user_a", text));
    expect((await docStatus(id)).content_sha256).toBe(sha256(text));
    const again = await upload("user_a", "user_a", tricked);
    expect(again).toMatchObject({ status: 409, duplicate: { id } });
  });

  it("a leading BOM (dropped by the decoder) neither evades the block nor stores the text twice", async () => {
    const text = paged(3, "bom");
    const bom = `\uFEFF${text}`;
    await t.owner.query("INSERT INTO blocked_content (content_sha256, reason) VALUES ($1, 'DSA notice')", [sha256(text)]);
    expect((await upload("user_a", "user_a", bom)).status).toBe(422);

    await t.owner.query("DELETE FROM blocked_content");
    const id = idOf(await upload("user_a", "user_a", text));
    expect(await upload("user_a", "user_a", bom)).toMatchObject({ status: 409, duplicate: { id } });
    // Uploaded with the BOM first, the stored hash is still that of the text, and ingest accepts it.
    const other = paged(3, "bom2");
    const id2 = idOf(await upload("user_a", "user_a", `\uFEFF${other}`));
    expect((await docStatus(id2)).content_sha256).toBe(sha256(other));
    expect(await ingestDocument(id2, "user_a")).toBe("done");
  });

  it("the stored hash is that of the normalized text; ingest verifies the upload by it", async () => {
    const text = paged(3, "hash");
    const tricked = text.replace("Odpovědnost", "Odpo­vědnost");
    const id = idOf(await upload("user_a", "user_a", tricked));
    expect((await docStatus(id)).content_sha256).toBe(sha256(text));
    expect(await ingestDocument(id, "user_a")).toBe("done");
  });
});

describe("a re-upload (replaces) reserves only the difference (completeness:PC-2)", () => {
  it("a large document can be replaced in a nearly full library; counters settle to the new document", async () => {
    const v1 = long(14, "v1");
    const v2 = long(14, "v2");
    const p1 = pagesOf(v1);
    const p2 = pagesOf(v2);
    expect(p2).toBeGreaterThan(2);
    quotaQ = p1 + Math.max(0, p2 - p1) + 1;
    const old = idOf(await upload("user_q", "user_q", v1));
    expect(await ingestDocument(old, "user_q")).toBe("done");

    // A plain upload of the same size does not fit…
    expect((await upload("user_q", "user_q", long(14, "jiný"))).status).toBe(403);
    // …its re-upload does.
    const next = idOf(await upload("user_q", "user_q", v2, { replaces: old }));
    // A second re-upload of the same document while the first is in flight gets no second credit.
    const second = await upload("user_q", "user_q", long(14, "v3"), { replaces: old });
    expect(second.status).toBe(403);
    expect((second as { error: string }).error).toMatch(/v knihovně zbývá/);

    expect(await ingestDocument(next, "user_q")).toBe("done");
    expect(await libRow("user_q")).toMatchObject({ page_count: p2, pages_reserved: 0, doc_count: 1 });
  });

  it("a failed re-upload gives its reservation back and the old document still counts", async () => {
    const v1 = long(8, "v1");
    quotaQ = pagesOf(v1) + 1;
    const old = idOf(await upload("user_q", "user_q", v1));
    expect(await ingestDocument(old, "user_q")).toBe("done");
    const next = idOf(await upload("user_q", "user_q", long(8, "v2"), { replaces: old }));
    await t.owner.query("UPDATE documents SET pending_gz = '\\x00'::bytea WHERE id = $1", [next]);
    expect(await ingestDocument(next, "user_q")).toBe("failed");
    expect(await libRow("user_q")).toMatchObject({ page_count: pagesOf(v1), pages_reserved: 0, doc_count: 1 });
  });
});

describe("the daily upload limits (security:F5, ops:FT-5)", () => {
  it("the per-library limit holds for uploads started together", async () => {
    await todayUsage("user_a", { uploads: LIMITS.uploadsPerLibraryPerDay - 1 });
    const outcomes = await Promise.all([upload("user_a", "user_a", paged(3, "x1")), upload("user_a", "user_a", paged(3, "x2"))]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([201, 429]);
    const n = await t.owner.query<{ uploads: number }>("SELECT uploads FROM usage_daily WHERE scope = 'user_a'");
    expect(n.rows[0].uploads).toBe(LIMITS.uploadsPerLibraryPerDay);
  });

  it("a refused upload leaves the counters as they were", async () => {
    await todayUsage("user_a", { uploads: LIMITS.uploadsPerLibraryPerDay });
    expect((await upload("user_a", "user_a", paged(3, "y"))).status).toBe(429);
    const n = await t.owner.query<{ uploads: number }>("SELECT uploads FROM usage_daily WHERE scope = 'user_a'");
    expect(n.rows[0].uploads).toBe(LIMITS.uploadsPerLibraryPerDay);
    expect(await t.owner.query("SELECT 1 FROM usage_daily WHERE scope = 'global'").then((r) => r.rows.length)).toBe(0);
  });

  it("the global daily upload cap → 429 in Czech, also for uploads started together", async () => {
    await todayUsage("global", { uploads: UPLOAD_GUARDS.globalUploadsPerDay });
    const refused = await upload("user_a", "user_a", paged(3, "g"));
    expect(refused).toMatchObject({ status: 429 });
    expect((refused as { error: string }).error).toMatch(/Vlastní zdroje dnes přijaly/);

    await t.owner.query("UPDATE usage_daily SET uploads = $1 WHERE scope = 'global'", [UPLOAD_GUARDS.globalUploadsPerDay - 1]);
    const outcomes = await Promise.all([upload("user_a", "user_a", paged(3, "g1")), upload("user_q", "user_q", paged(3, "g2"))]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([201, 429]);
  });

  it("the global caps default to the plan's values and follow their env overrides", async () => {
    expect(UPLOAD_GUARDS).toMatchObject({ globalUploadsPerDay: 200, globalCpuMsPerDay: 600_000, globalCpuMs30Days: 3_600_000 });
    process.env.FILES_GLOBAL_UPLOADS_PER_DAY = "50";
    process.env.FILES_CPU_MS_DAY = "120000";
    process.env.FILES_CPU_MS_30D = "nonsense";
    expect(UPLOAD_GUARDS).toMatchObject({ globalUploadsPerDay: 50, globalCpuMsPerDay: 120_000, globalCpuMs30Days: 3_600_000 });
    await todayUsage("global", { uploads: 50 });
    expect(await upload("user_a", "user_a", paged(3, "env"))).toMatchObject({ status: 429 });
  });

  it("the global CPU caps: today, and the rolling 30 days", async () => {
    await todayUsage("global", { cpu_ms: UPLOAD_GUARDS.globalCpuMsPerDay });
    const today = await upload("user_a", "user_a", paged(3, "c"));
    expect(today).toMatchObject({ status: 429 });
    expect((today as { error: string }).error).toMatch(/výpočetní/);

    await t.owner.query("DELETE FROM usage_daily");
    const perDay = Math.ceil(UPLOAD_GUARDS.globalCpuMs30Days / 20);
    for (let d = 1; d <= 20; d++) await todayUsage("global", { cpu_ms: perDay }, d);
    const month = await upload("user_a", "user_a", paged(3, "c"));
    expect(month).toMatchObject({ status: 429 });
    expect((month as { error: string }).error).toMatch(/výpočetní/);

    await t.owner.query("DELETE FROM usage_daily");
    expect((await upload("user_a", "user_a", paged(3, "c"))).status).toBe(201);
  });

  it("cpu_ms books the feature's own work, not another request's CPU during a wait", async () => {
    const id = idOf(await upload("user_a", "user_a", paged(3, "cpu-wait")));
    const cpuOf = async () =>
      Number((await t.owner.query<{ cpu_ms: number }>("SELECT cpu_ms FROM usage_daily WHERE scope = 'global'")).rows[0]?.cpu_ms ?? 0);
    const afterUpload = await cpuOf();
    expect(afterUpload).toBeGreaterThan(0);
    // Stand-in for an MCP call running on the same instance while ingest waits for the model.
    propose.fn.mockImplementation(async () => {
      await Promise.resolve();
      const until = process.cpuUsage().user + 300_000;
      while (process.cpuUsage().user < until) {
        // burn 300 ms of CPU
      }
      return { meta: {}, ai: "skipped", detail: null };
    });
    expect(await ingestDocument(id, "user_a")).toBe("done");
    expect(propose.fn).toHaveBeenCalledTimes(1);
    const booked = (await cpuOf()) - afterUpload;
    expect(booked).toBeGreaterThan(0);
    expect(booked).toBeLessThan(200);
  });

  it("an accepted upload is counted once in its library and once in all", async () => {
    idOf(await upload("user_a", "user_a", long(10, "cpu")));
    const { rows } = await t.owner.query<{ scope: string; uploads: number }>("SELECT scope, uploads FROM usage_daily ORDER BY scope");
    expect(rows).toEqual([
      { scope: "global", uploads: 1 },
      { scope: "user_a", uploads: 1 },
    ]);
  });
});
