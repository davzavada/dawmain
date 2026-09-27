import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYZER_VERSION } from "@/src/files/config";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import { claimForIngest, finishIngest, insertUploadedDocument, writeDocumentIndex } from "@/src/files/db/documents";
import { ensureLibrary } from "@/src/files/db/libraries";
import { loadReadDoc, loadText, type ReadDoc } from "@/src/files/db/reading";
import { fuse, loadChunks, searchChannels, type SearchParams } from "@/src/files/db/search";
import { splitStorageBlocks } from "@/src/files/dmd/blocks";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { buildMetaTsv, deriveIndex, metaIdentKeys } from "@/src/files/index/derive";
import { queryIdentKeys, stripIdentifiers } from "@/src/files/index/identifiers";
import { buildTsQuery } from "@/src/files/text/analyze";
import type { BibMeta, UploadMeta } from "@/src/files/types";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * The whole indexing and retrieval pipeline on a real Postgres (PGlite, as
 * dawmain_app under RLS): a realistic commentary DMD → gzip upload →
 * claim → normalize → parse → storage blocks → deriveIndex →
 * writeDocumentIndex → buildMetaTsv / metaIdentKeys → finishIngest('ready');
 * then queries the way files_search runs them: buildTsQuery over the query
 * minus its identifiers, queryIdentKeys for the idn channel and the act
 * filter, searchChannels, fuse, loadChunks, and the chunk text via
 * loadText. A book in the same library competes for the words; a copy of
 * the commentary in another library must never surface.
 */

const LIB = "user_e2e";
const OTHER = "org_other";

const COMMENTARY = `[s. 1245]

# ČÁST ČTVRTÁ Relativní majetková práva

## HLAVA III Závazky z deliktů

### § 2913 [Porušení smluvní povinnosti]

> (1) Poruší-li strana povinnost ze smlouvy, nahradí škodu z toho vzniklou druhé straně nebo i osobě, jejímuž zájmu mělo splnění ujednané povinnosti zřejmě sloužit.
>
> (2) Povinnosti k náhradě se škůdce zprostí, prokáže-li, že mu ve splnění povinnosti ze smlouvy dočasně nebo trvale zabránila mimořádná nepředvídatelná a nepřekonatelná překážka vzniklá nezávisle na jeho vůli.

#### I. Obecně

Zpracoval: Filip Melzer

[m. č. 1] Komentované ustanovení upravuje odpovědnost za škodu způsobenou porušením smluvní povinnosti. Jde o objektivní odpovědnost, u níž se zavinění škůdce nevyžaduje.[^1] Škůdce se může zprostit jen prokázáním liberačního důvodu podle odstavce druhého.

[^1]: Srov. rozsudek Nejvyššího soudu ze dne 12. 3. 2020, sp. zn. 25 Cdo 1234/2019, a dále ECLI:CZ:NS:2020:25.CDO.1234.2019.1.

[m. č. 2] Předpokladem vzniku povinnosti k náhradě je porušení povinnosti ze smlouvy, vznik škody a příčinná souvislost mezi nimi. Věřitel nemusí [s. 1246] prokazovat zavinění dlužníka; stačí, že povinnost nebyla splněna řádně a včas.

#### II. Liberace

[m. č. 3] Liberační důvod musí být mimořádný, nepředvídatelný a nepřekonatelný a musí vzniknout nezávisle na vůli škůdce.[^2] Za takovou překážku se nepovažuje okolnost, která vznikla teprve v době prodlení.

[^2]: Blíže MELZER, F. Liberační důvody. Právní rozhledy, 2015, č. 4, s. 117.

[s. 1247]

### § 2914 [Odpovědnost za jiného]

[m. č. 1] Kdo ve své činnosti použije zmocněnce, zaměstnance nebo jiného pomocníka, nahradí škodu jím způsobenou stejně, jako by ji způsobil sám. Nejvyšší soud tento rozsudek opakovaně potvrdil ve vztahu k pomocníkům při plnění. Na rozdíl od § 2913 nejde o porušení vlastní povinnosti.
`;

const BOOK = `# Kapitola 1 Kupní smlouva

Kupní smlouvou se prodávající zavazuje odevzdat kupujícímu věc. Odpovědnost prodávajícího za vady se řídí zvláštními ustanoveními; náhrada škody přichází v úvahu vedle práv z vadného plnění.

# Kapitola 2 Nájem

Nájemce platí nájemné. Odpovědnost pronajímatele za stav věci je upravena samostatně.
`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function metaOf(docType: BibMeta["doc_type"], title: string, extra: Partial<BibMeta> = {}): BibMeta {
  return { doc_type: docType, title, authors: [], editors: [], isbn: [], keywords: [], language: "cs", ...extra };
}

const COMMENTARY_META = metaOf("komentar", "Občanský zákoník VI. Komentář", {
  editors: ["Melzer, Filip", "Tégl, Petr"],
  publisher: "Leges",
  year: 2018,
  isbn: ["978-80-7502-274-5"],
  commented_act: "zak:89/2012",
  commented_act_name: "občanský zákoník",
});

let t: TestDb;
const scoped = <T>(libs: string[], fn: (db: Queryable) => Promise<T>) => withScope(libs, fn);

/** Upload + ingest exactly as upload.ts and ingest.ts chain the repositories. Returns the document id. */
async function ingest(lib: string, dmd: string, meta: BibMeta, fileName: string): Promise<string> {
  const text = normalizeDmd(dmd).text;
  const uploadMeta: UploadMeta = {
    library_id: lib,
    file: { name: fileName, bytes: text.length, sha256: sha(`file:${text}`), kind: "pdf" },
    converter: "pdf@1",
    content: { sha256: sha(text), chars: text.length },
    pages: { physical: 3, label_source: "printed" },
    quality: { footnotes: "linked", linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 4, unsure_pages: [] },
    hints: {},
    rights: "vlastni",
    doc_type_hint: meta.doc_type,
  };
  const inserted = await scoped([lib], (db) =>
    insertUploadedDocument(db, {
      libraryId: lib,
      uploadedBy: "user_e2e",
      meta: uploadMeta,
      contentSha256: sha(text),
      charCount: text.length,
      billablePages: 1,
      physicalPages: 3,
      pendingGz: gzipSync(Buffer.from(text, "utf8")),
      quality: uploadMeta.quality,
      hints: {},
      injectionFlag: false,
    }),
  );
  if (!("id" in inserted)) throw new Error("unexpected duplicate");
  const id = inserted.id;
  const claim = await scoped([lib], (db) => claimForIngest(db, id, lib));
  if (!claim) throw new Error("claim failed");

  const stored = normalizeDmd(gunzipSync(claim.pendingGz).toString("utf8")).text;
  const parsed = parseDmd(stored);
  const derived = deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
  await scoped([lib], async (db) => {
    const wrote = await writeDocumentIndex(db, {
      id,
      libraryId: lib,
      runToken: claim.runToken,
      text: stored,
      blocks: splitStorageBlocks(stored, 400), // small blocks: chunks straddle block borders
      parsed,
      derived,
      analyzerVersion: ANALYZER_VERSION,
    });
    if (!wrote) throw new Error("lease lost");
    const finished = await finishIngest(db, {
      id,
      libraryId: lib,
      runToken: claim.runToken,
      proposed: {},
      meta: { ...meta, section_range: derived.sectionRange },
      metaTsv: buildMetaTsv(meta, parsed.sections),
      identKeys: [...new Set([...metaIdentKeys(meta), ...derived.docIdentKeys])],
      status: "ready",
      statusDetail: null,
    });
    if (!finished) throw new Error("finish failed");
  });
  return id;
}

interface Hit {
  docId: string;
  ord: number;
  heading: string;
  /** Headings from the section up to the root, innermost first. */
  path: string[];
  text: string;
}

let commentaryId: string;
let bookId: string;
let foreignId: string;
let readDoc: ReadDoc;

/** Run the channels the way files_search does and resolve the shown chunks to text and headings. */
async function search(
  query: string,
  opts: { weights?: string; act?: boolean } = {},
): Promise<{ docs: ReturnType<typeof fuse>; hits: Hit[]; params: SearchParams }> {
  const ids = queryIdentKeys(query);
  const ts = buildTsQuery(stripIdentifiers(query), { weights: opts.weights });
  const params: SearchParams = {
    libraryIds: [LIB],
    tsAnd: ts.and,
    tsOr: ts.or,
    identKeys: opts.weights ? [] : ids.keys,
    act: opts.act ? ids.act : null,
    perDoc: 3,
    limit: 60,
  };
  return scoped([LIB], async (db) => {
    const docs = fuse(await searchChannels(db, params));
    const keys = docs.flatMap((d) => d.chunks.map((c) => ({ docId: d.docId, ord: c.ord })));
    const hits: Hit[] = [];
    for (const c of await loadChunks(db, [LIB], keys)) {
      const src = await loadText(db, c.docId, LIB, c.start, c.end);
      const sections = c.docId === commentaryId ? readDoc.sections : (await loadReadDoc(db, c.docId, [LIB]))!.sections;
      const path: string[] = [];
      for (let s = c.sectionOrd; s !== null; s = sections[s].parent) path.push(sections[s].heading);
      hits.push({ docId: c.docId, ord: c.ord, heading: path[0] ?? "", path, text: src.slice(c.start, c.end) });
    }
    return { docs, hits, params };
  });
}

const inPar2913 = (h: Hit) => h.path.includes("§ 2913 [Porušení smluvní povinnosti]");

beforeAll(async () => {
  t = await createTestDb();
  setScopeRunner(t.runner);
  await scoped([LIB], (db) => ensureLibrary(db, LIB, "E2E"));
  await scoped([OTHER], (db) => ensureLibrary(db, OTHER, "Jiný tým"));
  commentaryId = await ingest(LIB, COMMENTARY, COMMENTARY_META, "OZ-komentar.pdf");
  bookId = await ingest(LIB, BOOK, metaOf("kniha", "Smluvní právo", { authors: ["Novák, Jan"], year: 2021 }), "kniha.pdf");
  foreignId = await ingest(OTHER, COMMENTARY, COMMENTARY_META, "OZ-komentar.pdf");
  readDoc = (await scoped([LIB], (db) => loadReadDoc(db, commentaryId, [LIB])))!;
}, 60_000);

afterAll(async () => {
  setScopeRunner(null);
  await t?.close();
});

describe("files search end to end (PGlite)", () => {
  it("stores the derived index: sections, chunks with sec: keys, document keys and metadata", async () => {
    expect(readDoc.row).toMatchObject({ status: "ready", analyzer_version: ANALYZER_VERSION });
    expect(readDoc.row.meta.section_range).toBe("§ 2913–2914");
    expect(readDoc.sections.map((s) => s.key)).toEqual([
      "part:cast-ctvrta",
      "part:hlava-iii",
      "par:2913",
      null,
      null,
      "par:2914",
    ]);
    const { rows } = await t.owner.query<{ ord: number; keys: string[]; section_ord: number }>(
      "SELECT ord, ident_keys AS keys, section_ord FROM chunks WHERE doc_id = $1 ORDER BY ord",
      [commentaryId],
    );
    expect(rows.filter((r) => r.keys.includes("sec:par:2913")).map((r) => r.section_ord)).toEqual([2, 3, 4]);
    const docKeys = (await t.owner.query<{ k: string[] }>("SELECT ident_keys AS k FROM documents WHERE id = $1", [commentaryId])).rows[0].k;
    expect(docKeys).toEqual(expect.arrayContaining(["isbn:9788075022745", "zak:89/2012", "sz:25cdo1234-2019", "sec:par:2913"]));
  });

  it("finds the § 2913 chunk for an inflected query typed without diacritics", async () => {
    const { docs, hits } = await search("odpovednosti za skodu zpusobenou porusenim smluvnich povinnosti");
    expect(docs[0].docId).toBe(commentaryId);
    expect(docs[0].matchedBy).toContain("and");
    const top = hits.find((h) => h.docId === commentaryId)!;
    expect(top.heading).toBe("I. Obecně");
    expect(inPar2913(top)).toBe(true);
    expect(top.text).toContain("odpovědnost za škodu způsobenou porušením smluvní povinnosti");
    expect(hits.some((h) => h.docId === foreignId)).toBe(false);
  });

  it('finds body words and a footnote sp. zn. in one chunk: "odpovědnost 25 Cdo 1234/2019"', async () => {
    const { docs, hits, params } = await search("odpovědnost 25 Cdo 1234/2019");
    expect(params.identKeys).toEqual(["sz:25cdo1234-2019"]);
    expect(docs[0].docId).toBe(commentaryId);
    expect(docs[0].matchedBy).toEqual(expect.arrayContaining(["and", "idn"]));
    const top = hits[0];
    expect(top.heading).toBe("I. Obecně");
    expect(top.text).toContain("odpovědnost");
    expect(top.text).toContain("[^1]: Srov. rozsudek Nejvyššího soudu ze dne 12. 3. 2020, sp. zn. 25 Cdo 1234/2019");
    // Even the raw query (sp. zn. tokens left in the tsquery) is ONE AND match: the note lives in the chunk.
    const tsAnd = buildTsQuery("odpovědnost 25 Cdo 1234/2019").and;
    const andOnly = await scoped([LIB], (db) => searchChannels(db, { libraryIds: [LIB], tsAnd, tsOr: null, identKeys: [], perDoc: 3, limit: 60 }));
    const and = andOnly.filter((h) => h.channel === "and");
    expect(and.map((h) => [h.docId, h.chunkOrd])).toEqual([[commentaryId, top.ord]]);
  });

  it('finds § 2913 for "§ 2913 o. z." — sec: keys and the act filter', async () => {
    const { docs, hits, params } = await search("§ 2913 o. z.", { act: true });
    expect(params).toMatchObject({ tsAnd: null, act: "zak:89/2012" });
    expect(params.identKeys).toEqual(["par:2913", "parz:89/2012/2913"]);
    expect(docs.map((d) => d.docId)).toEqual([commentaryId]); // the book neither comments on nor cites the OZ
    expect(docs[0].matchedBy).toEqual(["idn"]);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(inPar2913(h)).toBe(true);
    expect(hits[0].heading).toBe("§ 2913 [Porušení smluvní povinnosti]"); // the § itself first
    expect(docs[0].moreInDoc).toBeGreaterThan(0); // I. and II. (and § 2914, which cites § 2913) also match
  });

  it("restricted to footnotes (weight D), a word finds only the chunk whose note contains it", async () => {
    const all = await search("rozsudek");
    const everywhere = all.hits.filter((h) => h.docId === commentaryId).map((h) => h.heading);
    expect(everywhere).toEqual(expect.arrayContaining(["I. Obecně", "§ 2914 [Odpovědnost za jiného]"]));

    const notes = await search("rozsudek", { weights: "D" });
    expect(notes.docs.map((d) => d.docId)).toEqual([commentaryId]);
    expect(notes.hits.map((h) => h.heading)).toEqual(["I. Obecně"]);
    expect(notes.docs[0].moreInDoc).toBe(0);

    // A body-only word is not found in footnotes; excluding footnotes (ABC) drops the note-only match.
    expect((await search("zmocněnce", { weights: "D" })).docs).toEqual([]);
    const body = await search("Nejvyššího soudu", { weights: "ABC" });
    expect(body.hits.map((h) => h.heading)).toEqual(["§ 2914 [Odpovědnost za jiného]"]);
  });

  it("the meta channel finds the document by its title and outline", async () => {
    const { docs } = await search("zavazky z deliktu");
    expect(docs[0].docId).toBe(commentaryId);
    expect(docs[0].matchedBy).toContain("meta");
    const byEditor = await search("Tégl");
    expect(byEditor.docs.map((d) => d.docId)).toEqual([commentaryId]);
    expect(byEditor.docs[0].matchedBy).toEqual(["meta"]);
  });

  it("never returns the other library's copy, even when both libraries are in scope of the query text", async () => {
    const { docs } = await search("odpovědnost");
    expect(docs.map((d) => d.docId).sort()).toEqual([bookId, commentaryId].sort());
    const other = await scoped([OTHER], (db) =>
      searchChannels(db, { libraryIds: [LIB], tsAnd: buildTsQuery("odpovědnost").and, tsOr: null, identKeys: [], perDoc: 3, limit: 60 }),
    );
    expect(other).toEqual([]); // RLS: scope OTHER, filter LIB → nothing
  });
});
