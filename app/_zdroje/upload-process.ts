import { LIMITS, ORIGINAL_PART_BYTES } from "@/src/files/config";
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

/** PUT an original's parts, then finish it. Throws UploadStop with a Czech message. */
async function uploadOriginal(id: string, file: File, onProgress: (text: string) => void): Promise<void> {
  const base = `/api/files/documents/${encodeURIComponent(id)}/original`;
  const parts = Math.max(1, Math.ceil(file.size / ORIGINAL_PART_BYTES));
  for (let n = 0; n < parts; n++) {
    const body = file.slice(n * ORIGINAL_PART_BYTES, Math.min(file.size, (n + 1) * ORIGINAL_PART_BYTES));
    onProgress(parts > 1 ? `Ukládám originál… ${Math.round((n / parts) * 100)} %` : "Ukládám originál…");
    let done = false;
    // One retry per part: the server stores a part idempotently.
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(`${base}?part=${n}`, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" }, credentials: "same-origin" });
      } catch {
        res = null;
      }
      if (res?.ok) done = true;
      else if (res && res.status < 500) throw new UploadStop(await errorText(res, "Originál se nepodařilo uložit."));
    }
    if (!done) throw new UploadStop("Spojení se přerušilo při ukládání originálu.");
  }
  let res: Response;
  try {
    res = await fetch(base, { method: "POST", credentials: "same-origin" });
  } catch {
    throw new UploadStop("Spojení se přerušilo při ukládání originálu.");
  }
  if (!res.ok) throw new UploadStop(await errorText(res, "Originál se nepodařilo uložit."));
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

