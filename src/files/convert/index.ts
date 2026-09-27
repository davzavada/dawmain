/**
 * Browser entry of the converters: File → normalized DMD + quality report.
 *
 * `convertFile` sniffs the real format from the bytes (never trusting the
 * extension for PDF/DOCX), hashes the ORIGINAL file before any converter
 * runs (pdf.js transfers — detaches — the ArrayBuffer to its worker), and
 * dispatches: PDF → ./pdf (loaded lazily, it pulls in pdf.js), DOCX →
 * ./docx (mammoth, also lazy inside), TXT/MD → ./text. Formats we cannot
 * read well (.doc, .rtf, .odt, .epub, .html …) are rejected with a Czech
 * message telling the user what to save instead.
 *
 * `detectKind` and `listZipEntries` are pure — unit-tested in
 * tests/files-convert-index.test.ts; `sliceDmd` lives in ./slice.
 */

import type { FileKind } from "../types";
import { convertDocx } from "./docx";
import { convertText, decodeText } from "./text";
import { ConvertError, type ConvertOptions, type ConvertResult } from "./types";

export { sliceDmd, scanDmdOutline, type DmdOutline } from "./slice";
export { ConvertError, DEFAULT_CONVERT_OPTIONS, type ConvertOptions, type ConvertResult } from "./types";

/** Largest original file the browser converts (the text sent is far smaller). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const SAVE_AS = "Uložte dokument jako PDF nebo DOCX.";

/** Formats recognised by extension only to explain the rejection. */
const REJECTED_EXTENSIONS: Record<string, string> = {
  doc: "DOC (starý formát Wordu)",
  dot: "DOT (starý formát Wordu)",
  rtf: "RTF",
  odt: "ODT",
  ott: "OTT",
  epub: "EPUB",
  html: "HTML",
  htm: "HTML",
  xhtml: "XHTML",
  mht: "MHT",
  pages: "Pages",
  wpd: "WordPerfect",
  xls: "Excel",
  xlsx: "Excel",
  ppt: "PowerPoint",
  pptx: "PowerPoint",
};

const TEXT_EXTENSIONS: Record<string, "txt" | "md"> = { txt: "txt", text: "txt", md: "md", markdown: "md" };
const DOCX_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function unsupported(what: string): ConvertError {
  return new ConvertError("unsupported", `${what} ${SAVE_AS}`);
}

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

function indexOfAscii(bytes: Uint8Array, needle: string, limit = bytes.length): number {
  const first = needle.charCodeAt(0);
  const end = Math.min(limit, bytes.length) - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) if (bytes[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

const PDF_MAGIC = "%PDF-";
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF = "{\\rtf";

/**
 * Entry names from a ZIP's central directory (at most `max`), or null when
 * the directory cannot be read (truncated file, ZIP64). Pure.
 */
export function listZipEntries(bytes: Uint8Array, max = 5_000): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  // End of central directory: 22 bytes + a comment of ≤ 65535 bytes, from the end.
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) return null; // ZIP64
  const decoder = new TextDecoder("utf-8");
  const names: string[] = [];
  let p = offset;
  for (let k = 0; k < count && names.length < max; k++) {
    if (p + 46 > n || view.getUint32(p, true) !== 0x02014b50) return names.length ? names : null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > n) break;
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** What a ZIP container holds: a Word document, or which other format. */
function zipKind(bytes: Uint8Array): "docx" | string {
  const names = listZipEntries(bytes);
  const has = names
    ? (name: string) => names.includes(name)
    : // Unreadable directory: the names are also stored uncompressed in the local headers.
      (name: string) => indexOfAscii(bytes, name) >= 0;
  if (has("word/document.xml")) return "docx";
  if (has("META-INF/container.xml") && indexOfAscii(bytes, "application/epub+zip", 200) >= 0) return "EPUB";
  if (has("content.xml") && has("mimetype")) return "OpenDocument (ODT)";
  if (has("xl/workbook.xml")) return "Excel";
  if (has("ppt/presentation.xml")) return "PowerPoint";
  return "ZIP";
}

/**
 * The file's kind from its bytes: `%PDF-` (within the first 1 KB, as
 * readers allow) → pdf; a ZIP with word/document.xml → docx (also .docm,
 * .dotx); else a .txt / .md by extension. Everything else throws
 * ConvertError('unsupported', "… Uložte dokument jako PDF nebo DOCX."),
 * a password-protected Word file (an OLE2 container named .docx) throws
 * 'encrypted', an empty file 'broken'. Pure.
 */
export function detectKind(bytes: Uint8Array, fileName: string): FileKind {
  if (bytes.length === 0) throw new ConvertError("broken", "Soubor je prázdný.");
  const ext = extensionOf(fileName);
  if (indexOfAscii(bytes, PDF_MAGIC, 1024) >= 0) return "pdf";
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) {
    const kind = zipKind(bytes);
    if (kind === "docx") return "docx";
    throw unsupported(kind === "ZIP" ? "Archiv ZIP neobsahuje dokument Wordu." : `Formát ${kind} tu nelze převést.`);
  }
  if (startsWith(bytes, OLE2)) {
    if (DOCX_EXTENSIONS.has(ext)) {
      // Word stores an encrypted .docx inside an OLE2 container.
      throw new ConvertError("encrypted", "Dokument je chráněný heslem. Heslo ve Wordu odstraňte a soubor nahrajte znovu.");
    }
    throw unsupported("Starý formát Wordu (DOC) tu nelze převést.");
  }
  if (indexOfAscii(bytes, RTF, 8) >= 0) throw unsupported("Formát RTF tu nelze převést.");
  const text = TEXT_EXTENSIONS[ext];
  if (text) return text;
  if (DOCX_EXTENSIONS.has(ext)) throw unsupported("Soubor není platný dokument DOCX.");
  if (ext === "pdf") throw new ConvertError("broken", "Soubor není platné PDF.");
  const known = REJECTED_EXTENSIONS[ext];
  throw unsupported(known ? `Formát ${known} tu nelze převést.` : "Tento typ souboru tu nelze převést.");
}

/** SHA-256 of the bytes as lowercase hex (Web Crypto — browser and node). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ConvertProgress = { phase: string; done: number; total: number };

/**
 * Convert one user-selected file. Phases reported: "read", "hash", then
 * "pdf" (per page, from the PDF converter), "docx" or "text", and "done".
 * Throws ConvertError: 'too_large' over MAX_FILE_BYTES, 'unsupported' /
 * 'encrypted' / 'broken' from detection or the converter, 'scan' from the
 * PDF converter.
 */
export async function convertFile(
  file: File,
  opts: ConvertOptions,
  onProgress?: (p: ConvertProgress) => void,
): Promise<ConvertResult & { fileSha256: string; fileName: string; bytes: number }> {
  const report = (phase: string, done: number, total: number) => onProgress?.({ phase, done, total });
  if (file.size > MAX_FILE_BYTES) {
    const mb = Math.ceil(file.size / (1024 * 1024));
    throw new ConvertError("too_large", `Soubor má ${mb} MB, převést lze nejvýš ${MAX_FILE_BYTES / (1024 * 1024)} MB. Nahrajte jen potřebnou část.`);
  }

  report("read", 0, 1);
  const data = await file.arrayBuffer();
  report("read", 1, 1);
  const kind = detectKind(new Uint8Array(data), file.name);

  // Before any converter: pdf.js detaches `data` when it hands it to its worker.
  report("hash", 0, 1);
  const fileSha256 = await sha256Hex(data);
  report("hash", 1, 1);

  let result: ConvertResult;
  if (kind === "pdf") {
    const { convertPdf } = await import("./pdf/index");
    result = await convertPdf(data, opts, (done: number, total: number) => report("pdf", done, total));
  } else if (kind === "docx") {
    report("docx", 0, 1);
    result = await convertDocx(data, opts);
    report("docx", 1, 1);
  } else {
    report("text", 0, 1);
    let decoded: ReturnType<typeof decodeText>;
    try {
      decoded = decodeText(new Uint8Array(data));
    } catch {
      throw unsupported("Soubor není čitelný text.");
    }
    result = convertText(decoded.text, kind);
    if (decoded.encoding === "windows-1250") {
      result.warnings.unshift("Soubor nebyl v kódování UTF-8, načetl se jako windows-1250 — zkontrolujte v náhledu diakritiku.");
    }
    report("text", 1, 1);
  }
  report("done", 1, 1);
  return { ...result, fileSha256, fileName: file.name, bytes: file.size };
}
