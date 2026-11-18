"use client";

import { createElement, Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentDetail, DocumentListItem } from "@/src/files/web-types";
import { api } from "./api";

/**
 * The preview of one document in the side panel of the files page: the
 * original itself, drawn in the browser. A PDF's pages are rendered by
 * pdf.js onto canvases (a few at a time, more on request), a DOCX is laid
 * out into pages by docx-preview (mammoth's flowing text from a whitelist of
 * tags when that fails), a TXT or MD file is
 * shown as text. Nothing is framed (the site forbids framing) and nothing
 * the file contains runs. A document whose original was never stored
 * (uploaded before originals were kept) shows the start of its text.
 * pdf.js and mammoth load only when a preview needs them.
 */

/** Bigger originals are not downloaded just for a preview: the panel offers to open them instead. */
export const PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
const PAGES_STEP = 4;

type State =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "pdf"; pages: number }
  | { kind: "html"; nodes: ReactNode[] }
  | { kind: "docx"; data: ArrayBuffer }
  | { kind: "text"; text: string; legacy: boolean };

/** Tags of mammoth's HTML that the preview draws; anything else keeps only its text. */
const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sup", "sub", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "br", "a", "img"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "svg", "math", "template"]);

/**
 * Mammoth's HTML turned into React elements from a whitelist: formatting
 * tags only, links only to http(s)/mailto, images only as data: URLs of
 * raster types, no other attribute. No HTML string ever reaches the DOM
 * (no raw HTML injection anywhere in the Vlastní soubory UI).
 */
export function docHtmlToReact(html: string): ReactNode[] {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild;
  let key = 0;
  const walk = (node: Node): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return null;
    const children = [...el.childNodes].map(walk);
    if (!TAGS.has(tag)) return createElement(Fragment, { key: key++ }, ...children);
    const props: Record<string, unknown> = { key: key++ };
    if (tag === "a") {
      const href = el.getAttribute("href")?.trim() ?? "";
      if (/^(https?:|mailto:)/i.test(href)) Object.assign(props, { href, target: "_blank", rel: "noopener noreferrer nofollow" });
    } else if (tag === "img") {
      const src = el.getAttribute("src")?.trim() ?? "";
      if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return null;
      Object.assign(props, { src, alt: "" });
      return createElement("img", props);
    } else if (tag === "td" || tag === "th") {
      const colSpan = Number(el.getAttribute("colspan"));
      const rowSpan = Number(el.getAttribute("rowspan"));
      if (colSpan > 1 && colSpan < 100) props.colSpan = colSpan;
      if (rowSpan > 1 && rowSpan < 1000) props.rowSpan = rowSpan;
    }
    if (tag === "br") return createElement("br", props);
    return createElement(tag, props, ...children);
  };
  return root ? [...root.childNodes].map(walk) : [];
}

export function DocPreview({ doc }: { doc: DocumentListItem }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [shown, setShown] = useState(PAGES_STEP);
  const pdfRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const tooBig = doc.original === "ready" && (doc.fileBytes ?? 0) > PREVIEW_MAX_BYTES;

  useEffect(() => {
    const ctrl = new AbortController();
    let pdfTask: { destroy: () => Promise<void> } | null = null;
    setState({ kind: "loading" });
    setShown(PAGES_STEP);
    void (async () => {
      try {
        if (doc.original !== "ready") {
          const res = await api<DocumentDetail>(`/api/files/documents/${encodeURIComponent(doc.id)}`, { signal: ctrl.signal });
          setState(res.ok ? { kind: "text", text: res.data.preview, legacy: true } : { kind: "error", text: res.error });
          return;
        }
        if (tooBig) return;
        const res = await fetch(`/api/files/documents/${encodeURIComponent(doc.id)}/original`, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) {
          setState({ kind: "error", text: "Náhled se nepodařilo načíst. Soubor si můžete stáhnout." });
          return;
        }
        if (doc.fileKind === "pdf") {
          const data = new Uint8Array(await res.arrayBuffer());
          const { loadPdfJs } = await import("@/src/files/convert/pdf/pdfjs");
          const pdfjs = await loadPdfJs();
          const task = pdfjs.getDocument({ data, enableXfa: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
          pdfTask = task;
          const pdf = await task.promise;
          if (ctrl.signal.aborted) return;
          pdfRef.current = pdf;
          setState({ kind: "pdf", pages: pdf.numPages });
        } else if (doc.fileKind === "docx") {
          const buffer = await res.arrayBuffer();
          if (!ctrl.signal.aborted) setState({ kind: "docx", data: buffer });
        } else {
          const text = await res.text();
          if (!ctrl.signal.aborted) setState({ kind: "text", text: text.slice(0, 200_000), legacy: false });
        }
      } catch {
        if (!ctrl.signal.aborted) setState({ kind: "error", text: "Náhled se nepodařilo zobrazit. Soubor si můžete stáhnout." });
      }
    })();
    return () => {
      ctrl.abort();
      pdfRef.current = null;
      void pdfTask?.destroy().catch(() => undefined);
    };
  }, [doc.id, doc.original, doc.fileKind, tooBig]);

  if (tooBig) {
    return (
      <div className="fp-preview fp-preview-note">
        <p>Soubor je na náhled příliš velký. Otevřete si ho nebo ho stáhněte.</p>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="fp-preview fp-preview-note">
        <p className="zd-progress" role="status">
          <span className="zd-spinner" aria-hidden="true" />
          Načítám náhled…
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="fp-preview fp-preview-note">
        <p>{state.text}</p>
      </div>
    );
  }
  if (state.kind === "pdf") {
    const count = Math.min(shown, state.pages);
    return (
      <div className="fp-preview" aria-label="Náhled dokumentu">
        {Array.from({ length: count }, (_, i) => (
          <PdfPage key={i} pdf={pdfRef} number={i + 1} />
        ))}
        {state.pages > count ? (
          <button type="button" className="zd-btn zd-btn-secondary fp-preview-more" onClick={() => setShown((n) => n + PAGES_STEP * 2)}>
            Další strany ({count} z {state.pages})
          </button>
        ) : null}
      </div>
    );
  }
  if (state.kind === "docx") {
    return <DocxPages data={state.data} onFail={(nodes) => setState(nodes ? { kind: "html", nodes } : { kind: "error", text: "Náhled se nepodařilo zobrazit. Soubor si můžete stáhnout." })} />;
  }
  if (state.kind === "html") {
    return (
      <div className="fp-preview" aria-label="Náhled dokumentu">
        <div className="fp-page fp-page-doc">{state.nodes}</div>
      </div>
    );
  }
  return (
    <div className="fp-preview" aria-label="Náhled dokumentu">
      {state.legacy ? <p className="zd-muted zd-small fp-preview-legacy">Originál tohoto souboru není uložený, nahrál se dřív. Ukazuji začátek jeho textu.</p> : null}
      <pre className="fp-page fp-page-text">{state.text}</pre>
    </div>
  );
}

/** One PDF page on a canvas, drawn at the panel's width (sharp on retina). */
function PdfPage({ pdf, number }: { pdf: { current: import("pdfjs-dist").PDFDocumentProxy | null }; number: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const doc = pdf.current;
      const el = canvas.current;
      if (!doc || !el) return;
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const width = el.parentElement?.clientWidth || 360;
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        el.style.aspectRatio = `${base.width} / ${base.height}`;
        task = page.render({ canvas: el, viewport } as never) as unknown as { cancel: () => void; promise: Promise<void> };
        await task.promise;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number]);
  return (
    <div className="fp-page fp-page-pdf">
      {failed ? <p className="zd-muted zd-small">Stranu {number} se nepodařilo vykreslit.</p> : <canvas ref={canvas} aria-label={`Strana ${number}`} />}
    </div>
  );
}

/** Width docx-preview lays an A4 page out at (210 mm at 96 dpi); the panel scales it down to its own width. */
const DOCX_PAGE_PX = 794;

/**
 * A Word file laid out into pages like Word prints it (docx-preview, in the
 * browser): page size and margins, headers, footers and footnotes, scaled to
 * the panel. Embedded HTML chunks are not rendered and links that are not
 * http(s)/mailto lose their target. If the layout fails, the flowing text of
 * mammoth (docHtmlToReact) is shown instead.
 */
function DocxPages({ data, onFail }: { data: ArrayBuffer; onFail: (fallback: ReactNode[] | null) => void }) {
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    let cancelled = false;
    const el = body.current;
    const css = styles.current;
    if (!el || !css) return;
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        await renderAsync(data, el, css, {
          className: "fp-docx",
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderAltChunks: false,
          renderComments: false,
          renderChanges: false,
          useBase64URL: true,
          experimental: false,
        });
        if (cancelled) return;
        el.querySelectorAll("a").forEach((a) => {
          const href = a.getAttribute("href")?.trim() ?? "";
          if (/^(https?:|mailto:)/i.test(href)) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer nofollow");
          } else if (!href.startsWith("#")) a.removeAttribute("href");
        });
        el.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
        setZoom(Math.min(1, (el.clientWidth || 400) / DOCX_PAGE_PX));
      } catch {
        if (cancelled) return;
        try {
          const mod = (await import("mammoth")) as typeof import("mammoth") & { default?: typeof import("mammoth") };
          const mammoth = mod.default ?? mod;
          const out = await mammoth.convertToHtml({ arrayBuffer: data }, { externalFileAccess: false } as never);
          if (!cancelled) failRef.current(docHtmlToReact(out.value));
        } catch {
          if (!cancelled) failRef.current(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div className="fp-preview fp-preview-docx" aria-label="Náhled dokumentu">
      <div ref={styles} hidden />
      <div ref={body} className="fp-docx-host" style={{ ["--docx-zoom" as string]: String(zoom) }} />
    </div>
  );
}
