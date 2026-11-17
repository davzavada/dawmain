import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { FIND_DESCRIPTION, READING_DESCRIPTION, READ_ONLY, continuationHint, toolFailure } from "./shared";
import { parsePdfPages } from "./psp";
import {
  LP_STAGES,
  SOURCE,
  findLpByAct,
  getLpDocumentText,
  getLpProcess,
  parseLpNumber,
  searchLp,
  type LpDocument,
  type LpHit,
  type LpProcess,
  type LpStage,
} from "@/src/sources/slovlex-lp";
import { PDF_PAGES_PER_CALL, type ExtractedDocument } from "@/src/sources/shared/documents";
import { SourceError } from "@/src/sources/shared/errors";
import { pageOrExcerpt, snippet } from "@/src/sources/shared/text";

const fail = toolFailure(SOURCE);

const STAGE_KEYS = Object.keys(LP_STAGES) as [LpStage, ...LpStage[]];
const STAGE_TABLE = STAGE_KEYS.map((key) => `${key} = ${LP_STAGES[key]}`).join(", ");

/** "25 kB" from bytes. Pure. */
function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/** One file line with the call that reads it. Pure. */
function documentLines(documents: LpDocument[]): string[] {
  return documents.map((doc, i) => {
    const size = sizeLabel(doc.size);
    return `${i + 1}. [${doc.kind}] ${doc.name}${size ? ` (${size})` : ""} → sk_lp_get_text {document_id: "${doc.documentId}"}`;
  });
}

export interface SkLpSearchArgs {
  query?: string;
  number?: string;
  act?: string;
  stage?: LpStage;
  limit: number;
  page: number;
}

/** The text of an sk_lp_search answer; `hits` is the page shown, `total` all matches. Pure — unit-tested. */
export function skLpSearchText(hits: LpHit[], total: number, args: SkLpSearchArgs, note?: string): string {
  const offset = (args.page - 1) * args.limit;
  const criteria = [
    args.query?.trim() ? `text "${args.query.trim()}"` : "",
    args.number?.trim() ? `number ${args.number.trim()}` : "",
    args.act?.trim() ? `published as act ${args.act.trim()}` : "",
    args.stage ? `stage ${LP_STAGES[args.stage]}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (!hits.length) {
    if (offset > 0 && total > 0) {
      return `No more processes: the ${total} matches end before page ${args.page} (pages 1–${Math.ceil(total / args.limit)} hold them all).`;
    }
    return [
      `No legislative process with ${criteria}.`,
      ...(note ? [note] : []),
      "query searches titles and the texts of the files (all words, any order; \"…\" = an exact phrase) — use Slovak terms ('pedagogických zamestnancoch', 'Občiansky zákonník'); number takes 'LP/2025/300'.",
    ].join(" ");
  }
  const lines = hits.map((hit, i) => {
    const since = hit.stageFrom ? ` od ${hit.stageFrom}` : "";
    const eu = hit.prefix === "LPEU" ? " (EU act consultation — open the link; sk_lp_get_process reads LP processes)" : "";
    return `${offset + i + 1}. ${hit.lp} — ${snippet(hit.title, 220)} [${hit.type}] · ${hit.stage}${since}${eu}\n   ${hit.url}`;
  });
  const hasMore = total > offset + hits.length;
  return [
    `${total} legislative process${total === 1 ? "" : "es"} with ${criteria} — hits ${offset + 1}–${offset + hits.length} (page ${args.page}), newest stage first:`,
    ...lines,
    ...(note ? [note] : []),
    ...(hasMore ? [`More: page: ${args.page + 1} (same arguments).`] : []),
    "Next: sk_lp_get_process {year, number} — submitter, MPK, stages with dates, the act it was published as, and its files; sk_lp_get_text {year, number} — the dôvodová správa.",
  ].join("\n");
}

/** The text of an sk_lp_get_process answer. Pure — unit-tested. */
export function skLpProcessText(process: LpProcess): string {
  const { detail, stages, documentsStage, documents } = process;
  const meta = [
    detail.type ? `Typ: ${detail.type}` : "",
    `Štádium: ${detail.stage}${detail.lastChange ? ` (posledná zmena ${detail.lastChange})` : ""}`,
  ].filter(Boolean);
  const who = [
    detail.submitter ? `Predkladateľ: ${detail.submitter}` : "",
    detail.institution ? `Inštitúcia: ${detail.institution}` : "",
    detail.ministryNumber ? `Rezortné číslo: ${detail.ministryNumber}` : "",
  ].filter(Boolean);
  const outcome = [
    detail.mpkFrom || detail.mpkTo ? `MPK: ${detail.mpkFrom ?? "?"} – ${detail.mpkTo ?? "?"}` : "",
    detail.nrsrResult ? `Výsledok NR SR: ${detail.nrsrResult}` : "",
    detail.endReason ? `Dôvod ukončenia: ${detail.endReason}` : "",
  ].filter(Boolean);
  const amended = [
    ...(detail.mainAmended ? [`${detail.mainAmended.citation} (hlavný)${detail.mainAmended.title ? ` — ${snippet(detail.mainAmended.title, 160)}` : ""}`] : []),
    ...detail.amended.map((ref) => `${ref.citation}${ref.title ? ` — ${snippet(ref.title, 160)}` : ""}`),
  ];
  const published = detail.publishedAs.map((ref) =>
    ref.year !== undefined && ref.number !== undefined
      ? `Vyhlásené ako ${ref.citation} → sk_predpis_get_text {year: ${ref.year}, number: ${ref.number}}`
      : `Vyhlásené ako ${ref.citation}`,
  );
  const timeline = stages.map(
    (s, i) => `${i + 1}. ${s.from ?? "?"}${s.to && s.to !== s.from ? ` – ${s.to}` : ""} ${s.name}${s.owner ? ` (${s.owner})` : ""}${i + 1 === documentsStage ? "  ← files below" : ""}`,
  );
  const shownStage = stages[documentsStage - 1];
  const filesHead = shownStage
    ? `Files of stage ${documentsStage} (${shownStage.name}${shownStage.from ? `, ${shownStage.from}` : ""}) — ${documents.length}:`
    : `Files — ${documents.length}:`;
  return [
    `${detail.lp} — ${detail.title}`,
    detail.url,
    meta.join(" · "),
    ...(who.length ? [who.join(" · ")] : []),
    ...(detail.podnet ? [`Podnet: ${detail.podnet}`] : []),
    ...(detail.areas.length ? [`Oblasti: ${detail.areas.join(", ")}`] : []),
    ...(outcome.length ? [outcome.join(" · ")] : []),
    ...(amended.length ? [`Novelizuje: ${amended.join("; ")}`] : []),
    ...published,
    "",
    stages.length ? `Štádiá (${stages.length}):\n${timeline.join("\n")}` : "No stages recorded.",
    "",
    documents.length
      ? `${filesHead}\n${documentLines(documents).join("\n")}`
      : "No files in this stage.",
    ...(stages.length > 1
      ? [`Each stage keeps its own snapshot of the files (the drafts as they stood then, with their own document_id); the last stage is the fullest. Earlier: sk_lp_get_process {year: ${detail.year}, number: ${detail.number}, stage: 1–${stages.length}}.`]
      : []),
  ].join("\n");
}

function pdfNotes(doc: ExtractedDocument, paged: { has_more: boolean }): string[] {
  if (!doc.pdf) return [];
  const [from, to] = doc.pdf.range;
  const notes = [`PDF: pages ${from}–${to} of ${doc.pdf.pages} converted${doc.pdf.warnings.length ? `; ${doc.pdf.warnings.join(" ")}` : ""}.`];
  if (to < doc.pdf.pages && !paged.has_more) {
    notes.push(`(continue without asking the user: pdf_pages: "${to + 1}-${Math.min(to + PDF_PAGES_PER_CALL, doc.pdf.pages)}")`);
  }
  return notes;
}

const documentSchema = z.object({ document_id: z.string(), name: z.string(), kind: z.string(), kind_code: z.string(), size: z.number().optional() });
const toDocumentOutput = (doc: LpDocument) => ({ document_id: doc.documentId, name: doc.name, kind: doc.kind, kind_code: doc.kindCode, ...(doc.size !== undefined ? { size: doc.size } : {}) });

export function registerSkLp(server: McpServer): void {
  server.registerTool(
    "sk_lp_search",
    {
      title: "eLegislatíva SR: find legislative processes",
      description:
        "Find Slovak legislative processes (eLegislatíva on slov-lex.sk — LP/2025/300: a government bill, vyhláška or nariadenie vlády from its draft through MPK (medzirezortné pripomienkové konanie), the government and the NR SR to the Zbierka zákonov). By full text (query: titles AND the texts of the files; all words, \"…\" = exact phrase; Slovak terms), by process number (number: 'LP/2025/300'), by the act a process was published as (act: '325/2025' — resolved through the act's title and kept only when the process names that act; eLegislatíva links acts to processes for processes of the current system, roughly from 2024 on — older acts are not found this way), and by current stage (stage). Newest stage change first. Each hit names the number, title, type and current stage; sk_lp_get_process then gives the process record with its stages and files, sk_lp_get_text the dôvodová správa or any file.",
      inputSchema: z.object({
        query: z.string().optional().describe("Full text over titles and file texts (hladanyVyraz): Slovak words, all must occur; \"…\" for an exact phrase."),
        number: z.string().optional().describe("Process number, 'LP/2025/300' or '2025/300' (the latter also matches the EU-act process LPEU/2025/300)."),
        act: z.string().optional().describe("Zbierka citation of the resulting act, '325/2025' or '325/2025 Z. z.' — finds the process it was published from (recent processes only)."),
        stage: z.enum(STAGE_KEYS).optional().describe(`Current stage of the process: ${STAGE_TABLE}.`),
        limit: z.number().int().min(1).max(25).default(10),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        total: z.number(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            lp: z.string(),
            year: z.number(),
            number: z.number(),
            uuid: z.string(),
            type: z.string(),
            title: z.string(),
            stage: z.string(),
            stage_from: z.string().optional(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, number, act, stage, limit, page }) => {
      try {
        if (!query?.trim() && !number?.trim() && !act?.trim() && !stage) {
          throw new SourceError(SOURCE, "INPUT_INVALID", "Neither query, number, act nor stage was given.", "Pass Slovak words (query), a process number (number: 'LP/2025/300'), a Zbierka citation (act: '325/2025') or a stage.");
        }
        let hits: LpHit[];
        let total: number;
        let note: string | undefined;
        if (number?.trim()) {
          const parts = parseLpNumber(number);
          if (!parts) {
            throw new SourceError(SOURCE, "INPUT_INVALID", `"${number}" is not a process number.`, "Pass number as 'LP/2025/300' or '2025/300'.");
          }
          const normalised = parts.prefix ? `${parts.prefix}/${parts.year}/${parts.number}` : `${parts.year}/${parts.number}`;
          const result = await searchLp({ number: normalised, query, stage }, page, limit);
          hits = result.hits;
          total = result.total;
        } else if (act?.trim()) {
          const lookup = await findLpByAct(act, { query, stage });
          const offset = (page - 1) * limit;
          hits = lookup.hits.slice(offset, offset + limit);
          total = lookup.hits.length;
          if (!lookup.actTitle) {
            note = `The Zbierka zákonov knows no act ${act.trim()} — check the citation (sk_predpis_search).`;
          } else if (!lookup.hits.length) {
            note = `Act ${act.trim()} ("${snippet(lookup.actTitle, 140)}") is named by none of the ${lookup.checked} processes with that title — eLegislatíva links acts only to processes of its current system (roughly 2024 on); search its title words with query instead.`;
          }
        } else {
          const result = await searchLp({ query, stage }, page, limit);
          hits = result.hits;
          total = result.total;
        }
        const offset = (page - 1) * limit;
        return {
          content: [{ type: "text", text: skLpSearchText(hits, total, { query, number, act, stage, limit, page }, note) }],
          structuredContent: {
            total,
            count: hits.length,
            page,
            has_more: total > offset + hits.length,
            items: hits.map((hit) => ({
              lp: hit.lp,
              year: hit.year,
              number: hit.number,
              uuid: hit.uuid,
              type: hit.type,
              title: hit.title,
              stage: hit.stage,
              ...(hit.stageFrom ? { stage_from: hit.stageFrom } : {}),
              url: hit.url,
            })),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sk_lp_get_process",
    {
      title: "eLegislatíva SR: a legislative process, its stages and files",
      description:
        "One Slovak legislative process (LP/year/number) from eLegislatíva: title, type and current stage; predkladateľ, inštitúcia, rezortné číslo, podnet; MPK dates and the NR SR result; the acts it amends; the act it was published as in the Zbierka zákonov (with the sk_predpis_get_text call); the stages with dates; and the files of one stage — dôvodová správa (všeobecná and osobitná časť), vlastný materiál, predkladacia správa, doložka vplyvov, tabuľka zhody, vznesené pripomienky and vyhodnotenie MPK, schválené znenie — each with the sk_lp_get_text call that reads it. Default: the last stage with files (the fullest set); stage: N lists the files as they stood in stage N (each stage keeps its own snapshot of the drafts).",
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100).describe("Year of the process (the 2025 of LP/2025/300)."),
        number: z.number().int().min(1).describe("Number of the process (the 300 of LP/2025/300)."),
        stage: z.number().int().min(1).optional().describe("1-based index of the stage whose files to list (the stage list in the answer numbers them); default: the last stage with files."),
      }),
      outputSchema: z.object({
        lp: z.string(),
        uuid: z.string(),
        title: z.string(),
        url: z.string(),
        type: z.string(),
        stage: z.string(),
        stages: z.array(z.object({ index: z.number(), code: z.string(), name: z.string(), from: z.string().optional(), to: z.string().optional() })),
        documents_stage: z.number(),
        documents: z.array(documentSchema),
        amends: z.array(z.object({ citation: z.string(), title: z.string() })),
        published_as: z.array(z.object({ citation: z.string(), year: z.number().optional(), number: z.number().optional() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, stage }) => {
      try {
        const process = await getLpProcess(year, number, stage);
        const { detail } = process;
        return {
          content: [{ type: "text", text: skLpProcessText(process) }],
          structuredContent: {
            lp: detail.lp,
            uuid: detail.uuid,
            title: detail.title,
            url: detail.url,
            type: detail.type,
            stage: detail.stage,
            stages: process.stages.map((s, i) => ({ index: i + 1, code: s.code, name: s.name, ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}) })),
            documents_stage: process.documentsStage,
            documents: process.documents.map(toDocumentOutput),
            amends: [...(detail.mainAmended ? [detail.mainAmended] : []), ...detail.amended].map((ref) => ({ citation: ref.citation, title: ref.title })),
            published_as: detail.publishedAs.map((ref) => ({ citation: ref.citation, ...(ref.year !== undefined ? { year: ref.year } : {}), ...(ref.number !== undefined ? { number: ref.number } : {}) })),
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sk_lp_get_text",
    {
      title: "eLegislatíva SR: text of a dôvodová správa or another file",
      description:
        `Text of Slovak legislative-process files from eLegislatíva: by year + number the DÔVODOVÁ SPRÁVA of the process (všeobecná and osobitná časť, the files of the last stage that has them, joined under a header per file) followed by the list of the process's other files; by document_id (from sk_lp_get_process) any one file — vlastný materiál (the bill's text), predkladacia správa, doložka vplyvov, tabuľka zhody, vyhodnotenie MPK, schválené znenie. DOCX whole; PDF in windows of ${PDF_PAGES_PER_CALL} pages (pdf_pages for the rest). ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        document_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional().describe("The file's id from sk_lp_get_process (each stage has its own ids)."),
        year: z.number().int().min(2000).max(2100).optional().describe("Year of the process, with number: reads its dôvodová správa."),
        number: z.number().int().min(1).optional().describe("Number of the process, with year."),
        pdf_pages: z
          .string()
          .regex(/^\d+(?:-\d+)?$/)
          .optional()
          .describe(`PDF files only: physical pages to convert, '61-120' or '61' (default 1-${PDF_PAGES_PER_CALL}; at most ${PDF_PAGES_PER_CALL} per call).`),
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
        documents: z.array(documentSchema).optional(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ document_id, year, number, pdf_pages, find, page }) => {
      try {
        const range = parsePdfPages(pdf_pages);
        if (document_id) {
          const doc = await getLpDocumentText(document_id, range);
          const paged = pageOrExcerpt(doc.text, page, find);
          const head = [doc.name ? `${doc.name} — ${doc.url}` : doc.url, ...pdfNotes(doc, paged)].join("\n");
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
              text: paged.text,
            },
          };
        }
        if (year === undefined || number === undefined) {
          throw new SourceError(SOURCE, "INPUT_INVALID", "Neither document_id nor year + number was given.", "Pass year and number of the process (its dôvodová správa) or document_id of one file from sk_lp_get_process.");
        }
        const process = await getLpProcess(year, number);
        const reasons = process.documents.filter((doc) => doc.kindCode === "DovodovaSprava");
        const others = process.documents.filter((doc) => doc.kindCode !== "DovodovaSprava");
        if (!reasons.length) {
          throw new SourceError(
            SOURCE,
            "NOT_FOUND",
            `${process.detail.lp} lists no dôvodová správa among its ${process.documents.length} file(s).`,
            process.documents.length
              ? `Read another file by document_id — sk_lp_get_process {year: ${year}, number: ${number}} lists them (the bill itself is the vlastný materiál).`
              : `The process has no files yet; open ${process.detail.url}.`,
          );
        }
        const texts = await Promise.all(reasons.map((doc) => getLpDocumentText(doc.documentId, range)));
        const joined = texts.map((doc, i) => `=== ${reasons[i].name} (${reasons[i].kind}) ===\n\n${doc.text}`).join("\n\n");
        const paged = pageOrExcerpt(joined, page, find);
        const formats = [...new Set(texts.map((doc) => doc.format))];
        const pdfs = texts.filter((doc) => doc.pdf);
        const notes = texts.flatMap((doc, i) => pdfNotes(doc, paged).map((note) => `${reasons[i].name}: ${note}`));
        const stage = process.stages[process.documentsStage - 1];
        const files = others.length ? `Other files of this stage:\n${documentLines(others).join("\n")}` : "";
        const head = [
          `${process.detail.lp} — ${snippet(process.detail.title, 220)}`,
          process.detail.url,
          `Dôvodová správa: ${reasons.map((doc) => doc.name).join(", ")}${stage ? ` (stage ${process.documentsStage}: ${stage.name})` : ""}`,
          ...notes,
          paged.page === 1 && paged.mode === "page" ? files : "",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [{ type: "text", text: `${head}\n\n${paged.text}${continuationHint(paged)}` }],
          structuredContent: {
            url: process.detail.url,
            format: formats.length === 1 ? formats[0] : formats.join("+"),
            page: paged.page,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            matches: paged.matches,
            ...(pdfs.length === 1 && pdfs[0].pdf ? { pdf: { pages: pdfs[0].pdf.pages, range: pdfs[0].pdf.range } } : {}),
            documents: others.map(toDocumentOutput),
            text: paged.text,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
