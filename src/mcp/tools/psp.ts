import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { FIND_DESCRIPTION, READING_DESCRIPTION, READ_ONLY, continuationHint, toolFailure } from "./shared";
import {
  CURRENT_PERIOD,
  PDF_PAGES_PER_CALL,
  PSP_PERIODS,
  PSP_TYPES,
  RESULTS_PER_PAGE,
  SOURCE,
  getPspDocument,
  getPspTisk,
  getPspTiskText,
  mainDocument,
  periodLabel,
  periodsForYear,
  searchPsp,
  type PspDocument,
  type PspHit,
  type PspSearchResult,
  type PspTisk,
  type PspType,
} from "@/src/sources/psp";
import { SourceError } from "@/src/sources/shared/errors";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure(SOURCE);

const PERIOD_TABLE = PSP_PERIODS.map((p) => `${p.period} = ${p.from}–${p.to ?? "dosud"}`).join(", ");
const TYPE_KEYS = Object.keys(PSP_TYPES) as [PspType, ...PspType[]];
const TYPE_TABLE = TYPE_KEYS.map((key) => `${key} = ${PSP_TYPES[key][1]}`).join(", ");

const periodSchema = z
  .number()
  .int()
  .min(1)
  .max(CURRENT_PERIOD)
  .describe(`Volební období (psp.cz 'o'): ${PERIOD_TABLE}.`);

/** The one call that reads a document, for the answer texts. Pure. */
function readingCall(doc: PspDocument): string {
  if (doc.part) return `psp_get_text {period: ${doc.part.period}, number: ${doc.part.number}, part: ${doc.part.part}}`;
  if (doc.documentId !== undefined) return `psp_get_text {document_id: ${doc.documentId}}`;
  return "(open the link — not readable here)";
}

function documentLines(documents: PspDocument[]): string[] {
  return documents.map((doc, i) => `${i + 1}. [${doc.kind}] ${snippet(doc.label, 160)} (${doc.format}) → ${readingCall(doc)}\n   ${doc.url}`);
}

export interface SearchTextArgs {
  query?: string;
  number?: number;
  act?: string;
  /** The periods the answer is limited to (period or year given), else null = every period the site answered. */
  scope: number[] | null;
  /** Hits of other periods that the scope left out. */
  otherPeriods: number;
  limit: number;
  page: number;
}

/** The text of a psp_search answer. Pure — unit-tested. */
export function pspSearchText(hits: PspHit[], result: Pick<PspSearchResult, "total" | "truncated" | "pagesScanned">, args: SearchTextArgs): string {
  const offset = (args.page - 1) * args.limit;
  const shown = hits.slice(offset, offset + args.limit);
  const hasMore = hits.length > offset + args.limit;
  const criteria = [
    args.query?.trim() ? `title containing "${args.query.trim()}"` : "",
    args.number !== undefined ? `number ${args.number}` : "",
    args.act?.trim() ? `the bill of act ${args.act.trim()}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const where = args.scope ? ` in the ${args.scope.map(periodLabel).join(" and ")}` : "";
  const others = args.otherPeriods ? ` (+${args.otherPeriods} in other periods — call without period/year to see them)` : "";
  if (!shown.length) {
    if (offset > 0 && hits.length) return `No more tisky: the ${hits.length} matches end before page ${args.page} (pages 1–${Math.ceil(hits.length / args.limit)} hold them all).`;
    return [
      `No sněmovní tisk with ${criteria}${where}${others}.`,
      "The site filters titles by its own rule — a short phrase as it stands in the title works best ('občanský zákoník', 'zákoník práce'); try a shorter or differently inflected phrase, the Sbírka number of the act (act: \"89/2012\" — answers across periods), or another period: an act is debated in the period before its publication year.",
    ].join(" ");
  }
  const lines = shown.map((hit, i) => {
    const meta = hit.cells.filter((cell) => cell.length <= 80).slice(0, 4);
    return `${offset + i + 1}. Tisk ${hit.number}/${hit.part} (${hit.period}. období) — ${snippet(hit.title, 200)}${meta.length ? ` · ${meta.join(" · ")}` : ""}\n   ${hit.url}`;
  });
  const count = result.total !== null && result.total > hits.length ? `${result.total} (${hits.length} read)` : String(hits.length);
  const truncatedNote = result.truncated
    ? ` — the site counts more than the ${result.pagesScanned} results page(s) read (${RESULTS_PER_PAGE} rows each): narrow the criteria`
    : "";
  return [
    `${count} sněmovní tisky with ${criteria}${where}${others} — hits ${offset + 1}–${offset + shown.length} (page ${args.page})${truncatedNote}:`,
    ...lines,
    ...(hasMore ? [`More: page: ${args.page + 1} (same arguments).`] : []),
    "Next: psp_get_tisk {period, number} — the legislative history and the documents (návrh zákona, důvodová zpráva, rozdílová tabulka, RIA, platné znění s vyznačením změn, usnesení výborů); psp_get_text {period, number} — the text of the tisk itself (a bill with its důvodová zpráva).",
  ].join("\n");
}

/** The text of a psp_get_tisk answer. Pure — unit-tested. */
export function pspTiskText(tisk: PspTisk, body: string): string {
  const docs = documentLines(tisk.documents);
  return [
    `${tisk.title} (${periodLabel(tisk.period)})`,
    tisk.url,
    ...(tisk.asOf ? [tisk.asOf] : []),
    ...(tisk.stages ? [`Fáze: ${tisk.stages}`] : []),
    "",
    body,
    "",
    docs.length
      ? `Documents (${docs.length}) — part 0 is the bill with its důvodová zpráva (psp_get_text reads its file), further parts are stanoviska and usnesení; rozdílová tabulka, RIA and platné znění s vyznačením změn are files of the part (listed in its psp_get_text answer):\n${docs.join("\n")}`
      : "No document links on this page.",
    ...(tisk.amendedActsUrl ? [`Navržené změny předpisů (the acts this tisk amends): ${tisk.amendedActsUrl}`] : []),
  ].join("\n");
}

export function registerPsp(server: McpServer): void {
  server.registerTool(
    "psp_search",
    {
      title: "Poslanecká sněmovna: find sněmovní tisky",
      description:
        "Find sněmovní tisky (bills and other parliamentary prints) on psp.cz through the Chamber's own search form: by words of the tisk's TITLE (the site's 'Název tisku' filter — a short phrase as it stands in the title: 'občanský zákoník', 'zákoník práce'), by tisk number, or by the Sbírka number of the resulting act (act: '89/2012' — the one lookup that answers across all periods; the bill a statute came from, hence its důvodová zpráva). Not a full-text search of the texts. Each hit names the tisk number, its period, the druh tisku and the state or the Sbírka number; psp_get_tisk then gives the legislative history and documents (důvodová zpráva, rozdílová tabulka, RIA, platné znění s vyznačením změn, usnesení výborů, pozměňovací návrhy), psp_get_text their texts. Title and number searches are opened in one volební období: pass period, or year (an act is debated in the period BEFORE its publication year — zákon č. 89/2012 Sb. = tisk 362 of the 6th period, 2011; both periods of an election year are searched).",
      inputSchema: z.object({
        query: z.string().optional().describe("Název tisku contains this (the site's own title filter) — a short phrase as it appears in the title."),
        number: z.number().int().min(1).optional().describe("Exact číslo tisku (the 1234 of '1234/0')."),
        act: z.string().optional().describe("Sbírka citation of the resulting act, '221/2006' or '221/2006 Sb.' — finds the bill it came from, in whatever period."),
        period: periodSchema.optional().describe(`Volební období to search in: ${PERIOD_TABLE}. Default: the current one (${CURRENT_PERIOD}) — unless year is given.`),
        year: z.number().int().min(1993).max(2100).optional().describe("A calendar year instead of period: searches the period(s) sitting that year (two in an election year)."),
        types: z
          .array(z.enum(TYPE_KEYS))
          .optional()
          .describe(`Druh tisku — restrict to these (default: all): ${TYPE_TABLE}.`),
        only_pending: z.boolean().default(false).describe("Pouze neukončené — tisky still in the process."),
        limit: z.number().int().min(1).max(25).default(10),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        count: z.number(),
        truncated: z.boolean(),
        other_periods: z.number(),
        items: z.array(z.object({ period: z.number(), number: z.number(), part: z.number(), title: z.string(), cells: z.array(z.string()), url: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, number, act, period, year, types, only_pending, limit, page }) => {
      try {
        if (!query?.trim() && number === undefined && !act?.trim()) {
          throw new SourceError(SOURCE, "INPUT_INVALID", "Neither query, number nor act was given.", "Pass title words (query), a tisk number (number) or a Sbírka citation (act).");
        }
        // The period the form is opened in, and the periods the answer keeps.
        let contexts: number[];
        let scope: number[] | null;
        if (period !== undefined) {
          contexts = [period];
          scope = [period];
        } else if (year !== undefined) {
          contexts = periodsForYear(year);
          if (!contexts.length) {
            throw new SourceError(SOURCE, "INPUT_INVALID", `psp.cz holds tisky from 1993 on; ${year} has no period.`, "Pass a year from 1993, or a period.");
          }
          scope = contexts;
        } else {
          contexts = [CURRENT_PERIOD];
          // The act lookup answers across periods; a title search is kept to what the site gave.
          scope = null;
        }
        const needed = page * limit + 1;
        const results = await Promise.all(
          contexts.map((p) => searchPsp({ query, number, act, period: p, types, onlyPending: only_pending }, needed)),
        );
        const seen = new Set<string>();
        const merged: PspHit[] = [];
        for (const result of results) {
          for (const hit of result.hits) {
            const key = `${hit.period}/${hit.number}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(hit);
          }
        }
        const hits = scope ? merged.filter((hit) => scope!.includes(hit.period)) : merged;
        const otherPeriods = merged.length - hits.length;
        const totals = results.map((r) => r.total).filter((t): t is number => t !== null);
        const summary = {
          // The site's count covers every period it answered; once a period filter drops hits, only the kept ones can be counted.
          total: totals.length && !otherPeriods ? Math.max(...totals) : null,
          truncated: results.some((r) => r.truncated),
          pagesScanned: results.reduce((sum, r) => sum + r.pagesScanned, 0),
        };
        const text = pspSearchText(hits, summary, { query, number, act, scope, otherPeriods, limit, page });
        const offset = (page - 1) * limit;
        return {
          content: [{ type: "text", text }],
          structuredContent: { total: summary.total, count: hits.length, truncated: summary.truncated, other_periods: otherPeriods, items: hits.slice(offset, offset + limit) },
        };
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
        "One sněmovní tisk from psp.cz: its title, the legislative process as the Chamber records it (předložení, 1.–3. čtení with dates, výbory and their usnesení, Senát, prezident, vyhlášení ve Sbírce zákonů) the legislative-process schema (which stage is current), the acts it amends, and every document linked — the tisk's parts (0 = the bill with its důvodová zpráva; stanovisko vlády, usnesení výborů and pozměňovací návrhy as further parts), committee resolutions and the Parlamentní institut opinion — each with the psp_get_text call that reads it. The files of a part (rozdílová tabulka, RIA, platné znění s vyznačením změn) are listed by psp_get_text on that part. Number and period come from psp_search (or from citations like 'sněmovní tisk 362/0, 6. volební období').",
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
        as_of: z.string().optional(),
        stages: z.string().optional(),
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
        amended_acts_url: z.string().optional(),
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
          as_of: tisk.asOf,
          stages: tisk.stages,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          documents: tisk.documents.map(({ documentId, ...doc }) => ({ ...doc, ...(documentId !== undefined ? { document_id: documentId } : {}) })),
          amended_acts_url: tisk.amendedActsUrl,
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
        `Text from psp.cz: a PART of a sněmovní tisk by period + number (+ part: 0 = the tisk as submitted — for a bill the návrh zákona followed by its DŮVODOVÁ ZPRÁVA, obecná and zvláštní část, in one file; further parts are stanovisko vlády, usnesení výborů, pozměňovací návrhy), or an attached FILE by document_id. psp.cz keeps the text in files, not on the page: a part's answer reads the part's main file (the bill with its důvodová zpráva — DOCX whole, else PDF in windows of ${PDF_PAGES_PER_CALL} pages, pdf_pages for the rest) and lists the part's other files (rozdílová tabulka, RIA, platné znění s vyznačením změn, "Celý sněmovní tisk") with their document_id. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        period: periodSchema.optional(),
        number: z.number().int().min(1).optional().describe("Číslo tisku, with period."),
        part: z.number().int().min(0).default(0).describe("Podčíslo of the tisk's part (the 0 of '1234/0'); psp_get_tisk lists the parts."),
        document_id: z.number().int().min(1).optional().describe("The idd of an attached original document, from psp_get_tisk or a part's answer."),
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
        documents: z.array(z.object({ label: z.string(), kind: z.string(), format: z.string(), url: z.string(), document_id: z.number().optional() })).optional(),
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
        const result = await getPspTiskText(period, number!, part);
        const documents = result.documents.map(({ documentId, part: _part, ...doc }) => ({ ...doc, ...(documentId !== undefined ? { document_id: documentId } : {}) }));
        const files = result.documents.length ? `Files of this part:\n${documentLines(result.documents).join("\n")}` : "";
        if (result.text.trim()) {
          // A part with text on the page itself (none captured so far, kept for the day psp.cz sets one inline).
          const paged = pageOrExcerpt(result.text, page, find);
          const head = [result.url, result.title, paged.page === 1 && paged.mode === "page" ? files : ""].filter(Boolean).join("\n");
          return {
            content: [{ type: "text", text: `${head}\n\n${paged.text}${continuationHint(paged)}` }],
            structuredContent: { url: result.url, format: "html", page: paged.page, total_pages: paged.total_pages, has_more: paged.has_more, matches: paged.matches, documents, text: paged.text },
          };
        }
        const main = mainDocument(result.documents);
        if (!main?.documentId) {
          throw new SourceError(SOURCE, "NOT_FOUND", `psp.cz sets no text and links no readable file for tisk ${number}/${part} (${periodLabel(period)}).`, `Open ${result.url} yourself; psp_get_tisk lists the tisk's parts.`);
        }
        const range = parsePdfPages(pdf_pages);
        const doc = await getPspDocument(main.documentId, range);
        const paged = pageOrExcerpt(doc.text, page, find);
        const notes: string[] = [`Read from: ${snippet(main.label, 160)} (${doc.format.toUpperCase()}) — ${doc.url}`];
        if (doc.pdf) {
          const [from, to] = doc.pdf.range;
          notes.push(`PDF: pages ${from}–${to} of ${doc.pdf.pages} converted${doc.pdf.warnings.length ? `; ${doc.pdf.warnings.join(" ")}` : ""}.`);
          if (to < doc.pdf.pages && !paged.has_more) {
            notes.push(`(continue without asking the user: pdf_pages: "${to + 1}-${Math.min(to + PDF_PAGES_PER_CALL, doc.pdf.pages)}")`);
          }
        }
        const head = [result.url, result.title, ...notes, paged.page === 1 && paged.mode === "page" ? files : ""].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: `${head}\n\n${paged.text}${continuationHint(paged)}` }],
          structuredContent: {
            url: doc.url,
            format: doc.format,
            page: paged.page,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            matches: paged.matches,
            ...(doc.pdf ? { pdf: { pages: doc.pdf.pages, range: doc.pdf.range } } : {}),
            documents,
            text: paged.text,
          },
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
