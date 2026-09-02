/**
 * One bibliographic hit — a book, a chapter, a journal article — in the shape
 * the doctrine tools render. The source client maps its record format onto
 * it; the shape is catalogue-neutral so a further library can be added
 * without touching the tool.
 */
export interface BibHit {
  /** Which catalogue produced the record. Only UKAŽ today. */
  source: "cuni";
  /** Primo record id (`alma…` for the UK catalogue, `cdi_…` for the CDI). */
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
 * Dedupe key across query variants of one source: the record id when the
 * catalogue gave one, else DOI, else title + year + first author. The key
 * is prefixed by the source, so two catalogues would never be deduped
 * against each other — the same book held by both is two verifiable
 * records. Pure.
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
 * Which catalogue pages a tool page maps onto. The catalogue serves fixed
 * pages of `pageSize`; a caller asking for 30 hits, page 2, wants hits
 * 30–59 — catalogue pages 4, 5 and 6. Pure — unit-tested.
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
