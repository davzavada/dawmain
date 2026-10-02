"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { LIMITS } from "@/src/files/config";
import type { ConvertOptions, ConvertResult } from "@/src/files/convert/types";
import { parseDmd } from "@/src/files/dmd/parse";
import { DmdLimitError } from "@/src/files/dmd/types";
import type { LibrarySummary } from "@/src/files/web-types";
import { countPages, countPagesAcc, formatBytes, formatCount, plural } from "./format";
import { ZIcon } from "./icons";
import { registerUnsavedWork } from "./store";
import { buildUploadMeta, gzipText, missingBrowserFeatures, sha256Text, UNSUPPORTED_BROWSER, uploadCost, uploadForm, uploadOutcome } from "./upload-core";

/**
 * Upload inside the Vlastní soubory modal (wireframe 04): drop files, and
 * each one — one at a time, the rest wait in a queue — is converted to text
 * in the browser, gzipped and posted, with no further step. The server's AI
 * classifies it (komentář, článek, kniha…) and proposes the metadata; the
 * document is searchable once it is processed, and the user changes the
 * type or the metadata later in its row of the list. Only the converted Markdown text goes to the server; the
 * original file never leaves the browser and nothing of it is kept.
 *
 * Uploading accepts the content rules stated under the dropzone (the
 * server records the acceptance with the first upload).
 *
 * Closing the modal or leaving the page while a file is being converted or
 * waits asks first. Converters are loaded on demand (pdf.js, mammoth) —
 * nothing of them is in the page bundle until someone drops a file.
 */

type Converted = ConvertResult & { fileSha256: string; fileName: string; bytes: number };

const DEFAULT_OPTS: ConvertOptions = { footnotes: true, columns: "auto", marginalNumbers: true, plain: false, pageRange: null, labelOffset: null };
const ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

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

type LogEntry = { name: string; ok: boolean; message: string };

/** A message for the log, thrown by processFile on anything that stops the upload. */
class UploadStop extends Error {}

/**
 * Convert one file, check it and post it. Resolves with the new document's
 * id; throws UploadStop with the Czech message otherwise. The page cost is
 * checked here against the quota the summary last reported; the server
 * checks it again.
 */
async function processFile(
  file: File,
  library: LibrarySummary,
  onProgress: (text: string) => void,
): Promise<string> {
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

  const cost = uploadCost(parsed, library.quotaPages, library.pagesUsed ?? 0);
  if (!cost.fits) {
    throw new UploadStop(
      `Dokument má ${countPagesAcc(cost.pages)}, v knihovně ${plural(cost.remaining, "zbývá", "zbývají", "zbývá")} ${countPages(cost.remaining)}. Smažte jiný dokument nebo nahrajte jen část.`,
    );
  }

  onProgress("Balím text…");
  const text = result.dmd;
  const [contentSha256, gz] = await Promise.all([sha256Text(text), gzipText(text)]);
  if (gz.size > LIMITS.maxUploadBytes - 64 * 1024) {
    throw new UploadStop(`Text má i po kompresi ${formatBytes(gz.size)} — na jedno nahrání je to moc. Rozdělte dokument na menší části.`);
  }
  const meta = buildUploadMeta({
    libraryId: library.id,
    file: { name: result.fileName, bytes: result.bytes, sha256: result.fileSha256 },
    result,
    parsed,
    contentSha256,
    // Who uploads answers for having the right to (the rules under the dropzone).
    rights: "jine",
    docTypeHint: null,
  });

  onProgress(`Nahrávám ${formatBytes(gz.size)}…`);
  let res: Response;
  try {
    res = await fetch("/api/files/documents", { method: "POST", body: uploadForm(meta, gz), credentials: "same-origin" });
  } catch {
    throw new UploadStop("Spojení se serverem se přerušilo. Zkuste to znovu.");
  }
  const outcome = uploadOutcome(res.status, await res.json().catch(() => null));
  if (!outcome.ok) throw new UploadStop(outcome.message);
  return outcome.id;
}

export function Uploader({ library, onUploaded }: { library: LibrarySummary; onUploaded: (id: string) => void }) {
  const [queue, setQueue] = useState<File[]>([]);
  const [current, setCurrent] = useState<{ file: File; progress: string } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Uploader is loaded only in the browser (next/dynamic, ssr: false): the check can run here.
  const [unsupported] = useState(() => missingBrowserFeatures().length > 0);

  // Work that closing would throw away: a file in progress or files waiting.
  const hasWork = queue.length > 0 || current !== null;
  const work = useRef(hasWork);
  work.current = hasWork;
  useEffect(() => {
    registerUnsavedWork(() => work.current);
    return () => registerUnsavedWork(null);
  }, []);
  useEffect(() => {
    if (!hasWork) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasWork]);

  // The latest props for the running upload (the quota moves after each document).
  const props = useRef({ library, onUploaded });
  props.current = { library, onUploaded };

  // Take the next file from the queue whenever nothing is in progress.
  // The ref keeps a re-run of the effect (React's dev double-invoke) from uploading a file twice.
  const started = useRef<File | null>(null);
  useEffect(() => {
    if (current || queue.length === 0 || started.current === queue[0]) return;
    const [file, ...rest] = queue;
    started.current = file;
    setQueue(rest);
    setCurrent({ file, progress: "Připravuji převod…" });
    const update = (progress: string) => setCurrent((c) => (c && c.file === file ? { ...c, progress } : c));
    const { library: lib } = props.current;
    void (async () => {
      try {
        const id = await processFile(file, lib, update);
        // Nothing to report here: the file's row in the list below spins until it is processed.
        props.current.onUploaded(id);
      } catch (error) {
        const entry = { name: file.name, ok: false, message: error instanceof UploadStop ? error.message : "Nahrávání se nepodařilo. Zkuste to prosím znovu." };
        setLog((l) => [entry, ...l].slice(0, 8));
      }
      setCurrent(null);
    })();
  }, [current, queue]);

  function add(files: FileList | File[] | null) {
    const list = [...(files ?? [])];
    if (list.length === 0) return;
    setQueue((q) => [...q, ...list]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  }

  const maxMb = 100;

  if (unsupported) {
    return (
      <div className="zd-upload">
        <p className="zd-banner" role="alert">
          {UNSUPPORTED_BROWSER}
        </p>
      </div>
    );
  }

  return (
    <div className="zd-upload">
      <div
        className="zd-dropzone"
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <button type="button" className="zd-dropzone-button" onClick={() => picker.current?.click()}>
          <ZIcon name="upload" size={20} style={{ color: "var(--muted)" }} />
          <span className="zd-dropzone-main">
            Přetáhněte soubory sem, nebo <span className="zd-link">vyberte z počítače</span>
          </span>
          <span className="zd-dropzone-sub">
            PDF, DOCX, TXT nebo MD, nejvýš {maxMb} MB. Převádí se na text přímo ve vašem prohlížeči; typ dokumentu rovnou zařadí AI.
          </span>
        </button>
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <p className="zd-muted zd-small zd-upload-rules">
        Nahráním potvrzujete, že k textu máte právo a že nejde o spisy klientů ani neveřejné osobní údaje (
        <a href="/podminky" target="_blank" rel="noopener">
          pravidla
        </a>
        ). Typ a údaje změníte po rozkliknutí řádku.
      </p>
      {current ? (
        <div className="zd-row zd-upload-current">
          <p className="zd-progress" role="status" aria-live="polite">
            <span className="zd-spinner" aria-hidden="true" />
            <strong className="zd-ellipsis">{current.file.name}</strong>
            <span>{current.progress}</span>
          </p>
        </div>
      ) : null}
      {queue.length > 0 ? <p className="zd-muted zd-small">Ve frontě: {queue.map((f) => f.name).join(", ")}</p> : null}
      {log.map((entry, i) => (
        <p key={`${entry.name}-${i}`} className={entry.ok ? "zd-ok-line" : "zd-error"} role={entry.ok ? "status" : "alert"}>
          <strong>{entry.name}:</strong> {entry.message}
        </p>
      ))}
    </div>
  );
}
