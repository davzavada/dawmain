import { SourceError } from "./errors";
import { htmlToText, looksLikeHtml } from "./html";

/**
 * Downloaded documents (PDF, DOCX, HTML) to text, shared by the sources that
 * read attached files: psp.cz (orig2.sqw) and Slov-Lex (eLegislatíva
 * documents, court decisions on obcan.justice.sk). The converters load
 * lazily — pdf.js and mammoth are heavy — and tests swap them.
 */

export type DocumentFormat = "pdf" | "docx" | "doc" | "rtf" | "html" | "unknown";

/** What a downloaded file is, from its first bytes — never from the header. Pure — unit-tested. */
export function sniffDocument(bytes: Uint8Array): DocumentFormat {
  const head = Array.from(bytes.slice(0, 8));
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith("%PDF")) return "pdf";
  if (ascii.startsWith("PK\u0003\u0004")) return "docx";
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "doc";
  if (ascii.startsWith("{\\rtf")) return "rtf";
  const text = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  if (looksLikeHtml(text)) return "html";
  return "unknown";
}

export interface PdfRange {
  text: string;
  pages: number;
  range: [number, number];
  warnings: string[];
}

export type PdfOutcome = PdfRange | { unavailable: "encrypted" | "scan" | "broken" | "too-many-pages" | "timeout" };

/** The converters, injectable for tests; the defaults load lazily (pdf.js and mammoth are heavy). */
export interface DocumentConverters {
  pdf: (bytes: ArrayBuffer, range: [number, number]) => Promise<PdfOutcome>;
  docx: (bytes: ArrayBuffer) => Promise<string>;
}

/** A sněmovní tisk runs to thousands of pages (the občanský zákoník bill with its důvodová zpráva); the per-call window stays PDF_PAGES_PER_CALL. */
export const PDF_MAX_TOTAL_PAGES = 5_000;

/** PDF pages one call converts at most (a rozdílová tabulka runs to hundreds). */
export const PDF_PAGES_PER_CALL = 60;

const defaultConverters: DocumentConverters = {
  pdf: async (bytes, range) => {
    const result = await (await import("@/src/zotero/pdf-text")).pdfText(bytes, { pageRange: range, maxTotalPages: PDF_MAX_TOTAL_PAGES });
    return "unavailable" in result ? result : { text: result.text, pages: result.pages, range: result.pageRange, warnings: result.warnings };
  },
  docx: async (bytes) => {
    const mod = (await import("mammoth")) as typeof import("mammoth") & { default?: typeof import("mammoth") };
    const mammoth = mod.default ?? mod;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  },
};

export interface ExtractedDocument {
  url: string;
  format: DocumentFormat;
  text: string;
  /** PDF only: the whole file's pages, the pages this text covers, converter warnings. */
  pdf?: { pages: number; range: [number, number]; warnings: string[] };
}

let activeConverters: DocumentConverters = defaultConverters;

/** Tests swap the converters (pdf.js and mammoth are not exercised there); undefined restores the defaults. */
export function setDocumentConverters(converters?: DocumentConverters): void {
  activeConverters = converters ?? defaultConverters;
}

const PDF_UNAVAILABLE: Record<Exclude<PdfOutcome, PdfRange>["unavailable"], string> = {
  encrypted: "the PDF is encrypted",
  scan: "the PDF is a scan without a text layer",
  broken: "the PDF could not be parsed",
  "too-many-pages": "the PDF has more pages than this server converts",
  timeout: "converting the PDF took too long",
};

/**
 * The text of a downloaded file: PDF through the Vlastní zdroje converter
 * (page markers ⟦s. N⟧, only the pages of `pdfRange`), DOCX through mammoth,
 * HTML as text. A legacy .doc, RTF or unknown binary → UPSTREAM_ERROR telling
 * the model to open the file itself (a source with a PDF rendition, like
 * psp.cz, asks for it before calling this). `label` names the document in
 * errors (default: its URL).
 */
export async function extractDocument(
  source: string,
  file: { bytes: ArrayBuffer; url: string },
  pdfRange: [number, number] = [1, PDF_PAGES_PER_CALL],
  opts: { label?: string; converters?: DocumentConverters } = {},
): Promise<ExtractedDocument> {
  const converters = opts.converters ?? activeConverters;
  const label = opts.label ?? file.url;
  const format = sniffDocument(new Uint8Array(file.bytes));
  switch (format) {
    case "pdf": {
      const outcome = await converters.pdf(file.bytes, pdfRange);
      if ("unavailable" in outcome) {
        throw new SourceError(source, "UPSTREAM_ERROR", `Document ${label}: ${PDF_UNAVAILABLE[outcome.unavailable]}.`, `Open it yourself: ${file.url}`);
      }
      return { url: file.url, format, text: outcome.text, pdf: { pages: outcome.pages, range: outcome.range, warnings: outcome.warnings } };
    }
    case "docx":
      return { url: file.url, format, text: (await converters.docx(file.bytes)).trim() };
    case "html":
      return { url: file.url, format, text: htmlToText(new TextDecoder("utf-8").decode(file.bytes)) };
    default:
      throw new SourceError(
        source,
        "UPSTREAM_ERROR",
        `Document ${label} is a ${format === "doc" ? "legacy Word (.doc)" : format === "rtf" ? "RTF" : "binary"} file.`,
        `This server reads PDF, DOCX and HTML. Open the file yourself: ${file.url}`,
      );
  }
}
