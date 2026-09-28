import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import { fuse, isWellFormedTsQuery, loadChunks, searchChannels, type ChannelHit, type SearchParams } from "@/src/files/db/search";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * Search channels on PGlite as dawmain_app (RLS on). Documents are seeded as
 * the owner with hand-written tsvector literals, so these tests pin the SQL
 * (per-document caps, filters, isolation) independently of the analyzer.
 */

let t: TestDb;
const A = "user_a";
const B = "org_b";
const scoped = <T>(libs: string[], fn: (db: Queryable) => Promise<T>) => withScope(libs, fn);
let seq = 0;

interface Seed {
  lib?: string;
  status?: string;
  enabled?: boolean;
  docType?: string | null;
  year?: number | null;
  act?: string | null;
  metaTsv?: string | null;
  docKeys?: string[];
  chunks: Array<{ tsv: string; keys?: string[] }>;
}

async function seed(s: Seed): Promise<string> {
  const lib = s.lib ?? A;
  const sha = (++seq).toString(16).padStart(64, "0");
  const { rows } = await t.owner.query<{ id: string }>(
    `INSERT INTO documents (library_id, status, uploaded_by, file_kind, file_name, file_sha256, content_sha256, converter,
       rights, billable_pages, char_count, page_label_source, enabled, doc_type, year, commented_act, meta_tsv, title, ident_keys)
     VALUES ($1, $2, 'user_u1', 'pdf', 'f.pdf', $3, $3, 'pdf@1', 'vlastni', 1, 100, 'physical', $4, $5, $6, $7, $8::tsvector, 'T', $9::text[])
     RETURNING id`,
    [lib, s.status ?? "ready", sha, s.enabled ?? true, s.docType ?? "kniha", s.year ?? 2020, s.act ?? null, s.metaTsv ?? null, s.docKeys ?? []],
  );
  const id = rows[0].id;
  for (let i = 0; i < s.chunks.length; i++) {
    await t.owner.query(
      `INSERT INTO chunks (doc_id, library_id, ord, char_start, char_end, page_from, page_to, section_ord, anchor_from, tsv, ident_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 0, $7, $8::tsvector, $9::text[])`,
      [id, lib, i, i * 10, i * 10 + 10, i + 1, `m${i}`, s.chunks[i].tsv, s.chunks[i].keys ?? []],
    );
  }
  return id;
}

const params = (p: Partial<SearchParams>): SearchParams => ({
  libraryIds: [A],
  tsAnd: null,
  tsOr: null,
  identKeys: [],
  perDoc: 3,
  limit: 60,
  ...p,
});

const docsOf = (hits: ChannelHit[], channel?: string) => [...new Set(hits.filter((h) => !channel || h.channel === channel).map((h) => h.docId))];

let big: string;
let small: string;
let review: string;
let disabled: string;
let commentary: string;
let citing: string;
let foreign: string;
let metaOnly: string;

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
  await t.owner.query("INSERT INTO libraries (id) VALUES ($1), ($2)", [A, B]);
  // A 200-chunk book where every chunk matches strongly (own-heading weight A)…
  big = await seed({ year: 2010, chunks: Array.from({ length: 200 }, () => ({ tsv: "'nahrad':1A 'skod':2A" })) });
  // …and a small article whose one chunk matches weakly (body weight C).
  small = await seed({ docType: "clanek", year: 2022, chunks: [{ tsv: "'nahrad':5C 'skod':6C 'jin':7C" }] });
  review = await seed({ status: "review", chunks: [{ tsv: "'nahrad':1A 'skod':2A" }] });
  disabled = await seed({ enabled: false, chunks: [{ tsv: "'nahrad':1A 'skod':2A" }] });
  commentary = await seed({
    docType: "komentar",
    act: "zak:89/2012",
    chunks: [
      { tsv: "'porusen':1A", keys: ["sec:par:2913"] },
      { tsv: "'porusen':1C", keys: ["sec:par:2913", "par:2913"] },
      { tsv: "'jin':1C", keys: ["sec:par:2914"] },
    ],
  });
  citing = await seed({ chunks: [{ tsv: "'nahrad':1C", keys: ["par:2913", "parz:89/2012/2913", "sz:25cdo1234-2019"] }] });
  foreign = await seed({ lib: B, chunks: [{ tsv: "'nahrad':1A 'skod':2A", keys: ["par:2913", "sz:25cdo1234-2019"] }], metaTsv: "'nahrad':1A" });
  metaOnly = await seed({ metaTsv: "'nahrad':1A 'skod':2A", chunks: [] });
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});

describe("searchChannels — lexical AND/OR", () => {
  const q = { tsAnd: "'nahrad':* & 'skod':*", tsOr: "'nahrad':* | 'skod':*" };

  it("caps hits per document in SQL, so a 200-chunk book does not crowd out a small article", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params({ ...q, limit: 5 })));
    const and = hits.filter((h) => h.channel === "and");
    expect(and.filter((h) => h.docId === big)).toHaveLength(3);
    expect(and.find((h) => h.docId === big)!.perDocTotal).toBe(200);
    expect(and.map((h) => h.docId)).toContain(small);
    expect(and.find((h) => h.docId === small)!.perDocTotal).toBe(1);
    expect(and.map((h) => h.rank)).toEqual(and.map((_, i) => i + 1));
    // Without a meaningful cap the big book would take every slot.
    const crowded = await scoped([A], (db) => searchChannels(db, params({ ...q, limit: 5, perDoc: 20 })));
    expect(docsOf(crowded, "and")).toEqual([big]);
  });

  it("searches only ready AND enabled documents", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params(q)));
    const docs = docsOf(hits);
    expect(docs).not.toContain(review);
    expect(docs).not.toContain(disabled);
  });

  it("OR reaches chunks the AND query misses; meta matches the document-level tsvector", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params({ tsAnd: "'nahrad':* & 'skod':*", tsOr: "'nahrad':* | 'skod':*" })));
    expect(docsOf(hits, "or")).toContain(citing);
    expect(docsOf(hits, "and")).not.toContain(citing);
    expect(hits.filter((h) => h.channel === "meta")).toEqual([{ channel: "meta", docId: metaOnly, chunkOrd: null, rank: 1, perDocTotal: 1 }]);
  });

  it("filters: doc types, year range, docId", async () => {
    const types = await scoped([A], (db) => searchChannels(db, params({ ...q, docTypes: ["clanek"] })));
    expect(docsOf(types)).toEqual([small]);
    const years = await scoped([A], (db) => searchChannels(db, params({ ...q, yearFrom: 2021, yearTo: 2030 })));
    expect(docsOf(years)).toEqual([small]);
    const none = await scoped([A], (db) => searchChannels(db, params({ ...q, yearFrom: 2011, yearTo: 2019 })));
    expect(docsOf(none)).not.toContain(big);
    const inDoc = await scoped([A], (db) => searchChannels(db, params({ ...q, docId: big, perDoc: 10 })));
    expect(docsOf(inDoc)).toEqual([big]);
    expect(inDoc.filter((h) => h.channel === "and")).toHaveLength(10);
    expect(await scoped([A], (db) => searchChannels(db, params({ ...q, docTypes: ["bogus" as never] })))).toEqual([]);
  });

  it("refuses tsquery strings the builder never emits, instead of aborting the transaction", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params({ tsAnd: "nahrad & (", tsOr: "'x'; DROP TABLE chunks" })));
    expect(hits).toEqual([]);
    // The transaction is still usable afterwards.
    const after = await scoped([A], async (db) => {
      await searchChannels(db, params({ tsAnd: "!!!(((" }));
      return searchChannels(db, params({ tsAnd: "'nahrad':*" }));
    });
    expect(after.length).toBeGreaterThan(0);
  });

  it("weight restriction D only matches footnote-weighted lexemes", async () => {
    const d = await t.owner.query("SELECT 1 FROM chunks WHERE tsv @@ to_tsquery('simple', $1)", ["'nahrad':*D"]);
    expect(d.rows).toHaveLength(0);
    const hits = await scoped([A], (db) => searchChannels(db, params({ tsAnd: "'nahrad':*D" })));
    expect(hits).toEqual([]);
  });
});

describe("searchChannels — identifiers and act", () => {
  it("idn: the § section itself ranks before chunks that merely cite it", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params({ identKeys: ["par:2913"] })));
    const idn = hits.filter((h) => h.channel === "idn");
    expect(idn[0]).toMatchObject({ docId: commentary, chunkOrd: 1 }); // sec + par
    expect(idn[1]).toMatchObject({ docId: commentary, chunkOrd: 0 }); // sec only
    expect(idn.map((h) => h.docId)).toContain(citing);
    expect(idn.find((h) => h.docId === commentary)!.perDocTotal).toBe(2);
    expect(idn.some((h) => h.docId === commentary && h.chunkOrd === 2)).toBe(false);
  });

  it("act filter: commentaries on the act, or chunks citing a § of it (parz)", async () => {
    const withParz = await scoped([A], (db) =>
      searchChannels(db, params({ identKeys: ["par:2913", "parz:89/2012/2913"], act: "zak:89/2012" })),
    );
    expect(docsOf(withParz).sort()).toEqual([commentary, citing].sort());
    // Without a § in the query, a chunk citing the act (any § of it) passes too.
    const actOnly = await scoped([A], (db) => searchChannels(db, params({ tsOr: "'porusen':* | 'nahrad':*", act: "zak:89/2012" })));
    expect(docsOf(actOnly).sort()).toEqual([commentary, citing].sort());
    const otherAct = await scoped([A], (db) => searchChannels(db, params({ identKeys: ["par:2913"], act: "zak:99/1963" })));
    expect(otherAct).toEqual([]);
    expect(await scoped([A], (db) => searchChannels(db, params({ identKeys: ["par:2913"], act: "zak:89/2012' OR '1'='1" })))).toEqual([]);
  });

  it("malformed docId or empty library list → no hits, no error", async () => {
    expect(await scoped([A], (db) => searchChannels(db, params({ tsAnd: "'nahrad':*", docId: "nope" })))).toEqual([]);
    expect(await scoped([A], (db) => searchChannels(db, params({ tsAnd: "'nahrad':*", libraryIds: [] })))).toEqual([]);
  });
});

describe("searchChannels — act filter without a § (files_search: \"commentaries on it or passages citing its §\")", () => {
  // Seeded in their own library, so the counts above stay as they are.
  const L = "user_act";
  let onAct: string;
  let cites2913: string;
  let cites2910: string;
  let byNumber: string;
  let otherAct: string;
  let metaCiting: string;
  let metaOther: string;
  const run = (p: Partial<SearchParams>) => scoped([L], (db) => searchChannels(db, params({ libraryIds: [L], ...p })));

  beforeAll(async () => {
    await t.owner.query("INSERT INTO libraries (id) VALUES ($1)", [L]);
    onAct = await seed({ lib: L, docType: "komentar", act: "zak:89/2012", chunks: [{ tsv: "'porusen':1C 'povinnost':2C", keys: ["sec:par:2913"] }] });
    // "Náhrada škody podle § 2913 o. z. vyžaduje porušení povinnosti." in a book.
    cites2913 = await seed({ lib: L, chunks: [{ tsv: "'porusen':1C 'povinnost':2C", keys: ["par:2913", "parz:89/2012/2913"] }] });
    cites2910 = await seed({ lib: L, docType: "clanek", chunks: [{ tsv: "'porusen':1C 'povinnost':2C", keys: ["par:2910", "parz:89/2012/2910"] }] });
    // "… podle zákona č. 89/2012 Sb." — the act by number.
    byNumber = await seed({ lib: L, chunks: [{ tsv: "'porusen':1C 'povinnost':2C", keys: ["zak:89/2012"] }] });
    // § 100 of the civil procedure code, and an act whose number merely starts alike.
    otherAct = await seed({ lib: L, chunks: [{ tsv: "'porusen':1C 'povinnost':2C", keys: ["par:100", "parz:99/1963/100", "parz:89/20121/5"] }] });
    metaCiting = await seed({ lib: L, metaTsv: "'porusen':1A", docKeys: ["parz:89/2012/2913"], chunks: [] });
    metaOther = await seed({ lib: L, metaTsv: "'porusen':1A", docKeys: ["parz:99/1963/100"], chunks: [] });
  });

  it("keeps commentaries on the act AND passages citing any § of it or the act by number", async () => {
    const hits = await run({ tsAnd: "'porusen':* & 'povinnost':*", act: "zak:89/2012" });
    expect(docsOf(hits, "and").sort()).toEqual([onAct, cites2913, cites2910, byNumber].sort());
    expect(docsOf(hits)).not.toContain(otherAct);
    // Without the act filter every passage matches.
    const all = await run({ tsAnd: "'porusen':* & 'povinnost':*" });
    expect(docsOf(all, "and")).toContain(otherAct);
  });

  it("the identifier channel obeys the same filter", async () => {
    const hits = await run({ identKeys: ["par:2913", "par:2910", "par:100"], act: "zak:89/2012" });
    // The commentary through its sec:par:2913 key; the § 100 of another act is dropped.
    expect(docsOf(hits, "idn").sort()).toEqual([onAct, cites2913, cites2910].sort());
  });

  it("with a § of the act in the query, only commentaries and passages citing THAT §", async () => {
    const hits = await run({ tsOr: "'porusen':*", identKeys: ["par:2913", "parz:89/2012/2913"], act: "zak:89/2012" });
    expect(docsOf(hits, "or").sort()).toEqual([onAct, cites2913].sort());
  });

  it("the meta channel keeps documents citing the act by their document keys", async () => {
    const hits = await run({ tsAnd: "'porusen':*", act: "zak:89/2012" });
    expect(docsOf(hits, "meta")).toEqual([metaCiting]);
    expect(docsOf(hits)).not.toContain(metaOther);
  });

  it("another act keeps only its own citations; an EU act matches commentaries (and chunks keyed with it)", async () => {
    expect(docsOf(await run({ tsAnd: "'porusen':*", act: "zak:99/1963" })).sort()).toEqual([otherAct, metaOther].sort());
    expect(await run({ tsAnd: "'porusen':*", act: "eu:32016R0679" })).toEqual([]);
  });
});

describe("searchChannels — isolation", () => {
  const all = { tsAnd: "'nahrad':*", tsOr: "'nahrad':* | 'skod':*", identKeys: ["par:2913", "sz:25cdo1234-2019"] };

  it("a foreign library's documents are invisible via RLS (scope [user_a], libraryIds [org_b])", async () => {
    const hits = await scoped([A], (db) => searchChannels(db, params({ ...all, libraryIds: [B] })));
    expect(hits).toEqual([]);
  });

  it("…and via the explicit filter alone (scope [user_a, org_b], libraryIds [user_a])", async () => {
    const hits = await scoped([A, B], (db) => searchChannels(db, params({ ...all, libraryIds: [A] })));
    expect(hits.length).toBeGreaterThan(0);
    expect(docsOf(hits)).not.toContain(foreign);
    const docFilter = await scoped([A, B], (db) => searchChannels(db, params({ ...all, libraryIds: [A], docId: foreign })));
    expect(docFilter).toEqual([]);
  });

  it("with both libraries requested, both are searched", async () => {
    const hits = await scoped([A, B], (db) => searchChannels(db, params({ ...all, libraryIds: [A, B] })));
    expect(docsOf(hits)).toContain(foreign);
  });
});

describe("isWellFormedTsQuery", () => {
  // Shapes buildTsQuery emits (quoted lexemes, prefixes, weights, phrases, variant groups).
  const good = [
    "'smlouv':*",
    "'nahrad':* & 'skod':*",
    "'nahrad':* | 'skod':*",
    "( 'nahrad':* | 'nahrada' ) & ( 'skod':* <-> 'vznik':* )",
    "'2019':*D & 'cdo':*ABC",
    "'a'",
    "!'x':* & ( 'y' <2> 'z' )",
    "  'x':*  ",
  ];
  const bad = [
    "",
    "   ",
    "nahrad & (",
    "'x'; DROP TABLE chunks",
    "a & & b",
    "( a",
    "a )",
    "a b",
    "'Škoda'",
    "'a''b'",
    "a:*Z",
    "a <-",
    "!",
    "'x':* & " + "'y':* & ".repeat(600) + "'z'",
  ];

  it("accepts the builder's shapes — and Postgres parses every one of them", async () => {
    for (const q of good) {
      expect(isWellFormedTsQuery(q), q).toBe(true);
      await expect(t.owner.query("SELECT to_tsquery('simple', $1)", [q])).resolves.toBeDefined();
    }
  });

  it("refuses anything else", () => {
    for (const q of bad) expect(isWellFormedTsQuery(q), q).toBe(false);
  });
});

describe("loadChunks", () => {
  it("returns positions in request order, only for chunks of the given libraries", async () => {
    const keys = [
      { docId: small, ord: 0 },
      { docId: big, ord: 7 },
      { docId: foreign, ord: 0 },
      { docId: big, ord: 999 },
      { docId: "junk", ord: 1 },
      { docId: big, ord: 1.5 },
    ];
    const rows = await scoped([A, B], (db) => loadChunks(db, [A], keys));
    expect(rows).toEqual([
      { docId: small, ord: 0, start: 0, end: 10, pageFrom: 1, pageTo: 1, sectionOrd: 0, anchorFrom: "m0", anchorTo: null },
      { docId: big, ord: 7, start: 70, end: 80, pageFrom: 8, pageTo: 8, sectionOrd: 0, anchorFrom: "m7", anchorTo: null },
    ]);
    expect(await scoped([A], (db) => loadChunks(db, [B], [{ docId: foreign, ord: 0 }]))).toEqual([]);
    expect(await scoped([A], (db) => loadChunks(db, [A], []))).toEqual([]);
  });
});

describe("fuse", () => {
  const hit = (channel: ChannelHit["channel"], docId: string, chunkOrd: number | null, rank: number, perDocTotal = 1): ChannelHit => ({
    channel,
    docId,
    chunkOrd,
    rank,
    perDocTotal,
  });

  it("is weighted RRF with k = 60 over chunks; a document scores its best chunk plus meta", () => {
    const fused = fuse([hit("and", "d1", 0, 1), hit("idn", "d1", 0, 1), hit("or", "d1", 3, 2), hit("meta", "d1", null, 1)]);
    expect(fused).toHaveLength(1);
    const best = 1.0 / 61 + 1.5 / 61;
    expect(fused[0].score).toBeCloseTo(best + 0.8 / 61, 12);
    expect(fused[0].chunks).toEqual([
      { ord: 0, score: best },
      { ord: 3, score: 0.5 / 62 },
    ]);
    expect(fused[0].matchedBy).toEqual(["and", "or", "idn", "meta"]);
  });

  it("orders documents by score; identifier hits outweigh lexical ones at equal rank", () => {
    const fused = fuse([hit("and", "lex", 0, 1), hit("idn", "idn", 0, 1), hit("or", "weak", 0, 1), hit("meta", "meta", null, 1)]);
    expect(fused.map((d) => d.docId)).toEqual(["idn", "lex", "meta", "weak"]);
  });

  it("many mediocre chunks of one document do not beat one strong chunk elsewhere", () => {
    const hits = [hit("and", "small", 0, 1), hit("idn", "small", 0, 1)];
    for (let r = 2; r <= 40; r++) hits.push(hit("and", "big", r, r, 500));
    const fused = fuse(hits);
    expect(fused[0].docId).toBe("small");
  });

  it("keeps the best perDoc chunks (default 2) and counts the rest as moreInDoc", () => {
    const fused = fuse([hit("and", "d", 5, 3, 200), hit("and", "d", 1, 1, 200), hit("and", "d", 9, 2, 200)]);
    expect(fused[0].chunks.map((c) => c.ord)).toEqual([1, 9]);
    expect(fused[0].moreInDoc).toBe(198);
    const three = fuse([hit("and", "d", 5, 3, 3), hit("and", "d", 1, 1, 3), hit("or", "d", 9, 2, 1)], { perDoc: 3 });
    expect(three[0].chunks).toHaveLength(3);
    expect(three[0].moreInDoc).toBe(0);
    // Distinct chunks seen across channels also count when perDocTotal is lower.
    const across = fuse([hit("and", "d", 1, 1, 1), hit("or", "d", 2, 1, 1), hit("idn", "d", 3, 1, 1)]);
    expect(across[0].moreInDoc).toBe(1);
  });

  it("a meta-only document has no chunks; ties break by docId; bad input is ignored", () => {
    const fused = fuse([
      hit("meta", "b", null, 1),
      hit("meta", "a", null, 1),
      { ...hit("and", "x", 0, 0) },
      { ...hit("bogus" as never, "y", 0, 1) },
      { ...hit("__proto__" as never, "z", 0, 1) },
    ]);
    expect(fused.map((d) => d.docId)).toEqual(["a", "b"]);
    expect(fused[0]).toMatchObject({ chunks: [], moreInDoc: 0, matchedBy: ["meta"] });
    expect(fuse([])).toEqual([]);
  });

  it("chunk ties within a document prefer the earlier chunk", () => {
    const fused = fuse([hit("and", "d", 7, 1), hit("or", "d", 2, 1)].map((h) => ({ ...h, channel: "and" as const })));
    expect(fused[0].chunks.map((c) => c.ord)).toEqual([2, 7]);
  });
});
