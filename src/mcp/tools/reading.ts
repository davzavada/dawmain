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

export const OUTLINE_DESCRIPTION =
  "Return the outline instead of the text: the výrok, then the headings of the reasoning with their paragraph (bod) ranges and sizes.";

export const outlineSchema = z.boolean().optional().describe(OUTLINE_DESCRIPTION);

const SECTION_NAMES: Record<string, string> = {
  zahlavi: "záhlaví",
  vyrok: "výrok",
  oduvodneni: "odůvodnění",
  pouceni: "poučení",
  stanovisko: "odlišné stanovisko",
};

/** Most of a výrok an outline quotes; a longer one is cut and its paragraphs named. */
const OUTLINE_VERDICT_CHARS = 2_500;
/** Most headings an outline lists. */
const OUTLINE_HEADINGS = 40;

function size(chars: number): string {
  return chars < 1_000 ? `${chars} znaků` : `${(chars / 1_000).toFixed(chars < 10_000 ? 1 : 0)}k znaků`;
}

/** "body 12–19" of the paragraphs starting inside [from, to); "" when none do. */
function bodyRange(paragraphs: Array<{ num: string; start: number }>, from: number, to: number): string {
  const inside = paragraphs.filter((p) => p.start >= from && p.start < to);
  if (!inside.length) return "";
  const first = inside[0].num;
  const last = inside[inside.length - 1].num;
  return first === last ? `bod ${first}` : `body ${first}–${last}`;
}

/**
 * The outline of a decision: its parts with their sizes, the výrok in full,
 * and under the reasoning its headings with the body they cover. A long
 * decision is half procedural history and the parties' submissions; the
 * outline shows where the court's own assessment starts ("IV. Posouzení
 * věci — body 23–41"), so going back, or screening a 100k-character nález,
 * does not start with page 1. Read from the text (deriveStructure). Pure.
 */
export function readOutline(text: string): DocumentView {
  const { sections, paragraphs, headings } = deriveStructure(text);
  const pages = pageStarts(text).length;
  const whole = `page 1${pages > 1 ? `–${pages}` : ""}`;
  if (!sections.length && !headings.length && !paragraphs.length) {
    return note(`No parts the tool can tell apart in this decision (${size(text.length)}, ${pages} ${pages === 1 ? "page" : "pages"}) — locate a passage with find: "term", or read ${whole}.`, text.length);
  }
  const lines: string[] = [`Osnova — the whole text: ${size(text.length)}, ${pages} ${pages === 1 ? "page" : "pages"}.`];
  for (const section of sections) {
    const name = SECTION_NAMES[section.kind] ?? section.kind;
    const range = section.kind === "oduvodneni" ? bodyRange(paragraphs, section.start, section.end) : "";
    lines.push(`■ ${name} — ${size(section.end - section.start)}${range ? `, ${range}` : ""}`);
    if (section.kind === "vyrok") {
      const verdict = text.slice(section.start, section.end).trim();
      lines.push(verdict.length > OUTLINE_VERDICT_CHARS ? `${verdict.slice(0, OUTLINE_VERDICT_CHARS)}… (cut — the výrok whole is on page 1)` : verdict);
    }
    if (section.kind === "oduvodneni") lines.push(...headingLines(headings, paragraphs, section.end));
  }
  // No odůvodnění found: the headings and numbering were read from the whole main text.
  if (!sections.some((s) => s.kind === "oduvodneni")) {
    const range = paragraphs.length ? bodyRange(paragraphs, 0, text.length) : "";
    if (range) lines.push(`■ numbered paragraphs: ${range}`);
    lines.push(...headingLines(headings, paragraphs, text.length));
  }
  const how = paragraphs.length ? `paragraphs: "from-to" reads a part, ` : `find: "term" locates a passage, `;
  lines.push("", `(An outline, not a reading: ${how}${whole} the whole decision.)`);
  return note(lines.join("\n"), text.length);
}

function headingLines(
  headings: Array<{ text: string; start: number }>,
  paragraphs: Array<{ num: string; start: number }>,
  end: number,
): string[] {
  const shown = headings.slice(0, OUTLINE_HEADINGS);
  const out = shown.map((heading, i) => {
    const to = headings[i + 1]?.start ?? end;
    const range = bodyRange(paragraphs, heading.start, to);
    return `  · ${heading.text} — ${range ? `${range}, ` : ""}${size(to - heading.start)}`;
  });
  if (headings.length > shown.length) out.push(`  · … and ${headings.length - shown.length} more headings`);
  return out;
}

/** One entry point of the Czech *_get_decision tools: `outline` first, then `paragraphs`, then `find`, then the page. */
export function readDecision(text: string, opts: { page: number; find?: string; paragraphs?: string; outline?: boolean }): DocumentView {
  if (opts.outline) return readOutline(text);
  if (opts.paragraphs?.trim()) return readParagraphs(text, opts.paragraphs);
  return pageOrExcerpt(text, opts.page, opts.find);
}
