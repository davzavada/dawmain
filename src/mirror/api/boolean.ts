import { foldWord } from "@/src/files/text/analyze";

/**
 * Search operators, as the courts' own search boxes take them (NS: AND / OR /
 * NOT, NEAR / SENTENCE / PARAGRAPH, `nájem*`, brackets; NSS and NALUS a subset):
 *
 *   "smluvní pokuta" NOT nájem
 *   nájem AND (výpověď OR odstoupení)
 *   promlč* NEAR námitka
 *
 * A query with any of them is parsed here and put to the BM25 index over the
 * whole decisions as ONE query: every leaf is a pg_search operator on the
 * body (`&&&` every word, `###` the phrase, a regex over the indexed terms
 * for a prefix) and the operators between them are SQL's own AND / OR / NOT —
 * pg_search folds the whole WHERE into a single Tantivy boolean query
 * (measured on the production index, 11/2026: `### 'smluvní pokuta' AND NOT
 * (||| 'nájem')` → must + must_not, 7 ms, 4 694 NS decisions = 4 887 with the
 * phrase − 193 with both). The mirror used to read the operators as words to
 * find: NOT was ignored without a word, and such queries then went to the
 * live court instead.
 *
 * Grammar (operators in CAPITALS only, as at the courts; lower-case "not",
 * "or" are words):
 *
 *   or      := and (OR and)*
 *   and     := unary (AND? unary)*        adjacent terms are ANDed
 *   unary   := NOT unary | near
 *   near    := primary ((NEAR | SENTENCE | PARAGRAPH) primary)*
 *   primary := "(" or ")" | "a phrase" | word | prefix*
 *
 * The index holds Czech stems with the diacritics folded, so a word matches
 * its inflections and a phrase its words in that order in any inflection.
 * Proximity is by distance in words, whichever comes first: the index knows
 * no sentences or paragraphs, so SENTENCE and PARAGRAPH are the same test
 * with a wider reach (PROXIMITY_WORDS).
 */

export type Node =
  | { kind: "words"; text: string }
  | { kind: "phrase"; text: string }
  | { kind: "prefix"; text: string }
  | { kind: "near"; left: Side; right: Side; reach: number }
  | { kind: "not"; node: Node }
  | { kind: "and"; nodes: Node[] }
  | { kind: "or"; nodes: Node[] };

/** One side of a proximity operator: a word or phrase as written, or a prefix (without its *). */
export interface Side {
  text: string;
  prefix: boolean;
}

/** How far apart (in words) the two sides of a proximity operator may stand. */
export const PROXIMITY_WORDS = { NEAR: 10, SENTENCE: 25, PARAGRAPH: 120 } as const;
type Proximity = keyof typeof PROXIMITY_WORDS;

/** Deepest nesting and most leaves one query may have — a search box, not a programming language. */
const MAX_DEPTH = 6;
const MAX_LEAVES = 24;
const MAX_PREFIX_CHARS = 40;
/** A prefix shorter than this would match a large part of the dictionary. */
const MIN_PREFIX_CHARS = 3;

/** The body's tokenizer in decision_text_bm25 (migration 0015) — a word put into a proximity clause is stemmed as the index stemmed the text. */
const INDEX_TOKENIZER = "'stemmer=czech', 'ascii_folding=true'";
/** Most stored terms a prefix inside a proximity clause is expanded to. */
const PREFIX_EXPANSIONS = 200;

export class BooleanSyntaxError extends Error {}

type Token =
  | { t: "(" | ")" | "AND" | "OR" | "NOT" }
  | { t: "PROX"; op: Proximity }
  | { t: "phrase"; text: string }
  | { t: "word"; text: string }
  | { t: "prefix"; text: string };

const QUOTES = /["„“”‟«»]/;

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ t: ch });
      i++;
    } else if (QUOTES.test(ch)) {
      let end = i + 1;
      while (end < query.length && !QUOTES.test(query[end])) end++;
      const text = query.slice(i + 1, end).replace(/\s+/g, " ").trim();
      if (text) tokens.push({ t: "phrase", text });
      i = end + 1;
    } else {
      let end = i;
      while (end < query.length && !/[\s()]/.test(query[end]) && !QUOTES.test(query[end])) end++;
      const raw = query.slice(i, end);
      i = end;
      if (raw === "AND" || raw === "OR" || raw === "NOT") tokens.push({ t: raw });
      else if (raw === "NEAR" || raw === "SENTENCE" || raw === "PARAGRAPH") tokens.push({ t: "PROX", op: raw });
      else if (/^[^*?]+\*$/.test(raw)) tokens.push({ t: "prefix", text: raw.slice(0, -1) });
      else {
        // A wildcard anywhere else ("*nájem", "ná?em") is not a form the index answers.
        if (/[*?]/.test(raw)) throw new BooleanSyntaxError(`"${raw}": a wildcard is taken only as * at the end of a word (nájem*)`);
        tokens.push({ t: "word", text: raw });
      }
    }
  }
  return tokens;
}

/**
 * Whether a query speaks the operator syntax at all: an operator word in
 * capitals, a bracket, or a trailing * — outside quotation marks. Anything
 * else (plain words, "phrases") keeps the ordinary search. Pure.
 */
export function hasOperators(query: string): boolean {
  const bare = query.replace(/["„“”‟«»][^"„“”‟«»]*["„“”‟«»]/g, " ");
  return /[()*?]/.test(bare) || bare.split(/\s+/).some((word) => word === "AND" || word === "OR" || word === "NOT" || word in PROXIMITY_WORDS);
}

/** The query as a tree; throws BooleanSyntaxError with what is wrong, in the reader's terms. Pure. */
export function parseBoolean(query: string): Node {
  const tokens = tokenize(query);
  let at = 0;
  let leaves = 0;
  const peek = (): Token | undefined => tokens[at];
  const leaf = <T extends Node>(node: T): T => {
    if (++leaves > MAX_LEAVES) throw new BooleanSyntaxError(`the query has more than ${MAX_LEAVES} terms`);
    return node;
  };

  const primary = (depth: number): Node => {
    const token = tokens[at++];
    if (!token) throw new BooleanSyntaxError("the query ends where a word, a phrase or a bracket was expected");
    if (token.t === "(") {
      if (depth >= MAX_DEPTH) throw new BooleanSyntaxError("the brackets are nested too deep");
      const inner = or(depth + 1);
      if (tokens[at++]?.t !== ")") throw new BooleanSyntaxError("a bracket is not closed");
      return inner;
    }
    if (token.t === "phrase") return leaf({ kind: "phrase", text: token.text });
    if (token.t === "word") return leaf({ kind: "words", text: token.text });
    if (token.t === "prefix") {
      const folded = foldWord(token.text).replace(/[^a-z0-9]/g, "");
      if (folded.length < MIN_PREFIX_CHARS) throw new BooleanSyntaxError(`"${token.text}*": a prefix needs at least ${MIN_PREFIX_CHARS} letters`);
      if (folded.length > MAX_PREFIX_CHARS) throw new BooleanSyntaxError(`"${token.text}*" is too long`);
      return leaf({ kind: "prefix", text: token.text });
    }
    throw new BooleanSyntaxError(`${token.t === "PROX" ? token.op : token.t} stands where a word, a phrase or a bracket was expected`);
  };

  const near = (depth: number): Node => {
    let left = primary(depth);
    for (let next = peek(); next?.t === "PROX"; next = peek()) {
      at++;
      const right = primary(depth);
      const side = (node: Node): Side => {
        if (node.kind === "words" || node.kind === "phrase") return { text: node.text, prefix: false };
        if (node.kind === "prefix") return { text: node.text, prefix: true };
        throw new BooleanSyntaxError(`${next.op} takes a word, a prefix* or a "phrase" on each side`);
      };
      const sides = { left: side(left), right: side(right) };
      // A prefix stands next to ONE word: the index tests a prefix against single terms, not phrases.
      if ((sides.left.prefix || sides.right.prefix) && [sides.left, sides.right].some((s) => !s.prefix && /\s/.test(s.text))) {
        throw new BooleanSyntaxError(`${next.op} with a prefix* takes a single word on the other side, not a phrase`);
      }
      left = { kind: "near", ...sides, reach: PROXIMITY_WORDS[next.op] };
    }
    return left;
  };

  const unary = (depth: number): Node => {
    if (peek()?.t === "NOT") {
      at++;
      if (depth >= MAX_DEPTH) throw new BooleanSyntaxError("the query is nested too deep");
      return { kind: "not", node: unary(depth + 1) };
    }
    return near(depth);
  };

  const and = (depth: number): Node => {
    const nodes = [unary(depth)];
    for (let next = peek(); next && next.t !== ")" && next.t !== "OR"; next = peek()) {
      if (next.t === "AND") at++;
      nodes.push(unary(depth));
    }
    // Bare words side by side are one "every word" leaf, as the plain search reads them.
    const merged: Node[] = [];
    for (const node of nodes) {
      const last = merged[merged.length - 1];
      if (node.kind === "words" && last?.kind === "words") last.text = `${last.text} ${node.text}`;
      else merged.push(node.kind === "words" ? { ...node } : node);
    }
    return merged.length === 1 ? merged[0] : { kind: "and", nodes: merged };
  };

  function or(depth: number): Node {
    const nodes = [and(depth)];
    while (peek()?.t === "OR") {
      at++;
      nodes.push(and(depth));
    }
    return nodes.length === 1 ? nodes[0] : { kind: "or", nodes };
  }

  if (!tokens.length) throw new BooleanSyntaxError("the query is empty");
  const tree = or(0);
  if (at < tokens.length) throw new BooleanSyntaxError(tokens[at].t === ")" ? "a bracket is closed that was never opened" : "the query could not be read to its end");
  if (!positiveText(tree)) throw new BooleanSyntaxError("NOT needs something to find beside what it leaves out");
  return tree;
}

/**
 * What the query asks to FIND, as plain text: the words, phrases and prefixes
 * not under a NOT. It picks each hit's excerpt and marks its matches — what a
 * query excludes is, by definition, not in the hit. "" when the query only
 * excludes. Pure.
 */
export function positiveText(node: Node): string {
  switch (node.kind) {
    case "words":
    case "phrase":
    case "prefix":
      return node.text;
    case "near":
      return `${node.left.text} ${node.right.text}`;
    case "not":
      return "";
    case "and":
    case "or":
      return node.nodes.map(positiveText).filter(Boolean).join(" ");
  }
}

/** Whether the node can match on its own (a NOT, or an AND of nothing but NOTs, only narrows what stands beside it). */
function matchesSomething(node: Node): boolean {
  if (node.kind === "not") return false;
  if (node.kind === "and") return node.nodes.some(matchesSomething);
  if (node.kind === "or") return node.nodes.every(matchesSomething);
  return true;
}

/**
 * The tree as a SQL predicate over `column` (the BM25-indexed body), every
 * piece of the reader's text a bound parameter pushed onto `params`. Only
 * operators, brackets and the validated word distances are interpolated.
 * An OR with a side that only excludes ("a OR NOT b" = nearly every decision)
 * is refused. Pure.
 */
export function booleanSql(node: Node, column: string, params: unknown[]): string {
  const bind = (value: string): string => `$${params.push(value)}::text`;
  switch (node.kind) {
    case "words":
      return `${column} &&& ${bind(node.text)}`;
    case "phrase":
      return `${column} ### ${bind(node.text)}`;
    case "prefix": {
      // The index holds stems: "nájem" itself is stored as "naje", which "najem.*" would miss — so the
      // word as written counts too.
      const folded = foldWord(node.text).replace(/[^a-z0-9]/g, "");
      return `(${column} @@@ pdb.regex(${bind(`${folded}.*`)}) OR ${column} &&& ${bind(node.text)})`;
    }
    case "near": {
      const reach = Math.floor(node.reach);
      // Words and phrases: the phrase operator with slack — the index stems both sides itself.
      if (!node.left.prefix && !node.right.prefix) return `${column} ### ${bind(`${node.left.text} ${node.right.text}`)}::pdb.slop(${reach})`;
      // A prefix on a side: a proximity clause of single terms. A term there is taken as stored, so the
      // word is stemmed by the index's own tokenizer first; the prefix is a pattern over the stored terms.
      const clause = (side: Side): string =>
        side.prefix
          ? `pdb.prox_regex(${bind(`${foldWord(side.text).replace(/[^a-z0-9]/g, "")}.*`)}, ${PREFIX_EXPANSIONS})`
          : `pdb.prox_term((${bind(side.text)}::pdb.simple(${INDEX_TOKENIZER})::text[])[1])`;
      return `${column} @@@ pdb.proximity(${clause(node.left)}, ${reach}, ${clause(node.right)})`;
    }
    case "not":
      return `NOT (${booleanSql(node.node, column, params)})`;
    case "and":
      return `(${node.nodes.map((child) => booleanSql(child, column, params)).join(" AND ")})`;
    case "or":
      if (!node.nodes.every(matchesSomething)) throw new BooleanSyntaxError("NOT cannot stand alone on one side of OR — say what to find there");
      return `(${node.nodes.map((child) => booleanSql(child, column, params)).join(" OR ")})`;
  }
}
