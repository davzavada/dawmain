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

/** Title for comparison: lowercase, punctuation and spacing folded. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How much citation data a record carries — the richer copy is kept. */
function richness(hit: BibHit): number {
  return [hit.authors.length > 0, hit.year, hit.abstract, hit.container, hit.subjects?.length].filter(Boolean).length;
}

/** Access links a merged copy contributes: its own, then its record page. */
const MERGED_LINKS_CAP = 3;

/**
 * Same-page duplicates under different record ids. The Central Discovery
 * Index serves one article from several collections — live, "genocide"
 * (cze) put cdi_unpaywall_…_cl_2024_1_03 (no author, no year, an OA PDF
 * link) and cdi_crossref_…_CL_2024_1_03 (full metadata and abstract) on one
 * page, DOIs differing only in case. Two hits merge only when the DOI
 * matches case-insensitively AND the titles agree (equal, or one a prefix
 * of the other) — a chapter may repeat its book's DOI. The richer copy is
 * kept with its id and url (so doctrine_get_record opens the full record),
 * at the rank of the group's first occurrence; the other fills what it
 * lacks and contributes its access links and record page. Pure.
 */
export function mergeDoiDuplicates(hits: BibHit[]): BibHit[] {
  const out: BibHit[] = [];
  for (const hit of hits) {
    const doi = hit.doi?.[0]?.toLowerCase();
    const title = titleKey(hit.title);
    const at = doi
      ? out.findIndex((kept) => {
          if (kept.doi?.[0]?.toLowerCase() !== doi) return false;
          const other = titleKey(kept.title);
          return Boolean(title && other) && (title.startsWith(other) || other.startsWith(title));
        })
      : -1;
    if (at < 0) {
      out.push(hit);
      continue;
    }
    const kept = out[at];
    const [primary, secondary] = richness(hit) > richness(kept) ? [hit, kept] : [kept, hit];
    const links = [...(primary.links ?? [])];
    for (const url of [...(secondary.links ?? []), ...(secondary.url ? [secondary.url] : [])]) {
      if (links.length >= (primary.links?.length ?? 0) + MERGED_LINKS_CAP) break;
      if (!links.includes(url)) links.push(url);
    }
    out[at] = {
      ...primary,
      authors: primary.authors.length ? primary.authors : secondary.authors,
      year: primary.year ?? secondary.year,
      publisher: primary.publisher ?? secondary.publisher,
      type: primary.type ?? secondary.type,
      language: primary.language ?? secondary.language,
      isbn: primary.isbn?.length ? primary.isbn : secondary.isbn,
      issn: primary.issn?.length ? primary.issn : secondary.issn,
      container: primary.container ?? secondary.container,
      subjects: primary.subjects?.length ? primary.subjects : secondary.subjects,
      abstract: primary.abstract ?? secondary.abstract,
      contents: primary.contents ?? secondary.contents,
      open_access: primary.open_access || secondary.open_access || undefined,
      links: links.length ? links : undefined,
    };
  }
  return out;
}
