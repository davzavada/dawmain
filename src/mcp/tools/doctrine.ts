import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PRIMO_MAX_RESULTS, PRIMO_PAGE_SIZE, SOURCE as PRIMO_SOURCE, getPrimoRecord, primoLanguage, searchPrimo } from "@/src/sources/primo";
import { bibKey, formatAuthors, mergeDoiDuplicates, pageWindow, sliceWindow, type BibHit } from "@/src/sources/shared/bib";
import { dedupeBy, uniqueQueries } from "@/src/sources/shared/text";
import { READ_ONLY, toolFailure } from "./shared";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

/**
 * Doctrine — the literature: books, chapters and journal articles in UKAŽ,
 * the discovery service of Univerzita Karlova (the UK catalogue plus the
 * Central Discovery Index of licensed e-resources). The catalogue serves
 * fixed pages of 10, so a request for 20 hits pulls two catalogue pages in
 * one parallel batch; `page` then walks further — the flag the user raised:
 * this database answers with thousands of records, and the reader must be
 * able to keep going — within the first 500 records of a list, all Primo
 * pages a guest through (PRIMO_MAX_RESULTS); past that the reader narrows.
 *
 * A record is the result. The search shows the first lines of each
 * record's abstract and contents; doctrine_get_record returns one record
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
  // A list entry carries the id doctrine_get_record needs.
  if (index !== undefined) lines.push(`   id ${hit.id}`);
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
        "LITERATURE search — books, chapters and journal articles — in UKAŽ, the discovery service of Univerzita Karlova: the UK catalogue (Czech legal doctrine, commentaries, monographs) plus the Central Discovery Index of licensed e-resources (international journals and e-books). Criteria combine with AND: query (keywords anywhere), title, author, subject, language (cze/eng/ger/fre), year_from/year_to (either alone is open-ended); 'queries' runs up to 3 keyword variants in parallel, each with its share of the page (Czech terms for the catalogue, English for the international literature). The catalogue answers with thousands of records: limit (up to 20; above 10 the records come brief, without abstracts) pulls several catalogue pages at once and page walks further — has_more and total say how far the list goes. UKAŽ lets a guest page through only the first 500 records of a list, so for a broad topic narrow up front (title, author, subject, language, years). Results are bibliographic records with the record's own link and, where the record carries them, the first lines of the abstract and contents plus access links; doctrine_get_record {id} returns one record whole (full abstract, table of contents). Cite the literature by author, title, year and the record link.",
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
          .regex(/^[a-z]{2,3}$/i, "Use a language code: cze, eng, ger, fre")
          .optional()
          .describe("Language of the work as the catalogue's code: cze, eng, ger, fre, slo (ces/deu/fra/slk and cs/en/de are mapped)."),
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
        variant_totals: variantTotalsSchema,
        failed_variants: variantFailureSchema,
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
      // Primo indexes 3-letter codes only: a two-letter code the mapping does
      // not know would match nothing and read as "no literature".
      if (language && primoLanguage(language).length < 3) {
        return {
          content: [{ type: "text", text: `Language "${language}" is not a code the catalogue knows — use its 3-letter code: cze, eng, ger, fre, slo, pol, rus…` }],
          isError: true,
        };
      }
      try {
        // Field-only searches (author + subject, no keywords) run once.
        const keywordVariants: Array<string | undefined> = variants.length ? variants : [undefined];
        const n = keywordVariants.length;
        // Every variant owns a fixed share of the page and is walked in step
        // across pages: with one window per variant the first would fill the
        // whole page and the others — fetched at full cost — would never
        // reach the reader. The shares sum to exactly `limit` (10 over 3 →
        // 4, 3, 3) and stay the same on every page, so each variant's ranks
        // run on contiguously from page to page and nothing is cut from the
        // merged list. Round-robin, then dedupe; a short share stays short
        // rather than being back-filled, which would open holes between
        // pages. A variant whose share is 0 (limit below the variant count)
        // is not searched — and the text says so.
        const shares = keywordVariants.map((_, i) => Math.floor(limit / n) + (i < limit % n ? 1 : 0));
        const windows = shares.map((share) => pageWindow(page, share, PRIMO_PAGE_SIZE));
        // Catalogue pages past the 500-record cap are refused upstream; a
        // window straddling it keeps the records before it.
        const reachable = windows.map((window, i) =>
          shares[i] > 0 ? window.upstreamPages.filter((p) => (p - 1) * PRIMO_PAGE_SIZE < PRIMO_MAX_RESULTS) : [],
        );
        const first = (page - 1) * limit + 1;
        if (reachable.every((pages) => !pages.length)) {
          const text = `${LABEL}: page ${page} would start at record ${first}, but UKAŽ lets a guest page through only the first ${PRIMO_MAX_RESULTS} records of a list. Narrow the search — title, author, subject, language, years or a more specific query — to reach the rest; nothing was fetched.`;
          return {
            content: [{ type: "text", text }],
            structuredContent: { variants, page, limit, total: null, total_local: null, total_central: null, has_more: false, items: [] },
          };
        }
        // Only the variants with pages to fetch run: were a share-0 or
        // past-the-cap variant counted, a call whose every searched variant
        // failed would come back as an empty page instead of the error.
        const active = keywordVariants.filter((_, i) => reachable[i].length > 0);
        const outcome = await runVariants(active, async (variant) => {
          const i = keywordVariants.indexOf(variant);
          const pages = await fetchPages(reachable[i], (p) =>
            searchPrimo(
              { query: variant, title, author, subject, language, yearFrom: year_from, yearTo: year_to },
              (p - 1) * PRIMO_PAGE_SIZE,
              PRIMO_PAGE_SIZE,
            ),
          );
          const head = pages[0];
          return {
            total: head.total as number | null,
            totalLocal: head.totalLocal as number | null,
            totalCentral: head.totalCentral as number | null,
            hits: sliceWindow(
              pages.flatMap((p) => p.hits),
              windows[i],
            ),
            skipped: undefined as "cap" | "share" | undefined,
          };
        });
        const failures = outcome.failures;
        // Back in variant order; a variant not run says why.
        const values = keywordVariants.map((variant, i) => {
          if (reachable[i].length) return outcome.values[active.indexOf(variant)];
          return { total: null, totalLocal: null, totalCentral: null, hits: [] as BibHit[], skipped: shares[i] > 0 ? ("cap" as const) : ("share" as const) };
        });
        const rotated: BibHit[] = [];
        for (let rank = 0; rank < Math.max(...shares); rank++) {
          for (const variant of values) if (variant?.hits[rank]) rotated.push(variant.hits[rank]);
        }
        const brief = limit > FULL_DETAIL_LIMIT;
        const items = mergeDoiDuplicates(dedupeBy(rotated, bibKey)).map((hit) => (brief ? briefHit(hit) : hit));
        // The three counts come from ONE variant — the one with most records
        // — so the catalogue split adds up to the total it stands beside.
        const best = values.reduce<(typeof values)[number]>(
          (a, b) => (b && b.total !== null && (a?.total ?? -1) < b.total ? b : a),
          null,
        );
        const total = best?.total ?? null;
        const totalLocal = best?.totalLocal ?? null;
        const totalCentral = best?.totalCentral ?? null;
        // Per variant: has it records left past what its share has walked,
        // within the 500 Primo serves? And what the page actually returned
        // decides too: an empty page must not advertise a next one on the
        // strength of a count alone.
        const hasMore =
          items.length > 0 &&
          values.some(
            (v, i) => v !== null && !v.skipped && v.total !== null && page * shares[i] < Math.min(v.total, PRIMO_MAX_RESULTS),
          );
        const variantTotals = n > 1 ? values.map((v) => v?.total ?? null) : undefined;
        const variantLine =
          n > 1
            ? `Variants searched in parallel, merged round-robin: ${keywordVariants
                .map((variant, i) => {
                  const v = values[i];
                  const state =
                    v === null
                      ? "✗"
                      : v.skipped === "share"
                        ? `not searched (limit ${limit} is below the ${n} variants — raise limit)`
                        : v.skipped === "cap"
                          ? `past the first ${PRIMO_MAX_RESULTS} records`
                          : `${v.total ?? "?"}${v.totalLocal !== null && v.totalCentral !== null ? ` (${v.totalLocal} + ${v.totalCentral})` : ""}`;
                  return `"${variant}" ${state}`;
                })
                .join(" · ")}`
            : variants.length
              ? `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}`
              : "Field search (no keywords)";

        const header = `✓ ${LABEL}: ${total ?? "?"} records${n > 1 ? " (best variant)" : ""}${totalLocal !== null && totalCentral !== null ? ` — ${totalLocal} in the UK catalogue, ${totalCentral} in the Central Discovery Index` : ""}${items.length ? `; showing ${first}–${first + items.length - 1}` : ""}${hasMore ? ` (more: page ${page + 1})` : ""}`;
        const text = [
          ...failureLines(failures),
          variantLine,
          ...(brief ? [`Brief records (limit above ${FULL_DETAIL_LIMIT}) — abstracts and contents omitted; ask for ≤ ${FULL_DETAIL_LIMIT} to see them.`] : []),
          "",
          header,
          ...(total !== null && total > PRIMO_MAX_RESULTS
            ? [`Only the first ${PRIMO_MAX_RESULTS} records of a list can be paged (UKAŽ's limit for guests) — narrow the search (title, author, subject, language, years) to reach the rest.`]
            : []),
          ...(items.length ? items.map((hit, i) => renderHit(hit, first + i)) : ["   no records on this page"]),
          "",
          items.length
            ? "These are catalogue records, not texts: cite author, title, year and the record link; the whole abstract and contents of a hit: doctrine_get_record {id}. Different wording finds different literature — try the other language's term, or the subject heading a good hit carries."
            : "No records — broaden the keywords (drop a word, use the English or Czech term), remove the year or language filter, or search the subject heading instead of the title.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            variants,
            page,
            limit,
            total,
            total_local: totalLocal,
            total_central: totalCentral,
            has_more: hasMore,
            items,
            ...(variantTotals ? { variant_totals: variantTotals } : {}),
            ...(failures.length ? { failed_variants: failures } : {}),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "doctrine_get_record",
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
        // No outer deadline: fetchPrimo bounds each attempt at 20 s with one
        // retry (≈ 41.5 s worst case, inside the route's 60 s). A 20 s race
        // around it — the old cap — answered "timed out" exactly when the
        // retry started, leaving that retry orphaned and useless.
        const record = await getPrimoRecord(id);
        const shownIds = (record.isbn?.length ? 1 : 0) + (record.issn?.length ? 1 : 0) + (record.doi?.length ? 1 : 0);
        const allIds = [
          record.isbn?.length ? `ISBN ${record.isbn.join(", ")}` : "",
          record.issn?.length ? `ISSN ${record.issn.join(", ")}` : "",
          record.doi?.length ? `DOI ${record.doi.join(", ")}` : "",
        ].filter(Boolean);
        const idCount = (record.isbn?.length ?? 0) + (record.issn?.length ?? 0) + (record.doi?.length ?? 0);
        const text = [
          `RECORD [${LABEL}]: ${renderHit({ ...record, abstract: undefined, contents: undefined, subjects: undefined, links: undefined, url: null })}`,
          // The RECORD line cites three authors and the first identifier of
          // each kind; the record view lists every one it holds.
          ...(record.authors.length > 3 ? [`Authors: ${record.authors.join("; ")}`] : []),
          ...(idCount > shownIds ? [`Identifiers: ${allIds.join(" · ")}`] : []),
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
