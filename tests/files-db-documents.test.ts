import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import {
  MAX_INGEST_ATTEMPTS,
  claimForIngest,
  confirmDocument,
  deleteDocument,
  documentStatuses,
  failIngest,
  finishIngest,
  getDocument,
  insertUploadedDocument,
  isBlocked,
  listDocuments,
  pendingCounts,
  updateDocumentMeta,
  writeDocumentIndex,
} from "@/src/files/db/documents";
import { ensureLibrary } from "@/src/files/db/libraries";
import { loadFootnotes, loadReadDoc, loadText } from "@/src/files/db/reading";
import type { ParsedDoc } from "@/src/files/dmd/types";
import type { Derived, DerivedChunk } from "@/src/files/index/types";
import type { BibMeta, DocType, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * Documents and reading repositories on PGlite (production migrations, run
 * as dawmain_app with RLS). Libraries: user_a and org_b; every read/write
 * is also checked against a document of the OTHER library, both when RLS
 * hides it (scope [user_a]) and when only the explicit library filter does
 * (scope [user_a, org_b]).
 */

let t: TestDb;
const A = "user_a";
const B = "org_b";
const NOBODY = "00000000-0000-4000-8000-000000000000";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const scoped = <T>(libs: string[], fn: (db: Queryable) => Promise<T>) => withScope(libs, fn);

// A paged DMD: 2 pages, one § section, one footnote defined on page 2.
const P1 = "[s. 245]\n";
const H = "# § 2913 Porušení\n\n";
const BODY = "Smlouva a náhrada škody[^1] se řídí zákonem.\n\n";
const P2 = "[s. 246]\n";
const DEF = "[^1]: Srov. 25 Cdo 1234/2019.\n";
const TEXT = P1 + H + BODY + P2 + DEF;
const at = (part: string) => TEXT.indexOf(part);

function parsedFixture(text = TEXT): ParsedDoc {
  const p2 = at(P2);
  return {
    text,
    paged: true,
    pages: [
      { ord: 1, label: "245", start: 0, end: p2, flags: 0 },
      { ord: 2, label: "246", start: p2, end: text.length, flags: 1 },
    ],
    blocks: [],
    sections: [
      {
        ord: 0,
        parent: null,
        level: 1,
        kind: "par",
        key: "par:2913",
        keyNum: 2913,
        heading: "§ 2913 Porušení",
        author: null,
        start: at(H),
        end: text.length,
        pageFrom: 1,
        pageTo: 2,
        indexed: true,
      },
    ],
    footnotes: [
      {
        seq: 1,
        label: "1",
        kind: "f",
        refAt: at("[^1]"),
        defStart: at(DEF) + 6,
        defEnd: text.length - 1,
        page: 1,
        section: 0,
        anchor: null,
      },
    ],
    refs: [],
    anchorLabel: null,
    stats: { chars: text.length, countedChars: text.length, physicalPages: 2, headings: 1, footnotes: 1, danglingRefs: 0, danglingDefs: 0, marginalNumbers: 0 },
    problems: [],
  };
}

function chunk(ord: number, tsv: string, keys: string[] = [], start = at(BODY), end = TEXT.length): DerivedChunk {
  return { ord, start, end, pageFrom: 1, pageTo: 2, section: 0, anchorFrom: null, anchorTo: null, tsv, identKeys: keys };
}

function derivedFixture(chunks: DerivedChunk[] = [chunk(0, "'smlouv':1C 'nahrad':3C 'skod':4C", ["sz:25cdo1234-2019", "sec:par:2913"])]): Derived {
  return { chunks, docIdentKeys: ["sz:25cdo1234-2019"], sectionRange: "§ 2913" };
}

/** Blocks of ~`size` chars tiling `text`. */
function tile(text: string, size: number) {
  const blocks: Array<{ ord: number; start: number; end: number }> = [];
  for (let s = 0; s < text.length; s += size) blocks.push({ ord: blocks.length, start: s, end: Math.min(text.length, s + size) });
  return blocks;
}

function uploadMeta(lib: string, name: string, content: string, hint?: DocType): UploadMeta {
  return {
    library_id: lib,
    file: { name, bytes: 12345, sha256: sha(`file:${content}`), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha(content), chars: content.length },
    pages: { physical: 2, label_source: "printed" },
    quality: { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] },
    hints: {},
    rights: "vlastni",
    doc_type_hint: hint,
  };
}

const META: BibMeta = {
  doc_type: "komentar",
  title: "Občanský zákoník. Komentář",
  authors: ["Petrov, Jan"],
  editors: [],
  isbn: ["9788074007855"],
  keywords: ["náhrada škody"],
  language: "cs",
  year: 2019,
  commented_act: "zak:89/2012",
  decided_on: "2019-05-01",
  section_range: "§ 2913",
};

async function upload(lib: string, content: string, name = "kniha.pdf", hint?: DocType, scope = [lib]) {
  return scoped(scope, (db) =>
    insertUploadedDocument(db, {
      libraryId: lib,
      uploadedBy: "user_u1",
      meta: uploadMeta(lib, name, content, hint),
      contentSha256: sha(content),
      charCount: content.length,
      billablePages: 2,
      physicalPages: 2,
      pendingGz: Buffer.from("gz:" + content),
      quality: uploadMeta(lib, name, content).quality,
      hints: { pdf_info: { title: "T" } },
      injectionFlag: false,
    }),
  );
}

/** Upload + full ingest; returns the id. */
async function ingested(lib: string, content: string, status: "review" | "ready" = "review", meta: BibMeta = META) {
  const res = await upload(lib, content);
  if (!("id" in res)) throw new Error("duplicate");
  const claim = await scoped([lib], (db) => claimForIngest(db, res.id, lib));
  if (!claim) throw new Error("claim failed");
  await scoped([lib], async (db) => {
    const ok = await writeDocumentIndex(db, {
      id: res.id,
      libraryId: lib,
      runToken: claim.runToken,
      text: TEXT,
      blocks: tile(TEXT, 20),
      parsed: parsedFixture(),
      derived: derivedFixture(),
      analyzerVersion: 1,
    });
    if (!ok) throw new Error("write failed");
    await finishIngest(db, {
      id: res.id,
      libraryId: lib,
      runToken: claim.runToken,
      proposed: { title: { value: meta.title, source: "ai", confidence: 0.8 } },
      meta,
      metaTsv: "'obcansk':1A 'zakonik':2A",
      identKeys: ["zak:89/2012"],
      status,
      statusDetail: null,
    });
  });
  return res.id;
}

const count = async (table: string, id: string) =>
  Number((await t.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE doc_id = $1`, [id])).rows[0].n);

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
  await scoped([A], (db) => ensureLibrary(db, A, "Anna"));
  await scoped([B], (db) => ensureLibrary(db, B, "Tým B"));
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});

describe("insertUploadedDocument", () => {
  it("inserts a queued document with the hint as provisional doc_type and a user proposal", async () => {
    const res = await upload(A, "content-insert", "Komentář.pdf", "komentar");
    expect("id" in res).toBe(true);
    const id = (res as { id: string }).id;
    const row = await scoped([A], (db) => getDocument(db, id, [A]));
    expect(row).toMatchObject({
      status: "queued",
      library_id: A,
      file_name: "Komentář.pdf",
      file_bytes: 12345,
      billable_pages: 2,
      page_label_source: "printed",
      attempts: 0,
      enabled: true,
      replaces: null,
      meta_version: 0,
      hints: { pdf_info: { title: "T" } },
    });
    expect(row!.meta.doc_type).toBe("komentar");
    expect(row!.meta.title).toBe("Komentář.pdf");
    expect(row!.proposed_meta?.doc_type).toEqual({ value: "komentar", source: "user", confidence: 0.9 });
    expect(row!.quality.footnotes).toBe("linked");
  });

  it("returns the existing document for the same content in the same library", async () => {
    const first = (await upload(A, "content-dup", "a.pdf")) as { id: string };
    const second = await upload(A, "content-dup", "b.pdf");
    expect(second).toEqual({ duplicate: { id: first.id, title: "a.pdf" } });
  });

  it("dedupes per library only — the same content in another library is a new document, not a leak", async () => {
    const a = (await upload(A, "content-shared")) as { id: string };
    const b = await upload(B, "content-shared");
    expect("id" in b && b.id !== a.id).toBe(true);
  });

  it("cannot insert into a library outside the scope", async () => {
    await expect(
      scoped([A], (db) =>
        insertUploadedDocument(db, {
          libraryId: B,
          uploadedBy: "user_u1",
          meta: uploadMeta(B, "x.pdf", "content-foreign"),
          contentSha256: sha("content-foreign"),
          charCount: 1,
          billablePages: 1,
          physicalPages: 1,
          pendingGz: Buffer.from("x"),
          quality: uploadMeta(B, "x", "y").quality,
          hints: {},
          injectionFlag: false,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("never sets `replaces` (re-uploads are no longer accepted), even when a stale client sends one", async () => {
    const own = (await upload(A, "content-old")) as { id: string };
    const r1 = (await scoped([A], (db) =>
      insertUploadedDocument(db, {
        libraryId: A,
        uploadedBy: "user_u1",
        meta: { ...uploadMeta(A, "n.pdf", "content-new-1"), replaces: own.id } as UploadMeta,
        contentSha256: sha("content-new-1"),
        charCount: "content-new-1".length,
        billablePages: 2,
        physicalPages: 2,
        pendingGz: Buffer.from("gz:content-new-1"),
        quality: uploadMeta(A, "n.pdf", "content-new-1").quality,
        hints: {},
        injectionFlag: false,
      }),
    )) as { id: string };
    const get = (id: string) => scoped([A], (db) => getDocument(db, id, [A]));
    expect((await get(r1.id))!.replaces).toBeNull();
  });
});

describe("ingest lease", () => {
  it("claims once, then refuses while the lease is held; returns the pending text", async () => {
    const { id } = (await upload(A, "content-lease")) as { id: string };
    const c1 = await scoped([A], (db) => claimForIngest(db, id, A));
    expect(c1).not.toBeNull();
    expect(Buffer.from(c1!.pendingGz).toString()).toBe("gz:content-lease");
    expect(c1!.row.status).toBe("processing");
    expect(c1!.row.attempts).toBe(1);
    expect(await scoped([A], (db) => claimForIngest(db, id, A))).toBeNull();
  });

  it("an expired lease is re-claimed; the old run token then loses every write", async () => {
    const { id } = (await upload(A, "content-lost")) as { id: string };
    const c1 = (await scoped([A], (db) => claimForIngest(db, id, A, 60)))!;
    await t.owner.query("UPDATE documents SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
    const c2 = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    expect(c2.runToken).not.toBe(c1.runToken);
    expect(c2.row.attempts).toBe(2);

    const write = (token: string) =>
      scoped([A], (db) =>
        writeDocumentIndex(db, {
          id,
          libraryId: A,
          runToken: token,
          text: TEXT,
          blocks: tile(TEXT, 20),
          parsed: parsedFixture(),
          derived: derivedFixture(),
          analyzerVersion: 1,
        }),
      );
    expect(await write(c1.runToken)).toBe(false);
    expect(await count("chunks", id)).toBe(0);
    const finish = (token: string) =>
      scoped([A], (db) =>
        finishIngest(db, {
          id,
          libraryId: A,
          runToken: token,
          proposed: {},
          meta: META,
          metaTsv: "",
          identKeys: [],
          status: "review",
          statusDetail: null,
        }),
      );
    expect(await finish(c1.runToken)).toBe(false);
    expect(await scoped([A], (db) => failIngest(db, id, A, c1.runToken, "x", true))).toBeNull();

    expect(await write(c2.runToken)).toBe(true);
    expect(await finish(c2.runToken)).toBe(true);
    const row = await scoped([A], (db) => getDocument(db, id, [A]));
    expect(row!.status).toBe("review");
    const raw = await t.owner.query<{ pending_gz: unknown; run_token: unknown; lease_until: unknown }>(
      "SELECT pending_gz, run_token, lease_until FROM documents WHERE id = $1",
      [id],
    );
    expect(raw.rows[0]).toEqual({ pending_gz: null, run_token: null, lease_until: null });
    // Finished: nothing left to claim.
    expect(await scoped([A], (db) => claimForIngest(db, id, A))).toBeNull();
  });

  it("malformed ids and tokens are refused without touching SQL types", async () => {
    expect(await scoped([A], (db) => claimForIngest(db, "1; DROP TABLE documents", A))).toBeNull();
    const { id } = (await upload(A, "content-badtoken")) as { id: string };
    expect(
      await scoped([A], (db) =>
        writeDocumentIndex(db, {
          id,
          libraryId: A,
          runToken: "nope",
          text: TEXT,
          blocks: tile(TEXT, 20),
          parsed: parsedFixture(),
          derived: derivedFixture(),
          analyzerVersion: 1,
        }),
      ),
    ).toBe(false);
    expect(await scoped([A], (db) => failIngest(db, id, A, "nope", "x", true))).toBeNull();
  });

  it("failIngest: retryable → queued until the last attempt, then error; non-retryable → error", async () => {
    const { id } = (await upload(A, "content-fail")) as { id: string };
    for (let attempt = 1; attempt < MAX_INGEST_ATTEMPTS; attempt++) {
      const c = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
      expect(c.row.attempts).toBe(attempt);
      expect(await scoped([A], (db) => failIngest(db, id, A, c.runToken, "Dočasná chyba", true))).toBe("queued");
    }
    const last = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    expect(await scoped([A], (db) => failIngest(db, id, A, last.runToken, "Dočasná chyba", true))).toBe("error");
    const row = await scoped([A], (db) => getDocument(db, id, [A]));
    expect(row).toMatchObject({ status: "error", status_detail: "Dočasná chyba" });
    expect(await scoped([A], (db) => claimForIngest(db, id, A))).toBeNull();

    const other = (await upload(A, "content-fail-2")) as { id: string };
    expect(await scoped([A], (db) => failIngest(db, other.id, A, null, "Nelze přečíst", false))).toBe("error");
    // A finished document is never failed afterwards.
    expect(await scoped([A], (db) => failIngest(db, other.id, A, null, "x", false))).toBeNull();
  });

  it("isolation: a foreign document can be neither claimed, written, finished nor failed", async () => {
    const { id } = (await upload(B, "content-b-lease")) as { id: string };
    expect(await scoped([A], (db) => claimForIngest(db, id, B))).toBeNull(); // RLS
    expect(await scoped([A, B], (db) => claimForIngest(db, id, A))).toBeNull(); // explicit filter
    const c = (await scoped([B], (db) => claimForIngest(db, id, B)))!;
    const args = {
      id,
      libraryId: A,
      runToken: c.runToken,
      text: TEXT,
      blocks: tile(TEXT, 20),
      parsed: parsedFixture(),
      derived: derivedFixture(),
      analyzerVersion: 1,
    };
    expect(await scoped([A, B], (db) => writeDocumentIndex(db, args))).toBe(false);
    expect(await scoped([A], (db) => writeDocumentIndex(db, { ...args, libraryId: B }))).toBe(false);
    expect(
      await scoped([A, B], (db) =>
        finishIngest(db, { id, libraryId: A, runToken: c.runToken, proposed: {}, meta: META, metaTsv: "", identKeys: [], status: "ready", statusDetail: null }),
      ),
    ).toBe(false);
    expect(await scoped([A], (db) => failIngest(db, id, B, null, "x", false))).toBeNull();
    expect(await scoped([A, B], (db) => failIngest(db, id, A, null, "x", false))).toBeNull();
    expect((await scoped([B], (db) => getDocument(db, id, [B])))!.status).toBe("processing");
  });
});

describe("writeDocumentIndex", () => {
  it("writes blocks, pages, sections, footnotes and chunks; a re-run replaces them (idempotent)", async () => {
    const id = await ingested(A, "content-index");
    const counts = async () => ({
      blocks: await count("doc_blocks", id),
      pages: await count("doc_pages", id),
      sections: await count("doc_sections", id),
      footnotes: await count("doc_footnotes", id),
      chunks: await count("chunks", id),
    });
    const expected = { blocks: Math.ceil(TEXT.length / 20), pages: 2, sections: 1, footnotes: 1, chunks: 1 };
    expect(await counts()).toEqual(expected);

    // Re-run (a re-derive after an analyzer change) under a fresh lease.
    await t.owner.query("UPDATE documents SET status = 'queued', pending_gz = 'x' WHERE id = $1", [id]);
    const c = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    const again = () =>
      scoped([A], (db) =>
        writeDocumentIndex(db, {
          id,
          libraryId: A,
          runToken: c.runToken,
          text: TEXT,
          blocks: tile(TEXT, 20),
          parsed: parsedFixture(),
          derived: derivedFixture(),
          analyzerVersion: 2,
        }),
      );
    expect(await again()).toBe(true);
    expect(await again()).toBe(true);
    expect(await counts()).toEqual(expected);
    const page = await t.owner.query("SELECT label, label_key, flags FROM doc_pages WHERE doc_id = $1 ORDER BY ord", [id]);
    expect(page.rows).toEqual([
      { label: "245", label_key: "245", flags: 0 },
      { label: "246", label_key: "246", flags: 1 },
    ]);
    const ch = await t.owner.query<{ tsv: string; ident_keys: string[] }>("SELECT tsv, ident_keys FROM chunks WHERE doc_id = $1", [id]);
    expect(ch.rows[0].tsv).toBe("'nahrad':3C 'skod':4C 'smlouv':1C");
    expect(ch.rows[0].ident_keys).toEqual(["sz:25cdo1234-2019", "sec:par:2913"]);
  });

  it("inserts in batches of at most 300 rows per statement", async () => {
    const { id } = (await upload(A, "content-batches")) as { id: string };
    const c = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    const chunks = Array.from({ length: 650 }, (_, i) => chunk(i, `'w${i}':1C`, [`k:${i}`], 0, 10));
    const statements: string[] = [];
    await scoped([A], (db) => {
      const spy: Queryable = {
        query: (text, params) => {
          statements.push(text);
          return db.query(text, params);
        },
      };
      return writeDocumentIndex(spy, {
        id,
        libraryId: A,
        runToken: c.runToken,
        text: TEXT,
        blocks: tile(TEXT, 20),
        parsed: parsedFixture(),
        derived: derivedFixture(chunks),
        analyzerVersion: 1,
      });
    });
    const chunkInserts = statements.filter((s) => s.startsWith("INSERT INTO chunks"));
    expect(chunkInserts).toHaveLength(3);
    for (const s of chunkInserts) expect((s.match(/::tsvector/g) ?? []).length).toBeLessThanOrEqual(300);
    expect(await count("chunks", id)).toBe(650);
  });

  it("refuses blocks that do not tile the text", async () => {
    const { id } = (await upload(A, "content-tiling")) as { id: string };
    const c = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    const bad = [
      { ord: 0, start: 0, end: 10 },
      { ord: 1, start: 11, end: TEXT.length },
    ];
    await expect(
      scoped([A], (db) =>
        writeDocumentIndex(db, {
          id,
          libraryId: A,
          runToken: c.runToken,
          text: TEXT,
          blocks: bad,
          parsed: parsedFixture(),
          derived: derivedFixture(),
          analyzerVersion: 1,
        }),
      ),
    ).rejects.toThrow(/tile/);
  });

  it("stores adversarial strings verbatim (quotes, SQL, markers) — everything is parameterized", async () => {
    const { id } = (await upload(A, "content-adversarial")) as { id: string };
    const c = (await scoped([A], (db) => claimForIngest(db, id, A)))!;
    const parsed = parsedFixture();
    parsed.sections[0].heading = "'); DROP TABLE chunks; -- ⟦s. 1⟧ \\ $1";
    parsed.pages[0].label = "IV'";
    const derived = derivedFixture([chunk(0, "'o''brien':1A 'x':2", ["sz:1'--"])]);
    expect(
      await scoped([A], (db) =>
        writeDocumentIndex(db, { id, libraryId: A, runToken: c.runToken, text: TEXT, blocks: tile(TEXT, 20), parsed, derived, analyzerVersion: 1 }),
      ),
    ).toBe(true);
    const s = await t.owner.query<{ heading: string }>("SELECT heading FROM doc_sections WHERE doc_id = $1", [id]);
    expect(s.rows[0].heading).toBe(parsed.sections[0].heading);
    const ch = await t.owner.query<{ tsv: string; ident_keys: string[] }>("SELECT tsv, ident_keys FROM chunks WHERE doc_id = $1", [id]);
    expect(ch.rows[0]).toEqual({ tsv: "'o''brien':1A 'x':2", ident_keys: ["sz:1'--"] });
  });
});

describe("finishIngest", () => {
  it("writes typed metadata, proposals, meta_tsv and keys; 'ready' also confirms", async () => {
    const id = await ingested(A, "content-finish-ready", "ready");
    const row = (await scoped([A], (db) => getDocument(db, id, [A])))!;
    expect(row.status).toBe("ready");
    expect(row.confirmed_by).toBe("user_u1");
    expect(row.confirmed_at).not.toBeNull();
    expect(row.meta_version).toBe(1);
    expect(row.meta).toMatchObject({
      doc_type: "komentar",
      title: "Občanský zákoník. Komentář",
      authors: ["Petrov, Jan"],
      year: 2019,
      isbn: ["9788074007855"],
      commented_act: "zak:89/2012",
      decided_on: "2019-05-01",
      section_range: "§ 2913",
      keywords: ["náhrada škody"],
    });
    expect(row.proposed_meta).toEqual({ title: { value: META.title, source: "ai", confidence: 0.8 } });
    const raw = await t.owner.query<{ meta_tsv: string; ident_keys: string[] }>("SELECT meta_tsv, ident_keys FROM documents WHERE id = $1", [id]);
    expect(raw.rows[0]).toEqual({ meta_tsv: "'obcansk':1A 'zakonik':2A", ident_keys: ["zak:89/2012"] });

    const review = await ingested(A, "content-finish-review", "review");
    const r2 = (await scoped([A], (db) => getDocument(db, review, [A])))!;
    expect(r2.status).toBe("review");
    expect(r2.confirmed_at).toBeNull();
  });
});

describe("confirmDocument / updateDocumentMeta", () => {
  const edit = (id: string, libraryId: string, expectedVersion: number, meta: Partial<BibMeta> = {}) => ({
    id,
    libraryId,
    meta: { ...META, ...meta },
    expectedVersion,
    userId: "user_u2",
    metaTsv: "'novy':1A",
    identKeys: ["zak:89/2012", "isbn:9788074007855"],
  });

  it("confirms with the loaded version; a stale version conflicts", async () => {
    const id = await ingested(A, "content-confirm");
    const v = (await scoped([A], (db) => getDocument(db, id, [A])))!.meta_version;
    expect(await scoped([A], (db) => confirmDocument(db, edit(id, A, v, { title: "Nový název" })))).toBe("ok");
    const row = (await scoped([A], (db) => getDocument(db, id, [A])))!;
    expect(row).toMatchObject({ status: "ready", confirmed_by: "user_u2", meta_version: v + 1 });
    expect(row.meta.title).toBe("Nový název");
    expect(await scoped([A], (db) => confirmDocument(db, edit(id, A, v)))).toBe("conflict");
    expect(await scoped([A], (db) => updateDocumentMeta(db, edit(id, A, v)))).toBe("conflict");
    expect(await scoped([A], (db) => confirmDocument(db, edit(id, A, 1.5)))).toBe("conflict");
  });

  it("update keeps the status; section_range survives a form that does not send it", async () => {
    const id = await ingested(A, "content-update");
    const v = (await scoped([A], (db) => getDocument(db, id, [A])))!.meta_version;
    expect(await scoped([A], (db) => updateDocumentMeta(db, edit(id, A, v, { section_range: null, year: 2020, summary: "Shrnutí" })))).toBe("ok");
    const row = (await scoped([A], (db) => getDocument(db, id, [A])))!;
    expect(row.status).toBe("review");
    expect(row.confirmed_at).toBeNull();
    expect(row.meta).toMatchObject({ year: 2020, summary: "Shrnutí", section_range: "§ 2913" });
  });

  it("a document still being processed cannot be confirmed; unknown ids are not_found", async () => {
    const { id } = (await upload(A, "content-confirm-early")) as { id: string };
    expect(await scoped([A], (db) => confirmDocument(db, edit(id, A, 0)))).toBe("conflict");
    expect(await scoped([A], (db) => confirmDocument(db, edit(NOBODY, A, 0)))).toBe("not_found");
    expect(await scoped([A], (db) => confirmDocument(db, edit("x' OR 1=1 --", A, 0)))).toBe("not_found");
  });

  it("isolation: a foreign document is not_found, and stays untouched", async () => {
    const id = await ingested(B, "content-confirm-b");
    const v = (await scoped([B], (db) => getDocument(db, id, [B])))!.meta_version;
    expect(await scoped([A], (db) => confirmDocument(db, edit(id, B, v)))).toBe("not_found");
    expect(await scoped([A, B], (db) => confirmDocument(db, edit(id, A, v)))).toBe("not_found");
    expect(await scoped([A], (db) => updateDocumentMeta(db, edit(id, B, v)))).toBe("not_found");
    expect(await scoped([A, B], (db) => updateDocumentMeta(db, edit(id, A, v)))).toBe("not_found");
    const row = (await scoped([B], (db) => getDocument(db, id, [B])))!;
    expect(row).toMatchObject({ status: "review", meta_version: v });
  });
});

describe("reads: getDocument, listDocuments, documentStatuses, pendingCounts", () => {
  let aDocs: string[];
  let bDoc: string;
  beforeAll(async () => {
    const lib = "user_list";
    const other = "org_list";
    await scoped([lib], (db) => ensureLibrary(db, lib, null));
    await scoped([other], (db) => ensureLibrary(db, other, null));
    aDocs = [
      await ingested(lib, "list-1", "ready", { ...META, title: "Škoda a její náhrada", year: 2015, doc_type: "kniha" }),
      await ingested(lib, "list-2", "review", { ...META, title: "Alfa 100% jistota", year: 2021 }),
      await ingested(lib, "list-3", "ready", { ...META, title: "Beta", authors: ["Novák, Petr"], year: 2018 }),
    ];
    await upload(lib, "list-queued", "queued.pdf");
    bDoc = await ingested(other, "list-b", "ready", { ...META, title: "Škoda cizí" });
  });
  const L = ["user_list"];
  const both = ["user_list", "org_list"];

  it("getDocument: own found; foreign not found via RLS and via the explicit filter; malformed id → null", async () => {
    expect(await scoped(L, (db) => getDocument(db, aDocs[0], L))).not.toBeNull();
    expect(await scoped(L, (db) => getDocument(db, bDoc, ["org_list"]))).toBeNull();
    expect(await scoped(both, (db) => getDocument(db, bDoc, L))).toBeNull();
    expect(await scoped(both, (db) => getDocument(db, bDoc, both))).not.toBeNull();
    expect(await scoped(L, (db) => getDocument(db, "'; SELECT 1; --", L))).toBeNull();
    expect(await scoped(L, (db) => getDocument(db, aDocs[0], []))).toBeNull();
  });

  it("listDocuments filters, folds the query, escapes LIKE, sorts and pages", async () => {
    const list = (args: Partial<Parameters<typeof listDocuments>[1]> = {}, scope = L) =>
      scoped(scope, (db) => listDocuments(db, { libraryIds: L, limit: 50, offset: 0, ...args }));
    expect((await list()).total).toBe(4);
    const skoda = await list({ q: "skoda" });
    expect(skoda.rows.map((r) => r.meta.title)).toEqual(["Škoda a její náhrada"]);
    expect((await list({ q: "NOVÁK" })).rows.map((r) => r.meta.title)).toEqual(["Beta"]);
    expect((await list({ q: "100%" })).rows.map((r) => r.meta.title)).toEqual(["Alfa 100% jistota"]);
    expect((await list({ q: "%" })).rows.map((r) => r.meta.title)).toEqual(["Alfa 100% jistota"]);
    expect((await list({ q: "_" })).total).toBe(0);
    expect((await list({ q: "queued" })).rows.map((r) => r.file_name)).toEqual(["queued.pdf"]);
    expect((await list({ status: ["ready"], sort: "title" })).rows.map((r) => r.meta.title)).toEqual(["Beta", "Škoda a její náhrada"]);
    expect((await list({ docType: ["kniha"] })).rows.map((r) => r.meta.title)).toEqual(["Škoda a její náhrada"]);
    expect((await list({ status: ["bogus" as never] })).total).toBe(0);
    expect((await list({ sort: "__proto__" as never })).total).toBe(4);
    expect((await list({ sort: "1; DROP TABLE documents" as never, limit: Number.NaN, offset: -5 })).rows).toHaveLength(1);
    const byYear = await list({ status: ["ready", "review"], sort: "year" });
    expect(byYear.rows.map((r) => r.meta.year)).toEqual([2021, 2018, 2015]);
    const page = await list({ sort: "title", limit: 2, offset: 2 });
    expect(page.total).toBe(4);
    expect(page.rows).toHaveLength(2);
    expect((await list({ limit: 1, offset: 99 })).rows).toEqual([]);
    // Isolation: the other library's "Škoda cizí" never shows up.
    expect((await list({ q: "skoda" }, both)).rows.map((r) => r.meta.title)).toEqual(["Škoda a její náhrada"]);
    expect((await scoped(L, (db) => listDocuments(db, { libraryIds: ["org_list"], limit: 50, offset: 0 }))).total).toBe(0);
  });

  it("documentStatuses returns only own ids and ignores malformed ones", async () => {
    const res = await scoped(both, (db) => documentStatuses(db, L, [aDocs[0], bDoc, "junk", aDocs[1].toUpperCase()]));
    expect(res.map((r) => r.id).sort()).toEqual([aDocs[0], aDocs[1]].sort());
    expect(res.find((r) => r.id === aDocs[1])!.status).toBe("review");
    expect(await scoped(L, (db) => documentStatuses(db, ["org_list"], [bDoc]))).toEqual([]);
    expect(await scoped(L, (db) => documentStatuses(db, L, []))).toEqual([]);
  });

  it("pendingCounts per library, zeros for libraries without documents, nothing leaks", async () => {
    expect(await scoped(L, (db) => pendingCounts(db, [...L, "org_list"]))).toEqual({
      user_list: { review: 1, processing: 1, ready: 2 },
      org_list: { review: 0, processing: 0, ready: 0 }, // RLS hides it
    });
    expect(await scoped(both, (db) => pendingCounts(db, L))).toEqual({ user_list: { review: 1, processing: 1, ready: 2 } });
  });
});

describe("deleteDocument", () => {
  it("deletes the document with everything derived; returns pages and prior status", async () => {
    const id = await ingested(A, "content-delete", "ready");
    expect(await scoped([A], (db) => deleteDocument(db, id, A))).toEqual({ billablePages: 2, status: "ready" });
    for (const table of ["doc_blocks", "doc_pages", "doc_sections", "doc_footnotes", "chunks"]) expect(await count(table, id)).toBe(0);
    expect(await scoped([A], (db) => deleteDocument(db, id, A))).toBeNull();
    expect(await scoped([A], (db) => deleteDocument(db, "bad id", A))).toBeNull();
  });

  it("isolation: a foreign document cannot be deleted", async () => {
    const id = await ingested(B, "content-delete-b", "ready");
    expect(await scoped([A], (db) => deleteDocument(db, id, B))).toBeNull();
    expect(await scoped([A, B], (db) => deleteDocument(db, id, A))).toBeNull();
    expect(await count("chunks", id)).toBe(1);
  });
});

describe("isBlocked", () => {
  it("matches taken-down content hashes, case-insensitively; junk is never blocked", async () => {
    const h = sha("taken-down");
    await t.owner.query("INSERT INTO blocked_content (content_sha256, reason) VALUES ($1, 'DSA notice')", [h]);
    expect(await scoped([A], (db) => isBlocked(db, h))).toBe(true);
    expect(await scoped([], (db) => isBlocked(db, h.toUpperCase()))).toBe(true);
    expect(await scoped([A], (db) => isBlocked(db, sha("other")))).toBe(false);
    expect(await scoped([A], (db) => isBlocked(db, "' OR 1=1 --"))).toBe(false);
  });
});

describe("reading", () => {
  let id: string;
  let bId: string;
  beforeEach(async () => {
    if (!id) {
      id = await ingested(A, "content-read", "ready");
      bId = await ingested(B, "content-read-b", "ready");
    }
  });

  it("loadReadDoc: row, pages, sections and text length", async () => {
    const doc = (await scoped([A], (db) => loadReadDoc(db, id, [A])))!;
    expect(doc.row.id).toBe(id);
    expect(doc.textLength).toBe(TEXT.length);
    expect(doc.pages).toEqual([
      { ord: 1, label: "245", start: 0, end: at(P2), flags: 0 },
      { ord: 2, label: "246", start: at(P2), end: TEXT.length, flags: 1 },
    ]);
    expect(doc.sections).toEqual([
      {
        ord: 0,
        parent: null,
        level: 1,
        kind: "par",
        key: "par:2913",
        keyNum: 2913,
        heading: "§ 2913 Porušení",
        author: null,
        start: at(H),
        end: TEXT.length,
        pageFrom: 1,
        pageTo: 2,
        indexed: true,
      },
    ]);
  });

  it("loadText loads only overlapping blocks and slices across block boundaries", async () => {
    const statements: string[] = [];
    const src = await scoped([A], (db) =>
      loadText(
        { query: (text, params) => (statements.push(String(params?.slice(2))), db.query(text, params)) },
        id,
        A,
        at(BODY),
        at(BODY) + 30,
      ),
    );
    expect(src.start).toBeLessThanOrEqual(at(BODY));
    expect(src.end).toBeGreaterThanOrEqual(at(BODY) + 30);
    expect(src.end - src.start).toBeLessThanOrEqual(30 + 2 * 20);
    expect(src.slice(at(BODY), at(BODY) + 30)).toBe(TEXT.slice(at(BODY), at(BODY) + 30));
    const whole = await scoped([A], (db) => loadText(db, id, A, 0, 1e9));
    expect(whole.slice(0, TEXT.length)).toBe(TEXT);
  });

  it("loadText: empty/inverted ranges and foreign documents give an empty source", async () => {
    for (const [from, to] of [
      [10, 10],
      [20, 5],
      [TEXT.length + 5, TEXT.length + 50],
      [Number.NaN, Number.NaN],
    ]) {
      const src = await scoped([A], (db) => loadText(db, id, A, from, to));
      expect(src.end - src.start).toBe(0);
      expect(src.slice(0, 100)).toBe("");
    }
    expect((await scoped([A], (db) => loadText(db, bId, B, 0, 100))).slice(0, 100)).toBe("");
    expect((await scoped([A, B], (db) => loadText(db, bId, A, 0, 100))).slice(0, 100)).toBe("");
    expect((await scoped([A], (db) => loadText(db, "nope", A, 0, 100))).slice(0, 100)).toBe("");
  });

  it("loadText refuses inconsistent storage (a missing block)", async () => {
    const victim = await ingested(A, "content-read-gap", "ready");
    await t.owner.query("DELETE FROM doc_blocks WHERE doc_id = $1 AND ord = 1", [victim]);
    await expect(scoped([A], (db) => loadText(db, victim, A, 0, 60))).rejects.toThrow(/incomplete/);
  });

  it("loadFootnotes: by range (def or ref inside), by label, with the page label of the reference (the note's page)", async () => {
    const all = await scoped([A], (db) => loadFootnotes(db, id, A, null));
    expect(all).toEqual([
      {
        seq: 1,
        label: "1",
        kind: "f",
        refAt: at("[^1]"),
        defStart: at(DEF) + 6,
        defEnd: TEXT.length - 1,
        pageLabel: "245",
        page: 1,
        sectionOrd: 0,
        anchor: null,
      },
    ]);
    // Range around the reference only (the definition lies after it).
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, { from: at(BODY), to: at(P2) }))).toHaveLength(1);
    // Range around the definition only.
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, { from: at(DEF), to: TEXT.length }))).toHaveLength(1);
    // Range before both.
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, { from: 0, to: at(H) }))).toHaveLength(0);
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, null, ["1"]))).toHaveLength(1);
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, null, ["2"]))).toHaveLength(0);
    expect(await scoped([A], (db) => loadFootnotes(db, id, A, null, []))).toHaveLength(0);
  });

  it("isolation: foreign documents are invisible to every reader", async () => {
    expect(await scoped([A], (db) => loadReadDoc(db, bId, [B]))).toBeNull();
    expect(await scoped([A, B], (db) => loadReadDoc(db, bId, [A]))).toBeNull();
    expect(await scoped([A], (db) => loadFootnotes(db, bId, B, null))).toEqual([]);
    expect(await scoped([A, B], (db) => loadFootnotes(db, bId, A, null))).toEqual([]);
    expect((await scoped([A, B], (db) => loadReadDoc(db, bId, [A, B])))!.row.library_id).toBe(B);
  });
});
