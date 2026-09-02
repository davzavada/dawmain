/**
 * One bibliographic hit, whichever library catalogue it came from. The
 * doctrine search fans out to two discovery systems that describe the same
 * kind of thing — a book, a chapter, a journal article — so they share one
 * shape; each source client maps its own record format onto it, and the tool
 * renders it once.
 */
export interface BibHit {
  /** "peacepalace" | "cuni" — which catalogue produced the record. */
  source: "peacepalace" | "cuni";
  /** OCLC number (Peace Palace) or Primo record id (UKAŽ). */
  id: string;
  title: string;
  authors: string[];
  year?: string;
  publisher?: string;
  /** Catalogue's own form label: "eBook", "Book", "Article", "book_chapter"… */
  type?: string;
  /** MARC/ISO 639-2 code as the catalogue reports it: "eng", "cze", "ger". */
  language?: string;
  isbn?: string[];
  issn?: string[];
  doi?: string[];
  /** Journal or host publication of an article/chapter, with volume/pages. */
  container?: string;
  subjects?: string[];
  /** Abstract or summary, trimmed to a snippet. */
  abstract?: string;
  /** Table of contents, trimmed to a snippet. */
  contents?: string;
  open_access?: boolean;
  /** Where a human sees the catalogue record itself. */
  url: string | null;
  /** Access links the record carries (publisher page, DOI, proxy…). Capped. */
  links?: string[];
}

/**
 * Dedupe key across query variants of ONE source: the record id when the
 * catalogue gave one, else DOI, else title + year + first author. Two catalogues are never
 * deduped against each other — the same book held by both is two verifiable
 * records, and the reader may want either library's copy. Pure.
 */
export function bibKey(hit: BibHit): string {
  if (hit.id) return `${hit.source}:${hit.id}`;
  const doi = hit.doi?.[0]?.toLowerCase();
  if (doi) return `${hit.source}:doi:${doi}`;
  return `${hit.source}:${hit.title.toLowerCase().replace(/\s+/g, " ").trim()}|${hit.year ?? ""}|${hit.authors[0]?.toLowerCase() ?? ""}`;
}

/** Author list for a citation line: up to `max` names, "et al." beyond. Pure. */
export function formatAuthors(authors: string[], max = 3): string {
  if (!authors.length) return "";
  const shown = authors.slice(0, max).join(", ");
  return authors.length > max ? `${shown} et al.` : shown;
}

export interface PageWindow {
  /** 0-based index of the first hit the caller asked for. */
  start: number;
  /** Exclusive end. */
  end: number;
  /** 1-based catalogue pages that together cover [start, end). */
  upstreamPages: number[];
  /** 0-based offset of the first hit of the first upstream page. */
  firstOffset: number;
}

/**
 * Which catalogue pages a tool page maps onto. Both catalogues serve fixed
 * pages of `pageSize`; a caller asking for 30 hits per source, page 2, wants
 * hits 30–59 — catalogue pages 4, 5 and 6. Pure — unit-tested.
 */
export function pageWindow(page: number, limit: number, pageSize: number): PageWindow {
  const start = (Math.max(1, page) - 1) * limit;
  const end = start + limit;
  const firstPage = Math.floor(start / pageSize) + 1;
  const lastPage = Math.ceil(end / pageSize);
  const upstreamPages: number[] = [];
  for (let p = firstPage; p <= lastPage; p++) upstreamPages.push(p);
  return { start, end, upstreamPages, firstOffset: (firstPage - 1) * pageSize };
}

/** Hits of the fetched upstream pages, concatenated in order, cut to the
 * window. Pure — unit-tested. */
export function sliceWindow<T>(concatenated: T[], window: PageWindow): T[] {
  return concatenated.slice(window.start - window.firstOffset, window.end - window.firstOffset);
}
