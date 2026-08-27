import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNssDecision, searchNss } from "@/src/sources/nss";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { dedupeBy, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD");

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("Nejvyšší správní soud", error));
}

export function registerNss(server: McpServer): void {
  server.registerTool(
    "nss_search",
    {
      title: "Nejvyšší správní soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Administrative Court decisions (kasační stížnosti — tax, immigration, public procurement, administrative law) — plus spisová značka/čj., decision/publication date ranges, court/senate (incl. rozšířený senát and KRAJSKÉ SOUDY — the index covers regional administrative courts too), rejstřík code, oblast úpravy, and applied-provision filters: applies_act '106/1999' + applies_provision '§ 17 odst. 2' finds decisions that APPLIED that provision (metadata-based — works without keywords; the citator Czech courts lack). Czech queries. 'queries' searches up to 3 variants IN PARALLEL in one call (Czech inflects — pass stems/synonyms) and merges deduplicated results. Page 1 returns up to 40 hits, later pages 20. Results carry a numeric document_id for nss_get_decision. read_top: N also returns excerpt previews of the N best hits — search + first reading in one call.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged (inflections, synonyms)."),
        case_number: z.string().optional().describe("Spisová značka / čj., e.g. '1 Afs 25/2024'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe("Date the decision was published to the web, from (ISO) — monitor what is new."),
        published_to: isoDate.optional().describe("Publication date to (ISO)."),
        court: z
          .enum(["nss", "rozsireny-senat", "krajske", "karne"])
          .optional()
          .describe(
            "nss = NSS (all senates), rozsireny-senat = grand chamber (most authoritative), krajske = regional administrative courts, karne = disciplinary courts.",
          ),
        registry: z
          .string()
          .optional()
          .describe(
            "Docket registry (rejstřík) code — the agenda: 'Afs' tax, 'Azs' asylum, 'Ads' social security, 'As' general administrative, 'Ans' inaction, 'Aps' unlawful interference, 'Ao' measures of general nature, 'Ars' electoral, 'Vol' elections, 'Komp'/'Konf' competence disputes.",
          ),
        area: z
          .string()
          .optional()
          .describe(
            "Subject area (oblast úpravy), Czech substring — e.g. 'daň z přidané hodnoty', 'Pobyt cizinců', 'Právo na informace', 'Stavební zákon'; all matching areas are OR-ed. An invalid value returns the full list.",
          ),
        applies_act: z
          .string()
          .optional()
          .describe(
            "Only decisions applying this Sb. act — 'číslo/rok', e.g. '106/1999' (informace), '150/2002' (s.ř.s.), '280/2009' (daňový řád). Works without keywords.",
          ),
        applies_treaty: z
          .string()
          .optional()
          .describe("Only decisions applying this Sb./Sb.m.s. treaty — e.g. '209/1992' (EÚLP)."),
        applies_eu_regulation: z
          .string()
          .optional()
          .describe("Only decisions applying this EU regulation — '2016/679' (GDPR) or '1049/2001'."),
        applies_eu_directive: z
          .string()
          .optional()
          .describe("Only decisions applying this EU directive — e.g. '2004/48', '2011/95'."),
        applies_provision: z.coerce
          .string()
          .optional()
          .describe(
            "Narrow the applies_* act to one provision: '§ 17 odst. 2 písm. a', 'čl. 8 odst. 2', or compact '17(2)(a)'. Requires one applies_* filter.",
          ),
        page: z.number().int().min(1).default(1),
        read_top: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe("Fetch the N best hits' texts in parallel and return excerpts around the query."),
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            id: z.string(),
            caseNumber: z.string().optional(),
            court: z.string().optional(),
            date: z.string().optional(),
            form: z.string().optional(),
            url: z.string(),
          }),
        ),
        previews: z
          .array(
            z.object({
              id: z.string(),
              caseNumber: z.string(),
              matches: z.number(),
              excerpt: z.string(),
            }),
          )
          .optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, queries, case_number, date_from, date_to, published_from, published_to, court, registry, area, applies_act, applies_treaty, applies_eu_regulation, applies_eu_directive, applies_provision, page, read_top }) => {
      try {
        const variants = uniqueQueries(query, queries);
        // One upstream request per variant, in parallel; hits merged in
        // variant order and deduplicated. Totals/has_more follow the largest
        // variant — the union across variants is unknowable.
        const results = await Promise.all(
          (variants.length ? variants : [undefined]).map((variant) =>
            searchNss(
              {
                query: variant,
                caseNumber: case_number,
                dateFrom: date_from,
                dateTo: date_to,
                publishedFrom: published_from,
                publishedTo: published_to,
                court,
                registry,
                area,
                appliesAct: applies_act,
                appliesTreaty: applies_treaty,
                appliesEuRegulation: applies_eu_regulation,
                appliesEuDirective: applies_eu_directive,
                appliesProvision: applies_provision,
              },
              page,
            ),
          ),
        );
        const cap = page === 1 ? 40 : 20;
        const result = {
          total: maxTotal(results.map((r) => r.total)),
          page: results[0].page,
          hits: dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.id,
          ).slice(0, cap),
        };
        const previews = await buildPreviews(
          result.hits.slice(0, read_top).map((hit) => ({ id: hit.id, caseNumber: hit.caseNumber ?? "?" })),
          (id) => getNssDecision(id).then((d) => d.text),
          variants,
        );
        const seen = page === 1 ? result.hits.length : 40 + (page - 1) * 20;
        const output = {
          total: result.total,
          count: result.hits.length,
          page: result.page,
          has_more: result.total !== null && seen < result.total,
          items: result.hits,
          previews,
        };
        const lines = result.hits.map(
          (hit, i) =>
            `${i + 1}. ${hit.caseNumber ?? "?"}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""} — id ${hit.id}\n   ${hit.url}`,
        );
        const text =
          result.total === 0 || (!result.hits.length && result.total === null)
            ? "No NSS decisions matched. Broaden the query or the date range."
            : [
                `${result.total ?? "?"} decisions${variants.length > 1 ? ` (best of ${variants.length} variants, merged)` : ""} (page ${result.page}):`,
                ...lines,
                "Full text: nss_get_decision {document_id}.",
                ...renderPreviews(previews, "nss_get_decision"),
              ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "nss_get_decision",
    {
      title: "Nejvyšší správní soud: decision text",
      description:
        "Full text and metadata (ECLI, soudce zpravodaj, výrok, oblast úpravy) of one Supreme Administrative Court decision, by the numeric id from nss_search. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        document_id: z.string().regex(/^\d+$/, "Numeric id from nss_search"),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        id: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ document_id, find, page }) => {
      try {
        const decision = await getNssDecision(document_id);
        const paged = pageOrExcerpt(decision.text, page, find);
        const output = {
          id: decision.id,
          url: decision.url,
          metadata: decision.metadata,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        const meta = Object.entries(decision.metadata)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${meta}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)` : ""}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
