import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ecliToSz, getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { pageOrExcerpt } from "@/src/sources/shared/text";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD");

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("Ústavní soud (NALUS)", error));
}

export function registerNalus(server: McpServer): void {
  server.registerTool(
    "nalus_search",
    {
      title: "Ústavní soud: search NALUS",
      description:
        "FULL-TEXT search of Czech Constitutional Court decisions (nálezy, usnesení, stanoviska pléna) in NALUS — plus citace (sp. zn. like 'Pl. ÚS 24/10'), ECLI, soudce zpravodaj, populární název, date range and decision-type filters. Czech queries. Each hit carries an 'sz' identifier for nalus_get_decision. Costs 3 upstream requests per page.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query (právní věta, výrok, odůvodnění…)."),
        case_number: z.string().optional().describe("Citace / sp. zn., e.g. 'Pl. ÚS 24/10' or 'I. ÚS 1169/26'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:CZ:US:2026:1.US.1169.26.1'."),
        judge: z.string().optional().describe("Soudce zpravodaj, e.g. 'Wagnerová'."),
        popular_name: z.string().optional().describe("Populární název, e.g. 'Data retention'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        types: z
          .array(z.enum(["nález", "usnesení", "stanovisko"]))
          .optional()
          .describe("Restrict decision forms. Default: all."),
        page: z.number().int().min(0).default(0).describe("Result page (0-indexed, 20 hits per page)."),
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
      }),
      annotations: READ_ONLY,
    },
    async ({ query, case_number, ecli, judge, popular_name, date_from, date_to, types, page }) => {
      try {
        const result = await searchNalus(
          {
            query,
            citace: case_number,
            ecli,
            judge,
            popularName: popular_name,
            dateFrom: date_from,
            dateTo: date_to,
            types,
          },
          page,
        );
        const shown = (page + 1) * 20;
        const output = {
          total: result.total,
          count: result.hits.length,
          page,
          has_more: result.total !== null && shown < result.total,
          items: result.hits,
        };
        const lines = result.hits.map(
          (hit, i) =>
            `${page * 20 + i + 1}. ${hit.caseNumber}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""} — sz ${hit.sz ?? "?"}${hit.url ? `\n   ${hit.url}` : ""}`,
        );
        const text = result.empty
          ? "No Constitutional Court decisions matched. Broaden the criteria or check the citace format ('I. ÚS 123/20')."
          : [`${result.total ?? "?"} decisions:`, ...lines, "Full text: nalus_get_decision {sz}."].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "nalus_get_decision",
    {
      title: "Ústavní soud: decision text",
      description:
        "Full text, abstract and právní věta of one Constitutional Court decision. Identify it by the NALUS 'sz' (e.g. '1-1169-26_1' from nalus_search) or by ECLI. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        sz: z.string().optional().describe("NALUS id: '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. 'Pl-24-10_1'."),
        ecli: z.string().optional().describe("Alternative: the decision's ECLI."),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
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
            "Pass sz from nalus_search (e.g. '1-1169-26_1') or a full ECLI:CZ:US:… identifier.",
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
        const header = [
          decision.registrySign,
          decision.form,
          decision.popularName ? `Populární název: ${decision.popularName}` : null,
          decision.legalSentence
            ? `Právní věta:\n${decision.legalSentence
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)` : ""}`,
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
