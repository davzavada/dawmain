import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, searchNs } from "@/src/sources/ns";
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
  return toToolError(error instanceof SourceError ? error : asSourceError("Nejvyšší soud", error));
}

export function registerNs(server: McpServer): void {
  server.registerTool(
    "ns_search",
    {
      title: "Nejvyšší soud: search decisions",
      description:
        "Search decisions of the Czech Supreme Court (civil & criminal law: dovolání, sjednocující stanoviska). Full-text queries are Czech. Any query addresses at most its first 900 documents — when 'truncated' is true, narrow with a date range. Results carry a UNID for ns_get_decision.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query over decision bodies."),
        case_number: z.string().optional().describe("Spisová značka, e.g. '23 Cdo 1234/2025'."),
        date_from: isoDate.optional().describe("Published-to-web from (ISO)."),
        date_to: isoDate.optional().describe("Published-to-web to (ISO)."),
        limit: z.number().int().min(1).max(40).default(20),
        offset: z.number().int().min(0).max(880).default(0).describe("Offset within the 900-doc window."),
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        matched: z.number().nullable().describe("True match count when the 900-doc window truncates."),
        truncated: z.boolean(),
        count: z.number(),
        offset: z.number(),
        items: z.array(
          z.object({ unid: z.string(), caseNumbers: z.array(z.string()), url: z.string() }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, case_number, date_from, date_to, limit, offset }) => {
      try {
        const page = await searchNs(
          { query, caseNumber: case_number, dateFrom: date_from, dateTo: date_to },
          offset,
          limit,
        );
        const output = {
          total: page.total,
          matched: page.matched,
          truncated: page.truncated,
          count: page.hits.length,
          offset,
          items: page.hits,
        };
        const lines = page.hits.map(
          (hit, i) => `${offset + i + 1}. ${hit.caseNumbers.join("; ")} — unid ${hit.unid}`,
        );
        const text = page.empty
          ? "No NS decisions matched. Broaden the query or the date range."
          : [
              `${page.total ?? "?"} decisions${page.truncated ? ` (window-capped; ${page.matched} match in total — narrow by date to see the rest)` : ""}:`,
              ...lines,
            ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "ns_get_decision",
    {
      title: "Nejvyšší soud: decision text",
      description:
        "Full text and metadata (spisová značka, ECLI, právní věta, heslo, dotčené předpisy) of one Supreme Court decision, by the 32-hex UNID from ns_search. Long texts are paginated by characters.",
      inputSchema: z.object({
        unid: z.string().regex(/^[0-9A-Fa-f]{32}$/, "32-hex UNID from ns_search"),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        unid: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ unid, page }) => {
      try {
        const decision = await getNsDecision(unid);
        const paged = charPage(decision.text, page);
        const output = {
          unid: decision.unid,
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
