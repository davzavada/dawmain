import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, nsBodyMissing, searchNs } from "@/src/sources/ns";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { dedupeBy, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";

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
        "FULL-TEXT search of Czech Supreme Court decisions (civil & criminal law: dovolání, sjednocující stanoviska) — plus spisová značka, kategorie rozhodnutí (A–E) and date range. Czech queries; 'queries' searches up to 3 variants IN PARALLEL and merges deduplicated results. Broad queries without dates often fail upstream (HTTP 500) and any query addresses at most its first 900 documents — narrow with dates. Results carry a UNID for ns_get_decision. read_top: N also returns excerpt previews of the N best hits.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query over decision bodies."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged (inflections, synonyms)."),
        case_number: z.string().optional().describe("Spisová značka, e.g. '23 Cdo 1234/2025'."),
        category: z
          .string()
          .regex(/^[A-Ea-e]$/)
          .optional()
          .describe("Kategorie rozhodnutí A–E (A = zásadní judikatura)."),
        date_from: isoDate.optional().describe("Published-to-web from (ISO)."),
        date_to: isoDate.optional().describe("Published-to-web to (ISO)."),
        limit: z.number().int().min(1).max(40).default(20),
        offset: z.number().int().min(0).max(880).default(0).describe("Offset within the 900-doc window."),
        read_top: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe("Fetch the N best hits' texts in parallel and return excerpts around the query."),
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
    async ({ query, queries, case_number, category, date_from, date_to, limit, offset, read_top }) => {
      try {
        const variants = uniqueQueries(query, queries);
        // One Domino request per variant, in parallel; merged and deduplicated.
        const results = await Promise.all(
          (variants.length ? variants : [undefined]).map((variant) =>
            searchNs(
              { query: variant, caseNumber: case_number, category, dateFrom: date_from, dateTo: date_to },
              offset,
              limit,
            ),
          ),
        );
        const page = {
          total: maxTotal(results.map((r) => r.total)),
          matched: maxTotal(results.map((r) => r.matched)),
          truncated: results.some((r) => r.truncated),
          appliedWindowFrom: results[0].appliedWindowFrom,
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
          (id) => getNsDecision(id).then((d) => d.text),
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
          ? ` Results limited to decisions published since ${page.appliedWindowFrom} (the NS server rejects unbounded queries) — pass date_from/date_to for another period.`
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
        "Full text and metadata (spisová značka, ECLI, právní věta, heslo, dotčené předpisy) of one Supreme Court decision, by the 32-hex UNID from ns_search. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        unid: z.string().regex(/^[0-9A-Fa-f]{32}$/, "32-hex UNID from ns_search"),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
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
        const output = {
          unid: decision.unid,
          url: decision.url,
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
          ? `${meta}\n\n(NS did not publish a machine-readable judgment body for this document — neither the WebPrint nor the WebSearch rendition carries it. Only metadata is available; open ${decision.url} in a browser to check for an attached PDF.)`
          : `${meta}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)` : ""}`;
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
