import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYZER_VERSION } from "@/src/files/config";
import { __setAccessLoaderForTests } from "@/src/files/access";
import type { Access, LibraryAccess } from "@/src/files/access-types";
import { setScopeRunner, withScope, type Queryable, type ScopeRunner } from "@/src/files/db/client";
import { claimForIngest, finishIngest, insertUploadedDocument, writeDocumentIndex } from "@/src/files/db/documents";
import { ensureLibrary } from "@/src/files/db/libraries";
import { loadFootnotes, loadFootnotesMany, loadText, loadTexts, pagesAround, pagesAroundMany, sectionChains, sectionChainsMany } from "@/src/files/db/reading";
import { loadChunks } from "@/src/files/db/search";
import { splitStorageBlocks } from "@/src/files/dmd/blocks";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { __resetGuardsForTests, MODE_OVERRIDE_KEY } from "@/src/files/guards";
import { buildMetaTsv, deriveIndex, metaIdentKeys } from "@/src/files/index/derive";
import type { BibMeta } from "@/src/files/types";
import { planVariant, registerFiles } from "@/src/mcp/tools/files";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * files_search fixes from the 2026-09 search audit, through the real handler
 * on PGlite (dawmain_app under RLS): case_number and section as filters
 * inside SQL, citation furniture and lone stopwords next to identifiers,
 * act-only queries, doc-mode counts and paging, a page past the end, the
 * batched hit loading, the guard measurement overlapped with the search.
 */

const LIB = "user_fix";
const LIB_ACCESS: LibraryAccess = {
  id: LIB,
  kind: "user",
  name: "Osobní",
  slug: null,
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
};
const ACCESS: Access = { userId: LIB, banned: false, libraries: [LIB_ACCESS], all: [LIB_ACCESS], zotero: false };
const CTX = { http: { authInfo: { token: "t", clientId: "c", scopes: [], extra: { userId: LIB } } } };

const FILLER = "Obecný text o smluvních vztazích a jejich povaze v právní praxi. ";
const para = (mn: number, extra = "") => `[m. č. ${mn}] ${extra}${FILLER.repeat(22)}`;

/** § 2913: 15 paragraphs, "retence" only in the last; § 2914: 20 paragraphs that all repeat it. */
function retenceDmd(): string {
  const parts = ["[s. 1]", "", "# Komentář k závazkům", "", "## § 2913 [Porušení smluvní povinnosti]", ""];
  for (let mn = 1; mn <= 15; mn++) parts.push(para(mn, mn === 15 ? "Zadržovací právo (retence) se zde neuplatní. " : ""), "");
  parts.push("[s. 2]", "", "## § 2914 [Odpovědnost za jiného]", "");
  for (let mn = 1; mn <= 20; mn++) parts.push(para(mn, "Retence věci a retence peněz, retence obecně. "), "");
  return parts.join("\n");
}

/** Čl. II with a nested § 5: the word sits inside the §. */
const NESTED = `# Úmluva

## Čl. II Předmět

### § 5 Zvláštní režim

${"Úvodní text článku bez hledaného slova. ".repeat(30)}

Zvláštní pojistný režim se uplatní jen výjimečně. ${FILLER.repeat(10)}
`;

/** A long commentary: 70 paragraphs about "výklad" (doc mode) — 71 matching chunks with the heading's. */
function longDmd(): string {
  const parts = ["[s. 1]", "", "# Zákon o výkladu", "", "## § 1 [Výklad]", ""];
  for (let mn = 1; mn <= 70; mn++) parts.push(`[m. č. ${mn}] Výklad k číslu ${mn}. ${FILLER.repeat(22)}`, "");
  return parts.join("\n");
}

let t: TestDb;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const metaOf = (docType: BibMeta["doc_type"], title: string, extra: Partial<BibMeta> = {}): BibMeta => ({
  doc_type: docType,
  title,
  authors: [],
  editors: [],
  isbn: [],
  keywords: [],
  language: "cs",
  ...extra,
});

async function ingest(dmd: string, meta: BibMeta, physicalPages: number | null = null): Promise<string> {
  const text = normalizeDmd(dmd).text;
  const quality = { footnotes: "linked" as const, linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 4, unsure_pages: [] };
  const scoped = <T>(fn: (db: Queryable) => Promise<T>) => withScope([LIB], fn);
  const inserted = await scoped((db) =>
    insertUploadedDocument(db, {
      libraryId: LIB,
      uploadedBy: LIB,
      meta: {
        library_id: LIB,
        file: { name: `${meta.title}.pdf`, bytes: text.length, sha256: sha(`file:${text}:${meta.title}`), kind: "pdf" },
        converter: "pdf@1",
        content: { sha256: sha(`${text}:${meta.title}`), chars: text.length },
        ...(physicalPages ? { pages: { physical: physicalPages, label_source: "printed" as const } } : {}),
        quality,
        hints: {},
        rights: "vlastni",
        doc_type_hint: meta.doc_type,
      },
      contentSha256: sha(`${text}:${meta.title}`),
      charCount: text.length,
      billablePages: 1,
      physicalPages,
      pendingGz: gzipSync(Buffer.from(text, "utf8")),
      quality,
      hints: {},
      injectionFlag: false,
    }),
  );
  if (!("id" in inserted)) throw new Error("unexpected duplicate");
  const id = inserted.id;
  const claim = await scoped((db) => claimForIngest(db, id, LIB));
  if (!claim) throw new Error("claim failed");
  const stored = normalizeDmd(gunzipSync(claim.pendingGz).toString("utf8")).text;
  const parsed = parseDmd(stored);
  const derived = deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
  await scoped(async (db) => {
    // Small storage blocks, so passages straddle block borders and share blocks.
    if (!(await writeDocumentIndex(db, { id, libraryId: LIB, runToken: claim.runToken, text: stored, blocks: splitStorageBlocks(stored, 1_000), parsed, derived, analyzerVersion: ANALYZER_VERSION }))) {
      throw new Error("lease lost");
    }
    const ok = await finishIngest(db, {
      id,
      libraryId: LIB,
      runToken: claim.runToken,
      proposed: {},
      meta: { ...meta, section_range: derived.sectionRange },
      metaTsv: buildMetaTsv(meta, parsed.sections),
      identKeys: [...new Set([...metaIdentKeys(meta), ...derived.docIdentKeys])],
      status: "ready",
      statusDetail: null,
    });
    if (!ok) throw new Error("finish failed");
  });
  return id;
}

let retenceId: string;
let nestedId: string;
let citingId: string;
let longId: string;
let gdprId: string;
let isbnId: string;
const noiseIds: string[] = [];
const sectionIds: string[] = [];

/** Statements per scope of the last call: [libraries, statements]. */
let scopes: Array<{ libs: readonly string[]; statements: string[] }> = [];

beforeAll(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  t = await createTestDb();
  setScopeRunner(t.runner);
  await withScope([LIB], (db) => ensureLibrary(db, LIB, LIB));
  retenceId = await ingest(retenceDmd(), metaOf("komentar", "Komentář k závazkům", { year: 2020 }), 2);
  nestedId = await ingest(NESTED, metaOf("jine", "Úmluva o pojištění"));
  citingId = await ingest(
    `# Poznámka k judikatuře\n\nRozhodnutí 25 Cdo 1234/2019 se týká výkladu smlouvy. ${FILLER.repeat(10)}\n`,
    metaOf("clanek", "Poznámka k judikatuře"),
  );
  for (let i = 0; i < 4; i++) {
    noiseIds.push(
      await ingest(
        `# Nájem ${i}\n\nViz rozsudek sp. zn. 30 Cdo ${100 + i}/2018 a výklad k nájmu, k tomu též č. j. 12 Co ${i + 1}/2020. ${FILLER.repeat(10)}\n`,
        metaOf("clanek", `Nájem ${i}`),
      ),
    );
  }
  longId = await ingest(longDmd(), metaOf("komentar", "Zákon o výkladu. Komentář", { year: 2019 }), 1);
  gdprId = await ingest(
    `# Ochrana osobních údajů\n\nSprávce podle GDPR odpovídá za zpracování. ${FILLER.repeat(10)}\n\nNařízení (EU) 2016/679 dopadá i na zaměstnavatele. ${FILLER.repeat(10)}\n`,
    metaOf("clanek", "Ochrana osobních údajů"),
  );
  isbnId = await ingest(`# Kupní smlouva\n\nText o kupní smlouvě. ${FILLER.repeat(10)}\n`, metaOf("kniha", "Kupní smlouva", { isbn: ["978-80-7502-274-5"] }));
  for (let i = 0; i < 9; i++) {
    sectionIds.push(await ingest(`# Komentář ${i}\n\n## § 5 [Ustanovení]\n\nText k paragrafu pět číslo ${i}. ${FILLER.repeat(10)}\n`, metaOf("komentar", `Komentář ${i}`)));
  }
}, 180_000);

afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  await t?.close();
});

beforeEach(() => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  __resetGuardsForTests();
  __setAccessLoaderForTests(vi.fn(async () => ACCESS));
  scopes = [];
  const counting: ScopeRunner = (libs, fn, options) => {
    const scope = { libs, statements: [] as string[] };
    scopes.push(scope);
    return t.runner(libs, (db) => fn({ query: (text, params) => (scope.statements.push(text), db.query(text, params)) } as Queryable), options);
  };
  setScopeRunner(counting);
});

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;
const tools: Record<string, { handler: Handler; config: Record<string, unknown> }> = {};
registerFiles({
  registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
    tools[name] = { handler, config };
  },
} as never);

async function search(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const schema = tools.files_search.config.inputSchema as { parse: (v: unknown) => Record<string, unknown> };
  const result = await tools.files_search.handler(schema.parse(args), CTX);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

/** Document ids in the order their hits are listed (each hit line carries its read call). */
function listed(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/files_get_document \{id: "([0-9a-f-]{36})"/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/** The scopes that ran search statements, and those that did not (guard, doc lookup, load). */
const channelScopes = () => scopes.filter((s) => s.statements.some((q) => q.includes("files_search_")));

describe("case_number is a filter, also next to a query (files-query-0)", () => {
  it("lists only passages citing the decision; the query only ranks them", async () => {
    const r = await search({ query: "výklad", case_number: "25 Cdo 1234/19" });
    expect(r.isError).toBe(false);
    expect(listed(r.text)).toEqual([citingId]);
    expect(r.text).toContain("Filters: case_number 25 Cdo 1234/19");
    // Without the filter the word finds the other documents too.
    expect(listed((await search({ query: "výklad" })).text)).toEqual(expect.arrayContaining([citingId, longId, ...noiseIds]));
  });

  it("a lowercase registry is accepted (files-query-12)", async () => {
    const r = await search({ case_number: "25 cdo 1234/2019" });
    expect(r.isError).toBe(false);
    expect(listed(r.text)).toEqual([citingId]);
  });
});

describe("identifier queries: citation furniture and lone stopwords (files-query-1, files-query-2)", () => {
  it('"sp. zn." / "č. j." around a case number demand nothing of other chunks', async () => {
    for (const query of ["sp. zn. 25 Cdo 1234/2019", "č. j. 25 Cdo 1234/2019", "srov. 25 Cdo 1234/2019", "k 25 Cdo 1234/2019"]) {
      expect(listed((await search({ query })).text), query).toEqual([citingId]);
    }
  });

  it('"k § 5" finds what "§ 5" finds', async () => {
    const plain = listed((await search({ query: "§ 5", limit: 20 })).text);
    expect(plain.length).toBeGreaterThan(0);
    expect(listed((await search({ query: "k § 5", limit: 20 })).text)).toEqual(plain);
  });
});

describe("section is applied in SQL before the per-document cap (files-query-3, files-tool-0, files-tool-6)", () => {
  it("the passage inside the § that holds the word is found, ahead of the § 's first chunks", async () => {
    const r = await search({ query: "retence", section: "§ 2913" });
    expect(listed(r.text)).toEqual([retenceId]);
    expect(r.text).toContain("m. č. 15");
    expect(r.text).not.toContain("no query word in this passage");
    expect(r.text).not.toMatch(/§ 2914/);
    // Inside the document as well.
    const d = await search({ doc: retenceId, query: "retence", section: "§ 2913" });
    expect(d.text).toContain("inside one document: 1 matching passage;");
    expect(d.text).toContain("m. č. 15");
  });

  it("a § nested in the článek counts for section: čl. II", async () => {
    const r = await search({ query: "pojistný", section: "čl. II" });
    expect(listed(r.text)).toEqual([nestedId]);
  });

  it("a section-only search reaches every commentary with the §, not 6", async () => {
    const r = await search({ section: "§ 5", limit: 20 });
    expect(listed(r.text)).toEqual(expect.arrayContaining(sectionIds));
    expect(r.text).not.toMatch(/\d\+ documents/);
  });
});

describe("doc mode counts and pages every passage (files-query-4, files-tool-3, files-tool-4)", () => {
  it("71 matching passages, all reachable page by page", async () => {
    const seen = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      const r = await search({ doc: longId, query: "výklad", limit: 20, page });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("inside one document: 71 matching passages;");
      expect(r.text).toContain(`showing ${(page - 1) * 20 + 1}–${Math.min(71, page * 20)}`);
      if (page < 4) expect(r.text).toContain(`(more: page ${page + 1})`);
      for (const m of r.text.matchAll(/m\. č\. (\d+)/g)) seen.add(m[1]);
    }
    expect(seen.size).toBe(70);
  });

  it("each passage is labelled with the channels that found IT", async () => {
    // "výklad" is in every chunk, "5" in one: the others are or-fallback only, although "and"
    // hit the document (the old label named the document's channels on every passage).
    const r = await search({ doc: longId, query: "výklad 5", limit: 3 });
    const labels = [...r.text.matchAll(/^\d+\. matched: (.+)$/gm)].map((m) => m[1]);
    expect(labels[0]).toBe("and");
    expect(labels.slice(1)).toEqual(["or-fallback", "or-fallback"]);
  });

  it("the Variants line counts passages in doc mode (files-tool-8)", async () => {
    const r = await search({ doc: longId, queries: ["výklad", "číslu"], limit: 5 });
    expect(r.text).toMatch(/Variants: "výklad" 71 · "číslu" 70/);
  });
});

describe("a page past the end (files-query-9, files-query-add0, files-tool-5)", () => {
  it("says where the results end, without a fence and without loading anything", async () => {
    const r = await search({ query: "výklad", page: 50 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/page 50 is past the end: \d+ documents \(pages 1–1 at limit 10\)/);
    expect(r.text).not.toContain("⟦DOC");
    expect(scopes.some((s) => s.statements.some((q) => q.includes("doc_blocks")))).toBe(false);
    const d = await search({ doc: longId, query: "výklad", limit: 20, page: 5 });
    expect(d.text).toContain("page 5 is past the end: 71 passages (pages 1–4 at limit 20)");
  });
});

describe("act-only queries and nothing searchable (files-query-6, files-tool-1)", () => {
  it('"GDPR" searches the act: the word and passages citing the regulation by number', async () => {
    const r = await search({ query: "GDPR" });
    expect(r.isError).toBe(false);
    expect(listed(r.text)).toContain(gdprId);
  });

  it('"!!" is refused before any database work', async () => {
    const r = await search({ query: "!!" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Nothing searchable in "!!"');
    expect(channelScopes()).toEqual([]);
  });

  it("a variant with nothing to search is named and skipped", async () => {
    const r = await search({ queries: ["!!", "výklad"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('⚠ Variant "!!" has nothing to search');
  });
});

describe("ISBN / DOI in the metadata only (files-query-5)", () => {
  it("finds the book by the ISBN its text never prints, and says so", async () => {
    const r = await search({ query: "978-80-7502-274-5" });
    expect(listed(r.text)).toEqual([isbnId]);
    expect(r.text).toContain("(matched by the ISBN / DOI in its metadata)");
  });
});

describe("round trips (files-query-7, files-query-10, files-tool-2, files-tool-7)", () => {
  it("one channel statement per variant; the page loads in a fixed handful of statements", async () => {
    const r = await search({ query: "výklad", limit: 10 });
    expect(r.isError).toBe(false);
    const channels = channelScopes();
    expect(channels).toHaveLength(1);
    expect(channels[0].statements).toHaveLength(1);
    const load = scopes.find((s) => s.statements.some((q) => q.includes("doc_blocks")))!;
    // documentsByIds, loadChunks, sectionChainsMany, loadTexts, pagesAroundMany, loadFootnotesMany, documentShapes.
    expect(load.statements.length).toBeLessThanOrEqual(7);
    // Doc mode: the same, and the document row is not selected twice.
    scopes = [];
    await search({ doc: longId, query: "výklad", limit: 20 });
    const docLoad = scopes.find((s) => s.statements.some((q) => q.includes("doc_blocks")))!;
    expect(docLoad.statements.length).toBeLessThanOrEqual(6);
  });

  it("a cold guard measurement runs next to the search, a cached one not at all", async () => {
    const r = await search({ query: "výklad" });
    expect(r.isError).toBe(false);
    const guard = scopes.findIndex((s) => s.libs.length === 0);
    const channel = scopes.findIndex((s) => s.statements.some((q) => q.includes("files_search_")));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(channel).toBeGreaterThanOrEqual(0);
    scopes = [];
    await search({ query: "výklad" });
    expect(scopes.some((s) => s.libs.length === 0)).toBe(false);
  });

  it("a guard that says off wins over a search that ran next to it", async () => {
    await t.owner.query("INSERT INTO system_state (key, value) VALUES ($1, $2::jsonb)", [MODE_OVERRIDE_KEY, JSON.stringify("off")]);
    try {
      const r = await search({ query: "výklad" });
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("⟦DOC");
      // Cached off: nothing touches the database.
      scopes = [];
      expect((await search({ query: "výklad" })).isError).toBe(true);
      expect(scopes).toEqual([]);
    } finally {
      await t.owner.query("DELETE FROM system_state");
    }
  });
});

describe("batched loaders give what the single-span loaders give", () => {
  it("text, pages, footnotes and section chains, for spans across documents and shared blocks", async () => {
    setScopeRunner(t.runner);
    await withScope([LIB], async (db) => {
      const keys = [longId, retenceId, citingId].flatMap((docId) => [0, 1, 2, 5, 9].map((ord) => ({ docId, ord })));
      const chunks = await loadChunks(db, [LIB], keys);
      expect(chunks.length).toBeGreaterThan(8);
      const spans = chunks.map((c) => ({ docId: c.docId, libraryId: LIB, from: c.start, to: c.end, pageFrom: c.pageFrom, pageTo: c.pageTo }));
      const texts = await loadTexts(db, spans);
      const pages = await pagesAroundMany(db, spans);
      const notes = await loadFootnotesMany(db, spans);
      const chains = await sectionChainsMany(db, chunks.flatMap((c) => (c.sectionOrd === null ? [] : [{ docId: c.docId, libraryId: LIB, ord: c.sectionOrd }])));
      for (const [i, c] of chunks.entries()) {
        const one = await loadText(db, c.docId, LIB, c.start, c.end);
        expect(texts[i].slice(c.start, c.end)).toBe(one.slice(c.start, c.end));
        expect([texts[i].start, texts[i].end]).toEqual([one.start, one.end]);
        expect(pages[i]).toEqual(await pagesAround(db, c.docId, LIB, c.start, c.end));
        // Without the chunk's page ords every page of the document is tested: the same answer.
        expect((await pagesAroundMany(db, [{ ...spans[i], pageFrom: null, pageTo: null }]))[0]).toEqual(pages[i]);
        expect(notes[i]).toEqual(await loadFootnotes(db, c.docId, LIB, { from: c.start, to: c.end }));
        if (c.sectionOrd !== null) {
          expect(chains.get(c.docId)?.get(c.sectionOrd)).toEqual((await sectionChains(db, c.docId, LIB, [c.sectionOrd])).get(c.sectionOrd));
        }
      }
      // The paged documents' spans did carry pages (and page ords), so the bounds were exercised.
      expect(pages.some((p, i) => p.length > 0 && spans[i].pageFrom !== null)).toBe(true);
      // Unknown ids and empty ranges: empty answers, no error.
      const odd = [{ docId: "nope", libraryId: LIB, from: 0, to: 10 }, { docId: longId, libraryId: LIB, from: 5, to: 5 }];
      expect((await loadTexts(db, odd)).map((s) => s.end - s.start)).toEqual([0, 0]);
      expect(await pagesAroundMany(db, odd.slice(0, 1))).toEqual([[]]);
    });
  });
});

describe("planVariant (pure)", () => {
  const plan = (p: Record<string, unknown> = {}) =>
    ({ libraryIds: [LIB], weights: undefined, inFootnotes: undefined, docTypes: null, yearFrom: null, yearTo: null, act: null, sectionKey: null, caseKeys: [], docId: null, ...p }) as never;

  it("a pinpoint remainder ranks only passages carrying the query's § keys", () => {
    const q = planVariant(plan(), "§ 52 písm. g) ZP")!;
    expect(q.params.tsAnd).toContain("pism");
    expect(q.params.require).toEqual(expect.arrayContaining(["parz:262/2006/52", "sec:par:52"]));
    // A real word next to the § keeps the search open.
    expect(planVariant(plan(), "§ 52 písm. g) ZP výpověď")!.params.require).toEqual([]);
  });

  it("an act-only variant searches the act; an act among words demands nothing", () => {
    const gdpr = planVariant(plan(), "GDPR")!;
    expect(gdpr.params.tsAnd).toBe("'gdpr':*");
    expect(gdpr.params.identKeys).toEqual(["eu:32016R0679"]);
    const osr = planVariant(plan(), "o. s. ř.")!;
    expect(osr.params.tsAnd).toContain("soudn");
    expect(osr.params.tsAnd).not.toMatch(/'o'|'s'/);
    const withWord = planVariant(plan(), "GDPR souhlas")!;
    expect(withWord.params.identKeys).toEqual([]);
    expect(withWord.params.tsAnd).not.toContain("gdpr");
    expect(planVariant(plan(), "!!")).toBeNull();
  });

  it("with words, section is a filter only; without words its keys are the search", () => {
    const words = planVariant(plan({ sectionKey: "par:2913" }), "retence")!;
    expect(words.params.section).toBe("par:2913");
    expect(words.params.identKeys).toEqual([]);
    expect(planVariant(plan({ sectionKey: "par:2913" }), undefined)!.params.identKeys).toEqual(["sec:par:2913"]);
  });

  it("footnotes-only and case_number searches skip the meta channel; its query carries no weights", () => {
    expect(planVariant(plan({ inFootnotes: true, weights: "D" }), "náhrada")!.params.tsMeta).toBeNull();
    expect(planVariant(plan({ caseKeys: ["sz:25cdo1234-2019"] }), "náhrada")!.params.tsMeta).toBeNull();
    const abc = planVariant(plan({ inFootnotes: false, weights: "ABC" }), "náhrada")!;
    expect(abc.params.tsAnd).toMatch(/:\*ABC/);
    expect(abc.params.tsMeta).not.toMatch(/ABC/);
  });
});
