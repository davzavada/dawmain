import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  assertDateRange,
  continuationHint,
  isoDate,
  toolFailure,
} from "./shared";
import { parsePdfPages } from "./psp";
import { SLOVLEX_SUDY } from "@/src/sources/slovlex-base";
import {
  SK_DECISION_FORMS,
  SK_DECISION_NATURES,
  SK_LAW_AREAS,
  getSkDecision,
  searchSkDecisions,
  type SkDatabase,
  type SkDecision,
  type SkSearchPage,
} from "@/src/sources/slovlex-judikatura";
import { PDF_PAGES_PER_CALL } from "@/src/sources/shared/documents";
import { callDeadline } from "@/src/sources/shared/clock";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure(SLOVLEX_SUDY);

/** The chained detail → file → conversion of one decision. */
const DECISION_BUDGET_MS = 30_000;

const DATABASE_LABEL: Record<SkDatabase, string> = {
  sudy: "všeobecné súdy SR",
  judikaty: "Zbierka stanovísk a rozhodnutí (judikáty)",
};

/**
 * The sk_judikatura_search answer text. Paging is 1-based like the
 * parameter; every hit names the call that opens it; a page past the end
 * says so instead of reading as "nothing found". Pure — unit-tested.
 */
export function skJudikaturaSearchText(result: SkSearchPage, { page, limit }: { page: number; limit: number }): string {
  const first = (page - 1) * limit + 1;
  if (!result.hits.length) {
    if (result.total === 0) {
      return result.database === "judikaty"
        ? 'No judikáty matched. The Zbierka is small (~2.9k decisions: NS SR to 2018, ÚS SR 1993–2014) — broaden the query (Slovak terms, a word stem), or search database: "sudy" for every decision of the všeobecné súdy.'
        : "No decisions matched. Query in Slovak terms (nájom, výpoveď, náhrada škody), drop a filter, or widen the dates.";
    }
    if (page > result.totalPages) {
      return `Page ${page} is past the end: ${result.total} decisions fill pages 1–${result.totalPages} at limit ${limit}. Call page: ${result.totalPages} or lower (same arguments).`;
    }
    return `${result.total} decisions matched, but page ${page} returned no readable rows${page < result.totalPages ? ` — try page: ${page + 1} (same arguments)` : ""}.`;
  }
  const lines = result.hits.map((hit, i) =>
    [
      `${first + i}. ${hit.case_number ?? "?"} — ${hit.court ?? "?"}${hit.type ? ` (${hit.type})` : ""}${hit.decided ? ` ${hit.decided}` : ""}`,
      hit.title ? `   ${snippet(hit.title, 200)}` : null,
      hit.judge ? `   sudca: ${hit.judge}` : null,
      `   ${hit.url}`,
      `   → sk_judikatura_get_decision {id: "${hit.id}"}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    `${result.total} decisions (${DATABASE_LABEL[result.database]}) by decision date, newest first — hits ${first}–${first + result.hits.length - 1} (page: ${page} of ${result.totalPages}):`,
    ...lines,
    ...(page < result.totalPages ? [`More: page: ${page + 1} (same arguments).`] : []),
  ].join("\n");
}

/** The decision's own metadata as text lines — clients read the text only. Pure — unit-tested. */
export function skDecisionHeader(decision: Omit<SkDecision, "text">): string[] {
  return [
    [decision.case_number ?? "?", decision.court, decision.type, decision.decided].filter(Boolean).join(" — "),
    decision.judge ? `Sudca: ${decision.judge}` : null,
    decision.nature ? `Povaha: ${decision.nature}` : null,
    decision.area ? `Oblasť: ${decision.area}` : null,
    decision.ecli ? `ECLI: ${decision.ecli}` : null,
    decision.references.length ? `Odkazované predpisy: ${decision.references.join("; ")}` : null,
    decision.document ? `Dokument: ${decision.document.name ?? "súbor"} — ${decision.document.url}` : null,
    decision.url,
  ].filter((line): line is string => Boolean(line));
}

export function registerSkJudikatura(server: McpServer): void {
  server.registerTool(
    "sk_judikatura_search",
    {
      title: "Slovensko: search court decisions (Slov-Lex)",
      description:
        'Search SLOVAK court decisions on Slov-Lex — only for Slovak law or a CZ/SK comparison, never the default for Czech research. database "sudy" (default) = every published decision of the všeobecné súdy SR (~4.7 M: okresné, krajské, NS SR, NSS SR) with full text in Slovak; "judikaty" = the curated Zbierka stanovísk a rozhodnutí (~2.9 k with a právna veta: NS SR to 2018 and Ústavný súd SR 1993–2014) — start there for settled law. Always ordered by decision date, newest first. Query in SLOVAK terms (nájom, výpoveď, náhrada škody); plain words are all required, "quotes" = exact phrase. court: "ns" (Najvyšší súd SR), "nss" (Najvyšší správny súd SR; sudy only), "us" (Ústavný súd SR; judikaty only), a sud_NNN id or a court name ("Krajský súd v Bratislave"). sudy only: ecli, form, nature, area and the citator applies_act "40/1964" (+ applies_section "§ 420 ods. 1") = decisions that CITE that act/unit. Hits carry the id for sk_judikatura_get_decision.',
      inputSchema: z.object({
        database: z
          .enum(["sudy", "judikaty"])
          .default("sudy")
          .describe('"sudy" = all decisions of the všeobecné súdy SR (incl. NS SR, NSS SR); "judikaty" = the curated Zbierka (právna veta; NS SR + ÚS SR).'),
        query: z.string().optional().describe('Slovak full-text query. Plain words = all required; "quoted words" = exact phrase.'),
        case_number: z.string().optional().describe("Spisová značka, e.g. '30Ek/2848/2026' or '6 Cdo 138/2016' (either spelling)."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:SK:OSBB:2026:6126457003.1' (sudy only)."),
        court: z
          .string()
          .optional()
          .describe('"ns" = Najvyšší súd SR, "nss" = Najvyšší správny súd SR (sudy), "us" = Ústavný súd SR (judikaty), a sud_NNN id, or a court name such as "Krajský súd v Košiciach" (sudy; an ambiguous name returns the candidates).'),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        form: z.enum(SK_DECISION_FORMS).optional().describe("Forma rozhodnutia (sudy only)."),
        nature: z.enum(SK_DECISION_NATURES).optional().describe("Povaha rozhodnutia, e.g. 'Zmeňujúce', 'Zrušujúce', 'Potvrdzujúce' (sudy only)."),
        area: z.enum(SK_LAW_AREAS).optional().describe("Oblasť právnej úpravy (sudy only)."),
        applies_act: z
          .string()
          .optional()
          .describe("Only decisions citing this act — 'číslo/rok', e.g. '40/1964' (Občiansky zákonník), '160/2015' (CSP), '311/2001' (Zákonník práce). Works without keywords. sudy only."),
        applies_section: z
          .string()
          .optional()
          .describe("Narrows applies_act to ONE unit, matched exactly: '§ 420' finds decisions citing § 420 as a whole, '§ 420 ods. 1' those citing that odsek — run both to cover a §. Články (Ústava) as 'čl. 46'. Requires applies_act."),
        limit: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).max(100_000).default(1).describe("Result page (1-based)."),
      }),
      outputSchema: z.object({
        total: z.number(),
        count: z.number(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            id: z.string(),
            case_number: z.string().optional(),
            court: z.string().optional(),
            judge: z.string().optional(),
            type: z.string().optional(),
            title: z.string().optional(),
            decided: z.string().optional(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ database, query, case_number, ecli, court, date_from, date_to, form, nature, area, applies_act, applies_section, limit, page }) => {
      try {
        assertDateRange(SLOVLEX_SUDY, date_from, date_to);
        const result = await searchSkDecisions(
          {
            database,
            query,
            caseNumber: case_number,
            ecli,
            court,
            dateFrom: date_from,
            dateTo: date_to,
            form,
            nature,
            area,
            appliesAct: applies_act,
            appliesSection: applies_section,
          },
          page,
          limit,
        );
        const output = {
          total: result.total,
          count: result.hits.length,
          page,
          total_pages: result.totalPages,
          has_more: page < result.totalPages,
          items: result.hits,
        };
        const sectionNote = applies_section
          ? `applies_section matches references to exactly "${applies_section}" — a decision citing only a narrower or wider unit (§ vs. § + ods.) is not in these results.`
          : null;
        const text = [sectionNote, skJudikaturaSearchText(result, { page, limit })].filter(Boolean).join("\n\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sk_judikatura_get_decision",
    {
      title: "Slovensko: decision text (Slov-Lex)",
      description: `Full text of one Slovak decision by its id from sk_judikatura_search: 'uuid:uuid' = a decision of the všeobecné súdy (its PDF from obcan.justice.sk, in windows of ${PDF_PAGES_PER_CALL} PDF pages — pdf_pages for the rest), a plain uuid = a judikát (právna veta, odôvodnenie). The header gives sp. zn., súd, sudca, forma, povaha, ECLI and the cited acts. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        id: z.string().min(1).describe("Decision id from sk_judikatura_search ('uuid:uuid' or uuid; its slov-lex.sk URL works too)."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
        pdf_pages: z
          .string()
          .regex(/^\d+(?:-\d+)?$/)
          .optional()
          .describe(`PDF decisions only: physical pages to convert, '61-120' or '61' (default 1-${PDF_PAGES_PER_CALL}; at most ${PDF_PAGES_PER_CALL} per call).`),
      }),
      outputSchema: z.object({
        id: z.string(),
        kind: z.enum(["sudy", "judikat"]),
        url: z.string(),
        case_number: z.string().optional(),
        court: z.string().optional(),
        decided: z.string().optional(),
        ecli: z.string().optional(),
        document_url: z.string().optional(),
        format: z.string().optional(),
        pdf: z.object({ pages: z.number(), range: z.tuple([z.number(), z.number()]) }).optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ id, find, page, pdf_pages }) => {
      try {
        const decision = await getSkDecision(id, { pdfRange: parsePdfPages(pdf_pages), deadlineAt: callDeadline(DECISION_BUDGET_MS) });
        const paged = pageOrExcerpt(decision.text, page, find);
        const notes: string[] = [];
        if (decision.pdf) {
          const [from, to] = decision.pdf.range;
          notes.push(`PDF: pages ${from}–${to} of ${decision.pdf.pages} converted${decision.pdf.warnings.length ? `; ${decision.pdf.warnings.join(" ")}` : ""}.`);
          if (to < decision.pdf.pages && !paged.has_more) {
            notes.push(`(continue without asking the user: pdf_pages: "${to + 1}-${Math.min(to + PDF_PAGES_PER_CALL, decision.pdf.pages)}")`);
          }
        } else if (pdf_pages) {
          notes.push("(pdf_pages ignored: a judikát is HTML, not a PDF.)");
        }
        const head = [...skDecisionHeader(decision), ...notes].join("\n");
        return {
          content: [{ type: "text", text: `${head}\n\n${paged.text}${continuationHint(paged)}` }],
          structuredContent: {
            id: decision.id,
            kind: decision.kind,
            url: decision.url,
            case_number: decision.case_number,
            court: decision.court,
            decided: decision.decided,
            ecli: decision.ecli,
            document_url: decision.document?.url,
            format: decision.format,
            ...(decision.pdf ? { pdf: { pages: decision.pdf.pages, range: decision.pdf.range } } : {}),
            page: paged.page,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            matches: paged.matches,
            text: paged.text,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
