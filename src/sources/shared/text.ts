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
