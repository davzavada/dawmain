#!/usr/bin/env node
/**
 * Retrieval evaluation of Vlastní zdroje (plan §12): runs a set of Czech
 * queries through the files_search pipeline and prints recall@k (default
 * k = 5) and MRR — the numbers that decide whether search needs vectors.
 *
 *   node scripts/files-eval.mjs --queries scripts/files-eval.example.json
 *   node scripts/files-eval.mjs --queries my-set.json --verbose       # + the top k per query
 *   node scripts/files-eval.mjs --queries my-set.json --json          # machine-readable result
 *   FILES_DATABASE_URL=… node scripts/files-eval.mjs --queries my-set.json --db --library user_abc
 *   node scripts/files-eval.mjs --queries my-set.json --k 10           # another cutoff (1–50)
 *
 * Exit code 0 whatever the scores (it measures, it does not gate); 1 on an
 * error, 2 on bad arguments or a malformed query file.
 *
 * Two corpora:
 *
 * - PGlite (default): an in-memory Postgres with the production migrations,
 *   queried as dawmain_app under RLS. The query file's `corpus` (DMD texts,
 *   inline or in files next to it) is ingested with the same chain of
 *   repositories as src/files/ingest.ts (normalize → parse → derive →
 *   storage blocks → writeDocumentIndex → finishIngest 'ready'); metadata
 *   come from the heuristics (no AI call) overridden by the entry's `meta`.
 *   No network, nothing leaves the machine.
 * - `--db`: the documents already in a real database (FILES_DATABASE_URL,
 *   the dawmain_app role — RLS applies), limited to `--library` (comma-
 *   separated ids). Prefer a local Postgres with a copy of the texts: every
 *   run against Neon wakes it and costs compute hours of the free plan.
 *
 * Each query runs the way files_search runs it (src/mcp/tools/files.ts,
 * searchVariant + mergeVariants): identifiers of the query, buildTsQuery
 * over the rest (weights for in_footnotes), the act filter (explicit or
 * implied by "§ N <act>"), the channels, RRF fusion, variants merged
 * round-robin, 2 passages per document. Not evaluated: `section`, `doc`,
 * and the note-only passage filter of in_footnotes: false (those run after
 * the channels, in files.ts itself).
 *
 * Query file (JSON):
 *
 *   {
 *     "corpus": [                                  // PGlite only; ignored with --db
 *       { "key": "oz6",                            // how queries name the document
 *         "file": "texts/oz6.dmd.md",              // DMD, relative to this JSON file…
 *         "text": "…",                             // …or inline
 *         "file_name": "OZ-VI.pdf",                // optional (default: file / key)
 *         "meta": { "doc_type": "komentar", "title": "…", "commented_act": "zak:89/2012" } }
 *     ],
 *     "queries": [
 *       { "id": "q01",
 *         "query": "odpovednost za skodu",         // or "queries": [up to 3 variants]
 *         "act": "OZ", "doc_type": ["komentar"], "case_number": "25 Cdo 1234/2019",
 *         "in_footnotes": true, "year_from": 2010, "year_to": 2020,   // all optional, as in files_search
 *         "relevant": [                            // what a good answer shows
 *           "oz6",                                 // any passage of the document (or its metadata)
 *           { "doc": "oz6", "section": "§ 2913" }, // a passage inside that § / čl. / heading
 *           { "doc": "oz6", "page": "1245" },      // a passage on that printed page
 *           { "doc": "oz6", "contains": "liberační důvod" }  // a passage containing the words
 *         ] }                                      //   (case and diacritics ignored; conditions combine)
 *     ]
 *   }
 *
 * With --db, "doc" is a document id or its exact title (or file name).
 *
 * Metrics. The ranked list is what files_search shows, in order: for each
 * document its passages (a document found by its metadata alone takes one
 * slot). Passage recall@k = share of a query's relevant items matched by
 * one of the first k slots; passage MRR = 1 / rank of the first slot that
 * matches any item (0 when none does). The document-level pair does the
 * same over the ranked documents. All four are averaged over the queries.
 *
 * TypeScript sources are loaded through Vite (a dependency of vitest) with
 * the aliases of vitest.config.mts, so the script runs the real code.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = "user_eval";
const UPLOADER = "user_eval";
/** files.ts: CHANNEL_DEPTH, the per-document SQL cap outside doc/section mode, CHUNKS_PER_DOC. */
const CHANNEL_DEPTH = 60;
const PER_DOC_SQL = 3;
const CHUNKS_PER_DOC = 2;
const QUERY_KEYS = new Set([
  "id", "query", "queries", "act", "doc_type", "case_number", "in_footnotes", "year_from", "year_to", "relevant", "note",
]);

function usage(message) {
  if (message) console.error(`files-eval: ${message}\n`);
  console.error(
    "usage: node scripts/files-eval.mjs --queries <file.json> [--k 5] [--verbose] [--json]\n" +
      "       node scripts/files-eval.mjs --queries <file.json> --db --library <id[,id…]>   (FILES_DATABASE_URL)",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { queries: null, k: 5, verbose: false, json: false, db: false, libraries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
    if (a === "--queries") out.queries = next();
    else if (a === "--k") out.k = Number(next());
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--json") out.json = true;
    else if (a === "--db") out.db = true;
    else if (a === "--library") out.libraries = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument ${a}`);
  }
  if (!out.queries) usage("--queries is required");
  if (!Number.isInteger(out.k) || out.k < 1 || out.k > 50) usage("--k must be an integer 1–50");
  if (out.db && !out.libraries.length) usage("--db needs --library");
  if (out.db && !process.env.FILES_DATABASE_URL?.trim()) usage("--db reads FILES_DATABASE_URL (the dawmain_app role); export it first");
  return out;
}

/** Lowercase, no diacritics, single spaces — for "contains" and heading matches. */
function fold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

function readQueryFile(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    usage(`cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(data?.queries) || !data.queries.length) usage(`${file}: "queries" must be a non-empty array`);
  const ids = new Set();
  data.queries.forEach((q, i) => {
    const where = `${file}: queries[${i}]`;
    for (const key of Object.keys(q)) if (!QUERY_KEYS.has(key)) usage(`${where}: "${key}" is not evaluated (supported: ${[...QUERY_KEYS].join(", ")})`);
    if (!q.query && !q.queries?.length && !q.case_number) usage(`${where}: needs query, queries or case_number`);
    if (q.queries && (!Array.isArray(q.queries) || q.queries.length > 3)) usage(`${where}: "queries" takes up to 3 strings`);
    if (!Array.isArray(q.relevant) || !q.relevant.length) usage(`${where}: "relevant" must be a non-empty array`);
    q.id = String(q.id ?? `q${i + 1}`);
    if (ids.has(q.id)) usage(`${where}: duplicate id "${q.id}"`);
    ids.add(q.id);
    q.relevant = q.relevant.map((r) => (typeof r === "string" ? { doc: r } : r));
    for (const r of q.relevant) if (!r?.doc) usage(`${where}: every relevant item needs "doc"`);
  });
  return data;
}

async function loadModules() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.join(ROOT, "vitest.config.mts"),
    root: ROOT,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    // Clerk's ESM build is not loadable by plain Node (extensionless imports); let Vite transform it.
    ssr: { noExternal: [/^@clerk\//] },
  });
  const load = (p) => server.ssrLoadModule(p);
  const [config, client, documents, libraries, reading, search, blocks, normalize, parse, derive, identifiers, analyze, input, heuristics, schema, files] =
    await Promise.all([
      load("/src/files/config.ts"),
      load("/src/files/db/client.ts"),
      load("/src/files/db/documents.ts"),
      load("/src/files/db/libraries.ts"),
      load("/src/files/db/reading.ts"),
      load("/src/files/db/search.ts"),
      load("/src/files/dmd/blocks.ts"),
      load("/src/files/dmd/normalize.ts"),
      load("/src/files/dmd/parse.ts"),
      load("/src/files/index/derive.ts"),
      load("/src/files/index/identifiers.ts"),
      load("/src/files/text/analyze.ts"),
      load("/src/files/meta/input.ts"),
      load("/src/files/meta/heuristics.ts"),
      load("/src/files/meta/schema.ts"),
      load("/src/mcp/tools/files.ts"),
    ]);
  return {
    server,
    m: { ...config, ...client, ...documents, ...libraries, ...reading, ...search, ...blocks, ...normalize, ...parse, ...derive, ...identifiers, ...analyze, ...input, ...heuristics, ...schema, files },
  };
}

// ---------------------------------------------------------------------------
// PGlite corpus

async function pgliteRunner(m) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readdirSync } = await import("node:fs");
  const db = await PGlite.create();
  const dir = path.join(ROOT, "src", "files", "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  const q = { query: (text, params) => db.query(text, params) };
  let chain = Promise.resolve();
  // Like withScope: one transaction as dawmain_app (RLS on), the scope transaction-local.
  m.setScopeRunner((libraryIds, fn) => {
    const run = async () => {
      await db.exec("BEGIN");
      try {
        await db.exec("SET LOCAL ROLE dawmain_app");
        await db.query("SELECT set_config('app.library_ids', $1, true)", [libraryIds.join(",")]);
        const result = await fn(q);
        await db.exec("COMMIT");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK");
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  });
  return db;
}

/** Upload + ingest one corpus entry as upload.ts and ingest.ts chain the repositories. Returns its id. */
async function ingestEntry(m, entry, baseDir) {
  const raw = entry.text ?? (entry.file ? readFileSync(path.resolve(baseDir, entry.file), "utf8") : null);
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`corpus "${entry.key}": needs "text" or "file"`);
  const text = m.normalizeDmd(raw).text;
  const fileName = entry.file_name ?? (entry.file ? path.basename(entry.file) : `${entry.key}.md`);
  const parsed = m.parseDmd(text);
  const heuristic = m.heuristicMeta(m.buildMetaInput(parsed, {}, fileName, entry.meta?.doc_type ?? null));
  const meta = { ...m.proposalToBibMeta(heuristic, fileName), ...(entry.meta ?? {}) };
  if (meta.doc_type === "komentar" && !entry.meta?.section_range) meta.section_range = m.sectionRangeOf(parsed.sections);
  if (!meta.anchor_label) meta.anchor_label = parsed.anchorLabel;
  const uploadMeta = {
    library_id: LIBRARY,
    file: { name: fileName, bytes: Buffer.byteLength(raw), sha256: sha(`file:${entry.key}:${text}`), kind: "md" },
    converter: "eval@1",
    content: { sha256: sha(text), chars: text.length },
    pages: { physical: parsed.pages.length || null, label_source: parsed.pages.length ? "printed" : "none" },
    quality: { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 0, unsure_pages: [] },
    hints: {},
    rights: "vlastni",
    doc_type_hint: meta.doc_type,
  };
  const inserted = await m.withScope([LIBRARY], (db) =>
    m.insertUploadedDocument(db, {
      libraryId: LIBRARY,
      uploadedBy: UPLOADER,
      meta: uploadMeta,
      contentSha256: sha(text),
      charCount: text.length,
      billablePages: Math.max(1, Math.ceil(text.length / m.PAGE_CHARS)),
      physicalPages: parsed.pages.length || null,
      pendingGz: gzipSync(Buffer.from(text, "utf8")),
      quality: uploadMeta.quality,
      hints: {},
      injectionFlag: false,
    }),
  );
  if (!("id" in inserted)) throw new Error(`corpus "${entry.key}": the same text as another entry`);
  const claim = await m.withScope([LIBRARY], (db) => m.claimForIngest(db, inserted.id, LIBRARY));
  if (!claim) throw new Error(`corpus "${entry.key}": claim failed`);
  const derived = m.deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
  await m.withScope([LIBRARY], async (db) => {
    const wrote = await m.writeDocumentIndex(db, {
      id: inserted.id,
      libraryId: LIBRARY,
      runToken: claim.runToken,
      text,
      blocks: m.splitStorageBlocks(text),
      parsed,
      derived,
      analyzerVersion: m.ANALYZER_VERSION,
    });
    const finished =
      wrote &&
      (await m.finishIngest(db, {
        id: inserted.id,
        libraryId: LIBRARY,
        runToken: claim.runToken,
        proposed: heuristic,
        meta,
        metaTsv: m.buildMetaTsv(meta, parsed.sections),
        identKeys: [...new Set([...m.metaIdentKeys(meta), ...derived.docIdentKeys])],
        status: "ready",
        statusDetail: null,
      }));
    if (!finished) throw new Error(`corpus "${entry.key}": ingest did not finish`);
  });
  return inserted.id;
}

// ---------------------------------------------------------------------------
// Search (files.ts searchVariant + mergeVariants, without the rendering)

function parzKeys(act, sections) {
  if (!act?.startsWith("zak:")) return [];
  const num = act.slice(4);
  return sections.flatMap((s) => {
    const hit = /^par:(\d+[a-z]?)$/.exec(s);
    return hit ? [`parz:${num}/${hit[1]}`] : [];
  });
}

async function runQuery(m, libs, q) {
  const act = q.act ? m.files.resolveActFilter(q.act) : null;
  if (q.act && !act) throw new Error(`query ${q.id}: unknown act "${q.act}"`);
  const caseKeys = q.case_number ? m.files.caseNumberKeys(q.case_number) : [];
  if (q.case_number && !caseKeys.length) throw new Error(`query ${q.id}: "${q.case_number}" is not a spisová značka`);
  const weights = q.in_footnotes === true ? "D" : q.in_footnotes === false ? "ABC" : undefined;
  const variants = [...new Set([q.query, ...(q.queries ?? [])].filter((v) => typeof v === "string" && v.trim()))];
  const lists = [];
  for (const variant of variants.length ? variants : [undefined]) {
    const ids = variant ? m.queryIdentKeys(variant) : { keys: [], act: null, sections: [] };
    const ts = variant ? m.buildTsQuery(m.stripIdentifiers(variant), { weights }) : { and: null, or: null };
    const actId = act?.act ?? m.files.implicitAct(ids);
    const identKeys = [...new Set([...ids.keys, ...parzKeys(actId, ids.sections), ...caseKeys])];
    const hits = await m.withScope(libs, (db) =>
      m.searchChannels(db, {
        libraryIds: libs,
        tsAnd: ts.and,
        tsOr: ts.or,
        identKeys,
        docTypes: q.doc_type?.length ? q.doc_type : null,
        yearFrom: q.year_from ?? null,
        yearTo: q.year_to ?? null,
        act: actId,
        docId: null,
        perDoc: PER_DOC_SQL,
        limit: CHANNEL_DEPTH,
      }),
    );
    lists.push(m.fuse(hits, { perDoc: CHUNKS_PER_DOC }));
  }
  let entries = m.files.mergeVariants(lists, { perDoc: CHUNKS_PER_DOC });
  if (q.in_footnotes === true) entries = entries.filter((e) => e.chunks.length > 0);
  return entries;
}

// ---------------------------------------------------------------------------
// Judging

/** Slots in display order: each passage of each document; a metadata-only document takes one slot. */
async function slotsOf(m, libs, entries, cache) {
  const keys = entries.flatMap((e) => e.chunks.map((ord) => ({ docId: e.docId, ord })));
  const chunks = new Map();
  await m.withScope(libs, async (db) => {
    for (const c of await m.loadChunks(db, libs, keys)) {
      let doc = cache.get(c.docId);
      if (!doc) {
        doc = await m.loadReadDoc(db, c.docId, libs);
        cache.set(c.docId, doc);
      }
      const src = await m.loadText(db, c.docId, doc.row.library_id, c.start, c.end);
      const bySection = new Map(doc.sections.map((s) => [s.ord, s]));
      const chain = [];
      for (let s = c.sectionOrd; s !== null && s !== undefined && bySection.has(s); s = bySection.get(s).parent) chain.push(bySection.get(s));
      const pages = doc.pages.filter((p) => p.start < c.end && p.end > c.start).map((p) => p.label);
      chunks.set(`${c.docId}:${c.ord}`, { text: src.slice(c.start, c.end), chain, pages });
    }
  });
  return entries.flatMap((e) =>
    e.chunks.length
      ? e.chunks.map((ord) => ({ docId: e.docId, ord, chunk: chunks.get(`${e.docId}:${ord}`) ?? null }))
      : [{ docId: e.docId, ord: null, chunk: null }],
  );
}

function matches(m, slot, item, docIds) {
  if (slot.docId !== docIds.get(item.doc)) return false;
  const passageOnly = item.section || item.page || item.contains;
  if (!passageOnly) return true;
  if (!slot.chunk) return false;
  if (item.section) {
    const key = m.files.searchSectionKey(item.section);
    const want = fold(item.section);
    if (!slot.chunk.chain.some((s) => (key && s.key === key) || fold(s.heading).startsWith(want))) return false;
  }
  if (item.page && !slot.chunk.pages.some((label) => fold(label) === fold(item.page))) return false;
  if (item.contains && !fold(slot.chunk.text).includes(fold(item.contains))) return false;
  return true;
}

function judge(m, q, entries, slots, docIds, k) {
  const found = q.relevant.map((item) => slots.slice(0, k).some((s) => matches(m, s, item, docIds)));
  const firstSlot = slots.findIndex((s) => q.relevant.some((item) => matches(m, s, item, docIds)));
  const wanted = [...new Set(q.relevant.map((r) => docIds.get(r.doc)))];
  const topDocs = entries.slice(0, k).map((e) => e.docId);
  const firstDoc = entries.findIndex((e) => wanted.includes(e.docId));
  return {
    id: q.id,
    passageRecall: found.filter(Boolean).length / found.length,
    passageRR: firstSlot < 0 ? 0 : 1 / (firstSlot + 1),
    passageRank: firstSlot < 0 ? null : firstSlot + 1,
    docRecall: wanted.filter((d) => topDocs.includes(d)).length / wanted.length,
    docRR: firstDoc < 0 ? 0 : 1 / (firstDoc + 1),
    missed: q.relevant.filter((_, i) => !found[i]),
  };
}

// ---------------------------------------------------------------------------

async function resolveDbDocs(m, libs, data) {
  const rows = await m.withScope(libs, async (db) => {
    const { rows } = await db.query(
      "SELECT id, title, file_name FROM documents WHERE library_id = ANY($1) AND status = 'ready' AND enabled",
      [libs],
    );
    return rows;
  });
  const docIds = new Map();
  for (const q of data.queries) {
    for (const r of q.relevant) {
      if (docIds.has(r.doc)) continue;
      const hit = rows.filter((d) => d.id === r.doc || d.title === r.doc || d.file_name === r.doc);
      if (hit.length !== 1) {
        throw new Error(`query ${q.id}: document "${r.doc}" ${hit.length ? "is ambiguous — use its id" : "is not among the ready documents in scope"}`);
      }
      docIds.set(r.doc, hit[0].id);
    }
  }
  return { docIds, titles: new Map(rows.map((d) => [d.id, d.title || d.file_name])), count: rows.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = readQueryFile(args.queries);
  const { server, m } = await loadModules();
  let pglite = null;
  try {
    let libs;
    let docIds;
    let titles;
    let corpusSize;
    if (args.db) {
      libs = args.libraries;
      for (const id of libs) if (!m.LIBRARY_ID_RE.test(id)) usage(`invalid library id ${id}`);
      ({ docIds, titles, count: corpusSize } = await resolveDbDocs(m, libs, data));
    } else {
      if (!Array.isArray(data.corpus) || !data.corpus.length) usage(`${args.queries}: "corpus" is required without --db`);
      pglite = await pgliteRunner(m);
      libs = [LIBRARY];
      await m.withScope(libs, (db) => m.ensureLibrary(db, LIBRARY, "Evaluace"));
      docIds = new Map();
      titles = new Map();
      const baseDir = path.dirname(path.resolve(args.queries));
      for (const entry of data.corpus) {
        if (!entry?.key || docIds.has(entry.key)) usage(`corpus: every entry needs a unique "key"`);
        const id = await ingestEntry(m, entry, baseDir);
        docIds.set(entry.key, id);
        titles.set(id, entry.key);
      }
      for (const q of data.queries) for (const r of q.relevant) if (!docIds.has(r.doc)) usage(`query ${q.id}: "${r.doc}" is not a corpus key`);
      corpusSize = data.corpus.length;
    }

    const cache = new Map();
    const results = [];
    for (const q of data.queries) {
      const entries = await runQuery(m, libs, q);
      const slots = await slotsOf(m, libs, entries, cache);
      const r = judge(m, q, entries, slots, docIds, args.k);
      results.push(r);
      if (!args.json) {
        const label = q.query ?? q.queries?.[0] ?? q.case_number;
        console.log(
          `${r.passageRecall === 1 ? "✓" : r.passageRecall > 0 ? "~" : "✗"} ${q.id.padEnd(6)} recall@${args.k} ${r.passageRecall.toFixed(2)}  ` +
            `first relevant: ${r.passageRank ?? "—"}  ${JSON.stringify(label)}`,
        );
        if (args.verbose) {
          slots.slice(0, args.k).forEach((s, i) => {
            const where = s.chunk
              ? [s.chunk.chain[0]?.heading, s.chunk.pages.length ? `s. ${s.chunk.pages.join("–")}` : null].filter(Boolean).join(", ")
              : "metadata";
            const excerpt = s.chunk ? fold(s.chunk.text).slice(0, 70) : "";
            console.log(`     ${i + 1}. ${titles.get(s.docId) ?? s.docId} · ${where}${excerpt ? ` · ${excerpt}…` : ""}`);
          });
          for (const miss of r.missed) console.log(`     missed: ${JSON.stringify(miss)}`);
        }
      }
    }

    const mean = (f) => results.reduce((a, r) => a + r[f], 0) / results.length;
    const summary = {
      queries: results.length,
      documents: corpusSize,
      k: args.k,
      passage: { recall: mean("passageRecall"), mrr: mean("passageRR") },
      document: { recall: mean("docRecall"), mrr: mean("docRR") },
    };
    if (args.json) {
      console.log(JSON.stringify({ summary, results }, null, 2));
    } else {
      console.log(
        `\n${summary.queries} queries over ${summary.documents} documents (${args.db ? `database, ${libs.join(", ")}` : "PGlite"})\n` +
          `passages:  recall@${args.k} ${summary.passage.recall.toFixed(3)}   MRR ${summary.passage.mrr.toFixed(3)}\n` +
          `documents: recall@${args.k} ${summary.document.recall.toFixed(3)}   MRR ${summary.document.mrr.toFixed(3)}`,
      );
    }
  } finally {
    m.setScopeRunner(null);
    await pglite?.close();
    await server.close();
  }
}

main().then(
  // pg keeps idle pool connections open for a few seconds; nothing is left to wait for.
  () => process.exit(0),
  (error) => {
    console.error(`files-eval: ${error?.stack ?? error}`);
    process.exit(1);
  },
);
