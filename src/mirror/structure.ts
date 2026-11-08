import { justiceSectionTexts } from "@/src/sources/justice";
import { findDissents } from "./index";

/**
 * The parts of a decision's text: záhlaví, výrok, odůvodnění, poučení,
 * odlišná stanoviska — and within the odůvodnění its numbered body
 * paragraphs ("12.", "[12]") and headings ("II. Posouzení věci"), each as
 * [start, end) offsets into the stored text. Lets search look in výroky
 * only, a citation point to "bod 23", and a reader jump by headings.
 *
 * justice gives its parts as JSON sections (justiceParts, exact); NS, NSS
 * and ÚS by the lines that open them, read with their letter spacing folded
 * ("O d ů v o d n ě n í", "t a k t o :"). A part that is not found is left
 * out rather than guessed: the Sbírka versions ("Z odůvodnění:") have no
 * výrok, old NSS letters no structure at all. Pure — unit-tested.
 */

export type SectionKind = "zahlavi" | "vyrok" | "oduvodneni" | "pouceni" | "stanovisko";

export interface Span {
  start: number;
  end: number;
}
export interface Section extends Span {
  kind: SectionKind;
}
export interface Paragraph extends Span {
  /** "12" for "12." or "[12]". */
  num: string;
}
export interface Heading extends Span {
  text: string;
}
export interface Structure {
  sections: Section[];
  paragraphs: Paragraph[];
  headings: Heading[];
}

interface Line {
  start: number;
  end: number;
  text: string;
  /** Without whitespace, lower case: "O d ů v o d n ě n í :" → "odůvodnění:". */
  folded: string;
}

function lines(body: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const part of body.split("\n")) {
    out.push({ start, end: start + part.length, text: part, folded: part.replace(/\s+/g, "").toLowerCase() });
    start += part.length + 1;
  }
  return out;
}

/** The výrok follows the line ending in "takto:" (the opening sentence of the decision). */
const TAKTO = /takto:$/;
/** "Odůvodnění:", "O d ů v o d n ě n í (§ 243f odst. 3 o. s. ř.) :", "Stručné odůvodnění (§ 169 odst. 2 o. s. ř.):", "Z odůvodnění:". */
const ODUVODNENI = /^(?:stručné|zkrácené)?(?:z)?odůvodnění(?:\([^)]{0,60}\))?[:.]?$|^důvody:?$/;
/** A výrok's own point: "I.", "II.", "1." at the start of its paragraph. */
const VYROK_POINT = /^\s*(?:[IVX]{1,5}\.|\d{1,2}\.|[a-z]\))\s/;
const POUCENI = /^poučení:/;
/** Not further than this into the text: past it a "takto:" is a quotation. */
const TAKTO_WITHIN = 0.6;

const NUMBERED = /^\s*(?:(\d{1,3})\.|\[(\d{1,3})\])\s+\S/;
const HEADING = /^\s*(?:[IVX]{1,5}\.(?:[a-z]\)|\d{1,2}\.?)?|[A-Z]\)|[a-z]\)|[IVX]{1,5}\.[A-Z]\.)\s*[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\n]{1,140}$/;
const MAX_HEADING = 150;

/** Numbered body paragraphs: a line opening the next number in sequence starts one; other numbers are lists inside it. */
function numberedParagraphs(body: string, all: Line[], from: number, to: number): Paragraph[] {
  const starts: Array<{ num: number; at: number }> = [];
  let expected = 1;
  for (const line of all) {
    if (line.start < from || line.start >= to) continue;
    const m = NUMBERED.exec(line.text);
    const num = m ? Number(m[1] ?? m[2]) : null;
    if (num === expected) {
      starts.push({ num, at: line.start + line.text.search(/\S/) });
      expected++;
    }
  }
  if (starts.length < 2) return [];
  return starts.map((s, i) => ({ num: String(s.num), start: s.at, end: trimEndOf(body, starts[i + 1]?.at ?? to) }));
}

function headings(all: Line[], from: number, to: number): Heading[] {
  const out: Heading[] = [];
  for (const line of all) {
    if (line.start < from || line.end > to) continue;
    const text = line.text.trim();
    if (!text || text.length > MAX_HEADING || NUMBERED.test(line.text)) continue;
    // A heading is a title, not a sentence: no full stop at its end, few commas.
    if (/[.;,:]$/.test(text) && !/^[IVX]{1,5}\.$/.test(text)) continue;
    if ((text.match(/,/g) ?? []).length > 2) continue;
    if (!HEADING.test(text) && !/^[IVX]{1,5}\.$/.test(text)) continue;
    const start = line.start + line.text.indexOf(text);
    out.push({ text, start, end: start + text.length });
  }
  // "II." alone on its line names the next line's title.
  return out.map((h) => {
    if (!/^[IVX]{1,5}\.$/.test(h.text)) return h;
    const next = all.find((l) => l.start > h.start && l.text.trim());
    if (!next || next.end > to || next.text.trim().length > MAX_HEADING || /[.;,]$/.test(next.text.trim())) return h;
    return { text: `${h.text} ${next.text.trim()}`, start: h.start, end: next.start + next.text.indexOf(next.text.trim()) + next.text.trim().length };
  });
}

/** Sections by their opening lines (NS, NSS, ÚS), the dissents by findDissents. */
export function deriveStructure(body: string, given?: Section[]): Structure {
  const all = lines(body);
  const trimEnd = (at: number) => trimEndOf(body, at);
  const dissents = findDissents(body);
  const mainEnd = trimEnd(dissents[0]?.start ?? body.length);
  let sections: Section[];
  if (given) sections = given.filter((s) => s.end <= mainEnd || s.kind === "stanovisko");
  else {
    const within = (l: Line) => l.start < mainEnd;
    const takto = all.find((l) => within(l) && l.start < body.length * TAKTO_WITHIN && TAKTO.test(l.folded));
    const oduv = all.find((l) => within(l) && (!takto || l.start > takto.start) && ODUVODNENI.test(l.folded));
    const pouc = all.find((l) => within(l) && (oduv ? l.start > oduv.start : takto ? l.start > takto.start : true) && POUCENI.test(l.folded));
    const vyrokStart = takto ? takto.end + 1 : null;
    // Or at the end of the výrok's own line: "Návrh se o d m í t á. Odůvodnění:".
    const inline = oduv
      ? null
      : all.find((l) => within(l) && takto && l.start > takto.start && l.text.length < 300 && /odůvodnění:$/.test(l.folded) && !ODUVODNENI.test(l.folded));
    const inlineAt = inline ? inline.start + inline.text.search(/O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í\s*:\s*$/i) : -1;
    const oduvStart = oduv ? oduv.start : inline && inlineAt >= inline.start ? inlineAt : null;
    const poucStart = pouc ? pouc.start : null;
    const cut = (from: number, ...ends: Array<number | null>) => trimEnd(Math.min(mainEnd, ...ends.filter((e): e is number => e !== null && e > from)));
    sections = [];
    const firstPart = [vyrokStart !== null ? takto!.start : null, oduvStart, poucStart].filter((x): x is number => x !== null);
    if (firstPart.length) sections.push({ kind: "zahlavi", start: 0, end: vyrokStart ?? trimEnd(Math.min(...firstPart)) });
    if (vyrokStart !== null) {
      // Without the odůvodnění's heading the reasons follow the výrok unannounced: the výrok is its first
      // paragraph, and the next ones only while they open with its points (I., II.).
      const unannounced = oduvStart === null ? vyrokBlocksEnd(body, skipBlank(body, vyrokStart)) : null;
      sections.push({ kind: "vyrok", start: skipBlank(body, vyrokStart), end: cut(vyrokStart, oduvStart, poucStart, unannounced) });
    }
    if (oduvStart !== null) sections.push({ kind: "oduvodneni", start: oduvStart, end: cut(oduvStart, poucStart) });
    if (poucStart !== null) sections.push({ kind: "pouceni", start: poucStart, end: mainEnd });
    sections = sections.filter((s) => s.end > s.start);
  }
  for (const d of dissents) sections.push({ kind: "stanovisko", start: d.start, end: trimEnd(d.end) });
  const reasons = sections.find((s) => s.kind === "oduvodneni");
  // Without an odůvodnění found, the numbering and headings are looked for in the whole main text.
  const area = reasons ?? { start: sections.find((s) => s.kind === "vyrok")?.end ?? 0, end: mainEnd };
  return {
    sections: sections.sort((a, b) => a.start - b.start),
    paragraphs: numberedParagraphs(body, all, area.start, area.end),
    headings: headings(all, area.start, area.end),
  };
}

/** End of the výrok's paragraphs from `start`: the first, then those opening with a point (blank lines between). */
function vyrokBlocksEnd(body: string, start: number): number {
  const blocks = [...body.slice(start).matchAll(/[^\n](?:[^\n]|\n(?!\s*\n))*/g)];
  let end = start + (blocks[0] ? blocks[0].index + blocks[0][0].length : 0);
  // Only points of the kind the výrok opened with: after "I. …" a "1. …" is the reasons' first paragraph,
  // and "I." alone on its line is a heading over them.
  const kind = (text: string) => (/^\s*[IVX]{1,5}\.\s+\S/.test(text) ? "roman" : /^\s*\d{1,2}\.\s+\S/.test(text) ? "arabic" : /^\s*[a-z]\)\s/.test(text) ? "letter" : null);
  const opened = blocks[0] ? kind(blocks[0][0]) : null;
  for (const block of blocks.slice(1)) {
    if (opened === null || kind(block[0]) !== opened || !VYROK_POINT.test(block[0])) break;
    end = start + block.index + block[0].length;
  }
  return end;
}

function skipBlank(body: string, at: number): number {
  while (at < body.length && /\s/.test(body[at])) at++;
  return at;
}

/**
 * justice: the sections as parseJusticeDecision joins them (header, verdict, justification,
 * information, "\n\n" between the non-empty ones) — exact offsets, or null when the stored text is
 * not that join (an older parser), and the caller reads the lines instead.
 */
export function justiceParts(body: string, parts: { header: string; verdict: string; justification: string; information: string }): Section[] | null {
  const order: Array<[SectionKind, string]> = [
    ["zahlavi", parts.header],
    ["vyrok", parts.verdict],
    ["oduvodneni", parts.justification],
    ["pouceni", parts.information],
  ];
  const present = order.filter(([, text]) => text.trim());
  const joined = present.map(([, text]) => text).join("\n\n");
  const lead = joined.length - joined.trimStart().length;
  if (joined.trim() !== body) return null;
  const out: Section[] = [];
  let at = -lead;
  for (const [kind, text] of present) {
    const start = Math.max(0, at);
    const end = Math.min(body.length, at + text.length);
    if (end > start) out.push({ kind, start: start + (text.slice(start - at).length - text.slice(start - at).trimStart().length), end: trimEndOf(body, end) });
    at += text.length + 2;
  }
  return out;
}

function trimEndOf(body: string, end: number): number {
  while (end > 0 && /\s/.test(body[end - 1])) end--;
  return end;
}

/** The structure of a stored or fetched decision: justice from its finaldoc JSON where the text is its join, else by the lines. */
export function structureOf(source: string, body: string, raw?: Uint8Array | null): Structure {
  if (source === "justice" && raw?.length) {
    try {
      const parts = justiceParts(body, justiceSectionTexts(JSON.parse(Buffer.from(raw).toString("utf8"))));
      if (parts) return deriveStructure(body, parts);
    } catch {
      // Not the finaldoc JSON: read the lines.
    }
  }
  return deriveStructure(body);
}

/** The výrok's text, for the search in výroky only; null without one. */
export function verdictText(body: string, structure: Structure): string | null {
  const verdict = structure.sections.find((s) => s.kind === "vyrok");
  const text = verdict ? body.slice(verdict.start, verdict.end).trim() : "";
  return text || null;
}
