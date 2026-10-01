import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import { searchChannels, type SearchParams } from "@/src/files/db/search";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * The search functions of 0004_search.sql on PGlite, as dawmain_app (RLS
 * on). Under FORCE RLS the planner cannot use a GIN index for `@@` / `&&`
 * (not leakproof), so the channels run inside SECURITY DEFINER functions
 * that apply the policy's scope themselves. These tests pin both halves:
 * the right index is used (pg_stat_get_xact_numscans, counted within the
 * scoped transaction), and the functions see no more than RLS would.
 *
 * A is a large library (6,000 chunks: the GIN path), B a small one (3,000,
 * at most 5,000: read whole by chunks_lib_doc). tsv is forced out of line,
 * as real chunks are, so every detoast shows up as a scan of the TOAST
 * index — what a GIN recheck of other libraries' chunks would cost.
 */

let t: TestDb;
const A = "user_gin";
const B = "org_gin";
const INDEXES = ["chunks_tsv", "chunks_ident", "chunks_lib_doc", "documents_ident"] as const;
type Scans = Record<(typeof INDEXES)[number] | "detoast", number>;

const params = (p: Partial<SearchParams>): SearchParams => ({
  libraryIds: [A],
  tsAnd: null,
  tsOr: null,
  identKeys: [],
  perDoc: 3,
  limit: 60,
  ...p,
});

/** Oid of the TOAST index of chunks: one scan per detoasted tsv. */
let toastIndex: string;

async function scans(db: Queryable): Promise<Scans> {
  const { rows } = await db.query<{ i: string; n: number }>(
    `SELECT i, pg_stat_get_xact_numscans(i::regclass)::int AS n FROM unnest($1::text[]) i
     UNION ALL SELECT 'detoast', pg_stat_get_xact_numscans($2::oid)::int`,
    [INDEXES, toastIndex],
  );
  return Object.fromEntries(rows.map((r) => [r.i, Number(r.n)])) as Scans;
}

/** Run `fn` as dawmain_app in scope `libs`; returns its result and the index scans it caused. */
async function measured<T>(libs: string[], fn: (db: Queryable) => Promise<T>): Promise<{ result: T; used: Scans }> {
  return withScope(libs, async (db) => {
    const before = await scans(db);
    const result = await fn(db);
    const after = await scans(db);
    const used = Object.fromEntries(Object.keys(before).map((i) => [i, after[i as keyof Scans] - before[i as keyof Scans]])) as Scans;
    return { result, used };
  });
}

/** The chunk channel's query inline, under RLS — the reference result. */
async function inline(libs: string[], q: string): Promise<string[]> {
  const { rows } = await withScope(libs, (db) =>
    db.query<{ doc_id: string; ord: number }>(
      "SELECT doc_id, ord FROM chunks WHERE library_id = ANY ($1) AND tsv @@ to_tsquery('simple', $2) ORDER BY 1, 2",
      [libs, q],
    ),
  );
  return rows.map((r) => `${r.doc_id}/${r.ord}`);
}

async function viaFunction(libs: string[], q: string): Promise<string[]> {
  const { rows } = await withScope(libs, (db) =>
    db.query<{ doc_id: string; ord: number }>(
      "SELECT doc_id, ord FROM files_search_chunks($1, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, 20, 200) ORDER BY 1, 2",
      [libs, q],
    ),
  );
  return rows.map((r) => `${r.doc_id}/${r.ord}`);
}

let docs: string[];
let docsB: string[];

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
  // Uncompressed, and (with the padding lexemes below) over the 2 kB TOAST threshold.
  await t.owner.query("ALTER TABLE chunks ALTER COLUMN tsv SET STORAGE EXTERNAL");
  await t.owner.query("INSERT INTO libraries (id) VALUES ($1), ($2)", [A, B]);
  // Books of 250 chunks of 40 filler words (body, weight C); chunk 17 of
  // every book carries a rare word and a case number, chunk 18 a footnote
  // word (weight D). "spolecne" is in every chunk of B but only in chunk 17
  // of A ("spolecne vzacnyterm"); "vsudea" in every other chunk of A but
  // only in chunk 17 of B.
  for (const [lib, books] of [[A, 24], [B, 12]] as const) {
    await t.owner.query(
      `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter,
         rights, billable_pages, char_count, page_label_source, doc_type, year, title, meta_tsv)
       SELECT $1, 'ready', 'user_u1', 'pdf', 'f.pdf', h, h, 'pdf@1', 'vlastni', 1, 100, 'physical', 'kniha', 2020, 'T',
              to_tsvector('simple', 'kniha ' || n)
         FROM generate_series(1, $2::int) n, LATERAL (SELECT md5($1 || n) || md5(n || $1) AS h) x`,
      [lib, books],
    );
    const big = lib === A;
    await t.owner.query(
      `INSERT INTO chunks (doc_id, library_id, ord, char_start, char_end, tsv, ident_keys)
       SELECT d.id, d.library_id, o, 0, 1,
              setweight(to_tsvector('simple',
                (SELECT string_agg('slovo' || ((o * 7 + w * 13) % 400), ' ') FROM generate_series(1, 40) w)
                || CASE WHEN o = 17 THEN ' spolecne vzacnyterm' WHEN $2 THEN ' vsudea' ELSE ' spolecne' END
                || CASE WHEN o = 17 AND NOT $2 THEN ' vsudea' ELSE '' END
                || ' ' || (SELECT string_agg('vypln' || k || repeat('x', 60), ' ') FROM generate_series(1, 30) k)), 'C')
              || CASE WHEN o = 18 THEN setweight(to_tsvector('simple', 'poznamka'), 'D') ELSE ''::tsvector END,
              CASE WHEN o = 17 THEN ARRAY['sz:25cdo1234-2019'] ELSE ARRAY['par:' || (o % 50)] END
         FROM documents d, generate_series(0, 249) o
        WHERE d.library_id = $1`,
      [lib, big],
    );
  }
  // 0005's section filter: one keyed section per document covering all its chunks (all start at 0).
  await t.owner.query(
    `INSERT INTO doc_sections (doc_id, library_id, ord, parent_ord, level, kind, key, heading, char_start, char_end)
     SELECT d.id, d.library_id, 0, NULL, 1, 'par', 'par:5', '§ 5', 0, 1 FROM documents d`,
  );
  // 0005's document keys: a library of 3,000 documents, each with its own ISBN.
  await t.owner.query("INSERT INTO libraries (id) VALUES ('org_ginbulk')");
  await t.owner.query(
    `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter,
       rights, billable_pages, char_count, page_label_source, doc_type, year, title, ident_keys)
     SELECT 'org_ginbulk', 'ready', 'user_u1', 'pdf', 'f.pdf', h, h, 'pdf@1', 'vlastni', 1, 100, 'physical', 'kniha', 2020, 'T',
            ARRAY['isbn:97880' || lpad(n::text, 8, '0'), 'zak:89/2012']
       FROM generate_series(1, 3000) n, LATERAL (SELECT md5('bulk' || n) || md5(n || 'bulk') AS h) x`,
  );
  await t.owner.query("ANALYZE documents");
  await t.owner.query("ANALYZE chunks");
  await t.owner.query("ANALYZE doc_sections");
  toastIndex = (
    await t.owner.query<{ i: string }>(
      "SELECT i.indexrelid::text AS i FROM pg_class c JOIN pg_index i ON i.indrelid = c.reltoastrelid WHERE c.oid = 'chunks'::regclass",
    )
  ).rows[0].i;
  const ids = async (lib: string) =>
    (await t.owner.query<{ id: string }>("SELECT id FROM documents WHERE library_id = $1 ORDER BY id", [lib])).rows.map((r) => r.id);
  docs = await ids(A);
  docsB = await ids(B);
}, 120_000);

afterAll(async () => {
  setScopeRunner(null);
  await t?.close();
});

describe("0004_search: the GIN indexes under RLS", () => {
  it("the fixture: tsv is stored out of line", async () => {
    const { used } = await measured([A], (db) => db.query("SELECT length(tsv) FROM chunks WHERE library_id = $1 LIMIT 10", [[A]]));
    expect(used.detoast).toBeGreaterThanOrEqual(10);
  });

  it("the reason: an inline `tsv @@` query as dawmain_app never uses chunks_tsv", async () => {
    const { result, used } = await measured([A], (db) =>
      db.query("SELECT count(*)::int AS n FROM chunks c WHERE c.library_id = ANY ($1) AND c.tsv @@ to_tsquery('simple', 'vzacnyterm')", [[A]]),
    );
    expect(result.rows[0]).toEqual({ n: docs.length });
    expect(used.chunks_tsv).toBe(0);
  });

  it("the lexical channels use chunks_tsv in a large scope, with the per-document cap and counts intact", async () => {
    const { result, used } = await measured([A], (db) => searchChannels(db, params({ tsAnd: "'vzacnyterm':*", tsOr: "'vzacnyterm':* | 'nicneni':*" })));
    expect(used.chunks_tsv).toBeGreaterThanOrEqual(2);
    // Only the scope's size, counted up to the bound, once per channel.
    expect(used.chunks_lib_doc).toBeLessThanOrEqual(2);
    for (const channel of ["and", "or"]) {
      const hits = result.filter((h) => h.channel === channel);
      expect(hits.map((h) => h.docId).sort()).toEqual(docs);
      expect(hits.every((h) => h.chunkOrd === 17 && h.perDocTotal === 1)).toBe(true);
    }
  });

  it("the identifier channel uses chunks_ident", async () => {
    for (const lib of [A, B]) {
      const { result, used } = await measured([lib], (db) => searchChannels(db, params({ libraryIds: [lib], identKeys: ["sz:25cdo1234-2019"] })));
      expect(used.chunks_ident).toBeGreaterThanOrEqual(1);
      expect(used.chunks_lib_doc).toBe(0);
      expect(result.map((h) => h.docId).sort()).toEqual(lib === A ? docs : docsB);
    }
  });

  it("the per-document cap still holds on a common word", async () => {
    const { result } = await measured([A], (db) => searchChannels(db, params({ tsAnd: "'slovo7'", perDoc: 2, limit: 200 })));
    const perDoc = new Map<string, number>();
    for (const h of result) perDoc.set(h.docId, (perDoc.get(h.docId) ?? 0) + 1);
    expect([...perDoc.values()].every((n) => n === 2)).toBe(true);
    expect(result.every((h) => h.perDocTotal > 2)).toBe(true);
  });

  it("a weighted or phrase query in a large scope detoasts no other library's chunks", async () => {
    // 'spolecne' matches every chunk of B; in A only chunk 17. A GIN recheck
    // (weights, <->) before the library test would detoast all of B.
    for (const q of ["'spolecne':*ABC", "'spolecne':*C", "( 'spolecne' <-> 'vzacnyterm' )", "( 'spolecne':*C <-> 'vzacnyterm':*C )"]) {
      const { result, used } = await measured([A], (db) => searchChannels(db, params({ tsAnd: q })));
      expect(used.chunks_tsv, q).toBeGreaterThanOrEqual(1);
      expect(result.filter((h) => h.channel === "and").map((h) => h.docId).sort(), q).toEqual(docs);
      // The matches in scope, once to test the query and once to rank it.
      expect(used.detoast, q).toBeLessThanOrEqual(2 * docs.length + 10);
    }
  });

  it("a small scope is read by chunks_lib_doc: its cost does not grow with other libraries", async () => {
    for (const q of ["'vsudea':*", "'vsudea':*C", "( 'vsudea' <-> 'slovo1' ) | 'vsudea':*ABC"]) {
      const { result, used } = await measured([B], (db) => searchChannels(db, params({ libraryIds: [B], tsAnd: q })));
      expect(used.chunks_tsv, q).toBe(0);
      expect(used.chunks_lib_doc, q).toBeGreaterThanOrEqual(1);
      expect(result.filter((h) => h.channel === "and").map((h) => h.docId).sort(), q).toEqual(docsB);
      // Each chunk of B at most once, plus the ranking of its matches.
      expect(used.detoast, q).toBeLessThanOrEqual(docsB.length * 250 + 2 * docsB.length + 10);
    }
  });

  it("0005's case_number and section filters keep the plan: chunks_tsv / chunks_ident, nothing outside the scope detoasted", async () => {
    const filters: Array<Partial<SearchParams>> = [{ section: "par:5" }, { require: ["sz:25cdo1234-2019"] }, { section: "par:5", require: ["sz:25cdo1234-2019"] }];
    for (const filter of filters) {
      for (const q of ["'vzacnyterm':*", "'spolecne':*ABC", "( 'spolecne' <-> 'vzacnyterm' )"]) {
        const { result, used } = await measured([A], (db) => searchChannels(db, params({ tsAnd: q, tsMeta: null, ...filter })));
        const label = `${JSON.stringify(filter)} ${q}`;
        expect(used.chunks_tsv, label).toBeGreaterThanOrEqual(1);
        expect(result.map((h) => h.docId).sort(), label).toEqual(docs);
        expect(used.detoast, label).toBeLessThanOrEqual(2 * docs.length + 10);
      }
      const idn = await measured([A], (db) => searchChannels(db, params({ identKeys: ["sz:25cdo1234-2019"], ...filter })));
      expect(idn.used.chunks_ident).toBeGreaterThanOrEqual(1);
      expect(idn.used.chunks_lib_doc).toBe(0);
      expect(idn.result.map((h) => h.docId).sort()).toEqual(docs);
    }
    // A section no document has, or a key no chunk carries: nothing.
    expect(await withScope([A], (db) => searchChannels(db, params({ tsAnd: "'vzacnyterm':*", tsMeta: null, section: "par:6" })))).toEqual([]);
    expect(await withScope([A], (db) => searchChannels(db, params({ tsAnd: "'vzacnyterm':*", tsMeta: null, require: ["sz:1cdo1-2020"] })))).toEqual([]);
  });

  it("0005's document keys (ISBN / DOI) go through documents_ident, in scope only", async () => {
    const BULK = "org_ginbulk";
    const key = ["isbn:9788000000042"];
    const { result, used } = await measured([BULK], (db) => searchChannels(db, params({ libraryIds: [BULK], tsMeta: null, metaKeys: key })));
    expect(used.documents_ident).toBeGreaterThanOrEqual(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ channel: "meta", byKey: true, libraryId: BULK, rank: 1 });
    // Another scope, or the bulk library asked for outside the transaction's scope: nothing.
    expect(await withScope([A], (db) => searchChannels(db, params({ libraryIds: [A], tsMeta: null, metaKeys: key })))).toEqual([]);
    expect(await withScope([A], (db) => searchChannels(db, params({ libraryIds: [BULK], tsMeta: null, metaKeys: key })))).toEqual([]);
  });

  it("both paths return exactly the query's matches (weights, phrases, prefixes)", async () => {
    const queries = [
      "'spolecne':*C & 'vzacnyterm'",
      "'spolecne':*D | 'vzacnyterm':*D",
      "'poznamka':D",
      "'poznamka':*ABC",
      "'poznamka' | 'vzacnyterm':C",
      "( 'spolecne':* <-> 'vzacnyterm':*C )",
      "( 'vzacnyterm' <-> 'spolecne' )",
      "( 'slovo1':*C <2> 'slovo27' ) & 'vzacnyterm'",
      "'vsudea':*A | 'vzacnyterm':*B",
    ];
    for (const libs of [[A], [B], [A, B]]) {
      for (const q of queries) {
        const want = await inline(libs, q);
        const got = await viaFunction(libs, q);
        // The function caps at 20 per document; none of these queries hit more.
        expect(got, `${libs} ${q}`).toEqual(want);
      }
    }
  });
});

describe("0004_search: the functions see no more than RLS would", () => {
  const call = (db: Queryable, libs: string[]) =>
    db.query<{ doc_id: string }>(
      "SELECT doc_id FROM files_search_chunks($1, 'vzacnyterm', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, 3, 60)",
      [libs],
    );

  it("a library outside the transaction's scope yields nothing, even when asked for by name", async () => {
    const { result } = await measured([A], (db) => call(db, [A, B]));
    expect(result.rows).toHaveLength(docs.length);
    expect(new Set(result.rows.map((r) => r.doc_id))).toEqual(new Set(docs));
    const foreign = await measured([A], (db) => call(db, [B]));
    expect(foreign.result.rows).toEqual([]);
    const meta = await withScope([A], (db) =>
      db.query("SELECT * FROM files_search_meta($1, 'kniha', NULL, NULL, NULL, NULL, NULL, '{}', NULL, 60)", [[B]]),
    );
    expect(meta.rows).toEqual([]);
  });

  it("the system scope (no libraries) yields nothing", async () => {
    const { result } = await measured([], (db) => call(db, [A, B]));
    expect(result.rows).toEqual([]);
  });

  it("the caller's own filter narrows the scope further", async () => {
    const { result } = await measured([A, B], (db) => call(db, [B]));
    expect(result.rows).toHaveLength(docsB.length);
    expect(result.rows.some((r) => docs.includes(r.doc_id))).toBe(false);
  });

  it("SECURITY DEFINER with a pinned search_path; EXECUTE for dawmain_app only", async () => {
    const { rows } = await t.owner.query<{ proname: string; nargs: number; prosecdef: boolean; proconfig: string[] }>(
      "SELECT proname, pronargs::int AS nargs, prosecdef, proconfig FROM pg_proc WHERE proname IN ('files_search_chunks', 'files_search_meta') ORDER BY proname, pronargs",
    );
    // 0004's signatures (the build deployed before 0005 still calls them) and 0005's overloads.
    expect(rows.map((r) => `${r.proname}/${r.nargs}`)).toEqual([
      "files_search_chunks/13",
      "files_search_chunks/15",
      "files_search_meta/10",
      "files_search_meta/11",
    ]);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toContain("search_path=pg_catalog, public");
      // The chunk scan is pinned to an index (see the migrations).
      if (r.proname === "files_search_chunks") expect(r.proconfig).toContain("enable_seqscan=off");
    }
    await t.owner.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'files_gin_other') THEN CREATE ROLE files_gin_other; END IF; END $$");
    const grants = await t.owner.query<{ app: boolean; other: boolean }>(
      `SELECT bool_and(has_function_privilege('dawmain_app', p.oid, 'EXECUTE')) AS app,
              bool_or(has_function_privilege('files_gin_other', p.oid, 'EXECUTE')) AS other
         FROM pg_proc p WHERE p.proname IN ('files_search_chunks', 'files_search_meta')`,
    );
    expect(grants.rows[0]).toEqual({ app: true, other: false });
  });
});
