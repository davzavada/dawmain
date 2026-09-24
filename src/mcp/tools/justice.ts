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
  JUSTICE_COURT_CODES,
  JUSTICE_DOC_TYPES,
  formatCaseNumber,
  getJusticeDecision,
  searchJustice,
  type JusticeCaseNumber,
} from "@/src/sources/justice";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure("rozhodnuti.justice.cz");

/** Years searched when the caller gives no date and no spisová značka. */
export const DEFAULT_WINDOW_YEARS = 5;

/**
 * The decision-date floor applied when the call names no date of either kind
 * and no spisová značka: full text over the whole archive is what times out,
 * and a značka lookup must reach every year. Pure — unit-tested.
 */
export function defaultDecidedFrom(
  input: { date_from?: string; date_to?: string; published_from?: string; published_to?: string; case_number?: string },
  today: Date = new Date(),
): string | undefined {
  if (input.date_from || input.date_to || input.published_from || input.published_to || input.case_number) {
    return undefined;
  }
  const floor = new Date(today);
  floor.setUTCFullYear(floor.getUTCFullYear() - DEFAULT_WINDOW_YEARS);
  return floor.toISOString().slice(0, 10);
}

/** Czech names for the decision types, so the schema reads as law, not as enum. */
const TYPE_LABELS: Record<string, string> = {
  JUDGEMENT: "rozsudek",
  ORDER_T: "trestní příkaz",
  RESOLUTION: "usnesení",
};

/**
 * The decision's own metadata as text lines — the soud, značka, date, judge,
 * outcome, the provisions it applied and what it did to the decision below.
 * Clients read the text only, so none of this may live in structured output
 * alone. Pure — unit-tested.
 */
export function justiceDecisionHeader(metadata: Record<string, unknown>): string[] {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const type = str(metadata.type);
  const caseNumber = formatCaseNumber(metadata.caseNumber as JusticeCaseNumber | undefined);
  const solver = (metadata.solver ?? {}) as Record<string, unknown>;
  const judge = [solver.titlesBefore, solver.firstName, solver.lastName, solver.titlesAfter]
    .map(str)
    .filter(Boolean)
    .join(" ");
  const regulations = list(metadata.regulations)
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => `§ ${entry.paragraphNumber} ${entry.lexNumber}/${entry.lexYear}`)
    .filter((entry) => !entry.includes("undefined"));
  const affects = list(metadata.affectedDocs)
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => {
      const types = list(entry.affectedTypes ?? entry.types).join("/");
      const mark = formatCaseNumber(entry.caseNumber as JusticeCaseNumber | undefined);
      return [types, mark, str(entry.courtCode) ? `(${entry.courtCode})` : ""].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  return [
    [caseNumber ?? "?", str(metadata.courtCode), type ? (TYPE_LABELS[type] ?? type) : undefined, str(metadata.decisionAt)]
      .filter(Boolean)
      .join(" — "),
    str(metadata.ecli) ? `ECLI: ${metadata.ecli}` : null,
    str(metadata.caseSubject) ? `Předmět: ${metadata.caseSubject}` : null,
    judge ? `Soudce: ${judge}${str(solver.function) ? ` (${solver.function})` : ""}` : null,
    list(metadata.caseResultType).length ? `Výsledek: ${list(metadata.caseResultType).join(", ")}` : null,
    regulations.length ? `Aplikované předpisy: ${regulations.join("; ")}` : null,
    affects.length ? `Mění/potvrzuje: ${affects.join("; ")}` : null,
    str(metadata.publishedAt) ? `Zveřejněno: ${metadata.publishedAt}` : null,
  ].filter((line): line is string => Boolean(line));
}

export function registerJustice(server: McpServer): void {
  server.registerTool(
    "justice_search",
    {
      title: "Obecné soudy: search decisions",
      description:
        "FULL-TEXT search of Czech general-court decisions (okresní, krajské, vrchní — plus NS/NSS/ÚS copies) in the Ministry of Justice database. Czech queries; match: all_words (default), any_word, phrase. Also filters by spisová značka, court (court_codes), decision type, decision date, publication date, and — the citator these courts otherwise lack — applies_act '89/2012' + applies_section '§ 2201' finds decisions that APPLIED that provision, with no keywords at all. Hits carry a uuid for justice_get_decision, the výrok, and 'affects': what the decision did to the lower court's ruling (CHANGE/CONFIRM/CANCEL…). Data starts 2020-10, mostly first-instance civil decisions; party names are anonymized. With no date and no case_number the search covers only the LAST 5 YEARS of decisions (the response says so) — pass date_from: '2020-10-01' for the whole archive. Full text is SLOW upstream: multi-word queries and large result sets can exceed the time limit even with a date range, while one distinctive word plus a date window of months answers in about a second — search with 1–2 key terms, not a sentence, and narrow with dates/court_codes. For NS/NSS/ÚS case law prefer cz_caselaw_search, whose indexes are richer.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query over the decision texts."),
        match: z
          .enum(["all_words", "any_word", "phrase"])
          .default("all_words")
          .describe("How the query terms combine."),
        case_number: z
          .string()
          .optional()
          .describe("Spisová značka, e.g. '8 Co 60/2025' — matched field by field."),
        court_codes: z
          .array(z.string())
          .max(20)
          .optional()
          .describe(
            "Court codes (OR). OS… = okresní soud, OSPH01–10 = obvodní soudy pro Prahu, KS… = krajský, MS… = městský, VSOL/VSPH = vrchní, NS/NSS/US. E.g. ['KSBR','MSPH']. An invalid code returns the full list.",
          ),
        types: z
          .array(z.enum(JUSTICE_DOC_TYPES))
          .optional()
          .describe("JUDGEMENT = rozsudek, RESOLUTION = usnesení, ORDER_T = trestní příkaz."),
        date_from: isoDate
          .optional()
          .describe("Decision date from (ISO) — when the court decided. Omitted (with no other date and no case_number) = the last 5 years; '2020-10-01' = the whole archive."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe("Publication date from (ISO) — for monitoring what is newly published."),
        published_to: isoDate.optional().describe("Publication date to (ISO)."),
        applies_act: z
          .string()
          .optional()
          .describe(
            "Only decisions applying this act — 'číslo/rok', e.g. '89/2012' (o. z.), '99/1963' (o. s. ř.), '40/2009' (tr. zákoník). Works without keywords.",
          ),
        applies_section: z
          .string()
          .optional()
          .describe("Narrows applies_act to one §, e.g. '§ 2201' or '2201'. Requires applies_act."),
        sort: z
          .enum(["published", "decided"])
          .default("published")
          .describe("Newest first by publication date (default) or by decision date."),
        limit: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(0).default(0).describe("Result page (0-indexed)."),
      }),
      outputSchema: z.object({
        total: z.number(),
        count: z.number(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        default_date_from: z
          .string()
          .optional()
          .describe("Set when the 5-year default window was applied: the decision-date floor used."),
        items: z.array(
          z.object({
            uuid: z.string(),
            caseNumber: z.string().optional(),
            ecli: z.string().optional(),
            court: z.string().optional(),
            type: z.string().optional(),
            decidedAt: z.string().optional(),
            publishedAt: z.string().optional(),
            judge: z.string().optional(),
            subject: z.string().optional(),
            affects: z.array(
              z.object({
                caseNumber: z.string().optional(),
                court: z.string().optional(),
                date: z.string().optional(),
                types: z.array(z.string()),
              }),
            ),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({
      query,
      match,
      case_number,
      court_codes,
      types,
      date_from,
      date_to,
      published_from,
      published_to,
      applies_act,
      applies_section,
      sort,
      limit,
      page,
    }) => {
      try {
        const defaultFrom = defaultDecidedFrom({ date_from, date_to, published_from, published_to, case_number });
        const result = await searchJustice(
          {
            query,
            match,
            caseNumber: case_number,
            courtCodes: court_codes,
            types,
            decidedFrom: date_from ?? defaultFrom,
            decidedTo: date_to,
            publishedFrom: published_from,
            publishedTo: published_to,
            appliesAct: applies_act,
            appliesSection: applies_section,
            sort,
          },
          page,
          limit,
        );
        const output = {
          total: result.total,
          count: result.hits.length,
          page: result.page,
          total_pages: result.totalPages,
          has_more: result.page + 1 < result.totalPages,
          ...(defaultFrom ? { default_date_from: defaultFrom } : {}),
          // The výrok is often longer than a search result should carry; the
          // full text is one justice_get_decision away.
          items: result.hits.map(({ verdict: _verdict, ...hit }) => hit),
        };
        const lines = result.hits.map((hit, i) => {
          const affects = hit.affects
            .map((a) => `${a.types.join("/")} ${a.caseNumber ?? "?"} (${a.court ?? "?"})`)
            .join("; ");
          return [
            `${page * limit + i + 1}. ${hit.caseNumber ?? "?"} — ${hit.court ?? "?"}${hit.type ? ` (${TYPE_LABELS[hit.type] ?? hit.type})` : ""}${hit.decidedAt ? ` ${hit.decidedAt}` : ""}`,
            hit.subject ? `   ${snippet(hit.subject, 120)}` : null,
            affects ? `   mění/potvrzuje: ${affects}` : null,
            hit.verdict ? `   výrok: ${snippet(hit.verdict, 220)}` : null,
            `   uuid ${hit.uuid}\n   ${hit.url}`,
          ]
            .filter(Boolean)
            .join("\n");
        });
        const windowNote = defaultFrom
          ? `⚠ Default window: only decisions issued from ${defaultFrom} (the last ${DEFAULT_WINDOW_YEARS} years), because no date was given — older decisions (the archive starts 2020-10) are NOT in these results. For the whole archive pass date_from: "2020-10-01". Say this in the memo.`
          : null;
        const body = result.hits.length
          ? [
              `${result.total} decisions (page ${result.page + 1}/${result.totalPages}):`,
              ...lines,
              "Full text: justice_get_decision {uuid}.",
            ].join("\n")
          : "No decisions matched. This database starts 2020-10 and holds mostly first-instance civil decisions — broaden the query, widen the dates, or try cz_caselaw_search for NS/NSS/ÚS case law.";
        const text = windowNote ? `${windowNote}\n\n${body}` : body;
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
      description: `Full anonymized text of one general-court decision by its UUID from justice_search. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        uuid: z.string().uuid().describe("Decision UUID from justice_search."),
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
              text: `${[...justiceDecisionHeader(decision.metadata), decision.url].join("\n")}\n\n${paged.text}${continuationHint(paged)}`,
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
