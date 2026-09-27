"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One page of the user's PDF drawn on a canvas, next to the converted text
 * of that page in the preview — so a wrong footnote zone, a lost heading
 * or a column mix-up shows at a glance. pdf.js is the same legacy build
 * (and worker) the converter uses; the file is opened once per preview and
 * released when the preview goes away. Nothing leaves the browser.
 */

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((lib) => {
      if (!lib.GlobalWorkerOptions.workerPort && typeof Worker !== "undefined") {
        lib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
      }
      return lib;
    })
    .catch((error: unknown) => {
      pdfjs = null;
      throw error;
    });
  return pdfjs;
}

/** Open `file` once for as long as the component using it lives. */
export function usePdfDocument(file: File | null): PdfDoc | null {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let opened: PdfDoc | null = null;
    let destroy: (() => Promise<void>) | null = null;
    void (async () => {
      try {
        const lib = await loadPdfJs();
        const data = new Uint8Array(await file.arrayBuffer());
        const task = lib.getDocument({ data, disableFontFace: false, isOffscreenCanvasSupported: false, enableXfa: false });
        destroy = () => task.destroy();
        opened = await task.promise;
        if (cancelled) void task.destroy();
        else setDoc(opened);
      } catch {
        // The preview text still works without the picture.
      }
    })();
    return () => {
      cancelled = true;
      setDoc(null);
      void destroy?.();
    };
  }, [file]);
  return doc;
}

export function PdfPageCanvas({ doc, page, label }: { doc: PdfDoc | null; page: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!doc || !canvas.current || page < 1 || page > doc.numPages) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    setFailed(false);
    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled || !canvas.current) return;
        const el = canvas.current;
        const width = el.parentElement?.clientWidth || 360;
        const base = p.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = p.getViewport({ scale: (width / base.width) * ratio });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        el.style.width = `${Math.floor(viewport.width / ratio)}px`;
        el.style.height = `${Math.floor(viewport.height / ratio)}px`;
        task = p.render({ canvas: el, viewport });
        await task.promise;
        p.cleanup();
      } catch (error) {
        if ((error as { name?: string })?.name !== "RenderingCancelledException" && !cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);

  if (failed) return <p className="zd-muted">Stranu se nepodařilo vykreslit.</p>;
  return (
    <div className="zd-canvas-wrap">
      {!doc ? <p className="zd-muted">Načítám stranu…</p> : null}
      <canvas ref={canvas} className="zd-canvas" role="img" aria-label={`Strana ${label} v PDF`} />
    </div>
  );
}
