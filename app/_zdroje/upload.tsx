"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySummary } from "@/src/files/web-types";
import { registerUnsavedWork } from "./store";
import { missingBrowserFeatures, UNSUPPORTED_BROWSER } from "./upload-core";

/**
 * Uploading on the Vlastní soubory page: files dropped anywhere on the list
 * or picked with "Nahrát soubory" queue up and go one at a time. Each one is
 * converted to text in the browser (the text layer the assistant searches),
 * that text is posted (POST /api/files/documents, into the open folder),
 * and then the original file itself follows in parts
 * (PUT …/original?part=N, POST …/original to finish) so the user can open
 * and download it later (./upload-process.ts, loaded with the first file).
 * The server classifies the text and proposes the metadata; the row spins
 * until that is done.
 *
 * The storage quota (originals, MB) is checked against what the summary
 * last reported, before any conversion work; the server checks it again.
 * Uploading accepts the content rules stated on the page (the server records
 * the acceptance with the first upload). Leaving the page while a file is
 * being converted or waits asks first.
 */

export const ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

export type UploadLogEntry = { name: string; ok: boolean; message: string };

/**
 * The upload queue of one library: `add` takes picked or dropped files into
 * the folder open at that moment; one file is processed at a time.
 */
export function useUploads({
  library,
  folderId,
  maxFileBytes,
  onUploaded,
}: {
  library: LibrarySummary;
  folderId: string | null;
  maxFileBytes: number;
  onUploaded: (id: string) => void;
}) {
  const [queue, setQueue] = useState<Array<{ file: File; folderId: string | null }>>([]);
  const [current, setCurrent] = useState<{ file: File; progress: string } | null>(null);
  const [log, setLog] = useState<UploadLogEntry[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => setUnsupported(missingBrowserFeatures().length > 0), []);

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
  const props = useRef({ library, maxFileBytes, onUploaded });
  props.current = { library, maxFileBytes, onUploaded };

  // The ref keeps a re-run of the effect (React's dev double-invoke) from uploading a file twice.
  const started = useRef<File | null>(null);
  useEffect(() => {
    if (current || queue.length === 0 || started.current === queue[0].file) return;
    const [next, ...rest] = queue;
    started.current = next.file;
    setQueue(rest);
    setCurrent({ file: next.file, progress: "Připravuji převod…" });
    const update = (progress: string) => setCurrent((c) => (c && c.file === next.file ? { ...c, progress } : c));
    const { library: lib, maxFileBytes: max } = props.current;
    void (async () => {
      try {
        const { processFile } = await import("./upload-process");
        const { id, note } = await processFile(next.file, lib, next.folderId, max, update);
        if (note) setLog((l) => [{ name: next.file.name, ok: false, message: note }, ...l].slice(0, 8));
        props.current.onUploaded(id);
      } catch (error) {
        const message = error instanceof Error && error.name === "UploadStop" ? error.message : "Nahrávání se nepodařilo. Zkuste to prosím znovu.";
        const entry = { name: next.file.name, ok: false, message };
        setLog((l) => [entry, ...l].slice(0, 8));
      }
      setCurrent(null);
    })();
  }, [current, queue]);

  const add = useCallback(
    (files: FileList | File[] | null) => {
      const list = [...(files ?? [])];
      if (list.length === 0) return;
      setQueue((q) => [...q, ...list.map((file) => ({ file, folderId }))]);
    },
    [folderId],
  );
  const dismiss = useCallback((index: number) => setLog((l) => l.filter((_, i) => i !== index)), []);

  return { add, current, queue, log, dismiss, unsupported, unsupportedText: UNSUPPORTED_BROWSER };
}
