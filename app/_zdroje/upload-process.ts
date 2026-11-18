import { LIMITS, ORIGINAL_ALREADY_STORED, ORIGINAL_PART_BYTES } from "@/src/files/config";
import type { ConvertOptions, ConvertResult } from "@/src/files/convert/types";
import { parseDmd } from "@/src/files/dmd/parse";
import { DmdLimitError } from "@/src/files/dmd/types";
import type { LibrarySummary } from "@/src/files/web-types";
import { formatCount, formatStorageBytes as formatBytes, zBefore } from "./format";
import { buildUploadMeta, gzipText, sha256Text, storageCheck, uploadForm, uploadOutcome } from "./upload-core";

/**
 * One file's way to the library (loaded on demand by ./upload.tsx when a
 * file is dropped, so the DMD parser and the converters are never in a
 * page's first load): the storage check, the conversion to text in the
 * browser, the text posted, then the original in parts.
 */

type Converted = ConvertResult & { fileSha256: string; fileName: string; bytes: number };

const DEFAULT_OPTS: ConvertOptions = { footnotes: true, columns: "auto", marginalNumbers: true, plain: false, pageRange: null, labelOffset: null };

const PHASES: Record<string, string> = {
  read: "Načítám soubor",
  hash: "Počítám otisk souboru",
  pdf: "Čtu strany PDF",
  docx: "Převádím DOCX",
  text: "Převádím text",
  layout: "Skládám text",
  done: "Převedeno",
};

function progressText(phase: string, done: number, total: number): string {
  const label = PHASES[phase] ?? "Převádím";
  return total > 1 ? `${label}… ${formatCount(done)} / ${formatCount(total)}` : `${label}…`;
}

function convertErrorMessage(error: unknown): string {
  const e = error as { name?: string; message?: string } | null;
  if (e?.name === "ConvertError" && typeof e.message === "string") return e.message;
  return "Soubor se nepodařilo převést. Zkuste ho uložit znovu jako PDF nebo DOCX.";
}

export class UploadStop extends Error {
  override name = "UploadStop";
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

/** Waits before the 2nd, 3rd and 4th attempt of one request of the original's upload. */
export const ORIGINAL_RETRY_MS: readonly number[] = [500, 1_500, 4_000];

const CONNECTION_LOST = "Spojení se přerušilo při ukládání originálu.";
const ORIGINAL_FAILED = "Originál se nepodařilo uložit.";

/**
 * One request of the original's upload, tried again after a network error
 * or a 5xx (the server stores a part idempotently and a finalize changes
 * nothing until it succeeds). Resolves with the first response that is not
 * a 5xx. Throws UploadStop: the server's own Czech message when its last
 * answer was a 5xx, "the connection broke" when no answer came at all.
 */
export async function sendWithRetry(
  send: () => Promise<Response>,
  waits: readonly number[] = ORIGINAL_RETRY_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) await sleep(waits[attempt - 1]);
    try {
      last = await send();
    } catch {
      last = null;
      continue;
    }
    if (last.status < 500) return last;
  }
  throw new UploadStop(last ? await errorText(last, ORIGINAL_FAILED) : CONNECTION_LOST);
}

/** PUT an original's parts, then finish it. Throws UploadStop with a Czech message. */
async function uploadOriginal(id: string, file: File, onProgress: (text: string) => void): Promise<void> {
  const base = `/api/files/documents/${encodeURIComponent(id)}/original`;
  const parts = Math.max(1, Math.ceil(file.size / ORIGINAL_PART_BYTES));
  for (let n = 0; n < parts; n++) {
    const body = file.slice(n * ORIGINAL_PART_BYTES, Math.min(file.size, (n + 1) * ORIGINAL_PART_BYTES));
    onProgress(parts > 1 ? `Ukládám originál… ${Math.round((n / parts) * 100)} %` : "Ukládám originál…");
    const res = await sendWithRetry(() =>
      fetch(`${base}?part=${n}`, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" }, credentials: "same-origin" }),
    );
    if (!res.ok) throw new UploadStop(await errorText(res, ORIGINAL_FAILED));
  }
  const res = await sendWithRetry(() => fetch(base, { method: "POST", credentials: "same-origin" }));
  if (res.ok) return;
  const message = await errorText(res, ORIGINAL_FAILED);
  // A finalize whose answer got lost did its work: the retry finds the original already stored.
  if (res.status === 409 && message === ORIGINAL_ALREADY_STORED) return;
  throw new UploadStop(message);
}

/**
 * Convert one file, check it and post it, then its original. Resolves with
 * the new document's id and a note when only the original failed (the text
 * is in and searchable, the file just cannot be opened); throws UploadStop
 * otherwise.
 */
export async function processFile(
  file: File,
  library: LibrarySummary,
  folderId: string | null,
  maxFileBytes: number,
  onProgress: (text: string) => void,
): Promise<{ id: string; note: string | null }> {
  const check = storageCheck(file.size, library.quotaBytes, library.bytesUsed ?? 0, maxFileBytes);
  if (!check.fits) {
    throw new UploadStop(
      check.reason === "file"
        ? `Soubor má ${formatBytes(file.size)}, nahrát jde nejvýš ${formatBytes(maxFileBytes)}.`
        : `Soubor má ${formatBytes(file.size)}, v knihovně zbývá ${formatBytes(check.remaining)} ${zBefore(formatBytes(library.quotaBytes))} ${formatBytes(library.quotaBytes)}. Smažte některý dokument.`,
    );
  }

  let result: Converted;
  try {
    const conv = await import("@/src/files/convert/index");
    result = await conv.convertFile(file, DEFAULT_OPTS, (p) => onProgress(progressText(p.phase, p.done, p.total)));
  } catch (error) {
    throw new UploadStop(convertErrorMessage(error));
  }

  let parsed;
  try {
    parsed = parseDmd(result.dmd);
  } catch (error) {
    if (error instanceof DmdLimitError) throw new UploadStop(`Dokument je na jedno nahrání příliš velký (${error.message}). Rozdělte ho na menší části.`);
    throw new UploadStop("Převedený text nejde zpracovat.");
  }

  onProgress("Balím text…");
  const text = result.dmd;
  const [contentSha256, gz] = await Promise.all([sha256Text(text), gzipText(text)]);
  if (gz.size > LIMITS.maxUploadBytes - 64 * 1024) {
    throw new UploadStop(`Text má i po kompresi ${formatBytes(gz.size)}, na jedno nahrání je to moc. Rozdělte dokument na menší části.`);
  }
  const meta = {
    ...buildUploadMeta({
      libraryId: library.id,
      file: { name: result.fileName, bytes: result.bytes, sha256: result.fileSha256 },
      result,
      parsed,
      contentSha256,
      // Who uploads answers for having the right to (the rules on the page).
      rights: "jine",
      docTypeHint: null,
    }),
    original: true as const,
    folderId,
  };

  onProgress("Nahrávám text…");
  let res: Response;
  try {
    res = await fetch("/api/files/documents", { method: "POST", body: uploadForm(meta, gz), credentials: "same-origin" });
  } catch {
    throw new UploadStop("Spojení se serverem se přerušilo. Zkuste to znovu.");
  }
  const outcome = uploadOutcome(res.status, await res.json().catch(() => null));
  if (!outcome.ok) throw new UploadStop(outcome.message);

  try {
    await uploadOriginal(outcome.id, file, onProgress);
    return { id: outcome.id, note: null };
  } catch (error) {
    const why = error instanceof UploadStop ? error.message : "Originál se nepodařilo uložit.";
    return { id: outcome.id, note: `Text je nahraný a asistent v něm hledá, jen se neuložil originál. ${why}` };
  }
}

