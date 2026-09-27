/**
 * Highlighting and excerpt windows for Vlastní zdroje hits. A hit comes
 * from stems (the lex channels) or normalized identifiers (idn), so the
 * excerpt must be found the same way — a substring search would miss
 * "náhrada škody" for the query "náhradu škody", and "25 Cdo 1234/19" for
 * the key sz:25cdo1234-2019. Matching here reuses the analyzer and the
 * identifier regexes, never a separate notion of "match".
 *
 * Callers pass markup-stripped text (stripMarkup) or raw chunk text, and get
 * offsets relative to that text.
 *
 * Pure — unit-tested (tests/files-highlight.test.ts).
 */

import { findIdentSpans } from "@/src/files/index/identifiers";
import { indexTerm, isExactTerm, tokenize } from "@/src/files/text/analyze";

export interface Span {
  start: number;
  end: number;
}

/** Default excerpt length (chars). */
export const DEFAULT_WINDOW_CHARS = 600;
/** How far back a window may reach to start at the paragraph start. */
const PARAGRAPH_REACH = 300;

/**
 * Spans of `text` that the query matched: word tokens whose index term
 * starts with a query term (equals it, for exact terms — digits, ≤ 2
 * chars), and identifiers whose key is in `identKeys` (a "sec:"-prefixed
 * key matches the bare § key too). Sorted, overlaps merged. Pure.
 */
export function findMatches(text: string, q: { terms: string[]; identKeys: string[] }): Span[] {
  const found: Span[] = [];
  const exact = new Set(q.terms.filter(isExactTerm));
  const prefixes = q.terms.filter((t) => t && !isExactTerm(t));
  if (exact.size || prefixes.length) {
    const memo = new Map<string, boolean>();
    for (const token of tokenize(text)) {
      let hit = memo.get(token.lower);
      if (hit === undefined) {
        const term = indexTerm(token.lower);
        hit = exact.has(term) || prefixes.some((p) => term.startsWith(p));
        memo.set(token.lower, hit);
      }
      if (hit) found.push({ start: token.start, end: token.end });
    }
  }
  if (q.identKeys.length) {
    const keys = new Set(q.identKeys);
    for (const span of findIdentSpans(text)) {
      if (span.keys.some((k) => keys.has(k) || keys.has(`sec:${k}`))) found.push({ start: span.start, end: span.end });
    }
  }
  return mergeSpans(found);
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const isWord = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c);
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * The best ≤ maxChars window: around the cluster with the most matches
 * (earliest on a tie), starting at its paragraph start when that is within
 * 300 chars of the first match, else with about a third of the spare room
 * before the cluster; both ends snapped to word boundaries. `excerpt` is the
 * window text with "…" where it cuts running text (not at a paragraph
 * break or the text's ends). `matchAt` = first match of the cluster — the
 * offset a pinpoint (page, m. č., footnote) is derived from. Pure.
 */
export function bestWindow(
  text: string,
  matches: Span[],
  maxChars = DEFAULT_WINDOW_CHARS,
): { start: number; end: number; matchAt: number; excerpt: string } | null {
  const ms = matches.filter((m) => m.start >= 0 && m.end <= text.length && m.end > m.start).sort((a, b) => a.start - b.start);
  if (!ms.length || maxChars <= 0) return null;

  // Densest cluster: most matches whose span fits in maxChars.
  let bestI = 0;
  let bestJ = 0;
  for (let i = 0, j = 0; i < ms.length; i++) {
    if (j < i) j = i;
    while (j + 1 < ms.length && ms[j + 1].end - ms[i].start <= maxChars) j++;
    if (j - i > bestJ - bestI) [bestI, bestJ] = [i, j];
  }
  const first = ms[bestI];
  const clusterEnd = Math.max(first.end, ms[bestJ].end);

  const paragraphStart = text.lastIndexOf("\n", first.start - 1) + 1;
  let start: number;
  let end: number;
  if (first.start - paragraphStart <= PARAGRAPH_REACH && first.end - paragraphStart <= maxChars) {
    start = paragraphStart;
    end = Math.min(text.length, start + maxChars);
  } else {
    const spare = Math.max(0, maxChars - (clusterEnd - first.start));
    start = Math.max(0, first.start - Math.floor(spare / 3));
    end = Math.min(text.length, start + maxChars);
    // Near the end of the text: use the room before the cluster instead.
    start = Math.max(0, Math.min(start, end - maxChars));
  }

  // Snap inward to word boundaries, never past the first match.
  if (start > 0 && isWord(text[start - 1]) && isWord(text[start])) {
    while (start < first.start && isWord(text[start])) start++;
  }
  while (start < first.start && /\s/.test(text[start])) start++;
  if (end < text.length && isWord(text[end - 1]) && isWord(text[end])) {
    let e = end;
    while (e > first.end && isWord(text[e - 1])) e--;
    if (e > first.end || !isWord(text[e - 1])) end = e;
  }
  if (end < text.length && end > start && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  while (end > first.end && /\s/.test(text[end - 1])) end--;

  // Running text is cut when non-blank text of the same line lies outside.
  const cutBefore = text.slice(text.lastIndexOf("\n", start - 1) + 1, start).trim() !== "";
  const lineEnd = text.indexOf("\n", end);
  const cutAfter = text.slice(end, lineEnd === -1 ? text.length : lineEnd).trim() !== "";
  const excerpt = `${cutBefore ? "…" : ""}${text.slice(start, end)}${cutAfter ? "…" : ""}`;
  return { start, end, matchAt: first.start, excerpt };
}
