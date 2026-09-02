import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { WORLDCAT_PAGE_SIZE, getWorldcatRecord, searchWorldcat } from "@/src/sources/worldcat";
import { PRIMO_PAGE_SIZE, getPrimoRecord, searchPrimo } from "@/src/sources/primo";
import {
  fetchDocumentText,
  orderCandidates,
  resolveOpenAccess,
  type FetchedDocument,
  type OaResolution,
  type TextCandidate,
} from "@/src/sources/fulltext";
import { SourceError } from "@/src/sources/shared/errors";
import { bibKey, formatAuthors, pageWindow, sliceWindow, type BibHit } from "@/src/sources/shared/bib";
import { dedupeBy, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { withDeadline } from "./previews";
import { FIND_DESCRIPTION, READING_DESCRIPTION, READ_ONLY, continuationHint, toolFailure } from "./shared";

/**
 * Doctrine — the literature: books, chapters and journal articles, searched
 * in two library discovery systems in parallel (the same fan-out shape as
 * cz_caselaw_search). Each catalogue serves fixed pages of 10, so a request
 * for 30 hits pulls three catalogue pages per source in one parallel batch;
 * `page` then walks further — the flag the user raised: these databases
 * answer with thousands of records, and the reader must be able to keep
 * going. Nothing here has a *_get_* companion: a catalogue record IS the
 * result (with its abstract and contents where the record carries them),
 * and the link opens the record for the reader.
 */

const SOURCES = ["peacepalace", "cuni"] as const;
type SourceId = (typeof SOURCES)[number];
const LABELS: Record<SourceId, string> = {
  peacepalace: "Peace Palace Library (WorldCat)",
  cuni: "UKAŽ (Univerzita Karlova)",
};
const PER_SOURCE_DEADLINE_MS = 25_000;
/** Catalogue pages requested at once per source and variant. */
const PAGE_BATCH = 5;

interface SourceStatus {
  source: SourceId;
  ok: boolean;
  total: number | null;
  has_more: boolean;
  note?: string;
  error?: string;
}

interface RunnerResult {
  total: number | null;
  hits: BibHit[];
  note?: string;
}

interface Criteria {
  title?: string;
  author?: string;
  subject?: string;
  language?: string;
  yearFrom?: number;
  yearTo?: number;
  fullTextOnly?: boolean;
}

/** Fetch every catalogue page of one variant, in small parallel batches, in order. */
async function fetchPages<T>(pages: number[], load: (page: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < pages.length; i += PAGE_BATCH) {
    out.push(...(await Promise.all(pages.slice(i, i + PAGE_BATCH).map(load))));
  }
  return out;
}

/**
 * Above this many hits per source the page switches to brief records — no
 * abstract, contents, subjects or access links, in the text AND in the
 * structured items. Measured: 2 × 10 full records ≈ 21k characters of text
 * plus as much again in structuredContent, right at the response budget
 * (see DOC_PAGE_CHARS); 2 × 30 full records reached 62k of text alone and
 * would have been rejected whole by the client.
 */
export const FULL_DETAIL_LIMIT = 10;

/** The record without its bulky optional parts. Pure. */
export function briefHit(hit: BibHit): BibHit {
  const { abstract: _abstract, contents: _contents, subjects: _subjects, links: _links, ...rest } = hit;
  return rest;
}

/** Citation-style line for one hit; the structured record carries the rest.
 * `index` numbers a list entry; the record view passes none. */
function renderHit(hit: BibHit, index?: number): string {
  const head = [
    formatAuthors(hit.authors),
    hit.year ? `(${hit.year})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const ids = [
    hit.isbn?.length ? `ISBN ${hit.isbn[0]}` : "",
    hit.issn?.length ? `ISSN ${hit.issn[0]}` : "",
    hit.doi?.length ? `DOI ${hit.doi[0]}` : "",
  ].filter(Boolean);
  const tags = [hit.type, hit.language, hit.open_access ? "open access" : ""].filter(Boolean);
  const lines = [
    `${index === undefined ? "" : `${index}. `}${head ? `${head}. ` : ""}${hit.title}.${hit.container ? ` In: ${hit.container}.` : ""}${hit.publisher ? ` ${hit.publisher}` : ""}${tags.length ? ` [${tags.join(", ")}]` : ""}${ids.length ? ` ${ids.join(" · ")}` : ""}`,
  ];
  if (hit.subjects?.length) lines.push(`   Subjects: ${hit.subjects.slice(0, 6).join("; ")}`);
  if (hit.abstract) lines.push(`   Abstract: ${hit.abstract}`);
  if (hit.contents) lines.push(`   Contents: ${hit.contents}`);
  if (hit.url) lines.push(`   ${hit.url}`);
  if (hit.links?.length) lines.push(`   access: ${hit.links.join(" | ")}`);
  return lines.join("\n");
}

const bibItemSchema = z.object({
  source: z.enum(SOURCES),
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.string().optional(),
  publisher: z.string().optional(),
  type: z.string().optional(),
  language: z.string().optional(),
  isbn: z.array(z.string()).optional(),
  issn: z.array(z.string()).optional(),
  doi: z.array(z.string()).optional(),
  container: z.string().optional(),
  subjects: z.array(z.string()).optional(),
  abstract: z.string().optional(),
  contents: z.string().optional(),
  open_access: z.boolean().optional(),
  url: z.string().nullable(),
  links: z.array(z.string()).optional(),
});

/** Wall-clock the document tool may spend trying copies; the function has 60 s. */
const READ_BUDGET_MS = 45_000;
const PER_COPY_MS = 25_000;
const MAX_COPIES_TRIED = 3;

interface TriedCopy extends TextCandidate {
  outcome: string;
}

/**
 * Try the candidate copies in order until one yields text. Every failure is
 * kept with its reason — "licensed" is a finding the reader needs, not noise.
 */
async function readFirstCopy(
  candidates: TextCandidate[],
  started: number,
): Promise<{ document?: FetchedDocument; tried: TriedCopy[]; exhausted: boolean }> {
  const tried: TriedCopy[] = [];
  for (const candidate of candidates.slice(0, MAX_COPIES_TRIED)) {
    const left = READ_BUDGET_MS - (Date.now() - started);
    if (left < 5_000) return { tried, exhausted: false };
    try {
      const document = await withDeadline(fetchDocumentText(candidate.url), Math.min(PER_COPY_MS, left));
      return { document, tried: [...tried, { ...candidate, outcome: `read (${document.kind})` }], exhausted: false };
    } catch (error) {
      const message = error instanceof SourceError ? error.message : error instanceof Error ? error.message : String(error);
      tried.push({ ...candidate, outcome: message });
    }
  }
  return { tried, exhausted: tried.length >= Math.min(MAX_COPIES_TRIED, candidates.length) };
}

const failDocument = toolFailure("doctrine");

export function registerDoctrine(server: McpServer): void {
  server.registerTool(
    "doctrine_search",
    {
      title: "Doctrine: search the literature in two law libraries",
      description:
        "LITERATURE search — books, chapters and journal articles — in two library discovery systems in parallel: the Peace Palace Library in The Hague (WorldCat Discovery: WorldCat.org plus the library's licensed law collections — Nomos, Brill, Kluwer Law Online, OUP Law, Cambridge journals, Springer, Elgar) and Univerzita Karlova's UKAŽ (Primo: the UK catalogue plus the Central Discovery Index of licensed e-resources). Criteria combine with AND: query (keywords anywhere), title, author, subject, language (cze/eng/ger/fre), year_from/year_to; 'queries' runs up to 3 keyword variants in parallel (Czech for UKAŽ, English for the Peace Palace). These catalogues answer with thousands of records: per_source_limit (up to 20; above 10 the records come brief, without abstracts) pulls several catalogue pages at once and page walks further — has_more and total per source say how far the list goes. Results are bibliographic records with the record's own link and, where the record carries them, abstract, contents and access links; there is NO full text to fetch here — cite the literature by author, title, year and the record link.",
      inputSchema: z.object({
        query: z.string().min(2).optional().describe("Keywords anywhere in the record (title, subject, abstract, contents)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 keyword variants searched in parallel and merged (Czech/English terms, synonyms)."),
        title: z.string().min(2).optional().describe("Words from the title."),
        author: z.string().min(2).optional().describe("Author or editor name — surname is enough."),
        subject: z.string().min(2).optional().describe("Subject heading words (LCSH / Czech subject headings)."),
        language: z
          .string()
          .regex(/^[a-z]{3}$/i, "Use a 3-letter code: cze, eng, ger, fre")
          .optional()
          .describe("Language of the work as a 3-letter code: cze, eng, ger, fre, slo."),
        year_from: z.number().int().min(1500).max(2100).optional().describe("Publication year from (inclusive)."),
        year_to: z.number().int().min(1500).max(2100).optional().describe("Publication year to (inclusive)."),
        full_text_only: z
          .boolean()
          .default(false)
          .describe("Peace Palace only: restrict to records whose full text the library can open (the 'Full Text' facet). UKAŽ ignores it."),
        sources: z
          .array(z.enum(SOURCES))
          .optional()
          .describe("Restrict to one catalogue. Default: both."),
        per_source_limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe(
            `Hits per catalogue per page (max 20). Up to ${FULL_DETAIL_LIMIT}: full records with abstract/contents; above that the page comes as a brief list (author, year, title, container, link) so it fits the response — the bibliography mode.`,
          ),
        page: z.number().int().min(1).default(1).describe("1-based page of per_source_limit hits, per catalogue."),
      }),
      outputSchema: z.object({
        variants: z.array(z.string()),
        page: z.number(),
        per_source_limit: z.number(),
        statuses: z.array(
          z.object({
            source: z.enum(SOURCES),
            ok: z.boolean(),
            total: z.number().nullable(),
            has_more: z.boolean(),
            note: z.string().optional(),
            error: z.string().optional(),
          }),
        ),
        items: z.array(bibItemSchema),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, queries, title, author, subject, language, year_from, year_to, full_text_only, sources, per_source_limit, page }) => {
      const variants = uniqueQueries(query, queries);
      if (!variants.length && !title && !author && !subject) {
        return {
          content: [
            {
              type: "text",
              text: "Provide at least one of query/queries (keywords), title, author or subject — language and years alone cannot drive a catalogue search.",
            },
          ],
          isError: true,
        };
      }
      if (year_from && year_to && year_from > year_to) {
        return {
          content: [{ type: "text", text: "year_from must not exceed year_to." }],
          isError: true,
        };
      }
      const criteria: Criteria = {
        title,
        author,
        subject,
        language,
        yearFrom: year_from,
        yearTo: year_to,
        fullTextOnly: full_text_only,
      };
      const active: SourceId[] = sources?.length ? SOURCES.filter((s) => sources.includes(s)) : [...SOURCES];
      // Field-only searches (author + subject, no keywords) run once.
      const keywordVariants: Array<string | undefined> = variants.length ? variants : [undefined];

      const runners: Record<SourceId, () => Promise<RunnerResult>> = {
        peacepalace: async () => {
          const window = pageWindow(page, per_source_limit, WORLDCAT_PAGE_SIZE);
          const perVariant = await Promise.all(
            keywordVariants.map(async (variant) => {
              const pages = await fetchPages(window.upstreamPages, (p) =>
                searchWorldcat({ query: variant, ...criteria }, p),
              );
              return {
                total: pages[0]?.total ?? null,
                partial: pages.some((p) => p.partial),
                hits: sliceWindow(
                  pages.flatMap((p) => p.hits),
                  window,
                ),
              };
            }),
          );
          const partial = perVariant.some((v) => v.partial);
          return {
            total: maxTotal(perVariant.map((v) => v.total)),
            hits: dedupeBy(
              perVariant.flatMap((v) => v.hits),
              bibKey,
            ).slice(0, per_source_limit),
            ...(partial ? { note: "partial result — one of the library's databases did not answer upstream" } : {}),
          };
        },
        cuni: async () => {
          const window = pageWindow(page, per_source_limit, PRIMO_PAGE_SIZE);
          const perVariant = await Promise.all(
            keywordVariants.map(async (variant) => {
              const pages = await fetchPages(window.upstreamPages, (p) =>
                searchPrimo(
                  { query: variant, title, author, subject, language, yearFrom: year_from, yearTo: year_to },
                  (p - 1) * PRIMO_PAGE_SIZE,
                  PRIMO_PAGE_SIZE,
                ),
              );
              const head = pages[0];
              return {
                total: head?.total ?? null,
                split: head ? `${head.totalLocal} in the UK catalogue, ${head.totalCentral} in the Central Discovery Index` : undefined,
                hits: sliceWindow(
                  pages.flatMap((p) => p.hits),
                  window,
                ),
              };
            }),
          );
          const split = perVariant.find((v) => v.split)?.split;
          return {
            total: maxTotal(perVariant.map((v) => v.total)),
            hits: dedupeBy(
              perVariant.flatMap((v) => v.hits),
              bibKey,
            ).slice(0, per_source_limit),
            ...(split ? { note: split } : {}),
          };
        },
      };

      const settled = await Promise.all(
        active.map(async (source) => {
          try {
            const result = await withDeadline(runners[source](), PER_SOURCE_DEADLINE_MS);
            const status: SourceStatus = {
              source,
              ok: true,
              total: result.total,
              has_more: result.total !== null && page * per_source_limit < result.total,
              ...(result.note ? { note: result.note } : {}),
            };
            return { source, status, hits: result.hits };
          } catch (error) {
            const message =
              error instanceof SourceError
                ? `${error.message} ${error.hint}`
                : error instanceof Error
                  ? error.message
                  : String(error);
            const status: SourceStatus = { source, ok: false, total: null, has_more: false, error: message };
            return { source, status, hits: [] as BibHit[] };
          }
        }),
      );

      const statuses: SourceStatus[] = settled.map((s) => s.status);
      const brief = per_source_limit > FULL_DETAIL_LIMIT;
      const items = settled.flatMap((s) => s.hits).map((hit) => (brief ? briefHit(hit) : hit));
      const first = (page - 1) * per_source_limit + 1;

      const blocks = settled.map((entry) => {
        const { status, hits, source } = entry;
        const header = status.ok
          ? `✓ ${LABELS[source]}: ${status.total ?? "?"} records${variants.length > 1 ? " (best variant)" : ""}${status.note ? ` — ${status.note}` : ""}${hits.length ? `; showing ${first}–${first + hits.length - 1}` : ""}${status.has_more ? ` (more: page ${page + 1})` : ""}`
          : `✗ ${LABELS[source]}: ${status.error}`;
        const body = hits.length
          ? hits.map((hit, i) => renderHit(brief ? briefHit(hit) : hit, first + i))
          : status.ok
            ? ["   no records on this page"]
            : [];
        return [header, ...body].join("\n");
      });

      const anyHits = items.length > 0;
      const text = [
        variants.length
          ? `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}`
          : "Field search (no keywords)",
        ...(brief ? [`Brief records (per_source_limit above ${FULL_DETAIL_LIMIT}) — abstracts and contents omitted; ask for ≤ ${FULL_DETAIL_LIMIT} per source to see them.`] : []),
        "",
        ...blocks.flatMap((block) => [block, ""]),
        anyHits
          ? "These are catalogue records, not texts: cite author, title, year and the record link; open the access links for the publisher's copy. Different wording finds different literature — try the other language's term, or the subject heading a good hit carries."
          : "No records on either side — broaden the keywords (drop a word, use the English or Czech term), remove the year or language filter, or search the subject heading instead of the title.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: { variants, page, per_source_limit, statuses, items },
      };
    },
  );

  server.registerTool(
    "doctrine_get_document",
    {
      title: "Doctrine: the record in full, and the work's text where it is open",
      description:
        `READ a work from doctrine_search: the catalogue record in full (whole abstract, table of contents, subject headings, access links) and — where an open-access copy exists — the text of the work itself, paged like every other *_get_* tool. Identify the work by source + id from a hit, by doi, or by an access url. The open copy is looked for in this order: the url you pass, the open-access location Unpaywall knows for the DOI (PDF before landing page), the DOI's own page, the record's access links; the first readable one wins and every failed attempt is reported with its reason. Licensed works (most of the Peace Palace collections, the Central Discovery Index) come back as 'unavailable': the record still orients you — abstract, contents, subjects — but the text needs the library's reader login, which this server does not hold. record_only: true skips the download and returns just the record. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        source: z.enum(SOURCES).optional().describe("Catalogue the id comes from (with id)."),
        id: z.string().min(1).optional().describe("Record id from a doctrine_search hit: OCLC number (peacepalace) or Primo record id (cuni)."),
        doi: z.string().min(7).optional().describe("DOI of the work, e.g. '10.1163/9789004724822' — also without source/id."),
        url: z.string().url().optional().describe("An https access link (publisher page, repository PDF) to read directly."),
        record_only: z.boolean().default(false).describe("Return only the catalogue record in full; do not look for the text."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        record: bibItemSchema.optional(),
        record_error: z.string().optional(),
        access: z.object({
          status: z.enum(["open", "unavailable", "not_tried"]),
          oa_status: z.string().optional().describe("Unpaywall's verdict for the DOI: gold/hybrid/bronze/green/closed."),
          tried: z.array(z.object({ url: z.string(), reason: z.string(), outcome: z.string() })),
        }),
        text_url: z.string().optional(),
        via: z.enum(["pdf", "html"]).optional(),
        pdf_pages: z.number().optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ source, id, doi, url, record_only, find, page }) => {
      try {
        if ((source && !id) || (id && !source)) {
          throw new SourceError("doctrine", "INPUT_INVALID", "source and id go together.", "Pass both, as they appear on a doctrine_search hit.");
        }
        if (!id && !doi && !url) {
          throw new SourceError("doctrine", "INPUT_INVALID", "Nothing identifies the work.", "Pass source + id from a hit, a doi, or an access url.");
        }
        const started = Date.now();

        // 1. The record — the orientation even when no copy can be read.
        let record: BibHit | undefined;
        let recordError: string | undefined;
        if (source && id) {
          try {
            record = await withDeadline(source === "peacepalace" ? getWorldcatRecord(id) : getPrimoRecord(id), 20_000);
          } catch (error) {
            // Without a DOI or URL to go on, the record failure is the answer.
            if (!doi && !url) throw error;
            recordError = error instanceof SourceError ? `${error.message} ${error.hint}` : error instanceof Error ? error.message : String(error);
          }
        }

        // 2. Where a readable copy might be.
        const workDoi = doi ?? record?.doi?.[0];
        let oa: OaResolution | undefined;
        let oaError: string | undefined;
        if (workDoi && !record_only) {
          try {
            oa = await withDeadline(resolveOpenAccess(workDoi), 10_000);
          } catch (error) {
            oaError = error instanceof Error ? error.message : String(error);
          }
        }
        const candidates = record_only ? [] : orderCandidates({ url, doi: workDoi, oa, links: record?.links });

        // 3. Read the first copy that is really the work.
        const { document, tried } = candidates.length ? await readFirstCopy(candidates, started) : { document: undefined, tried: [] as TriedCopy[] };
        const paged = document ? pageOrExcerpt(document.text, page, find) : undefined;

        const access = {
          status: document ? ("open" as const) : record_only || !candidates.length ? ("not_tried" as const) : ("unavailable" as const),
          ...(oa?.status ? { oa_status: oa.status } : {}),
          tried: tried.map(({ url: triedUrl, reason, outcome }) => ({ url: triedUrl, reason, outcome })),
        };
        const output = {
          record,
          ...(recordError ? { record_error: recordError } : {}),
          access,
          ...(document ? { text_url: document.finalUrl, via: document.kind, ...(document.pages ? { pdf_pages: document.pages } : {}) } : {}),
          page: paged?.page ?? 1,
          total_pages: paged?.total_pages ?? 1,
          has_more: paged?.has_more ?? false,
          ...(paged?.matches !== undefined ? { matches: paged.matches } : {}),
          text: paged?.text ?? "",
        };

        const recordBlock = record
          ? [
              `RECORD [${LABELS[record.source]}]: ${renderHit({ ...record, abstract: undefined, contents: undefined, subjects: undefined, links: undefined })}`,
              ...(record.subjects?.length ? [`Subjects: ${record.subjects.join("; ")}`] : []),
              ...(record.abstract ? [`Abstract: ${record.abstract}`] : []),
              ...(record.contents ? [`Contents: ${record.contents}`] : []),
              ...(record.url ? [`Record: ${record.url}`] : []),
              ...(record.links?.length ? [`Access links: ${record.links.join(" | ")}`] : []),
            ]
          : recordError
            ? [`RECORD: could not be fetched — ${recordError}`]
            : [];
        const accessBlock = record_only
          ? ["(record only — no copy was looked for)"]
          : [
              `ACCESS: ${document ? `open — read the ${document.kind}${document.pages ? ` (${document.pages} pages)` : ""} at ${document.finalUrl}` : candidates.length ? "no readable open copy" : "nothing to try — the record carries no DOI or access link"}${oa ? ` · Unpaywall: ${oa.isOa ? `open access (${oa.status ?? "oa"})` : "closed (no open-access copy known)"}` : oaError ? ` · Unpaywall: ${oaError}` : ""}`,
              ...tried.map((entry) => `  ${entry.outcome.startsWith("read") ? "✓" : "✗"} ${entry.reason}: ${entry.url} — ${entry.outcome}`),
              ...(!document && candidates.length
                ? [
                    "This is a licensed work as far as the open web goes: orient by the abstract and contents above and cite the record; the text needs the library's reader login (Peace Palace / UK), which this server does not hold yet.",
                  ]
                : []),
            ];
        const textBlock = document && paged ? ["", `--- TEXT (${document.kind}, via ${document.finalUrl}) ---`, paged.text + continuationHint(paged)] : [];
        return {
          content: [{ type: "text", text: [...recordBlock, "", ...accessBlock, ...textBlock].join("\n") }],
          structuredContent: output,
        };
      } catch (error) {
        return failDocument(error);
      }
    },
  );
}
