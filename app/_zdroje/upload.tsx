"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { LIMITS } from "@/src/files/config";
import type { ConvertOptions, ConvertResult } from "@/src/files/convert/types";
import { scanDmdOutline, sliceDmd, type DmdOutline } from "@/src/files/convert/slice";
import { parseDmd } from "@/src/files/dmd/parse";
import { DmdLimitError, type ParsedDoc } from "@/src/files/dmd/types";
import { DOC_TYPE_LABELS, DOC_TYPES, RIGHTS, RIGHTS_LABELS, type DocType, type Rights } from "@/src/files/types";
import type { LibrarySummary } from "@/src/files/web-types";
import { countPages, formatBytes, formatCount, plural } from "./format";
import { ZIcon } from "./icons";
import { PdfPageCanvas, usePdfDocument } from "./pdf-canvas";
import {
  buildUploadMeta,
  dmdPageFor,
  gzipText,
  leadText,
  nextUnsurePage,
  pageFlagText,
  pageText,
  pageTone,
  previewStats,
  rangeSections,
  sha256Text,
  unsurePages,
  uploadCost,
  uploadForm,
  uploadOutcome,
} from "./upload-core";

/**
 * Upload inside the Vlastní zdroje modal: the dashed dropzone of the design
 * (2b), then per file — one at a time, the rest wait in a queue — the
 * browser conversion with a progress line and the "Náhled převodu" card:
 * statistics, Czech warnings, the page strip coloured by page flags with
 * "další sporná strana", the PDF page drawn next to its converted text,
 * the toggles that re-run the layout (bez poznámek, jednosloupcová sazba,
 * nerozpoznávat m. č., prostý text), page-label calibration, the range
 * (pages, or § / chapters), rights, a type hint and the cost in pages
 * against the remaining quota. "Nahrát" gzips the text and posts it;
 * the original file never leaves the browser.
 *
 * Converters are loaded on demand (pdf.js, mammoth) — nothing of them is in
 * the page bundle until someone drops a file.
 */

type Converted = ConvertResult & { fileSha256: string; fileName: string; bytes: number };

interface Session {
  file: File;
  /** Set while converting: "Čtu PDF… 120 / 480". */
  progress: string | null;
  /** The conversion (PDF: re-laid out on every option change from the cached pdf.js read). */
  result: Converted | null;
  error: string | null;
  /** PDF only: re-run the pure layout with other options. */
  relayout: ((opts: ConvertOptions) => ConvertResult) | null;
}

const DEFAULT_OPTS: ConvertOptions = { footnotes: true, columns: "auto", marginalNumbers: true, plain: false, pageRange: null, labelOffset: null };
const ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

const PHASES: Record<string, string> = {
  read: "Načítám soubor",
  hash: "Počítám otisk souboru",
  pdf: "Čtu strany PDF",
  docx: "Převádím DOCX",
  text: "Převádím text",
  layout: "Skládám text",
  done: "Hotovo",
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

/** Convert one file in the browser. PDFs are read once; the returned relayout re-runs only the layout. */
async function convert(file: File, onProgress: (text: string) => void): Promise<{ result: Converted; relayout: Session["relayout"] }> {
  const conv = await import("@/src/files/convert/index");
  if (file.size > conv.MAX_FILE_BYTES) {
    // convertFile throws the proper Czech message for this.
    await conv.convertFile(file, DEFAULT_OPTS);
  }
  // %PDF- within the first kilobyte, as readers allow (convertFile does the full detection otherwise).
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!String.fromCharCode(...head).includes("%PDF-")) {
    const result = await conv.convertFile(file, DEFAULT_OPTS, (p) => onProgress(progressText(p.phase, p.done, p.total)));
    return { result, relayout: null };
  }
  onProgress(progressText("read", 0, 1));
  const data = await file.arrayBuffer();
  onProgress(progressText("hash", 0, 1));
  const fileSha256 = await conv.sha256Hex(data);
  const pdf = await import("@/src/files/convert/pdf/index");
  const doc = await pdf.readPdf(data, (done, total) => onProgress(progressText("pdf", done, total)));
  onProgress(progressText("layout", 0, 1));
  const relayout = (opts: ConvertOptions) => pdf.layoutToDmd(doc, opts);
  let first: ConvertResult;
  try {
    first = relayout(DEFAULT_OPTS);
  } catch (error) {
    // Over the page cap: start with the first 1 500 pages; the range picker narrows it.
    if ((error as { code?: string })?.code !== "too_large") throw error;
    first = relayout({ ...DEFAULT_OPTS, pageRange: [1, 1_500] });
    first.warnings.unshift("Dokument má víc než 1 500 stran — najednou lze nahrát nejvýš 1 500. Vyberte rozsah.");
  }
  return { result: { ...first, fileSha256, fileName: file.name, bytes: file.size }, relayout };
}

export function Uploader({
  library,
  replace,
  onCancelReplace,
  onUploaded,
}: {
  library: LibrarySummary;
  replace: { id: string; title: string } | null;
  onCancelReplace: () => void;
  onUploaded: (id: string) => void;
}) {
  const [queue, setQueue] = useState<File[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [log, setLog] = useState<Array<{ name: string; ok: boolean; message: string }>>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // Take the next file from the queue whenever nothing is in progress.
  // The ref keeps a re-run of the effect (React's dev double-invoke) from converting a file twice.
  const started = useRef<File | null>(null);
  useEffect(() => {
    if (session || queue.length === 0 || started.current === queue[0]) return;
    const [file, ...rest] = queue;
    started.current = file;
    setQueue(rest);
    setSession({ file, progress: "Připravuji převod…", result: null, error: null, relayout: null });
    // Updates for a file the user cancelled meanwhile are dropped by the `s.file === file` checks.
    const update = (patch: Partial<Session>) => setSession((s) => (s && s.file === file ? { ...s, ...patch } : s));
    void (async () => {
      try {
        const { result, relayout } = await convert(file, (progress) => update({ progress }));
        update({ progress: null, result, relayout });
      } catch (error) {
        update({ progress: null, error: convertErrorMessage(error) });
      }
    })();
  }, [session, queue]);

  function add(files: FileList | File[] | null) {
    const list = [...(files ?? [])];
    if (list.length === 0) return;
    // A re-upload replaces exactly one document: take only the first file.
    setQueue((q) => [...q, ...(replace ? list.slice(0, 1) : list)]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  }

  function finish(entry: { name: string; ok: boolean; message: string } | null) {
    if (entry) setLog((l) => [entry, ...l].slice(0, 6));
    setSession(null);
  }

  const maxMb = 100;

  return (
    <div className="zd-upload">
      {replace ? (
        <div className="zd-banner">
          <span>
            Nahráváte novou verzi dokumentu <strong>{replace.title}</strong>. Metadata se převezmou z původní verze a jen je znovu potvrdíte; starý převod se po zpracování nahradí.
          </span>
          <button type="button" className="zd-link-button" onClick={onCancelReplace}>
            Zrušit
          </button>
        </div>
      ) : null}
      {!session ? (
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
              Přetáhněte {replace ? "novou verzi" : "soubory"} sem, nebo <span className="zd-link">vyberte z počítače</span>
            </span>
            <span className="zd-dropzone-sub">PDF, DOCX, TXT nebo MD · nejvýš {maxMb} MB na soubor · převádí se ve vašem prohlížeči</span>
          </button>
          <input
            ref={picker}
            type="file"
            accept={ACCEPT}
            multiple={!replace}
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}
      {queue.length > 0 ? (
        <p className="zd-muted zd-small">
          Ve frontě: {queue.map((f) => f.name).join(", ")}
        </p>
      ) : null}
      {log.map((entry, i) => (
        <p key={`${entry.name}-${i}`} className={entry.ok ? "zd-ok-line" : "zd-error"} role={entry.ok ? "status" : "alert"}>
          <strong>{entry.name}:</strong> {entry.message}
        </p>
      ))}
      {session ? (
        session.result ? (
          <Preview
            key={session.file.name + session.file.size}
            session={session as Session & { result: Converted }}
            library={library}
            replace={replace}
            onCancel={() => finish(null)}
            onDone={(entry, id) => {
              finish(entry);
              if (id) onUploaded(id);
            }}
          />
        ) : (
          <div className="zd-card">
            <div className="zd-card-head">
              <strong className="zd-ellipsis">{session.file.name}</strong>
              <span className="zd-muted">{formatBytes(session.file.size)}</span>
            </div>
            {session.error ? (
              <>
                <p className="zd-error" role="alert">
                  {session.error}
                </p>
                <button type="button" className="zd-btn zd-btn-secondary" onClick={() => finish({ name: session.file.name, ok: false, message: session.error ?? "" })}>
                  {queue.length > 0 ? "Další soubor" : "Zavřít"}
                </button>
              </>
            ) : (
              <div className="zd-row">
                <p className="zd-progress" role="status" aria-live="polite">
                  <span className="zd-spinner" aria-hidden="true" />
                  {session.progress}
                </p>
                <button type="button" className="zd-btn zd-btn-quiet" onClick={() => finish(null)}>
                  Zrušit
                </button>
              </div>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

type RangeMode = "all" | "pages" | "sections";

/** The "Náhled převodu" card for one converted file. */
function Preview({
  session,
  library,
  replace,
  onCancel,
  onDone,
}: {
  session: Session & { result: Converted };
  library: LibrarySummary;
  replace: { id: string; title: string } | null;
  onCancel: () => void;
  onDone: (entry: { name: string; ok: boolean; message: string }, id: string | null) => void;
}) {
  const base = session.result;
  const isPdf = base.kind === "pdf" && session.relayout !== null;
  const [opts, setOpts] = useState<ConvertOptions>(() => ({ ...DEFAULT_OPTS, pageRange: base.warnings.some((w) => w.includes("1 500 stran")) ? [1, 1_500] : null }));
  const [result, setResult] = useState<ConvertResult>(base);
  const [relayoutError, setRelayoutError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [rangeMode, setRangeMode] = useState<RangeMode>(opts.pageRange ? "pages" : "all");
  const [pageFrom, setPageFrom] = useState(String(opts.pageRange?.[0] ?? 1));
  const [pageTo, setPageTo] = useState(String(opts.pageRange?.[1] ?? base.physicalPages ?? 1));
  const [sectionFrom, setSectionFrom] = useState("");
  const [sectionTo, setSectionTo] = useState("");
  const [calibration, setCalibration] = useState("");
  const [page, setPage] = useState(1);
  const [rights, setRights] = useState<Rights | "">("");
  const [docType, setDocType] = useState<DocType | "">("");
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const pdfDoc = usePdfDocument(isPdf ? session.file : null);

  // Re-run the PDF layout when an option changes (pure, in this tab; big books take a few seconds).
  function applyOptions(next: ConvertOptions) {
    setOpts(next);
    if (!session.relayout) return;
    setWorking(true);
    setRelayoutError(null);
    window.setTimeout(() => {
      try {
        setResult(session.relayout!(next));
      } catch (error) {
        setRelayoutError(convertErrorMessage(error));
      } finally {
        setWorking(false);
      }
    }, 30);
  }

  const outline = useMemo<DmdOutline | null>(() => {
    try {
      return scanDmdOutline(result.dmd);
    } catch {
      return null;
    }
  }, [result.dmd]);
  const sectionChoices = useMemo(() => (outline ? rangeSections(outline) : []), [outline]);

  // The text that would be uploaded: the section range cut out of the conversion.
  const selected = useMemo<{ dmd: string; error: string | null }>(() => {
    if (rangeMode !== "sections" || sectionFrom === "") return { dmd: result.dmd, error: null };
    const from = Number(sectionFrom);
    const to = sectionTo === "" ? from : Number(sectionTo);
    if (to < from) return { dmd: "", error: "Konec rozsahu je před jeho začátkem." };
    try {
      // From the start of the first chosen section to the end of the last one, subsections included.
      return { dmd: sliceDmd(result.dmd, { sections: [from, to] }), error: null };
    } catch {
      return { dmd: "", error: "Tento rozsah nejde vybrat." };
    }
  }, [result.dmd, rangeMode, sectionFrom, sectionTo]);

  const parsed = useMemo<{ doc: ParsedDoc | null; error: string | null }>(() => {
    if (!selected.dmd) return { doc: null, error: selected.error ?? "Vybraný rozsah je prázdný." };
    try {
      return { doc: parseDmd(selected.dmd), error: null };
    } catch (error) {
      if (error instanceof DmdLimitError) return { doc: null, error: `Dokument je na jedno nahrání příliš velký (${error.message}). Vyberte menší rozsah.` };
      return { doc: null, error: "Převedený text nejde zpracovat." };
    }
  }, [selected]);

  const stats = parsed.doc ? previewStats(parsed.doc, result) : null;
  const cost = parsed.doc ? uploadCost(parsed.doc, library.quotaPages, library.pagesUsed ?? 0) : null;
  const selectedOutline = useMemo(() => (selected.dmd ? scanDmdOutline(selected.dmd) : null), [selected.dmd]);
  const flags = result.pageFlags;
  const labels = result.pageLabels;
  const unsure = unsurePages(flags);
  const pageCount = flags.length;
  // PDF page → the page of the selected text (ords there count only the kept pages; labels match).
  const expected = page - ((opts.pageRange?.[0] ?? 1) - 1);
  const textPage = selectedOutline?.paged ? dmdPageFor(selectedOutline, labels[page - 1] ?? String(page), expected) : null;
  const inSelection = !selectedOutline?.paged || textPage !== null;
  const shownText = selectedOutline?.paged ? (textPage !== null ? pageText(selected.dmd, selectedOutline, textPage) : "") : leadText(selected.dmd);

  // Keep the selected page inside the document after a relayout.
  useEffect(() => {
    if (pageCount > 0 && page > pageCount) setPage(1);
  }, [pageCount, page]);

  function applyPageRange() {
    const a = Math.max(1, Math.floor(Number(pageFrom) || 1));
    const b = Math.min(pageCount || a, Math.max(a, Math.floor(Number(pageTo) || a)));
    setPageFrom(String(a));
    setPageTo(String(b));
    applyOptions({ ...opts, pageRange: [a, b] });
    setPage(a);
  }

  function applyCalibration() {
    const printed = Number(calibration);
    if (!Number.isInteger(printed) || printed < -10_000 || printed > 100_000) return;
    applyOptions({ ...opts, labelOffset: printed - 1 });
  }

  async function upload() {
    if (!parsed.doc || !cost || !rights) return;
    setUploadError(null);
    try {
      setUploading("Balím text…");
      const text = selected.dmd;
      const [contentSha256, gz] = await Promise.all([sha256Text(text), gzipText(text)]);
      if (gz.size > LIMITS.maxUploadBytes - 64 * 1024) {
        setUploading(null);
        setUploadError(`Text má i po kompresi ${formatBytes(gz.size)} — na jedno nahrání je to moc. Vyberte menší rozsah.`);
        return;
      }
      const meta = buildUploadMeta({
        libraryId: library.id,
        file: { name: base.fileName, bytes: base.bytes, sha256: base.fileSha256 },
        result,
        parsed: parsed.doc,
        contentSha256,
        rights,
        docTypeHint: docType || null,
        replaces: replace?.id ?? null,
      });
      setUploading(`Nahrávám ${formatBytes(gz.size)}…`);
      let res: Response;
      try {
        res = await fetch("/api/files/documents", { method: "POST", body: uploadForm(meta, gz), credentials: "same-origin" });
      } catch {
        setUploading(null);
        setUploadError("Spojení se serverem se přerušilo. Zkuste to znovu.");
        return;
      }
      const outcome = uploadOutcome(res.status, await res.json().catch(() => null));
      setUploading(null);
      if (outcome.ok) {
        onDone({ name: base.fileName, ok: true, message: "nahráno, zpracovává se." }, outcome.id);
      } else if (res.status === 409) {
        onDone({ name: base.fileName, ok: false, message: outcome.message }, null);
      } else {
        setUploadError(outcome.message);
      }
    } catch {
      setUploading(null);
      setUploadError("Text se nepodařilo připravit k nahrání. Zkuste to znovu.");
    }
  }

  const warnings = [...result.warnings, ...(relayoutError ? [relayoutError] : [])];

  return (
    <section className="zd-card zd-preview" aria-label={`Náhled převodu: ${base.fileName}`}>
      <div className="zd-card-head">
        <strong>Náhled převodu</strong>
        <span className="zd-muted zd-ellipsis">
          {base.fileName} · {formatBytes(base.bytes)}
        </span>
      </div>

      {stats ? (
        <dl className="zd-stats">
          {stats.pages !== null ? <Stat label="Strany" value={formatCount(stats.pages)} /> : null}
          <Stat label="Poznámky" value={stats.footnotes === 0 ? "žádné" : `${formatCount(stats.footnotes)} · svázáno ${stats.linkedPercent}%`} />
          <Stat label="Nadpisy" value={formatCount(stats.headings)} />
          {stats.paragraphs > 0 ? <Stat label="§ oddíly" value={formatCount(stats.paragraphs)} /> : null}
          {stats.marginalNumbers > 0 ? <Stat label="m. č." value={formatCount(stats.marginalNumbers)} /> : null}
          <Stat label="Čísla stran" value={stats.labelSource} />
          {stats.plainMode || opts.plain ? <Stat label="Režim" value="prostý text (OCR)" /> : null}
        </dl>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="zd-warnings">
          {warnings.map((w, i) => (
            <li key={i}>
              <ZIcon name="alert" size={14} /> {w}
            </li>
          ))}
        </ul>
      ) : null}

      {isPdf ? (
        <fieldset className="zd-toggles" disabled={working}>
          <legend className="zd-sr">Možnosti převodu</legend>
          <Toggle label="bez poznámek" checked={!opts.footnotes} onChange={(v) => applyOptions({ ...opts, footnotes: !v })} />
          <Toggle label="jednosloupcová sazba" checked={opts.columns === "single"} onChange={(v) => applyOptions({ ...opts, columns: v ? "single" : "auto" })} />
          <Toggle label="nerozpoznávat m. č." checked={!opts.marginalNumbers} onChange={(v) => applyOptions({ ...opts, marginalNumbers: !v })} />
          <Toggle label="prostý text" checked={opts.plain} onChange={(v) => applyOptions({ ...opts, plain: v })} />
          {working ? (
            <span className="zd-progress" role="status">
              <span className="zd-spinner" aria-hidden="true" />
              Přepočítávám…
            </span>
          ) : null}
        </fieldset>
      ) : null}

      {isPdf && pageCount > 0 ? (
        <div className="zd-pages">
          <div className="zd-pages-bar">
            <label className="zd-inline-field">
              <span>Strana PDF</span>
              <input type="number" min={1} max={pageCount} value={page} onChange={(e) => setPage(Math.min(pageCount, Math.max(1, Number(e.target.value) || 1)))} />
            </label>
            <span className="zd-muted">
              tištěná s. {labels[page - 1] ?? page}
              {flags[page - 1] ? ` · ${pageFlagText(flags[page - 1])}` : ""}
            </span>
            <button type="button" className="zd-btn zd-btn-secondary" disabled={unsure.length === 0} onClick={() => setPage(nextUnsurePage(flags, page) ?? page)}>
              další sporná strana{unsure.length > 0 ? ` (${unsure.length})` : ""}
            </button>
          </div>
          <div
            className="zd-strip"
            aria-hidden="true"
            onClick={(e) => {
              const n = Number((e.target as HTMLElement).dataset.page);
              if (n) setPage(n);
            }}
          >
            {flags.map((f, i) => (
              <span key={i} data-page={i + 1} data-tone={pageTone(f)} data-current={page === i + 1 || undefined} title={`s. ${labels[i] ?? i + 1}${f ? ` — ${pageFlagText(f)}` : ""}`} />
            ))}
          </div>
          <div className="zd-side-by-side">
            <PdfPageCanvas doc={pdfDoc} page={page} label={labels[page - 1] ?? String(page)} />
            <pre className="zd-page-text">{inSelection ? shownText || "(strana bez textu)" : "Tato strana je mimo vybraný rozsah."}</pre>
          </div>
        </div>
      ) : (
        <pre className="zd-page-text zd-page-text-solo">{shownText || "(bez textu)"}</pre>
      )}

      <div className="zd-form-grid">
        {isPdf ? (
          <label className="zd-field">
            <span>Kalibrace čísel stran: PDF s. 1 = tištěná s.</span>
            <span className="zd-row">
              <input type="number" inputMode="numeric" value={calibration} placeholder={labels[0] ?? "1"} onChange={(e) => setCalibration(e.target.value)} />
              <button type="button" className="zd-btn zd-btn-secondary" onClick={applyCalibration} disabled={working || calibration === ""}>
                Použít
              </button>
            </span>
          </label>
        ) : null}

        <div className="zd-field">
          <span>Rozsah</span>
          <span className="zd-segment" role="radiogroup" aria-label="Rozsah">
            <SegmentButton on={rangeMode === "all"} onClick={() => {
              setRangeMode("all");
              if (opts.pageRange && pageCount <= 1_500) applyOptions({ ...opts, pageRange: null });
            }}>celý dokument</SegmentButton>
            {isPdf ? <SegmentButton on={rangeMode === "pages"} onClick={() => setRangeMode("pages")}>strany</SegmentButton> : null}
            {sectionChoices.length > 0 ? <SegmentButton on={rangeMode === "sections"} onClick={() => setRangeMode("sections")}>§ / kapitoly</SegmentButton> : null}
          </span>
          {rangeMode === "pages" && isPdf ? (
            <span className="zd-row">
              <input aria-label="Od strany PDF" type="number" min={1} max={pageCount} value={pageFrom} onChange={(e) => setPageFrom(e.target.value)} />
              <span>–</span>
              <input aria-label="Do strany PDF" type="number" min={1} max={pageCount} value={pageTo} onChange={(e) => setPageTo(e.target.value)} />
              <button type="button" className="zd-btn zd-btn-secondary" onClick={applyPageRange} disabled={working}>
                Použít
              </button>
            </span>
          ) : null}
          {rangeMode === "sections" ? (
            <span className="zd-row zd-row-wrap">
              <select aria-label="Od oddílu" value={sectionFrom} onChange={(e) => setSectionFrom(e.target.value)}>
                <option value="">od…</option>
                {sectionChoices.map((s) => (
                  <option key={s.ord} value={s.ord}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select aria-label="Do oddílu" value={sectionTo} onChange={(e) => setSectionTo(e.target.value)}>
                <option value="">do (stejný oddíl)</option>
                {sectionChoices
                  .filter((s) => sectionFrom === "" || s.ord >= Number(sectionFrom))
                  .map((s) => (
                    <option key={s.ord} value={s.ord}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </span>
          ) : null}
        </div>

        <label className="zd-field">
          <span>Práva k textu</span>
          <select value={rights} onChange={(e) => setRights(e.target.value as Rights | "")} required>
            <option value="">Vyberte…</option>
            {RIGHTS.map((r) => (
              <option key={r} value={r}>
                {RIGHTS_LABELS[r]}
              </option>
            ))}
          </select>
        </label>

        <label className="zd-field">
          <span>Typ dokumentu</span>
          <select value={docType} onChange={(e) => setDocType(e.target.value as DocType | "")}>
            <option value="">nechat navrhnout</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOC_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {parsed.error ? (
        <p className="zd-error" role="alert">
          {parsed.error}
        </p>
      ) : null}
      {cost ? (
        <p className={cost.fits ? "zd-cost" : "zd-error"}>
          {cost.fits
            ? cost.line
            : `Dokument má ${countPages(cost.pages)}, v knihovně ${plural(cost.remaining, "zbývá", "zbývají", "zbývá")} ${countPages(cost.remaining)}. Vyberte menší rozsah nebo smažte jiný dokument.`}
        </p>
      ) : null}
      {uploadError ? (
        <p className="zd-error" role="alert">
          {uploadError}
        </p>
      ) : null}

      <div className="zd-card-actions">
        <button type="button" className="zd-btn zd-btn-quiet" onClick={onCancel} disabled={uploading !== null}>
          Zrušit
        </button>
        <button
          type="button"
          className="zd-btn zd-btn-primary"
          onClick={() => void upload()}
          disabled={!parsed.doc || !cost?.fits || !rights || working || uploading !== null}
          title={!rights ? "Vyberte, jaká práva k textu máte." : undefined}
        >
          {uploading ?? "Nahrát"}
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="zd-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="zd-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function SegmentButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="zd-segment-button" onClick={onClick}>
      {children}
    </button>
  );
}
