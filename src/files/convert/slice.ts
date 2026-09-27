/**
 * Range selection before upload (plan H1: "jen strany 1100–1400", "jen
 * § 2894–3079"): keep a physical page range and/or a section range of an
 * already converted document and re-emit VALID DMD — the result parses
 * with parseDmd like any converter output.
 *
 * Works on documents of any size: a 3 000-page commentary exceeds the
 * parser's safety caps (DMD_LIMITS), and slicing is exactly how it gets
 * under them. So the scan here reuses the parser's own line grammar and
 * inline tokens (classifyLine, InlineCursor, readInline — the three
 * readings of the text cannot drift apart) but keeps only what slicing
 * needs and enforces no caps. `scanDmdOutline` exposes the same scan for
 * the range picker (pages and headings with offsets and ords identical to
 * parseDmd's).
 *
 * What a slice keeps:
 * - paged documents start with a page marker line: the label of the page
 *   the range starts on (an inline ` [s. N] ` at the start becomes a line);
 * - page markers inside the range; the marker of the page after the range
 *   is cut off (with a paragraph that runs on, the rest of it goes);
 * - headings (sections) that start inside the range;
 * - footnote definitions whose reference is kept — also one that lay after
 *   the range end (it follows the last, cut paragraph); a definition whose
 *   reference was cut off goes too (a page break inside it survives as a
 *   marker line). Definitions bound to nothing stay where they were.
 * Pure — unit-tested in tests/files-convert-index.test.ts.
 */

import { classifyLine, InlineCursor, readInline, sectionKeyOf, unescapeDmd, type DmdLine } from "../dmd/parse";
import { normalizeDmd } from "../dmd/normalize";
import { FOOTNOTE_LABEL_SOURCE, type SectionKind } from "../dmd/types";

export interface DmdOutline {
  /** First non-blank line is a page marker. */
  paged: boolean;
  /** Physical pages, 1-based `ord` as in ParsedDoc.pages / ConvertResult.pageFlags. */
  pages: Array<{ ord: number; label: string; start: number; end: number }>;
  /** Headings in document order; `ord` is the index parseDmd gives the section. */
  sections: Array<{
    ord: number;
    level: number;
    heading: string;
    kind: SectionKind;
    key: string | null;
    start: number;
    end: number;
    /** Physical page the heading is on (0 in an unpaged document). */
    page: number;
  }>;
}

interface ScanPage {
  ord: number;
  label: string;
  start: number;
  end: number;
  /** Inline ` [s. N] ` token (else a marker line); tokenEnd = end of "[s. N]". */
  inline: boolean;
  tokenEnd: number;
}

interface ScanDef {
  /** Start of the `[^L]: ` line … end of its last continuation line. */
  lineStart: number;
  end: number;
  /** Offset of the bound reference, or null (dangling). */
  refAt: number | null;
}

interface Scan extends DmdOutline {
  scanPages: ScanPage[];
  defs: ScanDef[];
}

// Same rule as the parser's heading cleanup: refs dropped (escaped ones kept), escapes removed, one line.
const REF_IN_TEXT_RE = new RegExp(String.raw`(\\)?\s?\[\^(?:${FOOTNOTE_LABEL_SOURCE})\]`, "g");
function cleanHeading(raw: string): string {
  const withoutRefs = raw.replace(REF_IN_TEXT_RE, (match, escape: string | undefined) => (escape ? match : ""));
  return unescapeDmd(withoutRefs).replace(/\s+/g, " ").trim();
}

/** One pass over the lines, mirroring parseDmd's page, heading, definition and binding rules. */
function scan(text: string): Scan {
  const n = text.length;
  const cursor = new InlineCursor(text);
  const pages: ScanPage[] = [];
  const sections: DmdOutline["sections"] = [];
  const defs: ScanDef[] = [];
  const refs: number[] = [];
  const unbound = new Map<string, number[]>();
  const stack: number[] = [];
  let curDef: ScanDef | null = null;
  let lastContentEnd = 0;
  let paged: boolean | null = null;

  const newPage = (label: string, start: number, inline: boolean, tokenEnd: number) => {
    if (pages.length) pages[pages.length - 1].end = start;
    pages.push({ ord: pages.length + 1, label, start, end: n, inline, tokenEnd });
  };
  const inline = (line: DmdLine) => {
    for (const m of cursor.take(line.contentStart, line.end)) {
      const tok = readInline(text, m, line, paged === true);
      if (tok.kind === "ref") {
        refs.push(tok.at);
        const stackOf = unbound.get(tok.label);
        if (stackOf) stackOf.push(refs.length - 1);
        else unbound.set(tok.label, [refs.length - 1]);
      } else if (tok.kind === "page") newPage(tok.label, tok.at, true, tok.end);
    }
  };
  const closeSection = (idx: number) => {
    sections[idx].end = Math.max(sections[idx].start, lastContentEnd);
  };

  let s = 0;
  while (s <= n) {
    let e = text.indexOf("\n", s);
    if (e === -1) e = n;
    let line = classifyLine(text, s, e);
    s = e + 1;
    if (line.kind === "blank") continue;
    if (paged === null) paged = line.kind === "page";
    if (line.kind === "page") {
      if (paged) {
        curDef = null;
        newPage(line.label!, line.start, false, line.end);
        continue;
      }
      line = { ...line, kind: "text", contentStart: line.start, label: null };
    }
    if (line.kind === "text" && line.indented && curDef) {
      curDef.end = line.end;
      lastContentEnd = line.end;
      inline(line);
      continue;
    }
    curDef = null;
    if (line.kind === "heading") {
      // Sections closed by this heading end with the content before it.
      while (stack.length && sections[stack[stack.length - 1]].level >= line.level) closeSection(stack.pop()!);
      const raw = text.slice(line.contentStart, line.end);
      const { kind, key } = sectionKeyOf(raw, line.level);
      sections.push({
        ord: sections.length,
        level: line.level,
        heading: cleanHeading(raw),
        kind,
        key,
        start: line.start,
        end: line.end,
        page: pages.length,
      });
      stack.push(sections.length - 1);
    } else if (line.kind === "fndef") {
      const refIdx = unbound.get(line.label!)?.pop();
      curDef = { lineStart: line.start, end: line.end, refAt: refIdx === undefined ? null : refs[refIdx] };
      defs.push(curDef);
    }
    lastContentEnd = line.end;
    inline(line);
  }
  while (stack.length) closeSection(stack.pop()!);
  return {
    paged: paged === true,
    pages: pages.map(({ ord, label, start, end }) => ({ ord, label, start, end })),
    sections,
    scanPages: pages,
    defs,
  };
}

/**
 * Pages and headings of a DMD document with their offsets — for the range
 * picker. Linear, no safety caps (works on documents parseDmd rejects as
 * too large). Section `ord`s and page `ord`s match parseDmd's. Pure.
 */
export function scanDmdOutline(dmd: string): DmdOutline {
  const { paged, pages, sections } = scan(dmd);
  return { paged, pages, sections };
}

function checkRange(range: [number, number], what: string): void {
  const [a, b] = range;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
    throw new RangeError(`Invalid ${what} range [${a}, ${b}].`);
  }
}

/**
 * Keep only a physical page range (1-based, inclusive — PDF) and/or a
 * section range (section ords as in parseDmd / scanDmdOutline, 0-based,
 * inclusive: from the start of the first section to the end of the last
 * one, subsections included) of a converted document. Both given → their
 * intersection. Neither → the text unchanged. An empty intersection → "".
 * Ranges reaching past the document are clamped; a range starting past it,
 * a reversed or non-integer range, or pages of an unpaged document throw
 * RangeError. Output: normalized DMD that parses (see module header). Pure.
 */
export function sliceDmd(
  dmd: string,
  range: { pages?: [number, number] | null; sections?: [number, number] | null },
): string {
  if (!range.pages && !range.sections) return dmd;
  const doc = scan(dmd);
  const n = dmd.length;
  let from = 0;
  let to = n;

  if (range.pages) {
    checkRange(range.pages, "page");
    if (!doc.paged) throw new RangeError("The document has no pages (DOCX/TXT): select sections instead.");
    const [a, b] = range.pages;
    if (a > doc.scanPages.length) throw new RangeError(`Page ${a} is past the last page (${doc.scanPages.length}).`);
    from = Math.max(from, doc.scanPages[Math.max(1, a) - 1].start);
    to = Math.min(to, b < doc.scanPages.length ? doc.scanPages[b].start : n);
  }
  if (range.sections) {
    checkRange(range.sections, "section");
    const [i, j] = range.sections;
    if (i < 0 || i >= doc.sections.length) throw new RangeError(`Section ${i} does not exist (${doc.sections.length} sections).`);
    const last = Math.min(j, doc.sections.length - 1);
    let end = 0;
    for (let k = i; k <= last; k++) end = Math.max(end, doc.sections[k].end);
    from = Math.max(from, doc.sections[i].start);
    to = Math.min(to, end);
  }
  if (from >= to) return "";

  const out: string[] = [];
  let bodyFrom = from;
  if (doc.paged) {
    const page = pageAt(doc.scanPages, from);
    if (page && !(page.start === from && !page.inline)) {
      out.push(`[s. ${page.label}]\n\n`);
      if (page.inline && page.start === from) {
        // The range opens at an inline break: its marker became the line above.
        bodyFrom = page.tokenEnd;
        if (dmd[bodyFrom] === " ") bodyFrom++;
      }
    }
  }

  // Definitions whose reference is outside the range leave; those whose
  // reference is inside but that lie (partly) after `to` move to the end.
  const cuts: Array<{ start: number; end: number; replacement: string }> = [];
  const moved: string[] = [];
  const kept = (at: number) => at >= from && at < to;
  for (const def of doc.defs) {
    if (def.end <= bodyFrom || def.lineStart >= to) {
      if (def.lineStart >= to && def.refAt !== null && kept(def.refAt)) moved.push(withoutPageTokens(dmd, def, doc.scanPages));
      continue;
    }
    if (def.refAt === null) continue; // dangling: stays
    if (!kept(def.refAt)) {
      const start = Math.max(def.lineStart, bodyFrom);
      const end = Math.min(def.end, to);
      cuts.push({ start, end, replacement: pageLinesWithin(doc.scanPages, start, end) });
    } else if (def.end > to) {
      cuts.push({ start: def.lineStart, end: to, replacement: "" });
      moved.push(withoutPageTokens(dmd, def, doc.scanPages));
    }
  }

  let pos = bodyFrom;
  for (const cut of cuts) {
    out.push(dmd.slice(pos, cut.start).trimEnd(), cut.replacement || "\n");
    pos = cut.end;
  }
  // Cut before an inline break: the paragraph ends here, without the space before the marker.
  out.push(dmd.slice(pos, to).trimEnd());
  if (moved.length) out.push(`\n\n${moved.join("\n")}`);

  // Removed definitions leave extra blank lines; blocks only need one.
  const text = out.join("").replace(/\n{3,}/g, "\n\n").trim();
  return normalizeDmd(text).text;
}

/** The page whose [start, end) contains `offset` (null before the first page). */
function pageAt(pages: ScanPage[], offset: number): ScanPage | null {
  let lo = 0;
  let hi = pages.length - 1;
  let found: ScanPage | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= offset) {
      found = pages[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** A definition's text with its inline page markers (and one space each) removed. */
function withoutPageTokens(text: string, def: ScanDef, pages: ScanPage[]): string {
  let out = "";
  let pos = def.lineStart;
  for (const page of pages) {
    if (!page.inline || page.start < def.lineStart || page.start >= def.end) continue;
    out += text.slice(pos, page.start);
    pos = page.tokenEnd;
    if (text[pos] === " ") pos++;
    else if (out.endsWith(" ")) out = out.slice(0, -1);
  }
  return (out + text.slice(pos, def.end)).trimEnd();
}

/** Marker lines for the inline page breaks inside [start, end) — so removing that text keeps its pages. */
function pageLinesWithin(pages: ScanPage[], start: number, end: number): string {
  const labels = pages.filter((p) => p.inline && p.start >= start && p.start < end).map((p) => p.label);
  return labels.length ? `\n\n${labels.map((l) => `[s. ${l}]`).join("\n\n")}\n\n` : "";
}
