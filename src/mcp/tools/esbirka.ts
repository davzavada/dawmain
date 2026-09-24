import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { READ_ONLY, isoDate, toolFailure } from "./shared";
import {
  buildStaleUrl,
  futureVersions,
  getAct,
  getActText,
  getHistory,
  getSection,
  resolveVersion,
  searchActs,
  type ActVersion,
} from "@/src/sources/esbirka";
import { charPage, snippet } from "@/src/sources/shared/text";

/** MCP tools over the e-Sbírka client. Thin: schema → client call → shaping. */

const actIdentity = {
  year: z.number().int().min(1918).max(2100).describe("Year of the act, e.g. 2012 for 89/2012 Sb."),
  number: z.number().int().min(1).describe("Number of the act, e.g. 89 for 89/2012 Sb."),
  collection: z
    .string()
    // Interpolated into a SPARQL IRI downstream — letters only, no delimiters.
    .regex(/^[a-z]{2,4}$/, "Collection code is 2–4 lowercase letters, e.g. 'sb'")
    .default("sb")
    .describe("Collection code: 'sb' (Sbírka zákonů, default), 'sm' (mezinárodní smlouvy), …"),
};

const fail = toolFailure("e-Sbírka");

/** "in force 2026-01-01 – 2026-12-31 (AKTUALNI)" — which wording a quotation is. */
function versionLabel(version: ActVersion | null): string | null {
  if (!version?.from && !version?.type) return null;
  const span = version.from ? `in force ${version.from}${version.to ? ` – ${version.to}` : " – (open)"}` : "";
  return [span, version.type ? `(${version.type})` : ""].filter(Boolean).join(" ");
}

/**
 * The versions a reader of TODAY's wording must hear about: published,
 * not yet in force. Only for the current version — a historical wording is
 * superseded by definition. Best-effort: a failing history costs the note,
 * never the text.
 */
async function pendingVersions(
  version: ActVersion | null,
  collection: string,
  year: number,
  number: number,
): Promise<string[]> {
  if (version?.type !== "AKTUALNI") return [];
  const future = await futureVersions(collection, year, number).catch(() => []);
  return version.from ? future.filter((date) => date > version.from!) : future;
}

function futureNote(future: string[]): string | null {
  if (!future.length) return null;
  return `⚠ A future version of this act is already published and takes effect ${future.join(", ")} — this wording may change then; to read it, call again with date: "${future[0]}".`;
}

export function registerEsbirka(server: McpServer): void {
  server.registerTool(
    "esbirka_search",
    {
      title: "e-Sbírka: search legislation",
      description:
        "FULL-TEXT search of Czech legislation in the official e-Sbírka (Collection of Laws). Modes: all words (default — every word must occur), exact phrase, any word; optional excluded words. Ranked by relevance; an act's common name finds it first ('občanský zákoník' → 89/2012). Returns acts with their staleUrl identifiers (e.g. /sb/2012/89). Use Czech queries without punctuation (e-Sbírka refuses some phrases with 'č.' or 'Sb.'). It finds ACTS, not sections — to read a provision use esbirka_get_text. For a known act number, prefer esbirka_get_act.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Czech full-text query, e.g. 'náhrada škody zaměstnance'."),
        match: z
          .enum(["all_words", "phrase", "any_word"])
          .default("all_words")
          .describe("How the query terms combine: all_words = every word must occur."),
        exclude_words: z.string().optional().describe("Words that must NOT occur."),
        date_from: isoDate
          .optional()
          .describe(
            "e-Sbírka's own 'předmětné datum' filter, from (ISO). Its meaning is undocumented and it does NOT select the acts in force on a date (tested: a single day and an open range both missed the Civil Code) — to read the law as of a date use esbirka_get_text with 'date' instead.",
          ),
        date_to: isoDate.optional().describe("'Předmětné datum' to (ISO) — see date_from."),
        limit: z.number().int().min(1).max(25).default(10).describe("Results per page."),
        offset: z.number().int().min(0).default(0).describe("Result offset for pagination."),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        count: z.number().int(),
        offset: z.number().int(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            staleUrl: z.string(),
            nazev: z.string(),
            kod: z.string().optional(),
            stav: z.string().optional(),
            datum: z.string().optional(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, match, exclude_words, date_from, date_to, limit, offset }) => {
      try {
        const result = await searchActs(query, offset, limit, {
          match,
          excludeWords: exclude_words,
          dateFrom: date_from,
          dateTo: date_to,
        });
        const output = {
          total: result.total,
          count: result.items.length,
          offset,
          has_more: offset + result.items.length < result.total,
          items: result.items.map((item) => ({ ...item, url: `https://e-sbirka.gov.cz${item.staleUrl}` })),
        };
        const lines = output.items.map(
          (item, i) =>
            `${offset + i + 1}. ${item.staleUrl} — ${snippet(item.nazev, 160)}${item.stav ? ` [${item.stav}]` : ""}\n   ${item.url}`,
        );
        const text = result.items.length
          ? `Found ${result.total} acts (showing ${offset + 1}–${offset + result.items.length}):\n${lines.join("\n")}`
          : `No acts matched "${query}". Try different Czech terms, fewer words (every word must occur by default), or the act's common name.`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "esbirka_get_act",
    {
      title: "e-Sbírka: act metadata & versions",
      description:
        "Metadata of one Czech act: official name, full citation, the citation with all amendments ('ve znění zákona č. …'), ELI, effective dates, and its history of time versions (znění) including published future ones (BUDOUCI). Identify the act by number/year, e.g. 89/2012 Sb. → number 89, year 2012.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Optional: describe the time version in force on this date."),
      }),
      outputSchema: z.object({
        staleUrl: z.string(),
        nazev: z.string(),
        uplnaCitace: z.string().optional(),
        uplnaCitaceSNovelami: z.string().optional().describe("The citation with every amendment, as e-Sbírka writes it."),
        eli: z.string().optional(),
        datumUcinnostiOd: z.string().optional(),
        datumCasVyhlaseni: z.string().optional(),
        datumUcinnostiZneniOd: z.string().optional(),
        datumUcinnostiZneniDo: z.string().optional(),
        typZneni: z.string().optional(),
        versions: z.array(
          z.object({
            datumUcinnostiOd: z.string().optional(),
            datumUcinnostiDo: z.string().optional(),
            typZneni: z.string().optional(),
            cisloZneni: z.number().optional(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, collection, date }) => {
      try {
        const staleUrl = buildStaleUrl(collection, year, number, date);
        const [detail, history] = await Promise.all([
          getAct(staleUrl),
          getHistory(buildStaleUrl(collection, year, number)).catch(() => []),
        ]);
        const versions = history.map(({ staleUrl: _ignored, ...rest }) => rest);
        const output = { ...detail, staleUrl: detail.staleUrl || staleUrl, versions };
        const versionLines = versions
          .slice(0, 30)
          .map((v) => `  • od ${v.datumUcinnostiOd ?? "?"}${v.datumUcinnostiDo ? ` do ${v.datumUcinnostiDo}` : ""}${v.typZneni ? ` (${v.typZneni})` : ""}`);
        const text = [
          `${detail.nazev}`,
          detail.uplnaCitace ? `Citace: ${detail.uplnaCitace}` : null,
          detail.uplnaCitaceSNovelami ? `Citace se změnami: ${detail.uplnaCitaceSNovelami}` : null,
          `staleUrl: ${output.staleUrl}`,
          detail.datumUcinnostiOd ? `Účinnost od: ${detail.datumUcinnostiOd}` : null,
          versions.length ? `Znění (${versions.length}):\n${versionLines.join("\n")}${versions.length > 30 ? "\n  …" : ""}` : null,
          `Portál: https://e-sbirka.gov.cz${output.staleUrl}`,
          `Text: use esbirka_get_text with the same identifiers${date ? "" : " (add 'date' for a historical version)"}.`,
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "esbirka_get_text",
    {
      title: "e-Sbírka: consolidated text",
      description:
        "Consolidated text of a Czech act as of a date — one section (§), one article (čl.), or the whole act page by page (~45k-character pages). Pass 'section' ('§ 1721', '1721', '3a') or an article ('čl. 36' — Ústava, Listina and other acts divided into articles, or 'čl. I' of an amending act); omit it to page through the act. Without 'date' you get the version in force TODAY; pass the date of the facts to read the wording that governed them; '0000-00-00' means the as-announced version. Every answer names the version it quotes (in force from–to) and warns when a future version of the act is already published.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Time version in force on this date. Omit for the version in force today."),
        section: z
          .string()
          .optional()
          .describe("One section — '§ 12', '12' or '3a' — or one article — 'čl. 36', 'čl. I'. Omit for the whole act."),
        page: z.number().int().min(1).default(1).describe("Page of the act text (or of a long section)."),
      }),
      outputSchema: z.object({
        staleUrl: z.string(),
        url: z.string(),
        section: z.string().optional(),
        version_from: z.string().optional().describe("The quoted version is in force from this date…"),
        version_to: z.string().optional().describe("…until this date (absent = open-ended)."),
        version_type: z.string().optional().describe("AKTUALNI (in force today), MINULE (past), BUDOUCI (future), VYHLASENE (as announced)…"),
        future_versions: z
          .array(z.string())
          .optional()
          .describe("Effective dates of published versions not yet in force — the wording may change on them."),
        page: z.number().int(),
        total_pages: z.number().int(),
        total_pages_estimated: z.boolean().optional().describe("True while later parts of a long act are unread — total_pages is then an estimate."),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, collection, date, section, page }) => {
      try {
        if (section) {
          const result = await getSection(collection, year, number, date, section);
          const staleUrl = result.version?.staleUrl ?? buildStaleUrl(collection, year, number, date);
          const future = await pendingVersions(result.version, collection, year, number);
          const paged = charPage(result.text, page);
          const output = {
            staleUrl,
            url: `https://e-sbirka.gov.cz${staleUrl}`,
            section,
            ...(result.version?.from ? { version_from: result.version.from } : {}),
            ...(result.version?.to ? { version_to: result.version.to } : {}),
            ...(result.version?.type ? { version_type: result.version.type } : {}),
            ...(future.length ? { future_versions: future } : {}),
            page: paged.page,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            text: paged.text,
          };
          const header = [`${staleUrl} ${section}`, versionLabel(result.version)].filter(Boolean).join(" — ");
          const note = futureNote(future);
          return {
            content: [
              {
                type: "text",
                text: `${header} (via ${result.via}):${note ? `\n${note}` : ""}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — call again with page: ${paged.page + 1} for the rest)` : ""}`,
              },
            ],
            structuredContent: output,
          };
        }

        // Whole act, in pages cut to what a client accepts.
        const version = await resolveVersion(collection, year, number, date).catch(() => null);
        const staleUrl = version?.staleUrl ?? buildStaleUrl(collection, year, number, date);
        const [actPage, future] = await Promise.all([
          getActText(staleUrl, page),
          pendingVersions(version, collection, year, number),
        ]);
        const output = {
          staleUrl,
          url: `https://e-sbirka.gov.cz${staleUrl}`,
          ...(version?.from ? { version_from: version.from } : {}),
          ...(version?.to ? { version_to: version.to } : {}),
          ...(version?.type ? { version_type: version.type } : {}),
          ...(future.length ? { future_versions: future } : {}),
          page: actPage.page,
          total_pages: actPage.totalPages,
          ...(actPage.totalPagesExact ? {} : { total_pages_estimated: true }),
          has_more: actPage.hasMore,
          text: actPage.text,
        };
        const of = `${actPage.totalPagesExact ? "" : "~"}${actPage.totalPages}`;
        const header = [`${staleUrl} — text page ${actPage.page}/${of}`, versionLabel(version)].filter(Boolean).join(" — ");
        const note = futureNote(future);
        return {
          content: [
            {
              type: "text",
              text: `${header}:${note ? `\n${note}` : ""}\n\n${actPage.text}${actPage.hasMore ? `\n\n(continue with page: ${actPage.page + 1}; to read one provision, pass section: "§ N" instead)` : ""}`,
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
