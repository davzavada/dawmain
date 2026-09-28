/**
 * The PDF layout engine: pdf.js text items of every page → normalized DMD
 * with the conversion's quality report. This is where a PDF's typography
 * becomes structure — pages and their printed numbers, paragraphs, split
 * words, headings, marginal numbers, footnotes bound to their references —
 * so every stage prefers leaving text as text (with a page flag and a
 * Czech warning for the preview) to guessing: text is never dropped,
 * except page furniture (running heads, page numbers — kept as hints) and
 * watermarks (removed, never indexed, never kept).
 *
 * Stages (each in its own module):
 *  geometry.ts  rows, superscripts, body size / line spacing, text edges,
 *               marginal numbers, the two-column split, lines;
 *  zones.ts     running heads & footers by geometry, printed page numbers,
 *               watermarks;
 *  labels.ts    page labels (calibration › /PageLabels › printed › physical);
 *  footnotes.ts footnote size, zones, notes, references, binding;
 *  headings.ts  outline › style › patterns, § order, levels, statute quotes;
 *  emit.ts      paragraphs, dehyphenation, definitions, marginal numbers,
 *               escaping → DMD.
 * An OCR'd text layer (flag from the adapter, GlyphLessFont, jittering
 * sizes) or the "prostý text" option switches to plain mode: pages,
 * paragraphs and dehyphenation only. A file without a usable text layer is
 * rejected with ConvertError("scan").
 *
 * Pure — no pdf.js here (see ./pdfjs.ts); unit-tested with synthetic pages
 * (tests/files-convert-pdf-layout.test.ts) and real generated PDFs
 * (tests/files-convert-pdf-pdfjs.test.ts).
 */

import { sanitizeLine, normalizeDmd } from "../../dmd/normalize";
import { DMD_LIMITS, PAGE_FLAGS } from "../../dmd/types";
import type { ConversionQuality, UploadHints } from "../../types";
import { ConvertError, type ConvertOptions, type ConvertResult, type PageZone } from "../types";
import { emitDmd } from "./emit";
import { collectRefs, footnoteSize, resolvePageNotes, zoneCandidates } from "./footnotes";
import { bodyStats, buildRows, buildSegments, hyphenDictionary, splitColumns, takeMarginNumbers, textEdges } from "./geometry";
import { detectHeadings } from "./headings";
import { computeLabels } from "./labels";
import type { Line, Note, PageModel, Part, Row } from "./model";
import { endsTerminal, foldText, labelList, pagesLoc, plural, privateUseCount, stopwordRatio } from "./text";
import type { PdfDocInput } from "./types";
import { detectFurniture, detectWatermarks, type PrintedNumber } from "./zones";

export type { PdfDocInput, PdfItem, PdfOutlineEntry, PdfPageInput } from "./types";

/** Converter id stored with the document; bump when the output changes materially. */
export const PDF_CONVERTER = "pdf@1";

/** Minimum characters for a page to count as having text (scan check). */
const SPARSE_CHARS = 40;

/**
 * Lay out a whole PDF as DMD. Throws ConvertError: "broken" (no pages, a
 * page range outside the document), "too_large" (> 1 500 pages to keep),
 * "scan" (> 30 % of the kept pages under 40 characters, a text layer of
 * unmapped glyphs, or text with almost no stop words). Pure.
 */
export function layoutToDmd(doc: PdfDocInput, opts: ConvertOptions): ConvertResult {
  const count = doc.pages.length;
  if (!count) throw new ConvertError("broken", "PDF neobsahuje žádné strany.");
  const [from, to] = keptRange(opts.pageRange, count);
  if (to - from + 1 > DMD_LIMITS.maxPages) {
    throw new ConvertError(
      "too_large",
      `Vybraný rozsah má ${to - from + 1} stran, najednou lze nahrát nejvýš ${DMD_LIMITS.maxPages}. Zvolte menší rozsah stran.`,
    );
  }
  const kept = (ord: number) => ord >= from && ord <= to;

  // ── rows and the scan check
  const pageRows = doc.pages.map((p, i) => {
    const page = { ...p, ord: i + 1 };
    const r = buildRows(page);
    return { ord: page.ord, width: page.width, height: page.height, rows: r.rows, rotated: r.rotated, rawChars: r.rawChars, rawText: r.rawText };
  });
  scanCheck(pageRows.filter((p) => kept(p.ord)));
  const rotated = pageRows.filter((p) => kept(p.ord)).reduce((n, p) => n + p.rotated, 0);

  // ── statistics, OCR
  const stats = bodyStats(pageRows.map((p) => p.rows));
  const ocr = doc.ocr || ocrFonts(doc) || sizeJitter(pageRows.map((p) => p.rows));
  const plain = opts.plain || ocr;

  // ── page furniture, labels, watermarks
  const outlineTitles = new Map<number, Set<string>>();
  for (const e of doc.outline) outlineTitles.set(e.page, (outlineTitles.get(e.page) ?? new Set()).add(foldKey(e.title)));
  const furniture = detectFurniture(pageRows, stats.lineGap, {
    bodySize: stats.bodySize,
    tolerance: ocr ? 3 : 1.5,
    isHeading: (page, text) => outlineTitles.get(page)?.has(foldKey(text)) ?? false,
  });
  const printed = new Map<number, PrintedNumber[]>(furniture.numbers);
  for (const [row, num] of furniture.loose) printed.set(row.page, [...(printed.get(row.page) ?? []), num]);
  const labels = computeLabels({
    count,
    pdfLabels: doc.pageLabels,
    printed,
    textPages: pageRows.filter((p) => p.rows.length).map((p) => p.ord),
    calibration: opts.labelOffset ?? null,
  });
  const drop = new Set<Row>(furniture.removed);
  for (const [row, num] of furniture.loose) {
    const label = labels.labels[row.page - 1];
    if ((num.value !== null && String(num.value) === label) || (num.roman !== null && num.roman === label)) drop.add(row);
  }
  // Preview overlays: what the layout recognised, per physical page.
  const zones: PageZone[][] = pageRows.map(() => []);
  const addZone = (page: number, zone: PageZone) => {
    const list = zones[page - 1];
    if (list && list.length < MAX_ZONES_PER_PAGE) list.push(zone);
  };
  for (const row of drop) {
    const height = pageRows[row.page - 1]?.height ?? 0;
    addZone(row.page, { kind: row.y < height / 2 ? "header" : "footer", ...rowBox(row) });
  }
  for (const p of pageRows) p.rows = p.rows.filter((r) => !drop.has(r));
  const watermarkRows = detectWatermarks(pageRows, new Set());
  for (const p of pageRows) p.rows = p.rows.filter((r) => !watermarkRows.has(r));
  const watermarks = furniture.watermarks + watermarkRows.size;

  // ── columns and lines
  const fnSize = opts.footnotes && !plain ? footnoteSize(pageRows.map((p) => p.rows), stats.bodySize) : null;
  const edgesOf = textEdges(pageRows, stats.bodySize);
  const pages: PageModel[] = [];
  let columnsUnsure = 0;
  const unsurePages = new Set<number>();
  for (const p of pageRows) {
    const edges = edgesOf(p.ord);
    const mns = takeMarginNumbers(p.rows, edges);
    const cols = splitColumns(p.rows, edges, opts.columns !== "single");
    const flags = labels.flags[p.ord - 1] | (cols.columns ? PAGE_FLAGS.COLUMNS : 0);
    if (cols.unsure && kept(p.ord)) {
      columnsUnsure++;
      unsurePages.add(p.ord);
    }
    pages.push({
      ord: p.ord,
      width: p.width,
      height: p.height,
      label: labels.labels[p.ord - 1],
      flags,
      segments: buildSegments(cols, p.ord, mns),
      notes: [],
      endText: [],
      heads: furniture.heads.get(p.ord) ?? [],
      kept: kept(p.ord),
    });
  }

  // ── footnotes
  let labelled = 0;
  let bound = 0;
  let monotonic = true;
  let prev: Note | null = null;
  let prevNoteOnly = false;
  const unboundRefs: Array<Extract<Part, { t: "ref" }>> = [];
  for (const page of pages) {
    if (!page.kept || plain || !opts.footnotes) {
      prev = null;
      prevNoteOnly = false;
      continue;
    }
    // Only a note left open by a real zone may continue on a page of nothing but small type, and only
    // in the page's lower half: never chained, so small-type body pages are not swallowed into a note.
    const lastOfPrev = prev?.lines[prev.lines.length - 1];
    const open = Boolean(lastOfPrev && !endsTerminal(lastOfPrev.plain)) && !prevNoteOnly;
    const cands = fnSize ? zoneCandidates(page.segments, fnSize, stats.lineGap, open ? 0.5 * page.height : null) : [];
    const zoneSet = new Set<Line>(cands.flatMap(([si, k]) => page.segments[si].lines.slice(k)));
    const zone = page.segments.flatMap((s) => s.lines).filter((l) => zoneSet.has(l));
    const body = page.segments.flatMap((s) => s.lines).filter((l) => !zoneSet.has(l));
    const refs = collectRefs(body);
    const res = resolvePageNotes({ page: page.ord, zone, body, refs, prev });
    if (res.zone && zone.length) addZone(page.ord, { kind: "footnotes", ...boundsOf(zone) });
    // A page of nothing but small type taken for a note's continuation: a guess worth a look.
    if (res.zone && zone.length && !body.length && !res.notes.length && !res.endText.length) {
      page.noteOnly = true;
      page.flags |= PAGE_FLAGS.FN_UNSURE;
    }
    if (res.zone) {
      for (const seg of page.segments) seg.lines = seg.lines.filter((l) => !zoneSet.has(l));
      page.segments = page.segments.filter((s) => s.lines.length);
    }
    page.notes = res.notes;
    page.endText = res.endText;
    if (res.unsure) page.flags |= PAGE_FLAGS.FN_UNSURE;
    labelled += res.labelled;
    bound += res.bound;
    if (!res.consecutive) monotonic = false;
    unboundRefs.push(...refs.filter((r) => r.note === null));
    prev = res.notes.length ? res.notes[res.notes.length - 1] : res.zone && !res.unsure ? prev : null;
    prevNoteOnly = Boolean(page.noteOnly);
  }

  // ── headings
  const headings = plain
    ? { from: "none" as const, count: 0, rejectedPar: 0, tocPages: new Set<number>() }
    : detectHeadings(pages, doc.outline.filter((e) => kept(e.page)), stats);

  for (const page of pages) {
    for (const seg of page.segments) for (const l of seg.lines) if (l.heading || l.headingCont) addZone(page.ord, { kind: "heading", ...rowBox(l) });
  }

  // ── emit
  const keptPages = pages.filter((p) => p.kept);
  const bodyLines = keptPages.flatMap((p) => p.segments.flatMap((s) => s.lines));
  const emitted = emitDmd(pages, {
    bodySize: stats.bodySize,
    lineGap: stats.lineGap,
    justified: isJustified(keptPages, stats.bodySize),
    dict: hyphenDictionary(bodyLines),
    marginalNumbers: opts.marginalNumbers && !plain,
  });
  for (const page of keptPages) {
    if (!page.segments.length && !page.endText.length && !page.notes.length && !page.noteOnly) page.flags |= PAGE_FLAGS.BLANK;
    if (page.flags & (PAGE_FLAGS.FN_UNSURE | PAGE_FLAGS.HEADING_UNSURE)) unsurePages.add(page.ord);
  }

  // ── report
  const footnotes: ConversionQuality["footnotes"] =
    !labelled ? "none" : bound / labelled >= 0.9 && monotonic ? "linked" : bound / labelled >= 0.5 ? "partial" : "unsure";
  const quality: ConversionQuality = {
    footnotes,
    linked_ratio: labelled ? Math.round((bound / labelled) * 1000) / 1000 : 0,
    columns_pages: keptPages.filter((p) => p.flags & PAGE_FLAGS.COLUMNS).length,
    headings_from: headings.from,
    mn: emitted.mn,
    ocr,
    unsure_pages: [...unsurePages].sort((a, b) => a - b).slice(0, 500),
  };

  const warnings = buildWarnings({
    ocr,
    plain: opts.plain,
    keptPages,
    fnUnsure: keptPages.filter((p) => (p.flags & PAGE_FLAGS.FN_UNSURE) && !p.noteOnly),
    noteOnly: keptPages.filter((p) => p.noteOnly),
    unboundRefs: unboundRefs.length,
    columnsUnsure,
    labelSource: labels.source,
    guessed: keptPages.filter((p) => p.flags & PAGE_FLAGS.LABEL_GUESSED),
    watermarks,
    rotated,
    rejectedPar: headings.rejectedPar,
    mnRejected: emitted.mnRejected,
    longNotes: emitted.longNotes,
    footnotes,
  });

  return {
    kind: "pdf",
    converter: PDF_CONVERTER,
    dmd: normalizeDmd(emitted.dmd).text,
    quality,
    hints: hintsOf(doc, keptPages),
    labelSource: labels.source,
    physicalPages: count,
    pageFlags: pages.map((p) => p.flags),
    pageLabels: pages.map((p) => p.label),
    pageZones: zones,
    warnings,
  };
}

/** Overlay rectangles per page (a page of many headings stays bounded). */
const MAX_ZONES_PER_PAGE = 80;

/** The box of one row or line: from about the cap height above the baseline to the descenders. */
function rowBox(r: { x0: number; x1: number; y: number; size: number }): Omit<PageZone, "kind"> {
  return { x0: r.x0, y0: r.y - r.size, x1: Math.max(r.x1, r.x0 + 1), y1: r.y + 0.3 * r.size };
}

/** The box around several lines. */
function boundsOf(lines: ReadonlyArray<{ x0: number; x1: number; y: number; size: number }>): Omit<PageZone, "kind"> {
  const boxes = lines.map(rowBox);
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Folded letters and digits only — for comparing outline titles with lines. */
function foldKey(s: string): string {
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The 1-based inclusive range of physical pages to keep. */
function keptRange(range: ConvertOptions["pageRange"], count: number): [number, number] {
  if (!range) return [1, count];
  const a = Math.max(1, Math.floor(Math.min(range[0], range[1])));
  const b = Math.min(count, Math.floor(Math.max(range[0], range[1])));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) {
    throw new ConvertError("broken", `Zvolený rozsah stran je mimo dokument (PDF má ${count} stran).`);
  }
  return [a, b];
}

/**
 * Reject a file without a usable text layer: > 30 % of the pages under 40
 * characters (a scan), > 20 % of the pages mostly private-use glyphs
 * (fonts without a Unicode mapping), or ≥ 300 words with < 3 % stop words
 * (garbage text).
 */
function scanCheck(pages: Array<{ rawChars: number; rawText: string }>): void {
  if (!pages.length) return;
  const sparse = pages.filter((p) => p.rawChars < SPARSE_CHARS).length;
  if (sparse > 0.3 * pages.length) {
    throw new ConvertError(
      "scan",
      `PDF nemá textovou vrstvu — ${sparse === pages.length ? "žádná strana" : `${sparse} z ${pages.length} stran`} neobsahuje text (sken). Nahrajte verzi s textovou vrstvou, např. po OCR.`,
    );
  }
  const broken = pages.filter((p) => p.rawChars && privateUseCount(p.rawText) > 0.2 * p.rawChars).length;
  if (broken > 0.2 * pages.length) {
    throw new ConvertError("scan", "Textová vrstva PDF je poškozená (písmo bez převodu na znaky). Nahrajte jinou verzi souboru, případně po OCR.");
  }
  const sample = pages.map((p) => p.rawText).join(" ").slice(0, 400_000);
  const { ratio, tokens } = stopwordRatio(sample);
  if (tokens >= 300 && ratio < 0.03) {
    throw new ConvertError("scan", "Text v PDF není čitelný (poškozené kódování písma nebo nekvalitní OCR). Nahrajte verzi s kvalitní textovou vrstvou.");
  }
}

/** A font without glyph outlines named by OCR engines ("GlyphLessFont"). */
function ocrFonts(doc: PdfDocInput): boolean {
  return doc.pages.some((p) => p.items.some((it) => /glyphless/i.test(it.font)));
}

/** OCR layers give every word its own, slightly different size: many rows with jittering sizes. */
function sizeJitter(pages: Row[][]): boolean {
  let rows = 0;
  let jitter = 0;
  for (const row of pages.flat()) {
    const sizes = row.runs.filter((r) => !r.sup).map((r) => r.size);
    if (sizes.length < 3) continue;
    rows++;
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const sd = Math.sqrt(sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length);
    if (mean > 0 && sd / mean > 0.06) jitter++;
  }
  return rows >= 20 && jitter >= 0.3 * rows;
}

/** Most body lines (not the last of their column) reach the right edge. */
function isJustified(pages: PageModel[], bodySize: number): boolean {
  let lines = 0;
  let full = 0;
  for (const page of pages) {
    for (const seg of page.segments) {
      for (let i = 0; i + 1 < seg.lines.length; i++) {
        const l = seg.lines[i];
        if (l.heading || Math.abs(l.size - bodySize) > 0.6) continue;
        lines++;
        if (l.x1 >= l.colRight - l.size) full++;
      }
    }
  }
  return lines > 0 && full >= 0.6 * lines;
}

const INFO_KEYS = ["title", "author", "subject", "keywords", "producer", "creator"] as const;

function hintsOf(doc: PdfDocInput, pages: PageModel[]): UploadHints {
  const hints: UploadHints = {};
  const info: NonNullable<UploadHints["pdf_info"]> = {};
  for (const [k, v] of Object.entries(doc.info ?? {})) {
    const key = k.toLowerCase() as (typeof INFO_KEYS)[number];
    if (!INFO_KEYS.includes(key) || typeof v !== "string") continue;
    const clean = sanitizeLine(v, 300);
    if (clean) info[key] = clean;
  }
  if (Object.keys(info).length) hints.pdf_info = info;
  const seen = new Set<string>();
  const heads: Array<{ page: number; text: string }> = [];
  for (const page of pages) {
    for (const raw of page.heads) {
      const text = sanitizeLine(raw, 120);
      if (!text || seen.has(text) || heads.length >= 200) continue;
      seen.add(text);
      heads.push({ page: page.ord, text });
    }
  }
  if (heads.length) hints.running_heads = heads;
  return hints;
}

function buildWarnings(w: {
  ocr: boolean;
  plain: boolean;
  keptPages: PageModel[];
  fnUnsure: PageModel[];
  noteOnly: PageModel[];
  unboundRefs: number;
  columnsUnsure: number;
  labelSource: string;
  guessed: PageModel[];
  watermarks: number;
  rotated: number;
  rejectedPar: number;
  mnRejected: number;
  longNotes: number;
  footnotes: ConversionQuality["footnotes"];
}): string[] {
  const out: string[] = [];
  if (w.ocr) {
    out.push("Soubor má textovou vrstvu z OCR: převedeno jako prostý text (strany, odstavce, dělení slov) — bez poznámek pod čarou, nadpisů a marginálních čísel.");
  } else if (w.plain) {
    out.push("Prostý text: převedeny jen strany, odstavce a dělení slov — bez poznámek pod čarou, nadpisů a marginálních čísel.");
  }
  if (w.fnUnsure.length) {
    out.push(
      `Na ${pagesLoc(w.fnUnsure.length)} nebyly poznámky pod čarou spolehlivě rozpoznány (s. ${labelList(w.fnUnsure.map((p) => p.label))}) — jejich text zůstane na konci strany nebo jako poznámka bez odkazu.`,
    );
  }
  if (w.noteOnly.length) {
    const labels = labelList(w.noteOnly.map((p) => p.label));
    out.push(
      `${w.noteOnly.length === 1 ? `Strana ${labels} obsahovala` : `Strany ${labels} obsahovaly`} jen drobné písmo v dolní části — text byl připojen k poznámce pod čarou z předchozí strany. Zkontrolujte ho v náhledu.`,
    );
  }
  if (w.footnotes === "unsure" && !w.fnUnsure.length) out.push("Poznámky pod čarou se podařilo spárovat s odkazy jen zčásti — zkontrolujte je v náhledu.");
  if (w.unboundRefs) out.push(`Odkazy na poznámku, které se nepodařilo spárovat — v textu zůstanou jako horní index: ${w.unboundRefs}.`);
  const columns = w.keptPages.filter((p) => p.flags & PAGE_FLAGS.COLUMNS);
  if (columns.length) {
    out.push(`Dvousloupcová sazba na ${pagesLoc(columns.length)}${w.columnsUnsure ? ` (na ${pagesLoc(w.columnsUnsure)} nejistá)` : ""} — pořadí čtení zkontrolujte v náhledu.`);
  }
  if (w.labelSource === "physical" && w.keptPages.length > 1) {
    out.push("Tištěná čísla stran se nepodařilo zjistit — citace ponesou pořadí strany v PDF. Znáte-li číslo první strany, nastavte ho v náhledu („PDF s. 1 = tištěná s. …“).");
  }
  if (w.labelSource === "printed" && w.guessed.length) {
    out.push(`Číslo strany je dopočítané na ${pagesLoc(w.guessed.length)} (s. ${labelList(w.guessed.map((p) => p.label))}).`);
  }
  if (w.watermarks) out.push(`Odstraněné řádky s vodoznakem (např. jméno nebo e-mail kupujícího) — nebudou v textu ani v indexu: ${w.watermarks}.`);
  if (w.rotated) out.push(`Vynechaný otočený text (obvykle vodoznak nebo text na okraji strany): ${plural(w.rotated, "úsek", "úseky", "úseků")}.`);
  if (w.rejectedPar) out.push(`Nadpisy „§“, které nenavazovaly na předchozí číslování, zůstaly jako text: ${w.rejectedPar}.`);
  if (w.mnRejected) out.push(`Marginální čísla, která nenavazovala na předchozí, zůstala jako text: ${w.mnRejected}.`);
  if (w.longNotes) out.push(`Velmi dlouhé poznámky rozdělené na poznámku a běžný odstavec: ${w.longNotes}.`);
  return out;
}
