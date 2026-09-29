import { sanitizeLine } from "@/src/files/dmd/normalize";
import { canonicalCaseNumber, findIdentSpans, queryIdentKeys } from "@/src/files/index/identifiers";

/**
 * Text helpers of the tools that print the user's private material —
 * Vlastní zdroje (files_*) and Zotero (zotero_*): numbers and dates the
 * Czech way, tool hints that echo only plainly safe values, and the
 * spisová značka bridges to the official texts (a decision found in a
 * user's book or library is cited from the court's database, never from
 * the copy).
 *
 * Kept apart from files.ts so zotero_* can print the same lines without
 * pulling in the files database layer. Pure — no I/O, no server-only
 * imports; src/mcp/tools/files.ts re-exports all of it for its callers.
 */

/** Official-text lines one hit (or one item) carries at most. */
const MAX_OFFICIAL_PER_HIT = 3;

/** "1 240" — thin-grouped Czech number. Pure. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** "2026-09-12T…" → "12. 9. 2026"; "" for anything else. Pure. */
export function czechDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : "";
}

/** Values a tool hint may echo from a document: page labels, m. č., footnote labels, § designators. */
const SAFE_HINT_VALUE = /^[\p{L}\p{N} .\-–§#*†]{1,24}$/u;

/** `name: "value"` for a tool hint, or null when the value is not plainly safe to echo. Pure. */
export function hintArg(name: string, value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return `${name}: ${value}`;
  return SAFE_HINT_VALUE.test(value) ? `${name}: ${JSON.stringify(value)}` : null;
}

/** `tool {a: 1, b: "x"}` from the non-null args. Pure. */
export function toolCall(tool: string, args: Array<string | null>): string {
  return `${tool} {${args.filter((a): a is string => !!a).join(", ")}}`;
}

/** Identifier keys of a spisová značka / ECLI / R / Sb. NSS / SbNU citation — the case_number filter. Pure. */
export function caseNumberKeys(input: string): string[] {
  return queryIdentKeys(input).keys.filter((k) => /^(sz|ecli|r|sbnss|sbnu):/.test(k));
}

const OFFICIAL_TOOL: Record<"NS" | "NSS" | "US" | "SDEU", string> = {
  NS: "ns_search",
  NSS: "nss_search",
  US: "us_search",
  SDEU: "sdeu_search",
};

/**
 * "oficiální text: ns_search {case_number: …}" for every spisová značka in
 * `text` (at most `max`), routed by the court its registry belongs to; a
 * lower court's značka goes to justice_search. The display comes from the
 * parsed parts, never from the raw text. Pure.
 */
export function officialTextLines(text: string, max = MAX_OFFICIAL_PER_HIT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const span of findIdentSpans(text)) {
    for (const key of span.keys) {
      if (!key.startsWith("sz:")) continue;
      const c = canonicalCaseNumber(key);
      if (!c || seen.has(c.display)) continue;
      seen.add(c.display);
      const tool = c.court ? OFFICIAL_TOOL[c.court] : "justice_search";
      out.push(`oficiální text: ${tool} {case_number: ${JSON.stringify(sanitizeLine(c.display, 40))}}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}
