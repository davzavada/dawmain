import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { READ_ONLY, assertDateRange, isoDate, rangeContinuationHint, toolFailure } from "./shared";
import {
  buildStaleUrl,
  futureVersions,
  getAct,
  getActText,
  getHistory,
  getSection,
  parseSectionLabel,
  resolveVersionForRead,
  searchActs,
  type ActVersion,
} from "@/src/sources/esbirka";
import { charPage, snippet } from "@/src/sources/shared/text";
import { SourceError } from "@/src/sources/shared/errors";

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

/** Sections one esbirka_get_text call reads at most. */
export const MAX_SECTIONS = 10;

/**
 * `section` as the labels to read: one ("§ 2291"), a list ("2288, 2291",
 * "čl. 10; čl. 36") or a range of §§ ("§ 2288-2291"). Neighbouring
 * provisions are read together — a definition and its exceptions, a rule and
 * the §§ it refers to — and one § per call made each of them a round trip
 * with its own header and future-version warning. A range or a list wider
 * than MAX_SECTIONS is refused: past that the act is read by page. Pure.
 */
export function expandSections(section: string): string[] {
  const out: string[] = [];
  for (const part of section.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const range = /^(?:§+\s*)?(\d{1,5})\s*[-–]\s*(?:§\s*)?(\d{1,5})$/u.exec(part);
    if (!range) {
      out.push(part);
      continue;
    }
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (to < from || to - from >= MAX_SECTIONS) {
      throw new SourceError(
        "e-Sbírka",
        "INPUT_INVALID",
        `"${part}" is not a range of at most ${MAX_SECTIONS} sections.`,
        `Pass a shorter range ('§ ${from}-${from + MAX_SECTIONS - 1}'), or omit 'section' and read the act page by page.`,
      );
    }
    for (let n = from; n <= to; n++) out.push(`§ ${n}`);
  }
  const unique = [...new Set(out)];
  if (unique.length > MAX_SECTIONS) {
    throw new SourceError("e-Sbírka", "INPUT_INVALID", `${unique.length} sections in one call — at most ${MAX_SECTIONS}.`, "Split the list, or omit 'section' and read the act page by page.");
  }
  return unique;
}

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

/** How long the comparison with the future version may hold an answer back. */
const FUTURE_COMPARE_MS = 6_000;

interface FutureDiff {
  /** The future version compared with: the last one published. */
  date: string;
  changed: string[];
  same: string[];
}

/**
 * Whether the sections just read differ in the future version already
 * published. "A future version takes effect 2027-01-01 — this wording may
 * change" stood over every § of the Civil Code, and a research then read the
 * section a second time with that date to learn it was the same (two of five
 * test researches, 11/2026). Compared with the LAST published version, so a
 * change in any of them shows. Null when the comparison did not finish in
 * time or failed — the general warning is then given instead.
 */
async function compareWithFuture(
  future: string[],
  collection: string,
  year: number,
  number: number,
  read: Array<{ label: string; text: string }>,
): Promise<FutureDiff | null> {
  const date = future.at(-1);
  if (!date || !read.length) return null;
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
  const run = (async (): Promise<FutureDiff> => {
    const version = await resolveVersionForRead(collection, year, number, date);
    const differs = await Promise.all(
      read.map(({ label, text }) =>
        getSection(collection, year, number, date, label, { version }).then(
          (then) => squash(then.text) !== squash(text),
          (error: unknown) => {
            // Gone from the future version: repealed or renumbered.
            if (error instanceof SourceError && error.kind === "NOT_FOUND") return true;
            throw error;
          },
        ),
      ),
    );
    return { date, changed: read.filter((_, i) => differs[i]).map((r) => r.label), same: read.filter((_, i) => !differs[i]).map((r) => r.label) };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FUTURE_COMPARE_MS);
  });
  try {
    return await Promise.race([run.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

function futureDiffNote(future: string[], diff: FutureDiff | null): string | null {
  if (!future.length) return null;
  if (!diff) return futureNote(future);
  const published = `A future version of this act is already published (effective ${future.join(", ")})`;
  if (!diff.changed.length) return `${published}: ${diff.same.join(", ")} ${diff.same.length > 1 ? "read" : "reads"} the same in it — no need to read it again with that date.`;
  return (
    `⚠ ${published}: ${diff.changed.join(", ")} ${diff.changed.length > 1 ? "DIFFER" : "DIFFERS"} in it (changed or no longer there) — read the new wording with date: "${diff.date}".` +
    (diff.same.length ? ` ${diff.same.join(", ")} ${diff.same.length > 1 ? "read" : "reads"} the same.` : "")
  );
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
        assertDateRange("e-Sbírka", date_from, date_to);
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
        // A page past the end of a query that DID match must not read as "no
        // match" — that sends the model off to reformulate a working query.
        const text = result.items.length
          ? `Found ${result.total} acts (showing ${offset + 1}–${offset + result.items.length}):\n${lines.join("\n")}`
          : result.total > 0
            ? `No more acts: "${query}" matched ${result.total}, and offset ${offset} is past the last one — use an offset below ${result.total}.`
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
          versions.length
            ? `Znění (${versions.length}, newest first):\n${versionLines.join("\n")}${versions.length > 30 ? `\n  … ${versions.length - 30} older versions not listed — pass 'date' for the one in force then` : ""}`
            : null,
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
        "Consolidated text of a Czech act as of a date — one section (§), several ('§ 2288-2291', '2235, 2291'), one article (čl.), or the whole act page by page (~45k-character pages). Pass 'section' ('§ 1721', '1721', '3a') or an article ('čl. 36' — Ústava, Listina and other acts divided into articles, or 'čl. I' of an amending act); omit it to page through the act. Without 'date' you get the version in force TODAY; pass the date of the facts to read the wording that governed them; '0000-00-00' means the as-announced version. Every answer names the version it quotes (in force from–to) and says whether the sections read differ in a future version already published.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Time version in force on this date. Omit for the version in force today."),
        section: z
          .string()
          .optional()
          .describe("One section — '§ 12', '12' or '3a' — or one article — 'čl. 36', 'čl. I'; several in one call as a range ('§ 2288-2291') or a list ('2235, 2291', 'čl. 10, čl. 36'), at most 10. Omit for the whole act."),
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
        const labels = section ? expandSections(section) : [];
        if (section && labels.length > 1) {
          // Several provisions of one version: the version once, the sections
          // three at a time (each may scan the act's fragment pages), one
          // header and one future-version warning for all of them.
          const version = await resolveVersionForRead(collection, year, number, date);
          const futureRun = pendingVersions(version, collection, year, number);
          const texts: string[] = [];
          const read: Array<{ label: string; text: string }> = [];
          const missing: string[] = [];
          for (let i = 0; i < labels.length; i += 3) {
            const batch = await Promise.all(
              labels.slice(i, i + 3).map((label) =>
                getSection(collection, year, number, date, label, { version }).then(
                  (result) => result.text,
                  (error: unknown) => {
                    if (error instanceof SourceError && error.kind === "NOT_FOUND") return null;
                    throw error;
                  },
                ),
              ),
            );
            batch.forEach((text, k) => {
              if (text === null) missing.push(labels[i + k]);
              else {
                texts.push(text);
                read.push({ label: labels[i + k], text });
              }
            });
          }
          const future = await futureRun;
          if (!texts.length) {
            throw new SourceError("e-Sbírka", "NOT_FOUND", `None of ${labels.join(", ")} was found in this act and time version.`, "Verify the sections exist in this act and time version, or fetch the whole act page by page (omit 'section').");
          }
          const staleUrl = version?.staleUrl ?? buildStaleUrl(collection, year, number, date);
          const paged = charPage(texts.join("\n\n"), page);
          const header = [`${staleUrl} ${labels.filter((label) => !missing.includes(label)).join(", ")}`, versionLabel(version)].filter(Boolean).join(" — ");
          const diff = future.length ? await compareWithFuture(future, collection, year, number, read) : null;
          const note = [futureDiffNote(future, diff), missing.length ? `Not in this act and time version: ${missing.join(", ")}.` : ""].filter(Boolean).join("\n");
          const locator = [`section: ${JSON.stringify(section)}`, date ? `date: "${date}"` : ""].filter(Boolean).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `${header}:${note ? `\n${note}` : ""}\n\n${paged.text}${rangeContinuationHint(locator, paged.page, paged.total_pages)}`,
              },
            ],
            structuredContent: {
              staleUrl,
              url: `https://e-sbirka.gov.cz${staleUrl}`,
              section,
              ...(version?.from ? { version_from: version.from } : {}),
              ...(version?.to ? { version_to: version.to } : {}),
              ...(version?.type ? { version_type: version.type } : {}),
              ...(future.length ? { future_versions: future } : {}),
              page: paged.page,
              total_pages: paged.total_pages,
              has_more: paged.has_more,
              text: paged.text,
            },
          };
        }
        if (section) {
          // The version first (one detail request, cached), then the section
          // and the future-version lookup side by side: the history needs only
          // the version type, not the text. An invalid label makes no request
          // at all — getSection rejects it before any I/O.
          const label = parseSectionLabel(section);
          const version = label ? await resolveVersionForRead(collection, year, number, date) : null;
          const [result, future] = await Promise.all([
            getSection(collection, year, number, date, section, label ? { version } : undefined),
            pendingVersions(version, collection, year, number),
          ]);
          const staleUrl = result.version?.staleUrl ?? buildStaleUrl(collection, year, number, date);
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
          const shown = label ? (label.kind === "paragraph" ? `§ ${label.value}` : `čl. ${label.value}`) : section;
          const header = [`${staleUrl} ${shown}`, versionLabel(result.version)].filter(Boolean).join(" — ");
          const diff = future.length ? await compareWithFuture(future, collection, year, number, [{ label: shown, text: result.text }]) : null;
          const note = futureDiffNote(future, diff);
          // The next window repeats the section (and the date): "page: 2" alone
          // would read page 2 of the WHOLE act — of today's version, without date.
          const locator = [`section: ${JSON.stringify(section)}`, date ? `date: "${date}"` : ""].filter(Boolean).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `${header} (via ${result.via}):${note ? `\n${note}` : ""}\n\n${paged.text}${rangeContinuationHint(locator, paged.page, paged.total_pages)}`,
              },
            ],
            structuredContent: output,
          };
        }

        // Whole act, in pages cut to what a client accepts.
        const version = await resolveVersionForRead(collection, year, number, date);
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
              // A dated read continues with its date — dropped, the next page
              // would silently come from today's version.
              text: `${header}:${note ? `\n${note}` : ""}\n\n${actPage.text}${actPage.hasMore ? `\n\n(continue with ${date ? `date: "${date}", ` : ""}page: ${actPage.page + 1}; to read one provision, pass section: "§ N" instead)` : ""}`,
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
