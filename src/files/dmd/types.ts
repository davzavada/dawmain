/**
 * DMD — "Dawmain Markdown" — is the ONE canonical form of an uploaded
 * document. The browser converts PDF/DOCX/TXT into it; the server stores it
 * and re-derives everything (pages, sections, footnotes, chunks, index) from
 * it with the same pure parser (src/files/dmd/parse.ts). Structure lives in
 * the text, never in a side channel, so the two can never disagree and the
 * index can be rebuilt without the original file (which is never kept).
 *
 * Grammar (line-based; blocks are separated by blank lines):
 *
 *   [s. 245]                 page start — a line of its own; label = printed page
 *   … text [s. 246] text …   page break inside a paragraph that runs on
 *   ## § 2913 [Porušení…]    heading, 1–6 "#", ≤ 300 chars
 *   [m. č. 14] Text…         paragraph with a marginal number (document's anchor_label)
 *   …škody[^12] a…           footnote reference — label 1–4 digits, a–z{1,4}, *{1,3}, †{1,2}
 *   [^12]: Text poznámky     footnote definition — right after the block citing it;
 *       continuation…        continuation lines are indented by 4 spaces
 *   > (1) Poruší-li…         quotation / wording of a provision
 *   | a | b |                table row (DOCX only)
 *   [●] [____] ☐ ☒           template placeholders (vzory)
 *
 * Escapes: `\[s. `, `\[^`, `\[m. č. ` and a leading `\#`, `\>`, `\|` are text.
 * Text is NFC, `\n` line ends, with no C0/C1 controls (except \n), bidi or
 * zero-width characters. Offsets everywhere are JS UTF-16 indices into the
 * normalized text.
 */

import type { AnchorLabel } from "../types";

export const PAGE_LABEL_RE = /^[\p{L}\p{N}.\-–]{1,12}$/u;
export const FOOTNOTE_LABEL_SOURCE = String.raw`\d{1,4}|[a-z]{1,4}|\*{1,3}|†{1,2}`;

/** Page flags (bit field), stored in doc_pages.flags. */
export const PAGE_FLAGS = {
  FN_UNSURE: 1, // footnotes on this page not reliably recognised — kept as text
  COLUMNS: 2, // two-column layout (reading order may be imperfect)
  BLANK: 4,
  LABEL_GUESSED: 8, // printed number inferred, not read
  HEADING_UNSURE: 16,
} as const;

export interface DmdPage {
  /** 1-based physical page (= count of page markers so far). */
  ord: number;
  label: string;
  /** Offset of the page marker (or of the inline break). */
  start: number;
  /** Exclusive end: the next page's start, or the text end. */
  end: number;
  flags: number;
}

export type BlockKind = "page" | "heading" | "para" | "quote" | "table" | "fndefs";

export interface DmdBlock {
  kind: BlockKind;
  start: number;
  end: number;
  /** Physical page (ord) the block starts on; 0 for an unpaged document. */
  page: number;
  /** heading: 1–6. */
  level?: number;
  /** para: its marginal number / bod label when it opens with `[m. č. N]`. */
  anchor?: string;
  /** Index into ParsedDoc.sections of the innermost section containing the block (-1 = none). */
  section: number;
}

export type SectionKind =
  | "part" // ČÁST / HLAVA / DÍL / ODDÍL / Pododdíl
  | "chapter" // Kapitola N, or a level-1 heading without a better kind
  | "par" // § N
  | "cl" // Čl. N / Článek N
  | "sub" // anything else
  | "front" // Předmluva, Úvod k vydání…
  | "toc" // Obsah — readable, not indexed
  | "index" // Rejstřík — readable, not indexed
  | "abbrev" // Seznam zkratek — indexed at weight D
  | "biblio" // Literatura, Seznam literatury, Bibliografie — weight D
  | "annex"; // Příloha

export interface DmdSection {
  ord: number;
  /** Index of the parent section, or null at top level. */
  parent: number | null;
  level: number;
  kind: SectionKind;
  /** "par:2913a", "cl:III", "cl:3", "part:hlava-iii", "ch:3" — null when none applies. */
  key: string | null;
  /** Sortable number of a § / čl. key: 2913 → 2913, 2913a → 2913.01; null otherwise. */
  keyNum: number | null;
  /** Heading text without the leading #'s, single line, ≤ 300 chars. */
  heading: string;
  /** Explicit author line of the section ("Zpracoval: …"), null if none. */
  author: string | null;
  /** Heading start … exclusive end (includes subsections). */
  start: number;
  end: number;
  pageFrom: number;
  pageTo: number;
  /** False for toc and index sections. */
  indexed: boolean;
}

export interface DmdFootnote {
  /** 1-based, in document order of definitions. */
  seq: number;
  label: string;
  /** 'f' footnote, 'e' endnote (DOCX endnotes, labels i, ii…). */
  kind: "f" | "e";
  /** Offset of the bound `[^L]` reference, or null (dangling definition). */
  refAt: number | null;
  /** Definition text span, WITHOUT the leading `[^L]: `. */
  defStart: number;
  defEnd: number;
  /** Physical page of the reference (dangling: of the definition). */
  page: number;
  /** Section (index) of the reference / definition. */
  section: number;
  /** Anchor (m. č.) of the citing paragraph. */
  anchor: string | null;
}

export interface DmdRef {
  label: string;
  at: number;
  /** seq of the bound definition, or null. */
  footnote: number | null;
}

export interface DmdProblem {
  code:
    | "dangling_ref"
    | "dangling_def"
    | "bad_page_label"
    | "duplicate_page_label"
    | "mn_sequence"
    | "heading_too_long"
    | "par_not_monotonic"
    | "unpaged_start"
    | "escaped_marker";
  at?: number;
  detail?: string;
}

export interface ParsedDoc {
  /** The normalized text all offsets refer to. */
  text: string;
  /** True when the document carries page markers (PDF); false for DOCX/TXT. */
  paged: boolean;
  pages: DmdPage[];
  blocks: DmdBlock[];
  sections: DmdSection[];
  footnotes: DmdFootnote[];
  refs: DmdRef[];
  /** Marginal-number label detected for the document, if any. */
  anchorLabel: AnchorLabel | null;
  stats: {
    chars: number;
    /** Chars excluding markup (markers, [^n], #, > , escapes) — the billing base. */
    countedChars: number;
    physicalPages: number;
    headings: number;
    footnotes: number;
    danglingRefs: number;
    danglingDefs: number;
    marginalNumbers: number;
  };
  problems: DmdProblem[];
}

/** Hard safety caps — a violation rejects the upload (structure anomalies never do). */
export const DMD_LIMITS = {
  maxChars: 7_000_000,
  maxPages: 1_500,
  maxLineChars: 30_000,
  maxHeadings: 20_000,
  maxFootnotes: 30_000,
  maxFootnoteChars: 10_000,
  maxHeadingChars: 300,
} as const;

export class DmdLimitError extends Error {
  constructor(
    public readonly limit: keyof typeof DMD_LIMITS,
    message: string,
  ) {
    super(message);
    this.name = "DmdLimitError";
  }
}

/** A readable span of the stored DMD, addressed by ABSOLUTE offsets (only [start, end) is loaded). */
export interface TextSource {
  start: number;
  end: number;
  slice(from: number, to: number): string;
}

/** A footnote as the renderer needs it (absolute offsets into the DMD). */
export interface RenderFootnote {
  seq: number;
  label: string;
  kind: "f" | "e";
  refAt: number | null;
  defStart: number;
  defEnd: number;
  /** Printed label of the page the note is printed on (its reference's page; the definition's own page for an endnote) — for "(s. 245)" tags. */
  pageLabel: string | null;
}
