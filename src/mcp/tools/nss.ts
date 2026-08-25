import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNssDecision, searchNss } from "@/src/sources/nss";
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
  return toToolError(error instanceof SourceError ? error : asSourceError("Nejvyšší správní soud", error));
}

export function registerNss(server: McpServer): void {
  server.registerTool(
    "nss_search",
    {
      title: "Nejvyšší správní soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Administrative Court decisions (kasační stížnosti — tax, immigration, public procurement, administrative law) — plus spisová značka/čj. and decision-date range. Czech queries. Page 1 returns up to 40 hits, later pages 20. Results carry a numeric document_id for nss_get_decision.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query."),
        case_number: z.string().optional().describe("Spisová značka / čj., e.g. '1 Afs 25/2024'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        page: z.number().int().min(1).default(1),
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
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, case_number, date_from, date_to, page }) => {
      try {
        const result = await searchNss(
          { query, caseNumber: case_number, dateFrom: date_from, dateTo: date_to },
          page,
        );
        const seen = page === 1 ? result.hits.length : 40 + (page - 1) * 20;
        const output = {
          total: result.total,
          count: result.hits.length,
          page: result.page,
          has_more: result.total !== null && seen < result.total,
          items: result.hits.map(({ citation: _citation, ...hit }) => hit),
        };
        const lines = result.hits.map(
          (hit, i) =>
            `${i + 1}. ${hit.caseNumber ?? "?"}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""} — id ${hit.id}`,
        );
        const text =
          result.total === 0 || (!result.hits.length && result.total === null)
            ? "No NSS decisions matched. Broaden the query or the date range."
            : [`${result.total ?? "?"} decisions (page ${result.page}):`, ...lines].join("\n");
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
        "Full text and metadata (ECLI, soudce zpravodaj, výrok, oblast úpravy) of one Supreme Administrative Court decision, by the numeric id from nss_search. Long texts are paginated by characters.",
      inputSchema: z.object({
        document_id: z.string().regex(/^\d+$/, "Numeric id from nss_search"),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        id: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ document_id, page }) => {
      try {
        const decision = await getNssDecision(document_id);
        const paged = charPage(decision.text, page);
        const output = {
          id: decision.id,
          url: decision.url,
          metadata: decision.metadata,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          text: paged.text,
        };
        const meta = Object.entries(decision.metadata)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${meta}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
