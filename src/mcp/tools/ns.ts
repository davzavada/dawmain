import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  continuationHint,
  isoDate,
  readTopSchema,
  toolFailure,
} from "./shared";
import { getNsDecision, nsBodyMissing, searchNs, withHighlight } from "@/src/sources/ns";
import {
  dedupeBy,
  maxTotal,
  narrowestWindow,
  pageOrExcerpt,
  uniqueQueries,
} from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";

const fail = toolFailure("Nejvyšší soud");

export function registerNs(server: McpServer): void {
  server.registerTool(
    "ns_search",
    {
      title: "Nejvyšší soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Court decisions (civil & criminal law: dovolání, sjednocující stanoviska), with the fields the NS search form exposes: spisová značka (exact), kategorie rozhodnutí A–E, typ rozhodnutí (rozsudek/usnesení/stanovisko), soud, decision date and publication date. The database also carries decisions of LOWER courts — they are in it because they were published in the Sbírka soudních rozhodnutí a stanovisek, so they carry comparable weight; keep them unless the user asked for NS only. Czech queries; 'query' accepts Domino full-text operators — AND / OR / NOT, \"exact phrase\", (grouping), wildcards (nájem*), proximity (NEAR, SENTENCE, PARAGRAPH) — so one precise expression beats several vague searches; 'queries' searches up to 3 variants IN PARALLEL and merges deduplicated results. case_number matches the značka itself, NOT decisions citing it — to find those, pass the značka as 'query'. A full-text search covers the WHOLE database by default (the server narrows to a 12-month, then 90-day window only if NS refuses, and says so in applied_window_from). Any query addresses at most its first 900 documents — 'matched' reports the true count, so narrow with dates, type or category to get inside the window rather than paging. Results carry a UNID for ns_get_decision, and their URLs open the decision with the query terms highlighted. read_top: N also returns excerpt previews of the N best hits.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query over decision bodies."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged (inflections, synonyms)."),
        case_number: z
          .string()
          .optional()
          .describe(
            "Spisová značka, e.g. '23 Cdo 116/2017' — matched field by field (senát/značka/číslo/rok), so it returns THAT decision, not the ones citing it.",
          ),
        category: z
          .string()
          .regex(/^[A-Ea-e]$/)
          .optional()
          .describe("Kategorie rozhodnutí A–E (A = zásadní judikatura ve Sbírce)."),
        type: z
          .enum(["rozsudek", "usnesení", "stanovisko"])
          .optional()
          .describe(
            "Typ rozhodnutí. Rozsudek = meritorní rozhodnutí; usnesení = převážně procesní (odmítnutí dovolání).",
          ),
        court: z
          .string()
          .optional()
          .describe(
            "Soud, e.g. 'Nejvyšší soud' or 'Vrchní soud v Praze'. The database also holds decisions of lower courts — they are in it because they were selected for the Sbírka, so leave this empty to keep them.",
          ),
        date_from: isoDate.optional().describe("Datum rozhodnutí from (ISO) — when the court decided."),
        date_to: isoDate.optional().describe("Datum rozhodnutí to (ISO)."),
        published_from: isoDate
          .optional()
          .describe(
            "Datum předání na web from (ISO) — for 'what has NS published lately'. For research prefer date_from/date_to: when the court decided is what a citation says, not when the web copy appeared.",
          ),
        published_to: isoDate.optional().describe("Datum předání na web to (ISO)."),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).max(899).default(0).describe("Offset within the 900-doc window."),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        matched: z.number().nullable().describe("True match count when the 900-doc window truncates."),
        truncated: z.boolean(),
        count: z.number(),
        offset: z.number(),
        applied_window_from: z
          .string()
          .nullable()
          .describe("When set, results were limited to this start date because no dates were given."),
        items: z.array(
          z.object({ unid: z.string(), caseNumbers: z.array(z.string()), url: z.string() }),
        ),
        previews: z
          .array(
            z.object({
              id: z.string(),
              caseNumber: z.string(),
              matches: z.number(),
              excerpt: z.string(),
            }),
          )
          .optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({
      query,
      queries,
      case_number,
      category,
      type,
      court,
      date_from,
      date_to,
      published_from,
      published_to,
      limit,
      offset,
      read_top,
    }) => {
      try {
        const variants = uniqueQueries(query, queries);
        // One Domino request per variant, in parallel; merged and deduplicated.
        const results = await Promise.all(
          (variants.length ? variants : [undefined]).map((variant) =>
            searchNs(
              {
                query: variant,
                caseNumber: case_number,
                category,
                // The field carries the Czech label with its initial capital.
                type: type && type.charAt(0).toUpperCase() + type.slice(1),
                court,
                dateFrom: date_from,
                dateTo: date_to,
                publishedFrom: published_from,
                publishedTo: published_to,
              },
              offset,
              limit,
            ),
          ),
        );
        const page = {
          total: maxTotal(results.map((r) => r.total)),
          matched: maxTotal(results.map((r) => r.matched)),
          truncated: results.some((r) => r.truncated),
          // Each variant falls back on its own, so the window must be reported
          // across ALL of them: naming only the first variant's would say
          // "whole archive" while two of three were quietly cut to 90 days.
          appliedWindowFrom: narrowestWindow(results.map((r) => r.appliedWindowFrom)),
          empty: results.every((r) => r.empty),
          hits: dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.unid,
          ).slice(0, limit),
        };
        const previews = await buildPreviews(
          page.hits
            .slice(0, read_top)
            .map((hit) => ({ id: hit.unid, caseNumber: hit.caseNumbers.join("; ") })),
          ({ id }) => getNsDecision(id).then((d) => d.text),
          variants,
        );
        const output = {
          total: page.total,
          matched: page.matched,
          truncated: page.truncated,
          count: page.hits.length,
          offset,
          applied_window_from: page.appliedWindowFrom,
          items: page.hits,
          previews,
        };
        const lines = page.hits.map(
          (hit, i) => `${offset + i + 1}. ${hit.caseNumbers.join("; ")} — unid ${hit.unid}\n   ${hit.url}`,
        );
        const windowNote = page.appliedWindowFrom
          ? ` Results limited to decisions decided since ${page.appliedWindowFrom} (the NS server rejects unbounded queries) — pass date_from/date_to for another period.`
          : "";
        const text = page.empty
          ? `No NS decisions matched.${windowNote} Broaden the query or the date range.`
          : [
              `${page.total ?? "?"} decisions${page.truncated ? ` (window-capped; ${page.matched} match in total — narrow by date to see the rest)` : ""}:${windowNote}`,
              ...lines,
              ...renderPreviews(previews, "ns_get_decision"),
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
        `Full text and metadata (spisová značka, ECLI, právní věta, heslo, dotčené předpisy) of one Supreme Court decision, by the 32-hex UNID from ns_search. The returned url opens the decision itself (and with 'find' it opens scrolled to the term) — cite that link, never a search URL. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        unid: z.string().regex(/^[0-9A-Fa-f]{32}$/, "32-hex UNID from ns_search"),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        unid: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ unid, find, page }) => {
      try {
        const decision = await getNsDecision(unid);
        const paged = pageOrExcerpt(decision.text, page, find);
        // With 'find', hand back a link that opens the document scrolled to the
        // term — a citation the reader can check in one click.
        const url = find ? withHighlight(decision.url, [find]) : decision.url;
        const output = {
          unid: decision.unid,
          url,
          metadata: decision.metadata,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        const meta = Object.entries(decision.metadata)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        // Never hand back a silent metadata echo — say plainly that NS has
        // no machine-readable body for this document.
        const text = nsBodyMissing(decision.text)
          ? `${meta}\n\n(NS did not publish a machine-readable judgment body for this document — neither the WebPrint nor the WebSearch rendition carries it. Only metadata is available; open ${url} in a browser to check for an attached PDF.)`
          : `${meta}\n\n${paged.text}${continuationHint(paged)}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
