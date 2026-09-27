/**
 * DOCX → DMD in the browser: mammoth 1.13 turns the Word document into
 * simple HTML, `htmlToDmd` walks that HTML (parsed with DOMParser into a
 * detached document — never attached to the live page, never rendered) and
 * writes DMD. The original never leaves the device; only the DMD does.
 *
 * mammoth facts this relies on (checked in node_modules/mammoth/lib):
 * - footnotes and endnotes share ONE counter: a reference is
 *   `<sup><a href="#{prefix}footnote-{id}" id="{prefix}footnote-ref-{id}">[n]</a></sup>`
 *   (endnote-… for endnotes); the bodies come last in one `<ol>` of
 *   `<li id="{prefix}footnote-{id}">…<a href="#…-ref-{id}">↑</a></li>`.
 *   We tell them apart by the href and relabel: footnotes 1..n, endnotes
 *   i, ii … (letters a, b … past xvii — see endnoteLabel);
 * - automatic numbering is lost (numbering-xml keeps only isOrdered and
 *   level; "Čl. III" / "3.2" labels vanish). MVP: counted through
 *   transformDocument and reported as quality.numbering "lost" + a Czech
 *   warning; the XML rewrite is phase 1.5;
 * - comments are dropped by default, images go through our converter which
 *   drops them, externalFileAccess is off (a DOCX cannot read local files).
 *
 * The package.json "browser" field swaps mammoth's unzip/files for the
 * browser versions under Next's client bundling; in node (tests) the lib
 * entry reads the same ArrayBuffer through `buffer`.
 *
 * `htmlToDmd` is pure over a DOM tree — unit-tested with happy-dom
 * (tests/files-convert-docx.test.ts).
 */

import { DMD_LIMITS } from "../dmd/types";
import type { ConversionQuality } from "../types";
import {
  countPlaceholders,
  definitionLines,
  endnoteLabel,
  escapeInline,
  escapeLineStart,
  footnoteLabel,
  formatCount,
  MAX_LINE_CHARS,
  MAX_ROMAN_ENDNOTES,
  normalizePlaceholders,
  plural,
  unpagedResult,
  wrapLongLine,
} from "./text";
import { ConvertError, type ConvertOptions, type ConvertResult } from "./types";

/** idPrefix handed to mammoth — every note id in its HTML starts with it. */
export const DOCX_ID_PREFIX = "dmd-";

/** Czech Word writes built-in headings with English names ("heading 1", mapped by mammoth's
 * defaults); these cover custom styles literally named in Czech and the Title style. */
export const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Název'] => h1:fresh",
  "p[style-name='Nadpis 1'] => h1:fresh",
  "p[style-name='Nadpis 2'] => h2:fresh",
  "p[style-name='Nadpis 3'] => h3:fresh",
  "p[style-name='Nadpis 4'] => h4:fresh",
  "p[style-name='Nadpis 5'] => h5:fresh",
  "p[style-name='Nadpis 6'] => h6:fresh",
  "p[style-name='Článek'] => h2:fresh",
];

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// ─────────────────────────────────────────────────────────── heading patterns

/** "Čl. III", "Článek 3", "Čl. 3a." */
const CL_RE = /^(?:čl\.|článek)\s*(?:\d{1,3}[a-z]?|[ivxlcdm]{1,8})\.?(?=\s|$)/iu;
/** "§ 12", "§ 12a" */
const PAR_RE = /^§\s*\d{1,4}[a-z]?\.?(?=\s|$)/u;
/** "ČÁST PRVNÍ", "Hlava II", "Díl 3", "Oddíl 1." */
const PART_RE = /^(?:část|hlava|díl|oddíl)\s+(?:\d{1,3}\.?|[ivxlcdm]{1,8}\.?|\p{L}+)(?=\s|$)/iu;
const MAX_PATTERN_HEADING = 150;

/**
 * Level of a short, fully bold paragraph that reads as a structural heading
 * ("Čl. III", "Článek 3 – Cena", "§ 5", "ČÁST PRVNÍ"): parts 1, articles and
 * § 2; null for anything else (a sentence ending in , ; : or a period after
 * more than the designator, or a long line). Pure.
 */
export function patternHeadingLevel(plain: string): number | null {
  const text = plain.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_PATTERN_HEADING || /[,;:]$/.test(text)) return null;
  const part = PART_RE.exec(text);
  const article = part ? null : CL_RE.exec(text) ?? PAR_RE.exec(text);
  const match = part ?? article;
  if (!match) return null;
  if (text.endsWith(".") && match[0].length !== text.length) return null;
  return part ? 1 : 2;
}

/** The heading text is just the designator ("Čl. III", "ČÁST PRVNÍ") — its title may follow on the next line. */
function designatorOnly(plain: string): boolean {
  const text = plain.replace(/\s+/g, " ").trim();
  const m = PART_RE.exec(text) ?? CL_RE.exec(text) ?? PAR_RE.exec(text);
  return !!m && m[0].length === text.length;
}

// ─────────────────────────────────────────────────────────── DOM helpers

function tagOf(node: Node): string {
  return node.nodeType === ELEMENT_NODE ? (node as Element).localName.toLowerCase() : "";
}

function childNodes(node: Node): Node[] {
  return Array.from(node.childNodes);
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_TAGS = new Set(["ul", "ol"]);
const BLOCK_TAGS = new Set(["p", "ul", "ol", "li", "table", "tr", "td", "th", "thead", "tbody", "tfoot", "div", "blockquote", "dl", "dt", "dd", ...HEADING_TAGS]);

/** Inline content collected from the DOM: raw text (escaped later, all at once), our markup, and line breaks. */
type Segment = { text: string } | { markup: string } | { br: true };

interface InlineOpts {
  /** Line breaks and nested blocks become spaces (table cells, headings, note paragraphs). */
  singleLine?: boolean;
  /** Nested elements rendered separately by the caller (e.g. a list inside a list item). */
  skip?: (el: Element) => boolean;
}

/** Text lines of the segments: placeholders normalized, whitespace collapsed, escaped, trimmed, non-empty. */
function segmentsToLines(segments: Segment[], placeholders: { count: number }): string[] {
  const lines: string[] = [];
  let line = "";
  let raw = "";
  const flushRaw = (beforeMarkup: boolean) => {
    if (!raw) return;
    const { text, count } = normalizePlaceholders(raw.replace(/[ \t\n\r\f\v]+/g, " "));
    placeholders.count += count;
    let escaped = escapeInline(text);
    // "…\" + "[^1]" would read as an escaped bracket: keep them apart.
    if (beforeMarkup && escaped.endsWith("\\")) escaped += " ";
    line += escaped;
    raw = "";
  };
  const endLine = () => {
    flushRaw(false);
    const trimmed = line.replace(/ {2,}/g, " ").trim();
    if (trimmed) lines.push(trimmed);
    line = "";
  };
  for (const seg of segments) {
    if ("text" in seg) raw += seg.text;
    else if ("markup" in seg) {
      flushRaw(true);
      line += seg.markup;
    } else endLine();
  }
  endLine();
  return lines;
}

// ─────────────────────────────────────────────────────────── the walker

export interface HtmlToDmdResult {
  dmd: string;
  /** Footnote references written (each with its definition). */
  footnotes: number;
  /** Endnote references written. */
  endnotes: number;
  /** Heading lines written. */
  headings: number;
  /** `[____]`, `[●]`, ☐, ☒ in the output text. */
  placeholders: number;
  /** Items of ordered lists — their automatic numbers are lost. */
  orderedItems: number;
  /** Endnotes labelled a, b, c … because there were more than 17. */
  letterEndnotes: boolean;
  /** Note definitions too long for DMD; their tail follows as plain text. */
  overflowedNotes: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class Walker {
  readonly blocks: string[] = [];
  private pending: Array<{ label: string; note: Element | null }> = [];
  private readonly notes = new Map<string, Element>();
  private readonly skip = new Set<Element>();
  private readonly refRe: RegExp;
  private readonly backRe: RegExp;
  private readonly endnoteTotal: number;
  private inNote = false;
  footnotes = 0;
  endnotes = 0;
  headings = 0;
  orderedItems = 0;
  overflowedNotes = 0;
  readonly placeholders = { count: 0 };

  constructor(root: ParentNode, prefix: string) {
    const p = escapeRegExp(prefix);
    this.refRe = new RegExp(`^#(${p}(footnote|endnote)-(-?\\d+))$`);
    this.backRe = new RegExp(`^#${p}(?:footnote|endnote)-ref-(-?\\d+)$`);
    const noteIdRe = new RegExp(`^${p}(?:footnote|endnote)-(-?\\d+)$`);

    // Note bodies: every <li id="{prefix}footnote-N">; the <ol> holding only them is not content.
    for (const li of Array.from(root.querySelectorAll("li[id]"))) {
      if (noteIdRe.test(li.id)) this.notes.set(li.id, li);
    }
    for (const ol of Array.from(root.querySelectorAll("ol"))) {
      const items = Array.from(ol.children);
      if (items.length && items.every((li) => tagOf(li) === "li" && this.notes.get(li.id) === li)) this.skip.add(ol);
    }
    // Comments (mammoth's <dl>) are never content.
    for (const dl of Array.from(root.querySelectorAll("dl"))) this.skip.add(dl);

    let endnotes = 0;
    for (const a of Array.from(root.querySelectorAll("a[href]"))) {
      const m = this.refRe.exec(a.getAttribute("href") ?? "");
      if (m && m[2] === "endnote" && this.notes.has(m[1])) endnotes++;
    }
    this.endnoteTotal = endnotes;
  }

  get letterEndnotes(): boolean {
    return this.endnoteTotal > MAX_ROMAN_ENDNOTES;
  }

  // ── inline

  /** Plain text and bold coverage of a paragraph — no side effects (used to look ahead). */
  inspect(el: Element): { plain: string; allBold: boolean } {
    let plain = "";
    let bold = 0;
    let total = 0;
    const visit = (node: Node, inBold: boolean) => {
      if (node.nodeType === TEXT_NODE) {
        const data = node.nodeValue ?? "";
        plain += data;
        const visible = data.replace(/\s+/g, "").length;
        total += visible;
        if (inBold) bold += visible;
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;
      const tag = tagOf(node);
      if (tag === "a" && this.refRe.test((node as Element).getAttribute("href") ?? "")) return; // a note mark is not text
      if (tag === "br") plain += " ";
      for (const child of childNodes(node)) visit(child, inBold || tag === "strong" || tag === "b");
    };
    visit(el, false);
    return { plain: plain.replace(/\s+/g, " ").trim(), allBold: total > 0 && bold === total };
  }

  private collect(node: Node, out: Segment[], opts: InlineOpts): void {
    if (node.nodeType === TEXT_NODE) {
      out.push({ text: node.nodeValue ?? "" });
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    if (opts.skip?.(el) || this.skip.has(el)) return;
    const tag = tagOf(el);
    switch (tag) {
      case "br":
        out.push(opts.singleLine ? { text: " " } : { br: true });
        return;
      case "img":
      case "script":
      case "style":
      case "template":
        return;
      case "input":
        if ((el.getAttribute("type") ?? "").toLowerCase() === "checkbox") {
          out.push({ text: el.hasAttribute("checked") ? "☒" : "☐" });
        }
        return;
      case "a": {
        const href = el.getAttribute("href") ?? "";
        if (this.backRe.test(href)) return; // the "↑" back-link of a note body
        const ref = this.refRe.exec(href);
        if (ref && /^\[\d+\]$/.test((el.textContent ?? "").trim())) {
          if (!this.inNote) {
            const markup = this.noteRef(ref[2] as "footnote" | "endnote", ref[1]);
            if (markup) out.push({ markup });
          }
          return;
        }
        break;
      }
    }
    const blockish = BLOCK_TAGS.has(tag);
    if (blockish && opts.singleLine) out.push({ text: " " });
    for (const child of childNodes(el)) this.collect(child, out, opts);
    if (blockish) out.push(opts.singleLine ? { text: " " } : { br: true });
  }

  private lines(el: Element, opts: InlineOpts = {}): string[] {
    const segments: Segment[] = [];
    for (const child of childNodes(el)) this.collect(child, segments, opts);
    return segmentsToLines(segments, this.placeholders);
  }

  private oneLine(el: Element, opts: InlineOpts = {}): string {
    return this.lines(el, { ...opts, singleLine: true }).join(" ");
  }

  /** A note reference: allocate our label, queue the definition for the current block. */
  private noteRef(kind: "footnote" | "endnote", id: string): string | null {
    const note = this.notes.get(id) ?? null;
    if (!note) return null; // mammoth always emits the body; without one there is nothing to cite
    const label = kind === "footnote" ? footnoteLabel(++this.footnotes) : endnoteLabel(++this.endnotes, this.endnoteTotal);
    this.pending.push({ label, note });
    return `[^${label}]`;
  }

  // ── blocks

  private push(block: string): void {
    this.blocks.push(block);
  }

  /** Write the definitions cited by the block just written, as one block right after it. */
  private flush(): void {
    if (!this.pending.length) return;
    const lines: string[] = [];
    const overflow: string[] = [];
    this.inNote = true;
    for (const { label, note } of this.pending) {
      const paragraphs = note ? this.noteParagraphs(note) : [];
      const rendered = definitionLines(label, paragraphs);
      lines.push(...rendered.lines);
      if (rendered.overflow.length) {
        this.overflowedNotes++;
        overflow.push(...rendered.overflow.map(escapeLineStart));
      }
    }
    this.inNote = false;
    this.pending = [];
    this.push(lines.join("\n"));
    if (overflow.length) this.push(overflow.join("\n"));
  }

  /** Paragraphs of a note body (one per block child), back-link removed. */
  private noteParagraphs(li: Element): string[] {
    const blocks = Array.from(li.children).filter((c) => BLOCK_TAGS.has(tagOf(c)));
    if (!blocks.length) return [this.oneLine(li)].filter(Boolean);
    return blocks.map((b) => this.oneLine(b)).filter(Boolean);
  }

  /** Emit a paragraph block from lines (already escaped), plus its notes. */
  private paragraph(lines: string[], prefix = ""): void {
    if (!lines.length) {
      this.flush();
      return;
    }
    const out: string[] = [];
    lines.forEach((line, i) => {
      const text = i === 0 && prefix ? prefix + line : escapeLineStart(line);
      out.push(...wrapLongLine(text));
    });
    this.push(out.join("\n"));
    this.flush();
  }

  private heading(level: number, text: string): void {
    if (!text) {
      this.flush();
      return;
    }
    if (text.length > DMD_LIMITS.maxHeadingChars) return this.paragraph([text]);
    this.push(`${"#".repeat(level)} ${text}`);
    this.headings++;
    this.flush();
  }

  /** Walk sibling nodes as blocks (with one-paragraph lookahead for split article headings). */
  walk(nodes: Node[]): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === TEXT_NODE) {
        const text = (node.nodeValue ?? "").trim();
        if (text) this.paragraph(segmentsToLines([{ text }], this.placeholders));
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const el = node as Element;
      if (this.skip.has(el)) continue;
      const tag = tagOf(el);

      if (HEADING_TAGS.has(tag)) {
        this.heading(Number(tag[1]), this.oneLine(el));
      } else if (tag === "p") {
        i += this.paragraphOrHeading(el, nodes, i);
      } else if (LIST_TAGS.has(tag)) {
        this.list(el);
      } else if (tag === "table") {
        this.table(el);
      } else if (tag === "img" || tag === "script" || tag === "style" || tag === "template") {
        continue;
      } else if (Array.from(el.children).some((c) => BLOCK_TAGS.has(tagOf(c)))) {
        this.walk(childNodes(el)); // a wrapper (div, blockquote…): its blocks
      } else {
        this.paragraph(this.lines(el));
      }
    }
    this.flush();
  }

  /** A <p>: pattern heading (possibly with its title on the next paragraph) or a paragraph. Returns extra nodes consumed. */
  private paragraphOrHeading(el: Element, nodes: Node[], i: number): number {
    const { plain, allBold } = this.inspect(el);
    const level = allBold ? patternHeadingLevel(plain) : null;
    if (level === null) {
      this.paragraph(this.lines(el));
      return 0;
    }
    let text = this.oneLine(el);
    let consumed = 0;
    if (designatorOnly(plain)) {
      // "Čl. I" + "Předmět smlouvy" on the next (bold, short) line → one heading.
      let j = i + 1;
      while (j < nodes.length && nodes[j].nodeType === TEXT_NODE && !(nodes[j].nodeValue ?? "").trim()) j++;
      const next = nodes[j];
      if (next && tagOf(next) === "p") {
        const title = this.inspect(next as Element);
        if (
          title.allBold &&
          title.plain.length <= MAX_PATTERN_HEADING &&
          /\p{L}/u.test(title.plain) &&
          !/[,;:]$/.test(title.plain) &&
          patternHeadingLevel(title.plain) === null
        ) {
          text = `${text} – ${this.oneLine(next as Element)}`;
          consumed = j - i;
        }
      }
    }
    this.heading(level, text);
    return consumed;
  }

  private list(el: Element): void {
    const ordered = tagOf(el) === "ol";
    for (const item of Array.from(el.children)) {
      if (tagOf(item) !== "li") {
        this.walk([item]);
        continue;
      }
      const nested = (c: Element) => LIST_TAGS.has(tagOf(c)) || tagOf(c) === "table";
      const lines = this.lines(item, { skip: nested });
      if (lines.length) {
        if (ordered) this.orderedItems++;
        this.paragraph(lines, ordered ? "" : "- ");
      }
      const children = Array.from(item.children).filter(nested);
      if (children.length) this.walk(children);
    }
  }

  private table(el: Element): void {
    const rows: Element[] = [];
    for (const child of Array.from(el.children)) {
      const tag = tagOf(child);
      if (tag === "tr") rows.push(child);
      else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
        for (const tr of Array.from(child.children)) if (tagOf(tr) === "tr") rows.push(tr);
      }
    }
    const cellsOf = (tr: Element) => Array.from(tr.children).filter((c) => tagOf(c) === "td" || tagOf(c) === "th");

    // A one-column table is page layout (a framed box), not data: its content as blocks.
    if (rows.every((tr) => cellsOf(tr).length <= 1)) {
      for (const tr of rows) for (const cell of cellsOf(tr)) this.walk(childNodes(cell));
      return;
    }

    const grid: string[][] = [];
    for (const tr of rows) {
      const row: string[] = [];
      for (const cell of cellsOf(tr)) {
        row.push(this.oneLine(cell).replace(/\|/g, "\\|"));
        const span = Math.min(50, Math.max(1, Number(cell.getAttribute("colspan")) || 1));
        for (let k = 1; k < span; k++) row.push("");
      }
      if (row.some((c) => c)) grid.push(row);
    }
    if (!grid.length) {
      this.flush();
      return;
    }
    const width = Math.max(...grid.map((r) => r.length));
    const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`.replace(/ {2,}/g, " ");
    const lines = [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)];
    if (lines.some((l) => l.length > MAX_LINE_CHARS)) {
      // A row too long for one line: keep the text, one line per row, as a
      // single block so the cells' notes still follow all their references.
      this.paragraph(grid.map((row) => row.filter(Boolean).join(" · ")));
      return;
    }
    this.push(lines.join("\n"));
    this.flush();
  }
}

/**
 * Walk mammoth's HTML (a detached DOM subtree) and write DMD: headings
 * (h1–h6, and short bold "Čl. / Článek / § / ČÁST …" paragraphs), paragraphs,
 * lists (unordered items as "- …"; ordered ones lose their number, counted
 * in `orderedItems`), GFM table rows, and footnote/endnote references
 * relabelled (1..n; i, ii …) with each definition placed right after the
 * block that cites it. Text that imitates DMD markup is escaped and template
 * placeholders are normalized. Never mutates or attaches the tree. Pure.
 */
export function htmlToDmd(root: ParentNode, opts: { idPrefix?: string } = {}): HtmlToDmdResult {
  const walker = new Walker(root, opts.idPrefix ?? DOCX_ID_PREFIX);
  walker.walk(childNodes(root as unknown as Node));
  const dmd = walker.blocks.join("\n\n");
  return {
    dmd,
    footnotes: walker.footnotes,
    endnotes: walker.endnotes,
    headings: walker.headings,
    placeholders: countPlaceholders(dmd),
    orderedItems: walker.orderedItems,
    letterEndnotes: walker.letterEndnotes && walker.endnotes > 0,
    overflowedNotes: walker.overflowedNotes,
  };
}

// ─────────────────────────────────────────────────────────── mammoth

/** The few fields of mammoth's document model the pre-pass reads. */
interface MammothElement {
  type: string;
  children?: MammothElement[];
  styleName?: string | null;
  numbering?: { isOrdered: boolean; level: string } | null;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Heading level implied by a paragraph style name mammoth does not map by
 * itself: "Nadpis 1" / "heading1" / "Nadpis 2 – vlastní" → N, "Název" /
 * "Title" / "Kapitola" / "Část" / "Hlava" → 1, "Článek" / "Díl" / "Oddíl"
 * → 2; null for everything else. Pure.
 */
export function headingLevelForStyle(name: string | null | undefined): number | null {
  if (!name) return null;
  const f = fold(name);
  const numbered = /^(?:heading|nadpis) ?([1-6])(?=\s|$|[^\d])/.exec(f);
  if (numbered) return Number(numbered[1]);
  if (/^(?:title|nazev|kapitola|cast|hlava)$/.test(f)) return 1;
  if (/^(?:clanek|cl\.?|dil|oddil|nadpis clanku)$/.test(f)) return 2;
  return null;
}

interface PrepassStats {
  orderedParagraphs: number;
  images: number;
}

/** transformDocument: count auto-numbered paragraphs and images; map Czech heading styles to mammoth's. */
function prepareDocument(element: MammothElement, stats: PrepassStats): MammothElement {
  if (element.type === "image") stats.images++;
  if (element.type === "paragraph") {
    if (element.numbering?.isOrdered) stats.orderedParagraphs++;
    const level = headingLevelForStyle(element.styleName);
    if (level !== null) element.styleName = `Heading ${level}`;
  }
  for (const child of element.children ?? []) prepareDocument(child, stats);
  return element;
}

type Mammoth = typeof import("mammoth");
type MammothOptions = NonNullable<Parameters<Mammoth["convertToHtml"]>[1]>;

async function loadMammoth(): Promise<Mammoth> {
  const mod = (await import("mammoth")) as Mammoth & { default?: Mammoth };
  return mod.default ?? mod;
}

/**
 * Convert a .docx (or .docm / .dotx) to DMD. `opts` is accepted for the
 * common converter signature; the layout switches are PDF-only (DOCX notes,
 * headings and paragraphs are explicit, nothing is guessed from geometry).
 * Throws ConvertError('broken') when mammoth cannot read the file and
 * ConvertError('unsupported') outside a DOM environment.
 */
export async function convertDocx(data: ArrayBuffer, opts: ConvertOptions): Promise<ConvertResult> {
  void opts;
  if (typeof DOMParser === "undefined") {
    throw new ConvertError("unsupported", "Převod DOCX běží jen v prohlížeči.");
  }
  const mammoth = await loadMammoth();
  const stats: PrepassStats = { orderedParagraphs: 0, images: 0 };
  const options = {
    idPrefix: DOCX_ID_PREFIX,
    externalFileAccess: false,
    includeDefaultStyleMap: true,
    styleMap: DOCX_STYLE_MAP,
    // Images are dropped without reading their bytes (no <img> at all).
    convertImage: (() => Promise.resolve([])) as unknown as MammothOptions["convertImage"],
    transformDocument: (doc: MammothElement) => prepareDocument(doc, stats),
  } satisfies MammothOptions;
  // Browser build reads `arrayBuffer`; the node build (tests) reads `buffer` (JSZip takes an ArrayBuffer).
  const input = { arrayBuffer: data, buffer: data } as unknown as Parameters<Mammoth["convertToHtml"]>[0];

  let html: string;
  try {
    html = (await mammoth.convertToHtml(input, options)).value;
  } catch {
    throw new ConvertError("broken", "Dokument DOCX se nepodařilo přečíst — soubor je poškozený, nebo to není dokument Wordu.");
  }

  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`, "text/html");
  const out = htmlToDmd(doc.body);
  return unpagedResult({
    kind: "docx",
    converter: "docx@1",
    dmd: out.dmd,
    quality: docxQuality(out, stats.orderedParagraphs),
    warnings: docxWarnings(out, stats),
  });
}

function docxQuality(out: HtmlToDmdResult, orderedParagraphs: number): ConversionQuality {
  const notes = out.footnotes + out.endnotes;
  return {
    footnotes: notes ? "linked" : "none",
    linked_ratio: notes ? 1 : 0,
    columns_pages: 0,
    headings_from: out.headings ? "docx" : "none",
    mn: 0,
    numbering: orderedParagraphs + out.orderedItems > 0 ? "lost" : "ok",
    unsure_pages: [],
  };
}

function docxWarnings(out: HtmlToDmdResult, stats: PrepassStats): string[] {
  const warnings: string[] = [];
  // The pre-pass sees every numbered paragraph (headings included); the walker only list items.
  const lost = Math.max(stats.orderedParagraphs, out.orderedItems);
  if (lost) {
    warnings.push(
      `Automatické číslování (např. „Čl. III", „3.2") se z DOCX nepřevádí — ${lost} ${plural(lost, "odstavci nebo nadpisu", "odstavcům nebo nadpisům", "odstavcům nebo nadpisům")} chybí ${lost === 1 ? "jeho číslo" : "jejich čísla"}. Pokud budete citovat podle článků, uložte dokument jako PDF a nahrajte PDF.`,
    );
  }
  if (stats.images) {
    warnings.push(`${stats.images} ${plural(stats.images, "obrázek se nepřevádí", "obrázky se nepřevádějí", "obrázků se nepřevádí")} — text v nich nebude prohledávatelný.`);
  }
  if (out.letterEndnotes) {
    warnings.push(`Vysvětlivek je víc než ${MAX_ROMAN_ENDNOTES}, proto jsou označené písmeny a, b, c… místo římských číslic.`);
  }
  if (out.overflowedNotes) {
    warnings.push(
      `${out.overflowedNotes} ${plural(out.overflowedNotes, "poznámka je", "poznámky jsou", "poznámek je")} delší než ${formatCount(DMD_LIMITS.maxFootnoteChars)} znaků — zbytek je za poznámkou jako běžný text.`,
    );
  }
  return warnings;
}
