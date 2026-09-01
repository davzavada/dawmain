import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { FIND_DESCRIPTION, READ_ONLY, continuationHint, toolFailure } from "./shared";
import { getEuipoClwDocument, searchEuipoClw } from "@/src/sources/euipo-clw";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure("EUIPO eSearchCLW");

export function registerEuipoClw(server: McpServer): void {
  server.registerTool(
    "euipo_clw_search",
    {
      title: "EUIPO: search case law",
      description:
        "METADATA search (no full-text) of EUIPO decisions (Boards of Appeal, opposition, cancellation, examination) for trademarks, or the design line — filters: case number, IP right, type, trade-mark name, cited norm. Ordered newest-first; filters run client-side over the newest ~200 records only. For older decisions use the viewUrl deep link. Fetch text with euipo_clw_get_document using a hit's pdfUrl.",
      inputSchema: z.object({
        register: z.enum(["trademark", "design"]).default("trademark"),
        case_number: z.string().optional().describe("Substring, e.g. 'R 1933/2016-4' or 'B 3 250 868'."),
        ip_right: z.string().optional().describe("E.g. 'EUTM', 'RCD', 'IR designating the EU'."),
        type: z.string().optional().describe("OPPOSITION | CANCELLATION | EXAMINATION | APPEAL."),
        entity_name: z.string().optional().describe("Trade mark name substring."),
        norm: z.string().optional().describe("Cited norm substring, e.g. 'Article 8(1)(b) EUTMR'."),
        limit: z.number().int().min(1).max(25).default(10),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: z.object({
        numFound: z.number(),
        count: z.number(),
        scanned: z.number(),
        truncated: z.boolean(),
        items: z.array(
          z.object({
            uniqueSolrKey: z.string().optional(),
            caseNumber: z.string().optional(),
            type: z.string().optional(),
            ipRight: z.string().optional(),
            entityName: z.string().optional(),
            entityNumber: z.string().optional(),
            appealed: z.string().optional(),
            language: z.string().optional(),
            date: z.string().optional(),
            outcome: z.string().optional(),
            norms: z.array(z.string()).optional(),
            pdfUrl: z.string().optional(),
            viewUrl: z.string().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ register, case_number, ip_right, type, entity_name, norm, limit, offset }) => {
      try {
        const result = await searchEuipoClw(
          register,
          { caseNumber: case_number, ipRight: ip_right, type, entityName: entity_name, norm },
          offset,
          limit,
        );
        const output = {
          numFound: result.numFound,
          count: result.items.length,
          scanned: result.scanned,
          truncated: result.truncated,
          items: result.items,
        };
        const lines = result.items.map(
          (item, i) =>
            `${offset + i + 1}. ${item.caseNumber ?? "?"} [${item.type ?? "?"}] ${item.entityName ?? ""}${item.date ? ` (${item.date})` : ""} — ${snippet(item.outcome ?? "", 80)}${item.viewUrl ? `\n   ${item.viewUrl}` : ""}`,
        );
        const text = result.items.length
          ? [
              `${result.numFound} decisions in the register${result.truncated ? ` (filters scanned only the newest ${result.scanned} — refine or use viewUrl deep links)` : ""}:`,
              ...lines,
              "Full text: euipo_clw_get_document {pdf_url} (use the hit's pdfUrl).",
            ].join("\n")
          : `No decisions matched among the newest ${result.scanned} records. Filters here are client-side — loosen them or search the web UI: https://euipo.europa.eu/eSearchCLW/`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "euipo_clw_get_document",
    {
      title: "EUIPO: decision text (PDF)",
      description:
        "Download one EUIPO decision PDF (cookie handshake replayed server-side) and return its extracted text, paginated by characters. Word-format documents cannot be extracted — the tool returns their link instead.",
      inputSchema: z.object({
        pdf_url: z.string().url().describe("The pdfUrl from a euipo_clw_search hit."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        pdfUrl: z.string(),
        pdf_pages: z.number(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ pdf_url, find, page }) => {
      try {
        const document = await getEuipoClwDocument(pdf_url);
        const paged = pageOrExcerpt(document.text, page, find);
        const output = {
          pdfUrl: document.pdfUrl,
          pdf_pages: document.pages,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${document.pdfUrl} (${document.pages} PDF pages)\n\n${paged.text}${continuationHint(paged)}`,
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
