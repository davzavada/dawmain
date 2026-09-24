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
import { ecliToSz, getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { SourceError } from "@/src/sources/shared/errors";
import { interleave, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("Ústavní soud (NALUS)");

export function registerNalus(server: McpServer): void {
  server.registerTool(
    "us_search",
    {
      title: "Ústavní soud: search NALUS",
      description:
        "FULL-TEXT search of Czech Constitutional Court decisions (nálezy, usnesení, stanoviska pléna) in NALUS — plus citace (sp. zn. like 'Pl. ÚS 24/10'), ECLI, soudce zpravodaj AND dissenting judge, populární název, outcome (výrok), petitioner type, contested act (druh/číslo/ustanovení — e.g. every decision reviewing zákon č. 106/1999), contested organ, decision/publication dates, only-published filter, relevance sort, and dissent-scope full text. Czech queries; 'queries' searches up to 3 variants IN PARALLEL and merges them round-robin, so every variant is represented ('variant_totals' says what each found; a failed variant is named in 'failed_variants'). Each hit carries an 'sz' identifier for us_get_decision. read_top: N also returns excerpt previews of the N best hits. Costs 3 upstream requests per variant.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query (právní věta, výrok, odůvodnění…)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (inflections, synonyms)."),
        case_number: z.string().optional().describe("Citace / sp. zn., e.g. 'Pl. ÚS 24/10' or 'I. ÚS 1169/26'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:CZ:US:2026:1.US.1169.26.1'."),
        judge: z.string().optional().describe("Soudce zpravodaj, e.g. 'Wagnerová'."),
        dissenting_judge: z
          .string()
          .optional()
          .describe("Judge who filed a dissent (soudce s odlišným stanoviskem), e.g. 'Fiala'."),
        popular_name: z.string().optional().describe("Populární název, e.g. 'Data retention'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe("Date the decision was made available in NALUS, from (ISO) — monitor what is new."),
        published_to: isoDate.optional().describe("Availability date to (ISO)."),
        types: z
          .array(z.enum(["nález", "usnesení", "stanovisko"]))
          .optional()
          .describe("Restrict decision forms. Default: all."),
        only_published: z
          .boolean()
          .default(false)
          .describe("Only decisions published in Sbírka zákonů / Sbírka nálezů a usnesení."),
        include_dissents: z
          .boolean()
          .default(false)
          .describe("Extend the full-text query into odlišná stanoviska — pair with dissenting_judge to search what a judge argued in dissent."),
        outcome: z
          .array(z.string())
          .max(6)
          .optional()
          .describe(
            "Výrok filter (OR), e.g. ['vyhověno'], ['zamítnuto'], ['odmítnuto pro zjevnou neopodstatněnost']. An invalid value returns the full menu.",
          ),
        petitioner: z
          .array(z.string())
          .max(6)
          .optional()
          .describe(
            "Petitioner type (OR): 'STĚŽOVATEL - FO', 'STĚŽOVATEL - PO', 'SKUPINA POSLANCŮ', 'SKUPINA SENÁTORŮ', 'SOUD', 'VLÁDA', 'VEŘEJNÝ OCHRÁNCE PRÁV'… Invalid value returns the full menu.",
          ),
        contested_organ_type: z
          .array(z.string())
          .max(6)
          .optional()
          .describe("Type of the organ whose act is contested (OR): 'SOUD', 'FINANČNÍ ÚŘAD / ŘEDITELSTVÍ', 'MINISTERSTVO / MINISTR'… Invalid value returns the full menu."),
        contested_organ: z
          .string()
          .optional()
          .describe("Contested organ specification, free text — e.g. 'Nejvyšší soud'."),
        contested_act_kind: z
          .array(z.string())
          .max(4)
          .optional()
          .describe("Kind of the contested act (OR): 'rozhodnutí soudu', 'rozhodnutí správní', 'zákon', 'obecně závazná vyhláška obce/kraje', 'opatření obecné povahy'… Invalid value returns the full menu."),
        contested_act_number: z
          .string()
          .optional()
          .describe("Number of the contested act, e.g. '106/1999' — with kind 'zákon' this is abstract-review lookup: every decision reviewing that act."),
        contested_act_name: z.string().optional().describe("Name of the contested act, free text."),
        contested_act_clause: z
          .string()
          .optional()
          .describe("Provision of the contested act, e.g. '§ 17' or 'čl. 36'."),
        sort: z
          .enum(["date", "relevance"])
          .default("date")
          .describe("date = newest first (default), relevance = NALUS 'význam' ranking for full-text queries."),
        page: z.number().int().min(0).default(0).describe("Result page (0-indexed, 20 hits per page)."),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            sz: z.string().nullable(),
            caseNumber: z.string(),
            ecli: z.string().optional(),
            judge: z.string().optional(),
            form: z.string().optional(),
            date: z.string().optional(),
            citation: z.string().optional(),
            url: z.string().nullable(),
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
    async ({ query, queries, case_number, ecli, judge, dissenting_judge, popular_name, date_from, date_to, published_from, published_to, types, only_published, include_dissents, outcome, petitioner, contested_organ_type, contested_organ, contested_act_kind, contested_act_number, contested_act_name, contested_act_clause, sort, page, read_top }) => {
      try {
        const variants = uniqueQueries(query, queries);
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined) => ({
          query: variant,
          citace: case_number,
          ecli,
          judge,
          dissentingJudge: dissenting_judge,
          popularName: popular_name,
          dateFrom: date_from,
          dateTo: date_to,
          publishedFrom: published_from,
          publishedTo: published_to,
          types,
          onlyPublished: only_published,
          includeDissents: include_dissents,
          outcome,
          petitioner,
          contestedOrganType: contested_organ_type,
          contestedOrgan: contested_organ,
          contestedActKind: contested_act_kind,
          contestedActNumber: contested_act_number,
          contestedActName: contested_act_name,
          contestedActClause: contested_act_clause,
          sort,
        });
        // One 3-step NALUS session per variant and page, in parallel. With
        // several variants each is read from its own top through this page,
        // merged round-robin, and the page is a slice of the merged list.
        const multi = keyed.length > 1;
        const start = page * 20;
        const { values, failures } = await runVariants(keyed, async (variant) => {
          if (!multi) return [await searchNalus(inputFor(variant), page)];
          const upstream = Array.from({ length: page + 1 }, (_, i) => i);
          return Promise.all(upstream.map((p) => searchNalus(inputFor(variant), p)));
        });
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const listOf = (pages: typeof answered[number]) => pages.flatMap((p) => p.hits);
        const totalOf = (pages: typeof answered[number]) => pages[0]?.total ?? null;
        const keyOf = (hit: { sz: string | null; caseNumber: string }) => hit.sz ?? hit.caseNumber;
        const merged = multi ? interleave(answered.map(listOf), keyOf) : listOf(answered[0]);
        const hits = (multi ? merged.slice(start, start + 20) : merged).slice(0, 20);
        const total = maxTotal(answered.map(totalOf));
        const empty = answered.every((pages) => pages.every((p) => p.empty)) && !hits.length;
        const previews = await buildPreviews(
          hits
            .slice(0, read_top)
            .filter((hit) => hit.sz)
            .map((hit) => ({ id: hit.sz as string, caseNumber: hit.caseNumber })),
          ({ id }) => getNalusDecision(id).then((d) => d.text),
          variants,
        );
        const hasMore = multi
          ? merged.length > start + 20 || answered.some((pages) => (totalOf(pages) ?? 0) > listOf(pages).length)
          : total !== null && start + 20 < total;
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
        // The citation line carries form, sp. zn., date and the SbNU/Sb.
        // reference in one — what a memo cites.
        const lines = hits.map(
          (hit, i) =>
            `${start + i + 1}. ${hit.citation ?? `${hit.caseNumber}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""}`} — sz ${hit.sz ?? "?"}${hit.url ? `\n   ${hit.url}` : ""}`,
        );
        const variantLine = variantTotals
          ? `Variants: ${keyed.map((v, i) => `"${v}" ${variantTotals[i] ?? "✗"}`).join(" · ")} (merged round-robin)`
          : null;
        const text = empty
          ? [
              "No Constitutional Court decisions matched. Broaden the criteria or check the citace format ('I. ÚS 123/20').",
              ...failureLines(failures),
            ].join("\n")
          : [
              ...failureLines(failures),
              ...(variantLine ? [variantLine] : []),
              `${total ?? "?"} decisions${multi ? " (best variant)" : ""}:`,
              ...lines,
              "Full text: us_get_decision {sz}.",
              ...renderPreviews(previews, "us_get_decision"),
            ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "us_get_decision",
    {
      title: "Ústavní soud: decision text",
      description:
        `Full text, abstract and právní věta of one Constitutional Court decision. Identify it by the NALUS 'sz' (e.g. '1-1169-26_1' from us_search) or by ECLI. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        sz: z.string().optional().describe("NALUS id: '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. 'Pl-24-10_1'."),
        ecli: z.string().optional().describe("Alternative: the decision's ECLI."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        sz: z.string(),
        url: z.string(),
        registrySign: z.string().optional(),
        form: z.string().optional(),
        popularName: z.string().optional(),
        legalSentence: z.string().optional(),
        abstract: z.string().optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ sz, ecli, find, page }) => {
      try {
        let identifier = sz;
        if (!identifier && ecli) identifier = ecliToSz(ecli) ?? undefined;
        if (!identifier) {
          throw new SourceError(
            "Ústavní soud (NALUS)",
            "INPUT_INVALID",
            "Neither a valid sz nor a resolvable ECLI was provided.",
            "Pass sz from us_search (e.g. '1-1169-26_1') or a full ECLI:CZ:US:… identifier.",
          );
        }
        const decision = await getNalusDecision(identifier);
        const paged = pageOrExcerpt(decision.text, page, find);
        const output = {
          sz: decision.sz,
          url: decision.url,
          registrySign: decision.registrySign,
          form: decision.form,
          popularName: decision.popularName,
          legalSentence: decision.legalSentence,
          abstract: decision.abstract,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        // The právní věta once, with the first page — not again with every
        // further page or `find` (it runs to thousands of characters).
        const firstRead = page === 1 && !find?.trim();
        // NALUS fills the abstract slot with a placeholder when it has none.
        const abstract = decision.abstract && !/^Abstrakt není k dispozici\.?$/i.test(decision.abstract.trim())
          ? decision.abstract
          : undefined;
        const header = [
          decision.registrySign,
          decision.form,
          decision.popularName ? `Populární název: ${decision.popularName}` : null,
          decision.url,
          firstRead && decision.legalSentence
            ? `Právní věta:\n${decision.legalSentence
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")}`
            : null,
          firstRead && abstract ? `Abstrakt:\n${abstract}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${paged.text}${continuationHint(paged)}`,
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
