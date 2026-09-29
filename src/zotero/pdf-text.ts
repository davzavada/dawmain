import "server-only";
import { layoutToDmd, readPdf, type PdfDocInput } from "@/src/files/convert/pdf";
import { buildRows } from "@/src/files/convert/pdf/geometry";
import { ConvertError, DEFAULT_CONVERT_OPTIONS, type ConvertResult } from "@/src/files/convert/types";
import { sanitizeLine } from "@/src/files/dmd/normalize";
import { parseDmd } from "@/src/files/dmd/parse";
import { renderRange, type RenderFootnote, type TextSource } from "@/src/files/dmd/render";
import { DMD_LIMITS, DmdLimitError, type ParsedDoc } from "@/src/files/dmd/types";
import { LIMITS } from "./config";

/**
 * Text of a Zotero PDF attachment when Zotero's own full-text index is
 * missing or incomplete (plan decision 8). It runs the Vlastní zdroje
 * converter — pdf.js (legacy build, fake worker in node) and the layout
 * engine — so the text has the same pages, headings and footnotes as an
 * uploaded document, and renders it the way files_get_document shows a
 * document to the model: page markers ⟦s. N⟧ (the printed page label
 * where the layout found one, else the page's place in the PDF), footnotes
 * ⟦pozn. N⟧ after their paragraph, marginal numbers ⟦m. č. N⟧.
 *
 * Bounded: at most LIMITS.maxPdfPages pages per call (pageRange selects
 * them), LIMITS.pdfTimeoutMs, and a file with more pages than Vlastní
 * zdroje accept at all is refused before any layout. Nothing is stored;
 * the caller caches the result in memory.
 *
 * "scan" means that not one page of the pages read has a text layer. The
 * converter's own scan verdict is stricter — more than 30 % of the pages
 * under 40 characters — and suits an upload, whose uploader sees the
 * error and picks another range; a Zotero reader cannot, and a blank page
 * inside a short window or a decision whose last page holds only the
 * signature is no scan. Such a window is laid out in runs that each pass
 * that rule (see layoutWindow).
 */

export type PdfTextUnavailable = "encrypted" | "scan" | "broken" | "too-many-pages" | "timeout";

export type PdfTextResult =
  | {
      /** Rendered text with ⟦s. N⟧ page markers; empty when the range starts past the last page. */
      text: string;
      /** Physical pages of the whole PDF. */
      pages: number;
      /** Physical pages read, 1-based inclusive; [from, to] with from > to when nothing was left to read. */
      pageRange: [number, number];
      /** Czech, for the tool's header: OCR layer, page numbering, cut range. */
      warnings: string[];
    }
  | { unavailable: PdfTextUnavailable };

/**
 * pdf.js visits every page of the file (size, label) even outside the
 * range; beyond what an upload may have at all the walk alone could eat
 * the budget, so such a file is refused as soon as its page count is known.
 */
const MAX_TOTAL_PAGES = DMD_LIMITS.maxPages;

/** The converter's sparse-page rule (SPARSE_CHARS and the 30 % share in scanCheck, src/files/convert/pdf/layout.ts). */
const SPARSE_CHARS = 40;
const SPARSE_SHARE = 0.3;
/**
 * Pages each side of a run whose text the layout still sees: enough to
 * recognise running heads and printed page numbers, while each run costs
 * about its own pages — not the whole window again (a window of alternating
 * blank pages is laid out in one run per text page).
 */
const RUN_CONTEXT_PAGES = 10;

/**
 * In the Next.js server bundle pdf.js's fake worker would import
 * "./pdf.worker.mjs" next to the bundled chunk (.next/server/chunks), where
 * it is not, and every conversion would fail as "broken". Loading the worker
 * module first sets globalThis.pdfjsWorker, which pdf.js then uses in-process.
 * Server-only (this file), so the browser upload keeps its Web Worker.
 */
let workerReady: Promise<unknown> | null = null;
function ensurePdfWorker(): Promise<unknown> {
  // @ts-expect-error pdfjs-dist ships no types for the worker entry
  workerReady ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs").catch((error: unknown) => {
    workerReady = null;
    throw error;
  });
  return workerReady;
}

/** Sentinels thrown out of readPdf's progress callback to stop it between pages. */
class Stop extends Error {
  constructor(readonly reason: "timeout" | "too-many-pages") {
    super(reason);
  }
}

export async function pdfText(
  bytes: ArrayBuffer,
  opts: { pageRange?: [number, number]; signal?: AbortSignal } = {},
): Promise<PdfTextResult> {
  const [from, askedTo] = requestedRange(opts.pageRange);
  const to = Math.min(askedTo, from + LIMITS.maxPdfPages - 1);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, LIMITS.pdfTimeoutMs);
    // The caller's budget ends the wait the same way.
    onAbort = () => resolve("timeout");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const stopped = () => timedOut || opts.signal?.aborted === true;

  try {
    await ensurePdfWorker();
    // readPdf takes no signal; its progress callback runs after every page,
    // and throwing there ends the read (readPdf destroys the pdf.js task in
    // its finally), so a timed-out conversion stops instead of running on.
    const reading = readPdf(
      bytes,
      (_done, total) => {
        if (total > MAX_TOTAL_PAGES) throw new Stop("too-many-pages");
        if (stopped()) throw new Stop("timeout");
      },
      { pageRange: [from, to] },
    );
    reading.catch(() => undefined); // the race below may abandon it
    const doc = await Promise.race([reading, deadline]);
    if (doc === "timeout" || stopped()) return { unavailable: "timeout" };

    const total = doc.pages.length;
    if (total > MAX_TOTAL_PAGES) return { unavailable: "too-many-pages" };
    if (from > total) {
      return {
        text: "",
        pages: total,
        pageRange: [from, total],
        warnings: [`PDF má jen ${total} ${pagesWord(total)}; strany od ${from} v něm nejsou.`],
      };
    }
    const last = Math.min(to, total);
    // The layout is synchronous and bounded by the range; the deadline is checked around it.
    const laid = layoutWindow(doc, from, last, stopped);
    if (laid === "scan") return { unavailable: "scan" };
    if (laid === "timeout" || stopped()) return { unavailable: "timeout" };
    return {
      text: laid.text,
      pages: total,
      pageRange: [from, last],
      // Cut: pages the caller wanted (and the file has) that this call did not read.
      warnings: warningsFor(laid.results, { from, last, total, cut: last < Math.min(askedTo, total) }),
    };
  } catch (error) {
    if (error instanceof Stop) return { unavailable: error.reason };
    if (error instanceof ConvertError) return { unavailable: convertReason(error) };
    if (error instanceof DmdLimitError) {
      return { unavailable: error.limit === "maxChars" || error.limit === "maxPages" ? "too-many-pages" : "broken" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Pages [from, last] laid out and rendered. When the converter calls the
 * window a scan because of its sparse-page rule while some page of it has
 * text, the window is laid out in runs that each pass the rule (pages of
 * text, joined across the short pages between them while a run keeps at
 * most 30 % short pages), and a short page left between runs is shown as
 * it stands: its marker and its few words. Runs lose little: the layout
 * still sees the text of RUN_CONTEXT_PAGES around each run (it keeps only
 * the run's pages), so page furniture and printed page numbers are
 * recognised as in one pass. The verdict stands when the window has no
 * text page at all (a scanner's stamp on each page does not make one), or
 * when the rule was not what refused it (unmapped glyphs, garbage text).
 */
function layoutWindow(
  doc: PdfDocInput,
  from: number,
  last: number,
  stopped: () => boolean,
): { text: string; results: ConvertResult[] } | "scan" | "timeout" {
  try {
    const whole = layoutToDmd(doc, { ...DEFAULT_CONVERT_OPTIONS, pageRange: [from, last] });
    return { text: renderDoc(parseDmd(whole.dmd)), results: [whole] };
  } catch (error) {
    if (!(error instanceof ConvertError) || error.code !== "scan") throw error;
  }
  const pageRows = doc.pages.slice(from - 1, last).map((page) => buildRows(page));
  const sparse = pageRows.map((rows) => rows.rawChars < SPARSE_CHARS);
  const short = sparse.filter(Boolean).length;
  if (short <= SPARSE_SHARE * sparse.length || short === sparse.length) return "scan";

  const laid: Array<{ at: number; end: number; result: ConvertResult }> = [];
  for (const [a, b] of textRuns(sparse)) {
    if (stopped()) return "timeout";
    const [lo, hi] = [from + a - RUN_CONTEXT_PAGES, from + b + RUN_CONTEXT_PAGES];
    // Pages outside the context keep their place (the layout numbers pages by position) but lose their text.
    const context: PdfDocInput = { ...doc, pages: doc.pages.map((p, i) => (i + 1 >= lo && i + 1 <= hi ? p : { ...p, items: [] })) };
    try {
      laid.push({ at: a, end: b, result: layoutToDmd(context, { ...DEFAULT_CONVERT_OPTIONS, pageRange: [from + a, from + b] }) });
    } catch (error) {
      if (error instanceof ConvertError && error.code === "scan") return "scan";
      throw error;
    }
  }

  const parts: string[] = [];
  for (let i = 0, k = 0; i < sparse.length; i++) {
    if (k < laid.length && laid[k].at === i) {
      parts.push(renderDoc(parseDmd(laid[k].result.dmd)));
      i = laid[k].end;
      k++;
      continue;
    }
    // A short page between runs, in the renderer's shape (marker line, blank line, text),
    // labelled as the run next to it labels it.
    const ord = from + i;
    const labels = laid[Math.max(0, k - 1)].result.pageLabels;
    const label = sanitizeLine(labels[ord - 1] ?? "", 20) || String(ord);
    const words = sanitizeLine(pageRows[i].rawText, 200);
    parts.push(words ? `⟦s. ${label}⟧\n\n${words}` : `⟦s. ${label}⟧`);
  }
  return { text: parts.join("\n\n"), results: laid.map((x) => x.result) };
}

/**
 * Runs [a, b] (0-based in the window) that pass the sparse-page rule:
 * every text page is in one; a run grows over the short pages up to the
 * next text page while at most SPARSE_SHARE of it stays short.
 */
function textRuns(sparse: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < sparse.length; i++) {
    if (sparse[i]) continue;
    const run = runs[runs.length - 1];
    if (run) {
      const span = sparse.slice(run[0], i + 1);
      if (span.filter(Boolean).length <= SPARSE_SHARE * span.length) {
        run[1] = i;
        continue;
      }
    }
    runs.push([i, i]);
  }
  return runs;
}

/** 1-based inclusive, ordered; without a range the whole file is asked for (and cut to LIMITS.maxPdfPages). */
function requestedRange(range: [number, number] | undefined): [number, number] {
  if (!range) return [1, Number.POSITIVE_INFINITY];
  const a = Number.isFinite(range[0]) ? Math.floor(range[0]) : 1;
  const b = Number.isFinite(range[1]) ? Math.floor(range[1]) : a;
  return [Math.max(1, Math.min(a, b)), Math.max(1, a, b)];
}

function convertReason(error: ConvertError): PdfTextUnavailable {
  switch (error.code) {
    case "encrypted":
      return "encrypted";
    case "scan":
      return "scan";
    case "too_large":
      return "too-many-pages";
    default:
      return "broken";
  }
}

/**
 * The whole DMD rendered as files_get_document renders a window: the same
 * renderRange over the same footnote table, each note tagged with the
 * printed label of the page its reference stands on.
 */
function renderDoc(doc: ParsedDoc): string {
  const src: TextSource = { start: 0, end: doc.text.length, slice: (a, b) => doc.text.slice(a, b) };
  const footnotes: RenderFootnote[] = doc.footnotes.map((f) => ({
    seq: f.seq,
    label: f.label,
    kind: f.kind,
    refAt: f.refAt,
    defStart: f.defStart,
    defEnd: f.defEnd,
    pageLabel: doc.pages[f.page - 1]?.label ?? null,
  }));
  return renderRange(src, 0, doc.text.length, footnotes, {
    mode: "after",
    anchorLabel: doc.anchorLabel,
    pageLabelAt: (offset) => pageLabelAt(doc, offset),
  });
}

/** Label of the page containing `offset` (pages are sorted by start). */
function pageLabelAt(doc: ParsedDoc, offset: number): string | null {
  let lo = 0;
  let hi = doc.pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const page = doc.pages[mid];
    if (offset < page.start) hi = mid - 1;
    else if (offset >= page.end) lo = mid + 1;
    else return page.label;
  }
  return null;
}

/**
 * The converter's own warnings speak to the upload preview ("zkontrolujte
 * v náhledu"), which a Zotero reader does not have; these say what the
 * model needs to cite and quote correctly. `results`: one per laid-out run
 * (usually one for the whole window).
 */
function warningsFor(results: ConvertResult[], r: { from: number; last: number; total: number; cut: boolean }): string[] {
  const out: string[] = [];
  if (r.cut) {
    out.push(`Přečteny strany ${r.from}–${r.last} z ${r.total}; najednou lze vytáhnout nejvýš ${LIMITS.maxPdfPages} stran.`);
  }
  if (results.some((x) => x.quality.ocr)) {
    out.push("Text pochází z OCR vrstvy PDF: jen strany a odstavce (bez poznámek pod čarou a nadpisů) a může obsahovat chyby rozpoznání.");
  }
  if (results.some((x) => x.labelSource === "physical") && r.last > r.from) {
    out.push("Tištěná čísla stran se nepodařilo zjistit — ⟦s. N⟧ je pořadí strany v PDF.");
  }
  const columns = results.reduce((n, x) => n + x.quality.columns_pages, 0);
  if (columns) {
    out.push(`Dvousloupcová sazba na ${columns} ${pagesWord(columns, "locative")} — pořadí čtení nemusí být přesné.`);
  }
  if (results.some((x) => x.quality.footnotes === "unsure" || x.quality.footnotes === "partial")) {
    out.push("Poznámky pod čarou se podařilo spárovat s odkazy jen zčásti; některé zůstaly jako běžný text.");
  }
  return out;
}

/** "(má) stranu / strany / stran" (accusative) or "(na) straně / stranách" (locative). */
function pagesWord(n: number, grammarCase: "accusative" | "locative" = "accusative"): string {
  if (grammarCase === "locative") return n === 1 ? "straně" : "stranách";
  if (n === 1) return "stranu";
  return n >= 2 && n <= 4 ? "strany" : "stran";
}
