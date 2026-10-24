/**
 * Derived layer of the mirror: a decision's text → chunks with a tsvector
 * literal and identifier keys. Everything here is re-computable from the
 * stored text and the base fields alone (`mirror reindex`), never from the
 * source.
 *
 * Chunks are contiguous spans of the text, the same sizes as Vlastní zdroje
 * (src/files/index/derive.ts): target 1,400 characters, min 400, max 2,400.
 * A cut prefers a paragraph end, then a sentence end, then a space, each
 * closest to the target; a text up to the max is one chunk. Offsets are
 * JavaScript string indices into decision_text.body (UTF-16 code units —
 * the API slices with them in JavaScript too).
 *
 * tsvector weights (ts_rank_cd '{D,C,B,A}'):
 *   A  the case number(s) of the decision — first chunk only
 *   B  its právní věta — first chunk only
 *   C  the chunk's text
 * Identifier keys: those cited in the chunk (extractIdentKeys); the first
 * chunk also carries the decision's own case numbers and ECLI, so a lookup
 * by sp. zn. finds the decision itself as well as decisions citing it.
 *
 * Pure — unit-tested (tests/mirror-index.test.ts).
 */

import { extractIdentKeys, MAX_IDENT_KEYS } from "@/src/files/index/identifiers";
import { buildTsvector, type Weight } from "@/src/files/index/tsv";
import type { DecisionRecord } from "./types";

export const CHUNK_TARGET = 1_400;
export const CHUNK_MIN = 400;
export const CHUNK_MAX = 2_400;

export interface TextSpan {
  start: number;
  end: number;
}

export interface DerivedChunk extends TextSpan {
  ord: number;
  tsv: string;
  identKeys: string[];
}

const SENTENCE_END = /[.!?;:][)"“”]?\s/g;

function closest(candidates: number[], target: number): number | undefined {
  let best: number | undefined;
  for (const c of candidates) if (best === undefined || Math.abs(c - target) < Math.abs(best - target)) best = c;
  return best;
}

/** Where the chunk starting at `start` ends (exclusive). */
function findCut(text: string, start: number): number {
  const lo = start + CHUNK_MIN;
  const hi = start + CHUNK_MAX;
  const target = start + CHUNK_TARGET;
  const window = text.slice(lo, hi);
  const at = (re: RegExp, offset: number) => [...window.matchAll(re)].map((m) => lo + m.index + offset);
  return (
    closest(at(/\n/g, 0), target) ??
    closest(
      [...window.matchAll(SENTENCE_END)].map((m) => lo + m.index + m[0].length - 1),
      target,
    ) ??
    closest(at(/\s/g, 0), target) ??
    hi
  );
}

/** Split `text` into chunk spans; whitespace between chunks belongs to none. Pure. */
export function chunkText(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const skip = (i: number) => {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  };
  const trimEnd = (from: number, to: number) => {
    while (to > from && /\s/.test(text[to - 1])) to--;
    return to;
  };
  let start = skip(0);
  while (start < text.length) {
    const end = text.length - start <= CHUNK_MAX ? text.length : findCut(text, start);
    const trimmed = trimEnd(start, end);
    if (trimmed > start) spans.push({ start, end: trimmed });
    start = skip(end);
  }
  return spans;
}

/** Chunks of a record with text; [] when it has none. Pure. */
export function deriveChunks(record: Pick<DecisionRecord, "text" | "caseNumbers" | "legalSentence" | "ecli">): DerivedChunk[] {
  const body = record.text?.body;
  if (!body) return [];
  return chunkText(body).map((span, ord) => {
    const chunk = body.slice(span.start, span.end);
    const parts: Array<{ text: string; weight: Weight }> = [];
    const own: string[] = [];
    if (ord === 0) {
      if (record.caseNumbers.length) parts.push({ text: record.caseNumbers.join("\n"), weight: "A" });
      if (record.legalSentence) parts.push({ text: record.legalSentence, weight: "B" });
      own.push(...extractIdentKeys([...record.caseNumbers, record.ecli ?? ""].join("\n")));
    }
    parts.push({ text: chunk, weight: "C" });
    const identKeys = [...new Set([...own, ...extractIdentKeys(chunk)])].slice(0, MAX_IDENT_KEYS);
    return { ord, ...span, tsv: buildTsvector(parts), identKeys };
  });
}
