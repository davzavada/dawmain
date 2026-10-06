import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, searchNs } from "@/src/sources/ns";
import { getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { getNssDecisionText, searchNss } from "@/src/sources/nss";
import { bestCuriaDocument, curiaDocKind, getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { callDeadline } from "@/src/sources/shared/clock";
import { SourceError } from "@/src/sources/shared/errors";
import { interleave, maxTotal, uniqueQueries } from "@/src/sources/shared/text";
import { PREVIEW_DEADLINE_MS, buildPreviews, previewBlock, withDeadline } from "./previews";
import { READ_ONLY, dateRangeError, isoDate } from "./shared";
import { runVariants } from "./variants";

/**
 * One call, many searches: up to 3 query variants across the three top Czech
 * courts (optionally plus the CJEU) in parallel — and with `read_top` the
 * response already carries excerpt previews of the best hits, so a research
 * round trip collapses into a single tool call.
 *
 * Every variant of every court runs on its own deadline and reports its own
 * outcome: a slow formulation costs only itself, never the court's other
 * variants and never the other courts. The variants of one court are merged
 * round-robin — concatenated, the first variant would fill the court's slots
 * alone. Runners RETURN their results (no shared mutable state), so a late
 * completion after a timeout cannot race a contradictory status into the
 * response.
 *
 * "Top courts" is meant literally: the NSS index also carries the regional
 * administrative courts, and without a court filter their newest decisions
 * crowded the NSS lane under an NSS label (measured: four of five "NSS" hits
 * were krajské soudy). The lane asks for NSS decisions only unless the caller
 * opts into the regional courts, and every hit names its court.
 * rozhodnuti.justice.cz is absent by design: its index is first-instance
 * civil, not the top courts' case law (see justice_search).
 */

const SOURCES = ["nss", "ns", "us", "sdeu"] as const;
type SourceId = (typeof SOURCES)[number];
const CZ_SOURCES: SourceId[] = ["nss", "ns", "us"];
const PER_VARIANT_DEADLINE_MS = 20_000;
/** NSS answers a full-text POST within its own 25 s timeout or not at all;
 * on a cold instance the handshake (GET /) comes first. */
const NSS_VARIANT_DEADLINE_MS = 30_000;
/** Searches plus previews end by then (and never past the call's boundary —
 * callDeadline): the slowest lane (30 s) plus a 15 s preview fits. */
const CALL_BUDGET_MS = 51_000;
/** Czech letters in a variant: the CJEU preview reads the Czech text. */
const CZECH_LETTERS = /[áčďéěíňóřšťúůýž]/i;

/** The per-court tool to retry a court with, when its lane did not answer. */
const COURT_TOOL: Record<SourceId, string> = {
  nss: "nss_search",
  ns: "ns_search",
  us: "us_search",
  sdeu: "sdeu_search",
};

interface AggregatedHit {
  source: SourceId;
  id: string;
  caseNumber: string;
  /** The deciding court where the lane is not single-court (NSS index, NS
   * database). "" = the index states none (NSS kárné senáty). */
  court?: string;
  /** NS kategorie A–E. */
  category?: string;
  /** Decision form — rozsudek/usnesení (NSS), nález/usnesení (ÚS), the
   * document's kind (CJEU: judgment, order, AG opinion…). For ÚS the main
   * authority signal, and nothing else on the line says it. */
  form?: string;
  /** ÚS: the collection reference (SbNU / Sb.) of a published decision. */
  published?: string;
  date?: string;
  /** CJEU: both ids — Cellar reads by ECLI, the InfoCuria blob by
   * logic_doc_id (a same-day decision Cellar lacks has only the latter). */
  ecli?: string;
  logicDocId?: string;
  /** CJEU: the case's other matching documents (summary, OJ notices…). */
  more?: number;
  detail_tool: string;
  url: string | null;
}

interface SourceStatus {
  source: SourceId;
  ok: boolean;
  total: number | null;
  /** The total is only a floor (NS under relevance order counts to 1000). */
  total_at_least?: boolean;
  /** Per-variant match counts, when more than one variant ran (null =
   * failed or not reported — variant_failed tells which). */
  variant_totals?: Array<number | null>;
  variant_at_least?: boolean[];
  variant_failed?: boolean[];
  /** A narrowing or a partial failure the reader must hear about. */
  note?: string;
  error?: string;
}

interface VariantResult {
  total: number | null;
  /** `total` is a floor, not a count. */
  atLeast?: boolean;
  hits: AggregatedHit[];
}

/** "(N 52/60 SbNU 625; 94/2011 Sb.)" at the end of a NALUS citation → the
 * collection reference alone; the rest of the citation repeats the line. */
function publishedRef(citation: string | undefined): string | undefined {
  return /\(([^()]*(?:SbNU|Sb\.)[^()]*)\)\s*$/.exec(citation ?? "")?.[1]?.trim() || undefined;
}

/** A court name worth printing: the lane's own court goes without saying. */
function foreignCourt(hit: AggregatedHit): string | undefined {
  // The NSS index lists some benches (kárné senáty, Ds) with no court at
  // all — say so rather than let them pass as plain NSS decisions.
  if (hit.source === "nss" && hit.court === "") return "court not stated (see nss_get_decision)";
  if (!hit.court) return undefined;
  if (hit.source === "ns" && hit.court === "Nejvyšší soud") return undefined;
  if (hit.source === "nss" && /nejvyšší(ho)? správní(ho)? soud/i.test(hit.court) && !/rozšířen/i.test(hit.court)) {
    return undefined;
  }
  return hit.court;
}

/** The follow-up call as the detail tool spells its parameter — "id/sz"
 * named no parameter any *_get_* tool has. */
function followUp(hit: AggregatedHit): string {
  switch (hit.source) {
    case "nss":
      return `nss_get_decision document_id: ${hit.id}`;
    case "ns":
      return `ns_get_decision unid: ${hit.id}`;
    case "us":
      return `us_get_decision sz: ${hit.id}`;
    case "sdeu": {
      const more = hit.more ? ` (+${hit.more} more document${hit.more === 1 ? "" : "s"}: sdeu_search {case_number})` : "";
      if (hit.ecli) {
        return `sdeu_get_document ecli: ${hit.ecli}${hit.logicDocId ? ` (logic_doc_id: ${hit.logicDocId})` : ""}${more}`;
      }
      if (hit.logicDocId) return `sdeu_get_document logic_doc_id: ${hit.logicDocId}${more}`;
      return `no document id — sdeu_search {case_number: "${hit.caseNumber}"}`;
    }
  }
}

/** A count as the reader should take it: "≥1000" for a floor. */
function countText(total: number | null, atLeast: boolean | undefined): string {
  if (total === null) return "?";
  return `${atLeast ? "≥" : ""}${total}`;
}

export function registerCzCaselaw(server: McpServer): void {
  server.registerTool(
    "caselaw_search",
    {
      title: "Case law: search all top courts at once",
      description:
        "FULL-TEXT search across NSS (administrative), NS (civil/criminal) and Ústavní soud (constitutional) in parallel — optionally also the CJEU (include_eu). Takes up to 3 query variants at once ('queries' — Czech inflects, so pass stems/synonyms: [\"bezpečný přístav\", \"bezpečného přístavu\", \"safe harbour\"]); each court's variants are merged round-robin, so every variant is represented, and each court reports what every variant found (variant_totals). Plain words are all required; \"quotes\" make a phrase. NS and ÚS hits come by relevance, NSS hits newest first; CJEU hits one per case (its judgment, else its best document). The NSS lane holds NSS decisions only (incl. the grand chamber) unless include_regional adds the regional administrative courts; every hit names its court where that is not obvious. With read_top: N the response ALSO carries excerpt previews of the N leading hits — search + first reading in one call. A court or a variant that fails or times out is reported by name while the rest still answer. Every court is searched across its whole archive — pass date_from/date_to only when the question has a time frame. For deeper digging use nss_search/ns_search/us_search/sdeu_search; fetch full texts with the *_get_* tool named in each hit.",
      inputSchema: z.object({
        query: z.string().min(2).optional().describe("Czech full-text query."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel (inflections, synonyms, EN term)."),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        per_source_limit: z.number().int().min(1).max(10).default(5),
        sources: z
          .array(z.enum(SOURCES))
          .optional()
          .describe("Restrict to these courts (us = Ústavní soud, sdeu = CJEU). Default: the three Czech courts (plus sdeu with include_eu)."),
        include_eu: z
          .boolean()
          .default(false)
          .describe("Also search the CJEU (InfoCuria) in the same parallel fan-out."),
        sdeu_court: z
          .enum(["C", "T"])
          .optional()
          .describe(
            "Only with the CJEU lane: C = Court of Justice only (leaves out the General Court / Tribunál), T = General Court only. Default: both.",
          ),
        include_regional: z
          .boolean()
          .default(false)
          .describe(
            "Also let the regional administrative courts (krajské soudy) into the NSS lane — first-instance administrative practice. Default: NSS decisions only.",
          ),
        read_top: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe(
            "Fetch the texts of the N leading hits in parallel and return excerpt previews around the query terms — saves a whole round trip.",
          ),
      }),
      outputSchema: z.object({
        variants: z.array(z.string()),
        statuses: z.array(
          z.object({
            source: z.enum(SOURCES),
            ok: z.boolean(),
            total: z.number().nullable(),
            total_at_least: z.boolean().optional(),
            variant_totals: z.array(z.number().nullable()).optional(),
            variant_at_least: z.array(z.boolean()).optional(),
            variant_failed: z.array(z.boolean()).optional(),
            note: z.string().optional(),
            error: z.string().optional(),
          }),
        ),
        items: z.array(
          z.object({
            source: z.enum(SOURCES),
            id: z.string(),
            caseNumber: z.string(),
            court: z.string().optional(),
            category: z.string().optional(),
            form: z.string().optional(),
            published: z.string().optional(),
            date: z.string().optional(),
            ecli: z.string().optional(),
            logicDocId: z.string().optional(),
            more: z.number().optional(),
            detail_tool: z.string(),
            url: z.string().nullable(),
          }),
        ),
        previews: z
          .array(
            z.object({
              source: z.enum(SOURCES),
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
    async ({ query, queries, date_from, date_to, per_source_limit, sources, include_eu, sdeu_court, include_regional, read_top }) => {
      const variants = uniqueQueries(query, queries);
      if (!variants.length) {
        return {
          content: [
            {
              type: "text",
              text: "Provide 'query' or 'queries' (1–3 Czech full-text variants).",
            },
          ],
          isError: true,
        };
      }
      // Every court answers an inverted range with zero hits — which would
      // read as "no case law" after 3–4 lanes × variants of pointless
      // searches. Refused before any request.
      const inverted = dateRangeError(date_from, date_to);
      if (inverted) return { content: [{ type: "text", text: inverted }], isError: true };

      const defaults: SourceId[] = include_eu ? [...CZ_SOURCES, "sdeu"] : CZ_SOURCES;
      const active = sources?.length ? SOURCES.filter((s) => sources.includes(s)) : defaults;
      // The sources that take a deadline end their own requests by it —
      // queueing at the NS gate included — instead of sending a request
      // the lane has already given up on. Both end before the call's
      // boundary (callDeadline).
      const laneDeadline = callDeadline(PER_VARIANT_DEADLINE_MS);
      const callEnd = callDeadline(CALL_BUDGET_MS);
      const sdeuLanguage = variants.some((variant) => CZECH_LETTERS.test(variant)) ? "cs" : "en";

      // One upstream search per court and variant; each RETURNS its result.
      const runners: Record<SourceId, (variant: string) => Promise<VariantResult>> = {
        nss: async (variant) => {
          const result = await searchNss(
            { query: variant, dateFrom: date_from, dateTo: date_to, ...(include_regional ? {} : { court: "nss" as const }) },
            1,
          );
          return {
            total: result.total,
            hits: result.hits.map((hit) => ({
              source: "nss" as const,
              id: hit.id,
              caseNumber: hit.caseNumber ?? "?",
              // An explicitly empty court is kept: foreignCourt says so.
              ...(hit.court !== undefined ? { court: hit.court } : {}),
              ...(hit.form ? { form: hit.form } : {}),
              date: hit.date,
              detail_tool: "nss_get_decision",
              url: hit.url,
            })),
          };
        },
        ns: async (variant) => {
          const result = await searchNs({ query: variant, dateFrom: date_from, dateTo: date_to }, 0, per_source_limit, {
            deadlineAt: laneDeadline,
          });
          return {
            total: result.matched ?? result.total,
            // Under relevance order NS counts at most 1000 matches — a floor,
            // as ns_search says, not an exact count.
            atLeast: Boolean(result.matchedIsMinimum),
            hits: result.hits.map((hit) => ({
              source: "ns" as const,
              id: hit.unid,
              caseNumber: hit.caseNumbers.join("; "),
              ...(hit.court ? { court: hit.court } : {}),
              ...(hit.category ? { category: hit.category } : {}),
              detail_tool: "ns_get_decision",
              url: hit.url,
            })),
          };
        },
        us: async (variant) => {
          // A topical fan-out wants the most relevant nálezy, not the newest
          // usnesení: NALUS ranks by its own "význam" here.
          const result = await searchNalus(
            { query: variant, dateFrom: date_from, dateTo: date_to, sort: "relevance" },
            0,
            20,
            { deadlineAt: laneDeadline },
          );
          return {
            total: result.total,
            // Hits without an sz cannot be fetched by us_get_decision —
            // never hand the model an id that the next tool will reject.
            hits: result.hits
              .filter((hit) => hit.sz)
              .map((hit) => {
                const published = publishedRef(hit.citation);
                return {
                  source: "us" as const,
                  id: hit.sz as string,
                  caseNumber: hit.caseNumber,
                  ...(hit.form ? { form: hit.form } : {}),
                  ...(published ? { published } : {}),
                  date: hit.date,
                  detail_tool: "us_get_decision",
                  url: hit.url,
                };
              }),
          };
        },
        sdeu: async (variant) => {
          // searchCuria pages are 0-based — page 0 = the top-relevance cases.
          // One hit per CASE, standing for it by its best document (the
          // judgment, not the summary or an OJ notice upstream may list
          // first — whose link and date would be cited as the decision's).
          const result = await searchCuria(
            { query: variant, dateFrom: date_from, dateTo: date_to, ...(sdeu_court ? { court: sdeu_court } : {}) },
            0,
            per_source_limit,
          );
          return {
            total: result.total,
            hits: result.affairs.map((affair) => {
              const best = bestCuriaDocument(affair.docs) ?? affair.docs[0];
              // || not ??: InfoCuria can return EMPTY-STRING ids, which must
              // fall through like missing ones.
              const ecli = best?.ecli || undefined;
              const logicDocId = best?.logicDocId || undefined;
              const form = curiaDocKind(best?.docType) ?? best?.docType;
              return {
                source: "sdeu" as const,
                id: ecli || logicDocId || "?",
                caseNumber: affair.caseNumber ?? affair.caseName ?? best?.caseNumber ?? "?",
                ...(form ? { form } : {}),
                date: best?.date,
                ...(ecli ? { ecli } : {}),
                ...(logicDocId ? { logicDocId } : {}),
                ...(affair.docs.length > 1 ? { more: affair.docs.length - 1 } : {}),
                detail_tool: "sdeu_get_document",
                url: best?.url ?? null,
              };
            }),
          };
        },
      };

      // Preview texts, one fetch per hit for the whole call: a lane's
      // leading hit starts reading as soon as its lane answers (below),
      // and buildPreviews later reuses that same promise. A rejection is
      // caught here so an unused one is never unhandled.
      const previewFetches = new Map<string, Promise<string>>();
      const previewText = (hit: AggregatedHit): Promise<string> => {
        const key = `${hit.source}:${hit.id}`;
        let pending = previewFetches.get(key);
        if (!pending) {
          const deadlineAt = Math.min(Date.now() + PREVIEW_DEADLINE_MS, callEnd);
          pending = withDeadline(fetchPreviewText(hit, deadlineAt), Math.max(1, deadlineAt - Date.now()));
          pending.catch(() => undefined);
          previewFetches.set(key, pending);
        }
        return pending;
      };
      // A CJEU hit with no id has no text to read — sdeu_search skips it too.
      const previewable = (hit: AggregatedHit) => hit.source !== "sdeu" || Boolean(hit.ecli || hit.logicDocId);
      const fetchPreviewText = async (hit: AggregatedHit, deadlineAt: number): Promise<string> => {
        switch (hit.source) {
          case "nss":
            // The text alone: a preview must not wait on the detail page.
            return getNssDecisionText(hit.id);
          case "ns":
            return (await getNsDecision(hit.id, { deadlineAt })).text;
          case "us":
            return (await getNalusDecision(hit.id, { deadlineAt })).text;
          case "sdeu":
            // In Czech when the variants are: the English text cannot match
            // Czech terms, and the cs text is what sdeu_get_document {language:
            // "cs"} reads from cache next. English stands in where there is no
            // Czech version (Cellar and the blob both fall back).
            return (
              await getCuriaDocument({
                ecli: hit.ecli,
                logicDocId: hit.logicDocId,
                language: sdeuLanguage,
                deadline: deadlineAt,
              })
            ).text;
        }
      };

      const settled = await Promise.all(
        active.map(async (source, laneIndex) => {
          try {
            const { values, failures } = await runVariants(
              variants,
              (variant) => runners[source](variant as string),
              source === "nss" ? NSS_VARIANT_DEADLINE_MS : PER_VARIANT_DEADLINE_MS,
            );
            const answered = values.filter((value): value is VariantResult => value !== null);
            // A CJEU case is keyed by its case number across variants; a hit
            // with no id and no case number by what it does have, or every
            // such hit would collapse into one.
            const hits = interleave(
              answered.map((result) => result.hits),
              (hit) =>
                hit.source === "sdeu"
                  ? hit.caseNumber !== "?"
                    ? `case:${hit.caseNumber}`
                    : `${hit.id}|${hit.date}|${hit.url}`
                  : hit.id,
            ).slice(0, per_source_limit);
            // This lane's leading hit sits at most at position laneIndex of
            // the merged list, so with laneIndex < read_top it is a preview
            // target whatever the other lanes return — start reading it now
            // instead of after the slowest court.
            if (laneIndex < read_top && hits[0] && previewable(hits[0])) void previewText(hits[0]);
            const note = failures.length
              ? failures.map((failure) => `variant "${failure.variant}" failed: ${failure.error}`).join("; ")
              : undefined;
            const total = maxTotal(answered.map((result) => result.total));
            const multi = variants.length > 1;
            return {
              source,
              status: {
                source,
                ok: true,
                total,
                // The lane's count is a floor when a variant that reached it is one.
                ...(answered.some((result) => result.atLeast && result.total === total) ? { total_at_least: true } : {}),
                ...(multi ? { variant_totals: values.map((value) => value?.total ?? null) } : {}),
                ...(multi && answered.some((result) => result.atLeast)
                  ? { variant_at_least: values.map((value) => Boolean(value?.atLeast)) }
                  : {}),
                ...(multi && failures.length ? { variant_failed: values.map((value) => value === null) } : {}),
                ...(note ? { note } : {}),
              } satisfies SourceStatus,
              hits,
            };
          } catch (error) {
            const message =
              error instanceof SourceError
                ? `${error.message} ${error.hint}`
                : error instanceof Error
                  ? error.message
                  : String(error);
            return {
              source,
              status: { source, ok: false, total: null, error: message } satisfies SourceStatus,
              hits: [] as AggregatedHit[],
            };
          }
        }),
      );
      const statuses: SourceStatus[] = settled.map((s) => s.status);
      const perSource = new Map<SourceId, AggregatedHit[]>(settled.map((s) => [s.source, s.hits]));

      // Interleave: one hit per source in rotation, so no court dominates.
      const items: AggregatedHit[] = [];
      for (let rank = 0; rank < per_source_limit; rank++) {
        for (const source of active) {
          const hit = perSource.get(source)?.[rank];
          if (hit) items.push(hit);
        }
      }

      // read_top: shared preview machinery over the leading hits; a failed
      // preview skips silently and the full read stays one tool call away.
      // buildPreviews applies its own deadline per target; hand it the hit
      // itself rather than looking the id back up (two sources can mint the
      // same id string).
      const previews = await buildPreviews(items.slice(0, read_top).filter(previewable), previewText, variants);

      statuses.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
      const statusLines = statuses.map((status) => {
        if (!status.ok) return `✗ ${status.source.toUpperCase()}: ${status.error}`;
        // ✗ only for a variant that failed; "?" is a count the court did not print.
        const perVariant = status.variant_totals
          ? ` (per variant: ${status.variant_totals
              .map((total, i) => (status.variant_failed?.[i] ? "✗" : countText(total, status.variant_at_least?.[i])))
              .join(" · ")})`
          : "";
        const scope = status.source === "nss" ? (include_regional ? " — NSS + krajské soudy" : " — NSS only") : "";
        return `✓ ${status.source.toUpperCase()}: ${countText(status.total, status.total_at_least)} matches${perVariant}${scope}${status.note ? ` ⚠ ${status.note}` : ""}`;
      });
      const hitLines = items.map((hit, i) => {
        const court = foreignCourt(hit);
        const facts = [hit.form, hit.date].filter(Boolean).join(", ");
        return `${i + 1}. [${hit.source.toUpperCase()}] ${hit.caseNumber}${hit.category ? ` [${hit.category}]` : ""}${facts ? ` (${facts})` : ""}${hit.published ? ` — ${hit.published}` : ""}${court ? ` — ${court}` : ""} → ${followUp(hit)}${hit.url ? `\n   ${hit.url}` : ""}`;
      });
      const previewBlocks = (previews ?? []).map((preview) =>
        previewBlock({ ...preview, caseNumber: `[${preview.source.toUpperCase()}] ${preview.caseNumber}` }, preview.detail_tool),
      );

      // No hits: "broaden the query" is right only when every court and every
      // variant answered. A court that failed is to be retried, not
      // reformulated around — and when none answered, the call failed.
      const failedLanes = statuses.filter((status) => !status.ok);
      const partialLanes = statuses.filter((status) => status.ok && status.note);
      if (!hitLines.length && failedLanes.length === statuses.length) {
        return {
          content: [
            {
              type: "text",
              text: [
                "No court answered:",
                ...statusLines,
                "",
                `Retry in a minute, or one court at a time (${failedLanes.map((status) => COURT_TOOL[status.source]).join(", ")}); dawmain_probe_sources tells whether a source is down.`,
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }
      const emptyLine = (() => {
        if (!failedLanes.length && !partialLanes.length) return "No hits in any court — broaden the query or add variants.";
        const answered = statuses
          .filter((status) => status.ok)
          .map((status) => status.source.toUpperCase())
          .join(", ");
        const missing = [
          ...failedLanes.map((status) => `${status.source.toUpperCase()} did not answer — retry it or use ${COURT_TOOL[status.source]}`),
          ...partialLanes.map(
            (status) => `some ${status.source.toUpperCase()} variants failed (see ⚠ above) — retry them or use ${COURT_TOOL[status.source]}`,
          ),
        ];
        return `No hits from what answered (${answered}); ${missing.join("; ")}. The case law may still be there.`;
      })();
      return {
        content: [
          {
            type: "text",
            text: [
              `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}`,
              ...statusLines,
              "",
              ...(hitLines.length ? hitLines : [emptyLine]),
              ...(previewBlocks.length ? ["", ...previewBlocks] : []),
            ].join("\n"),
          },
        ],
        structuredContent: {
          variants,
          statuses,
          items,
          previews: previews?.map(({ source, id, caseNumber, matches, excerpt }) => ({
            source,
            id,
            caseNumber,
            matches,
            excerpt,
          })),
        },
      };
    },
  );
}
