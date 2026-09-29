import { ITEM_KEY_RE } from "./config";
import type { SavedSearchCondition } from "./types";

/**
 * A Zotero saved search as a Web API query. The API stores saved searches
 * but never runs them (GET /searches returns only the conditions), so
 * zotero_search translates what the /items parameters can express and names
 * the rest:
 *
 *   applied      exactly: itemType is / is not, tag is / is not, collection
 *                is, subcollections (recursive);
 *   approximate  as a looser Zotero quick search, so the results are a
 *                superset: title / creator / year / quick search "contains"
 *                → q in title mode (which also matches creators, years and a
 *                note's first line), full-text and all-fields quick searches
 *                → q in everything mode;
 *   skipped      everything else (dates, other fields, notes, annotations,
 *                another saved search, display options) — not applied.
 *
 * "Match any" can only be expressed for a list of item types or of tags
 * (Zotero's " || "); any other mix under "any" is not translated at all.
 * Pure — no I/O.
 */

export interface SearchTranslation {
  /** Words for q (every one must match). */
  words: string[];
  /** q needs everything mode (a full-text or all-fields condition). */
  everything: boolean;
  /** ItemsQuery.itemTypes: all included or all excluded ("-note"). */
  itemTypes: string[];
  /** ItemsQuery.tags: each entry its own parameter (AND); " || " inside one is OR, a leading "-" is NOT. */
  tags: string[];
  collection: string | null;
  recursive: boolean;
  /** "condition operator" of each condition, by how it was used — Zotero's own vocabulary, validated. */
  applied: string[];
  approximate: string[];
  skipped: string[];
  /** The search joins its conditions with "any". */
  anyMode: boolean;
}

/** Conditions that are display or scope options, not conditions on an item. */
const OPTIONS = new Set(["joinMode", "recursive", "noChildren", "includeParentsAndChildren", "includeParents", "includeChildren", "deleted"]);
const TITLE_LIKE = new Set(["title", "creator", "lastName", "year", "quicksearch-titleCreatorYear", "quicksearch-titleCreatorYearNote"]);
const EVERYTHING_LIKE = new Set(["quicksearch-everything", "quicksearch-fields", "fulltextContent", "anyField"]);

/** "tag is" — Zotero's own names; anything else prints as "?". */
export function conditionLabel(c: Pick<SavedSearchCondition, "condition" | "operator">): string {
  const name = /^[A-Za-z][A-Za-z-]{0,39}$/.test(c.condition) ? c.condition : "?";
  const op = /^[A-Za-z]{1,20}$/.test(c.operator) ? c.operator : "?";
  return `${name} ${op}`;
}

/** A collection condition's value: the key, possibly with the "C" prefix older clients store. */
function collectionKey(value: string): string | null {
  const v = value.trim();
  if (ITEM_KEY_RE.test(v)) return v;
  if (v.length === 9 && v.startsWith("C") && ITEM_KEY_RE.test(v.slice(1))) return v.slice(1);
  return null;
}

function words(value: string): string[] {
  return value
    .replace(/["„“”]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** A tag as a `tag` parameter value: a leading "-" of the tag itself is escaped (Zotero reads it as NOT). */
function tagParam(tag: string, negate: boolean): string {
  const t = tag.trim();
  return negate ? `-${t}` : t.startsWith("-") ? `\\${t}` : t;
}

export function translateSavedSearch(conditions: SavedSearchCondition[]): SearchTranslation {
  const out: SearchTranslation = {
    words: [],
    everything: false,
    itemTypes: [],
    tags: [],
    collection: null,
    recursive: false,
    applied: [],
    approximate: [],
    skipped: [],
    anyMode: false,
  };
  for (const c of conditions) {
    if (c.condition === "joinMode") out.anyMode = c.value.trim() === "any";
    if (c.condition === "recursive" && c.value.trim() === "true") out.recursive = true;
  }
  const real = conditions.filter((c) => !OPTIONS.has(c.condition));
  for (const c of conditions) {
    if (!OPTIONS.has(c.condition) || c.condition === "joinMode" || c.condition === "recursive") continue;
    // "deleted" false is the default (the trash is never searched); other options change what is shown.
    if (c.condition === "deleted" && c.value.trim() !== "true") continue;
    out.skipped.push(conditionLabel(c));
  }

  if (out.anyMode && real.length > 1) {
    // Only a list of item types or of tags can be OR-ed through the API.
    const allTypes = real.every((c) => c.condition === "itemType" && c.operator === "is" && /^[A-Za-z]{1,40}$/.test(c.value.trim()));
    const allTags = real.every((c) => c.condition === "tag" && c.operator === "is" && c.value.trim() && !c.value.includes("||"));
    if (allTypes) {
      out.itemTypes = [...new Set(real.map((c) => c.value.trim()))];
      out.applied.push(...real.map(conditionLabel));
    } else if (allTags) {
      out.tags = [real.map((c) => tagParam(c.value, false)).join(" || ")];
      out.applied.push(...real.map(conditionLabel));
    } else {
      out.skipped.push(...real.map(conditionLabel));
    }
    return out;
  }

  let typesNegated: boolean | null = null;
  for (const c of real) {
    const label = conditionLabel(c);
    const value = c.value.trim();
    const op = c.operator;
    if (c.condition === "itemType" && (op === "is" || op === "isNot") && /^[A-Za-z]{1,40}$/.test(value)) {
      const negate = op === "isNot";
      // Zotero negates the whole list or nothing; two positive types under "all" would match nothing.
      if ((typesNegated !== null && typesNegated !== negate) || (!negate && out.itemTypes.length)) {
        out.skipped.push(label);
        continue;
      }
      typesNegated = negate;
      out.itemTypes.push(negate ? `-${value}` : value);
      out.applied.push(label);
    } else if (c.condition === "tag" && (op === "is" || op === "isNot") && value && !value.includes("||")) {
      out.tags.push(tagParam(value, op === "isNot"));
      out.applied.push(label);
    } else if (c.condition === "collection" && op === "is" && collectionKey(value) && !out.collection) {
      out.collection = collectionKey(value);
      out.applied.push(label);
    } else if ((TITLE_LIKE.has(c.condition) || EVERYTHING_LIKE.has(c.condition)) && (op === "contains" || op === "is") && words(value).length) {
      out.words.push(...words(value));
      if (EVERYTHING_LIKE.has(c.condition)) out.everything = true;
      out.approximate.push(label);
    } else {
      out.skipped.push(label);
    }
  }
  if (out.recursive && out.collection) out.applied.push("recursive true");
  return out;
}
