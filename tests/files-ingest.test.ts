import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ingest (src/files/ingest.ts) on PGlite with the real migrations, as
 * dawmain_app under RLS: claim → inflate → parse → metadata → derive →
 * one-transaction commit, failures, retries, the lease, `replaces`, the
 * AI budget and kickPendingIngests. The model call is mocked (no network);
 * everything else is the production code.
 */

const propose = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/src/files/meta/propose", () => ({ proposeMetadata: propose.fn }));

import { LIMITS } from "@/src/files/config";
import { setScopeRunner } from "@/src/files/db/client";
import { insertUploadedDocument } from "@/src/files/db/documents";
import { ensureLibrary, reservePages } from "@/src/files/db/libraries";
import { billablePages } from "@/src/files/dmd/billing";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { __resetGuardsForTests, MODE_OVERRIDE_KEY } from "@/src/files/guards";
import { aiBudget, inflatePending, IngestFailure, ingestDocument, kickPendingIngests, userHash } from "@/src/files/ingest";
import type { ConversionQuality, DocType, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

// ---------------------------------------------------------------------------
// Fixtures

const QUALITY: ConversionQuality = { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] };
const SENTENCES = [
  "Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti.",
  "Jde o objektivní odpovědnost, u níž se zavinění škůdce nevyžaduje a liberace je možná jen výjimečně.",
  "Předpokladem vzniku povinnosti k náhradě je porušení povinnosti, vznik škody a příčinná souvislost.",
  "Soudní praxe dovodila, že mimořádná překážka musí být nepředvídatelná a nepřekonatelná.",
  "Věřitel nemusí prokazovat zavinění dlužníka; postačí, že povinnost nebyla splněna řádně a včas.",
];

/** A paged commentary-like DMD: § sections, marginal numbers, footnotes citing sp. zn. */
function commentaryDmd(pages = 6, salt = ""): string {
  const out: string[] = [];
  let par = 2913;
  for (let p = 0; p < pages; p++) {
    out.push(`[s. ${1245 + p}]`, "");
    if (p % 2 === 0) out.push(`## § ${par++} [Ustanovení]`, "");
    out.push(`[m. č. ${p * 2 + 1}] ${SENTENCES[p % 5]} ${SENTENCES[(p + 1) % 5]}[^${p + 1}] ${salt}`, "");
    out.push(`[^${p + 1}]: Srov. rozsudek Nejvyššího soudu sp. zn. 25 Cdo ${1000 + p}/2019.`, "");
    out.push(`[m. č. ${p * 2 + 2}] ${SENTENCES[(p + 2) % 5]} ${SENTENCES[(p + 3) % 5]}`, "");
  }
  return out.join("\n");
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const gz = (s: string) => new Uint8Array(gzipSync(Buffer.from(s, "utf8")));

function uploadMeta(libraryId: string, text: string, over: Partial<UploadMeta> = {}): UploadMeta {
  return {
    library_id: libraryId,
    file: { name: "Petrov_OZ-komentar.pdf", bytes: 1234, sha256: "b".repeat(64), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha256(text), chars: text.length },
    pages: { physical: 6, label_source: "pdf_labels" },
    quality: QUALITY,
    hints: {},
    rights: "vlastni",
    ...over,
  };
}

// ---------------------------------------------------------------------------

let t: TestDb;
const ENV = { ...process.env };
const LIB = "user_owner";
const ORG = "org_team";

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});
beforeEach(() => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  setScopeRunner(t.runner);
  __resetGuardsForTests();
  propose.fn.mockReset();
  propose.fn.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
});
afterEach(async () => {
  process.env = { ...ENV };
  for (const table of ["documents", "libraries", "usage_daily", "audit_log", "system_state"]) {
    await t.owner.query(`DELETE FROM ${table}`);
  }
});

interface Seeded {
  id: string;
  pages: number;
}

/** What the upload does: library row, page reservation, queued row with the gzip. */
async function seed(
  lib: string,
  text: string,
  opts: { hint?: DocType; replaces?: string; uploadedBy?: string; pendingGz?: Uint8Array; sha?: string; pages?: number } = {},
): Promise<Seeded> {
  const pages = opts.pages ?? billablePages(parseDmd(normalizeDmd(text).text).stats.countedChars);
  return t.runner([lib], async (db) => {
    await ensureLibrary(db, lib, "Knihovna");
    expect(await reservePages(db, lib, pages, 100_000, 1_000_000)).toBe("ok");
    const meta = uploadMeta(lib, text, { doc_type_hint: opts.hint, replaces: opts.replaces });
    const r = await insertUploadedDocument(db, {
      libraryId: lib,
      uploadedBy: opts.uploadedBy ?? "user_owner",
      meta,
      contentSha256: opts.sha ?? sha256(text),
      charCount: text.length,
      billablePages: pages,
      physicalPages: 6,
      pendingGz: opts.pendingGz ?? gz(text),
      quality: QUALITY,
      hints: {},
      injectionFlag: false,
    });
    if (!("id" in r)) throw new Error("duplicate in fixture");
    return { id: r.id, pages };
  });
}

async function doc(id: string) {
  const { rows } = await t.owner.query<Record<string, unknown>>(
    `SELECT status, status_detail, pending_gz IS NULL AS pending_cleared, attempts, doc_type, title, section_range, anchor_label,
            proposed_meta, ident_keys, analyzer_version, confirmed_at, run_token, lease_until, meta_version, authors
       FROM documents WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function lib(id: string) {
  const { rows } = await t.owner.query<{ page_count: number; pages_reserved: number; doc_count: number }>(
    "SELECT page_count, pages_reserved, doc_count FROM libraries WHERE id = $1",
    [id],
  );
  return rows[0];
}

const count = async (sql: string, params: unknown[]) => Number((await t.owner.query<{ n: string }>(sql, params)).rows[0].n);

// ---------------------------------------------------------------------------

describe("ingestDocument — success", () => {
  it("indexes a queued upload, proposes metadata, lands in review and settles the pages", async () => {
    const text = commentaryDmd(6);
    const { id, pages } = await seed(LIB, text);
    expect(await lib(LIB)).toEqual({ page_count: 0, pages_reserved: pages, doc_count: 0 });

    expect(await ingestDocument(id, LIB)).toBe("done");

    const d = await doc(id);
    expect(d).toMatchObject({ status: "review", pending_cleared: true, attempts: 1, analyzer_version: 1, run_token: null, lease_until: null });
    expect(d.title).toBeTruthy();
    expect(d.ident_keys as string[]).toContain("sz:25cdo1000-2019");
    expect(await count("SELECT count(*) AS n FROM chunks WHERE doc_id = $1", [id])).toBeGreaterThan(0);
    expect(await count("SELECT count(*) AS n FROM doc_pages WHERE doc_id = $1", [id])).toBe(6);
    expect(await count("SELECT count(*) AS n FROM doc_footnotes WHERE doc_id = $1", [id])).toBe(6);
    expect(await count("SELECT count(*) AS n FROM doc_blocks WHERE doc_id = $1", [id])).toBeGreaterThan(0);
    expect(await lib(LIB)).toEqual({ page_count: pages, pages_reserved: 0, doc_count: 1 });
    expect(propose.fn).toHaveBeenCalledTimes(1);
  });

  it("the uploader's type hint wins; a commentary gets its § range and anchor label", async () => {
    const { id } = await seed(LIB, commentaryDmd(6), { hint: "komentar" });
    expect(await ingestDocument(id, LIB)).toBe("done");
    const d = await doc(id);
    expect(d.doc_type).toBe("komentar");
    expect(d.section_range).toBe("§ 2913–2915");
    expect(d.anchor_label).toBe("m. č.");
    expect((d.proposed_meta as Record<string, { source: string }>).doc_type.source).toBe("user");
  });

  it("merges the AI proposal and stores its Czech note in status_detail", async () => {
    propose.fn.mockResolvedValue({
      meta: { title: { value: "Občanský zákoník. Komentář", source: "ai", confidence: 0.8 } },
      ai: "failed",
      detail: "Návrh metadat pomocí AI se nepodařil. Metadata jsou navržena jen z textu dokumentu.",
    });
    const { id } = await seed(LIB, commentaryDmd(4));
    expect(await ingestDocument(id, LIB)).toBe("done");
    const d = await doc(id);
    expect(d.title).toBe("Občanský zákoník. Komentář");
    expect(d.status_detail).toMatch(/^Návrh metadat/);
  });

  it("passes an opaque user hash and the budget callbacks to the model call", async () => {
    let seen: { userHash: string } | null = null;
    propose.fn.mockImplementation(async (_input, opts) => {
      seen = opts;
      expect(await opts.allow()).toBe(true);
      await opts.record(0.0012);
      return { meta: {}, ai: "ok", detail: null };
    });
    const { id } = await seed(LIB, commentaryDmd(4));
    expect(await ingestDocument(id, LIB)).toBe("done");
    expect(seen!.userHash).toMatch(/^[0-9a-f]{32}$/);
    expect(seen!.userHash).not.toContain("owner");
    const { rows } = await t.owner.query<{ scope: string; ai_calls: number; ai_microusd: string }>(
      "SELECT scope, ai_calls, ai_microusd FROM usage_daily WHERE ai_calls > 0 ORDER BY scope",
    );
    expect(rows.map((r) => [r.scope, r.ai_calls, Number(r.ai_microusd)])).toEqual([
      ["global", 1, 1200],
      [LIB, 1, 1200],
    ]);
  });

  it("records the run's CPU time", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    await ingestDocument(id, LIB);
    expect(await count("SELECT count(*) AS n FROM usage_daily WHERE scope = 'global' AND cpu_ms > 0", [])).toBe(1);
  });

  it("autoConfirm → ready; aiProposals false → no model call", async () => {
    const { id } = await seed(ORG, commentaryDmd(4));
    await t.owner.query(`UPDATE libraries SET settings = '{"autoConfirm": true, "aiProposals": false}' WHERE id = $1`, [ORG]);
    expect(await ingestDocument(id, ORG)).toBe("done");
    const d = await doc(id);
    expect(d.status).toBe("ready");
    expect(d.confirmed_at).not.toBeNull();
    expect(propose.fn).not.toHaveBeenCalled();
  });
});

describe("ingestDocument — replaces", () => {
  it("a re-upload of a confirmed document keeps the confirmed metadata, becomes ready and deletes the old one", async () => {
    const old = await seed(LIB, commentaryDmd(6, "stará verze"));
    expect(await ingestDocument(old.id, LIB)).toBe("done");
    await t.owner.query(
      `UPDATE documents SET status = 'ready', confirmed_at = now(), confirmed_by = 'user_owner', doc_type = 'komentar',
              title = 'Potvrzený název', authors = '{"Jan Petrov"}', commented_act = 'zak:89/2012' WHERE id = $1`,
      [old.id],
    );
    const fresh = await seed(LIB, commentaryDmd(8, "nová verze"), { replaces: old.id });
    expect(await lib(LIB)).toMatchObject({ page_count: old.pages, pages_reserved: fresh.pages, doc_count: 1 });

    expect(await ingestDocument(fresh.id, LIB)).toBe("done");

    const d = await doc(fresh.id);
    expect(d).toMatchObject({ status: "ready", title: "Potvrzený název", doc_type: "komentar", authors: ["Jan Petrov"] });
    expect(d.section_range).toBe("§ 2913–2916");
    expect(d.ident_keys as string[]).toContain("zak:89/2012");
    expect(await doc(old.id)).toBeUndefined();
    expect(await count("SELECT count(*) AS n FROM chunks WHERE doc_id = $1", [old.id])).toBe(0);
    expect(await lib(LIB)).toEqual({ page_count: fresh.pages, pages_reserved: 0, doc_count: 1 });
    expect(propose.fn).toHaveBeenCalledTimes(1); // only for the original
    const audit = await t.owner.query<{ action: string; detail: { replaced: string } }>("SELECT action, detail FROM audit_log WHERE doc_id = $1", [fresh.id]);
    expect(audit.rows).toEqual([expect.objectContaining({ action: "document.replaced", detail: expect.objectContaining({ replaced: old.id }) })]);
  });

  it("replacing a document still in review: the new one goes to review, the old one is deleted", async () => {
    const old = await seed(LIB, commentaryDmd(4, "a"));
    await ingestDocument(old.id, LIB);
    const fresh = await seed(LIB, commentaryDmd(4, "b"), { replaces: old.id });
    expect(await ingestDocument(fresh.id, LIB)).toBe("done");
    expect((await doc(fresh.id)).status).toBe("review");
    expect(await doc(old.id)).toBeUndefined();
    expect(await lib(LIB)).toEqual({ page_count: fresh.pages, pages_reserved: 0, doc_count: 1 });
  });

  it("a replaced document still queued gives its reservation back", async () => {
    const old = await seed(LIB, commentaryDmd(4, "a"));
    const fresh = await seed(LIB, commentaryDmd(4, "b"), { replaces: old.id });
    expect(await ingestDocument(fresh.id, LIB)).toBe("done");
    expect(await doc(old.id)).toBeUndefined();
    expect(await lib(LIB)).toEqual({ page_count: fresh.pages, pages_reserved: 0, doc_count: 1 });
  });
});

describe("ingestDocument — lease and isolation", () => {
  it("a document already ingested, or leased by another run, is 'lost' and untouched", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    await t.owner.query("UPDATE documents SET status = 'processing', lease_until = now() + interval '5 minutes', run_token = gen_random_uuid() WHERE id = $1", [id]);
    expect(await ingestDocument(id, LIB)).toBe("lost");
    expect((await doc(id)).status).toBe("processing");
    await t.owner.query("UPDATE documents SET status = 'queued', lease_until = NULL, run_token = NULL WHERE id = $1", [id]);
    expect(await ingestDocument(id, LIB)).toBe("done");
    expect(await ingestDocument(id, LIB)).toBe("lost");
  });

  it("the lease lost mid-run: nothing is written, the other run keeps the document", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    propose.fn.mockImplementation(async () => {
      // Another run took over (e.g. after this one looked dead).
      await t.owner.query("UPDATE documents SET run_token = gen_random_uuid() WHERE id = $1", [id]);
      return { meta: {}, ai: "skipped", detail: null };
    });
    expect(await ingestDocument(id, LIB)).toBe("lost");
    const d = await doc(id);
    expect(d).toMatchObject({ status: "processing", pending_cleared: false });
    expect(await count("SELECT count(*) AS n FROM chunks WHERE doc_id = $1", [id])).toBe(0);
    expect(await lib(LIB)).toMatchObject({ page_count: 0, doc_count: 0 });
  });

  it("another library's id cannot claim the document (RLS + explicit filter)", async () => {
    const { id } = await seed(ORG, commentaryDmd(4));
    expect(await ingestDocument(id, LIB)).toBe("lost");
    expect(await ingestDocument(id, "org_other")).toBe("lost");
    expect((await doc(id)).status).toBe("queued");
  });

  it("malformed ids and a disabled deployment never touch the database", async () => {
    const runner = vi.fn();
    setScopeRunner(runner as never);
    for (const [d, l] of [["not-a-uuid", LIB], ["00000000-0000-0000-0000-000000000000", "user_x;drop"], [42, LIB]] as const) {
      expect(await ingestDocument(d as string, l)).toBe("failed");
    }
    process.env.FILES_MODE = "off";
    expect(await ingestDocument("00000000-0000-4000-8000-000000000000", LIB)).toBe("failed");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("ingestDocument — failures", () => {
  it("a corrupt gzip fails for good and releases the reservation", async () => {
    const text = commentaryDmd(4);
    const { id } = await seed(LIB, text, { pendingGz: new Uint8Array([1, 2, 3, 4]) });
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "error", status_detail: expect.stringMatching(/poškozený/) });
    expect(await lib(LIB)).toEqual({ page_count: 0, pages_reserved: 0, doc_count: 0 });
  });

  it("a text whose hash differs from the verified one fails", async () => {
    const { id } = await seed(LIB, commentaryDmd(4), { sha: "c".repeat(64) });
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect((await doc(id)).status).toBe("error");
  });

  it("a DMD safety limit fails for good with a Czech detail", async () => {
    const text = `Nadpis\n\n${"x".repeat(31_000)}\n`;
    const { id } = await seed(LIB, text, { pages: 9 });
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "error", status_detail: expect.stringMatching(/bezpečnostní limit.*Řádek/) });
    expect(await lib(LIB)).toMatchObject({ pages_reserved: 0 });
  });

  it("unexpected failures are retried up to 3 attempts, then error + release; logs carry no content", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    propose.fn.mockRejectedValue(Object.assign(new Error("secret text of the document"), { code: "XX000" }));
    const { id, pages } = await seed(LIB, commentaryDmd(4));
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "queued", attempts: 1, pending_cleared: false });
    expect(await lib(LIB)).toMatchObject({ pages_reserved: pages });
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "error", attempts: 3 });
    expect(await lib(LIB)).toMatchObject({ pages_reserved: 0 });
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
    log.mockRestore();

    // A later success is impossible without a new upload.
    propose.fn.mockResolvedValue({ meta: {}, ai: "skipped", detail: null });
    expect(await ingestDocument(id, LIB)).toBe("lost");
  });

  it("a crashed run over its attempts (expired lease) is failed on claim", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    await t.owner.query("UPDATE documents SET status = 'processing', attempts = 3, lease_until = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "error", attempts: 4 });
    expect(propose.fn).not.toHaveBeenCalled();
    expect(await lib(LIB)).toMatchObject({ pages_reserved: 0 });
  });

  it("a library marked for purge is not ingested", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    await t.owner.query("UPDATE libraries SET purge_after = now() + interval '7 days' WHERE id = $1", [LIB]);
    expect(await ingestDocument(id, LIB)).toBe("failed");
    expect(await doc(id)).toMatchObject({ status: "error", status_detail: "Knihovna je určena ke smazání." });
  });

  it("a database outage during claim is 'failed' and leaves the queue as it was", async () => {
    const { id } = await seed(LIB, commentaryDmd(4));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setScopeRunner((() => Promise.reject(new Error("connection refused"))) as never);
    expect(await ingestDocument(id, LIB)).toBe("failed");
    log.mockRestore();
    setScopeRunner(t.runner);
    expect((await doc(id)).status).toBe("queued");
  });
});

describe("kickPendingIngests", () => {
  it("runs waiting documents one after another and says how many", async () => {
    const a = await seed(LIB, commentaryDmd(4, "a"));
    const b = await seed(ORG, commentaryDmd(4, "b"));
    expect(await kickPendingIngests(5)).toBe(2);
    expect((await doc(a.id)).status).toBe("review");
    expect((await doc(b.id)).status).toBe("review");
    expect(await kickPendingIngests(5)).toBe(0);
  });

  it("honours the limit", async () => {
    await seed(LIB, commentaryDmd(4, "a"));
    await seed(LIB, commentaryDmd(4, "b"));
    expect(await kickPendingIngests(1)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM documents WHERE status = 'queued'", [])).toBe(1);
  });

  it("does nothing unless the mode is 'on' (read-only must not grow the DB)", async () => {
    await seed(LIB, commentaryDmd(4));
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, '\"readonly\"')", [MODE_OVERRIDE_KEY]);
    expect(await kickPendingIngests(5)).toBe(0);
    process.env.FILES_MODE = "readonly";
    expect(await kickPendingIngests(5)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM documents WHERE status = 'queued'", [])).toBe(1);
  });

  it("never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setScopeRunner((() => Promise.reject(new Error("down"))) as never);
    await expect(kickPendingIngests(2)).resolves.toBe(0);
    log.mockRestore();
  });
});

describe("aiBudget", () => {
  it("refuses once the rolling 30-day spend reaches LIMITS.aiBudgetUsd", async () => {
    const budget = aiBudget(LIB);
    expect(await budget.allow()).toBe(true);
    await t.owner.query("INSERT INTO usage_daily (day, scope, ai_microusd) VALUES (current_date - 29, 'global', $1)", [LIMITS.aiBudgetUsd * 1_000_000]);
    expect(await budget.allow()).toBe(false);
    await t.owner.query("UPDATE usage_daily SET day = current_date - 30 WHERE scope = 'global'");
    expect(await budget.allow()).toBe(true);
  });

  it("refuses after the library's daily proposals", async () => {
    await t.owner.query("INSERT INTO usage_daily (day, scope, ai_calls) VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2)", [LIB, LIMITS.aiProposalsPerLibraryPerDay]);
    expect(await aiBudget(LIB).allow()).toBe(false);
    expect(await aiBudget(ORG).allow()).toBe(true);
  });

  it("books at least one micro-dollar per call, nothing negative", async () => {
    await aiBudget(ORG).record(-5);
    await aiBudget(ORG).record(0.0000001);
    const { rows } = await t.owner.query<{ ai_calls: number; ai_microusd: string }>("SELECT ai_calls, ai_microusd FROM usage_daily WHERE scope = $1", [ORG]);
    expect(rows[0].ai_calls).toBe(2);
    expect(Number(rows[0].ai_microusd)).toBe(1);
  });
});

describe("inflatePending / userHash", () => {
  it("round-trips valid text and checks the hash", () => {
    const text = "Příliš žluťoučký kůň [s. 1]";
    expect(inflatePending(gz(text), sha256(text))).toBe(text);
    expect(inflatePending(gz(text))).toBe(text);
    expect(() => inflatePending(gz(text), "0".repeat(64))).toThrow(IngestFailure);
  });

  it("a decompression bomb stops at LIMITS.maxTextBytes", () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(LIMITS.maxTextBytes + 1024, 0x61)));
    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(() => inflatePending(bomb)).toThrow(IngestFailure);
  });

  it("invalid UTF-8 and garbage are not retryable failures", () => {
    const bad = new Uint8Array(gzipSync(Buffer.from([0x61, 0xff, 0xfe, 0x62])));
    for (const input of [bad, new Uint8Array([0x1f, 0x8b, 0, 0]), new Uint8Array(0)]) {
      try {
        inflatePending(input);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(IngestFailure);
        expect((e as IngestFailure).retryable).toBe(false);
      }
    }
  });

  it("userHash is stable, opaque and per user", () => {
    expect(userHash("user_abc")).toBe(userHash("user_abc"));
    expect(userHash("user_abc")).not.toBe(userHash("user_abd"));
    expect(userHash("user_abc")).not.toContain("abc");
  });
});

