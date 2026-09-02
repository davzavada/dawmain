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
  type ReaderAccess,
  type TextCandidate,
} from "@/src/sources/fulltext";
import { libraryProxies, unwrapProxiedLink } from "@/src/sources/library-login";
import { credentialsConfigured, loadReaderCredentials, type LibraryId, type ReaderCredential } from "../credentials";
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
const PER_COPY_MS = 20_000;
const MAX_OPEN_COPIES = 3;
const MAX_READER_COPIES = 2;

/** A copy to try: openly, or through a signed-in reader's library proxy. */
interface CopyCandidate extends TextCandidate {
  reader?: ReaderAccess;
  /** The work is known to be closed — any sign-in/purchase page is a wall. */
  strict?: boolean;
}

interface TriedCopy {
  url: string;
  reason: string;
  outcome: string;
}

/**
 * What the MCP layer knows about the caller: the Clerk user behind an OAuth
 * token, nothing behind the shared access code. Structural on purpose —
 * the SDK's RequestHandlerExtra carries authInfo.extra as a free object.
 */
export function callerUserId(extra: unknown): string | undefined {
  const info = (extra as { authInfo?: { extra?: Record<string, unknown> } } | undefined)?.authInfo?.extra;
  return typeof info?.userId === "string" && info.userId ? info.userId : undefined;
}

/**
 * The reader's own way in, after the open ones: the works behind the
 * record's library-wrapped links, the DOI page and the publisher links,
 * each through the proxy of a library the reader has a login for — the
 * record's own library first. Pure — unit-tested.
 */
export function readerCandidates(
  input: { doi?: string; links?: string[]; source?: LibraryId },
  logins: Partial<Record<LibraryId, ReaderCredential>>,
  userId: string,
): CopyCandidate[] {
  const libraries = (Object.keys(logins) as LibraryId[]).filter((id) => logins[id]);
  if (!libraries.length) return [];
  libraries.sort((a, b) => (a === input.source ? -1 : b === input.source ? 1 : 0));
  const targets: string[] = [];
  const push = (url: string | null | undefined) => {
    if (url && /^https?:\/\//i.test(url) && !targets.includes(url)) targets.push(url);
  };
  for (const link of input.links ?? []) push(unwrapProxiedLink(link));
  if (input.doi) push(`https://doi.org/${input.doi}`);
  for (const link of input.links ?? []) if (!unwrapProxiedLink(link)) push(link);
  const proxies = libraryProxies();
  const out: CopyCandidate[] = [];
  // Target-major: with two logins the cap then spends one attempt per
  // library instead of both on the first library's targets.
  for (const url of targets) {
    for (const library of libraries) {
      out.push({
        url,
        reason: `through your ${proxies[library].label} login`,
        reader: { userId, library, credential: logins[library] as ReaderCredential },
      });
    }
  }
  return out;
}

/**
 * Try the copies in order until one yields text. Every failure is kept
 * with its reason — "licensed" is a finding the reader needs, not noise.
 */
async function readFirstCopy(
  candidates: CopyCandidate[],
  started: number,
): Promise<{ document?: FetchedDocument; tried: TriedCopy[] }> {
  const tried: TriedCopy[] = [];
  for (const candidate of candidates) {
    const left = READ_BUDGET_MS - (Date.now() - started);
    if (left < 5_000) {
      tried.push({ url: candidate.url, reason: candidate.reason, outcome: "not tried — out of time for this call" });
      return { tried };
    }
    try {
      const document = await withDeadline(fetchDocumentText(candidate.url, candidate.reader, candidate.strict), Math.min(PER_COPY_MS, left));
      return { document, tried: [...tried, { url: candidate.url, reason: candidate.reason, outcome: `read (${document.kind})` }] };
    } catch (error) {
      const message = error instanceof SourceError ? error.message : error instanceof Error ? error.message : String(error);
      tried.push({ url: candidate.url, reason: candidate.reason, outcome: message });
    }
  }
  return { tried };
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
      if (!variants.length && !title?.trim() && !author?.trim() && !subject?.trim()) {
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
      // Every variant owns an equal share of the page and is walked in step
      // across pages: with one window per variant the first variant would
      // fill the whole page and the others — fetched at full cost — would
      // never reach the reader; and a thin variant would make later pages
      // skip records. Round-robin, then dedupe; a short share stays short
      // rather than being back-filled, which would reopen those holes.
      const share = Math.ceil(per_source_limit / keywordVariants.length);
      const rotate = (perVariant: Array<{ hits: BibHit[] }>): BibHit[] => {
        const rotated: BibHit[] = [];
        for (let rank = 0; rank < share; rank++) {
          for (const variant of perVariant) if (variant.hits[rank]) rotated.push(variant.hits[rank]);
        }
        return dedupeBy(rotated, bibKey).slice(0, per_source_limit);
      };

      const runners: Record<SourceId, () => Promise<RunnerResult>> = {
        peacepalace: async () => {
          const window = pageWindow(page, share, WORLDCAT_PAGE_SIZE);
          const perVariant = await Promise.all(
            keywordVariants.map(async (variant) => {
              const pages = await fetchPages(window.upstreamPages, (p) =>
                searchWorldcat({ query: variant, ...criteria }, p),
              );
              const head = pages[0];
              return {
                total: head?.total ?? null,
                partial: pages.some((p) => p.partial),
                rewritten: head?.rewritten ? (head.originalQuery ?? "query rewritten") : undefined,
                resultsType: head?.resultsType,
                hits: sliceWindow(
                  pages.flatMap((p) => p.hits),
                  window,
                ),
              };
            }),
          );
          const notes: string[] = [];
          if (perVariant.some((v) => v.partial)) notes.push("partial result — one of the library's databases did not answer upstream");
          const rewritten = perVariant.find((v) => v.rewritten)?.rewritten;
          if (rewritten) notes.push(`WorldCat did not run the query as given (its own report: ${rewritten}) — the count and the hits belong to the broadened query`);
          const odd = perVariant.find((v) => v.resultsType && v.resultsType !== "NORMAL")?.resultsType;
          if (odd) notes.push(`WorldCat answered with result type ${odd}`);
          return {
            total: maxTotal(perVariant.map((v) => v.total)),
            hits: rotate(perVariant),
            ...(notes.length ? { note: notes.join("; ") } : {}),
          };
        },
        cuni: async () => {
          const window = pageWindow(page, share, PRIMO_PAGE_SIZE);
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
            hits: rotate(perVariant),
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
              // What the page actually returned decides too: an empty page must
              // not advertise a next one on the strength of a count alone.
              has_more: result.total !== null && result.hits.length > 0 && page * per_source_limit < result.total,
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
        `READ a work from doctrine_search: the catalogue record in full (whole abstract, table of contents, subject headings, access links) and — where a copy can be opened — the text of the work itself, paged like every other *_get_* tool. Identify the work by source + id from a hit, by doi, or by an access url. Copies are tried in this order: the url you pass, the open-access location Unpaywall knows for the DOI (PDF before landing page), the DOI's own page, the record's access links; then, when the caller has stored a library login on /ucet, the same works through that library's proxy as a signed-in reader (licensed titles). The first readable copy wins and every failed attempt is reported with its reason. 'unavailable' means no copy could be opened: the record still orients you — abstract, contents, subjects — and the text needs a reader login the caller has not stored (or the library does not license the title). record_only: true skips the download and returns just the record. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        source: z.enum(SOURCES).optional().describe("Catalogue the id comes from (with id)."),
        id: z.string().min(1).optional().describe("Record id from a doctrine_search hit: OCLC number (peacepalace) or Primo record id (cuni)."),
        doi: z.string().min(7).optional().describe("DOI of the work, e.g. '10.1163/9789004724822' — also without source/id."),
        url: z
          .string()
          .url()
          .refine((value) => /^https?:\/\//i.test(value), "Pass an http(s) access link.")
          .optional()
          .describe("An http(s) access link (publisher page, repository PDF) to read directly."),
        record_only: z.boolean().default(false).describe("Return only the catalogue record in full; do not look for the text."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        record: bibItemSchema.optional(),
        record_error: z.string().optional(),
        access: z.object({
          status: z.enum(["open", "reader", "unavailable", "not_tried"]).describe("open = an open-access copy was read; reader = read through the caller's library login; unavailable = every copy refused."),
          oa_status: z.string().optional().describe("Unpaywall's verdict for the DOI: gold/hybrid/bronze/green/closed."),
          reader_logins: z.array(z.enum(SOURCES)).describe("Libraries the caller has a stored login for (used automatically)."),
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
    async ({ source, id, doi, url, record_only, find, page }, extra) => {
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
        // Unpaywall saying "closed" makes every open landing page a wall by
        // definition, however long it is.
        const strict = Boolean(oa && !oa.isOa);
        const openCandidates: CopyCandidate[] = record_only
          ? []
          : orderCandidates({ url, doi: workDoi, oa, links: record?.links })
              .slice(0, MAX_OPEN_COPIES)
              .map((candidate) => ({ ...candidate, strict }));

        // 2b. The caller's own library logins, for the licensed copies.
        const userId = callerUserId(extra);
        let logins: Partial<Record<LibraryId, ReaderCredential>> = {};
        if (userId && !record_only && credentialsConfigured()) {
          try {
            logins = await withDeadline(loadReaderCredentials(userId), 8_000);
          } catch {
            // Clerk unreachable: the open copies are still worth trying.
          }
        }
        const readerLogins = (Object.keys(logins) as LibraryId[]).filter((library) => logins[library]);
        const viaReader = userId && !record_only ? readerCandidates({ doi: workDoi, links: record?.links, source: record?.source ?? source }, logins, userId).slice(0, MAX_READER_COPIES) : [];
        const candidates = [...openCandidates, ...viaReader.filter((candidate) => !openCandidates.some((open) => open.url === candidate.url && !candidate.reader))];

        // 3. Read the first copy that is really the work.
        const { document, tried } = candidates.length ? await readFirstCopy(candidates, started) : { document: undefined, tried: [] as TriedCopy[] };
        const paged = document ? pageOrExcerpt(document.text, page, find) : undefined;

        const access = {
          status: document ? (document.reader ? ("reader" as const) : ("open" as const)) : record_only || !candidates.length ? ("not_tried" as const) : ("unavailable" as const),
          ...(oa?.status ? { oa_status: oa.status } : {}),
          reader_logins: readerLogins,
          tried,
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
              `ACCESS: ${document ? `${document.reader ? `read through your ${LABELS[document.reader]} login` : "open"} — the ${document.kind}${document.pages ? ` (${document.pages} pages)` : ""} at ${document.finalUrl}` : candidates.length ? "no readable copy" : record ? "nothing to try — the record carries no DOI or access link" : "nothing to try — no DOI or access link to go on"}${oa ? ` · Unpaywall: ${oa.isOa ? `open access (${oa.status ?? "oa"})` : "closed (no open-access copy known)"}` : oaError ? ` · Unpaywall: ${oaError}` : ""}${readerLogins.length ? ` · your library logins: ${readerLogins.map((library) => LABELS[library]).join(", ")}` : ""}`,
              ...tried.map((entry) => `  ${entry.outcome.startsWith("read") ? "✓" : "✗"} ${entry.reason}: ${entry.url} — ${entry.outcome}`),
              ...(!document && candidates.length
                ? [
                    readerLogins.length
                      ? "No copy opened, even through your library login: the library may not license this title, or the sign-in chain did not fit (the reasons above say which). Orient by the abstract and contents and cite the record."
                      : userId
                        ? "This is a licensed work as far as the open web goes: orient by the abstract and contents above and cite the record. To read licensed titles, store your library login on /ucet of the Dawmain site — it is then used automatically."
                        : "This is a licensed work as far as the open web goes: orient by the abstract and contents above and cite the record; licensed titles open only for a caller signed in with their own account and a stored library login (/ucet).",
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
