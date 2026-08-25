import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { caseNumberToCelex, getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { charPage } from "@/src/sources/shared/text";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("CJEU (InfoCuria)", error));
}

export function registerCuria(server: McpServer): void {
  server.registerTool(
    "curia_search",
    {
      title: "CJEU: search case law",
      description:
        "FULL-TEXT search of CJEU case law (Court of Justice 'C', General Court 'T') via the court's own live InfoCuria index — searches the TEXT of judgments/opinions plus metadata, includes same-day decisions. Also: case number (C-311/18), ECLI, parties (usual name), court filter, relevance/date sort. Fetch texts with curia_get_document.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords (any EU language; English works best)."),
        case_number: z.string().optional().describe("E.g. 'C-311/18' or 'T-655/17'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        parties: z.string().optional().describe("Usual name / parties, e.g. 'Schrems' or 'Google Spain'."),
        court: z.enum(["C", "T"]).optional().describe("C = Court of Justice, T = General Court."),
        sort: z.enum(["relevance", "date"]).default("relevance"),
        limit: z.number().int().min(1).max(20).default(10),
        page: z.number().int().min(0).default(0),
        language: z.string().default("en").describe("UI language for the search (en, cs, …)."),
      }),
      outputSchema: z.object({
        total: z.number(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            caseNumber: z.string().optional(),
            parties: z.string().optional(),
            ecli: z.string().optional(),
            date: z.string().optional(),
            docType: z.string().optional(),
            logicDocId: z.string().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, case_number, ecli, parties, court, sort, limit, page, language }) => {
      try {
        const result = await searchCuria(
          { query, caseNumber: case_number, ecli, parties, court, sort, language },
          page,
          limit,
        );
        const output = {
          total: result.total,
          count: result.hits.length,
          page,
          has_more: (page + 1) * limit < result.total,
          items: result.hits,
        };
        const lines = result.hits.map(
          (hit, i) =>
            `${page * limit + i + 1}. ${hit.caseNumber ?? "?"} ${hit.parties ?? ""}${hit.date ? ` (${hit.date})` : ""}${hit.ecli ? ` — ${hit.ecli}` : ""}`,
        );
        const text = result.hits.length
          ? [`${result.total} documents:`, ...lines].join("\n")
          : "No CJEU documents matched. Try English keywords or the exact case number.";
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "curia_get_document",
    {
      title: "CJEU: document text",
      description:
        "Full text of a CJEU judgment, order or AG opinion. Identify it by CELEX (62018CJ0311), ECLI (ECLI:EU:C:2020:559), or by case_number + doc_type (the CELEX is derived). For very recent documents not yet in Cellar, pass the logic_doc_id from curia_search. Long texts are paginated by characters.",
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX number, e.g. '62018CJ0311'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        parties: z.string().optional().describe("Usual name / parties, e.g. 'Schrems' or 'Google Spain'."),
        case_number: z.string().optional().describe("With doc_type, derives the CELEX. E.g. 'C-311/18'."),
        doc_type: z.enum(["judgment", "order", "opinion"]).default("judgment"),
        logic_doc_id: z.string().optional().describe("From curia_search, for very recent documents."),
        language: z.string().default("en").describe("Preferred language (cs, en, …); falls back to English."),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        via: z.enum(["cellar", "infocuria-blob"]),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, ecli, case_number, doc_type, logic_doc_id, language, page }) => {
      try {
        let resolvedCelex = celex;
        if (!resolvedCelex && case_number) {
          resolvedCelex = caseNumberToCelex(case_number, doc_type) ?? undefined;
        }
        if (!resolvedCelex && !ecli && !logic_doc_id) {
          throw new SourceError(
            "CJEU (InfoCuria)",
            "INPUT_INVALID",
            "No usable identifier provided.",
            "Pass celex, ecli, case_number (+doc_type), or logic_doc_id from curia_search.",
          );
        }
        const document = await getCuriaDocument({
          celex: resolvedCelex,
          ecli,
          logicDocId: logic_doc_id,
          language,
        });
        const paged = charPage(document.text, page);
        const output = {
          url: document.url,
          via: document.via,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${document.url} (via ${document.via})\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
