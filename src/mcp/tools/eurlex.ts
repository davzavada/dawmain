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
import {
  type EurlexSearchPage,
  getEurlexDocument,
  getLegislativeHistory,
  searchEurlex,
} from "@/src/sources/eurlex";
import { SourceError } from "@/src/sources/shared/errors";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure("EUR-Lex (Cellar)");

/**
 * Procedure paperwork rather than material a reader argues from: Council
 * agenda items and cover notes, Council and EP agendas (the AI Act dossier
 * listed four COREPER/Council agendas and two untitled EP plenary agendas),
 * voting results, drafts listed anyway in their final form, the EP's
 * adopted-text and Cellar's act duplicates, OJ notices. In the GDPR dossier
 * they were 14 of 31 entries. The rapporteur's draft report
 * (REPORT_DRAFT_EP_CMT) stays listed: unlike ACT_DRAFT it is not the final
 * text in draft form but the EP's first position, with its own amendments.
 * Pure — unit-tested.
 */
const PAPERWORK_TYPE =
  /^(?:ITEM_|NOTE|AGENDA_|PLENARY_AGENDA_|VOTING_RES$|ACT_DRAFT$|STAT_REASON_DRAFT$|NOTICE$|ADOPT_TEXT$|ACT_LEGIS$)/;

export function isProcedurePaperwork(type: string | undefined): boolean {
  return Boolean(type && PAPERWORK_TYPE.test(type));
}

/** The paperwork, as the texts name it. */
const PAPERWORK_LABEL = "Council/EP agendas and agenda items, cover notes, voting results, drafts, duplicates";

/** The text of an eurlex_search answer. Pure — unit-tested. */
export function eurlexSearchText(
  page: EurlexSearchPage,
  args: { query?: string; celex?: string; ecli?: string; types?: string[]; date_from?: string; date_to?: string; limit: number; offset: number },
): string {
  const { hits, hasMore } = page;
  if (!hits.length) {
    if (args.offset > 0) {
      return `No more EUR-Lex documents: the matches end before offset ${args.offset} (earlier pages hold them all).`;
    }
    if (!args.query?.trim()) {
      const filtered = args.types?.length || args.date_from || args.date_to ? " within the given types/dates" : "";
      return `No EUR-Lex document has this ${args.celex?.trim() ? "CELEX" : "ECLI"}${filtered}. Check its form — CELEX like 32016R0679, 62018CJ0311 or 52012PC0011, ECLI like ECLI:EU:C:2020:559; a CJEU decision too recent for Cellar is in sdeu_search.`;
    }
    return "No EUR-Lex documents matched. This searches TITLES only — try the act's official name keywords, or use sdeu_search for full-text case-law search.";
  }
  const lines = hits.map(
    (hit, i) =>
      `${args.offset + i + 1}. ${hit.celex}${hit.type ? ` [${hit.type}]` : ""}${hit.date ? ` ${hit.date}` : ""} — ${snippet(hit.title, 140)}\n   ${hit.url}`,
  );
  return [
    ...lines,
    ...(hasMore ? [`More: offset: ${args.offset + args.limit} (same arguments).`] : []),
    "Full text: eurlex_get_document {celex} (case law also via sdeu_get_document).",
  ].join("\n");
}

export function registerEurlex(server: McpServer): void {
  server.registerTool(
    "eurlex_search",
    {
      title: "EUR-Lex: search EU law",
      description:
        "Search EU legislation (regulations, directives, decisions), CJEU case law AND legislative materials (Commission proposals, communications, green/white papers, staff working documents, impact assessments, EESC/CoR opinions, EP and Council positions) through the official Publications Office Cellar SPARQL endpoint — the machine interface behind EUR-Lex. Matches TITLES, identifiers (CELEX/ECLI) and dates; document bodies are not full-text indexed here — for full-text search of CJEU judgments use sdeu_search. Newest first; the answer says when there are more (offset). Fetch texts with eurlex_get_document (legislation and legislative materials) or sdeu_get_document (case law). For ALL travaux préparatoires of one act at once, use eurlex_get_history.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Title keywords, all required, e.g. 'data protection' or 'Regulation 2016/679'. A trailing * matches word starts of 4+ letters (protect*). English titles by default."),
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
              "implementing_act",
              "delegated_act",
            ]),
          )
          .optional()
          .describe(
            "Restrict document types. Default: all. regulation/directive/decision include Commission implementing and delegated acts (decision also framework decisions); implementing_act / delegated_act select only those. Legislative materials: proposal (COM proposals incl. explanatory memorandum), communication, green_paper, white_paper, staff_working_document (SWD/SEC), impact_assessment, opinion (EESC/CoR/EDPS — not AG opinions), ep_position (EP legislative resolutions), council_position (incl. statements of reasons).",
          ),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        language: z
          .string()
          .default("en")
          .describe("Language of the titles searched — any EU language (en, cs, de, …). A celex/ecli lookup finds the document even without a title in it."),
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
        const page = await searchEurlex(
          { query, celex, ecli, types, dateFrom: date_from, dateTo: date_to, language },
          limit,
          offset,
        );
        const output = {
          count: page.hits.length,
          offset,
          // SPARQL has no cheap total count — the query asks one work beyond the page.
          has_more: page.hasMore,
          items: page.hits,
        };
        const text = eurlexSearchText(page, { query, celex, ecli, types, date_from, date_to, limit, offset });
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
        `Full text of an EU legal act, judgment or legislative material from the official Cellar dissemination API, by CELEX (e.g. '32016R0679' for GDPR, '52012PC0011' for its proposal — a proposal's text opens with the explanatory memorandum) or ECLI. Prefers the requested language and falls back to English, saying so. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX, e.g. '32016R0679', '62018CJ0311' or '52012PC0011'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:EU:C:2020:559'."),
        language: z.string().default("en").describe("Preferred language — any EU language (cs, en, de, …)."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        language: z.string().describe("Language of the text served — English when the requested one has none."),
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
          language: document.language,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        // Said in the text: a memo quoting it must know the wording is not
        // the requested language version.
        const fallbackNote = document.fallback
          ? "\n(Cellar has no text of this document in the requested language — this is the English version.)"
          : "";
        return {
          content: [
            {
              type: "text",
              text: `${document.url}${fallbackNote}\n\n${paged.text}${continuationHint(paged)}`,
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
    "eurlex_get_history",
    {
      title: "EUR-Lex: legislative history of an act",
      description:
        `All legislative materials (travaux préparatoires) of one EU act in a single call, from the official Cellar dossier of its interinstitutional procedure: the Commission proposal (with explanatory memorandum), impact assessments, EESC/CoR/EDPS opinions, EP positions, Council positions with statements of reasons, and the adopted act — each with CELEX, type, date, title and link, plus the procedure's number, legal basis and adopted/pending/withdrawn state. Anchor by the CELEX of the ADOPTED ACT or of ANY procedure document (e.g. 32016R0679 or 52012PC0011 both yield the GDPR dossier), or by the procedure reference. Procedure paperwork (${PAPERWORK_LABEL}) is counted but not listed unless all: true. Read the texts with eurlex_get_document {celex}.`,
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
          .describe("Language of the titles — any EU language (cs, en, …); falls back to English where a version is missing."),
        all: z
          .boolean()
          .default(false)
          .describe(`Also list procedure paperwork (${PAPERWORK_LABEL}).`),
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
            omitted: z.number().describe("Procedure paperwork left out (all: true lists it)."),
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
    async ({ celex, procedure, language, all }) => {
      try {
        const history = await getLegislativeHistory({ celex, procedure, language });
        const truncated = history.truncated;
        const dossiers = history.dossiers.map((dossier) => {
          const documents = all ? dossier.documents : dossier.documents.filter((doc) => !isProcedurePaperwork(doc.type));
          return { ...dossier, omitted: dossier.documents.length - documents.length, documents };
        });
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
            dossier.omitted
              ? `(+${dossier.omitted} procedure paperwork — ${PAPERWORK_LABEL} — not listed; all: true lists them)`
              : "",
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
