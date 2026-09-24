import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  continuationHint,
  isoDate,
  readTopSchema,
  toolFailure,
} from "./shared";
import { getNssDecision, searchNss } from "@/src/sources/nss";
import { interleave, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("Nejvyšší správní soud");

export function registerNss(server: McpServer): void {
  server.registerTool(
    "nss_search",
    {
      title: "Nejvyšší správní soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Administrative Court decisions (kasační stížnosti — tax, immigration, public procurement, administrative law) — plus spisová značka/čj., decision/publication date ranges, court/senate (incl. rozšířený senát and KRAJSKÉ SOUDY — the index covers regional administrative courts too), rejstřík code, oblast úpravy, and applied-provision filters: applies_act '106/1999' + applies_provision '§ 17 odst. 2' finds decisions that APPLIED that provision (metadata-based — works without keywords; the citator Czech courts lack). Czech queries. 'queries' searches up to 3 variants IN PARALLEL in one call (Czech inflects — pass stems/synonyms) and merges them round-robin, so every variant is represented; 'variant_totals' says what each found, and a variant that fails or times out is named in 'failed_variants' while the others still answer. Results are ordered by DECISION DATE, newest first — the NSS index has no relevance order, so distinctive terms and filters (court, registry, applies_*) decide what comes first. Page 1 returns up to 40 hits, later pages 20. Results carry a numeric document_id for nss_get_decision. read_top: N also returns excerpt previews of the N best hits — search + first reading in one call.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (inflections, synonyms)."),
        case_number: z.string().optional().describe("Spisová značka / čj., e.g. '1 Afs 25/2024'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe(
            "Date the decision was PUBLISHED to the web, from (ISO) — monitor what is new. Results still sort by DECISION date, so a fresh publication window legitimately surfaces older, just-published decisions (backfill) — not a broken filter.",
          ),
        published_to: isoDate.optional().describe("Publication date to (ISO)."),
        court: z
          .enum(["nss", "rozsireny-senat", "krajske", "karne"])
          .optional()
          .describe(
            "nss = NSS (all senates), rozsireny-senat = grand chamber (most authoritative), krajske = regional administrative courts incl. Městský soud v Praze, karne = disciplinary courts.",
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
          .describe(
            "Only decisions applying this EU directive — e.g. '2004/48', '2011/95'. A community qualifier ('2004/48/ES') narrows to that series.",
          ),
        applies_provision: z.coerce
          .string()
          .optional()
          .describe(
            "Narrow the applies_* act to one provision: '§ 17 odst. 2 písm. a', 'čl. 8 odst. 2', or compact '17(2)(a)'. Requires one applies_* filter.",
          ),
        page: z.number().int().min(1).default(1),
        read_top: readTopSchema,
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
        variant_totals: variantTotalsSchema,
        failed_variants: variantFailureSchema,
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
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined) => ({
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
        });
        // The portal pages by 40, then 20. One variant pages straight
        // through it. Several: each variant is read from its own top through
        // this page, the lists are merged round-robin, and the page is a
        // slice of the merged list — no variant's hits fall between pages.
        const multi = keyed.length > 1;
        const start = page === 1 ? 0 : 40 + (page - 2) * 20;
        const end = page === 1 ? 40 : start + 20;
        const { values, failures } = await runVariants(keyed, async (variant) => {
          if (!multi) return [await searchNss(inputFor(variant), page)];
          const upstream = Array.from({ length: page }, (_, i) => i + 1);
          return Promise.all(upstream.map((p) => searchNss(inputFor(variant), p)));
        });
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const listOf = (pages: typeof answered[number]) => pages.flatMap((p) => p.hits);
        const totalOf = (pages: typeof answered[number]) => pages[0]?.total ?? null;
        const merged = multi ? interleave(answered.map(listOf), (hit) => hit.id) : listOf(answered[0]);
        const hits = multi ? merged.slice(start, end) : merged.slice(0, end - start);
        const total = maxTotal(answered.map(totalOf));
        const hasMore = multi
          ? merged.length > end || answered.some((pages) => (totalOf(pages) ?? 0) > listOf(pages).length)
          : total !== null && end < total;
        const previews = await buildPreviews(
          hits.slice(0, read_top).map((hit) => ({ id: hit.id, caseNumber: hit.caseNumber ?? "?" })),
          ({ id }) => getNssDecision(id).then((d) => d.text),
          variants,
        );
        const variantTotals = multi ? values.map((value) => (value ? totalOf(value) : null)) : undefined;
        const output = {
          total,
          count: hits.length,
          page,
          has_more: hasMore,
          items: hits,
          ...(variantTotals ? { variant_totals: variantTotals } : {}),
          ...(failures.length ? { failed_variants: failures } : {}),
          previews,
        };
        const lines = hits.map(
          (hit, i) =>
            `${start + i + 1}. ${hit.caseNumber ?? "?"}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""} — id ${hit.id}\n   ${hit.url}`,
        );
        const variantLine = variantTotals
          ? `Variants: ${keyed.map((v, i) => `"${v}" ${variantTotals[i] ?? "✗"}`).join(" · ")} (merged round-robin)`
          : null;
        const text =
          total === 0 || (!hits.length && total === null)
            ? ["No NSS decisions matched. Broaden the query or the date range.", ...failureLines(failures)].join("\n")
            : [
                ...failureLines(failures),
                ...(variantLine ? [variantLine] : []),
                `${total ?? "?"} decisions${multi ? " (best variant)" : ""}, newest first (page ${page}):`,
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
        `Full text and metadata (ECLI, soudce zpravodaj, výrok, oblast úpravy) of one Supreme Administrative Court decision, by the numeric id from nss_search. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        document_id: z.string().regex(/^\d+$/, "Numeric id from nss_search"),
        find: z.string().optional().describe(FIND_DESCRIPTION),
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
              text: `${meta}\n\n${paged.text}${continuationHint(paged)}`,
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
