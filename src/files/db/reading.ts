import "server-only";
import type { RenderFootnote, SectionKind, TextSource } from "../dmd/types";
import type { Queryable } from "./client";
import { inflateText, num, numOrNull } from "./codec";
import { documentColumns, getDocument, isUuid, mapDocumentRow, type DocumentRow } from "./documents";

/**
 * Reading a stored document: its page and section tables (small — offsets
 * only), then just the text blocks a window needs, inflated in the app.
 * Everything returned here is document-derived and untrusted: the MCP tool
 * renders it inside the per-response fence.
 *
 * These functions do not look at status or `enabled`: the web detail view
 * shows documents under review, while files_get_document must check
 * `row.status === "ready"` itself.
 */

export type { TextSource, RenderFootnote };

export interface ReadDoc {
  row: DocumentRow;
  pages: Array<{ ord: number; label: string; start: number; end: number; flags: number }>;
  sections: Array<{
    ord: number;
    parent: number | null;
    level: number;
    kind: SectionKind;
    key: string | null;
    keyNum: number | null;
    heading: string;
    author: string | null;
    start: number;
    end: number;
    pageFrom: number | null;
    pageTo: number | null;
    indexed: boolean;
  }>;
  /** Length of the stored DMD (end of the last block; 0 before ingest wrote it). */
  textLength: number;
}

/** The document (in one of `libraryIds`) with its pages and sections, or null. */
export async function loadReadDoc(db: Queryable, id: string, libraryIds: string[]): Promise<ReadDoc | null> {
  const row = await getDocument(db, id, libraryIds);
  if (!row) return null;
  const lib = row.library_id;
  const pages = await db.query(
    `SELECT ord, label, char_start, char_end, flags FROM doc_pages
      WHERE doc_id = $1 AND library_id = $2 ORDER BY ord`,
    [row.id, lib],
  );
  const sections = await db.query(
    `SELECT ord, parent_ord, level, kind, key, key_num, heading, author, char_start, char_end, page_from, page_to, indexed
       FROM doc_sections WHERE doc_id = $1 AND library_id = $2 ORDER BY ord`,
    [row.id, lib],
  );
  const length = await db.query(
    "SELECT coalesce(max(char_end), 0) AS n FROM doc_blocks WHERE doc_id = $1 AND library_id = $2",
    [row.id, lib],
  );
  return {
    row,
    pages: pages.rows.map((p) => ({
      ord: num(p.ord),
      label: String(p.label),
      start: num(p.char_start),
      end: num(p.char_end),
      flags: num(p.flags),
    })),
    sections: sections.rows.map((s) => ({
      ord: num(s.ord),
      parent: numOrNull(s.parent_ord),
      level: num(s.level),
      kind: s.kind as SectionKind,
      key: (s.key as string | null) ?? null,
      keyNum: numOrNull(s.key_num),
      heading: String(s.heading),
      author: (s.author as string | null) ?? null,
      start: num(s.char_start),
      end: num(s.char_end),
      pageFrom: numOrNull(s.page_from),
      pageTo: numOrNull(s.page_to),
      indexed: s.indexed !== false,
    })),
    textLength: num(length.rows[0]?.n),
  };
}

/**
 * Load only the storage blocks overlapping [from, to) and return them as a
 * TextSource. Its start/end are the loaded span — block-aligned, so usually
 * wider than requested; slice() clamps to that span (a request outside it
 * yields ""). An empty or inverted range, a foreign document or one without
 * stored text gives an empty source. Throws when the stored blocks are
 * inconsistent (a gap, or a block whose inflated length differs from its
 * offsets) — better than rendering text at wrong offsets.
 */
export async function loadText(db: Queryable, id: string, libraryId: string, from: number, to: number): Promise<TextSource> {
  const lo = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
  const hi = Number.isFinite(to) ? Math.floor(to) : lo;
  if (!isUuid(id) || !(hi > lo)) return emptySource(lo);
  const { rows } = await db.query(
    `SELECT ord, char_start, char_end, body FROM doc_blocks
      WHERE doc_id = $1 AND library_id = $2 AND char_end > $3 AND char_start < $4
      ORDER BY ord`,
    [id, libraryId, lo, hi],
  );
  if (rows.length === 0) return emptySource(lo);
  const start = num(rows[0].char_start);
  let at = start;
  const parts: string[] = [];
  for (const r of rows) {
    const s = num(r.char_start);
    const e = num(r.char_end);
    if (s !== at) throw new Error("stored text is incomplete (gap between blocks)");
    const text = inflateText(r.body as Uint8Array);
    if (text.length !== e - s) throw new Error("stored text block does not match its offsets");
    parts.push(text);
    at = e;
  }
  return textSource(start, parts.join(""));
}

/** A TextSource over `text` placed at absolute offset `start`. Pure (exported for tests and callers with text in hand). */
export function textSource(start: number, text: string): TextSource {
  const end = start + text.length;
  return {
    start,
    end,
    slice(a: number, b: number): string {
      const x = Math.max(start, Math.min(end, a));
      const y = Math.max(x, Math.min(end, b));
      return text.slice(x - start, y - start);
    },
  };
}

function emptySource(at: number): TextSource {
  return textSource(at, "");
}

export type LoadedFootnote = RenderFootnote & { page: number | null; sectionOrd: number | null; anchor: string | null };

/**
 * Footnotes of the document, in seq order, as the renderer needs them, plus
 * the reference's page, section and anchor. `range` keeps those whose
 * definition overlaps [from, to) or whose reference lies inside it (so a
 * window can append definitions printed after its end); `labels` keeps only
 * those labels. pageLabel is the printed label of the page the note is
 * printed on: its reference's page (page_ord — a definition follows the
 * paragraph citing it, which may run onto the next page), the definition's
 * own page for an endnote or a note without a paged reference.
 */
export async function loadFootnotes(
  db: Queryable,
  id: string,
  libraryId: string,
  range: { from: number; to: number } | null,
  labels?: string[],
): Promise<LoadedFootnote[]> {
  if (!isUuid(id)) return [];
  const params: unknown[] = [id, libraryId];
  const where = ["f.doc_id = $1", "f.library_id = $2"];
  if (range) {
    params.push(Math.floor(range.from), Math.floor(range.to));
    where.push("((f.def_start < $4 AND f.def_end > $3) OR (f.ref_at >= $3 AND f.ref_at < $4))");
  }
  if (labels) {
    params.push(labels.filter((l) => typeof l === "string"));
    where.push(`f.label = ANY($${params.length}::text[])`);
  }
  const { rows } = await db.query(
    `SELECT f.seq, f.label, f.kind, f.ref_at, f.def_start, f.def_end, f.page_ord, f.section_ord, f.anchor,
            coalesce(pr.label, pd.label) AS page_label
       FROM doc_footnotes f
       LEFT JOIN doc_pages pr
         ON pr.doc_id = f.doc_id AND pr.library_id = f.library_id AND pr.ord = f.page_ord AND f.kind <> 'e'
       LEFT JOIN LATERAL (
         SELECT label FROM doc_pages p
          WHERE (f.kind = 'e' OR f.page_ord IS NULL)
            AND p.doc_id = f.doc_id AND p.library_id = f.library_id AND p.char_start <= f.def_start
          ORDER BY p.char_start DESC LIMIT 1
       ) pd ON true
      WHERE ${where.join(" AND ")}
      ORDER BY f.seq`,
    params,
  );
  return rows.map((r) => ({
    seq: num(r.seq),
    label: String(r.label),
    kind: r.kind === "e" ? "e" : "f",
    refAt: numOrNull(r.ref_at),
    defStart: num(r.def_start),
    defEnd: num(r.def_end),
    pageLabel: (r.page_label as string | null) ?? null,
    page: numOrNull(r.page_ord),
    sectionOrd: numOrNull(r.section_ord),
    anchor: (r.anchor as string | null) ?? null,
  }));
}

/** A section as search hits and read windows need it (offsets and pages only). */
export interface SectionLite {
  ord: number;
  parent: number | null;
  level: number;
  kind: SectionKind;
  key: string | null;
  heading: string;
  author: string | null;
  start: number;
  end: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface PageLite {
  ord: number;
  label: string;
  start: number;
  end: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// Lookups for search hits and read windows (explicit library filter on top of RLS)

/** Document rows by id, only those in `libraryIds`. */
export async function documentsByIds(db: Queryable, ids: string[], libraryIds: string[]): Promise<Map<string, DocumentRow>> {
  const valid = ids.filter(isUuid);
  if (!valid.length || !libraryIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT ${documentColumns("d")} FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.library_id = ANY($2::text[])`,
    [valid, libraryIds],
  );
  const out = new Map<string, DocumentRow>();
  for (const r of rows) {
    const row = mapDocumentRow(r);
    out.set(row.id, row);
  }
  return out;
}

/** Library of each document id (light: for the "in K libraries" count). */
export async function librariesOf(db: Queryable, ids: string[], libraryIds: string[]): Promise<Map<string, string>> {
  const valid = ids.filter(isUuid);
  if (!valid.length) return new Map();
  const { rows } = await db.query(
    "SELECT id, library_id FROM documents WHERE id = ANY($1::uuid[]) AND library_id = ANY($2::text[])",
    [valid, libraryIds],
  );
  return new Map(rows.map((r) => [String(r.id), String(r.library_id)]));
}

/** What a hint needs to address a read window: the stored text length and whether there are pages / an outline. */
export interface DocumentShape {
  textLength: number;
  paged: boolean;
  outlined: boolean;
}

/** DocumentShape of each document id, only those in `libraryIds`. */
export async function documentShapes(db: Queryable, ids: string[], libraryIds: string[]): Promise<Map<string, DocumentShape>> {
  const valid = ids.filter(isUuid);
  if (!valid.length || !libraryIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT d.id,
            (SELECT coalesce(max(b.char_end), 0) FROM doc_blocks b WHERE b.doc_id = d.id AND b.library_id = d.library_id) AS text_length,
            EXISTS (SELECT 1 FROM doc_pages p WHERE p.doc_id = d.id AND p.library_id = d.library_id) AS paged,
            EXISTS (SELECT 1 FROM doc_sections s WHERE s.doc_id = d.id AND s.library_id = d.library_id) AS outlined
       FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.library_id = ANY($2::text[])`,
    [valid, libraryIds],
  );
  return new Map(rows.map((r) => [String(r.id), { textLength: num(r.text_length), paged: r.paged === true, outlined: r.outlined === true }]));
}

/** Root-to-leaf section chains of the given section ords of one document. */
export async function sectionChains(db: Queryable, docId: string, libraryId: string, ords: number[]): Promise<Map<number, SectionLite[]>> {
  const wanted = [...new Set(ords.filter((o) => Number.isInteger(o) && o >= 0))];
  const out = new Map<number, SectionLite[]>();
  if (!wanted.length) return out;
  const { rows } = await db.query(
    `WITH RECURSIVE up AS (
       SELECT s.ord AS leaf, s.ord, s.parent_ord, 0 AS depth
         FROM doc_sections s WHERE s.doc_id = $1 AND s.library_id = $2 AND s.ord = ANY($3::int[])
       UNION ALL
       SELECT up.leaf, p.ord, p.parent_ord, up.depth + 1
         FROM up JOIN doc_sections p ON p.doc_id = $1 AND p.library_id = $2 AND p.ord = up.parent_ord
        WHERE up.depth < 32
     )
     SELECT up.leaf, up.depth, s.ord, s.parent_ord, s.level, s.kind, s.key, s.heading, s.author,
            s.char_start, s.char_end, s.page_from, s.page_to
       FROM up JOIN doc_sections s ON s.doc_id = $1 AND s.library_id = $2 AND s.ord = up.ord
      ORDER BY up.leaf, up.depth DESC`,
    [docId, libraryId, wanted],
  );
  for (const r of rows) {
    const leaf = Number(r.leaf);
    const list = out.get(leaf) ?? [];
    list.push({
      ord: Number(r.ord),
      parent: r.parent_ord === null ? null : Number(r.parent_ord),
      level: Number(r.level),
      kind: r.kind as SectionKind,
      key: (r.key as string | null) ?? null,
      heading: String(r.heading),
      author: (r.author as string | null) ?? null,
      start: Number(r.char_start),
      end: Number(r.char_end),
      pageFrom: r.page_from === null ? null : Number(r.page_from),
      pageTo: r.page_to === null ? null : Number(r.page_to),
    });
    out.set(leaf, list);
  }
  return out;
}

/** Pages overlapping [from, to] of one document. */
export async function pagesAround(db: Queryable, docId: string, libraryId: string, from: number, to: number): Promise<PageLite[]> {
  const { rows } = await db.query(
    `SELECT ord, label, char_start, char_end, flags FROM doc_pages
      WHERE doc_id = $1 AND library_id = $2 AND char_end > $3 AND char_start <= $4 ORDER BY ord`,
    [docId, libraryId, from, to],
  );
  return rows.map((r) => ({ ord: Number(r.ord), label: String(r.label), start: Number(r.char_start), end: Number(r.char_end), flags: Number(r.flags) }));
}

// ---------------------------------------------------------------------------
// Batched lookups for a page of search hits: one statement per kind, however
// many passages the page shows (node-postgres sends one statement per round
// trip; a page of 10 documents × 2 passages ran ~73 of them one by one).
// Each returns, per requested span, exactly what the single-span function
// above returns for it.

/** One passage of a search hit: its document, library and [from, to) span; its page ords when known. */
export interface HitSpan {
  docId: string;
  libraryId: string;
  from: number;
  to: number;
  /** The chunk's first / last page ord (chunks.page_from / page_to); null: unknown, test every page. */
  pageFrom?: number | null;
  pageTo?: number | null;
}

function bounds(s: HitSpan): { lo: number; hi: number } {
  const lo = Number.isFinite(s.from) ? Math.max(0, Math.floor(s.from)) : 0;
  const hi = Number.isFinite(s.to) ? Math.floor(s.to) : lo;
  return { lo, hi };
}

/**
 * loadText for every span in ONE statement. A storage block shared by two
 * spans is fetched and inflated once. The same checks as loadText, per
 * span: an empty source for an invalid id, an empty range or no blocks, and
 * an error for a gap between blocks or a block whose inflated length
 * differs from its offsets.
 */
export async function loadTexts(db: Queryable, spans: readonly HitSpan[]): Promise<TextSource[]> {
  const asked = spans.map((s) => ({ ...bounds(s), doc: s.docId.toLowerCase(), lib: s.libraryId, ok: isUuid(s.docId) }));
  const live = asked.filter((a) => a.ok && a.hi > a.lo);
  const byDoc = new Map<string, Array<{ ord: number; start: number; end: number; body: Uint8Array }>>();
  if (live.length) {
    const { rows } = await db.query(
      `SELECT b.doc_id, b.ord, b.char_start, b.char_end, b.body FROM doc_blocks b
        WHERE b.doc_id = ANY($1::uuid[]) AND b.library_id = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[]) r(doc, lib, lo, hi)
                       WHERE r.doc = b.doc_id AND r.lib = b.library_id AND b.char_end > r.lo AND b.char_start < r.hi)
        ORDER BY b.doc_id, b.ord`,
      [live.map((a) => a.doc), live.map((a) => a.lib), live.map((a) => a.lo), live.map((a) => a.hi)],
    );
    for (const r of rows) {
      const doc = String(r.doc_id);
      const list = byDoc.get(doc) ?? [];
      list.push({ ord: num(r.ord), start: num(r.char_start), end: num(r.char_end), body: r.body as Uint8Array });
      byDoc.set(doc, list);
    }
  }
  const inflated = new Map<string, string>();
  return asked.map((a) => {
    if (!a.ok || !(a.hi > a.lo)) return emptySource(a.lo);
    const blocks = (byDoc.get(a.doc) ?? []).filter((b) => b.end > a.lo && b.start < a.hi);
    if (blocks.length === 0) return emptySource(a.lo);
    let at = blocks[0].start;
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.start !== at) throw new Error("stored text is incomplete (gap between blocks)");
      const key = `${a.doc}:${b.ord}`;
      let text = inflated.get(key);
      if (text === undefined) {
        text = inflateText(b.body);
        inflated.set(key, text);
      }
      if (text.length !== b.end - b.start) throw new Error("stored text block does not match its offsets");
      parts.push(text);
      at = b.end;
    }
    return textSource(blocks[0].start, parts.join(""));
  });
}

/**
 * pagesAround for every span in ONE statement. A span with its chunk's page
 * ords reads only pages page_from … page_to + 1 by the primary key (the page
 * starting exactly at the span's end is the one after page_to — no page is
 * empty, each starts at its own marker line, so no second page can start
 * there); without them, every page of the document is tested, as
 * pagesAround does. The ord bounds are always sent (the whole int range
 * when unknown), so they stay an index condition on the primary key — an
 * `IS NULL OR …` would leave them a filter and walk every page of the
 * document for each span.
 */
export async function pagesAroundMany(db: Queryable, spans: readonly HitSpan[]): Promise<PageLite[][]> {
  const out: PageLite[][] = spans.map(() => []);
  const live = spans.map((s, i) => ({ s, i })).filter(({ s }) => isUuid(s.docId));
  if (!live.length) return out;
  const ord = (v: number | null | undefined) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const INT_MIN = -2_147_483_648;
  const INT_MAX = 2_147_483_647;
  const pageBounds = (s: HitSpan): [number, number] => {
    const from = ord(s.pageFrom);
    const to = ord(s.pageTo);
    return from !== null && to !== null ? [Math.max(INT_MIN, from), Math.min(INT_MAX, to + 1)] : [INT_MIN, INT_MAX];
  };
  const { rows } = await db.query(
    `SELECT r.n, p.ord, p.label, p.char_start, p.char_end, p.flags
       FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[], $5::int[], $6::int[]) WITH ORDINALITY AS r(doc, lib, lo, hi, pf, pt, n)
       JOIN doc_pages p ON p.doc_id = r.doc AND p.library_id = r.lib
        AND p.ord BETWEEN r.pf AND r.pt
        AND p.char_end > r.lo AND p.char_start <= r.hi
      ORDER BY r.n, p.ord`,
    [
      live.map(({ s }) => s.docId.toLowerCase()),
      live.map(({ s }) => s.libraryId),
      live.map(({ s }) => s.from),
      live.map(({ s }) => s.to),
      live.map(({ s }) => pageBounds(s)[0]),
      live.map(({ s }) => pageBounds(s)[1]),
    ],
  );
  for (const r of rows) {
    out[live[num(r.n) - 1].i].push({ ord: Number(r.ord), label: String(r.label), start: Number(r.char_start), end: Number(r.char_end), flags: Number(r.flags) });
  }
  return out;
}

/**
 * loadFootnotes(…, { from, to }) for every span in ONE statement: each
 * document's notes are walked once (not once per passage — offsets have no
 * index, and a commentary has thousands of notes), then handed to every
 * span they belong to by the same test.
 */
export async function loadFootnotesMany(db: Queryable, spans: readonly HitSpan[]): Promise<LoadedFootnote[][]> {
  const out: LoadedFootnote[][] = spans.map(() => []);
  const live = spans
    .map((s, i) => ({ doc: s.docId.toLowerCase(), lib: s.libraryId, lo: Math.floor(s.from), hi: Math.floor(s.to), i, ok: isUuid(s.docId) }))
    .filter((a) => a.ok && Number.isFinite(a.lo) && Number.isFinite(a.hi));
  if (!live.length) return out;
  const { rows } = await db.query(
    `SELECT f.doc_id, f.library_id, f.seq, f.label, f.kind, f.ref_at, f.def_start, f.def_end, f.page_ord, f.section_ord, f.anchor,
            coalesce(pr.label, pd.label) AS page_label
       FROM doc_footnotes f
       LEFT JOIN doc_pages pr
         ON pr.doc_id = f.doc_id AND pr.library_id = f.library_id AND pr.ord = f.page_ord AND f.kind <> 'e'
       LEFT JOIN LATERAL (
         SELECT label FROM doc_pages p
          WHERE (f.kind = 'e' OR f.page_ord IS NULL)
            AND p.doc_id = f.doc_id AND p.library_id = f.library_id AND p.char_start <= f.def_start
          ORDER BY p.char_start DESC LIMIT 1
       ) pd ON true
      WHERE f.doc_id = ANY($1::uuid[]) AND f.library_id = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[]) r(doc, lib, lo, hi)
                     WHERE r.doc = f.doc_id AND r.lib = f.library_id
                       AND ((f.def_start < r.hi AND f.def_end > r.lo) OR (f.ref_at >= r.lo AND f.ref_at < r.hi)))
      ORDER BY f.doc_id, f.seq`,
    [live.map((a) => a.doc), live.map((a) => a.lib), live.map((a) => a.lo), live.map((a) => a.hi)],
  );
  for (const r of rows) {
    const note: LoadedFootnote = {
      seq: num(r.seq),
      label: String(r.label),
      kind: r.kind === "e" ? "e" : "f",
      refAt: numOrNull(r.ref_at),
      defStart: num(r.def_start),
      defEnd: num(r.def_end),
      pageLabel: (r.page_label as string | null) ?? null,
      page: numOrNull(r.page_ord),
      sectionOrd: numOrNull(r.section_ord),
      anchor: (r.anchor as string | null) ?? null,
    };
    const doc = String(r.doc_id);
    const lib = String(r.library_id);
    for (const a of live) {
      if (a.doc !== doc || a.lib !== lib) continue;
      const def = note.defStart < a.hi && note.defEnd > a.lo;
      const ref = note.refAt !== null && note.refAt >= a.lo && note.refAt < a.hi;
      if (def || ref) out[a.i].push({ ...note });
    }
  }
  return out;
}

/** sectionChains for sections of several documents in ONE statement: docId → leaf ord → root-to-leaf chain. */
export async function sectionChainsMany(
  db: Queryable,
  leaves: ReadonlyArray<{ docId: string; libraryId: string; ord: number }>,
): Promise<Map<string, Map<number, SectionLite[]>>> {
  const out = new Map<string, Map<number, SectionLite[]>>();
  const seen = new Set<string>();
  const wanted = leaves.filter((l) => {
    if (!isUuid(l.docId) || !Number.isInteger(l.ord) || l.ord < 0) return false;
    const key = `${l.docId.toLowerCase()}:${l.libraryId}:${l.ord}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!wanted.length) return out;
  const { rows } = await db.query(
    `WITH RECURSIVE up AS (
       SELECT r.doc, r.lib, s.ord AS leaf, s.ord, s.parent_ord, 0 AS depth
         FROM unnest($1::uuid[], $2::text[], $3::int[]) r(doc, lib, ord)
         JOIN doc_sections s ON s.doc_id = r.doc AND s.library_id = r.lib AND s.ord = r.ord
       UNION ALL
       SELECT up.doc, up.lib, up.leaf, p.ord, p.parent_ord, up.depth + 1
         FROM up JOIN doc_sections p ON p.doc_id = up.doc AND p.library_id = up.lib AND p.ord = up.parent_ord
        WHERE up.depth < 32
     )
     SELECT up.doc, up.leaf, up.depth, s.ord, s.parent_ord, s.level, s.kind, s.key, s.heading, s.author,
            s.char_start, s.char_end, s.page_from, s.page_to
       FROM up JOIN doc_sections s ON s.doc_id = up.doc AND s.library_id = up.lib AND s.ord = up.ord
      ORDER BY up.doc, up.leaf, up.depth DESC`,
    [wanted.map((l) => l.docId.toLowerCase()), wanted.map((l) => l.libraryId), wanted.map((l) => l.ord)],
  );
  for (const r of rows) {
    const doc = String(r.doc);
    const leaf = Number(r.leaf);
    const chains = out.get(doc) ?? new Map<number, SectionLite[]>();
    const list = chains.get(leaf) ?? [];
    list.push({
      ord: Number(r.ord),
      parent: r.parent_ord === null ? null : Number(r.parent_ord),
      level: Number(r.level),
      kind: r.kind as SectionKind,
      key: (r.key as string | null) ?? null,
      heading: String(r.heading),
      author: (r.author as string | null) ?? null,
      start: Number(r.char_start),
      end: Number(r.char_end),
      pageFrom: r.page_from === null ? null : Number(r.page_from),
      pageTo: r.page_to === null ? null : Number(r.page_to),
    });
    chains.set(leaf, list);
    out.set(doc, chains);
  }
  return out;
}
