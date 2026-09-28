import { billablePages } from "@/src/files/dmd/billing";
import type { ParsedDoc } from "@/src/files/dmd/types";
import type { ConvertResult } from "@/src/files/convert/types";
import type { DocType, Rights, UploadMeta } from "@/src/files/types";
import { countPagesAcc, formatCount, plural } from "./format";

/** What the upload will cost, and whether it fits. */
export function uploadCost(
  parsed: ParsedDoc,
  quotaPages: number,
  usedPages: number,
  /**
   * A new version of a document replaces it: the old version's billable
   * pages, which the server credits against the quota (the document is in
   * review or ready — src/files/upload.ts replacementCredit). 0 otherwise.
   */
  creditPages = 0,
): { pages: number; remaining: number; fits: boolean; line: string } {
  const pages = billablePages(parsed.stats.countedChars);
  const credit = Math.max(0, Math.floor(creditPages));
  const remaining = Math.max(0, quotaPages - Math.max(0, usedPages - credit));
  const fits = pages <= remaining;
  const base = `Zabere ${countPagesAcc(pages)} z ${formatCount(remaining)} ${plural(remaining, "zbývající", "zbývajících", "zbývajících")}`;
  const line = credit > 0 ? `${base} (počítáno i s ${formatCount(credit)} ${plural(credit, "stranou", "stranami", "stranami")} původní verze, která se nahradí).` : `${base}.`;
  return { pages, remaining, fits, line };
}

/**
 * What a browser lacks for converting and uploading here: gzip
 * (CompressionStream — Safari before 16.4), SHA-256 (crypto.subtle, a secure
 * context) and module Workers (pdf.js). Empty when everything is there.
 */
export function missingBrowserFeatures(g: typeof globalThis = globalThis): string[] {
  const missing: string[] = [];
  if (typeof g.CompressionStream !== "function") missing.push("CompressionStream");
  if (!g.crypto?.subtle) missing.push("crypto.subtle");
  if (!supportsModuleWorkers(g)) missing.push("module Worker");
  return missing;
}

function supportsModuleWorkers(g: typeof globalThis): boolean {
  if (typeof g.Worker !== "function") return false;
  // A browser that knows module workers reads the `type` option; creating the worker from an
  // empty script is harmless, and it is terminated at once.
  let read = false;
  const options = {
    get type(): "module" {
      read = true;
      return "module";
    },
  };
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([""], { type: "text/javascript" }));
    new g.Worker(url, options).terminate();
  } catch {
    // Unsupported options or a blocked blob: URL — the getter tells which.
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  return read;
}

export const UNSUPPORTED_BROWSER =
  "Váš prohlížeč nahrávání nepodporuje: převod probíhá přímo v prohlížeči a potřebuje novější funkce. Použijte aktuální Chrome, Edge, Firefox nebo Safari 16.4 a novější.";

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
