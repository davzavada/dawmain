/**
 * Derivation: ParsedDoc → the search index of one document — chunks with
 * their tsvector literals and identifier keys, the document-level keys and
 * the § range of a commentary — plus the document-level meta tsvector and
 * keys built from (confirmed) metadata. Everything here is re-computable
 * from the stored DMD alone, so a new analyzer or chunker only needs a
 * re-derive, never the original file.
 *
 * Chunks (plan §4, reviews M3/H2):
 * - a chunk is ONE contiguous DMD span: paragraphs plus the footnote
 *   definitions that follow them, so "odpovědnost 25 Cdo 1234/2019" (words
 *   in the body, sp. zn. in a footnote) is one AND match;
 * - it never crosses a heading: the text between two headings (a
 *   "segment") is chunked on its own, the first chunk starting at the
 *   heading line; a section with no body of its own still gets one chunk
 *   (its heading carries the signal);
 * - sizes count BODY characters only (para / quote / table, not footnote
 *   definitions, headings or page markers): target 1,400, min 400, max
 *   2,400; a segment whose remaining body fits in the max is not split;
 * - split preference: before a `[m. č.]` paragraph, then any paragraph end,
 *   then — only inside a paragraph longer than the max — a sentence end,
 *   and as a last resort a space (or a hard cut in text without any);
 * - never split between a footnote reference and its definition when both
 *   lie within MAX_GLUE chars in the same segment (a longer distance means
 *   the converter mis-bound the note, and gluing would swallow pages);
 *   a definitions block also never starts a chunk — it belongs to the
 *   paragraph before it;
 * - page-marker lines belong to the text after them (a chunk never ends on
 *   a marker, so its pageTo is the page its text ends on);
 * - toc / index sections (and everything under them) are not indexed.
 *
 * tsvector weights (ts_rank_cd '{D,C,B,A}' = {0.05, 0.12, 0.2, 1.0}):
 *   A  the section's own heading, plus "§ 2913" / "čl. III" of the
 *      enclosing § / článek when the chunk sits in a subsection of it
 *   B  the parent section's heading (one level up)
 *   C  body text
 *   D  footnote definitions; in a commentary also `> ` quotes (the
 *      statute's wording — the official text is esbirka_get_text); every
 *      part of an abbrev / biblio section (Seznam zkratek, Literatura)
 * Positions follow document order within the span (headings first), so
 * phrases inside a paragraph keep adjacent positions.
 *
 * Identifier keys per chunk: "sec:<key>" of the enclosing § / článek
 * section first (e.g. "sec:par:2913" — so a capped key list never loses
 * it), then extractIdentKeys over the chunk's markup-stripped text with the
 * commented act (a bare "§ 2910" in a commentary on the civil code also
 * yields parz:89/2012/2910).
 *
 * Isomorphic and pure — unit-tested (tests/files-derive.test.ts; the whole
 * pipeline on PGlite in tests/files-search-e2e.test.ts).
 */

import { stripMarkup } from "@/src/files/dmd/parse";
import type { DmdBlock, DmdSection, ParsedDoc } from "@/src/files/dmd/types";
import { extractIdentKeys, MAX_IDENT_KEYS, normalizeIsbn } from "@/src/files/index/identifiers";
import { buildTsvector } from "@/src/files/index/tsv";
import type { Derived, DerivedChunk, Weight } from "@/src/files/index/types";
import type { BibMeta, DocType } from "@/src/files/types";

export type { Derived, DerivedChunk };

/** Body characters per chunk: the target, the preferred minimum and the maximum. */
export const CHUNK_TARGET = 1_400;
export const CHUNK_MIN = 400;
export const CHUNK_MAX = 2_400;
/** A reference and its definition further apart than this are not kept together (mis-bound note). */
export const MAX_GLUE = 8_000;
/** Document-level keys taken from the chunks (the commentary's sec: keys come on top). */
export const MAX_DOC_IDENT_KEYS = 500;
/** sec: keys of a commentary at document level — a safety cap far above any real commentary. */
export const MAX_DOC_SECTION_KEYS = 5_000;
/** Outline headings (levels ≤ 2) indexed in meta_tsv. */
export const META_HEADING_CHARS = 3_000;

// ─────────────────────────────────────────────────────────────── cuts

/**
 * Kind of a split point, best first. The packer adds CUT_PENALTY[kind] to a
 * split's distance from the target (in units of the target), so an m. č.
 * boundary ~400 chars off the target still beats a plain paragraph end on
 * it, while a sentence cut is taken only where a paragraph cut is far off.
 */
const Cut = { Mn: 0, Para: 1, Sentence: 2, Word: 3 } as const;
type Cut = (typeof Cut)[keyof typeof Cut];
const CUT_PENALTY: Record<Cut, number> = [0, 0.3, 0.6, 1.2];
/** Added when a split would leave a remainder under CHUNK_MIN. */
const SHORT_TAIL_PENALTY = 1;

/**
 * The smallest unit the packer moves: a span between two possible split
 * points. `cut` says what kind of split may happen right BEFORE the atom
 * (null: none — it is glued to the previous atom).
 */
interface Atom {
  start: number;
  end: number;
  body: number;
  cut: Cut | null;
}

/** The text after one heading up to the next one (or before the first heading). */
interface Segment {
  /** Index into parsed.sections; -1 for the text before the first heading. */
  section: number;
  heading: DmdBlock | null;
  /** Content blocks in order (page, para, quote, table, fndefs). */
  blocks: DmdBlock[];
}

function segmentsOf(blocks: DmdBlock[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment = { section: -1, heading: null, blocks: [] };
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (cur.heading || cur.blocks.length) out.push(cur);
      cur = { section: block.section, heading: block, blocks: [] };
    } else {
      cur.blocks.push(block);
    }
  }
  if (cur.heading || cur.blocks.length) out.push(cur);
  return out;
}

// Czech abbreviations that end with a period mid-sentence (lowercase, folded
// forms are not needed: the check runs on the word as written, lowercased).
const ABBREVIATIONS = new Set([
  "č", "čl", "odst", "písm", "pís", "zák", "tzv", "např", "atd", "resp", "srov", "pozn", "str", "sb", "vyd", "roč",
  "obr", "tab", "viz", "apod", "aj", "tj", "mj", "kol", "nar", "ing", "mgr", "judr", "doc", "prof", "phdr", "dr",
  "sp", "zn", "rozh", "rozs", "usn", "nál", "st", "tr", "obč", "ust", "příp", "popř", "cit", "op", "tamt", "et",
  "al", "dat", "zejm", "vč", "min", "max", "tis", "mil", "mld", "kč", "hod", "ul", "nám", "bod", "věta", "část",
  "hl", "dl", "odd", "přech", "ods", "vl", "sv", "ev", "reg", "fol", "orig", "angl", "něm", "lat", "srv", "cca",
]);
const ROMAN_NUMERAL = /^[IVXLCDM]+$/;

/**
 * A sentence end: terminal punctuation, optional closing quotes/brackets,
 * an optional footnote reference glued to it ("…škody.[^12] Soud"), then
 * whitespace and a sentence-looking start (capital, digit, opening quote).
 */
const SENTENCE_END_RE = /[.?!…]["'“”»)]*(?:\[\^[^\]\s]{1,6}\])?(\s+)(?=[„"«(]?[\p{Lu}\p{Nd}])/gu;
const WORD_BEFORE_RE = /[\p{L}\p{Nd}]+$/u;

function isSentenceEnd(text: string, punctAt: number): boolean {
  if (text[punctAt] !== ".") return true; // ? ! … always end a sentence
  const word = WORD_BEFORE_RE.exec(text.slice(Math.max(0, punctAt - 16), punctAt))?.[0] ?? "";
  if (word.length === 0) return true; // "(…)." "“." — punctuation after punctuation
  if (word.length === 1) return false; // initials, "s.", "o. z."
  if (ROMAN_NUMERAL.test(word)) return false; // "II. ÚS", "HLAVA III."
  if (/^\p{Nd}{1,3}$/u.test(word)) return false; // ordinals, dates: "2. vydání", "12. 3. 2019"
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/** Longest bracketed DMD token that contains a space: "[s. " + 12-char label + "]". */
const MAX_TOKEN = 17;

/** True when `pos` lies inside a bracketed DMD token ("[s. 246]", "[m. č. 3]"). Looks back MAX_TOKEN chars only. */
function insideBracket(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0 && i >= pos - MAX_TOKEN; i--) {
    const c = text.charCodeAt(i);
    if (c === 0x5d) return false; // "]" — the last token closed before pos
    if (c === 0x5b) return true; // "[" — still open at pos
  }
  return false;
}

/** A cut never separates a surrogate pair. */
function safeHardCut(text: string, pos: number): number {
  const c = text.charCodeAt(pos);
  return c >= 0xdc00 && c <= 0xdfff ? pos - 1 : pos;
}

interface Piece {
  start: number;
  end: number;
  cut: Cut | null;
}

/**
 * Split an oversized block [start, end) at sentence ends (table rows for a
 * table), then split any piece still over CHUNK_MAX at a space near the
 * target, else hard. Returns contiguous pieces; the gap between two pieces
 * is the whitespace at the cut. The first piece's cut is the caller's.
 */
function splitBlock(text: string, block: DmdBlock): Piece[] {
  const cuts: Array<{ end: number; next: number; cut: Cut }> = [];
  if (block.kind === "table") {
    for (let nl = text.indexOf("\n", block.start); nl !== -1 && nl < block.end; nl = text.indexOf("\n", nl + 1)) {
      cuts.push({ end: nl, next: nl + 1, cut: Cut.Sentence });
    }
  } else {
    const slice = text.slice(block.start, block.end);
    for (const m of slice.matchAll(SENTENCE_END_RE)) {
      const ws = m.index + m[0].length - m[1].length;
      if (!isSentenceEnd(slice, m.index)) continue;
      cuts.push({ end: block.start + ws, next: block.start + ws + m[1].length, cut: Cut.Sentence });
    }
  }
  const pieces: Piece[] = [];
  let from = block.start;
  let cut: Cut | null = null;
  const emit = (to: number, next: number, nextCut: Cut) => {
    // Break a piece that is still too long at spaces near the target.
    while (to - from > CHUNK_MAX) {
      const target = from + CHUNK_TARGET;
      let space = -1;
      for (let i = target; i < from + CHUNK_MAX && i < to; i++) {
        const c = text.charCodeAt(i);
        if ((c === 0x20 || c === 0x0a) && !insideBracket(text, i)) {
          space = i;
          break;
        }
      }
      for (let i = target - 1; space === -1 && i > from + CHUNK_MIN; i--) {
        const c = text.charCodeAt(i);
        if ((c === 0x20 || c === 0x0a) && !insideBracket(text, i)) space = i;
      }
      const at = space === -1 ? safeHardCut(text, from + CHUNK_MAX) : space;
      pieces.push({ start: from, end: at, cut });
      from = space === -1 ? at : at + 1;
      cut = Cut.Word;
    }
    pieces.push({ start: from, end: to, cut });
    from = next;
    cut = nextCut;
  };
  for (const c of cuts) if (c.end > from) emit(c.end, c.next, c.cut);
  emit(block.end, block.end, Cut.Word);
  return pieces;
}

// ─────────────────────────────────────────────────────────────── atoms and packing

/** Footnote reference → definition spans that must stay in one chunk, sorted by reference. */
function glueSpans(parsed: ParsedDoc): Array<[ref: number, def: number]> {
  const spans: Array<[number, number]> = [];
  for (const fn of parsed.footnotes) {
    if (fn.refAt === null || fn.defStart <= fn.refAt || fn.defStart - fn.refAt > MAX_GLUE) continue;
    spans.push([fn.refAt, fn.defStart]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** First index in the sorted `xs` whose value (via `key`) is ≥ `v`. */
function lowerBound<T>(xs: T[], v: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(xs[mid]) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function atomsOf(text: string, seg: Segment, glue: Array<[number, number]>): Atom[] {
  const atoms: Atom[] = [];
  if (seg.heading) atoms.push({ start: seg.heading.start, end: seg.heading.end, body: 0, cut: null });
  let pendingStart = -1; // page markers waiting for the text they introduce
  for (const block of seg.blocks) {
    if (block.kind === "page") {
      if (pendingStart < 0) pendingStart = block.start;
      continue;
    }
    if (block.kind === "fndefs") {
      // Definitions belong to the paragraph before them (with any marker in between).
      if (atoms.length) atoms[atoms.length - 1].end = block.end;
      else atoms.push({ start: pendingStart >= 0 ? pendingStart : block.start, end: block.end, body: 0, cut: null });
      pendingStart = -1;
      continue;
    }
    // No split before the segment's first text: a heading is never a chunk of its own when its section has text.
    const first = atoms.length === (seg.heading ? 1 : 0);
    const cut = first ? null : block.anchor !== undefined ? Cut.Mn : Cut.Para;
    const pieces = block.end - block.start > CHUNK_MAX ? splitBlock(text, block) : [{ start: block.start, end: block.end, cut: null }];
    pieces.forEach((piece, i) => {
      atoms.push({
        start: i === 0 && pendingStart >= 0 ? pendingStart : piece.start,
        end: piece.end,
        body: piece.end - piece.start,
        cut: i === 0 ? cut : piece.cut,
      });
    });
    pendingStart = -1;
  }
  // Trailing page markers stay outside: a chunk ends with text.
  if (atoms.length === 0) return atoms;

  // Keep references and their definitions together.
  const segStart = atoms[0].start;
  const segEnd = atoms[atoms.length - 1].end;
  for (let g = lowerBound(glue, segStart, (s) => s[0]); g < glue.length && glue[g][0] < segEnd; g++) {
    const [ref, def] = glue[g];
    if (def >= segEnd) continue;
    for (let i = lowerBound(atoms, ref + 1, (a) => a.start); i < atoms.length && atoms[i].start <= def; i++) atoms[i].cut = null;
  }
  return atoms;
}

/**
 * Greedy packing of a segment's atoms into chunks: from each chunk start,
 * the split candidates are the allowed cuts whose chunk body falls in
 * [CHUNK_MIN, CHUNK_MAX]; the cheapest (distance from the target plus the
 * cut's penalty) wins. When nothing lands in that window, the chunk ends at
 * the last allowed cut under the max (a short chunk) or, failing that, at
 * the first allowed cut at all (an oversized glued run). Returns the atom
 * index ranges [from, to).
 */
function pack(atoms: Atom[]): Array<[number, number]> {
  const n = atoms.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + atoms[i].body;
  const out: Array<[number, number]> = [];
  let from = 0;
  while (from < n) {
    const remaining = prefix[n] - prefix[from];
    if (remaining <= CHUNK_MAX) {
      out.push([from, n]);
      break;
    }
    let best = -1;
    let bestCost = Infinity;
    let lastUnder = -1;
    let firstAny = -1;
    for (let i = from + 1; i < n; i++) {
      const cut = atoms[i].cut;
      if (cut === null) continue;
      const size = prefix[i] - prefix[from];
      if (firstAny === -1) firstAny = i;
      if (size > CHUNK_MAX) break;
      if (size > 0) lastUnder = i;
      if (size < CHUNK_MIN) continue;
      const tail = prefix[n] - prefix[i];
      const cost = Math.abs(size - CHUNK_TARGET) / CHUNK_TARGET + CUT_PENALTY[cut] + (tail < CHUNK_MIN ? SHORT_TAIL_PENALTY : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    const to = best !== -1 ? best : lastUnder !== -1 ? lastUnder : firstAny !== -1 ? firstAny : n;
    out.push([from, to]);
    from = to;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── chunk content

/** Per-section facts the chunk builder needs, computed once. */
interface SectionInfo {
  /** abbrev / biblio section or inside one: every part at weight D. */
  weak: boolean;
  /** Nearest § / článek section with a key (itself included), or -1. */
  enclosing: number;
}

function sectionInfo(sections: DmdSection[]): SectionInfo[] {
  const info: SectionInfo[] = [];
  sections.forEach((s, i) => {
    const parent = s.parent !== null && s.parent >= 0 && s.parent < i ? info[s.parent] : null;
    info.push({
      weak: s.kind === "abbrev" || s.kind === "biblio" || (parent?.weak ?? false),
      enclosing: (s.kind === "par" || s.kind === "cl") && s.key ? i : (parent?.enclosing ?? -1),
    });
  });
  return info;
}

/** "par:2913a" → "§ 2913a", "cl:III" → "čl. III" — the key as a citation. */
export function keyDesignator(key: string): string | null {
  const m = /^(par|cl):(.+)$/.exec(key);
  if (!m) return null;
  return m[1] === "par" ? `§ ${m[2]}` : `čl. ${m[2]}`;
}

/** Physical page (ord) containing `offset`; pages are sorted and tile the text. */
function pageAt(parsed: ParsedDoc, offset: number): number | null {
  const pages = parsed.pages;
  if (!parsed.paged || pages.length === 0) return null;
  const i = lowerBound(pages, offset + 1, (p) => p.start) - 1;
  return pages[Math.max(0, i)].ord;
}

function dedupeCap(keys: string[], cap: number): string[] {
  return [...new Set(keys)].slice(0, cap);
}

/**
 * Derive the chunks of a parsed document (see the module header). `docType`
 * decides the commentary rules (quotes at weight D, the § range); the
 * commented act ("zak:89/2012") turns bare § references into parz: keys.
 * Pure.
 */
export function deriveIndex(parsed: ParsedDoc, opts: { docType: DocType | null; commentedAct?: string | null }): Derived {
  const { text, sections } = parsed;
  const commentary = opts.docType === "komentar";
  const ctx = { commentedAct: opts.commentedAct ?? null };
  const info = sectionInfo(sections);
  const glue = glueSpans(parsed);
  const chunks: DerivedChunk[] = [];

  for (const seg of segmentsOf(parsed.blocks)) {
    const section = seg.section >= 0 && seg.section < sections.length ? sections[seg.section] : null;
    if (section && !section.indexed) continue;
    const atoms = atomsOf(text, seg, glue);
    if (atoms.length === 0) continue;

    const own = section ? info[seg.section] : null;
    const weak = own?.weak ?? false;
    const enclosing = own && own.enclosing >= 0 ? sections[own.enclosing] : null;
    const secKey = enclosing?.key ? `sec:${enclosing.key}` : null;
    const headingParts: Array<{ text: string; weight: Weight }> = [];
    if (section) {
      const parent = section.parent !== null ? sections[section.parent] : undefined;
      if (parent) headingParts.push({ text: parent.heading, weight: weak ? "D" : "B" });
      headingParts.push({ text: section.heading, weight: weak ? "D" : "A" });
      const designator = enclosing && enclosing !== section && enclosing.key ? keyDesignator(enclosing.key) : null;
      if (designator) headingParts.push({ text: designator, weight: weak ? "D" : "A" });
    }

    // Effective marginal number of each content block (the parser resets it at every heading).
    const blocks = seg.heading ? [seg.heading, ...seg.blocks] : seg.blocks;
    const anchors: Array<string | null> = [];
    let anchor: string | null = null;
    for (const b of blocks) {
      if (b.kind === "para" && b.anchor !== undefined) anchor = b.anchor;
      anchors.push(anchor);
    }

    let k = 0; // first block that may overlap the next chunk
    for (const [a, z] of pack(atoms)) {
      const start = atoms[a].start;
      const end = atoms[z - 1].end;
      const parts = [...headingParts];
      const keyText: string[] = [];
      let anchorFrom: string | null = null;
      let anchorTo: string | null = null;
      let sawContent = false;
      while (k < blocks.length && blocks[k].end <= start) k++;
      for (let j = k; j < blocks.length && blocks[j].start < end; j++) {
        const b = blocks[j];
        if (b.kind === "page") continue;
        const from = Math.max(b.start, start);
        const to = Math.min(b.end, end);
        if (to <= from) continue;
        const stripped = stripMarkup(text.slice(from, to)).text;
        keyText.push(stripped);
        if (b.kind === "heading") continue; // indexed at A from the section heading
        const weight: Weight =
          b.kind === "fndefs" || weak || (b.kind === "quote" && commentary) ? "D" : "C";
        parts.push({ text: stripped, weight });
        if (b.kind !== "fndefs") {
          if (!sawContent) anchorFrom = anchors[j];
          anchorTo = anchors[j];
          sawContent = true;
        }
      }
      const keys = extractIdentKeys(keyText.join("\n"), ctx);
      chunks.push({
        ord: chunks.length,
        start,
        end,
        pageFrom: pageAt(parsed, start),
        pageTo: pageAt(parsed, Math.max(start, end - 1)),
        section: section ? seg.section : null,
        anchorFrom,
        anchorTo,
        tsv: buildTsvector(parts),
        identKeys: dedupeCap(secKey ? [secKey, ...keys] : keys, MAX_IDENT_KEYS),
      });
    }
  }

  return {
    chunks,
    docIdentKeys: docIdentKeys(chunks, commentary ? sections : []),
    sectionRange: commentary ? sectionRangeOf(sections) : null,
  };
}

/**
 * Document keys: the chunks' keys (sec: keys excluded) ranked by how many
 * chunks carry them, then by first occurrence, capped at MAX_DOC_IDENT_KEYS;
 * then "sec:<key>" of every indexed § / článek section passed in (the
 * caller passes a commentary's sections, else none).
 */
function docIdentKeys(chunks: DerivedChunk[], sections: DmdSection[]): string[] {
  const freq = new Map<string, number>();
  for (const c of chunks) {
    for (const key of c.identKeys) if (!key.startsWith("sec:")) freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  // Map iteration order is first occurrence; the sort is stable.
  const ranked = [...freq].sort((x, y) => y[1] - x[1]).map(([key]) => key).slice(0, MAX_DOC_IDENT_KEYS);
  const sec = sections
    .filter((s) => s.indexed && (s.kind === "par" || s.kind === "cl") && s.key)
    .map((s) => `sec:${s.key}`);
  return [...ranked, ...dedupeCap(sec, MAX_DOC_SECTION_KEYS)];
}

/**
 * "§ 2894–3079" from the indexed § sections (by key number: 2913a sorts
 * after 2913); "§ 2913" for one; null without any. Pure.
 */
export function sectionRangeOf(sections: DmdSection[]): string | null {
  let lo: DmdSection | null = null;
  let hi: DmdSection | null = null;
  for (const s of sections) {
    if (s.kind !== "par" || !s.indexed || s.key === null || s.keyNum === null) continue;
    if (!lo || s.keyNum < lo.keyNum!) lo = s;
    if (!hi || s.keyNum > hi.keyNum!) hi = s;
  }
  if (!lo || !hi) return null;
  const a = lo.key!.slice("par:".length);
  const b = hi.key!.slice("par:".length);
  return a === b ? `§ ${a}` : `§ ${a}–${b}`;
}

// ─────────────────────────────────────────────────────────────── document level

const str = (v: string | null | undefined): string => (typeof v === "string" ? v : "");
const list = (v: string[] | null | undefined): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "");

/**
 * Document-level tsvector literal (documents.meta_tsv, the "meta" search
 * channel): title and subtitle A; authors, editors, court, case number and
 * container title B; keywords, summary and publisher C; the outline —
 * headings of indexed sections at levels ≤ 2, whole headings up to
 * META_HEADING_CHARS — D. Pure.
 */
export function buildMetaTsv(meta: Partial<BibMeta>, sections: DmdSection[]): string {
  const headings: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (s.level > 2 || !s.indexed) continue;
    if (used + s.heading.length > META_HEADING_CHARS) break;
    headings.push(s.heading);
    used += s.heading.length + 1;
  }
  return buildTsvector([
    { text: [str(meta.title), str(meta.subtitle)].join("\n"), weight: "A" },
    {
      text: [list(meta.authors), list(meta.editors), str(meta.court), str(meta.case_number), str(meta.container_title)].join("\n"),
      weight: "B",
    },
    { text: [list(meta.keywords), str(meta.summary), str(meta.publisher)].join("\n"), weight: "C" },
    { text: headings.join("\n"), weight: "D" },
  ]);
}

const ZAK_RE = /^zak:\d{1,4}\/\d{4}$/;

/**
 * Document keys from confirmed metadata: isbn: (checksum-validated, ISBN-10
 * converted), doi:, ecli:, the case number's sz: key, and the commented act
 * when it is a Czech act ("zak:89/2012"). Normalized exactly like the keys
 * found in text (extractIdentKeys), so both meet in one GIN lookup. Pure.
 */
export function metaIdentKeys(meta: Partial<BibMeta>): string[] {
  const keys: string[] = [];
  for (const isbn of Array.isArray(meta.isbn) ? meta.isbn : []) {
    const normalized = typeof isbn === "string" ? normalizeIsbn(isbn) : null;
    if (normalized) keys.push(`isbn:${normalized}`);
  }
  const pick = (value: string | null | undefined, prefix: string) => {
    if (typeof value !== "string" || !value.trim()) return;
    for (const key of extractIdentKeys(value)) if (key.startsWith(prefix)) keys.push(key);
  };
  pick(meta.doi, "doi:");
  pick(meta.ecli, "ecli:");
  pick(meta.case_number, "sz:");
  if (typeof meta.commented_act === "string" && ZAK_RE.test(meta.commented_act)) keys.push(meta.commented_act);
  return [...new Set(keys)];
}
