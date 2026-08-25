import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getEurlexDocument, searchEurlex } from "@/src/sources/eurlex";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { charPage, snippet } from "@/src/sources/shared/text";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD");

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("EUR-Lex (Cellar)", error));
}

export function registerEurlex(server: McpServer): void {
  server.registerTool(
    "eurlex_search",
    {
      title: "EUR-Lex: search EU law",
      description:
        "Search EU legislation (regulations, directives, decisions) and CJEU case law through the official Publications Office Cellar SPARQL endpoint — the machine interface behind EUR-Lex. Matches TITLES, identifiers (CELEX/ECLI) and dates; document bodies are not full-text indexed here — for full-text search of CJEU judgments use curia_search. Fetch texts with eurlex_get_document (legislation) or curia_get_document (case law).",
      inputSchema: z.object({
        query: z.string().optional().describe("Title keywords, e.g. 'data protection'. English titles by default."),
        celex: z.string().optional().describe("Exact CELEX, e.g. '32016R0679' (GDPR)."),
        ecli: z.string().optional().describe("Exact ECLI, e.g. 'ECLI:EU:C:2020:559'."),
        types: z
          .array(z.enum(["regulation", "directive", "decision", "judgment", "order", "ag_opinion"]))
          .optional()
          .describe("Restrict document types. Default: all."),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        language: z.string().default("en").describe("Language of the titles searched (en, cs, …)."),
        limit: z.number().int().min(1).max(25).default(10),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: z.object({
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            celex: z.string(),
            title: z.string(),
            date: z.string().optional(),
            ecli: z.string().optional(),
            type: z.string().optional(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, celex, ecli, types, date_from, date_to, language, limit, offset }) => {
      try {
        const hits = await searchEurlex(
          { query, celex, ecli, types, dateFrom: date_from, dateTo: date_to, language },
          limit,
          offset,
        );
        const output = {
          count: hits.length,
          offset,
          // SPARQL has no cheap total count — a full page implies more rows.
          has_more: hits.length === limit,
          items: hits,
        };
        const lines = hits.map(
          (hit, i) =>
            `${offset + i + 1}. ${hit.celex}${hit.type ? ` [${hit.type}]` : ""}${hit.date ? ` ${hit.date}` : ""} — ${snippet(hit.title, 140)}\n   ${hit.url}`,
        );
        const text = hits.length
          ? [...lines, "Full text: eurlex_get_document {celex} (case law also via curia_get_document)."].join("\n")
          : "No EUR-Lex documents matched. This searches TITLES only — try the act's official name keywords, or use curia_search for full-text case-law search.";
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "eurlex_get_document",
    {
      title: "EUR-Lex: document text",
      description:
        "Full text of an EU legal act or judgment from the official Cellar dissemination API, by CELEX (e.g. '32016R0679' for GDPR) or ECLI. Prefers the requested language and falls back to English. Long texts are paginated by characters.",
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX, e.g. '32016R0679' or '62018CJ0311'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:EU:C:2020:559'."),
        language: z.string().default("en").describe("Preferred language (cs, en, …)."),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, ecli, language, page }) => {
      try {
        if (!celex && !ecli) {
          throw new SourceError(
            "EUR-Lex (Cellar)",
            "INPUT_INVALID",
            "Neither celex nor ecli was provided.",
            "Pass a CELEX (from eurlex_search) or an ECLI.",
          );
        }
        const document = await getEurlexDocument({ celex, ecli, language });
        const paged = charPage(document.text, page);
        const output = {
          url: document.url,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${document.url}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
