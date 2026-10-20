import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { FIND_DESCRIPTION, READING_DESCRIPTION, READ_ONLY, continuationHint, toolFailure } from "./shared";
import {
  CURRENT_PERIOD,
  MAX_LISTING_PAGES,
  PDF_PAGES_PER_CALL,
  PSP_PERIODS,
  SOURCE,
  getPspDocument,
  getPspTisk,
  getPspTiskText,
  periodLabel,
  periodsForYear,
  searchPsp,
  type PspSearchResult,
  type PspTisk,
} from "@/src/sources/psp";
import { SourceError } from "@/src/sources/shared/errors";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure(SOURCE);

const PERIOD_TABLE = PSP_PERIODS.map((p) => `${p.period} = ${p.from}–${p.to ?? "dosud"}`).join(", ");

const periodSchema = z
  .number()
  .int()
  .min(1)
  .max(CURRENT_PERIOD)
  .describe(`Volební období (psp.cz 'o'): ${PERIOD_TABLE}. Default: the current one (${CURRENT_PERIOD}).`);

/** The text of a psp_search answer for one period. Pure — unit-tested. */
export function pspSearchText(result: PspSearchResult, args: { query?: string; number?: number; limit: number; page: number }): string {
  const { hits, period } = result;
  const offset = (args.page - 1) * args.limit;
  const shown = hits.slice(offset, offset + args.limit);
  const hasMore = hits.length > offset + args.limit;
  const scan = result.pagesScanned
    ? `listing pages read: ${result.pagesScanned}${result.listingTruncated ? ` of more — the scan stops at ${MAX_LISTING_PAGES} pages, so further tisky may exist: narrow the words or page on` : " (the whole listing)"}`
    : "";
  if (!shown.length) {
    if (offset > 0 && hits.length) return `No more tisky: the ${hits.length} matches end before page ${args.page} (pages 1–${Math.ceil(hits.length / args.limit)} hold them all).`;
    const what = args.number !== undefined ? `number ${args.number}` : `every word of "${args.query}" in its title`;
    return [
      `No sněmovní tisk in the ${periodLabel(period)} has ${what}${scan ? ` (${scan})` : ""}.`,
      "Words match as stems (the ending is optional), so try fewer, more distinctive words — the act's short name or the words of its official title — or another period: an act is debated in the period before its publication year, sometimes two (year → period table in the parameter description).",
    ].join(" ");
  }
  const lines = shown.map((hit, i) => {
    const meta = hit.cells.filter((cell) => cell.length <= 80).slice(0, 4);
    return `${offset + i + 1}. Tisk ${hit.number} (${hit.period}. období) — ${snippet(hit.title, 200)}${meta.length ? ` · ${meta.join(" · ")}` : ""}\n   ${hit.url}`;
  });
  const head =
    args.number !== undefined
      ? `Sněmovní tisk ${args.number}, ${periodLabel(period)}:`
      : `${hits.length}${result.listingTruncated ? "+" : ""} sněmovní tisky with every word of "${args.query}" in the ${periodLabel(period)} — hits ${offset + 1}–${offset + shown.length} (page ${args.page}; ${scan}):`;
  return [
    head,
    ...lines,
    ...(hasMore ? [`More: page: ${args.page + 1} (same arguments).`] : []),
    `Next: psp_get_tisk {period: ${period}, number: N} — the legislative history and the documents (návrh zákona, důvodová zpráva, rozdílová tabulka, RIA, platné znění s vyznačením změn, usnesení výborů); psp_get_text {period: ${period}, number: N} — the text of the tisk itself (a bill with its důvodová zpráva).`,
  ].join("\n");
}

/** The text of a psp_get_tisk answer. Pure — unit-tested. */
export function pspTiskText(tisk: PspTisk, body: string): string {
  const docs = tisk.documents.map((doc, i) => {
    const call = doc.part
      ? `psp_get_text {period: ${doc.part.period}, number: ${doc.part.number}, part: ${doc.part.part}}`
      : doc.documentId !== undefined
        ? `psp_get_text {document_id: ${doc.documentId}}`
        : "(open the link — not readable here)";
    return `${i + 1}. [${doc.kind}] ${snippet(doc.label, 160)} (${doc.format}) → ${call}\n   ${doc.url}`;
  });
  return [
    `Sněmovní tisk ${tisk.number}, ${periodLabel(tisk.period)} — ${tisk.title}`,
    tisk.url,
    "",
    body,
    "",
    docs.length
      ? `Documents (${docs.length}) — the důvodová zpráva of a government bill is usually inside the tisk's own text (part 0), the rozdílová tabulka, RIA and platné znění s vyznačením změn are attached files:\n${docs.join("\n")}`
      : "No document links on this page.",
  ].join("\n");
}

export function registerPsp(server: McpServer): void {
  server.registerTool(
    "psp_search",
    {
      title: "Poslanecká sněmovna: find sněmovní tisky",
      description:
        "Find sněmovní tisky (bills and other parliamentary prints) of the Poslanecká sněmovna on psp.cz by words of their TITLE, or by tisk number, within one volební období (or the periods of a given year). Not a full-text search: the Chamber indexes titles only — use the words of the act's official title or its short name ('občanský zákoník', 'zákoník práce novela'); words match as stems, so inflection does not matter. Each hit names the tisk number and period; psp_get_tisk then gives its legislative history and documents (důvodová zpráva, rozdílová tabulka, RIA, platné znění s vyznačením změn, usnesení výborů, pozměňovací návrhy), psp_get_text their texts. An act is debated in the period BEFORE its publication year (zákon č. 89/2012 Sb. = tisk 362 of the 6th period, 2011): pick the period from the year of the bill, or pass year and both periods of an election year are searched.",
      inputSchema: z.object({
        query: z.string().optional().describe("Words of the tisk's title, all required (stems: 'občansk zákoník' finds 'občanského zákoníku'; a trailing * is an explicit prefix)."),
        number: z.number().int().min(1).optional().describe("Exact číslo tisku (the 1234 of '1234/0') — answers from the tisk's own page, no title needed."),
        period: periodSchema.optional(),
        year: z.number().int().min(1993).max(2100).optional().describe("A calendar year instead of period: searches the period(s) sitting that year (two in an election year)."),
        limit: z.number().int().min(1).max(25).default(10),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        periods: z.array(
          z.object({
            period: z.number(),
            count: z.number(),
            pages_scanned: z.number(),
            listing_truncated: z.boolean(),
            items: z.array(z.object({ period: z.number(), number: z.number(), title: z.string(), cells: z.array(z.string()), url: z.string() })),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, number, period, year, limit, page }) => {
      try {
        if (!query?.trim() && number === undefined) {
          throw new SourceError(SOURCE, "INPUT_INVALID", "Neither query nor number was given.", "Pass title words (query) or a tisk number (number).");
        }
        let periods: number[];
        if (period !== undefined) periods = [period];
        else if (year !== undefined) {
          periods = periodsForYear(year);
          if (!periods.length) {
            throw new SourceError(SOURCE, "INPUT_INVALID", `psp.cz holds tisky from 1993 on; ${year} has no period.`, "Pass a year from 1993, or a period.");
          }
        } else periods = [CURRENT_PERIOD];
        const needed = page * limit + 1;
        const settled = await Promise.allSettled(periods.map((p) => searchPsp({ query, number, period: p }, needed)));
        const texts: string[] = [];
        const output: Array<{ period: number; count: number; pages_scanned: number; listing_truncated: boolean; items: PspSearchResult["hits"] }> = [];
        settled.forEach((outcome, i) => {
          if (outcome.status === "fulfilled") {
            const result = outcome.value;
            texts.push(pspSearchText(result, { query, number, limit, page }));
            output.push({ period: result.period, count: result.hits.length, pages_scanned: result.pagesScanned, listing_truncated: result.listingTruncated, items: result.hits });
          } else {
            const error = outcome.reason;
            // One period's failure is named while the other answers; a lone period fails outright.
            if (periods.length === 1) throw error;
            const message = error instanceof Error ? error.message : String(error);
            texts.push(`${periodLabel(periods[i])}: failed — ${message}`);
          }
        });
        return { content: [{ type: "text", text: texts.join("\n\n") }], structuredContent: { periods: output } };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "psp_get_tisk",
    {
      title: "Poslanecká sněmovna: a tisk's legislative history and documents",
      description:
        "One sněmovní tisk from psp.cz: its title, the legislative process as the Chamber records it (předložení, 1.–3. čtení with dates, výbory and their usnesení, Senát, prezident, vyhlášení ve Sbírce zákonů) and every document attached — the tisk's own parts (text of the bill with its důvodová zpráva; usnesení výborů and pozměňovací návrhy as further parts) and the original files (rozdílová tabulka, RIA, platné znění s vyznačením navrhovaných změn, stanovisko vlády …), each with the psp_get_text call that reads it. Numbers and period come from psp_search (or from e-Sbírka/doctrine citations like 'sněmovní tisk 362/0, 6. volební období').",
      inputSchema: z.object({
        period: periodSchema,
        number: z.number().int().min(1).describe("Číslo tisku (the 1234 of '1234/0')."),
        page: z.number().int().min(1).default(1).describe("Page of the history text when it is long."),
      }),
      outputSchema: z.object({
        period: z.number(),
        number: z.number(),
        title: z.string(),
        url: z.string(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        documents: z.array(
          z.object({
            label: z.string(),
            kind: z.string(),
            format: z.string(),
            url: z.string(),
            part: z.object({ period: z.number(), number: z.number(), part: z.number() }).optional(),
            document_id: z.number().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ period, number, page }) => {
      try {
        const tisk = await getPspTisk(period, number);
        const paged = pageOrExcerpt(tisk.text, page);
        const output = {
          period: tisk.period,
          number: tisk.number,
          title: tisk.title,
          url: tisk.url,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          documents: tisk.documents.map(({ documentId, ...doc }) => ({ ...doc, ...(documentId !== undefined ? { document_id: documentId } : {}) })),
        };
        return {
          content: [{ type: "text", text: pspTiskText(tisk, `${paged.text}${continuationHint(paged)}`) }],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "psp_get_text",
    {
      title: "Poslanecká sněmovna: text of a tisk or an attached document",
      description:
        `Text from psp.cz: either a PART of a sněmovní tisk by period + number (+ part: 0 = the tisk as submitted — for a bill the návrh zákona followed by its DŮVODOVÁ ZPRÁVA, obecná and zvláštní část; further parts are usnesení výborů, pozměňovací návrhy, Senate returns) — or an ATTACHED ORIGINAL FILE by document_id (from psp_get_tisk: rozdílová tabulka, RIA, platné znění s vyznačením změn, stanovisko vlády), read as PDF (the first ${PDF_PAGES_PER_CALL} pages per call; pdf_pages for the rest), DOCX or HTML. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        period: periodSchema.optional(),
        number: z.number().int().min(1).optional().describe("Číslo tisku, with period."),
        part: z.number().int().min(0).default(0).describe("Podčíslo of the tisk's part (the 0 of '1234/0'); psp_get_tisk lists the parts."),
        document_id: z.number().int().min(1).optional().describe("The idd of an attached original document, from psp_get_tisk."),
        pdf_pages: z
          .string()
          .regex(/^\d+(?:-\d+)?$/)
          .optional()
          .describe(`PDF documents only: physical pages to convert, '61-120' or '61' (default 1-${PDF_PAGES_PER_CALL}; at most ${PDF_PAGES_PER_CALL} per call).`),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        format: z.string().optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional(),
        pdf: z.object({ pages: z.number(), range: z.tuple([z.number(), z.number()]) }).optional(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ period, number, part, document_id, pdf_pages, find, page }) => {
      try {
        if (document_id === undefined && number === undefined) {
          throw new SourceError(SOURCE, "INPUT_INVALID", "Neither document_id nor period + number was given.", "Pass period and number (a part of the tisk) or document_id (an attached file) from psp_get_tisk.");
        }
        if (document_id !== undefined) {
          const range = parsePdfPages(pdf_pages);
          const doc = await getPspDocument(document_id, range);
          const paged = pageOrExcerpt(doc.text, page, find);
          const notes: string[] = [];
          if (doc.pdf) {
            const [from, to] = doc.pdf.range;
            notes.push(`PDF: pages ${from}–${to} of ${doc.pdf.pages} converted${doc.pdf.warnings.length ? `; ${doc.pdf.warnings.join(" ")}` : ""}.`);
            if (to < doc.pdf.pages && !paged.has_more) {
              notes.push(`(continue without asking the user: pdf_pages: "${to + 1}-${Math.min(to + PDF_PAGES_PER_CALL, doc.pdf.pages)}")`);
            }
          }
          return {
            content: [{ type: "text", text: `${doc.url}${notes.length ? `\n${notes.join("\n")}` : ""}\n\n${paged.text}${continuationHint(paged)}` }],
            structuredContent: {
              url: doc.url,
              format: doc.format,
              page: paged.page,
              total_pages: paged.total_pages,
              has_more: paged.has_more,
              matches: paged.matches,
              ...(doc.pdf ? { pdf: { pages: doc.pdf.pages, range: doc.pdf.range } } : {}),
              text: paged.text,
            },
          };
        }
        if (period === undefined) {
          // Never guess the period: tisk 362 exists in every period, and the wrong one reads as the right one.
          throw new SourceError(SOURCE, "INPUT_INVALID", "number was given without period.", "Pass the period with the number (psp_search or psp_get_tisk name both), or document_id for an attached file.");
        }
        const text = await getPspTiskText(period, number!, part);
        const paged = pageOrExcerpt(text.text, page, find);
        return {
          content: [{ type: "text", text: `${text.url}\n\n${paged.text}${continuationHint(paged)}` }],
          structuredContent: { url: text.url, format: "html", page: paged.page, total_pages: paged.total_pages, has_more: paged.has_more, matches: paged.matches, text: paged.text },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}

/** "61-120" / "61" → [61, 120] / [61, 61 + PDF_PAGES_PER_CALL - 1], capped at PDF_PAGES_PER_CALL pages. Pure — unit-tested. */
export function parsePdfPages(spec: string | undefined): [number, number] {
  if (!spec) return [1, PDF_PAGES_PER_CALL];
  const [a, b] = spec.split("-").map(Number);
  const from = Math.max(1, a);
  const to = b === undefined ? from + PDF_PAGES_PER_CALL - 1 : Math.max(from, b);
  return [from, Math.min(to, from + PDF_PAGES_PER_CALL - 1)];
}
