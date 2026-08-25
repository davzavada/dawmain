import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getJusticeDecision, listJusticeDecisions } from "@/src/sources/justice";
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
  return toToolError(error instanceof SourceError ? error : asSourceError("rozhodnuti.justice.cz", error));
}

export function registerJustice(server: McpServer): void {
  server.registerTool(
    "justice_list_decisions",
    {
      title: "Obecné soudy: list decisions by date",
      description:
        "List decisions of Czech general courts (okresní, krajské, vrchní) from the Ministry of Justice open-data API. IMPORTANT LIMITATION: this source has NO server-side search — listings go strictly by PUBLICATION date (windows of at most 7 days), and 'court'/'keyword' are client-side filters over that window's metadata only. For full-text case-law research prefer cz_caselaw_search (NSS/NS/ÚS). Data starts 2020-10, mostly first-instance civil decisions; party names are anonymized. Recent days are backfilled — lists near today are not final.",
      inputSchema: z.object({
        date_from: isoDate.describe("Publication date from (ISO)."),
        date_to: isoDate.describe("Publication date to (ISO); window of at most 7 days."),
        court: z.string().optional().describe("Substring of the court name, e.g. 'Okresní soud v Mostě'."),
        keyword: z
          .string()
          .optional()
          .describe("Substring matched over jednací číslo, předmět řízení, keywords and cited provisions."),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: z.object({
        count: z.number(),
        days_walked: z.array(z.string()),
        pages_fetched: z.number(),
        truncated: z.boolean(),
        items: z.array(
          z.object({
            uuid: z.string(),
            jednaciCislo: z.string().optional(),
            soud: z.string().optional(),
            ecli: z.string().optional(),
            predmetRizeni: z.string().optional(),
            datumVydani: z.string().optional(),
            datumZverejneni: z.string().optional(),
            klicovaSlova: z.array(z.string()).optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ date_from, date_to, court, keyword, limit }) => {
      try {
        const result = await listJusticeDecisions(date_from, date_to, { court, keyword }, limit);
        const output = {
          count: result.items.length,
          days_walked: result.days_walked,
          pages_fetched: result.pages_fetched,
          truncated: result.truncated,
          items: result.items.map(({ autor: _autor, zminenaUstanoveni: _z, ...item }) => item),
        };
        const lines = result.items.map(
          (item, i) =>
            `${i + 1}. ${item.jednaciCislo ?? "?"} — ${item.soud ?? "?"}${item.predmetRizeni ? ` — ${snippet(item.predmetRizeni, 90)}` : ""} — uuid ${item.uuid}`,
        );
        const text = result.items.length
          ? [
              `${result.items.length} decisions (window ${date_from}..${date_to}${result.truncated ? "; page budget hit — narrow the window or filters" : ""}):`,
              ...lines,
            ].join("\n")
          : `No decisions matched in ${date_from}..${date_to}. Note this source lists by PUBLICATION date and holds mostly first-instance civil decisions from 2020-10 on.`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "justice_get_decision",
    {
      title: "Obecné soudy: decision text",
      description:
        "Full anonymized text of one general-court decision by its UUID from justice_list_decisions. Long texts are paginated by characters.",
      inputSchema: z.object({
        uuid: z.string().uuid().describe("Decision UUID from justice_list_decisions."),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        uuid: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.unknown()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ uuid, page }) => {
      try {
        const decision = await getJusticeDecision(uuid);
        const paged = charPage(decision.text, page);
        const output = {
          uuid: decision.uuid,
          url: decision.url,
          metadata: decision.metadata,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${decision.url}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
