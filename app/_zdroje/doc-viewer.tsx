"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentDetail, DocumentListItem } from "@/src/files/web-types";
import { api } from "./api";
import { docHtmlToReact } from "./doc-preview";
import { ZIcon } from "./icons";

/**
 * The document viewer of the files page: a large window over the page with
 * the original's pages in the middle, their thumbnails on the left, the page
 * counter and the zoom at the bottom right, and Stáhnout at the top — opened
 * by clicking a file (?dokument=<id>), closed with × or Escape.
 *
 * Everything is drawn in the browser: a PDF by pdf.js (each page rendered
 * when it scrolls near, at the current zoom), a Word file laid out into
 * pages by docx-preview (embedded HTML chunks off, links only http(s)/mailto;
 * mammoth's flowing text from a whitelist of tags if the layout fails), a
 * TXT or MD file as text. Nothing is framed and nothing in the file runs.
 * A document whose original was never stored shows the start of its text.
 */

/** Bigger originals are not downloaded just to be viewed: the window offers the download. */
export const VIEW_MAX_BYTES = 40 * 1024 * 1024;
/** Width docx-preview lays an A4 page out at (210 mm at 96 dpi). */
const DOCX_PAGE_PX = 794;
const THUMB_PX = 112;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

type State =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "big" }
  | { kind: "pdf"; pdf: PdfDoc; pages: number; aspect: number }
  | { kind: "docx"; data: ArrayBuffer }
  | { kind: "html"; nodes: ReactNode[] }
  | { kind: "text"; text: string; legacy: boolean };

export function DocViewer({ doc, onClose, actions }: { doc: DocumentListItem; onClose: () => void; actions?: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [mainWidth, setMainWidth] = useState(800);
  const main = useRef<HTMLDivElement>(null);
  const originalUrl = `/api/files/documents/${encodeURIComponent(doc.id)}/original`;
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(doc.fileName)?.[1] ?? doc.fileKind).toLowerCase();

  // ---- load ----
  useEffect(() => {
    const ctrl = new AbortController();
    let pdfTask: { destroy: () => Promise<void> } | null = null;
    setState({ kind: "loading" });
    setPage(1);
    setPages(0);
    void (async () => {
      try {
        if (doc.original !== "ready") {
          const res = await api<DocumentDetail>(`/api/files/documents/${encodeURIComponent(doc.id)}`, { signal: ctrl.signal });
          if (!ctrl.signal.aborted) setState(res.ok ? { kind: "text", text: res.data.preview, legacy: true } : { kind: "error", text: res.error });
          return;
        }
        if ((doc.fileBytes ?? 0) > VIEW_MAX_BYTES) {
          setState({ kind: "big" });
          return;
        }
        const res = await fetch(originalUrl, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) {
          setState({ kind: "error", text: "Soubor se nepodařilo načíst. Můžete si ho stáhnout." });
          return;
        }
        if (doc.fileKind === "pdf") {
          const data = new Uint8Array(await res.arrayBuffer());
          const { loadPdfJs } = await import("@/src/files/convert/pdf/pdfjs");
          const pdfjs = await loadPdfJs();
          const task = pdfjs.getDocument({ data, enableXfa: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
          pdfTask = task;
          const pdf = await task.promise;
          const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
          if (ctrl.signal.aborted) return;
          setPages(pdf.numPages);
          setState({ kind: "pdf", pdf, pages: pdf.numPages, aspect: first.height / first.width });
        } else if (doc.fileKind === "docx") {
          const data = await res.arrayBuffer();
          if (!ctrl.signal.aborted) setState({ kind: "docx", data });
        } else {
          const text = await res.text();
          if (!ctrl.signal.aborted) {
            setPages(1);
            setState({ kind: "text", text: text.slice(0, 400_000), legacy: false });
          }
        }
      } catch {
        if (!ctrl.signal.aborted) setState({ kind: "error", text: "Soubor se nepodařilo zobrazit. Můžete si ho stáhnout." });
      }
    })();
    return () => {
      ctrl.abort();
      void pdfTask?.destroy().catch(() => undefined);
    };
  }, [doc.id, doc.original, doc.fileKind, doc.fileBytes, originalUrl]);

  // ---- window: Escape, no page scroll behind, width of the reading area ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".fp-menu")) onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const measure = () => setMainWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Page width at 100 %: the reading area minus its margins, at most a comfortable 900 px. */
  const fit = Math.max(240, Math.min(mainWidth - 64, 900));
  const pageWidth = Math.round(fit * zoom);

  // ---- current page from the scroll position ----
  /** Top of a page inside the scrolled content (works with docx-preview's CSS zoom too). */
  const topOf = (el: HTMLElement, box: HTMLElement) => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  const onScroll = useCallback(() => {
    const el = main.current;
    if (!el) return;
    const line = el.scrollTop + el.clientHeight / 3;
    let current = 1;
    el.querySelectorAll<HTMLElement>("[data-page]").forEach((p) => {
      if (topOf(p, el) <= line) current = Number(p.dataset.page);
    });
    setPage(current);
  }, []);
  const goTo = useCallback((n: number) => {
    const box = main.current;
    const target = box?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (target && box) box.scrollTo({ top: topOf(target, box) - 16, behavior: "smooth" });
  }, []);

  const zoomIn = () => setZoom((z) => ZOOMS.find((v) => v > z + 0.001) ?? z);
  const zoomOut = () => setZoom((z) => [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? z);

  // ---- content ----
  let body: ReactNode;
  let thumbs: ReactNode = null;
  if (state.kind === "loading") {
    body = (
      <p className="zd-progress dv-note" role="status">
        <span className="zd-spinner" aria-hidden="true" />
        Načítám dokument…
      </p>
    );
  } else if (state.kind === "error" || state.kind === "big") {
    body = (
      <div className="dv-note">
        <p>{state.kind === "big" ? "Soubor je na zobrazení v prohlížeči příliš velký." : state.text}</p>
        {doc.original === "ready" ? (
          <a className="zd-btn zd-btn-primary" href={originalUrl} download>
            Stáhnout soubor
          </a>
        ) : null}
      </div>
    );
  } else if (state.kind === "pdf") {
    body = Array.from({ length: state.pages }, (_, i) => (
      <PdfCanvas key={i} pdf={state.pdf} number={i + 1} width={pageWidth} aspect={state.aspect} root={main} className="dv-page" />
    ));
    thumbs = Array.from({ length: state.pages }, (_, i) => (
      <button key={i} type="button" className="dv-thumb" aria-current={page === i + 1 ? "page" : undefined} onClick={() => goTo(i + 1)} aria-label={`Strana ${i + 1}`}>
        <PdfCanvas pdf={state.pdf} number={i + 1} width={THUMB_PX} aspect={state.aspect} root={null} className="dv-thumb-page" />
        <span className="dv-thumb-label">{i + 1}</span>
      </button>
    ));
  } else if (state.kind === "docx") {
    body = (
      <DocxPages
        data={state.data}
        scale={pageWidth / DOCX_PAGE_PX}
        onPages={setPages}
        onFail={(nodes) => setState(nodes ? { kind: "html", nodes } : { kind: "error", text: "Soubor se nepodařilo zobrazit. Můžete si ho stáhnout." })}
      />
    );
  } else if (state.kind === "html") {
    body = (
      <div className="dv-page dv-page-doc" data-page="1" style={{ width: pageWidth, fontSize: `${13 * zoom}px` }}>
        {state.nodes}
      </div>
    );
  } else {
    body = (
      <>
        {state.legacy ? <p className="dv-legacy">Originál tohoto souboru není uložený, nahrál se dřív. Ukazuji začátek jeho textu.</p> : null}
        <pre className="dv-page dv-page-text" data-page="1" style={{ width: pageWidth, fontSize: `${12.5 * zoom}px` }}>
          {state.text}
        </pre>
      </>
    );
  }

  return (
    <div className="dv-layer" role="dialog" aria-modal="true" aria-label={doc.fileName}>
      <div className="dv-backdrop" onClick={onClose} />
      <div className="dv-window">
        <header className="dv-head">
          <span className={`fp-doc fp-doc-${ext}`}>{ext.toUpperCase().slice(0, 4)}</span>
          <b className="dv-title" title={doc.fileName}>
            {doc.fileName}
          </b>
          <span className="dv-head-actions">
            {doc.original === "ready" ? (
              <a className="dv-tool" href={originalUrl} download>
                <ZIcon name="download" size={16} />
                <span>Stáhnout</span>
              </a>
            ) : null}
            {actions}
            <button type="button" className="dv-tool dv-close" aria-label="Zavřít" onClick={onClose}>
              <ZIcon name="close" size={18} />
            </button>
          </span>
        </header>
        <div className="dv-body">
          {state.kind === "docx" ? <DocxThumbs main={main} page={page} pages={pages} onPick={goTo} /> : thumbs ? <nav className="dv-thumbs" aria-label="Strany">{thumbs}</nav> : null}
          <div className="dv-main" ref={main} onScroll={onScroll}>
            <div className="dv-pages">{body}</div>
          </div>
          {state.kind !== "loading" && state.kind !== "error" && state.kind !== "big" ? (
            <div className="dv-controls">
              {pages > 1 ? (
                <span className="dv-pill">
                  <button type="button" aria-label="Předchozí strana" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                    <ZIcon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} />
                  </button>
                  <span className="dv-count">
                    {page}/{pages}
                  </span>
                  <button type="button" aria-label="Další strana" disabled={page >= pages} onClick={() => goTo(page + 1)}>
                    <ZIcon name="chevron" size={14} />
                  </button>
                </span>
              ) : null}
              <span className="dv-pill">
                <button type="button" aria-label="Zmenšit" disabled={zoom <= ZOOMS[0]} onClick={zoomOut}>
                  −
                </button>
                <button type="button" className="dv-count" aria-label="Přizpůsobit šířce" onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)} %
                </button>
                <button type="button" aria-label="Zvětšit" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={zoomIn}>
                  +
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One PDF page on a canvas at `width` CSS px (sharp on retina), drawn when it
 * comes near the visible part of `root` (or the window for thumbnails) and
 * drawn again when the width changes.
 */
function PdfCanvas({
  pdf,
  number,
  width,
  aspect,
  root,
  className,
}: {
  pdf: PdfDoc;
  number: number;
  width: number;
  aspect: number;
  root: { current: HTMLElement | null } | null;
  className: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(aspect);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      root: root?.current ?? null,
      rootMargin: "1200px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [near, root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const el = canvas.current;
      if (!el) return;
      try {
        const p = await pdf.getPage(number);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = p.getViewport({ scale: (width / base.width) * dpr });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        task = p.render({ canvas: el, viewport } as never) as unknown as { cancel: () => void; promise: Promise<void> };
        await task.promise;
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, number, width]);

  return (
    <div ref={box} className={className} data-page={className === "dv-page" ? number : undefined} style={{ width, height: Math.round(width * ratio) }}>
      {failed ? <p className="dv-page-failed">Stranu {number} se nepodařilo vykreslit.</p> : <canvas ref={canvas} aria-label={`Strana ${number}`} />}
    </div>
  );
}

/**
 * A Word file laid out into pages by docx-preview at `scale` (CSS zoom of
 * the page wrapper). Reports the page count; each page gets data-page.
 */
function DocxPages({
  data,
  scale,
  onPages,
  onFail,
}: {
  data: ArrayBuffer;
  scale: number;
  onPages: (n: number) => void;
  onFail: (fallback: ReactNode[] | null) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPages, onFail });
  callbacks.current = { onPages, onFail };

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
        el.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
        el.querySelectorAll("a").forEach((a) => {
          const href = a.getAttribute("href")?.trim() ?? "";
          if (/^(https?:|mailto:)/i.test(href)) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer nofollow");
          } else if (!href.startsWith("#")) a.removeAttribute("href");
        });
        const sections = el.querySelectorAll<HTMLElement>("section.fp-docx");
        sections.forEach((s, i) => (s.dataset.page = String(i + 1)));
        callbacks.current.onPages(sections.length);
      } catch {
        if (cancelled) return;
        try {
          const mod = (await import("mammoth")) as typeof import("mammoth") & { default?: typeof import("mammoth") };
          const mammoth = mod.default ?? mod;
          const out = await mammoth.convertToHtml({ arrayBuffer: data }, { externalFileAccess: false } as never);
          if (!cancelled) callbacks.current.onFail(docHtmlToReact(out.value));
        } catch {
          if (!cancelled) callbacks.current.onFail(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <>
      <div ref={styles} hidden />
      <div ref={body} className="dv-docx" style={{ ["--docx-zoom" as string]: String(scale) }} />
    </>
  );
}

/** Thumbnails of a laid-out Word file: copies of its pages, scaled down (made once the pages exist). */
function DocxThumbs({ main, page, pages, onPick }: { main: { current: HTMLElement | null }; page: number; pages: number; onPick: (n: number) => void }) {
  const holder = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = holder.current;
    const root = main.current;
    if (!nav || !root || pages === 0) return;
    nav.replaceChildren();
    root.querySelectorAll<HTMLElement>("section.fp-docx").forEach((section, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dv-thumb";
      button.setAttribute("aria-label", `Strana ${i + 1}`);
      button.addEventListener("click", () => onPick(i + 1));
      const frame = document.createElement("div");
      frame.className = "dv-thumb-page dv-thumb-docx";
      const copy = section.cloneNode(true) as HTMLElement;
      copy.removeAttribute("data-page");
      copy.querySelectorAll("a").forEach((a) => a.removeAttribute("href"));
      // Inside a wrapper of the same class, so docx-preview's styles (scoped to it) still apply.
      const wrapper = document.createElement("div");
      wrapper.className = "fp-docx-wrapper";
      wrapper.style.zoom = String(THUMB_PX / DOCX_PAGE_PX);
      wrapper.appendChild(copy);
      frame.appendChild(wrapper);
      const label = document.createElement("span");
      label.className = "dv-thumb-label";
      label.textContent = String(i + 1);
      button.append(frame, label);
      nav.appendChild(button);
    });
  }, [main, pages, onPick]);
  useEffect(() => {
    holder.current?.querySelectorAll(".dv-thumb").forEach((b, i) => {
      if (i + 1 === page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  }, [page, pages]);
  return <nav ref={holder} className="dv-thumbs" aria-label="Strany" />;
}
