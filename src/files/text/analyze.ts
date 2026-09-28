/**
 * The text analyzer of Vlastní zdroje: one tokenizer and one term function
 * for the index, one for queries, and the tsquery builder. Isomorphic and
 * pure — derive (browser preview and server ingest), search and highlight
 * all go through here, so what is indexed, what is queried and what gets
 * highlighted can never drift apart.
 *
 * Postgres has no Czech stemmer and Neon allows no custom dictionaries, so
 * stemming runs in the app and Postgres only sees 'simple' lexemes:
 *
 * - INDEX side (indexTerm): the vendored Snowball 3.1.1 Czech stemmer on the
 *   lowercase word WITH diacritics, then fold. Order matters: Snowball's
 *   suffix table is written with diacritics, so a folded "smlouvách" keeps
 *   its "-ach" and "vlastnického" stems to "vlastnickeh".
 *
 * - QUERY side (queryTerm / queryTerms): a word typed with diacritics gets
 *   exactly indexTerm. A word typed without them ("smlouvach", "skody") can't
 *   go through Snowball, so it gets the folded Lucene/Dolamic light stemmer
 *   below (case suffixes, then possessives) and a Snowball-compatible tail
 *   rewrite. Every query term is used as a PREFIX (":*"), which absorbs a
 *   stem that comes out a letter or two short. queryTerms adds the few
 *   alternatives Snowball itself is inconsistent about (c/k palatalisation:
 *   "soudce" → soudk but "soudců" → soudc; the inserted -e-: "obec" → obec
 *   but "obce" → obk) and the query ORs them.
 *
 * Terms containing a digit, and terms of ≤ 2 characters, are matched
 * exactly (never as prefixes): "§ 29" must not find 2913, and "ÚS" must not
 * find every word starting with "us".
 *
 * ---------------------------------------------------------------------------
 * The case / possessive suffix tables in luceneStem() are adapted from Apache
 * Lucene's org.apache.lucene.analysis.cz.CzechStemmer (removeCase,
 * removePossessives), an implementation of the light stemmer from
 * L. Dolamic, J. Savoy: "Indexing and stemming approaches for the Czech
 * language" (Information Processing & Management 45, 2009).
 *
 *   Licensed to the Apache Software Foundation (ASF) under one or more
 *   contributor license agreements. The ASF licenses this file to You under
 *   the Apache License, Version 2.0 (the "License"); you may not use this
 *   file except in compliance with the License. You may obtain a copy of the
 *   License at http://www.apache.org/licenses/LICENSE-2.0
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * Modifications: the suffixes are folded (they run on text typed without
 * diacritics, so "ích"/"ich" and "ům"/"um" merge), and Lucene's normalize()
 * step is replaced by snowballTail(), which mirrors what the Snowball index
 * side does instead (Lucene's z→h and generic -e- deletion would produce
 * prefixes that match no Snowball index term: "zákaz" → zakah, "výpovědi" →
 * vypovd).
 * ---------------------------------------------------------------------------
 *
 * Pure — unit-tested (tests/files-analyze.test.ts, tests/files-stem.test.ts).
 */

import CzechStemmer from "@/src/files/text/stem/czech-stemmer.js";
import { STOPWORDS } from "@/src/files/text/stopwords";

export { STOPWORDS };

const stemmer = new CzechStemmer();

/** Longer tokens are not words (hashes, glued URLs): folded, never stemmed. */
const MAX_STEM_LENGTH = 48;
/** Query input beyond this is ignored — a query is a few words, not a page. */
const MAX_QUERY_CHARS = 1_000;
/** Operands (words or phrases) per tsquery; more only slows the GIN scan. */
const MAX_QUERY_OPERANDS = 16;
/** Words per quoted phrase. */
const MAX_PHRASE_WORDS = 12;
/** Alternatives per query word (see queryTerms). */
const MAX_VARIANTS = 4;

/** Latin letters that NFD does not decompose into base + mark. */
const FOLD_EXTRA: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ħ: "h",
  ŧ: "t",
};
const FOLD_EXTRA_RE = /[ßæœøłđðþıħŧ]/g;

/** Lowercase, strip diacritics (NFD, drop combining marks). Pure. */
export function foldWord(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(FOLD_EXTRA_RE, (c) => FOLD_EXTRA[c] ?? c);
}

// A token starts with a letter or decimal digit and may carry combining
// marks (text that escaped NFC). \p{Nd}, not \p{N}: a superscript footnote
// digit glued to a word ("smlouvy²") must not become part of the word.
const TOKEN_RE = /[\p{L}\p{Nd}][\p{L}\p{Nd}\p{M}]*/gu;

/**
 * Word tokens with absolute [start, end) offsets into `text`; `lower` is the
 * lowercase NFC form. Callers pass markup-stripped or chunk text, so a token
 * never spans DMD markup. Pure.
 */
export function tokenize(text: string): Array<{ lower: string; start: number; end: number }> {
  const out: Array<{ lower: string; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    out.push({ lower: m[0].toLowerCase().normalize("NFC"), start, end: start + m[0].length });
  }
  return out;
}

const HAS_DIGIT = /\p{Nd}/u;

/**
 * Index-side term: Snowball stem of the lowercase word WITH diacritics, then
 * fold. Tokens with a digit and tokens under 2 characters pass folded. Pure.
 */
export function indexTerm(lower: string): string {
  const word = lower.toLowerCase().normalize("NFC");
  if (word.length < 2 || word.length > MAX_STEM_LENGTH || HAS_DIGIT.test(word)) return foldWord(word);
  return foldWord(stemmer.stemWord(word));
}

/** True when the term must match a lexeme exactly rather than as a prefix. */
export function isExactTerm(term: string): boolean {
  return term.length <= 2 || /[0-9]/.test(term);
}

// ---------------------------------------------------------------------------
// Query side for words typed without diacritics (see the header).

/** Folded removeCase tiers: [length must exceed, suffixes]. */
const CASE_TIERS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [7, ["atech"]],
  [6, ["etem", "atum"]],
  [
    5,
    [
      "ech", "ich", "eho", "emi", "emu", "ete", "eti", "iho", "imi", "imu", "ach", "ata", "aty", "ych",
      "ama", "ami", "ove", "ovi", "ymi",
    ],
  ],
  // Lucene's "es" is left out: Snowball never strips it, and on folded text
  // it only cuts loanwords short ("proces" → proc, matching "procent").
  [4, ["em", "im", "um", "at", "am", "os", "us", "ym", "mi", "ou"]],
];
const FINAL_VOWEL = /[aeiouy]$/;

/** Lucene removeCase + removePossessives on a folded word (stem ≥ 3 chars). Pure. */
export function luceneStem(folded: string): string {
  let w = folded;
  let stripped = false;
  for (const [minLen, suffixes] of CASE_TIERS) {
    if (w.length <= minLen) continue;
    const hit = suffixes.find((s) => w.endsWith(s));
    if (hit) {
      w = w.slice(0, -hit.length);
      stripped = true;
      break;
    }
  }
  if (!stripped && w.length > 3 && FINAL_VOWEL.test(w)) w = w.slice(0, -1);
  // Possessives -ov, -in (Lucene also strips -ův, but folded it is "uv" and
  // would eat the stem of "smlouv").
  if (w.length > 5 && /(?:ov|in)$/.test(w)) w = w.slice(0, -2);
  return w;
}

const VOWELS = "aeiouy";
const isConsonant = (c: string | undefined) => c !== undefined && /[a-z]/.test(c) && !VOWELS.includes(c);

/**
 * Snowball's removal of the inserted -e- (czech.sbl case_suffix: -eb, -ec,
 * -ek, -et, -ev), approximated on folded text: "rozsudek" → rozsudk,
 * "pocet" → poct, "cirkev" → cirkv. Returns the word unchanged when no rule
 * applies. -eň is left out: folded it is indistinguishable from the far more
 * common -en ("promlcen").
 */
export function snowballTail(w: string): string {
  const m = /^(.*[a-z])e([bcktv])$/.exec(w);
  if (!m || w.length < 4) return w;
  const [, head, last] = m;
  const before = head[head.length - 1];
  switch (last) {
    case "b":
      return isConsonant(before) && !head.endsWith("tr") ? head + "b" : w;
    case "c":
      return isConsonant(before) ? head + "c" : w;
    case "k":
      return isConsonant(before) && !/(?:dot|obl|sn)$/.test(head) ? head + "k" : w;
    case "t":
      return /(?:uc|c|h|ok|kar)$/.test(head) ? head + "t" : w;
    case "v":
      return /[hknrtz]$/.test(head) ? head + "v" : w;
  }
  return w;
}

/**
 * Query-side term: indexTerm for a word typed with diacritics; for a word
 * typed without them, the folded Lucene stem with Snowball's -e- removal.
 * Used as a prefix. Pure.
 */
export function queryTerm(lower: string): string {
  const word = lower.toLowerCase().normalize("NFC");
  const folded = foldWord(word);
  if (folded !== word || word.length <= 2 || word.length > MAX_STEM_LENGTH || HAS_DIGIT.test(word)) {
    return indexTerm(word);
  }
  return snowballTail(luceneStem(folded));
}

/**
 * Stem alternations no suffix rule reaches, for legal terms common enough to
 * matter ("uzavírání smluv", "výklad smluv"). Kept tiny on purpose: each entry
 * widens every query containing the word.
 */
const ALTERNATING_STEMS: Record<string, string> = { smlouv: "smluv", smluv: "smlouv" };

/** The spellings Snowball may give other forms of the same word. */
function alternatives(t: string, iContext: boolean): string[] {
  const out: string[] = [];
  const alternating = ALTERNATING_STEMS[t];
  if (alternating) out.push(alternating);
  // c/k palatalisation is applied to some case endings only (soudce/soudců).
  if (t.endsWith("c")) out.push(t.slice(0, -1) + "k");
  if (t.endsWith("k")) out.push(t.slice(0, -1) + "c");
  // Snowball turns čt → ck and št → sk before -i/-í endings and the -in
  // possessive; typed without diacritics, "ct"/"st" may hide č/š (čeští).
  if (iContext && /[cs]t$/.test(t)) out.push(t.slice(0, -1) + "k");
  // A short word starting with a vowel keeps its -e- in the nominative
  // (Snowball's R1 protects it: obec, otec, účet) but loses it elsewhere
  // (obce → obk, účtu → uct).
  const short = /^([aeiouy][b-df-hj-np-tv-z])([bcktv])$/.exec(t);
  if (short) {
    out.push(`${short[1]}e${short[2]}`);
    if (short[2] === "k") out.push(`${short[1]}ec`);
  }
  const tail = snowballTail(t);
  if (tail !== t) out.push(tail);
  return out;
}

/**
 * All prefixes a query word should match, primary (queryTerm) first. Words
 * typed without diacritics also try Snowball directly (right for words that
 * have none: "smlouvy", "soudci"). Candidates that another candidate
 * already covers as a prefix are dropped. Every result is [a-z0-9]+ or the
 * list is empty (a word with no Latin letters or digits after folding). Pure.
 */
export function queryTerms(lower: string): string[] {
  const word = lower.toLowerCase().normalize("NFC");
  const primary = queryTerm(word);
  if (isExactTerm(primary) || word.length > MAX_STEM_LENGTH) {
    return /^[a-z0-9]+$/.test(primary) ? [primary] : [];
  }
  const typedFolded = foldWord(word) === word;
  const candidates = [primary];
  if (typedFolded) candidates.push(indexTerm(word));
  // Endings before which Snowball palatalises (-i/-í forms, the -in possessive).
  const iContext = typedFolded && /(?:i|ich|iho|im|imi|imu|in[aeouy]?|inou|inach|inami)$/.test(word);
  for (const c of [...candidates]) candidates.push(...alternatives(c, iContext));
  const minLen = Math.min(3, primary.length);
  const valid = [...new Set(candidates)].filter((c) => c.length >= minLen && /^[a-z0-9]+$/.test(c));
  const kept: string[] = [];
  for (const c of valid) {
    if (valid.some((o) => o !== c && c.startsWith(o))) continue; // covered by a shorter prefix
    kept.push(c);
  }
  // The prefix covering the primary term leads (it is what queryTerm returns
  // or shorter); the alternatives follow in the order they were generated.
  const lead = kept.findIndex((k) => primary.startsWith(k));
  if (lead > 0) kept.unshift(...kept.splice(lead, 1));
  return kept.slice(0, MAX_VARIANTS);
}

// ---------------------------------------------------------------------------
// tsquery building.

export interface TsQueryBuild {
  /** All terms ANDed as prefixes, phrases as <->; null when nothing searchable. */
  and: string | null;
  /** Same terms ORed; null when < 2 terms. */
  or: string | null;
  /** Folded query stems (for highlighting), every alternative included. */
  terms: string[];
  /** Quoted phrases, each as its list of (primary) terms. */
  phrases: string[][];
}

const QUOTES = /["„“”‟«»]/g;

/** "D", "ABC" … — only A–D, deduplicated, in order; anything else is dropped. */
function sanitizeWeights(weights: string | undefined): string {
  if (!weights) return "";
  return [...new Set(weights.toUpperCase().replace(/[^ABCD]/g, ""))].sort().join("");
}

function lexeme(term: string, weights: string): string {
  // term is [a-z0-9]+ (queryTerms guarantees it), so the quotes need no escaping.
  return isExactTerm(term) ? `'${term}'${weights ? `:${weights}` : ""}` : `'${term}':*${weights}`;
}

function operand(variants: string[], weights: string): string {
  const parts = variants.map((v) => lexeme(v, weights));
  return parts.length === 1 ? parts[0] : `( ${parts.join(" | ")} )`;
}

interface Word {
  folded: string;
  variants: string[];
}

function words(text: string): Word[] {
  const out: Word[] = [];
  for (const t of tokenize(text)) {
    const variants = queryTerms(t.lower);
    if (variants.length) out.push({ folded: foldWord(t.lower), variants });
  }
  return out;
}

/**
 * tsquery strings for to_tsquery('simple', …) from free user text. Only
 * [a-z0-9] lexemes, quoted, and the builder's own operators reach the
 * output — operators, quotes and brackets in the input are just separators.
 * Stopwords are dropped outside phrases unless that leaves nothing. Text in
 * double quotes („…“ too) is a phrase: its words joined by <->, stopwords
 * kept (positions must line up). `weights` restricts every lexeme ("D" =
 * footnotes only, "ABC" = everything but footnotes). Pure.
 */
export function buildTsQuery(input: string, opts?: { weights?: string }): TsQueryBuild {
  const weights = sanitizeWeights(opts?.weights);
  const text = input.normalize("NFC").slice(0, MAX_QUERY_CHARS).replace(QUOTES, '"');
  const segments = text.split('"');
  // An unmatched opening quote: the rest is plain words, not a phrase.
  if (segments.length % 2 === 0) segments.push(segments.splice(-2, 2).join(" "));

  // Operands in input order: a loose word, or a phrase (odd segments).
  const items: Array<{ phrase: boolean; words: Word[] }> = [];
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      const ws = words(segment).slice(0, MAX_PHRASE_WORDS);
      if (ws.length) items.push({ phrase: true, words: ws });
    } else {
      for (const w of words(segment)) items.push({ phrase: false, words: [w] });
    }
  });

  const isStop = (item: { phrase: boolean; words: Word[] }) => !item.phrase && STOPWORDS.has(item.words[0].folded);
  // Stopwords go, unless nothing else is left ("to je ono").
  const content = items.some((item) => !isStop(item)) ? items.filter((item) => !isStop(item)) : items;
  const seen = new Set<string>();
  const chosen = content
    .filter((item) => {
      const key = item.words.map((w) => w.variants.join("|")).join(" ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_QUERY_OPERANDS);

  const operands = chosen.map((item) =>
    item.words.length === 1
      ? operand(item.words[0].variants, weights)
      : `( ${item.words.map((w) => operand(w.variants, weights)).join(" <-> ")} )`,
  );
  const terms = [...new Set(chosen.flatMap((item) => item.words.flatMap((w) => w.variants)))];
  return {
    and: operands.length ? operands.join(" & ") : null,
    or: operands.length >= 2 ? operands.join(" | ") : null,
    terms,
    phrases: chosen.filter((item) => item.phrase).map((item) => item.words.map((w) => w.variants[0])),
  };
}
