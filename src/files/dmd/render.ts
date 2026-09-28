/**
 * Rendering a DMD range for the model (files_get_document). Everything this
 * module returns goes INSIDE the per-response fence: it is document text.
 *
 * Structure is rendered with the reserved brackets ⟦ ⟧, which normalizeDmd
 * strips from every input — so a document can neither forge a page marker
 * or a footnote nor close the fence ("⟦/DOC nonce⟧" also needs the nonce,
 * which is random per response). As a second line of defence any ⟦ ⟧ that
 * still reaches the renderer (an un-normalized source) is turned into [ ].
 *
 * Footnote definitions are driven by the footnote table (by `seq`), not by
 * position alone: a window that shows a reference whose definition lies
 * beyond its end appends that definition, and the next window, which
 * contains the definition, skips it — so a window cut at an inline page
 * break never repeats or loses a note. Isomorphic and pure — unit-tested.
 */

import type { AnchorLabel } from "../types";
import { classifyLine, InlineCursor, readInline, type DmdLine } from "./parse";
import type { RenderFootnote, TextSource } from "./types";

export type { RenderFootnote, TextSource } from "./types";

export interface RenderOptions {
  mode: "after" | "omit";
  anchorLabel?: AnchorLabel | null;
  /** Printed label of the page at an absolute offset (from doc_pages); without it the renderer tracks the markers it sees. */
  pageLabelAt?: (offset: number) => string | null;
}

export const TAIL_HEADING = "— poznámky k tomuto úseku —";

/** Reserved brackets never pass through from the text itself. */
function clean(s: string): string {
  return s.replace(/⟦/g, "[").replace(/⟧/g, "]");
}

function noteMarker(fn: { kind: "f" | "e"; label: string }): string {
  return fn.kind === "e" ? `⟦vysvětl. ${fn.label}⟧` : `⟦pozn. ${fn.label}⟧`;
}

/** "1 poznámka vynechána", "3 poznámky vynechány", "5 poznámek vynecháno". */
function omittedPhrase(n: number): string {
  if (n === 1) return "1 poznámka vynechána";
  if (n >= 2 && n <= 4) return `${n} poznámky vynechány`;
  return `${n} poznámek vynecháno`;
}

/**
 * Render DMD [from, to) (absolute offsets, clamped to the source):
 * - page marker lines "[s. 245]" → "⟦s. 245⟧"; inline " [s. 246] " → " ⟦s. 246⟧ ";
 * - "[m. č. 14] " → "⟦m. č. 14⟧ " (label from anchorLabel, default "m. č.");
 * - refs "[^12]" → "⟦12⟧"; definitions "[^12]: text" → "⟦pozn. 12⟧ text", with
 *   " (s. 245)" after the marker when the note's page label differs from the
 *   page of the surrounding text; endnotes "⟦vysvětl. i⟧"; continuation
 *   lines lose their 4-space indent;
 * - mode "omit": definitions dropped (refs kept), trailer
 *   "(N poznámek vynecháno — footnote: "L")";
 * - definitions whose reference lies in [from, to) but which start at or
 *   after `to` are appended under "— poznámky k tomuto úseku —"; definitions
 *   in the range whose reference lies before `from` are skipped (the window
 *   that showed the reference already appended them);
 * - escapes removed; headings and "> " kept as Markdown.
 * `from` is treated as a line start when the character before it is "\n"
 * or not loaded. Pure.
 */
export function renderRange(src: TextSource, from: number, to: number, footnotes: RenderFootnote[], opts: RenderOptions): string {
  from = Math.max(from, src.start);
  to = Math.min(to, src.end);
  if (to <= from) return "";
  const text = src.slice(from, to);
  const n = text.length;
  const anchorLabel = opts.anchorLabel ?? "m. č.";
  const byDefStart = new Map<number, RenderFootnote>();
  for (const fn of footnotes) byDefStart.set(fn.defStart, fn);
  const atLineStart = from <= src.start || src.slice(from - 1, from) === "\n";

  const cursor = new InlineCursor(text);
  let currentPage: string | null = null;
  const pageAt = (rel: number): string | null => (opts.pageLabelAt ? opts.pageLabelAt(from + rel) : currentPage);

  /** Content of a line with its inline markup rendered. */
  const inline = (line: DmdLine, contentStart = line.contentStart): string => {
    let out = "";
    let c = contentStart;
    for (const m of cursor.take(contentStart, line.end)) {
      const tok = readInline(text, m, line, true);
      if (tok.kind === "escape") {
        out += clean(text.slice(c, tok.at));
        c = tok.at + 1;
      } else if (tok.kind === "ref") {
        out += `${clean(text.slice(c, tok.at))}⟦${tok.label}⟧`;
        c = tok.end;
      } else if (tok.kind === "page") {
        out += `${clean(text.slice(c, tok.at))}⟦s. ${tok.label}⟧`;
        c = tok.end;
        currentPage = tok.label;
      }
    }
    return out + clean(text.slice(c, line.end));
  };

  const out: string[] = [];
  const shown = new Set<number>();
  const omitted: string[] = [];
  let s = 0;
  let first = true;
  while (s <= n) {
    let e = text.indexOf("\n", s);
    if (e === -1) e = n;
    const line: DmdLine = first && !atLineStart ? { ...classifyLine(text, s, s), kind: "text", end: e } : classifyLine(text, s, e);
    first = false;

    switch (line.kind) {
      case "blank":
        out.push("");
        break;
      case "page":
        currentPage = line.label;
        out.push(`⟦s. ${line.label}⟧`);
        break;
      case "heading":
        out.push(`${"#".repeat(line.level)} ${inline(line)}`);
        break;
      case "quote":
        out.push(line.contentStart < line.end ? `> ${inline(line)}` : ">");
        break;
      case "fndef": {
        // The definition and its continuation lines (indented, possibly after blank lines).
        let last = e;
        const more: DmdLine[] = [];
        let probe = e + 1;
        while (probe <= n) {
          let pe = text.indexOf("\n", probe);
          if (pe === -1) pe = n;
          const next = classifyLine(text, probe, pe);
          if (next.kind === "text" && next.indented) {
            more.push(next);
            last = pe;
          } else if (next.kind !== "blank") break;
          probe = pe + 1;
        }
        const fn = byDefStart.get(from + line.contentStart);
        const skip = fn !== undefined && fn.refAt !== null && fn.refAt < from;
        if (!skip && opts.mode === "omit") omitted.push(line.label!);
        if (!skip && opts.mode === "after") {
          if (fn) shown.add(fn.seq);
          const pageLabel = fn?.pageLabel ?? null;
          const tag = pageLabel && pageLabel !== pageAt(line.start) ? ` (s. ${pageLabel})` : "";
          const marker = noteMarker(fn ?? { kind: "f", label: line.label! });
          const body = inline(line);
          out.push(`${marker}${tag}${body ? ` ${body}` : ""}`);
          let prevEnd = e;
          for (const cont of more) {
            // Keep blank lines between paragraphs of one note.
            for (let k = text.indexOf("\n", prevEnd + 1); k !== -1 && k < cont.start; k = text.indexOf("\n", k + 1)) out.push("");
            out.push(inline(cont, cont.start + 4).trimStart());
            prevEnd = cont.end;
          }
        } else if (fn) shown.add(fn.seq);
        s = last + 1;
        continue;
      }
      default:
        out.push(line.anchor !== null ? `⟦${anchorLabel} ${line.anchor}⟧ ${inline(line)}` : inline(line));
    }
    s = e + 1;
  }

  let result = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

  // Notes of references shown here whose definitions lie beyond the range.
  const tail = footnotes
    .filter((fn) => fn.refAt !== null && fn.refAt >= from && fn.refAt < to && fn.defStart >= to && !shown.has(fn.seq))
    .sort((a, b) => a.seq - b.seq);
  if (opts.mode === "omit") {
    for (const fn of tail) omitted.push(fn.label);
    if (omitted.length) result += `\n\n(${omittedPhrase(omitted.length)} — footnote: "${omitted[0]}")`;
    return result;
  }
  if (tail.length) {
    const endPage = opts.pageLabelAt ? opts.pageLabelAt(to - 1) : currentPage;
    const lines = tail.map((fn) => {
      const tag = fn.pageLabel && fn.pageLabel !== endPage ? ` (s. ${fn.pageLabel})` : "";
      const body = fn.defStart >= src.start && fn.defEnd <= src.end
        ? renderDefinitionText(src.slice(fn.defStart, fn.defEnd))
        : `(text poznámky není v načteném úseku — footnote: "${fn.label}")`;
      return `${noteMarker(fn)}${tag}${body ? ` ${body}` : ""}`;
    });
    result += `\n\n${TAIL_HEADING}\n${lines.join("\n")}`;
  }
  return result;
}

/** A definition's text (without its `[^L]: ` prefix) rendered on its own. */
function renderDefinitionText(def: string): string {
  const cursor = new InlineCursor(def);
  const lines: string[] = [];
  let s = 0;
  while (s <= def.length) {
    let e = def.indexOf("\n", s);
    if (e === -1) e = def.length;
    const line = { ...classifyLine(def, s, s), kind: "text" as const, end: e };
    let out = "";
    let c = s;
    for (const m of cursor.take(s, e)) {
      const tok = readInline(def, m, line, true);
      if (tok.kind === "escape") {
        out += clean(def.slice(c, tok.at));
        c = tok.at + 1;
      } else if (tok.kind === "ref" || tok.kind === "page") {
        out += `${clean(def.slice(c, tok.at))}${tok.kind === "ref" ? `⟦${tok.label}⟧` : `⟦s. ${tok.label}⟧`}`;
        c = tok.end;
      }
    }
    lines.push((out + clean(def.slice(c, e))).trim());
    s = e + 1;
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Fence document-derived text for tool output; the nonce is random per response. */
export function fence(nonce: string, body: string): string {
  return `⟦DOC ${nonce}⟧\n${body}\n⟦/DOC ${nonce}⟧`;
}

/** 8 hex chars from crypto.getRandomValues (browser and Node ≥ 19). */
export function newNonce(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
