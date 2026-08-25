import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ecliToSz, getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { charPage } from "@/src/sources/shared/text";

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
        "Search decisions of the Czech Constitutional Court (nálezy, usnesení, stanoviska pléna) in NALUS. Full-text queries are Czech. Search by citace (sp. zn. like 'Pl. ÚS 24/10'), ECLI, date range, or free text. Each hit carries an 'sz' identifier for nalus_get_decision. Costs 3 upstream requests per page.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query (právní věta, výrok, odůvodnění…)."),
        case_number: z.string().optional().describe("Citace / sp. zn., e.g. 'Pl. ÚS 24/10' or 'I. ÚS 1169/26'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:CZ:US:2026:1.US.1169.26.1'."),
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
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, case_number, ecli, date_from, date_to, types, page }) => {
      try {
        const result = await searchNalus(
          { query, citace: case_number, ecli, dateFrom: date_from, dateTo: date_to, types },
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
            `${page * 20 + i + 1}. ${hit.caseNumber}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""} — sz ${hit.sz ?? "?"}`,
        );
        const text = result.empty
          ? "No Constitutional Court decisions matched. Broaden the criteria or check the citace format ('I. ÚS 123/20')."
          : [`${result.total ?? "?"} decisions:`, ...lines].join("\n");
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
        "Full text, abstract and právní věta of one Constitutional Court decision. Identify it by the NALUS 'sz' (e.g. '1-1169-26_1' from nalus_search) or by ECLI. Long texts are paginated by characters.",
      inputSchema: z.object({
        sz: z.string().optional().describe("NALUS id: '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. 'Pl-24-10_1'."),
        ecli: z.string().optional().describe("Alternative: the decision's ECLI."),
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
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ sz, ecli, page }) => {
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
        const paged = charPage(decision.text, page);
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
          text: paged.text,
        };
        const header = [
          decision.registrySign,
          decision.form,
          decision.popularName ? `Populární název: ${decision.popularName}` : null,
          decision.legalSentence ? `Právní věta: ${decision.legalSentence}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
