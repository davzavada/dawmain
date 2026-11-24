import { z } from "zod";
import { deriveStructure } from "@/src/mirror/structure";
import { DOC_PAGE_CHARS, pageOrExcerpt, pageStarts, type DocumentView } from "@/src/sources/shared/text";

/**
 * Reading one Czech decision: a page, `find` excerpts, or — `paragraphs` —
 * the numbered body (bod 24, [24]) of its reasoning.
 *
 * Going back to a passage used to cost a whole page (45k characters) or a
 * `find` on a word the passage had to contain. A decision the model has read
 * is cited by bod, and so are the decisions it cites: `paragraphs: "24-31"`
 * returns those paragraphs alone. The numbering is read from the text itself
 * (deriveStructure — the same parse the mirror stores), so the live path and
 * the mirror path answer alike. Decisions without numbered paragraphs (most
 * of NS before ~2015, old NSS) say so and point at find and the pages.
 */

export const PARAGRAPHS_DESCRIPTION =
  "Return only these numbered paragraphs (body) of the reasoning — '24' or '24-31' — instead of pages: the cheap way back to a passage already read, or to the bod a citation names. Decisions without numbered paragraphs answer that they have none.";

export const paragraphsSchema = z
  .string()
  .regex(/^\s*\d{1,3}\s*(?:[-–]\s*\d{1,3}\s*)?$/, "One paragraph number or a range: '24' or '24-31'")
  .optional()
  .describe(PARAGRAPHS_DESCRIPTION);

function note(text: string, total: number): DocumentView {
  return { mode: "excerpt", text, page: 1, total_pages: 1, total_chars: total, has_more: false };
}

/** The numbered paragraphs `spec` names ("24", "24-31"), whole, as many as one page holds. Pure. */
export function readParagraphs(text: string, spec: string): DocumentView {
  const m = /^\s*(\d{1,3})\s*(?:[-–]\s*(\d{1,3})\s*)?$/.exec(spec);
  const pages = pageStarts(text).length;
  const whole = `page 1${pages > 1 ? ` of ${pages}` : ""}`;
  if (!m) return note(`"${spec}" is not a paragraph number or range — pass '24' or '24-31'.`, text.length);
  const paragraphs = deriveStructure(text).paragraphs;
  if (!paragraphs.length) {
    return note(`This decision has no numbered paragraphs the tool can tell apart — locate the passage with find: "term", or read ${whole}.`, text.length);
  }
  const last = Number(paragraphs[paragraphs.length - 1].num);
  const from = Number(m[1]);
  const to = Math.min(last, Math.max(from, Number(m[2] ?? m[1])));
  const first = paragraphs.findIndex((p) => Number(p.num) === from);
  if (first < 0) return note(`No bod ${from} in this decision: its numbered paragraphs run 1–${last}.`, text.length);
  let end = first;
  while (
    end + 1 < paragraphs.length &&
    Number(paragraphs[end + 1].num) <= to &&
    paragraphs[end + 1].end - paragraphs[first].start <= DOC_PAGE_CHARS
  ) {
    end++;
  }
  const shownTo = Number(paragraphs[end].num);
  const body = text.slice(paragraphs[first].start, Math.min(paragraphs[end].end, paragraphs[first].start + DOC_PAGE_CHARS));
  const range = from === shownTo ? `Bod ${from}` : `Body ${from}–${shownTo}`;
  const more = shownTo < to ? ` The range asked for runs to ${to}: continue with paragraphs: "${shownTo + 1}-${to}".` : "";
  return note(`${body}\n\n(${range} of 1–${last} — a part of the decision; the whole text: ${whole}.${more})`, text.length);
}

/** One entry point of the Czech *_get_decision tools: `paragraphs` first, then `find`, then the page. */
export function readDecision(text: string, opts: { page: number; find?: string; paragraphs?: string }): DocumentView {
  if (opts.paragraphs?.trim()) return readParagraphs(text, opts.paragraphs);
  return pageOrExcerpt(text, opts.page, opts.find);
}
