import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getEurlexDocument, getLegislativeHistory, searchEurlex } from "@/src/sources/eurlex";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

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
        "Search EU legislation (regulations, directives, decisions), CJEU case law AND legislative materials (Commission proposals, communications, green/white papers, staff working documents, impact assessments, EESC/CoR opinions, EP and Council positions) through the official Publications Office Cellar SPARQL endpoint — the machine interface behind EUR-Lex. Matches TITLES, identifiers (CELEX/ECLI) and dates; document bodies are not full-text indexed here — for full-text search of CJEU judgments use curia_search. Fetch texts with eurlex_get_document (legislation and legislative materials) or curia_get_document (case law). For ALL travaux préparatoires of one act at once, use eurlex_legislative_history.",
      inputSchema: z.object({
        query: z.string().optional().describe("Title keywords, e.g. 'data protection'. English titles by default."),
        celex: z.string().optional().describe("Exact CELEX, e.g. '32016R0679' (GDPR) or '52012PC0011' (its proposal)."),
        ecli: z.string().optional().describe("Exact ECLI, e.g. 'ECLI:EU:C:2020:559'."),
        types: z
          .array(
            z.enum([
              "regulation",
              "directive",
              "decision",
              "judgment",
              "order",
              "ag_opinion",
              "proposal",
              "communication",
              "green_paper",
              "white_paper",
              "staff_working_document",
              "impact_assessment",
              "opinion",
              "ep_position",
              "council_position",
            ]),
          )
          .optional()
          .describe(
            "Restrict document types. Default: all. Legislative materials: proposal (COM proposals incl. explanatory memorandum), communication, green_paper, white_paper, staff_working_document (SWD/SEC), impact_assessment, opinion (EESC/CoR/EDPS — not AG opinions), ep_position (EP legislative resolutions), council_position (incl. statements of reasons).",
          ),
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
        "Full text of an EU legal act, judgment or legislative material from the official Cellar dissemination API, by CELEX (e.g. '32016R0679' for GDPR, '52012PC0011' for its proposal — a proposal's text opens with the explanatory memorandum) or ECLI. Prefers the requested language and falls back to English. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX, e.g. '32016R0679', '62018CJ0311' or '52012PC0011'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:EU:C:2020:559'."),
        language: z.string().default("en").describe("Preferred language (cs, en, …)."),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, ecli, language, find, page }) => {
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
        const paged = pageOrExcerpt(document.text, page, find);
        const output = {
          url: document.url,
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
              text: `${document.url}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)` : ""}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "eurlex_legislative_history",
    {
      title: "EUR-Lex: legislative history of an act",
      description:
        "All legislative materials (travaux préparatoires) of one EU act in a single call, from the official Cellar dossier of its interinstitutional procedure: the Commission proposal (with explanatory memorandum), impact assessments, EESC/CoR/EDPS opinions, EP positions, Council positions with statements of reasons, and the adopted act — each with CELEX, type, date, title and link, plus the procedure's number, legal basis and adopted/pending/withdrawn state. Anchor by the CELEX of the ADOPTED ACT or of ANY procedure document (e.g. 32016R0679 or 52012PC0011 both yield the GDPR dossier), or by the procedure reference. Read the texts with eurlex_get_document {celex}.",
      inputSchema: z.object({
        celex: z
          .string()
          .optional()
          .describe("CELEX of the adopted act or of any procedure document, e.g. '32016R0679' or '52012PC0011'."),
        procedure: z
          .string()
          .optional()
          .describe("Interinstitutional procedure reference, e.g. '2012/0011(COD)'."),
        language: z
          .string()
          .default("en")
          .describe("Language of the titles (cs, en, …); falls back to English where a version is missing."),
      }),
      outputSchema: z.object({
        count: z.number().describe("Number of dossiers (procedures) found."),
        truncated: z
          .boolean()
          .describe("True when the row cap was hit — the newest documents may be missing; the procedure page has the complete list."),
        dossiers: z.array(
          z.object({
            procedure: z.string().optional(),
            procedure_type: z.string().optional().describe("e.g. OLP = ordinary legislative procedure."),
            legal_basis: z.string().optional(),
            status: z.enum(["adopted", "pending", "withdrawn", "unknown"]),
            date_adopted: z.string().optional(),
            title: z.string().optional(),
            url: z.string().optional().describe("EUR-Lex procedure page."),
            documents: z.array(
              z.object({
                celex: z.string().optional(),
                type: z.string().optional().describe("Cellar resource-type code, e.g. PROP_REG, IMPACT_ASSESS, OPIN, RES_LEGIS, POSIT, REG."),
                date: z.string().optional(),
                title: z.string().optional(),
                url: z.string(),
              }),
            ),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, procedure, language }) => {
      try {
        const { dossiers, truncated } = await getLegislativeHistory({ celex, procedure, language });
        const output = { count: dossiers.length, truncated, dossiers };
        if (!dossiers.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No legislative dossier found. Not every act has one (some older or non-legislative acts) — check the CELEX, or search the materials directly: eurlex_search with types like ['proposal','opinion','impact_assessment'] and title keywords.",
              },
            ],
            structuredContent: output,
          };
        }
        const blocks = dossiers.map((dossier) => {
          const header = [
            `Procedure ${dossier.procedure ?? "?"}`,
            dossier.procedure_type ? `[${dossier.procedure_type}]` : "",
            dossier.status !== "unknown"
              ? `${dossier.status}${dossier.date_adopted ? ` ${dossier.date_adopted}` : ""}`
              : "",
            dossier.legal_basis ? `— legal basis: ${dossier.legal_basis}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const lines = dossier.documents.map(
            (doc, i) =>
              `${i + 1}. ${doc.celex ?? "(no CELEX)"}${doc.type ? ` [${doc.type}]` : ""}${doc.date ? ` ${doc.date}` : ""} — ${snippet(doc.title ?? "", 140) || "(untitled)"}\n   ${doc.url}`,
          );
          return [
            header,
            dossier.title ? snippet(dossier.title, 200) : "",
            dossier.url ?? "",
            ...lines,
          ]
            .filter(Boolean)
            .join("\n");
        });
        const text = [
          ...blocks,
          ...(truncated
            ? [
                "WARNING: the listing hit the row cap — the NEWEST documents may be missing. The procedure page above has the complete list.",
              ]
            : []),
          "Texts: eurlex_get_document {celex}. Documents without a CELEX (Council working documents) link to their Cellar record.",
        ].join("\n\n");
        return { content: [{ type: "text" as const, text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
