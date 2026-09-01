import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  continuationHint,
  isoDate,
  toolFailure,
} from "./shared";
import { getJusticeDecision, listJusticeDecisions } from "@/src/sources/justice";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure("rozhodnuti.justice.cz");

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
            url: z.string(),
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
          items: result.items.map(({ autor: _autor, zminenaUstanoveni: _z, ...item }) => ({
            ...item,
            url: `https://rozhodnuti.justice.cz/rozhodnuti/?id=${item.uuid}`,
          })),
        };
        const lines = result.items.map(
          (item, i) =>
            `${i + 1}. ${item.jednaciCislo ?? "?"} — ${item.soud ?? "?"}${item.predmetRizeni ? ` — ${snippet(item.predmetRizeni, 90)}` : ""} — uuid ${item.uuid}\n   https://rozhodnuti.justice.cz/rozhodnuti/?id=${item.uuid}`,
        );
        const text = result.items.length
          ? [
              `${result.items.length} decisions (window ${date_from}..${date_to}${result.truncated ? "; page budget hit — narrow the window or filters" : ""}):`,
              ...lines,
              "Full text: justice_get_decision {uuid}.",
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
        `Full anonymized text of one general-court decision by its UUID from justice_list_decisions. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        uuid: z.string().uuid().describe("Decision UUID from justice_list_decisions."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        uuid: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.unknown()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ uuid, find, page }) => {
      try {
        const decision = await getJusticeDecision(uuid);
        const paged = pageOrExcerpt(decision.text, page, find);
        const output = {
          uuid: decision.uuid,
          url: decision.url,
          metadata: decision.metadata,
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
              text: `${decision.url}\n\n${paged.text}${continuationHint(paged)}`,
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
