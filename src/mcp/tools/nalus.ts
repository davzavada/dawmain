import { z } from "zod";
import { callDeadline } from "@/src/sources/shared/clock";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  assertDateRange,
  continuationHint,
  isoDate,
  readTopSchema,
  toolFailure,
} from "./shared";
import {
  ecliToSz,
  getNalusDecision,
  knownNalusTotal,
  nalusEcli,
  nalusPickerError,
  nalusQueryText,
  nalusPickersIn,
  searchNalus,
  type NalusCallOptions,
  type NalusSearchInput,
  type NalusSearchPage,
} from "@/src/sources/nalus";
import { SourceError } from "@/src/sources/shared/errors";
import { interleave, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { PREVIEW_DEADLINE_MS, buildPreviews, renderPreviews, withDeadline, type ToolPreview } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("Ústavní soud (NALUS)");

/**
 * The MCP route dies at 60 s (maxDuration) and takes the whole answer with
 * it. Unbounded, a search's three steps reached ~78 s (form GET + retry,
 * POST, results GET + retry, each up to 15 s), plus 15 s of previews. The
 * searches get 45 s from the call's start — every three-step search that
 * succeeds today without a retry fits — and each request is cut to what is
 * left; read_top previews must be done by 51 s — the registry answers for
 * the whole call at 54 s from the request's arrival, and callDeadline also
 * caps both budgets by that arrival clock.
 */
const SEARCH_BUDGET_MS = 45_000;
const CALL_BUDGET_MS = 51_000;
/** Previews are not started with less than this left of the call budget. */
const MIN_PREVIEW_MS = 3_000;
/** A query-less preview is as long as an excerpt preview. */
const SUMMARY_PREVIEW_CHARS = 1_200;

/**
 * One variant's rows 0..(page+1)·20 for the round-robin merge. Read as one
 * 20-, 40- or 80-row page instead of page+1 separate 20-row searches (page 2
 * of 3 variants: 9 requests, was 27), never past a total a search of the same
 * criteria already reported (a zero-hit variant costs nothing more), and the
 * 80-row pages all at once — a later one rides the first's session or runs
 * its own dance, never waiting for another. Each list is a prefix of the
 * NALUS ranking, so the merged slice is the same as before.
 */
async function variantRows(
  input: NalusSearchInput,
  page: number,
  options: NalusCallOptions,
): Promise<NalusSearchPage[]> {
  const rows = (page + 1) * 20;
  const known = knownNalusTotal(input);
  if (known === 0) return [{ hits: [], total: 0, empty: true }];
  const need = known === undefined ? rows : Math.min(rows, known);
  if (need <= 20) return [await searchNalus(input, 0, 20, options)];
  if (need <= 40) return [await searchNalus(input, 0, 40, options)];
  return Promise.all(Array.from({ length: Math.ceil(need / 80) }, (_, p) => searchNalus(input, p, 80, options)));
}

/** Cut at a word boundary, the way excerpt previews are cut. Pure. */
function clip(text: string, maxChars = SUMMARY_PREVIEW_CHARS): string {
  const clean = text.replace(/[ \t]+/g, " ").replace(/ ?\n\s*/g, "\n").trim();
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, maxChars);
  const lastSpace = head.search(/\s\S*$/);
  return `${lastSpace > maxChars * 0.6 ? head.slice(0, lastSpace) : head}…`;
}

type SummaryPreview = ToolPreview & { kind: "právní věta" | "abstrakt" | "none" };

/**
 * Query-less read_top (a case_number, ecli, date or contested-act lookup):
 * there are no terms to excerpt around, and excerpting around none printed
 * "the query terms do not occur" for every hit. The právní věta — else the
 * abstrakt — is what the reader screens a ÚS decision by, and the same
 * request already fetched it.
 */
async function summaryPreviews(
  targets: Array<{ id: string; caseNumber: string }>,
  deadlineAt: () => number,
): Promise<SummaryPreview[] | undefined> {
  if (!targets.length) return undefined;
  const settled = await Promise.all(
    targets.map(async (target): Promise<SummaryPreview | null> => {
      try {
        const at = deadlineAt();
        const decision = await withDeadline(getNalusDecision(target.id, { deadlineAt: at }), Math.max(1, at - Date.now()));
        if (decision.legalSentence) {
          return { ...target, matches: 0, kind: "právní věta", excerpt: clip(decision.legalSentence) };
        }
        if (decision.abstract) return { ...target, matches: 0, kind: "abstrakt", excerpt: clip(decision.abstract) };
        // GetAbstract did not answer: that is not "NALUS has none".
        if (decision.abstractUnavailable) return null;
        return { ...target, matches: 0, kind: "none", excerpt: "" };
      } catch {
        return null; // like a failed excerpt preview: skipped, the full read stays one call away
      }
    }),
  );
  const previews = settled.filter((preview) => preview !== null);
  return previews.length ? previews : undefined;
}

function summaryBlock(preview: SummaryPreview): string {
  if (preview.kind === "none") {
    return `— NO PREVIEW ${preview.caseNumber}: NALUS has neither a právní věta nor an abstrakt for it, and a text excerpt needs a query — read it via us_get_decision.`;
  }
  const label = preview.kind === "právní věta" ? "PRÁVNÍ VĚTA" : "ABSTRAKT";
  return `— ${label} ${preview.caseNumber} (no query to excerpt around):\n${preview.excerpt}\n(${preview.kind} only — the whole decision via us_get_decision)`;
}

/** Kept in the schema — dropped, zod would strip the key and the call would
 * run unfiltered without a word. */
const UNSUPPORTED =
  "NOT SUPPORTED — NALUS ignores this číselník filter, so a call that sets it is refused. Use query / case_number / contested_act_* / dates instead.";

export function registerNalus(server: McpServer): void {
  server.registerTool(
    "us_search",
    {
      title: "Ústavní soud: search NALUS",
      description:
        "FULL-TEXT search of Czech Constitutional Court decisions (nálezy, usnesení, stanoviska pléna) in NALUS — plus citace (sp. zn. like 'Pl. ÚS 24/10'), ECLI, populární název, contested act (číslo/název/ustanovení — e.g. every decision reviewing zákon č. 106/1999), contested organ, decision/publication dates, only-published filter, relevance sort, and dissent-scope full text. NALUS's číselník filters (judge, dissenting_judge, outcome, petitioner, contested_organ_type, contested_act_kind) do NOT work — NALUS ignores them — and a call that sets one is refused; each hit line names its soudce zpravodaj instead. Czech queries ('§' in a query is dropped — NALUS finds nothing with it). 'queries' searches up to 3 variants IN PARALLEL and merges them round-robin, so every variant is represented ('variant_totals' says what each found; a failed variant is named in 'failed_variants'). Each hit carries an 'sz' identifier for us_get_decision. read_top: N also returns previews of the N best hits (excerpts around the query; without a query their právní věta). Costs 3 upstream requests per variant; the next page of a single-query search usually 1.",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query (právní věta, výrok, odůvodnění…)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (inflections, synonyms)."),
        case_number: z.string().optional().describe("Citace / sp. zn., e.g. 'Pl. ÚS 24/10' or 'I. ÚS 1169/26'."),
        ecli: z.string().optional().describe("ECLI, e.g. 'ECLI:CZ:US:2026:1.US.1169.26.1'."),
        judge: z.string().optional().describe(UNSUPPORTED),
        dissenting_judge: z.string().optional().describe(UNSUPPORTED),
        popular_name: z.string().optional().describe("Populární název, e.g. 'Data retention'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe("Date the decision was made available in NALUS, from (ISO) — monitor what is new."),
        published_to: isoDate.optional().describe("Availability date to (ISO)."),
        types: z
          .array(z.enum(["nález", "usnesení", "stanovisko"]))
          .optional()
          .describe("Restrict decision forms. Default: all."),
        only_published: z
          .boolean()
          .default(false)
          .describe("Only decisions published in Sbírka zákonů / Sbírka nálezů a usnesení."),
        include_dissents: z
          .boolean()
          .default(false)
          .describe("Extend the full-text query into odlišná stanoviska — e.g. a judge's name plus the topic finds what was argued in dissent."),
        outcome: z.array(z.string()).max(6).optional().describe(UNSUPPORTED),
        petitioner: z.array(z.string()).max(6).optional().describe(UNSUPPORTED),
        contested_organ_type: z.array(z.string()).max(6).optional().describe(UNSUPPORTED),
        contested_organ: z
          .string()
          .optional()
          .describe("Contested organ specification, free text — e.g. 'Nejvyšší soud'."),
        contested_act_kind: z.array(z.string()).max(4).optional().describe(UNSUPPORTED),
        contested_act_number: z
          .string()
          .optional()
          .describe("Number of the contested act, e.g. '106/1999' — every decision reviewing that act (pair with types ['nález'] for the merits)."),
        contested_act_name: z.string().optional().describe("Name of the contested act, free text."),
        contested_act_clause: z
          .string()
          .optional()
          .describe("Provision of the contested act, e.g. '§ 17' or 'čl. 36'."),
        sort: z
          .enum(["date", "relevance"])
          .default("date")
          .describe("date = newest first (default), relevance = NALUS 'význam' ranking for full-text queries."),
        page: z.number().int().min(0).default(0).describe("Result page (0-indexed, 20 hits per page)."),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            sz: z.string().nullable(),
            caseNumber: z.string(),
            ecli: z.string().optional(),
            judge: z.string().optional(),
            form: z.string().optional(),
            date: z.string().optional(),
            citation: z.string().optional(),
            url: z.string().nullable(),
          }),
        ),
        variant_totals: variantTotalsSchema,
        failed_variants: variantFailureSchema,
        previews: z
          .array(
            z.object({
              id: z.string(),
              caseNumber: z.string(),
              matches: z.number(),
              excerpt: z.string(),
            }),
          )
          .optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, queries, case_number, ecli, judge, dissenting_judge, popular_name, date_from, date_to, published_from, published_to, types, only_published, include_dissents, outcome, petitioner, contested_organ_type, contested_organ, contested_act_kind, contested_act_number, contested_act_name, contested_act_clause, sort, page, read_top }) => {
      // Both budgets count from now but end before the call's boundary
      // (callDeadline) — the registry answers at 54 s from the request's
      // arrival, and an answer of ours after that would be thrown away.
      const searchEnd = callDeadline(SEARCH_BUDGET_MS);
      const callEnd = callDeadline(CALL_BUDGET_MS);
      try {
        // Refused before any request: NALUS would answer the same unfiltered
        // list, and this text would present it as filtered.
        const pickers = nalusPickersIn({
          judge,
          dissentingJudge: dissenting_judge,
          outcome,
          petitioner,
          contestedOrganType: contested_organ_type,
          contestedActKind: contested_act_kind,
        });
        if (pickers.length) throw nalusPickerError(pickers);
        assertDateRange("Ústavní soud (NALUS)", date_from, date_to);
        assertDateRange("Ústavní soud (NALUS)", published_from, published_to, "published");
        // '§' stripped before de-duplicating: variants differing only in it
        // are one NALUS search, and a '§'-only query is no query (no excerpt
        // around '§', the právní věta preview instead).
        const variants = uniqueQueries(query && nalusQueryText(query), queries?.map(nalusQueryText));
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined): NalusSearchInput => ({
          query: variant,
          citace: case_number,
          ecli,
          popularName: popular_name,
          dateFrom: date_from,
          dateTo: date_to,
          publishedFrom: published_from,
          publishedTo: published_to,
          types,
          onlyPublished: only_published,
          includeDissents: include_dissents,
          contestedOrgan: contested_organ,
          contestedActNumber: contested_act_number,
          contestedActName: contested_act_name,
          contestedActClause: contested_act_clause,
          sort,
        });
        // One NALUS search per variant, in parallel. With several variants
        // each is read from its own top through this page, merged
        // round-robin, and the page is a slice of the merged list. Every
        // request ends by the search budget; runVariants' deadline only
        // backstops it.
        const multi = keyed.length > 1;
        const start = page * 20;
        const budget = { deadlineAt: searchEnd };
        const { values, failures } = await runVariants(
          keyed,
          async (variant) =>
            multi ? variantRows(inputFor(variant), page, budget) : [await searchNalus(inputFor(variant), page, 20, budget)],
          SEARCH_BUDGET_MS + 1_000,
        );
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const listOf = (pages: typeof answered[number]) => pages.flatMap((p) => p.hits);
        const totalOf = (pages: typeof answered[number]) => pages[0]?.total ?? null;
        const keyOf = (hit: { sz: string | null; caseNumber: string }) => hit.sz ?? hit.caseNumber;
        const merged = multi ? interleave(answered.map(listOf), keyOf) : listOf(answered[0]);
        const hits = (multi ? merged.slice(start, start + 20) : merged).slice(0, 20);
        const total = maxTotal(answered.map(totalOf));
        const empty = answered.every((pages) => pages.every((p) => p.empty)) && !hits.length;

        const targets = hits
          .slice(0, read_top)
          .filter((hit) => hit.sz)
          .map((hit) => ({ id: hit.sz as string, caseNumber: hit.caseNumber }));
        // Each preview ends with its own deadline or the call's, whichever
        // comes first; none starts once too little of the call is left.
        const previewDeadline = () => Math.min(Date.now() + PREVIEW_DEADLINE_MS, callEnd);
        const previewsSkipped = targets.length > 0 && callEnd - Date.now() < MIN_PREVIEW_MS;
        let previews: ToolPreview[] | undefined;
        let previewLines: string[] = [];
        if (!previewsSkipped && variants.length) {
          previews = await buildPreviews(
            targets,
            ({ id }) => {
              const deadlineAt = previewDeadline();
              return withDeadline(
                getNalusDecision(id, { deadlineAt }).then((d) => d.text),
                Math.max(1, deadlineAt - Date.now()),
              );
            },
            variants,
          );
          previewLines = renderPreviews(previews, "us_get_decision");
        } else if (!previewsSkipped) {
          const summaries = await summaryPreviews(targets, previewDeadline);
          previews = summaries?.map(({ kind: _kind, ...preview }) => preview);
          previewLines = summaries ? ["", ...summaries.map(summaryBlock)] : [];
        } else {
          previewLines = ["", "(read_top previews skipped — the search used up this call's time; read the hits via us_get_decision.)"];
        }

        const hasMore = multi
          ? merged.length > start + 20 || answered.some((pages) => (totalOf(pages) ?? 0) > listOf(pages).length)
          : total !== null && start + 20 < total;
        const variantTotals = multi ? values.map((value) => (value ? totalOf(value) : null)) : undefined;
        const output = {
          total,
          count: hits.length,
          page,
          has_more: hasMore,
          items: hits,
          ...(variantTotals ? { variant_totals: variantTotals } : {}),
          ...(failures.length ? { failed_variants: failures } : {}),
          previews,
        };
        // The citation line carries form, sp. zn., date and the SbNU/Sb.
        // reference in one — what a memo cites. The soudce zpravodaj rides
        // along: no filter can select by judge, so the reader screens here.
        const lines = hits.map(
          (hit, i) =>
            `${start + i + 1}. ${hit.citation ?? `${hit.caseNumber}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""}`} — sz ${hit.sz ?? "?"}${hit.judge ? ` · zpravodaj ${hit.judge}` : ""}${hit.url ? `\n   ${hit.url}` : ""}`,
        );
        const variantLine = variantTotals
          ? `Variants: ${keyed.map((v, i) => `"${v}" ${variantTotals[i] ?? "✗"}`).join(" · ")} (merged round-robin)`
          : null;
        const decisions = (count: number | null) => `${count ?? "?"} decision${count === 1 ? "" : "s"}`;
        let text: string;
        if (empty) {
          text = [
            "No Constitutional Court decisions matched. Broaden the criteria or check the citace format ('I. ÚS 123/20').",
            ...failureLines(failures),
          ].join("\n");
        } else if (!hits.length) {
          // Past the end is not "no match" and not a glitch: say where the
          // results end. In multi mode `total` is one variant's count — the
          // merged list is what the pages slice.
          const known = multi ? merged.length : (total ?? 0);
          const last = Math.max(0, Math.ceil(known / 20) - 1);
          text = [
            ...failureLines(failures),
            ...(variantLine ? [variantLine] : []),
            `Page ${page} is past the end — ${multi ? `the merged variants hold ${decisions(known)}` : decisions(known)}, on page${last ? `s 0–${last}` : " 0"}. Ask for page ${last} or earlier.`,
          ].join("\n");
        } else {
          text = [
            ...failureLines(failures),
            ...(variantLine ? [variantLine] : []),
            `${decisions(total)}${multi ? " (best variant)" : ""}:`,
            ...lines,
            hasMore ? `More: page ${page + 1}.` : page > 0 || multi ? "Last page." : null,
            "Full text: us_get_decision {sz}.",
            ...previewLines,
          ]
            .filter((line) => line !== null)
            .join("\n");
        }
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "us_get_decision",
    {
      title: "Ústavní soud: decision text",
      description:
        `Full text, abstract and právní věta of one Constitutional Court decision. Identify it by the NALUS 'sz' (e.g. '1-1169-26_1' from us_search) or by ECLI. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        sz: z.string().optional().describe("NALUS id: '{senát}-{číslo}-{rok}[_{pořadí}]', e.g. 'Pl-24-10_1'."),
        ecli: z.string().optional().describe("Alternative: the decision's ECLI."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        sz: z.string(),
        url: z.string(),
        ecli: z.string().optional(),
        registrySign: z.string().optional(),
        form: z.string().optional(),
        popularName: z.string().optional(),
        legalSentence: z.string().optional(),
        abstract: z.string().optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ sz, ecli, find, page }) => {
      try {
        let identifier = sz;
        if (!identifier && ecli) identifier = ecliToSz(ecli) ?? undefined;
        if (!identifier) {
          throw new SourceError(
            "Ústavní soud (NALUS)",
            "INPUT_INVALID",
            "Neither a valid sz nor a resolvable ECLI was provided.",
            "Pass sz from us_search (e.g. '1-1169-26_1') or a full ECLI:CZ:US:… identifier.",
          );
        }
        const decision = await getNalusDecision(identifier);
        const paged = pageOrExcerpt(decision.text, page, find);
        const decisionEcli = nalusEcli(decision.sz, decision.registrySign);
        const output = {
          sz: decision.sz,
          url: decision.url,
          ...(decisionEcli ? { ecli: decisionEcli } : {}),
          registrySign: decision.registrySign,
          form: decision.form,
          popularName: decision.popularName,
          legalSentence: decision.legalSentence,
          abstract: decision.abstract,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        // The právní věta once, with the first page — not again with every
        // further page or `find` (it runs to thousands of characters).
        const firstRead = page === 1 && !find?.trim();
        // NALUS fills an empty slot with a placeholder ("Právní věta není k
        // dispozici.") — parseNalusAbstract drops them; this guards a cached
        // or mocked value all the same, so no placeholder is quoted as a holding.
        const placeholder = (value: string | undefined) =>
          value && !/^(?:Abstrakt|Právní věta) není k dispozici\.?$/i.test(value.trim()) ? value : undefined;
        const abstract = placeholder(decision.abstract);
        const legalSentence = placeholder(decision.legalSentence);
        const header = [
          decision.registrySign,
          decision.form,
          // GetText prints no ECLI; rebuilt from sz + year, it is what a formal citation needs.
          decisionEcli,
          decision.popularName ? `Populární název: ${decision.popularName}` : null,
          decision.url,
          firstRead && legalSentence
            ? `Právní věta:\n${legalSentence
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")}`
            : null,
          firstRead && abstract ? `Abstrakt:\n${abstract}` : null,
          firstRead && decision.abstractUnavailable
            ? "(Právní věta and abstrakt could not be loaded — NALUS's GetAbstract did not answer; ask again for them.)"
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${paged.text}${continuationHint(paged)}`,
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
