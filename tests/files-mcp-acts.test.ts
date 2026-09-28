import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYZER_VERSION } from "@/src/files/config";
import { __setAccessLoaderForTests } from "@/src/files/access";
import type { Access, LibraryAccess } from "@/src/files/access-types";
import { setScopeRunner, withScope, type Queryable } from "@/src/files/db/client";
import { claimForIngest, finishIngest, insertUploadedDocument, writeDocumentIndex } from "@/src/files/db/documents";
import { ensureLibrary } from "@/src/files/db/libraries";
import { splitStorageBlocks } from "@/src/files/dmd/blocks";
import { normalizeDmd } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { __resetGuardsForTests } from "@/src/files/guards";
import { buildMetaTsv, deriveIndex, metaIdentKeys } from "@/src/files/index/derive";
import { queryIdentKeys } from "@/src/files/index/identifiers";
import type { BibMeta, PageLabelSource, UploadMeta } from "@/src/files/types";
import { actFilterNote, implicitAct, matchesOnlyInNotes, registerFiles, resolveActFilter } from "@/src/mcp/tools/files";
import { createTestDb, type TestDb } from "./helpers/pglite";

/**
 * files_search and acts / footnotes (mcp:MCP-6, mcp:MCP-8): the act filter
 * keeps passages citing an EU act (chunks carry eu: keys), a § of an EU act
 * in the query does not narrow the search to its commentaries, EU citations
 * are not read as Sbírka numbers, a search without hits names the act
 * filter it ran under, and in_footnotes: false leaves out passages whose
 * only match is an identifier cited inside a note. Own PGlite database.
 */

const USER = "user_x";

const PERSONAL: LibraryAccess = {
  id: USER,
  kind: "user",
  name: "Osobní",
  slug: null,
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
};
const ACCESS: Access = { userId: USER, banned: false, libraries: [PERSONAL], all: [PERSONAL] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function metaOf(docType: BibMeta["doc_type"], title: string, extra: Partial<BibMeta> = {}): BibMeta {
  return { doc_type: docType, title, authors: [], editors: [], isbn: [], keywords: [], language: "cs", ...extra };
}

let t: TestDb;

async function ingest(
  lib: string,
  dmd: string,
  meta: BibMeta,
  opts: { physicalPages: number | null; labelSource: PageLabelSource; injection?: boolean },
): Promise<string> {
  const text = normalizeDmd(dmd).text;
  const quality = { footnotes: "linked" as const, linked_ratio: 1, columns_pages: 0, headings_from: "outline", mn: 4, unsure_pages: [] };
  const uploadMeta: UploadMeta = {
    library_id: lib,
    file: { name: `${meta.title}.pdf`, bytes: text.length, sha256: sha(`file:${text}`), kind: opts.physicalPages ? "pdf" : "docx" },
    converter: "pdf@1",
    content: { sha256: sha(text), chars: text.length },
    ...(opts.physicalPages ? { pages: { physical: opts.physicalPages, label_source: opts.labelSource } } : {}),
    quality,
    hints: {},
    rights: "vlastni",
    doc_type_hint: meta.doc_type,
  };
  const scoped = <T>(fn: (db: Queryable) => Promise<T>) => withScope([lib], fn);
  const inserted = await scoped((db) =>
    insertUploadedDocument(db, {
      libraryId: lib,
      uploadedBy: USER,
      meta: uploadMeta,
      contentSha256: sha(text),
      charCount: text.length,
      billablePages: 1,
      physicalPages: opts.physicalPages,
      pendingGz: gzipSync(Buffer.from(text, "utf8")),
      quality,
      hints: {},
      injectionFlag: opts.injection ?? false,
    }),
  );
  if (!("id" in inserted)) throw new Error("unexpected duplicate");
  const id = inserted.id;
  const claim = await scoped((db) => claimForIngest(db, id, lib));
  if (!claim) throw new Error("claim failed");
  const stored = normalizeDmd(gunzipSync(claim.pendingGz).toString("utf8")).text;
  const parsed = parseDmd(stored);
  const derived = deriveIndex(parsed, { docType: meta.doc_type, commentedAct: meta.commented_act ?? null });
  await scoped(async (db) => {
    if (!(await writeDocumentIndex(db, { id, libraryId: lib, runToken: claim.runToken, text: stored, blocks: splitStorageBlocks(stored, 2_000), parsed, derived, analyzerVersion: ANALYZER_VERSION }))) {
      throw new Error("lease lost");
    }
    const ok = await finishIngest(db, {
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
    if (!ok) throw new Error("finish failed");
  });
  await t.owner.query("UPDATE documents SET page_label_source = $2 WHERE id = $1", [id, opts.labelSource]);
  return id;
}

// ---------------------------------------------------------------------------
// Fixtures

/** A book whose only citation of 25 Cdo 1234/2019 sits in a note. */
const NOTE_ONLY = `[s. 1]

# Kapitola 1 Promlčení

Odstavec o promlčení nároku na plnění z pojistné smlouvy.[^1]

[^1]: Srov. rozsudek Nejvyššího soudu ze dne 1. 1. 2020, sp. zn. 25 Cdo 1234/2019.
`;

/** A book citing the same decision in its body. */
const BODY_CITE = `[s. 1]

# Kapitola 1 Náhrada škody

Nejvyšší soud v rozsudku sp. zn. 25 Cdo 1234/2019 vyložil rozsah náhrady škody.
`;

/** A book citing GDPR by name (no commentary). */
const GDPR_BOOK = `[s. 1]

# Kapitola 1 Ochrana údajů

Zpracování podle čl. 6 odst. 1 písm. f) GDPR vyžaduje oprávněný zájem správce a test proporcionality.
`;

/** A book on the same topic that cites no act at all. */
const PLAIN_BOOK = `[s. 1]

# Kapitola 1 Zájmy

Podle čl. 6 nařízení je zpracování zákonné, pokud převáží oprávněný zájem správce nad zájmy subjektu.
`;

const GDPR_COMMENTARY = `[s. 1]

# Obecné nařízení o ochraně osobních údajů

## Článek 6 [Zákonnost zpracování]

[m. č. 1] Oprávněný zájem správce je jedním z právních titulů zpracování.
`;

let noteOnlyId: string;
let bodyCiteId: string;
let gdprBookId: string;
let plainBookId: string;
let gdprCommentaryId: string;

const ENV = { ...process.env };
const loader = vi.fn(async (_userId: string): Promise<Access> => ACCESS);

beforeAll(async () => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  t = await createTestDb();
  setScopeRunner(t.runner);
  await withScope([USER], (db) => ensureLibrary(db, USER, USER));
  noteOnlyId = await ingest(USER, NOTE_ONLY, metaOf("kniha", "Promlčení"), { physicalPages: 1, labelSource: "printed" });
  bodyCiteId = await ingest(USER, BODY_CITE, metaOf("kniha", "Náhrada škody"), { physicalPages: 1, labelSource: "printed" });
  gdprBookId = await ingest(USER, GDPR_BOOK, metaOf("kniha", "Ochrana údajů"), { physicalPages: 1, labelSource: "printed" });
  plainBookId = await ingest(USER, PLAIN_BOOK, metaOf("kniha", "Zájmy"), { physicalPages: 1, labelSource: "printed" });
  gdprCommentaryId = await ingest(USER, GDPR_COMMENTARY, metaOf("komentar", "GDPR. Komentář", { commented_act: "eu:32016R0679" }), {
    physicalPages: 1,
    labelSource: "printed",
  });
}, 120_000);

afterAll(async () => {
  setScopeRunner(null);
  __setAccessLoaderForTests(null);
  process.env = { ...ENV };
  await t?.close();
});

beforeEach(() => {
  process.env.FILES_DATABASE_URL = "postgres://test";
  process.env.FILES_MODE = "on";
  __resetGuardsForTests();
  loader.mockReset();
  loader.mockImplementation(async () => ACCESS);
  __setAccessLoaderForTests(loader);
  setScopeRunner(t.runner);
});

// ---------------------------------------------------------------------------
// Harness

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;

const tools: Record<string, { handler: Handler; config: Record<string, unknown> }> = {};
registerFiles({
  registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
    tools[name] = { handler, config };
  },
} as never);

const USER_CTX = { http: { authInfo: { token: "t", clientId: "c", scopes: [], extra: { userId: USER } } } };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const schema = tools[name].config.inputSchema as { parse: (v: unknown) => Record<string, unknown> };
  const result = await tools[name].handler(schema.parse(args), USER_CTX);
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

const ids = (text: string) => [...text.matchAll(/id ([0-9a-f-]{36})/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------

describe("resolveActFilter reads EU citations as EU acts (MCP-6)", () => {
  it("known regulations by bare number, (EU)/(ES) citations and directives; no Sbírka number reaches 1000", () => {
    expect(resolveActFilter("1215/2012")?.act).toBe("eu:32012R1215");
    expect(resolveActFilter("2016/679")?.act).toBe("eu:32016R0679");
    expect(resolveActFilter("nařízení (EU) 2016/679")?.act).toBe("eu:32016R0679");
    expect(resolveActFilter("(ES) č. 44/2001")?.act).toBe("eu:32001R0044");
    expect(resolveActFilter("93/13/EHS")?.act).toBe("eu:31993L0013");
    expect(resolveActFilter("1500/2012")).toBeNull();
    expect(resolveActFilter("2016/1234")).toBeNull();
    // Czech acts as before; an explicit "Sb." or "zákon" is always Sbírka.
    expect(resolveActFilter("89/2012")?.act).toBe("zak:89/2012");
    expect(resolveActFilter("zákon č. 89/2012 Sb.")?.act).toBe("zak:89/2012");
    expect(resolveActFilter("OZ")?.act).toBe("zak:89/2012");
    expect(resolveActFilter("GDPR")?.act).toBe("eu:32016R0679");
  });

  it("the query's act filters only with a § of a Czech act", () => {
    expect(implicitAct(queryIdentKeys("§ 2913 OZ"))).toBe("zak:89/2012");
    expect(implicitAct(queryIdentKeys("čl. 6 GDPR"))).toBeNull();
    expect(implicitAct(queryIdentKeys("OZ náhrada škody"))).toBeNull();
  });

  it("the no-hit note names the act filter, explicit or from the query", () => {
    expect(actFilterNote({ act: "zak:89/2012", name: "občanský zákoník" }, [])).toMatch(/^Filtered by act zak:89\/2012 \(občanský zákoník\)/);
    expect(actFilterNote(null, ["§ 2913 OZ ananas"])).toMatch(/commentaries on zak:89\/2012 \(občanský zákoník\) and passages citing that §/);
    expect(actFilterNote(null, ["čl. 6 GDPR", "ananas"])).toBeNull();
  });
});

describe("files_search and EU acts (MCP-6)", () => {
  it("act: GDPR keeps the commentary and a book citing GDPR, not a book citing no act", async () => {
    const r = await call("files_search", { query: "oprávněný zájem", act: "GDPR" });
    expect(r.isError).toBe(false);
    const found = ids(r.text);
    expect(found).toContain(gdprCommentaryId);
    expect(found).toContain(gdprBookId);
    expect(found).not.toContain(plainBookId);
  });

  it("\"čl. 6 GDPR\" in the query does not narrow the search to GDPR commentaries", async () => {
    const r = await call("files_search", { query: "čl. 6 GDPR oprávněný zájem" });
    const found = ids(r.text);
    expect(found).toContain(plainBookId);
    expect(found).toContain(gdprCommentaryId);
  });

  it("a search without hits names the act filter it ran under", async () => {
    const explicit = await call("files_search", { query: "ananasová doložka", act: "OZ" });
    expect(explicit.text).toMatch(/No match in Vlastní zdroje/);
    expect(explicit.text).toMatch(/Filtered by act zak:89\/2012 \(občanský zákoník\)/);
    const implied = await call("files_search", { query: "§ 2913 OZ ananasová doložka" });
    expect(implied.text).toMatch(/No match in Vlastní zdroje/);
    expect(implied.text).toMatch(/limited the search to commentaries on zak:89\/2012/);
    const none = await call("files_search", { query: "ananasová doložka" });
    expect(none.text).not.toMatch(/Filtered by act|limited the search/);
  });
});

describe("in_footnotes: false and identifiers cited in a note (MCP-8)", () => {
  it("pure: every match inside a definition → left out; a body match or no visible match → kept", () => {
    const raw = "Text o promlčení.[^1]\n\n[^1]: Srov. 25 Cdo 1234/2019.";
    const defStart = raw.indexOf("[^1]:");
    const q = { terms: [], identKeys: ["sz:25cdo1234-2019"] };
    expect(matchesOnlyInNotes(raw, 100, q, [{ defStart: 100 + defStart, defEnd: 100 + raw.length }])).toBe(true);
    expect(matchesOnlyInNotes(raw, 100, q, [])).toBe(false);
    expect(matchesOnlyInNotes("25 Cdo 1234/2019 v textu.", 0, q, [{ defStart: 50, defEnd: 60 }])).toBe(false);
    expect(matchesOnlyInNotes("Nic tu není.", 0, q, [{ defStart: 0, defEnd: 12 }])).toBe(false);
  });

  it("case_number with in_footnotes: false leaves out the book citing it only in a note", async () => {
    const both = await call("files_search", { case_number: "25 Cdo 1234/2019" });
    expect(ids(both.text)).toEqual(expect.arrayContaining([noteOnlyId, bodyCiteId]));

    const body = await call("files_search", { case_number: "25 Cdo 1234/2019", in_footnotes: false });
    expect(body.isError).toBe(false);
    expect(ids(body.text)).toContain(bodyCiteId);
    expect(ids(body.text)).not.toContain(noteOnlyId);
    expect(body.text).toMatch(/1 passage matched only inside a footnote and was left out/);
    expect(body.text).toMatch(/✓ Vlastní zdroje: 1 document/);

    const notes = await call("files_search", { case_number: "25 Cdo 1234/2019", in_footnotes: true });
    expect(ids(notes.text)).toContain(noteOnlyId);
  });
});
