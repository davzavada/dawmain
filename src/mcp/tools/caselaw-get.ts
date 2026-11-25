import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { SourceError } from "@/src/sources/shared/errors";
import { readJusticeDecision } from "./justice";
import { readUsDecision } from "./nalus";
import { readNsDecision } from "./ns";
import { readNssDecision } from "./nss";
import { outlineSchema, paragraphsSchema } from "./reading";
import { FIND_DESCRIPTION, READING_DESCRIPTION, READ_ONLY, toolFailure } from "./shared";

/**
 * caselaw_get_decision — one read tool for the four Czech case-law sources.
 *
 * There used to be four: caselaw_get_decision {source: "ns", id}, caselaw_get_decision (source: nss)
 * {document_id}, caselaw_get_decision (source: us) {sz | ecli} and caselaw_get_decision {source: "justice", id}.
 * They took the same reading parameters (page, find, paragraphs, outline) and
 * differed in the name of the id alone — four definitions the model carried in
 * every conversation (~4k characters) and four spellings of "the id" to get
 * right. Now the call names the court (`source`) and passes the id a hit gave,
 * as caselaw_citations already did. Each court's reader stays in its own file
 * (readNsDecision …); with the mirror configured the call is answered there
 * first (./mirror-route.ts), by the same name.
 *
 * The CJEU keeps sdeu_get_document: it is read by ECLI or logic_doc_id in a
 * chosen language, and has no numbered-paragraph reading.
 */

export const GET_SOURCES = ["ns", "nss", "us", "justice"] as const;
export type GetSource = (typeof GET_SOURCES)[number];

const LABEL: Record<GetSource, string> = {
  ns: "Nejvyšší soud",
  nss: "Nejvyšší správní soud",
  us: "Ústavní soud (NALUS)",
  justice: "rozhodnuti.justice.cz",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id as its court's reader takes it, or the refusal: an id of another
 * court's shape (an NS unid sent with source "nss") would otherwise go to the
 * court and come back as "not found" — after a request, and without saying
 * why. Pure — exported for the tests.
 */
export function decisionId(source: GetSource, raw: string): { unid: string } | { document_id: string } | { sz: string } | { ecli: string } | { uuid: string } | string {
  const id = raw.trim();
  switch (source) {
    case "ns":
      return /^[0-9A-Fa-f]{32}$/.test(id) ? { unid: id } : `"${id}" is not an NS id — source "ns" takes the 32-hex unid a hit gives (→ caselaw_get_decision source: ns, id: …).`;
    case "nss":
      return /^\d+$/.test(id) ? { document_id: id } : `"${id}" is not an NSS id — source "nss" takes the numeric id a hit gives.`;
    case "us":
      if (/^ECLI:/i.test(id)) return { ecli: id };
      return id ? { sz: id } : `source "us" takes the NALUS sz a hit gives ('Pl-24-10_1') or the decision's ECLI.`;
    case "justice":
      return UUID.test(id) ? { uuid: id } : `"${id}" is not a justice.cz id — source "justice" takes the uuid a hit gives.`;
  }
}

export function registerCaselawGet(server: McpServer): void {
  server.registerTool(
    "caselaw_get_decision",
    {
      title: "Case law: decision text",
      description: `Full text and metadata of one Czech court decision: source names the court's database — ns (Nejvyšší soud), nss (Nejvyšší správní soud and the krajské soudy in its index), us (Ústavní soud) or justice (okresní, krajské, vrchní soudy) — and id is the court's own id from a search hit. The answer carries the spisová značka, ECLI, date, právní věta where there is one, who cites the decision, and the link that opens the decision itself — cite that link, never a search URL (for ns with 'find' it opens at the found passage). ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        source: z.enum(GET_SOURCES).describe("The court's database: ns, nss, us (Ústavní soud) or justice (obecné soudy)."),
        id: z
          .string()
          .min(1)
          .max(120)
          .describe("The court's own id, as a search hit gives it: ns = 32-hex unid, nss = numeric id, us = NALUS sz ('Pl-24-10_1') or the ECLI, justice = uuid."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        paragraphs: paragraphsSchema,
        outline: outlineSchema,
        page: z.number().int().min(1).default(1),
      }),
      annotations: READ_ONLY,
    },
    async ({ source, id, find, paragraphs, outline, page }) => {
      const key = decisionId(source, id);
      if (typeof key === "string") {
        return toolFailure(LABEL[source])(new SourceError(LABEL[source], "INPUT_INVALID", key, "Pass the id exactly as the hit line gives it, with that hit's source."));
      }
      const read = { find, paragraphs, outline, page };
      if ("unid" in key) return readNsDecision({ ...key, ...read });
      if ("document_id" in key) return readNssDecision({ ...key, ...read });
      if ("uuid" in key) return readJusticeDecision({ ...key, ...read });
      return readUsDecision({ ...key, ...read });
    },
  );
}
