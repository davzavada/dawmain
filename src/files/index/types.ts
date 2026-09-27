/**
 * Output of src/files/index/derive.ts — what ingest writes into doc_pages /
 * doc_sections / doc_footnotes / chunks next to the stored text. Types only,
 * shared by derive (pure) and the DB layer.
 */

export type Weight = "A" | "B" | "C" | "D";

export interface DerivedChunk {
  ord: number;
  /** DMD offsets: a chunk is one contiguous span (paragraphs + their footnote definitions). */
  start: number;
  end: number;
  /** Physical page ords; null for unpaged documents. */
  pageFrom: number | null;
  pageTo: number | null;
  /** Index into ParsedDoc.sections of the enclosing section, or null. */
  section: number | null;
  anchorFrom: string | null;
  anchorTo: string | null;
  /** tsvector literal (buildTsvector) — passed as $n::tsvector. */
  tsv: string;
  identKeys: string[];
}

export interface Derived {
  chunks: DerivedChunk[];
  /** Union of chunk keys (capped) + section keys — documents.ident_keys before confirmation. */
  docIdentKeys: string[];
  /** "§ 2894–3079" for a commentary, else null. */
  sectionRange: string | null;
}
