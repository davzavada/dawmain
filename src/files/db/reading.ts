import "server-only";
import type { RenderFootnote, SectionKind, TextSource } from "../dmd/types";
import type { Queryable } from "./client";
import { inflateText, num, numOrNull } from "./codec";
import { getDocument, isUuid, type DocumentRow } from "./documents";

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
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.floor(to);
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
 * those labels. pageLabel is the printed label of the page the DEFINITION
 * sits on.
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
    `SELECT f.seq, f.label, f.kind, f.ref_at, f.def_start, f.def_end, f.page_ord, f.section_ord, f.anchor, p.label AS page_label
       FROM doc_footnotes f
       LEFT JOIN LATERAL (
         SELECT label FROM doc_pages p
          WHERE p.doc_id = f.doc_id AND p.library_id = f.library_id AND p.char_start <= f.def_start
          ORDER BY p.char_start DESC LIMIT 1
       ) p ON true
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
