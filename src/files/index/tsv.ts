/**
 * tsvector LITERALS built in the app. Stemming happens here (analyze.ts), so
 * Postgres receives finished lexemes as `$n::tsvector` — the text is never
 * parsed by a Postgres text-search configuration, and the lexemes are exactly
 * what buildTsQuery's prefixes are made to meet.
 *
 * Layout: `'lexeme':1A,7 'other':2B` — positions 1.. in token order across
 * all parts, weight letter after each position, weight D written without a
 * letter (it is the default). Postgres limits that shape the output:
 * positions ≤ 16383 (later tokens keep 16383), ≤ 256 positions per lexeme
 * (more are dropped), lexemes < 2 KB (longer ones are dropped — no real word
 * gets near that).
 *
 * Pure — unit-tested (tests/files-analyze.test.ts, incl. real Postgres).
 */

import type { Weight } from "@/src/files/index/types";
import { indexTerm, tokenize } from "@/src/files/text/analyze";

export type { Weight };

/** Highest position Postgres stores (MAXENTRYPOS − 1). */
export const MAX_POSITION = 16_383;
/** Positions kept per lexeme (Postgres MAXNUMPOS). */
export const MAX_POSITIONS_PER_LEXEME = 256;
/** Longest lexeme in bytes (Postgres MAXSTRLEN is 2047). */
export const MAX_LEXEME_BYTES = 2_046;

const RANK: Record<Weight, number> = { A: 3, B: 2, C: 1, D: 0 };
const encoder = new TextEncoder();

/** Quote a lexeme for a tsvector literal: '' for a quote, \\ for a backslash. */
export function quoteLexeme(lexeme: string): string {
  return `'${lexeme.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * tsvector literal from weighted texts: terms via indexTerm(tokenize(text)),
 * positions 1.. in order across the parts. Empty input → "" (a valid empty
 * tsvector). Pure.
 */
export function buildTsvector(parts: Array<{ text: string; weight: Weight }>): string {
  // lexeme → position → highest weight seen there (positions repeat at the cap).
  const entries = new Map<string, Map<number, Weight>>();
  let position = 0;
  for (const part of parts) {
    for (const token of tokenize(part.text)) {
      position = Math.min(position + 1, MAX_POSITION);
      const term = indexTerm(token.lower);
      if (!term || encoder.encode(term).length > MAX_LEXEME_BYTES) continue;
      let positions = entries.get(term);
      if (!positions) entries.set(term, (positions = new Map()));
      const had = positions.get(position);
      if (had === undefined) {
        if (positions.size < MAX_POSITIONS_PER_LEXEME) positions.set(position, part.weight);
      } else if (RANK[part.weight] > RANK[had]) {
        positions.set(position, part.weight);
      }
    }
  }
  const out: string[] = [];
  for (const [lexeme, positions] of entries) {
    const list = [...positions].map(([pos, weight]) => (weight === "D" ? String(pos) : `${pos}${weight}`));
    out.push(`${quoteLexeme(lexeme)}:${list.join(",")}`);
  }
  return out.join(" ");
}
