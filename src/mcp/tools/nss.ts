import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  READ_ONLY,
  continuationHint,
  isoDate,
  readTopSchema,
  toolFailure, type ToolAnswer } from "./shared";
import { readDecision } from "./reading";
import { getNssDecision, getNssDecisionText, searchNss } from "@/src/sources/nss";
import { interleave, maxTotal, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, noTermsNote, renderPreviews } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("Nejvyšší správní soud");

/** Last page holding the `count`-th hit: page 1 carries 40, every later page 20. */
function lastPage(count: number): number {
  return count <= 40 ? 1 : 1 + Math.ceil((count - 40) / 20);
}

/**
 * The court worth printing on a hit line. NSS's own goes without saying. The
 * kárné soudy's citations name no court at all (live 2026-09: "1 Ds
 * 1/2026-83" is Vrchní soud v Praze, its citation says only "rozsudek ze
 * dne …") — printed as nothing, such a hit read as an NSS decision.
 */
function courtNote(court: string | undefined): string {
  if (court === "") return " — court not named in the citation (not necessarily NSS; caselaw_get_decision (source: nss) names it)";
  if (!court || /^Nejvyššího správního soudu$/i.test(court)) return "";
  return ` — ${court}`;
}

export function registerNss(server: McpServer): void {
  server.registerTool(
    "nss_search",
    {
      title: "Nejvyšší správní soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Administrative Court decisions (kasační stížnosti — tax, immigration, public procurement, administrative law) — plus spisová značka/čj., decision/publication date ranges, court/senate (incl. rozšířený senát and KRAJSKÉ SOUDY — the index covers regional administrative courts too), rejstřík code, oblast úpravy, and applied-provision filters: applies_act '106/1999' + applies_provision '§ 17 odst. 2' finds decisions that APPLIED that provision (metadata-based — works without keywords; the citator Czech courts lack). Czech queries. 'queries' searches up to 3 variants IN PARALLEL in one call (Czech inflects — pass stems/synonyms) and merges them round-robin, so every variant is represented; 'variant_totals' says what each found, and a variant that fails or times out is named in 'failed_variants' while the others still answer. Results are ordered by DECISION DATE, newest first — the NSS index has no relevance order, so distinctive terms and filters (court, registry, applies_*) decide what comes first. Page 1 returns up to 40 hits, later pages 20. Results carry a numeric document_id for caselaw_get_decision (source: nss). read_top: N also returns excerpt previews of the N best hits — search + first reading in one call. The query also reads AND / OR / NOT (capitals), brackets, a prefix* and NEAR (within ten words).",
      inputSchema: z.object({
        query: z.string().optional().describe("Czech full-text query."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (inflections, synonyms)."),
        case_number: z.string().optional().describe("Spisová značka / čj., e.g. '1 Afs 25/2024'."),
        date_from: isoDate.optional().describe("Decision date from (ISO)."),
        date_to: isoDate.optional().describe("Decision date to (ISO)."),
        published_from: isoDate
          .optional()
          .describe(
            "Date the decision was PUBLISHED to the web, from (ISO) — monitor what is new. Results still sort by DECISION date, so a fresh publication window legitimately surfaces older, just-published decisions (backfill) — not a broken filter.",
          ),
        published_to: isoDate.optional().describe("Publication date to (ISO)."),
        court: z
          .enum(["nss", "rozsireny-senat", "krajske", "karne"])
          .optional()
          .describe(
            "nss = NSS (all senates), rozsireny-senat = grand chamber (most authoritative), krajske = regional administrative courts incl. Městský soud v Praze, karne = disciplinary courts: the NSS kárný senát (Kss/Ksz/Kse…, until 2025) and the kárné soudy at the vrchní soudy / NS (Ds, from 2025).",
          ),
        registry: z
          .string()
          .optional()
          .describe(
            "Docket registry (rejstřík) code — the agenda: 'Afs' tax, 'Azs' asylum, 'Ads' social security, 'As' general administrative, 'Ans' inaction, 'Aps' unlawful interference, 'Ao' measures of general nature, 'Ars' electoral, 'Vol' elections, 'Komp'/'Konf' competence disputes.",
          ),
        area: z
          .string()
          .optional()
          .describe(
            "Subject area (oblast úpravy), Czech substring — e.g. 'daň z přidané hodnoty', 'Pobyt cizinců', 'Právo na informace', 'Stavební zákon'; all matching areas are OR-ed. An invalid value returns the full list.",
          ),
        applies_act: z
          .string()
          .optional()
          .describe(
            "Only decisions applying this Sb. act — 'číslo/rok', e.g. '106/1999' (informace), '150/2002' (s.ř.s.), '280/2009' (daňový řád). Works without keywords.",
          ),
        applies_treaty: z
          .string()
          .optional()
          .describe("Only decisions applying this Sb./Sb.m.s. treaty — e.g. '209/1992' (EÚLP)."),
        applies_eu_regulation: z
          .string()
          .optional()
          .describe("Only decisions applying this EU regulation — '2016/679' (GDPR) or '1049/2001'."),
        applies_eu_directive: z
          .string()
          .optional()
          .describe(
            "Only decisions applying this EU directive — e.g. '2004/48', '2011/95'. A community qualifier ('2004/48/ES') narrows to that series.",
          ),
        applies_provision: z.coerce
          .string()
          .optional()
          .describe(
            "Narrow the applies_* act to one provision: '§ 17 odst. 2 písm. a', 'čl. 8 odst. 2', or compact '17(2)(a)'. Requires one applies_* filter.",
          ),
        page: z.number().int().min(1).default(1),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        count: z.number(),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            id: z.string(),
            caseNumber: z.string().optional(),
            court: z.string().optional(),
            date: z.string().optional(),
            form: z.string().optional(),
            url: z.string(),
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
    async ({ query, queries, case_number, date_from, date_to, published_from, published_to, court, registry, area, applies_act, applies_treaty, applies_eu_regulation, applies_eu_directive, applies_provision, page, read_top }) => {
      try {
        const variants = uniqueQueries(query, queries);
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined) => ({
          query: variant,
          caseNumber: case_number,
          dateFrom: date_from,
          dateTo: date_to,
          publishedFrom: published_from,
          publishedTo: published_to,
          court,
          registry,
          area,
          appliesAct: applies_act,
          appliesTreaty: applies_treaty,
          appliesEuRegulation: applies_eu_regulation,
          appliesEuDirective: applies_eu_directive,
          appliesProvision: applies_provision,
        });
        // The portal pages by 40, then 20. One variant pages straight
        // through it. Several: each variant is read from its own top through
        // this page, the lists are merged round-robin, and the page is a
        // slice of the merged list — no variant's hits fall between pages.
        const multi = keyed.length > 1;
        const start = page === 1 ? 0 : 40 + (page - 2) * 20;
        const end = page === 1 ? 40 : start + 20;
        const { values, failures } = await runVariants(keyed, async (variant) => {
          if (!multi) return [await searchNss(inputFor(variant), page)];
          // Page 1 first: it carries the pagination context every later page
          // is rebuilt from, so the later pages then cost one row fragment
          // each (and none past the variant's total) instead of re-running
          // the full-text search per page. `since` lets them budget their
          // fragment against the time page 1 already took.
          const since = Date.now();
          const first = await searchNss(inputFor(variant), 1);
          const later = await Promise.all(
            Array.from({ length: page - 1 }, (_, i) => searchNss(inputFor(variant), i + 2, { since })),
          );
          return [first, ...later];
        });
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const listOf = (pages: typeof answered[number]) => pages.flatMap((p) => p.hits);
        const totalOf = (pages: typeof answered[number]) => pages[0]?.total ?? null;
        const merged = multi ? interleave(answered.map(listOf), (hit) => hit.id) : listOf(answered[0]);
        const hits = multi ? merged.slice(start, end) : merged.slice(0, end - start);
        const total = maxTotal(answered.map(totalOf));
        const hasMore = multi
          ? merged.length > end || answered.some((pages) => (totalOf(pages) ?? 0) > listOf(pages).length)
          : total !== null && end < total;
        const previews = await buildPreviews(
          hits.slice(0, read_top).map((hit) => ({ id: hit.id, caseNumber: hit.caseNumber ?? "?" })),
          ({ id }) => getNssDecisionText(id),
          variants,
        );
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
        const lines = hits.map(
          (hit, i) =>
            `${start + i + 1}. ${hit.caseNumber ?? "?"}${hit.form ? ` (${hit.form})` : ""}${hit.date ? ` ${hit.date}` : ""}${courtNote(hit.court)} — id ${hit.id}\n   ${hit.url}`,
        );
        const variantLine = variantTotals
          ? `Variants: ${keyed.map((v, i) => `"${v}" ${variantTotals[i] ?? "✗"}`).join(" · ")} (merged round-robin)`
          : null;
        // Past the end is not "no match": say where the results end.
        const listed = multi ? merged.length : total;
        const text = !hits.length
          ? [
              page === 1 || listed === 0
                ? "No NSS decisions matched. Broaden the query or the date range."
                : listed === null
                  ? `No hits on page ${page}, and NSS stated no total — the results end before it.`
                  : `No hits on page ${page}: the ${listed} decisions${multi ? " of the merged variants" : ""} end on page ${lastPage(listed)}.`,
              // What each formulation found — a real zero per variant.
              ...(variantLine ? [variantLine] : []),
              ...failureLines(failures),
            ].join("\n")
          : [
              ...failureLines(failures),
              ...(variantLine ? [variantLine] : []),
              `${total ?? "?"} decisions${multi ? " (best variant)" : ""}, newest first (page ${page}):`,
              ...lines,
              "Full text: caselaw_get_decision {source: 'nss', id}.",
              ...renderPreviews(previews, "caselaw_get_decision (source: nss)"),
              ...noTermsNote(read_top, variants, "caselaw_get_decision (source: nss)"),
            ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );
}

/**
 * One Nejvyšší správní soud decision: a page of its text, `find` excerpts, numbered
 * paragraphs or the outline. caselaw_get_decision (./caselaw-get.ts) is the
 * tool that calls it — one read tool for the four Czech sources.
 */
export async function readNssDecision({ document_id, find, paragraphs, outline, page }: { document_id: string; find?: string; paragraphs?: string; outline?: boolean; page: number }): Promise<ToolAnswer> {
  try {
    const decision = await getNssDecision(document_id);
    const paged = readDecision(decision.text, { page, find, paragraphs, outline });
    const output = {
      id: decision.id,
      url: decision.url,
      metadata: decision.metadata,
      page: paged.page,
      total_pages: paged.total_pages,
      has_more: paged.has_more,
      matches: paged.matches,
      text: paged.text,
    };
    // The link to cite rides in the text: clients read nothing else.
    const meta = [
      ...Object.entries(decision.metadata).map(([key, value]) => `${key}: ${value}`),
      ...(decision.metadataUnavailable
        ? ["(The NSS metadata page did not answer — ECLI, spisová značka and soud are missing from this answer, not from the decision; call caselaw_get_decision (source: nss) again to retry.)"]
        : []),
      decision.url,
    ].join("\n");
    return {
      content: [
        {
          type: "text",
          text: `${meta}\n\n${paged.text}${continuationHint(paged)}`,
        },
      ],
      structuredContent: output,
    };
  } catch (error) {
    return fail(error);
  }
}
