/** Size discipline: every tool result must stay digestible for an LLM. */

/** Max characters of one document page returned by a *_get_* tool.
 * Czech legal text tokenizes at ~2.5 chars/token, so a page must stay well
 * under MCP clients' ~25k-token output caps or the WHOLE response gets
 * rejected and the model reads nothing (measured live: 60k chars tripped the
 * cap). 45k chars ≈ 18k tokens: every page arrives reliably, a typical
 * decision fits in 1–2 pages, and the auto-continue hint chains the rest. */
export const DOC_PAGE_CHARS = 45_000;
/** Max characters of a single search-result snippet. */
export const SNIPPET_CHARS = 400;

export interface CharPage {
  text: string;
  page: number;
  total_pages: number;
  total_chars: number;
  has_more: boolean;
}

/** Slice a long text into fixed character pages (1-based `page`). */
export function charPage(text: string, page: number, pageChars = DOC_PAGE_CHARS): CharPage {
  const total_chars = text.length;
  const total_pages = Math.max(1, Math.ceil(total_chars / pageChars));
  const clamped = Math.min(Math.max(1, page), total_pages);
  const start = (clamped - 1) * pageChars;
  return {
    text: text.slice(start, start + pageChars),
    page: clamped,
    total_pages,
    total_chars,
    has_more: clamped < total_pages,
  };
}

/** Trim a snippet to the cap, on a word boundary where possible. */
export function snippet(text: string, max = SNIPPET_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Czech-friendly date helpers: tools accept ISO (YYYY-MM-DD), sources vary. */
export function isoToCzech(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
}

/**
 * DD.MM.YYYY / D. M. YYYY / DD/MM/YYYY → ISO. Returns null if unparsable.
 * (NALUS prints "7. 7. 2026", NS result rows "07.07.2026".)
 */
export function czechToIso(czech: string): string | null {
  const m = /^\s*(\d{1,2})[./]\s*(\d{1,2})[./]\s*(\d{4})\s*$/.exec(czech);
  if (!m) return null;
  const [day, month] = [Number(m[1]), Number(m[2])];
  // Range check keeps US-format dates (MM/DD/YYYY, e.g. 05/20/2026) from
  // being misread as day.month — the caller can then try the US parser.
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * Targeted excerpts: windows of text around every match of `term`,
 * diacritics- and case-insensitive (per-char NFD fold keeps offsets 1:1).
 * Lets the model jump to the relevant passages of a long decision instead
 * of paging through all of it — the token-economical read.
 */
const EXCERPT_CONTEXT_CHARS = 1_500;

function foldChar(char: string): string {
  // Astral characters (surrogate pairs) occupy TWO UTF-16 units — emit them
  // unchanged so folded offsets stay 1:1 with the original string.
  if (char.length === 2) return char;
  return char.normalize("NFD")[0]?.toLowerCase() ?? char;
}

function foldText(text: string): string {
  let out = "";
  for (const char of text) out += foldChar(char);
  return out;
}

export interface ExcerptResult {
  matches: number;
  /** Windows joined with a […] separator; capped at one page. */
  text: string;
  truncated: boolean;
}

export function findExcerpts(
  text: string,
  term: string,
  contextChars = EXCERPT_CONTEXT_CHARS,
  maxTotalChars = DOC_PAGE_CHARS,
): ExcerptResult {
  const needle = foldText(term.trim());
  if (!needle) return { matches: 0, text: "", truncated: false };
  const haystack = foldText(text);

  const windows: Array<[number, number]> = [];
  let index = haystack.indexOf(needle);
  let matches = 0;
  while (index !== -1 && matches < 200) {
    matches++;
    const start = Math.max(0, index - contextChars);
    const end = Math.min(text.length, index + needle.length + contextChars);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else windows.push([start, end]);
    index = haystack.indexOf(needle, index + needle.length);
  }
  if (!matches) return { matches: 0, text: "", truncated: false };

  const SEPARATOR = "\n\n[…]\n\n";
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const [start, end] of windows) {
    const piece = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    const cost = piece.length + (parts.length ? SEPARATOR.length : 0);
    if (used + cost > maxTotalChars) {
      truncated = true;
      break;
    }
    parts.push(piece);
    used += cost;
  }
  return { matches, text: parts.join(SEPARATOR), truncated };
}

/** Distinct, trimmed query variants — at most `cap` (case-insensitive dedupe). */
export function uniqueQueries(
  query: string | undefined,
  queries: string[] | undefined,
  cap = 3,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [query, ...(queries ?? [])]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/** Highest per-variant total — with several variants the union is unknowable. */
export function maxTotal(totals: Array<number | null>): number | null {
  const known = totals.filter((total): total is number => total !== null);
  return known.length ? Math.max(...known) : null;
}

/**
 * The narrowing to report when variants were windowed independently: the
 * LATEST start date among them, because that is the one that hid the most.
 * Null only when no variant was windowed — reporting one variant's null as
 * the answer would claim the whole archive was searched when it was not.
 */
export function narrowestWindow(windows: Array<string | null>): string | null {
  const applied = windows.filter((from): from is string => from !== null).sort();
  return applied.at(-1) ?? null;
}

/** First occurrence wins; order preserved. */
export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface SearchPreview {
  matches: number;
  excerpt: string;
}

/**
 * Search-result preview: excerpts around the first query variant that matches
 * (diacritics-insensitive), else the head of the text. Small on purpose —
 * a preview earns a full *_get_decision read, it does not replace one.
 */
/** Words that are search syntax, never document content — the Domino/Verity
 * operator vocabulary the NS box speaks, shared with the NS query builder so
 * the two can never fall out of step. */
export const SEARCH_OPERATORS = new Set([
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "SENTENCE",
  "PARAGRAPH",
  "ACCRUE",
  "EXACTCASE",
  "TERMWEIGHT",
]);

/**
 * Turn a search expression into strings that can be found inside a document.
 * A query may carry engine syntax — "exact phrases", (grouping), wildcards,
 * AND/OR/NOT — none of which appears in the text, so matching the raw query
 * finds nothing and the preview falls back to the document head.
 *
 * Priority: quoted phrases first (most precise), then each expression stripped
 * of syntax, then single words long enough to mean something. Pure.
 */
export function excerptTerms(queries: Array<string | undefined>): string[] {
  const phrases: string[] = [];
  const stripped: string[] = [];
  const words: string[] = [];
  for (const raw of queries) {
    if (!raw?.trim()) continue;
    for (const match of raw.matchAll(/"([^"]+)"/g)) phrases.push(match[1]);
    const tokens = raw
      .replace(/["()[\]{}*?]/g, " ")
      .split(/\s+/)
      .filter((token) => token && !SEARCH_OPERATORS.has(token.toUpperCase()));
    if (tokens.length) stripped.push(tokens.join(" "));
    for (const token of tokens) if (token.length >= 4) words.push(token);
  }
  const out: string[] = [];
  for (const candidate of [...phrases, ...stripped, ...words]) {
    const term = candidate.trim();
    if (term.length >= 3 && !out.includes(term)) out.push(term);
  }
  return out;
}

export function previewExcerpt(
  text: string,
  terms: string[],
  contextChars = 600,
  maxChars = 2_400,
): SearchPreview {
  for (const term of terms) {
    if (!term?.trim()) continue;
    const result = findExcerpts(text, term, contextChars, maxChars);
    if (result.matches) return { matches: result.matches, excerpt: result.text };
  }
  const head = text.slice(0, maxChars).trim();
  return { matches: 0, excerpt: text.length > maxChars ? `${head}…` : head };
}

export interface DocumentView extends CharPage {
  mode: "page" | "excerpt";
  /** Number of `find` matches (excerpt mode only). */
  matches?: number;
}

/** One entry point for *_get_* tools: full-text page, or `find` excerpts. */
export function pageOrExcerpt(text: string, page: number, find?: string): DocumentView {
  if (find?.trim()) {
    const result = findExcerpts(text, find);
    return {
      mode: "excerpt",
      matches: result.matches,
      // A zero-match answer must say so explicitly — an empty string reads
      // as a broken fetch, and Czech terms inflect, so hint at the fix.
      text: result.matches
        ? result.text
        : `No occurrences of "${find.trim()}" in this document (${text.length} chars searched; matching is case- and diacritics-insensitive). Inflected languages: retry with a shorter word stem or a synonym — or read the pages.`,
      page: 1,
      total_pages: 1,
      total_chars: text.length,
      has_more: result.truncated,
    };
  }
  return { mode: "page", ...charPage(text, page) };
}
