import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  continuationHint,
  readTopSchema,
  toolFailure,
} from "./shared";
import { caseNumberToCelex, getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError } from "@/src/sources/shared/errors";
import { dedupeBy, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, renderPreviews } from "./previews";

const fail = toolFailure("CJEU (InfoCuria)");

export function registerCuria(server: McpServer): void {
  server.registerTool(
    "curia_search",
    {
      title: "CJEU: search case law",
      description:
        "FULL-TEXT search of CJEU case law (Court of Justice 'C', General Court 'T') via the court's own live InfoCuria index — the advanced-search surface: text of judgments/opinions + metadata, case number (C-311/18), case/party name, ECLI, case status (closed/pending), document type, court and date filters, relevance/date sort. The text search matches EVERY language version at once — Czech phrases work directly. Two filters work even without keywords: cites_celex (+cites_article) finds decisions citing a given act or article in their grounds, and referred_from lists preliminary rulings referred by a given member state's courts (e.g. ['CZ']). Includes same-day decisions. 'queries' searches up to 3 variants IN PARALLEL and merges deduplicated results; read_top: N also returns excerpt previews of the N best hits. Fetch texts with curia_get_document.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords (any EU language; English works best)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged (synonyms, CS/EN terms)."),
        case_number: z.string().optional().describe("E.g. 'C-311/18' or 'T-655/17'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        parties: z
          .string()
          .optional()
          .describe("Case/party name, e.g. 'Telia Finland' — matched through document full text."),
        court: z.enum(["C", "T"]).optional().describe("C = Court of Justice, T = General Court."),
        state: z
          .enum(["all", "closed", "pending"])
          .default("all")
          .describe("Case status of the main proceedings (InfoCuria 'Case status')."),
        doc_type: z
          .enum(["any", "judgment", "opinion", "avis", "order", "request"])
          .default("any")
          .describe(
            "Restrict document kinds: judgment (incl. extracts/information), opinion = AG opinions, avis = Opinions of the Court (e.g. on international agreements), order, request = preliminary-ruling requests.",
          ),
        referred_from: z
          .array(
            z.enum([
              "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "EL", "HU", "IE", "IT",
              "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "UK", "XB",
            ]),
          )
          .max(10)
          .optional()
          .describe(
            "Only preliminary rulings referred by courts of these states — e.g. ['CZ'] for Czech references. EL = Greece, UK = pre-Brexit references, XB = Benelux Court of Justice. Works alone (no query needed) — combine with sort: 'date'.",
          ),
        cites_celex: z
          .string()
          .optional()
          .describe(
            "Only decisions citing this act in their grounds — CELEX number: directive 2004/48 = '32004L0048', GDPR = '32016R0679'. Works alone (no query needed); combine with sort: 'date' for the recent line.",
          ),
        cites_article: z.coerce
          .string()
          .optional()
          .describe("Narrow cites_celex to one article: '1', '17' or '17(2)'."),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Document date from (ISO)."),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Document date to (ISO)."),
        sort: z.enum(["relevance", "date"]).default("relevance"),
        limit: z.number().int().min(1).max(20).default(10),
        page: z.number().int().min(0).default(0),
        language: z.string().default("en").describe("UI language for the search (en, cs, …)."),
        read_top: readTopSchema,
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
            caseName: z.string().optional(),
            date: z.string().optional(),
            docType: z.string().optional(),
            stateCode: z.string().optional(),
            logicDocId: z.string().optional(),
            url: z.string().nullable(),
          }),
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
    async ({ query, queries, case_number, ecli, parties, court, state, doc_type, referred_from, cites_celex, cites_article, date_from, date_to, sort, limit, page, language, read_top }) => {
      try {
        const variants = uniqueQueries(query, queries);
        // One InfoCuria request per variant, in parallel; merged + deduped.
        const results = await Promise.all(
          (variants.length ? variants : [undefined]).map((variant) =>
            searchCuria(
              {
                query: variant,
                caseNumber: case_number,
                ecli,
                parties,
                court,
                state,
                docType: doc_type,
                referredFrom: referred_from,
                citesCelex: cites_celex,
                citesArticle: cites_article,
                dateFrom: date_from,
                dateTo: date_to,
                sort,
                language,
              },
              page,
              limit,
            ),
          ),
        );
        const result = {
          total: maxTotal(results.map((r) => r.total)) ?? 0,
          filtered: results.reduce((n, r) => n + r.filtered, 0),
          hits: dedupeBy(
            results.flatMap((r) => r.hits),
            // || not ??: empty-string ids must fall through like missing ones.
            (hit) => hit.ecli || hit.logicDocId || `${hit.caseNumber}|${hit.date}|${hit.docType}`,
          ).slice(0, limit),
        };
        const previewTargets = result.hits
          .slice(0, read_top)
          .map((hit) => ({
            id: hit.ecli || hit.logicDocId || "",
            caseNumber: hit.caseNumber ?? hit.caseName ?? "?",
          }))
          .filter((target) => target.id);
        const previews = await buildPreviews(
          previewTargets,
          ({ id }) =>
            getCuriaDocument(
              id.toUpperCase().startsWith("ECLI:") ? { ecli: id, language } : { logicDocId: id, language },
            ).then((d) => d.text),
          variants,
        );
        const output = {
          total: result.total,
          count: result.hits.length,
          page,
          has_more: (page + 1) * limit < result.total,
          items: result.hits,
          previews,
        };
        const lines = result.hits.map(
          (hit, i) =>
            `${page * limit + i + 1}. ${hit.caseNumber ?? "?"} ${hit.caseName ?? hit.parties ?? ""}${hit.docType ? ` [${hit.docType}]` : ""}${hit.date ? ` (${hit.date})` : ""}${hit.ecli ? ` — ${hit.ecli}` : ""}${hit.url ? `\n   ${hit.url}` : ""}`,
        );
        // total counts matching CASES (affairs); the listed items are the
        // documents (or bare case listings) inside them — say both.
        const text = result.hits.length
          ? [
              `${result.total} matching cases, showing ${result.hits.length} ${result.hits.some((h) => h.docType) ? "documents" : "case listings"}${variants.length > 1 ? ` (best of ${variants.length} variants, merged)` : ""}${result.filtered ? ` (${result.filtered} documents hidden by doc_type/state/date filters)` : ""}:`,
              ...lines,
              result.hits.some((h) => h.docType)
                ? "Full text: curia_get_document {ecli | case_number | logic_doc_id}."
                : "Case listings carry no document ids — fetch a case's documents with curia_search {case_number}, then texts with curia_get_document.",
              ...renderPreviews(previews, "curia_get_document"),
            ].join("\n")
          : result.total > 0
            ? `${result.total} cases matched but no document scored for this query — add keywords (query), a case_number or an ecli; party names alone need the full-text route (put the name in 'query' or 'parties').`
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
        `Full text of a CJEU judgment, order or AG opinion. Identify it by CELEX (62018CJ0311), ECLI (ECLI:EU:C:2020:559), or by case_number + doc_type (the CELEX is derived). For very recent documents not yet in Cellar, pass the logic_doc_id from curia_search. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX number, e.g. '62018CJ0311'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        case_number: z.string().optional().describe("With doc_type, derives the CELEX. E.g. 'C-311/18'. Party names alone cannot identify a document — resolve them via curia_search first."),
        doc_type: z.enum(["judgment", "order", "opinion"]).default("judgment"),
        logic_doc_id: z.string().optional().describe("From curia_search, for very recent documents."),
        language: z.string().default("en").describe("Preferred language (cs, en, …); falls back to English."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        via: z.enum(["cellar", "infocuria-blob"]),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, ecli, case_number, doc_type, logic_doc_id, language, find, page }) => {
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
        const paged = pageOrExcerpt(document.text, page, find);
        const output = {
          url: document.url,
          via: document.via,
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
              text: `${document.url} (via ${document.via})\n\n${paged.text}${continuationHint(paged)}`,
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
