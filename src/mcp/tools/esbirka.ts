import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  buildStaleUrl,
  getAct,
  getFragmentsPage,
  getHistory,
  getSection,
  searchActs,
} from "@/src/sources/esbirka";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { charPage, snippet } from "@/src/sources/shared/text";

/** MCP tools over the e-Sbírka client. Thin: schema → client call → shaping. */

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD")
  .describe("ISO date (YYYY-MM-DD).");

const actIdentity = {
  year: z.number().int().min(1918).max(2100).describe("Year of the act, e.g. 2012 for 89/2012 Sb."),
  number: z.number().int().min(1).describe("Number of the act, e.g. 89 for 89/2012 Sb."),
  collection: z
    .string()
    .default("sb")
    .describe("Collection code: 'sb' (Sbírka zákonů, default), 'sm' (mezinárodní smlouvy), …"),
};

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("e-Sbírka", error));
}

export function registerEsbirka(server: McpServer): void {
  server.registerTool(
    "esbirka_search",
    {
      title: "e-Sbírka: search legislation",
      description:
        "FULL-TEXT search of Czech legislation in the official e-Sbírka (Collection of Laws). Modes: all words (default), exact phrase, any word; optional excluded words and date range. Returns acts with their staleUrl identifiers (e.g. /sb/2012/89). Use Czech queries. For a known act number, prefer esbirka_get_act.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Czech full-text query, e.g. 'náhrada škody zaměstnance'."),
        match: z
          .enum(["all_words", "phrase", "any_word"])
          .default("all_words")
          .describe("How the query terms combine."),
        exclude_words: z.string().optional().describe("Words that must NOT occur."),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Subject date from (ISO)."),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Subject date to (ISO)."),
        limit: z.number().int().min(1).max(25).default(10).describe("Results per page."),
        offset: z.number().int().min(0).default(0).describe("Result offset for pagination."),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        count: z.number().int(),
        offset: z.number().int(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            staleUrl: z.string(),
            nazev: z.string(),
            kod: z.string().optional(),
            stav: z.string().optional(),
            datum: z.string().optional(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, match, exclude_words, date_from, date_to, limit, offset }) => {
      try {
        const result = await searchActs(query, offset, limit, {
          match,
          excludeWords: exclude_words,
          dateFrom: date_from,
          dateTo: date_to,
        });
        const output = {
          total: result.total,
          count: result.items.length,
          offset,
          has_more: offset + result.items.length < result.total,
          items: result.items.map((item) => ({ ...item, url: `https://e-sbirka.gov.cz${item.staleUrl}` })),
        };
        const lines = output.items.map(
          (item, i) =>
            `${offset + i + 1}. ${item.staleUrl} — ${snippet(item.nazev, 160)}${item.stav ? ` [${item.stav}]` : ""}\n   ${item.url}`,
        );
        const text = result.items.length
          ? `Found ${result.total} acts (showing ${offset + 1}–${offset + result.items.length}):\n${lines.join("\n")}`
          : `No acts matched "${query}". Try different Czech terms or the act's common name.`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "esbirka_get_act",
    {
      title: "e-Sbírka: act metadata & versions",
      description:
        "Metadata of one Czech act: official name, full citation, ELI, effective dates, and its history of time versions (znění). Identify the act by number/year, e.g. 89/2012 Sb. → number 89, year 2012.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Optional: describe the time version in force on this date."),
      }),
      outputSchema: z.object({
        staleUrl: z.string(),
        nazev: z.string(),
        uplnaCitace: z.string().optional(),
        eli: z.string().optional(),
        datumUcinnostiOd: z.string().optional(),
        typZneni: z.string().optional(),
        versions: z.array(
          z.object({
            datumUcinnostiOd: z.string().optional(),
            datumUcinnostiDo: z.string().optional(),
            typZneni: z.string().optional(),
            cisloZneni: z.number().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, collection, date }) => {
      try {
        const staleUrl = buildStaleUrl(collection, year, number, date);
        const [detail, history] = await Promise.all([
          getAct(staleUrl),
          getHistory(buildStaleUrl(collection, year, number)).catch(() => []),
        ]);
        const versions = history.map(({ staleUrl: _ignored, ...rest }) => rest);
        const output = { ...detail, staleUrl: detail.staleUrl || staleUrl, versions };
        const versionLines = versions
          .slice(0, 30)
          .map((v) => `  • od ${v.datumUcinnostiOd ?? "?"}${v.datumUcinnostiDo ? ` do ${v.datumUcinnostiDo}` : ""}${v.typZneni ? ` (${v.typZneni})` : ""}`);
        const text = [
          `${detail.nazev}`,
          detail.uplnaCitace ? `Citace: ${detail.uplnaCitace}` : null,
          `staleUrl: ${output.staleUrl}`,
          detail.datumUcinnostiOd ? `Účinnost od: ${detail.datumUcinnostiOd}` : null,
          versions.length ? `Znění (${versions.length}):\n${versionLines.join("\n")}${versions.length > 30 ? "\n  …" : ""}` : null,
          `Portál: https://e-sbirka.gov.cz${output.staleUrl}`,
          `Text: use esbirka_get_text with the same identifiers${date ? "" : " (add 'date' for a historical version)"}.`,
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "esbirka_get_text",
    {
      title: "e-Sbírka: consolidated text",
      description:
        "Consolidated text of a Czech act as of a date — either one section (§) or the whole act page by page. Pass 'section' (e.g. '§ 1721') to get just that provision; omit it to page through the full act. Without 'date' you get the current version; '0000-00-00' means the as-announced version.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Time version in force on this date. Omit for current."),
        section: z
          .string()
          .optional()
          .describe("One section, e.g. '§ 12' or '12' or '3a'. Omit for the whole act."),
        page: z.number().int().min(1).default(1).describe("Page of the act text (ignored with 'section')."),
      }),
      outputSchema: z.object({
        staleUrl: z.string(),
        url: z.string(),
        section: z.string().optional(),
        page: z.number().int(),
        total_pages: z.number().int(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, collection, date, section, page }) => {
      try {
        const staleUrl = buildStaleUrl(collection, year, number, date);
        if (section) {
          const result = await getSection(collection, year, number, date, section);
          const paged = charPage(result.text, 1);
          const output = {
            staleUrl,
            url: `https://e-sbirka.gov.cz${staleUrl}`,
            section,
            page: 1,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            text: paged.text,
          };
          return {
            content: [{ type: "text", text: `${staleUrl} ${section} (via ${result.via}):\n\n${paged.text}` }],
            structuredContent: output,
          };
        }

        // Whole act: upstream fragment pages are fixed-size — expose them 1:1.
        const upstream = await getFragmentsPage(staleUrl, page - 1);
        const text = upstream.fragments
          .map((fragment) => {
            const heading =
              fragment.kodTypuFragmentu === "Paragraf" && fragment.zkracenaCitace
                ? `\n${fragment.zkracenaCitace}\n`
                : "";
            return heading + fragment.text;
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        const output = {
          staleUrl,
          url: `https://e-sbirka.gov.cz${staleUrl}`,
          page,
          total_pages: upstream.totalPages,
          has_more: page < upstream.totalPages,
          text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${staleUrl} — text page ${page}/${upstream.totalPages}:\n\n${text}${output.has_more ? `\n\n(continue with page: ${page + 1})` : ""}`,
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
