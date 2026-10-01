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
import { getNsDecision, nsBodyMissing, searchNs, withHighlight } from "@/src/sources/ns";
import { interleave, maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { PREVIEW_DEADLINE_MS, buildPreviews, renderPreviews, withDeadline, type ToolPreview } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("Nejvyšší soud");

/**
 * The MCP route dies at 60 s (maxDuration) and takes the whole answer —
 * the variants that did answer included — with it. The searches get 45 s
 * from the call's start: a single search's worst case (attempt, back-off,
 * retry ≈ 32.5 s) plus queueing at the NS gate. A variant still unanswered
 * then is reported as failed. read_top previews must be done by 51 s — the
 * registry answers for the whole call at 54 s from the request's arrival,
 * and callDeadline also caps both budgets by that arrival clock.
 */
const SEARCH_BUDGET_MS = 45_000;
const CALL_BUDGET_MS = 51_000;
/** A query-less preview is as long as an excerpt preview. */
const OPERATIVE_PREVIEW_CHARS = 1_200;

/**
 * What a read_top preview shows when there are no query terms to excerpt
 * around — a case_number lookup, a date or category listing: the výrok,
 * from "takto:" to the odůvodnění heading, else the opening of the text.
 * Excerpting around no terms printed "the query terms do not occur" for
 * every hit and threw the fetched text away. Pure — unit-tested.
 */
export function nsOperativePart(
  text: string,
  maxChars = OPERATIVE_PREVIEW_CHARS,
): { kind: "výrok" | "opening"; excerpt: string } {
  const cut = (value: string) => {
    const clean = value.replace(/[ \t]+/g, " ").replace(/ ?\n\s*/g, "\n").trim();
    if (clean.length <= maxChars) return clean;
    const head = clean.slice(0, maxChars);
    const lastSpace = head.search(/\s\S*$/);
    return `${lastSpace > maxChars * 0.6 ? head.slice(0, lastSpace) : head}…`;
  };
  const takto = /takto\s*:/iu.exec(text.slice(0, 10_000));
  if (takto) {
    const rest = text.slice(takto.index + takto[0].length);
    const reasons = /o\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í\s*:/iu.exec(rest);
    const verdict = cut(reasons ? rest.slice(0, reasons.index) : rest);
    if (verdict) return { kind: "výrok", excerpt: verdict };
  }
  return { kind: "opening", excerpt: cut(text) };
}

/** Query-less read_top: fetch the leading hits and show their výrok. */
async function operativePreviews(
  targets: Array<{ id: string; caseNumber: string }>,
  deadlineAt: number,
): Promise<Array<ToolPreview & { kind: "výrok" | "opening" | "none" }> | undefined> {
  if (!targets.length) return undefined;
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        const decision = await withDeadline(
          getNsDecision(target.id, { deadlineAt }),
          Math.max(1, deadlineAt - Date.now()),
        );
        if (nsBodyMissing(decision.text)) return { ...target, matches: 0, excerpt: "", kind: "none" as const };
        return { ...target, matches: 0, ...nsOperativePart(decision.text) };
      } catch {
        return null; // like a failed excerpt preview: skipped, the full read stays one call away
      }
    }),
  );
  const previews = settled.filter((preview) => preview !== null);
  return previews.length ? previews : undefined;
}

function operativeBlock(preview: ToolPreview & { kind: "výrok" | "opening" | "none" }): string {
  if (preview.kind === "none") {
    return `— NO PREVIEW ${preview.caseNumber}: no judgment body came back from NS — its metadata via ns_get_decision.`;
  }
  const what = preview.kind === "výrok" ? "VÝROK" : "OPENING";
  return `— ${what} ${preview.caseNumber} (no query to excerpt around — ${preview.kind === "výrok" ? "the operative part" : "the start of the text"}):\n${preview.excerpt}\n(${preview.kind === "výrok" ? "výrok" : "opening"} only — the whole decision via ns_get_decision)`;
}

export function registerNs(server: McpServer): void {
  server.registerTool(
    "ns_search",
    {
      title: "Nejvyšší soud: search decisions",
      description:
        "FULL-TEXT search of Czech Supreme Court decisions (civil & criminal law: dovolání, sjednocující stanoviska), with the fields the NS search form exposes: spisová značka (exact), kategorie rozhodnutí A–E, typ rozhodnutí (rozsudek/usnesení/stanovisko), soud, decision date and publication date. The database also carries decisions of LOWER courts — they are in it because they were published in the Sbírka soudních rozhodnutí a stanovisek, so they carry comparable weight; keep them unless the user asked for NS only. Czech queries. Plain words are ALL required (joined with AND, anywhere in the text); \"quoted words\" are an exact phrase; a spisová značka in the query stays one phrase. 'query' also accepts Domino operators — AND / OR / NOT, (grouping), wildcards (nájem*), proximity (NEAR, SENTENCE, PARAGRAPH) — and an expression with any of them goes upstream exactly as written. Full-text results come ordered by RELEVANCE; each hit carries its court and category (A = Sbírka … E = mostly procedural). 'queries' searches up to 3 variants IN PARALLEL and merges them round-robin, so every variant is represented; 'variant_totals' says what each found. case_number matches the značka itself, NOT decisions citing it — to find those, pass the značka as 'query'. A full-text search covers the WHOLE database. Any query addresses at most its first 900 documents — 'matched' reports the true count (under relevance order at most 1000; 'matched_at_least' then marks it as a floor), so narrow with dates, type or category rather than paging deep. Results carry a UNID for ns_get_decision (whose 'find' also returns a link that opens scrolled to the found passage — the link to cite). read_top: N also returns excerpt previews of the N best hits (without a query: their výrok).",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Czech full-text query over decision bodies. Plain words = all required; \"quotes\" = exact phrase."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (inflections, synonyms)."),
        case_number: z
          .string()
          .optional()
          .describe(
            "Spisová značka, e.g. '23 Cdo 116/2017' or '20 Cdo 2018/98' — matched field by field (senát/značka/číslo/rok), so it returns THAT decision, not the ones citing it.",
          ),
        category: z
          .string()
          .regex(/^[A-Ea-e]$/)
          .optional()
          .describe("Kategorie rozhodnutí A–E (A = zásadní judikatura ve Sbírce)."),
        type: z
          .enum(["rozsudek", "usnesení", "stanovisko"])
          .optional()
          .describe(
            "Typ rozhodnutí. Rozsudek = meritorní rozhodnutí; usnesení = převážně procesní (odmítnutí dovolání).",
          ),
        court: z
          .string()
          .optional()
          .describe(
            "Soud, e.g. 'Nejvyšší soud' or 'Vrchní soud v Praze'. The database also holds decisions of lower courts — they are in it because they were selected for the Sbírka, so leave this empty to keep them.",
          ),
        date_from: isoDate.optional().describe("Datum rozhodnutí from (ISO) — when the court decided."),
        date_to: isoDate.optional().describe("Datum rozhodnutí to (ISO)."),
        published_from: isoDate
          .optional()
          .describe(
            "Datum předání na web from (ISO) — for 'what has NS published lately'. For research prefer date_from/date_to: when the court decided is what a citation says, not when the web copy appeared.",
          ),
        published_to: isoDate.optional().describe("Datum předání na web to (ISO)."),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).max(899).default(0).describe("Offset within the 900-doc window."),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().nullable(),
        matched: z.number().nullable().describe("True match count when the 900-doc window truncates."),
        matched_at_least: z
          .boolean()
          .optional()
          .describe("True when 'matched' is only a floor — under relevance order NS counts at most 1000."),
        truncated: z.boolean(),
        count: z.number(),
        offset: z.number(),
        order: z.enum(["relevance", "view"]).describe("relevance for full-text queries; view order (arbitrary) for field-only listings."),
        items: z.array(
          z.object({
            unid: z.string(),
            caseNumbers: z.array(z.string()),
            court: z.string().optional(),
            category: z.string().optional(),
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
    async ({
      query,
      queries,
      case_number,
      category,
      type,
      court,
      date_from,
      date_to,
      published_from,
      published_to,
      limit,
      offset,
      read_top,
    }) => {
      // Both budgets count from now but end before the call's boundary
      // (callDeadline) — the registry answers at 54 s from the request's
      // arrival, and an answer of ours after that would be thrown away.
      const searchEnd = callDeadline(SEARCH_BUDGET_MS);
      const callEnd = callDeadline(CALL_BUDGET_MS);
      try {
        const variants = uniqueQueries(query, queries);
        assertDateRange("Nejvyšší soud", date_from, date_to);
        assertDateRange("Nejvyšší soud", published_from, published_to, "published");
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined) => ({
          query: variant,
          caseNumber: case_number,
          category,
          // The field carries the Czech label with its initial capital.
          type: type && type.charAt(0).toUpperCase() + type.slice(1),
          court,
          dateFrom: date_from,
          dateTo: date_to,
          publishedFrom: published_from,
          publishedTo: published_to,
        });
        // One variant pages straight through the source. Several: each is
        // read from its own top, the lists are merged round-robin, and this
        // page is a slice of that merged list — the same page however the
        // reader got here, and no variant's hits fall between pages.
        const multi = keyed.length > 1;
        const window = Math.min(offset + limit, 900);
        // searchNs ends its own requests — queueing included — at the
        // deadline; runVariants' deadline only backstops it.
        const budget = { deadlineAt: searchEnd };
        const { values, failures } = await runVariants(
          keyed,
          (variant) =>
            multi ? searchNs(inputFor(variant), 0, window, budget) : searchNs(inputFor(variant), offset, limit, budget),
          SEARCH_BUDGET_MS + 1_000,
        );
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const hits = multi
          ? interleave(
              answered.map((result) => result.hits),
              (hit) => hit.unid,
            ).slice(offset, offset + limit)
          : answered[0].hits;
        const page = {
          total: maxTotal(answered.map((r) => r.total)),
          matched: maxTotal(answered.map((r) => r.matched)),
          matchedAtLeast: answered.some((r) => r.matchedIsMinimum),
          truncated: answered.some((r) => r.truncated),
          empty: answered.every((r) => r.empty) && !hits.length,
          hits,
        };
        const targets = page.hits
          .slice(0, read_top)
          .map((hit) => ({ id: hit.unid, caseNumber: hit.caseNumbers.join("; ") }));
        // Each preview ends with its own deadline or the call's, whichever
        // comes first — a document request NS has not started by then is
        // never sent.
        const previewDeadline = () => Math.min(Date.now() + PREVIEW_DEADLINE_MS, callEnd);
        let previews: ToolPreview[] | undefined;
        let previewLines: string[];
        if (variants.length) {
          previews = await buildPreviews(
            targets,
            ({ id }) => {
              const deadlineAt = previewDeadline();
              return withDeadline(
                getNsDecision(id, { deadlineAt }).then((d) => d.text),
                Math.max(1, deadlineAt - Date.now()),
              );
            },
            variants,
          );
          previewLines = renderPreviews(previews, "ns_get_decision");
        } else {
          const opened = await operativePreviews(targets, previewDeadline());
          previews = opened?.map(({ kind: _kind, ...preview }) => preview);
          previewLines = opened ? ["", ...opened.map(operativeBlock)] : [];
        }
        const variantTotals = multi ? values.map((value) => (value ? (value.matched ?? value.total) : null)) : undefined;
        const output = {
          total: page.total,
          matched: page.matched,
          ...(page.matchedAtLeast ? { matched_at_least: true } : {}),
          truncated: page.truncated,
          count: page.hits.length,
          offset,
          order: variants.length ? ("relevance" as const) : ("view" as const),
          items: page.hits,
          ...(variantTotals ? { variant_totals: variantTotals } : {}),
          ...(failures.length ? { failed_variants: failures } : {}),
          previews,
        };
        const lines = page.hits.map(
          (hit, i) =>
            `${offset + i + 1}. ${hit.caseNumbers.join("; ")}${hit.category ? ` [${hit.category}]` : ""}${hit.court && hit.court !== "Nejvyšší soud" ? ` — ${hit.court}` : ""} — unid ${hit.unid}\n   ${hit.url}`,
        );
        const variantLine = variantTotals
          ? // ✗ only for a variant that failed; "?" is a count NS did not print.
            `Variants: ${keyed.map((v, i) => `"${v}" ${values[i] === null ? "✗" : (variantTotals[i] ?? "?")}`).join(" · ")} (merged round-robin)`
          : null;
        const text = page.empty
          ? ["No NS decisions matched. Broaden the query or the date range.", ...failureLines(failures)].join("\n")
          : [
              ...failureLines(failures),
              ...(variantLine ? [variantLine] : []),
              `${page.total ?? "?"} decision${page.total === 1 ? "" : "s"}${variants.length ? ", by relevance" : ""}${page.truncated ? ` (window-capped; ${page.matchedAtLeast ? "≥ " : ""}${page.matched} match in total — narrow by date, type or category to see the rest)` : ""}:`,
              ...lines,
              ...previewLines,
            ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "ns_get_decision",
    {
      title: "Nejvyšší soud: decision text",
      description:
        `Full text and metadata (spisová značka, ECLI, právní věta, heslo, dotčené předpisy) of one Supreme Court decision, by the 32-hex UNID from ns_search. The returned url opens the decision itself (and with 'find' it opens scrolled to the term) — cite that link, never a search URL. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        unid: z.string().regex(/^[0-9A-Fa-f]{32}$/, "32-hex UNID from ns_search"),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        unid: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ unid, find, page }) => {
      try {
        const decision = await getNsDecision(unid);
        const paged = pageOrExcerpt(decision.text, page, find);
        // With 'find', hand back a link that opens the document scrolled to the
        // term — a citation the reader can check in one click. Only when the
        // term is there: a highlight of nothing would promise a passage.
        const found = Boolean(find?.trim() && paged.matches);
        const url = found ? withHighlight(decision.url, [find]) : decision.url;
        // withHighlight drops terms under 3 characters ("§ 22", "čl. 6", "ÚS")
        // and may hand back the plain url — which then opens at page one.
        const opensAtPassage = url !== decision.url;
        const output = {
          unid: decision.unid,
          url,
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
          opensAtPassage ? `${url} (opens at the found passage)` : url,
        ].join("\n");
        // Never hand back a silent metadata echo — say plainly that NS has
        // no machine-readable body for this document, and claim it only when
        // both renditions were actually read.
        const text = !nsBodyMissing(decision.text)
          ? `${meta}\n\n${paged.text}${continuationHint(paged)}`
          : decision.bodyUnverified
            ? `${meta}\n\n(WebPrint carries no judgment body and the WebSearch rendition could not be read just now — call ns_get_decision again in a minute; metadata only so far.)`
            : `${meta}\n\n(NS did not publish a machine-readable judgment body for this document — neither the WebPrint nor the WebSearch rendition carries it. Only metadata is available; open ${url} in a browser to check for an attached PDF.)`;
        return {
          content: [{ type: "text", text }],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
