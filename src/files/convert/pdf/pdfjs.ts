/**
 * pdf.js adapter: an ArrayBuffer with a PDF → PdfDocInput, the plain data
 * the layout engine (./layout.ts) works on. Runs in the browser (the
 * upload preview, pdf.js in its own Web Worker) and in node (tests; pdf.js
 * then uses its in-process "fake worker").
 *
 * - The LEGACY build: the modern one calls very new JavaScript APIs
 *   without guards and breaks on the managed, older browsers law firms run.
 * - getDocument({ data, disableFontFace }) — `isEvalSupported` no longer
 *   exists in pdf.js 6.3. The data is copied first: pdf.js transfers (and
 *   so detaches) the buffer it gets, and the preview re-runs conversions
 *   on the same file. (The upload's SHA-256 is computed before any of
 *   this, in src/files/convert/index.ts.)
 * - Password / DRM → ConvertError("encrypted"); unreadable → "broken".
 * - Coordinates: every text matrix is mapped through the page viewport
 *   (scale 1), so rotated pages and odd crop boxes come out as displayed.
 * - Fonts: getTextContent exposes only pdf.js's internal font ids. Real
 *   names and the bold flag live on the font objects that reach
 *   `commonObjs` only through getOperatorList(), so that runs on ≤ 15
 *   sampled pages and the names are mapped onto every page's items.
 * - OCR layers: Producer / Creator of an OCR tool or scanner, or a
 *   GlyphLessFont in the sampled fonts, set `ocr` (the layout switches to
 *   plain mode; it also detects jittering sizes on its own).
 * - Each page is released (page.cleanup()) as soon as it has been read.
 */

import { sanitizeLine } from "../../dmd/normalize";
import { ConvertError } from "../types";
import type { PdfDocInput, PdfItem, PdfOutlineEntry, PdfPageInput } from "./types";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;
type PDFPageProxy = import("pdfjs-dist").PDFPageProxy;
type PageViewport = import("pdfjs-dist").PageViewport;

/** Pages whose operator list is read for real font names and bold flags. */
const FONT_SAMPLE_PAGES = 15;
const MAX_OUTLINE_ENTRIES = 5_000;
const OCR_PRODUCER_RE =
  /abbyy|finereader|ocrmypdf|tesseract|paper capture|omnipage|readiris|scansnap|kofax|nuance|canon|ricoh|konica|kyocera|xerox|epson|scanner|scan to pdf/i;
const BOLD_NAME_RE = /bold|black|heavy|semibold|demi/i;

let loaded: Promise<PdfJs> | null = null;

/** Load pdf.js once; in the browser give it its own module worker. */
function loadPdfJs(): Promise<PdfJs> {
  loaded ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    if (typeof window !== "undefined" && typeof Worker !== "undefined" && !pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), {
        type: "module",
      });
    }
    return pdfjs;
  }).catch((err: unknown) => {
    loaded = null;
    throw err;
  });
  return loaded;
}

/**
 * Read every page's text items, the page labels, the outline and the info
 * dictionary. With `pageRange`, pages outside it are listed with their size
 * but no items (their labels still come from /PageLabels or the printed
 * offset). `onProgress(done, total)` after each page.
 */
export async function readPdf(
  data: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
  opts: { pageRange?: [number, number] | null } = {},
): Promise<PdfDocInput> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    throw openError(err);
  }
  try {
    return await readDocument(pdfjs, pdf, onProgress, opts.pageRange ?? null);
  } finally {
    await task.destroy().catch(() => {});
  }
}

function openError(err: unknown): ConvertError {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") {
    return new ConvertError("encrypted", "PDF je chráněné heslem nebo DRM. Nahrajte verzi bez ochrany.");
  }
  if (name === "InvalidPDFException") return new ConvertError("broken", "Soubor není platné PDF nebo je poškozený.");
  return new ConvertError("broken", "PDF se nepodařilo otevřít — soubor je poškozený nebo v nepodporované podobě.");
}

async function readDocument(
  pdfjs: PdfJs,
  pdf: PDFDocumentProxy,
  onProgress: ((done: number, total: number) => void) | undefined,
  range: [number, number] | null,
): Promise<PdfDocInput> {
  const total = pdf.numPages;
  const from = range ? Math.max(1, Math.min(range[0], range[1])) : 1;
  const to = range ? Math.min(total, Math.max(range[0], range[1])) : total;

  const [labels, meta, outlineRaw] = await Promise.all([
    pdf.getPageLabels().catch(() => null),
    pdf.getMetadata().catch(() => null),
    readOutline(pdf).catch(() => []),
  ]);

  const info: Record<string, string> = {};
  for (const [k, v] of Object.entries((meta?.info ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) info[k] = v;
  }
  let ocr = OCR_PRODUCER_RE.test(`${info.Producer ?? ""} ${info.Creator ?? ""}`);

  const sampled = new Set<number>();
  const span = to - from + 1;
  for (let k = 0; k < Math.min(FONT_SAMPLE_PAGES, span); k++) sampled.add(from + Math.floor((k * span) / Math.min(FONT_SAMPLE_PAGES, span)));
  const fonts = new Map<string, { name: string; bold: boolean }>();

  const pages: PdfPageInput[] = [];
  const viewports = new Map<number, PageViewport>();
  for (let ord = 1; ord <= total; ord++) {
    let page: PDFPageProxy | null = null;
    let size = { width: 595, height: 842 };
    try {
      page = await pdf.getPage(ord);
      const viewport = page.getViewport({ scale: 1 });
      viewports.set(ord, viewport);
      size = { width: round(viewport.width), height: round(viewport.height) };
      const items = ord >= from && ord <= to ? await pageItems(pdfjs, page, viewport) : [];
      if (sampled.has(ord)) {
        if (await sampleFonts(pdfjs, page, fonts)) ocr = true;
      }
      pages.push({ ord, ...size, items });
    } catch {
      // An unreadable page stays in the document (the page count and labels must hold), empty.
      pages.push({ ord, ...size, items: [] });
    } finally {
      try {
        page?.cleanup();
      } catch {
        // Releasing is best effort.
      }
    }
    onProgress?.(ord, total);
  }

  for (const page of pages) {
    for (const item of page.items) {
      const known = fonts.get(item.font);
      if (known) {
        item.font = known.name || item.font;
        item.bold = known.bold;
      } else if (BOLD_NAME_RE.test(item.font)) item.bold = true;
    }
  }

  const outline: PdfOutlineEntry[] = [];
  for (const e of outlineRaw) {
    const vp = viewports.get(e.page);
    const y = e.top !== null && vp ? round(vp.convertToViewportPoint(0, e.top)[1]) : null;
    outline.push({ title: e.title, page: e.page, y, level: e.level });
  }

  return { pages, pageLabels: labels && labels.length === total ? labels.map(String) : null, outline, info, ocr };
}

/** Text items of a page in viewport space. */
async function pageItems(pdfjs: PdfJs, page: PDFPageProxy, viewport: PageViewport): Promise<PdfItem[]> {
  const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
  const items: PdfItem[] = [];
  for (const it of content.items) {
    if (!("str" in it) || !it.str || !it.str.trim()) continue;
    const m = pdfjs.Util.transform(viewport.transform, it.transform) as number[];
    const size = Math.hypot(m[2], m[3]);
    const rotated = it.dir === "ttb" || m[0] <= 0 || Math.abs(m[1]) > 0.05 * Math.abs(m[0]);
    items.push({
      str: it.str,
      x: round(m[4]),
      y: round(m[5]),
      w: round(it.width),
      h: round(it.height),
      size: round(size),
      font: it.fontName,
      ...(rotated ? { rotated: true } : {}),
    });
  }
  return items;
}

/** Real font names and bold flags of the fonts a sampled page sets; true when one is an OCR GlyphLessFont. */
async function sampleFonts(pdfjs: PdfJs, page: PDFPageProxy, fonts: Map<string, { name: string; bold: boolean }>): Promise<boolean> {
  let glyphless = false;
  try {
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== pdfjs.OPS.setFont) continue;
      const id = (ops.argsArray[i] as unknown[] | undefined)?.[0];
      if (typeof id !== "string" || fonts.has(id) || !page.commonObjs.has(id)) continue;
      const font = page.commonObjs.get(id) as { name?: unknown; bold?: unknown } | null;
      const name = cleanFontName(typeof font?.name === "string" ? font.name : "");
      if (/glyphless/i.test(name)) glyphless = true;
      fonts.set(id, { name, bold: font?.bold === true || BOLD_NAME_RE.test(name) });
    }
  } catch {
    // Font names are an optimisation; the layout works without them.
  }
  return glyphless;
}

/** "ABCDEF+Minion-Bold" → "Minion-Bold". Pure. */
export function cleanFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "").trim();
}

/** The outline flattened in order, each destination resolved to (page, top in PDF user space). */
async function readOutline(pdf: PDFDocumentProxy): Promise<Array<{ title: string; page: number; top: number | null; level: number }>> {
  const tree = await pdf.getOutline();
  const out: Array<{ title: string; page: number; top: number | null; level: number }> = [];
  type Node = { title: string; dest: string | unknown[] | null; items: Node[] };
  const visit = async (nodes: Node[], level: number) => {
    for (const node of nodes) {
      if (out.length >= MAX_OUTLINE_ENTRIES) return;
      const target = await resolveDest(pdf, node.dest).catch(() => null);
      const title = sanitizeLine(node.title ?? "", 300);
      if (target && title) out.push({ title, page: target.page, top: target.top, level });
      if (level < 5 && node.items?.length) await visit(node.items, level + 1);
    }
  };
  await visit((tree ?? []) as Node[], 0);
  return out;
}

async function resolveDest(pdf: PDFDocumentProxy, dest: string | unknown[] | null): Promise<{ page: number; top: number | null } | null> {
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const ref = explicit[0];
  let index: number;
  if (typeof ref === "number") index = ref;
  else if (ref && typeof ref === "object" && "num" in ref) index = await pdf.getPageIndex(ref as { num: number; gen: number });
  else return null;
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const top = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : null;
  return { page: index + 1, top: typeof top === "number" ? top : null };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
