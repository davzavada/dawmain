import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PRIMO_PAGE_SIZE, SOURCE as PRIMO_SOURCE, getPrimoRecord, searchPrimo } from "@/src/sources/primo";
import { bibKey, formatAuthors, pageWindow, sliceWindow, type BibHit } from "@/src/sources/shared/bib";
import { dedupeBy, maxTotal, uniqueQueries } from "@/src/sources/shared/text";
import { withDeadline } from "./previews";
import { READ_ONLY, toolFailure } from "./shared";

/**
 * Doctrine — the literature: books, chapters and journal articles in UKAŽ,
 * the discovery service of Univerzita Karlova (the UK catalogue plus the
 * Central Discovery Index of licensed e-resources). The catalogue serves
 * fixed pages of 10, so a request for 20 hits pulls two catalogue pages in
 * one parallel batch; `page` then walks further — the flag the user raised:
 * this database answers with thousands of records, and the reader must be
 * able to keep going.
 *
 * A record is the result. The search shows the first lines of each
 * record's abstract and contents; doctrine_get_document returns one record
 * whole — the full abstract and table of contents are how a reader tells
 * whether a work is on point. The text of the work itself is NOT fetched:
 * an earlier layer downloaded open-access copies (Unpaywall, DOI, PDF
 * extraction) and opened licensed ones through the university's proxy with
 * a stored reader login; it was removed at the operator's request as more
 * machinery than the question needs. The record link leads to the work.
 *
 * The Peace Palace Library's WorldCat Discovery was a second source until
 * the first live run: Cloudflare refuses the deployment's address outright
 * (HTTP 403 in 40 ms, before any OCLC code runs), so the client went the
 * way of EUIPO and ÚPV — see docs/research/doctrine-sources.json.
 */

const LABEL = "UKAŽ (Univerzita Karlova)";
const fail = toolFailure(PRIMO_SOURCE);
/** Catalogue pages requested at once per variant. */
const PAGE_BATCH = 5;
/** The full-display call has the function's 60 s to share with the client. */
const RECORD_TIMEOUT_MS = 20_000;

/**
 * Above this many hits the page switches to brief records — no abstract,
 * contents, subjects or access links, in the text AND in the structured
 * items. Measured: 10 full records ≈ 10k characters of text plus as much
 * again in structuredContent; 30 full records would be rejected whole by
 * the client (see DOC_PAGE_CHARS).
 */
export const FULL_DETAIL_LIMIT = 10;

/** The record without its bulky optional parts. Pure. */
export function briefHit(hit: BibHit): BibHit {
  const { abstract: _abstract, contents: _contents, subjects: _subjects, links: _links, ...rest } = hit;
  return rest;
}

/** Fetch every catalogue page of one variant, in small parallel batches, in order. */
async function fetchPages<T>(pages: number[], load: (page: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < pages.length; i += PAGE_BATCH) {
    out.push(...(await Promise.all(pages.slice(i, i + PAGE_BATCH).map(load))));
  }
  return out;
}

/** Citation-style line for one hit; the structured record carries the rest.
 * `index` numbers a list entry; the record view passes none. */
function renderHit(hit: BibHit, index?: number): string {
  const head = [formatAuthors(hit.authors), hit.year ? `(${hit.year})` : ""].filter(Boolean).join(" ");
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
  source: z.literal("cuni"),
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

export function registerDoctrine(server: McpServer): void {
  server.registerTool(
    "doctrine_search",
    {
      title: "Doctrine: search the literature in UKAŽ",
      description:
        "LITERATURE search — books, chapters and journal articles — in UKAŽ, the discovery service of Univerzita Karlova: the UK catalogue (Czech legal doctrine, commentaries, monographs) plus the Central Discovery Index of licensed e-resources (international journals and e-books). Criteria combine with AND: query (keywords anywhere), title, author, subject, language (cze/eng/ger/fre), year_from/year_to; 'queries' runs up to 3 keyword variants in parallel (Czech terms for the catalogue, English for the international literature). The catalogue answers with thousands of records: limit (up to 20; above 10 the records come brief, without abstracts) pulls several catalogue pages at once and page walks further — has_more and total say how far the list goes. Results are bibliographic records with the record's own link and, where the record carries them, the first lines of the abstract and contents plus access links; doctrine_get_document {id} returns one record whole (full abstract, table of contents). Cite the literature by author, title, year and the record link.",
      inputSchema: z.object({
        query: z.string().min(2).optional().describe("Keywords anywhere in the record (title, subject, abstract, contents)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 keyword variants searched in parallel and merged (Czech/English terms, synonyms)."),
        title: z.string().min(2).optional().describe("Words from the title."),
        author: z.string().min(2).optional().describe("Author or editor name — surname is enough."),
        subject: z.string().min(2).optional().describe("Subject heading words (Czech subject headings / LCSH)."),
        language: z
          .string()
          .regex(/^[a-z]{3}$/i, "Use a 3-letter code: cze, eng, ger, fre")
          .optional()
          .describe("Language of the work as a 3-letter code: cze, eng, ger, fre, slo."),
        year_from: z.number().int().min(1500).max(2100).optional().describe("Publication year from (inclusive)."),
        year_to: z.number().int().min(1500).max(2100).optional().describe("Publication year to (inclusive)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe(
            `Hits per page (max 20). Up to ${FULL_DETAIL_LIMIT}: full records with abstract/contents; above that the page comes as a brief list (author, year, title, container, link) so it fits the response — the bibliography mode.`,
          ),
        page: z.number().int().min(1).default(1).describe("1-based page of `limit` hits."),
      }),
      outputSchema: z.object({
        variants: z.array(z.string()),
        page: z.number(),
        limit: z.number(),
        total: z.number().nullable(),
        total_local: z.number().nullable().describe("Records from the UK catalogue itself."),
        total_central: z.number().nullable().describe("Records from the Central Discovery Index."),
        has_more: z.boolean(),
        items: z.array(bibItemSchema),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, queries, title, author, subject, language, year_from, year_to, limit, page }) => {
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
        return { content: [{ type: "text", text: "year_from must not exceed year_to." }], isError: true };
      }
      try {
        // Field-only searches (author + subject, no keywords) run once.
        const keywordVariants: Array<string | undefined> = variants.length ? variants : [undefined];
        // Every variant owns an equal share of the page and is walked in
        // step across pages: with one window per variant the first would
        // fill the whole page and the others — fetched at full cost — would
        // never reach the reader; and a thin variant would make later pages
        // skip records. Round-robin, then dedupe; a short share stays short
        // rather than being back-filled, which would reopen those holes.
        const share = Math.ceil(limit / keywordVariants.length);
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
              totalLocal: head?.totalLocal ?? null,
              totalCentral: head?.totalCentral ?? null,
              hits: sliceWindow(
                pages.flatMap((p) => p.hits),
                window,
              ),
            };
          }),
        );
        const rotated: BibHit[] = [];
        for (let rank = 0; rank < share; rank++) {
          for (const variant of perVariant) if (variant.hits[rank]) rotated.push(variant.hits[rank]);
        }
        const brief = limit > FULL_DETAIL_LIMIT;
        const items = dedupeBy(rotated, bibKey)
          .slice(0, limit)
          .map((hit) => (brief ? briefHit(hit) : hit));
        const total = maxTotal(perVariant.map((v) => v.total));
        const totalLocal = maxTotal(perVariant.map((v) => v.totalLocal));
        const totalCentral = maxTotal(perVariant.map((v) => v.totalCentral));
        // What the page actually returned decides too: an empty page must
        // not advertise a next one on the strength of a count alone.
        const hasMore = total !== null && items.length > 0 && page * limit < total;
        const first = (page - 1) * limit + 1;

        const header = `✓ ${LABEL}: ${total ?? "?"} records${variants.length > 1 ? " (best variant)" : ""}${totalLocal !== null && totalCentral !== null ? ` — ${totalLocal} in the UK catalogue, ${totalCentral} in the Central Discovery Index` : ""}${items.length ? `; showing ${first}–${first + items.length - 1}` : ""}${hasMore ? ` (more: page ${page + 1})` : ""}`;
        const text = [
          variants.length ? `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}` : "Field search (no keywords)",
          ...(brief ? [`Brief records (limit above ${FULL_DETAIL_LIMIT}) — abstracts and contents omitted; ask for ≤ ${FULL_DETAIL_LIMIT} to see them.`] : []),
          "",
          header,
          ...(items.length ? items.map((hit, i) => renderHit(hit, first + i)) : ["   no records on this page"]),
          "",
          items.length
            ? "These are catalogue records, not texts: cite author, title, year and the record link; the whole abstract and contents of a hit: doctrine_get_document {id}. Different wording finds different literature — try the other language's term, or the subject heading a good hit carries."
            : "No records — broaden the keywords (drop a word, use the English or Czech term), remove the year or language filter, or search the subject heading instead of the title.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { variants, page, limit, total, total_local: totalLocal, total_central: totalCentral, has_more: hasMore, items },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "doctrine_get_document",
    {
      title: "Doctrine: one record in full — abstract and contents",
      description:
        "READ the catalogue record of a doctrine_search hit in full: the whole abstract, the table of contents, subject headings, identifiers and access links — the search shows only the first lines of the abstract and contents. This is how you tell whether a monograph, commentary or article is on point before citing it. The text of the work itself is not fetched: the record link leads to it (licensed titles open for the user through the university's remote access in a browser). Identify the record by the id of a hit: alma… for the UK catalogue, cdi_… for the Central Discovery Index.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Record id from a doctrine_search hit (alma… for the catalogue, cdi_… for the Central Discovery Index)."),
      }),
      outputSchema: z.object({
        record: bibItemSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      try {
        const record = await withDeadline(getPrimoRecord(id), RECORD_TIMEOUT_MS);
        const text = [
          `RECORD [${LABEL}]: ${renderHit({ ...record, abstract: undefined, contents: undefined, subjects: undefined, links: undefined, url: null })}`,
          ...(record.subjects?.length ? [`Subjects: ${record.subjects.join("; ")}`] : []),
          `Abstract: ${record.abstract ?? "(none in the record)"}`,
          `Contents: ${record.contents ?? "(none in the record)"}`,
          ...(record.url ? [`Record: ${record.url}`] : []),
          ...(record.links?.length ? [`Access links: ${record.links.join(" | ")}`] : []),
          "",
          record.abstract || record.contents
            ? "This is the catalogue record, not the work: cite author, title, year and the record link, and present what the abstract and contents say as the record's abstract, not as the text. The work itself opens from the record link — licensed titles through the university's remote access."
            : "The record carries neither an abstract nor a table of contents: orient by the title, subjects and container, and open the record link for more.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { record },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
