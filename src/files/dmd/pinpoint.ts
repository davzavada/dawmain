/**
 * Citation pinpoints and the ČSN ISO 690 reference line for uploaded
 * documents (plan §6). A pinpoint is derived from the OFFSET of a match —
 * its page, the marginal number of its paragraph, the footnote it falls in
 * — so it points at what was actually found, in the form a Czech lawyer
 * cites that kind of work:
 *
 *   kniha / kapitola / jiné   s. 245 · s. 245–246 · s. 245, pozn. 12
 *   komentář                  § 2913, m. č. 14, s. 1245 · § 2913, m. č. 14, pozn. 123 (s. 1245)
 *   článek                    s. 419 · s. 419, pozn. 7
 *   vzor                      čl. III odst. 2
 *   rozhodnutí                bod 24, s. 5
 *
 * Physical page numbers (no printed ones found) get " [strana PDF]";
 * unpaged documents (DOCX, TXT) cite by section only. Czech typography:
 * en dash in ranges, "s." and "pozn.". Isomorphic and pure — unit-tested.
 */

import { sanitizeLine } from "./normalize";
import type { AnchorLabel, BibMeta, DocType } from "../types";

export interface PinpointLoc {
  pageFrom?: string | null;
  pageTo?: string | null;
  /** Page labels are physical PDF pages (label_source "physical") → " [strana PDF]". */
  physicalPages?: boolean;
  section?: { key: string | null; heading: string; author?: string | null } | null;
  anchor?: string | null;
  anchorLabel?: AnchorLabel | null;
  footnote?: { label: string; page?: string | null } | null;
  /** vzor: "odst. 2". */
  clause?: string | null;
}

const PHYSICAL = " [strana PDF]";

function clip(s: string | null | undefined, max = 60): string | null {
  const line = sanitizeLine(s ?? "", max);
  return line ? line : null;
}

/** "s. 245", "s. 245–246", with the physical-page suffix; null when there is no page. */
function pageRef(from: string | null | undefined, to: string | null | undefined, physical: boolean | undefined): string | null {
  const a = clip(from, 20);
  if (!a) return null;
  const b = clip(to, 20);
  const range = b && b !== a ? `s. ${a}–${b}` : `s. ${a}`;
  return physical ? `${range}${PHYSICAL}` : range;
}

/** "§ 2913a", "čl. III", "kap. 3", else the heading in Czech quotes. */
export function sectionRef(section: PinpointLoc["section"]): string | null {
  if (!section) return null;
  const key = section.key ?? "";
  const m = /^(par|cl|ch):(.{1,16})$/.exec(key);
  if (m) {
    const value = clip(m[2], 16);
    if (value) return m[1] === "par" ? `§ ${value}` : m[1] === "cl" ? `čl. ${value}` : `kap. ${value}`;
  }
  const heading = clip(section.heading, 80);
  return heading ? `„${heading}“` : null;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join(", ");
}

/**
 * Per-type pinpoint (plan §6). `loc.footnote.page` is the page the note is
 * printed on (defaults to `pageFrom`). Returns "" when nothing locates the
 * match. Pure.
 */
export function pinpoint(docType: DocType | null, loc: PinpointLoc): string {
  const pages = pageRef(loc.pageFrom, loc.pageTo, loc.physicalPages);
  const fnLabel = loc.footnote ? clip(loc.footnote.label, 12) : null;
  const note = fnLabel ? `pozn. ${fnLabel}` : null;
  const notePage = loc.footnote ? pageRef(loc.footnote.page ?? loc.pageFrom, null, loc.physicalPages) : null;
  const section = sectionRef(loc.section);
  const anchorValue = clip(loc.anchor, 16);

  switch (docType) {
    case "komentar": {
      const anchor = anchorValue ? `${loc.anchorLabel ?? "m. č."} ${anchorValue}` : null;
      if (note) return joinParts([section, anchor, notePage ? `${note} (${notePage})` : note]);
      return joinParts([section, anchor, pages]);
    }
    case "vzor": {
      const clause = clip(loc.clause, 30);
      const base = section && clause ? `${section} ${clause}` : (section ?? clause);
      if (!base) return joinParts([pages, note]);
      return joinParts([base, note]);
    }
    case "rozhodnuti": {
      const anchor = anchorValue ? `${loc.anchorLabel ?? "bod"} ${anchorValue}` : null;
      return joinParts([anchor, pages, note]);
    }
    default: {
      // kniha, kapitola, clanek, jine, unknown type.
      if (pages || notePage) return note ? joinParts([notePage ?? pages, note]) : pages!;
      const anchor = anchorValue ? `${loc.anchorLabel ?? "m. č."} ${anchorValue}` : null;
      return joinParts([section, anchor, note]);
    }
  }
}

// ─────────────────────────────────────────────────────────────── ČSN ISO 690

const TITLE_TOKEN_RE =
  /^(?:prof|doc|judr|phdr|mgr|bc|ing|mudr|rndr|paeddr|thdr|thlic|icdr|dr|jud|phd|ph\.d|csc|drsc|dsc|ll\.?m|llm|mba|msc|ma|ba|bsc|dipl|arch|et|dr\.h\.c|dr\. h\. c)\.?,?$/i;
const PARTICLES = new Set(["van", "von", "de", "der", "den", "di", "da", "la", "le", "du", "dos", "del", "ten", "ter", "zu"]);

function upper(s: string): string {
  return s.toLocaleUpperCase("cs");
}

/** "Jan-Pavel" → "J.-P.", "J." stays. */
function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .filter(Boolean)
        .map((part) => `${Array.from(part)[0]}.`)
        .join("-"),
    )
    .join(" ");
}

/**
 * One personal name in ČSN ISO 690 form: "SURNAME, G." — from "Given
 * Surname" or "Surname, Given"; academic titles dropped; a single word is
 * taken as the surname. Pure.
 */
export function formatPersonName(name: string): string {
  const cleaned = sanitizeLine(name, 120)
    .split(/\s+/)
    .filter((token) => !TITLE_TOKEN_RE.test(token))
    .join(" ")
    .replace(/^[,\s]+|[,\s]+$/g, "");
  if (!cleaned) return "";
  const comma = cleaned.indexOf(",");
  let surname: string;
  let given: string;
  if (comma !== -1) {
    surname = cleaned.slice(0, comma).trim();
    given = cleaned.slice(comma + 1).replace(/,/g, " ").trim();
  } else {
    const tokens = cleaned.split(" ");
    let i = tokens.length - 1;
    while (i > 0 && PARTICLES.has(tokens[i - 1].toLowerCase())) i--;
    surname = tokens.slice(i).join(" ");
    given = tokens.slice(0, i).join(" ");
  }
  if (!surname) return upper(given);
  return given ? `${upper(surname)}, ${initials(given)}` : upper(surname);
}

/** Names for the head of a reference: ≤ 3, then " a kol."; `collective` always adds " a kol.". */
function formatNames(names: string[], opts: { collective?: boolean } = {}): string {
  const formatted = names.map(formatPersonName).filter(Boolean);
  if (!formatted.length) return "";
  const shown = formatted.slice(0, 3).join(", ");
  return formatted.length > 3 || opts.collective ? `${shown} a kol.` : shown;
}

/** Terminate a reference element with a period unless it already ends in punctuation. */
function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function field(s: string | null | undefined, max = 300): string | null {
  if (s === null || s === undefined) return null;
  const line = sanitizeLine(String(s), max);
  return line ? line : null;
}

function editionPart(edition: string | null | undefined): string | null {
  const e = field(edition, 40);
  if (!e) return null;
  if (/vyd/i.test(e)) return e;
  const num = /^(\d{1,3})\.?$/.exec(e);
  if (num) return num[1] === "1" ? null : `${num[1]}. vyd.`;
  return `${e} vyd.`;
}

function imprint(meta: Pick<Partial<BibMeta>, "place" | "publisher" | "year">, pagesRange?: string | null): string | null {
  const place = field(meta.place, 60);
  const publisher = field(meta.publisher, 120);
  const year = meta.year ? String(meta.year) : null;
  let out = place && publisher ? `${place}: ${publisher}` : (publisher ?? place ?? "");
  if (year) out = out ? `${out}, ${year}` : year;
  if (pagesRange) out = out ? `${out}, ${pagesRange}` : pagesRange;
  return out || null;
}

function pagesRangePart(range: string | null | undefined): string | null {
  const r = field(range, 30);
  return r ? `s. ${r.replace(/\s*[-‒–—]\s*/g, "–")}` : null;
}

function titlePart(meta: { title: string | null; subtitle?: string | null }): string {
  const title = field(meta.title) ?? "[bez názvu]";
  const subtitle = field(meta.subtitle);
  return subtitle ? `${title}: ${subtitle}` : title;
}

function czechDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : null;
}

function isbnPart(meta: Pick<Partial<BibMeta>, "isbn">): string | null {
  const isbn = field(meta.isbn?.[0], 20);
  return isbn ? `ISBN ${isbn}` : null;
}

function assemble(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim() !== "")
    .map(sentence)
    .join(" ");
}

/**
 * ČSN ISO 690-style reference line from the (confirmed) metadata:
 *   kniha      PETROV, J., VÝTISK, M. Title: subtitle. 2. vyd. Praha: C. H. Beck, 2019. ISBN ….
 *   kapitola   AUTHOR, A. Chapter. In: EDITOR, E. (ed.). Book. Praha: Leges, 2020, s. 17–40. ISBN ….
 *   článek     AUTHOR, A. Title. Právní rozhledy. 2019, roč. 27, č. 12, s. 417–425. DOI ….
 *   komentář   [SECTION AUTHOR, S. In:] PETROV, J. a kol. Občanský zákoník. Komentář. 2. vyd. …
 *   vzor       AUTHOR, A. Title [vzor]. Publisher, 2021.
 *   rozhodnutí Nejvyšší soud. Title. Ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019. ECLI:….
 * Surnames are uppercased with the given names as initials. Every value is
 * sanitized to one line (the result still belongs inside the fence). The
 * optional `sectionAuthor` (explicit "Zpracoval:" of a commentary section,
 * shown only once confirmed) prefixes a commentary as "MELZER, F. In: …".
 * Pure.
 */
export function citationLine(
  meta: Omit<Partial<BibMeta>, "doc_type" | "title"> & { doc_type: DocType | null; title: string | null },
  opts: { sectionAuthor?: string | null } = {},
): string {
  const authors = meta.authors ?? [];
  const editors = meta.editors ?? [];
  const title = titlePart(meta);

  switch (meta.doc_type) {
    case "kapitola": {
      const editorNames = formatNames(editors);
      const host = field(meta.container_title);
      const inPart = host || editorNames
        ? `In: ${[editorNames ? `${editorNames} (${editors.length > 1 ? "eds." : "ed."})` : null, host]
            .filter(Boolean)
            .map((p) => sentence(p!))
            .join(" ")}`
        : null;
      return assemble([
        formatNames(authors),
        title,
        inPart,
        editionPart(meta.edition),
        imprint(meta, pagesRangePart(meta.pages_range)),
        isbnPart(meta),
      ]);
    }
    case "clanek": {
      const issue = [
        meta.year ? String(meta.year) : null,
        field(meta.volume, 20) ? `roč. ${field(meta.volume, 20)}` : null,
        field(meta.issue, 20) ? `č. ${field(meta.issue, 20)}` : null,
        pagesRangePart(meta.pages_range),
      ].filter(Boolean);
      const doi = field(meta.doi, 120);
      const issn = field(meta.issn, 20);
      return assemble([
        formatNames(authors),
        title,
        field(meta.container_title),
        issue.length ? issue.join(", ") : null,
        issn ? `ISSN ${issn}` : null,
        doi ? `DOI: ${doi}` : null,
      ]);
    }
    case "komentar": {
      const useEditors = editors.length > 0;
      const names = formatNames(useEditors ? editors : authors, { collective: useEditors });
      const sectionAuthor = opts.sectionAuthor ? formatPersonName(opts.sectionAuthor) : "";
      const head = sectionAuthor ? `${sentence(sectionAuthor)} In: ${names || "[b. a.]"}` : names;
      const hasKomentar = /koment[aá]ř/i.test(`${meta.title ?? ""} ${meta.subtitle ?? ""}`);
      return assemble([
        head,
        title,
        hasKomentar ? null : "Komentář",
        editionPart(meta.edition),
        imprint(meta),
        isbnPart(meta),
      ]);
    }
    case "vzor":
      return assemble([formatNames(authors), `${title} [vzor]`, imprint(meta)]);
    case "rozhodnuti": {
      const court = field(meta.court, 120);
      const date = czechDate(meta.decided_on);
      const caseNumber = field(meta.case_number, 60);
      const when = [date ? `Ze dne ${date}` : null, caseNumber ? `sp. zn. ${caseNumber}` : null].filter(Boolean).join(", ");
      const decisionTitle = field(meta.title);
      return assemble([court, decisionTitle && decisionTitle !== court ? titlePart(meta) : null, when || null, field(meta.ecli, 80)]);
    }
    default: {
      // kniha, jine, unknown: authors, else editors "(ed.)".
      const head = authors.length
        ? formatNames(authors)
        : editors.length
          ? `${formatNames(editors)} (${editors.length > 1 ? "eds." : "ed."})`
          : null;
      return assemble([head, title, editionPart(meta.edition), imprint(meta), field(meta.series, 120), isbnPart(meta)]);
    }
  }
}
