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

  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const [start, end] of windows) {
    const piece = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    if (used + piece.length > maxTotalChars) {
      truncated = true;
      break;
    }
    parts.push(piece);
    used += piece.length;
  }
  return { matches, text: parts.join("\n\n[…]\n\n"), truncated };
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
