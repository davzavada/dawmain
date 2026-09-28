/**
 * DMD writer of the PDF layout engine: lines in reading order → the DMD
 * text (grammar in src/files/dmd/types.ts).
 * - Paragraphs: a new one starts on a vertical gap > 1.35 × line spacing,
 *   a first-line indent > 0.8 em, a short line ending a sentence, a change
 *   of size or of quote state, a bullet, a marginal number. Across a page
 *   or column break a paragraph runs on when its last line did not end a
 *   sentence (or the next starts in lowercase) and the next is not
 *   indented; a page break inside it becomes an inline " [s. N] " after
 *   the word joined across the break.
 * - Words split at a line end are joined (text.ts joinLines).
 * - Footnote definitions follow the paragraph (or heading) citing them;
 *   page-end material — dangling definitions, footnote zones kept as text —
 *   waits until the paragraph running over the page break has ended.
 * - Marginal numbers: "[m. č. N] " when the numbers increase within a §
 *   (inline bold numbers only when consecutive); otherwise the number
 *   stays text.
 * - Everything that is not markup is escaped. Lines stay ≤ 10k chars.
 * Pure — unit-tested through layoutToDmd.
 */

import type { Line, Note, PageModel, Part } from "./model";
import { endsTerminal, escapeDmdText, escapeLineStart, joinLines, startsLower, toSuperscript, type HyphenDict } from "./text";

export interface EmitContext {
  bodySize: number;
  lineGap: number;
  /** Most lines reach the right edge — a short line then ends a paragraph. */
  justified: boolean;
  dict: HyphenDict;
  marginalNumbers: boolean;
}

export interface EmitResult {
  dmd: string;
  /** Marginal numbers emitted as markup. */
  mn: number;
  /** Marginal numbers left as text because the sequence broke. */
  mnRejected: number;
  /** Footnote definitions longer than the DMD cap, split into a definition and a paragraph. */
  longNotes: number;
}

type Atom = Part | { t: "page"; label: string };

interface Para {
  atoms: Atom[];
  last: Line;
  quote: boolean;
  prefix: string;
}

/** Longest emitted line; the parser's hard cap is 30k. */
const MAX_LINE = 10_000;
/** A definition longer than this is split (the parser rejects > 10k). */
const MAX_NOTE = 9_000;

export function emitDmd(pages: PageModel[], ctx: EmitContext): EmitResult {
  const out: string[] = [];
  const held: string[] = [];
  let para: Para | null = null;
  let marker: string | null = null;
  let first = true;
  let mnLast: number | null = null;
  let mn = 0;
  let mnRejected = 0;
  let longNotes = 0;

  const closePara = () => {
    if (para) {
      const { text, notes } = serialize(para.atoms);
      if (text.trim()) {
        const body = para.quote ? `> ${text}` : para.prefix ? `${para.prefix}${text}` : escapeLineStart(text);
        out.push(wrap(body));
      }
      pushDefs(notes, out);
      para = null;
    }
    out.push(...held.splice(0));
  };
  const flushMarker = () => {
    if (marker !== null) out.push(`[s. ${marker}]`);
    marker = null;
  };
  const pushDefs = (notes: Note[], into: string[]) => {
    if (!notes.length) return;
    const defs: string[] = [];
    const extra: string[] = [];
    for (const note of notes) {
      let text = noteText(note, ctx.dict);
      if (text.length > MAX_NOTE) {
        longNotes++;
        const cut = text.lastIndexOf(" ", MAX_NOTE);
        const at = cut > MAX_NOTE / 2 ? cut : MAX_NOTE;
        extra.push(wrap(escapeLineStart(text.slice(at).trim())));
        text = text.slice(0, at);
      }
      defs.push(`[^${note.label}]: ${escapeDmdText(text)}`.trimEnd());
    }
    into.push(defs.join("\n"), ...extra);
  };

  for (const page of pages) {
    if (!page.kept) continue;
    if (first) {
      out.push(`[s. ${page.label}]`);
      first = false;
    } else marker = page.label;

    const lines = page.segments.flatMap((s) => s.lines);
    const running = para as Para | null;
    if (page.noteOnly && !lines.length && running && marker !== null && !endsTerminal(running.last.plain)) {
      // The page held only the continuation of a note and the paragraph is
      // visibly unfinished: it runs on past the page, whose marker goes inline.
      running.atoms.push({ t: "page", label: marker });
      marker = null;
    }
    for (const line of lines) {
      if (line.headingCont) continue;
      if (line.heading) {
        closePara();
        flushMarker();
        const h = line.heading;
        const { text, notes } = serialize(h.parts.map(cloneAtom));
        const content = text.replace(/\s+/g, " ").trim();
        if (content.length && content.length <= 300) out.push(`${"#".repeat(h.level)} ${content}`);
        else if (content.length) out.push(wrap(escapeLineStart(content)));
        pushDefs(notes, out);
        if (h.kind === "par" || h.kind === "cl" || h.kind === "part" || h.kind === "chapter" || h.level === 1 || /^§/.test(h.text)) mnLast = null;
        continue;
      }
      const cur = para as Para | null;
      if (cur && continues(cur.last, line, ctx)) {
        append(cur, line, marker, ctx.dict);
        marker = null;
        cur.last = line;
        continue;
      }
      closePara();
      flushMarker();
      const atoms = line.parts.map(cloneAtom);
      let prefix = "";
      const mnValue = ctx.marginalNumbers ? line.mn : null;
      if (mnValue !== null) {
        const v = parseInt(mnValue, 10);
        if (mnLast === null || v > mnLast) {
          prefix = `[m. č. ${mnValue}] `;
          mnLast = v;
          mn++;
        } else {
          mnRejected++;
          atoms.unshift({ t: "text", s: `${mnValue} ` });
        }
      } else if (line.mn !== null) atoms.unshift({ t: "text", s: `${line.mn} ` });
      else if (ctx.marginalNumbers && line.boldLead !== null) {
        const v = Number(line.boldLead);
        if ((mnLast === null && v === 1) || (mnLast !== null && v === mnLast + 1)) {
          const head = atoms[0];
          if (head?.t === "text") {
            head.s = head.s.replace(/^\s*\d{1,3}\s*/, "");
            prefix = `[m. č. ${line.boldLead}] `;
            mnLast = v;
            mn++;
          }
        }
      }
      para = { atoms, last: line, quote: line.quote, prefix };
    }

    if (marker !== null) {
      closePara();
      flushMarker();
    }
    const material: string[] = [];
    for (const block of textBlocks(page.endText, ctx)) material.push(block);
    pushDefs(page.notes.filter((n) => !n.bound), material);
    if (para) held.push(...material);
    else out.push(...material);
  }
  closePara();
  return { dmd: `${out.join("\n\n")}\n`, mn, mnRejected, longNotes };
}

/** Footnote-zone lines kept as text → paragraph blocks. */
function textBlocks(lines: Line[], ctx: EmitContext): string[] {
  const blocks: string[] = [];
  let cur: Para | null = null;
  const flush = () => {
    if (!cur) return;
    const { text } = serialize(cur.atoms, true);
    if (text.trim()) blocks.push(wrap(escapeLineStart(text)));
    cur = null;
  };
  for (const line of lines) {
    const open = cur as Para | null;
    if (open && open.last.seg === line.seg && continues(open.last, line, ctx)) {
      append(open, line, null, ctx.dict);
      open.last = line;
    } else {
      flush();
      cur = { atoms: line.parts.map(cloneAtom), last: line, quote: false, prefix: "" };
    }
  }
  flush();
  return blocks;
}

function cloneAtom(p: Part): Atom {
  return p.t === "text" ? { t: "text", s: p.s } : p.t === "sup" ? { t: "sup", s: p.s } : p;
}

// ─────────────────────────────────────────────────────────────── paragraph logic

/** Does `line` continue the paragraph whose last line is `prev`? */
export function continues(prev: Line, line: Line, ctx: Pick<EmitContext, "bodySize" | "lineGap" | "justified">): boolean {
  if (line.mn !== null || line.quote !== prev.quote) return false;
  if (Math.abs(line.size - prev.size) > 0.6) return false;
  if (/^[•▪◦●■–—]\s/.test(line.plain)) return false;
  const em = line.size;
  const colWidth = line.colRight - line.colLeft;
  const indented = line.x0 - line.colLeft > 0.8 * em;
  const short = ctx.justified ? prev.x1 < prev.colRight - 2 * prev.size : prev.x1 < prev.colLeft + 0.6 * (prev.colRight - prev.colLeft);
  const terminal = endsTerminal(prev.plain);
  if (line.boldLead !== null && terminal) return false;

  if (prev.page !== line.page || prev.seg !== line.seg) {
    if (indented && line.x0 - line.colLeft < 0.5 * colWidth) return false;
    if (terminal && !startsLower(line.plain)) return false;
    return !(short && terminal);
  }
  const expected = ctx.lineGap * (Math.max(line.size, prev.size) / ctx.bodySize);
  if (line.y - prev.y > 1.35 * expected || line.y <= prev.y) return false;
  if (indented && line.x0 - prev.x0 > 0.8 * em) return false;
  if (short && terminal) return false;
  return true;
}

/** Append a line's parts to the paragraph, joining a split word and placing a page marker. */
function append(para: Para, line: Line, marker: string | null, dict: HyphenDict): void {
  const atoms = line.parts.map(cloneAtom);
  const last = para.atoms[para.atoms.length - 1];
  const head = atoms[0];
  if (last?.t === "text" && head?.t === "text") {
    const j = joinLines(last.s, head.s, dict);
    last.s = j.left;
    if (marker !== null && j.glue === "") {
      // "povin-" | "nosti škody" → "povinnosti [s. 246] škody" (+ a reference glued to the word stays with it)
      const word = /^\S*/.exec(j.right)![0];
      last.s += word;
      const rest = j.right.slice(word.length).replace(/^\s+/, "");
      const tail = atoms.slice(1);
      const refs: Atom[] = [];
      if (!rest) while (tail.length && (tail[0].t === "ref" || tail[0].t === "sup")) refs.push(tail.shift()!);
      para.atoms.push(...refs, { t: "page", label: marker });
      if (rest) para.atoms.push({ t: "text", s: rest });
      para.atoms.push(...tail);
      return;
    }
    if (marker !== null) para.atoms.push({ t: "page", label: marker });
    head.s = marker !== null ? j.right : j.glue + j.right;
    para.atoms.push(...atoms);
    return;
  }
  if (marker !== null) para.atoms.push({ t: "page", label: marker });
  else if (head?.t === "text" && last && !/^\s/.test(head.s)) head.s = ` ${head.s}`;
  para.atoms.push(...atoms);
}

/**
 * Atoms → one DMD line: text escaped, bound references as `[^n]`,
 * unbound ones and other superscripts as Unicode superscript text, page
 * markers with a space on each side. Returns the notes to define, ordered
 * so the parser (which binds a definition to the NEAREST earlier unbound
 * reference with its label) binds each one to its own reference.
 */
function serialize(atoms: Atom[], plain = false): { text: string; notes: Note[] } {
  // Pieces in an array: a paragraph can be book-long, and inspecting a
  // growing concatenated string (endsWith, replace) would flatten it each time.
  const pieces: string[] = [];
  let buf = "";
  const refs: Note[] = [];
  const flush = () => {
    if (buf) pieces.push(escapeDmdText(buf));
    buf = "";
  };
  for (const a of atoms) {
    if (a.t === "text") buf += a.s;
    else if (a.t === "sup") buf += toSuperscript(a.s);
    else if (a.t === "ref") {
      if (a.note && a.note.bound && !plain) {
        flush();
        // A text backslash right before the reference would escape it.
        if (pieces.length && pieces[pieces.length - 1].endsWith("\\")) pieces.push(" ");
        pieces.push(`[^${a.label}]`);
        refs.push(a.note);
      } else buf += toSuperscript(a.raw);
    } else {
      buf = buf.replace(/\s+$/, "");
      flush();
      pieces.push(` [s. ${a.label}] `);
    }
  }
  flush();
  const s = pieces.join("");
  let text = s.replace(/ {2,}/g, " ").trim();
  // A line opening with a reference followed by ":" would read as a definition.
  if (/^\[\^[^\]]+\]:/.test(text)) text = text.replace(/^(\[\^[^\]]+\])/, "$1 ");

  const notes: Note[] = [];
  const seen = new Set<string>();
  for (const note of refs) {
    if (seen.has(note.label)) continue;
    seen.add(note.label);
    const same = refs.filter((n) => n.label === note.label);
    notes.push(...same.reverse());
  }
  return { text, notes };
}

/** Plain text of a note (its lines joined, superscripts as Unicode superscripts). */
export function noteText(note: Note, dict: HyphenDict): string {
  let text = "";
  for (const line of note.lines) {
    const s = line.parts
      .map((p) => (p.t === "text" ? p.s : p.t === "sup" ? toSuperscript(p.s) : toSuperscript(p.raw)))
      .join("")
      .trim();
    if (!s) continue;
    if (!text) text = s;
    else {
      const j = joinLines(text, s, dict);
      text = j.left + j.glue + j.right;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Keep lines under MAX_LINE: cut at a space followed by a letter or a digit
 * (never before markup), so the continuation line is plain paragraph text.
 */
function wrap(line: string): string {
  if (line.length <= MAX_LINE) return line;
  const lines: string[] = [];
  let rest = line;
  while (rest.length > MAX_LINE) {
    let cut = -1;
    for (let i = MAX_LINE; i > MAX_LINE / 2; i--) {
      // Never inside "[s. 12]" / "[m. č. 3]" (their inner space is followed by a digit too).
      if (rest[i] === " " && /[\p{L}\p{N}(„"]/u.test(rest[i + 1] ?? "") && !/\[(?:s\.|m\.|m\. č\.)$/.test(rest.slice(Math.max(0, i - 6), i))) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      cut = MAX_LINE;
      if (/[\uDC00-\uDFFF]/.test(rest[cut])) cut--;
    }
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^ +/, "");
    if (/^(?:[#>|]|\[s\. |\[\^|\[m\. č\. )/.test(rest)) rest = `\\${rest}`;
  }
  lines.push(rest);
  return lines.join("\n");
}
