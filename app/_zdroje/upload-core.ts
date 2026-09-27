import { billablePages } from "@/src/files/dmd/billing";
import { stripMarkup } from "@/src/files/dmd/parse";
import { PAGE_FLAGS, type ParsedDoc } from "@/src/files/dmd/types";
import type { ConvertResult } from "@/src/files/convert/types";
import type { DmdOutline } from "@/src/files/convert/slice";
import type { DocType, Rights, UploadMeta } from "@/src/files/types";
import { countPages, formatCount, plural } from "./format";

/**
 * The browser side of an upload, minus the React: what the preview shows
 * about a conversion, what one upload costs, the UploadMeta JSON, the gzip
 * and hash of the text, and the Czech answer to every refusal the upload
 * route can give. Pure except gzipText / sha256Text (Web APIs present in
 * browsers and in Node ≥ 18) — unit-tested in tests/files-web-format.test.ts.
 */

/** Conversion statistics for the "Náhled převodu" card. */
export interface PreviewStats {
  pages: number | null;
  footnotes: number;
  /** Share of footnote definitions bound to a reference, 0–100 (null without footnotes). */
  linkedPercent: number | null;
  headings: number;
  paragraphs: number;
  marginalNumbers: number;
  labelSource: string;
  plainMode: boolean;
}

const LABEL_SOURCES: Record<string, string> = {
  pdf_labels: "čísla stran z PDF",
  printed: "tištěná čísla stran",
  physical: "pořadí stran v PDF",
  none: "bez stran (citace podle oddílů)",
};

export function previewStats(parsed: ParsedDoc, result: Pick<ConvertResult, "labelSource" | "quality">): PreviewStats {
  const defs = parsed.footnotes.length;
  const bound = parsed.footnotes.filter((f) => f.refAt !== null).length;
  return {
    pages: parsed.paged ? parsed.stats.physicalPages : null,
    footnotes: defs,
    linkedPercent: defs > 0 ? Math.round((bound / defs) * 100) : null,
    headings: parsed.stats.headings,
    paragraphs: parsed.sections.filter((s) => s.kind === "par").length,
    marginalNumbers: parsed.stats.marginalNumbers,
    labelSource: LABEL_SOURCES[result.labelSource] ?? result.labelSource,
    plainMode: result.quality.ocr === true,
  };
}

/** What the upload will cost, and whether it fits. */
export function uploadCost(parsed: ParsedDoc, quotaPages: number, usedPages: number): { pages: number; remaining: number; fits: boolean; line: string } {
  const pages = billablePages(parsed.stats.countedChars);
  const remaining = Math.max(0, quotaPages - usedPages);
  const fits = pages <= remaining;
  const line = `Zabere ${countPages(pages)} z ${formatCount(remaining)} ${plural(remaining, "zbývající", "zbývajících", "zbývajících")}.`;
  return { pages, remaining, fits, line };
}

/** Pages (1-based physical ords) with a problem flag, for "další sporná strana". */
export function unsurePages(pageFlags: number[]): number[] {
  const mask = PAGE_FLAGS.FN_UNSURE | PAGE_FLAGS.COLUMNS | PAGE_FLAGS.LABEL_GUESSED | PAGE_FLAGS.HEADING_UNSURE;
  const out: number[] = [];
  pageFlags.forEach((f, i) => {
    if ((f & mask) !== 0) out.push(i + 1);
  });
  return out;
}

/** The next unsure page after `current`, wrapping around; null when there is none. */
export function nextUnsurePage(pageFlags: number[], current: number): number | null {
  const list = unsurePages(pageFlags);
  if (list.length === 0) return null;
  return list.find((p) => p > current) ?? list[0];
}

/** Strip colour of one page by its flags. */
export function pageTone(flags: number): "ok" | "warn" | "blank" {
  if ((flags & PAGE_FLAGS.BLANK) !== 0) return "blank";
  if ((flags & (PAGE_FLAGS.FN_UNSURE | PAGE_FLAGS.COLUMNS | PAGE_FLAGS.LABEL_GUESSED | PAGE_FLAGS.HEADING_UNSURE)) !== 0) return "warn";
  return "ok";
}

/** Czech tooltip of a page's flags. */
export function pageFlagText(flags: number): string {
  const parts: string[] = [];
  if (flags & PAGE_FLAGS.FN_UNSURE) parts.push("poznámky nerozpoznány");
  if (flags & PAGE_FLAGS.COLUMNS) parts.push("dva sloupce");
  if (flags & PAGE_FLAGS.LABEL_GUESSED) parts.push("číslo strany odhadnuto");
  if (flags & PAGE_FLAGS.HEADING_UNSURE) parts.push("nejisté nadpisy");
  if (flags & PAGE_FLAGS.BLANK) parts.push("prázdná strana");
  return parts.join(", ");
}

/**
 * The plain text of one physical page of a DMD document (markup stripped),
 * at most `max` characters — shown as TEXT in the preview, never as HTML.
 * Pages come from scanDmdOutline (their ords are physical page numbers).
 */
export function pageText(dmd: string, outline: DmdOutline, ord: number, max = 12_000): string {
  const page = outline.pages.find((p) => p.ord === ord);
  if (!page) return "";
  const raw = dmd.slice(page.start, Math.min(page.end, page.start + max + 200));
  const text = stripMarkup(raw).text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The page of a (possibly cut) DMD document showing a given PDF page: the
 * one with the PDF page's printed label; when several pages share it
 * (roman front matter restarting), the one nearest `expectedOrd`. Null when
 * the page is not in the text (outside the selected range).
 */
export function dmdPageFor(outline: DmdOutline, label: string, expectedOrd: number): number | null {
  let best: number | null = null;
  for (const p of outline.pages) {
    if (p.label !== label) continue;
    if (best === null || Math.abs(p.ord - expectedOrd) < Math.abs(best - expectedOrd)) best = p.ord;
  }
  return best;
}

/** The beginning of an unpaged document (DOCX, TXT) as plain text. */
export function leadText(dmd: string, max = 6_000): string {
  const text = stripMarkup(dmd.slice(0, max + 500)).text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Section ranges the picker offers: § and článek sections, and top-level parts/chapters. */
export function rangeSections(outline: DmdOutline): Array<{ ord: number; label: string }> {
  const minLevel = Math.min(...outline.sections.map((s) => s.level), 6);
  return outline.sections
    .filter((s) => s.kind === "par" || s.kind === "cl" || ((s.kind === "part" || s.kind === "chapter") && s.level <= minLevel + 1))
    .map((s) => ({ ord: s.ord, label: s.heading.length > 70 ? `${s.heading.slice(0, 69)}…` : s.heading }));
}

/** The JSON part of the upload (src/files/types.ts UploadMeta); the server re-checks all of it. */
export function buildUploadMeta(args: {
  libraryId: string;
  file: { name: string; bytes: number; sha256: string };
  result: Pick<ConvertResult, "kind" | "converter" | "quality" | "hints" | "labelSource">;
  parsed: ParsedDoc;
  contentSha256: string;
  rights: Rights;
  docTypeHint: DocType | null;
  replaces: string | null;
}): UploadMeta {
  const meta: UploadMeta = {
    library_id: args.libraryId,
    file: { name: args.file.name, bytes: Math.max(0, Math.floor(args.file.bytes)), sha256: args.file.sha256, kind: args.result.kind },
    converter: args.result.converter,
    content: { sha256: args.contentSha256, chars: args.parsed.text.length },
    quality: args.result.quality,
    hints: args.result.hints,
    rights: args.rights,
  };
  if (args.parsed.paged) meta.pages = { physical: args.parsed.stats.physicalPages, label_source: args.result.labelSource };
  if (args.docTypeHint) meta.doc_type_hint = args.docTypeHint;
  if (args.replaces) meta.replaces = args.replaces;
  return meta;
}

/** UTF-8 bytes of the text, gzip-compressed (CompressionStream). */
export async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** SHA-256 of the UTF-8 text, lowercase hex — what the server recomputes from the decompressed body. */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The multipart body of POST /api/files/documents. */
export function uploadForm(meta: UploadMeta, gz: Blob): FormData {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("dmd", gz, "dokument.dmd.gz");
  return form;
}

/**
 * The upload route's answer as a Czech message for the queue. The server's
 * own message wins when it sent one (it is always Czech and content-free);
 * these are the fallbacks per status.
 */
export function uploadOutcome(status: number, body: unknown): { ok: true; id: string } | { ok: false; message: string; duplicateId?: string } {
  const b = (body && typeof body === "object" ? body : {}) as { id?: unknown; error?: unknown; duplicate?: { id?: unknown; title?: unknown } };
  if (status === 201 && typeof b.id === "string") return { ok: true, id: b.id };
  const server = typeof b.error === "string" && b.error.trim() ? b.error : null;
  if (status === 409) {
    const title = typeof b.duplicate?.title === "string" ? b.duplicate.title : null;
    return {
      ok: false,
      message: title ? `Tento dokument už v knihovně je („${title.slice(0, 120)}“).` : (server ?? "Tento dokument už v knihovně je."),
      duplicateId: typeof b.duplicate?.id === "string" ? b.duplicate.id : undefined,
    };
  }
  const fallback: Record<number, string> = {
    400: "Nahrávání se nepodařilo — data se cestou poškodila. Zkuste to znovu.",
    401: "Přihlášení vypršelo. Přihlaste se prosím znovu.",
    403: "Do této knihovny teď nahrávat nemůžete.",
    413: "Dokument je na jedno nahrání příliš velký. Vyberte menší rozsah stran nebo oddílů.",
    422: "Dokument nejde zpracovat — nejspíš jde o sken bez textu.",
    429: "Dnes už se do knihovny nahrálo příliš mnoho dokumentů. Zkuste to zítra.",
    503: "Vlastní zdroje jsou teď nedostupné nebo jen pro čtení. Zkuste to později.",
  };
  return { ok: false, message: server ?? fallback[status] ?? "Nahrávání se nepodařilo. Zkuste to prosím znovu." };
}
