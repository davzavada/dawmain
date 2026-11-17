import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { READ_ONLY, assertDateRange, isoDate, rangeContinuationHint, toolFailure } from "./shared";
import {
  ANNOUNCED_DATE,
  actPages,
  defaultCitation,
  findUnit,
  getActMeta,
  getActUnits,
  getVersions,
  parseSkSectionLabel,
  pickVersion,
  portalUrl,
  resolveVersion,
  searchPredpisy,
  unitText,
  versionStatus,
  type PredpisVersion,
  type ResolvedVersion,
} from "@/src/sources/slovlex-predpisy";
import { SLOVLEX_ZBIERKA, todayIso } from "@/src/sources/slovlex-base";
import { SourceError } from "@/src/sources/shared/errors";
import { charPage, snippet } from "@/src/sources/shared/text";

/** MCP tools over Zbierka zákonov SR (Slov-Lex). Thin: schema → client call → shaping, like esbirka_*. */

const actIdentity = {
  year: z.number().int().min(1918).max(2100).describe("Year of the act, e.g. 1964 for 40/1964 Zb., 2025 for 325/2025 Z. z."),
  number: z.number().int().min(1).describe("Number of the act, e.g. 40 for 40/1964 Zb."),
};

const fail = toolFailure(SLOVLEX_ZBIERKA);

/** "účinné 2026-07-31 – 2027-06-30" / "vyhlásené znenie". */
function versionLabel(version: PredpisVersion): string {
  if (version.announced) return "vyhlásené znenie (as announced)";
  return `účinné ${version.from ?? "?"} – ${version.to ?? "(open)"}`;
}

function warnings(resolved: ResolvedVersion): string[] {
  const out: string[] = [];
  if (resolved.status === "future") {
    out.push(`⚠ This wording takes effect only on ${resolved.version.from} — it is NOT in force today (${todayIso()}).`);
  }
  if (resolved.future.length) {
    out.push(
      `⚠ A future version of this act is already published and takes effect ${resolved.future.join(", ")} — this wording may change then; to read it, call again with date: "${resolved.future[0]}".`,
    );
  }
  return out;
}

const versionOutput = (resolved: ResolvedVersion) => ({
  ...(resolved.version.from ? { version_from: resolved.version.from } : {}),
  ...(resolved.version.to ? { version_to: resolved.version.to } : {}),
  version_type: resolved.status,
  ...(resolved.future.length ? { future_versions: resolved.future } : {}),
});

export function registerSkPredpisy(server: McpServer): void {
  server.registerTool(
    "sk_predpis_search",
    {
      title: "Slov-Lex: search Slovak legislation",
      description:
        "Search the Zbierka zákonov SR (Slovak Collection of Laws, slov-lex.sk) by full text, title, number, year or type. Finds ACTS, not sections — to read a provision use sk_predpis_get_text. Use Slovak terms ('nájom bytu', 'Zákonník práce'). For a known number/year go straight to sk_predpis_get_act or sk_predpis_get_text. Each hit names the wording it points at (in force today, or on in_force_on). To find which acts transpose an EU directive, put its number in quotes: query '\"2004/48/ES\"' (unquoted it matches thousands).",
      inputSchema: z.object({
        query: z.string().optional().describe("Slovak full-text query, e.g. 'nájom bytu'."),
        title: z.string().optional().describe("Words of the act's title, e.g. 'Občiansky zákonník'."),
        number: z.string().optional().describe("Number/year, e.g. '40/1964' or '325/2025'."),
        year: z.number().int().min(1918).max(2100).optional().describe("Year (ročník) of the Zbierka."),
        type: z.string().optional().describe("Type of act as Slov-Lex names it: 'Zákon', 'Vyhláška', 'Nariadenie vlády', 'Ústavný zákon', 'Oznámenie'…"),
        in_force_on: isoDate.optional().describe("Only acts in force on this date; hits then point at the wording in force on it."),
        published_from: isoDate.optional().describe("Announced (vyhlásené) on or after this date."),
        published_to: isoDate.optional().describe("Announced on or before this date."),
        sort: z.enum(["relevance", "newest"]).default("relevance").describe("relevance (default) or newest announced first."),
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
            citation: z.string(),
            year: z.number().int(),
            number: z.number().int(),
            title: z.string(),
            type: z.string().optional(),
            published: z.string().optional(),
            version_from: z.string().optional(),
            version_to: z.string().optional(),
            iri: z.string(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, title, number, year, type, in_force_on, published_from, published_to, sort, limit, offset }) => {
      try {
        assertDateRange(SLOVLEX_ZBIERKA, published_from, published_to, "published");
        const result = await searchPredpisy({ query, title, number, year, type, in_force_on, published_from, published_to, sort }, offset, limit);
        const items = result.items.map(({ headings: _headings, ...item }) => item);
        const output = { total: result.total, count: items.length, offset, has_more: offset + items.length < result.total, items };
        const lines = result.items.map((item, i) => {
          const head = `${offset + i + 1}. ${item.citation} — ${snippet(item.title, 160)}${item.type ? ` [${item.type}]` : ""}${item.version_from ? ` · znenie od ${item.version_from}` : ""}`;
          const headings = item.headings.length ? `\n   nadpisy: ${item.headings.map((h) => `„${h}“`).join("; ")}` : "";
          return `${head}${headings}\n   ${item.url}`;
        });
        const asked = [query, title, number].filter(Boolean).join(" / ") || "these criteria";
        const text = result.items.length
          ? `Found ${result.total} acts (showing ${offset + 1}–${offset + result.items.length}):\n${lines.join("\n")}\n\nRead a provision: sk_predpis_get_text {year, number, section: "§ N"}; versions: sk_predpis_get_act.${output.has_more ? ` More: offset: ${offset + items.length}.` : ""}`
          : result.total > 0
            ? `No more acts: "${asked}" matched ${result.total}, and offset ${offset} is past the last one — use an offset below ${result.total}.`
            : `No acts matched "${asked}". Try Slovak terms (not Czech), fewer words, or the act's title.`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sk_predpis_get_act",
    {
      title: "Slov-Lex: Slovak act & its versions",
      description:
        "One Slovak act from the Zbierka zákonov SR: citation, title, type, announcement date and its history of wordings (znenia) with the amending acts behind each — newest first, the one in force on 'date' (or today) marked, published future ones flagged. Identify the act by number/year, e.g. 40/1964 Zb. → number 40, year 1964.",
      inputSchema: z.object({
        ...actIdentity,
        date: isoDate.optional().describe("Mark the wording in force on this date (default: today)."),
      }),
      outputSchema: z.object({
        citation: z.string(),
        title: z.string().optional(),
        type: z.string().optional(),
        published: z.string().optional(),
        url: z.string(),
        in_force_iri: z.string().optional().describe("The iri of the wording in force on 'date' (or today)."),
        versions: z.array(
          z.object({
            from: z.string().optional(),
            to: z.string().optional(),
            announced: z.boolean(),
            iri: z.string(),
            amended_by: z.array(z.string()),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, date }) => {
      try {
        const [history, meta] = await Promise.all([getVersions(year, number), getActMeta(year, number)]);
        const today = todayIso();
        const on = date ?? today;
        const selected = pickVersion(history, on);
        const versions = [...history].reverse().map(({ from, to, announced, iri, amended_by }) => ({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          announced,
          iri,
          amended_by,
        }));
        const citation = meta?.citation ?? defaultCitation(year, number);
        const output = {
          citation,
          ...(meta?.title ? { title: meta.title } : {}),
          ...(meta?.type ? { type: meta.type } : {}),
          ...(meta?.published ? { published: meta.published } : {}),
          url: portalUrl(year, number),
          ...(selected ? { in_force_iri: selected.iri } : {}),
          versions,
        };
        const line = (v: PredpisVersion) => {
          const span = v.announced ? "vyhlásené znenie" : `${v.from ?? "?"} – ${v.to ?? "(open)"}`;
          const by = v.amended_by.length ? ` · ${v.amended_by.join(", ")}` : "";
          const mark = v === selected ? ` ← účinné k ${on}` : "";
          const future = versionStatus(v, today) === "future" ? " (budúce — ešte neúčinné)" : "";
          return `  • ${span}${by}${future}${mark}`;
        };
        const newestFirst = [...history].reverse();
        const shown = newestFirst.slice(0, 30);
        const lines = shown.map(line);
        if (newestFirst.length > 30) {
          if (selected && !shown.includes(selected)) lines.push(`  …\n${line(selected)}`);
          lines.push(`  … ${newestFirst.length - 30} older versions not listed — pass 'date' to mark the one in force then`);
        }
        const text = [
          `${citation}${meta?.title ? ` — ${meta.title}` : ""}${meta?.type ? ` [${meta.type}]` : ""}`,
          meta?.published ? `Vyhlásené: ${meta.published}` : null,
          selected ? null : `No wording of this act is in force on ${on}.`,
          `Znenia (${history.length}, newest first):\n${lines.join("\n")}`,
          `Portál: ${output.url}`,
          `Text: sk_predpis_get_text {year: ${year}, number: ${number}, section: "§ N"}${date ? `, date: "${date}"` : " (add 'date' for a historical wording)"}.`,
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
    "sk_predpis_get_text",
    {
      title: "Slov-Lex: Slovak act text",
      description:
        "Consolidated text of a Slovak act (Zbierka zákonov SR) as of a date — one section (§), one article (čl.), or the whole act page by page (~45k-character pages). Pass 'section' ('§ 420', '420', '23e') or an article ('čl. I', 'čl. 1'); omit it to page through the act. Without 'date' you get the wording in force TODAY; pass the date of the facts for the wording that governed them; '0000-00-00' means the as-announced wording. An AMENDING act consists of articles (Čl. I, II …) quoting new wordings of other acts — read it by 'čl.'; for the amended § itself read the amended act. Every answer names the wording it quotes (účinné from–to) and warns about future wordings.",
      inputSchema: z.object({
        ...actIdentity,
        date: z
          .union([isoDate, z.literal(ANNOUNCED_DATE)])
          .optional()
          .describe("Wording in force on this date (ISO). Omit for today's; '0000-00-00' = as announced."),
        section: z.string().optional().describe("One section — '§ 12', '12' or '3a' — or one article — 'čl. I', 'čl. 1'. Omit for the whole act."),
        page: z.number().int().min(1).default(1).describe("Page of the act text (or of a long section)."),
      }),
      outputSchema: z.object({
        iri: z.string(),
        url: z.string(),
        section: z.string().optional(),
        version_from: z.string().optional().describe("The quoted wording is in force from this date…"),
        version_to: z.string().optional().describe("…until this date (absent = open-ended)."),
        version_type: z.string().optional().describe("current (in force today), past, future (not yet in force), announced (as announced)."),
        future_versions: z.array(z.string()).optional().describe("Effective dates of published wordings not yet in force — the text may change on them."),
        page: z.number().int(),
        total_pages: z.number().int(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ year, number, date, section, page }) => {
      try {
        const label = section ? parseSkSectionLabel(section) : null;
        if (section && !label) {
          throw new SourceError(SLOVLEX_ZBIERKA, "INPUT_INVALID", `section "${section}" is neither a § nor an article.`, `Pass section as "§ 12", "12", "3a", "čl. I" or "čl. 1".`);
        }
        const resolved = await resolveVersion(year, number, date);
        const act = await getActUnits(year, number, resolved.version.version);
        const iri = resolved.version.iri;
        const url = portalUrl(year, number, resolved.version.version);
        const notes = warnings(resolved);
        const noteText = notes.length ? `\n${notes.join("\n")}` : "";

        if (section && label) {
          const shown = label.kind === "paragraph" ? `§ ${label.value}` : `čl. ${label.value}`;
          const match = findUnit(act, label);
          if (!match || "citedIn" in match) {
            if (match && "citedIn" in match) {
              throw new SourceError(
                SLOVLEX_ZBIERKA,
                "NOT_FOUND",
                `${defaultCitation(year, number)} has no ${shown} of its own: it is an amending act, and ${shown} appears only as the quoted new wording of another act in ${match.citedIn.join(", ")}.`,
                `Read the amendment with section: "${match.citedIn[0].replace(/^Čl\./, "čl.")}", or read ${shown} in the amended act (its number is named at the start of that article) with sk_predpis_get_text.`,
              );
            }
            const own = act.units.filter((u) => u.kind === (label.kind === "paragraph" ? "paragraph" : "article")).map((u) => u.label).filter(Boolean);
            const range = own.length ? ` (its ${label.kind === "paragraph" ? "sections run" : "articles run"} ${own[0]} … ${own[own.length - 1]})` : "";
            throw new SourceError(
              SLOVLEX_ZBIERKA,
              "NOT_FOUND",
              `${iri} has no ${shown}${range}.`,
              "Check the label (sk_predpis_get_text without section pages through the act), or the date — a § may not exist in that wording.",
            );
          }
          const paged = charPage(unitText(act, match.units), page);
          const output = {
            iri,
            url,
            section,
            ...versionOutput(resolved),
            page: paged.page,
            total_pages: paged.total_pages,
            has_more: paged.has_more,
            text: paged.text,
          };
          // The next window repeats the section and the date: "page: 2" alone
          // would read page 2 of the WHOLE act, of today's wording.
          const locator = [`section: ${JSON.stringify(section)}`, date ? `date: "${date}"` : ""].filter(Boolean).join(", ");
          return {
            content: [{ type: "text", text: `${iri} ${shown} — ${versionLabel(resolved.version)}:${noteText}\n\n${paged.text}${rangeContinuationHint(locator, paged.page, paged.total_pages)}` }],
            structuredContent: output,
          };
        }

        const pages = actPages(act);
        const current = Math.min(Math.max(1, page), pages.length);
        const hasMore = current < pages.length;
        const output = {
          iri,
          url,
          ...versionOutput(resolved),
          page: current,
          total_pages: pages.length,
          has_more: hasMore,
          text: pages[current - 1],
        };
        const header = `${iri} — text page ${current}/${pages.length} — ${versionLabel(resolved.version)}`;
        return {
          content: [
            {
              type: "text",
              // A dated read continues with its date — dropped, the next page
              // would silently come from today's wording.
              text: `${header}:${noteText}\n\n${pages[current - 1]}${hasMore ? `\n\n(continue with ${date ? `date: "${date}", ` : ""}page: ${current + 1}; to read one provision, pass section: "§ N" instead)` : ""}`,
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
