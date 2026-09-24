import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, searchNs } from "@/src/sources/ns";
import { getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { getNssDecision, searchNss } from "@/src/sources/nss";
import { getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError } from "@/src/sources/shared/errors";
import { interleave, maxTotal, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews } from "./previews";
import { READ_ONLY, isoDate } from "./shared";
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

const SOURCES = ["nss", "ns", "nalus", "curia"] as const;
type SourceId = (typeof SOURCES)[number];
const CZ_SOURCES: SourceId[] = ["nss", "ns", "nalus"];
const PER_VARIANT_DEADLINE_MS = 20_000;
/** NSS answers a full-text POST within its own 25 s timeout or not at all. */
const NSS_VARIANT_DEADLINE_MS = 26_000;

interface AggregatedHit {
  source: SourceId;
  id: string;
  caseNumber: string;
  /** The deciding court where the lane is not single-court (NSS index, NS database). */
  court?: string;
  /** NS kategorie A–E. */
  category?: string;
  date?: string;
  detail_tool: string;
  url: string | null;
}

interface SourceStatus {
  source: SourceId;
  ok: boolean;
  total: number | null;
  /** Per-variant match counts, when more than one variant ran. */
  variant_totals?: Array<number | null>;
  /** A narrowing or a partial failure the reader must hear about. */
  note?: string;
  error?: string;
}

interface VariantResult {
  total: number | null;
  hits: AggregatedHit[];
}

async function fetchPreviewText(hit: AggregatedHit): Promise<string> {
  switch (hit.source) {
    case "nss":
      return (await getNssDecision(hit.id)).text;
    case "ns":
      return (await getNsDecision(hit.id)).text;
    case "nalus":
      return (await getNalusDecision(hit.id)).text;
    case "curia": {
      const byEcli = hit.id.toUpperCase().startsWith("ECLI:");
      const document = await getCuriaDocument(
        byEcli ? { ecli: hit.id } : { logicDocId: hit.id },
      );
      return document.text;
    }
  }
}

/** A court name worth printing: the lane's own court goes without saying. */
function foreignCourt(hit: AggregatedHit): string | undefined {
  if (!hit.court) return undefined;
  if (hit.source === "ns" && hit.court === "Nejvyšší soud") return undefined;
  if (hit.source === "nss" && /nejvyšší(ho)? správní(ho)? soud/i.test(hit.court) && !/rozšířen/i.test(hit.court)) {
    return undefined;
  }
  return hit.court;
}

export function registerCzCaselaw(server: McpServer): void {
  server.registerTool(
    "cz_caselaw_search",
    {
      title: "Case law: search all top courts at once",
      description:
        "FULL-TEXT search across NSS (administrative), NS (civil/criminal) and Ústavní soud (constitutional) in parallel — optionally also the CJEU (include_eu). Takes up to 3 query variants at once ('queries' — Czech inflects, so pass stems/synonyms: [\"bezpečný přístav\", \"bezpečného přístavu\", \"safe harbour\"]); each court's variants are merged round-robin, so every variant is represented, and each court reports what every variant found (variant_totals). Plain words are all required; \"quotes\" make a phrase. NS and ÚS hits come by relevance, NSS hits newest first. The NSS lane holds NSS decisions only (incl. the grand chamber) unless include_regional adds the regional administrative courts; every hit names its court where that is not obvious. With read_top: N the response ALSO carries excerpt previews of the N leading hits — search + first reading in one call. A court or a variant that fails or times out is reported by name while the rest still answer. Every court is searched across its whole archive — pass date_from/date_to only when the question has a time frame. For deeper digging use nss_search/ns_search/nalus_search/curia_search; fetch full texts with the *_get_* tool named in each hit.",
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
          .describe("Restrict to these courts. Default: the three Czech courts (plus curia with include_eu)."),
        include_eu: z
          .boolean()
          .default(false)
          .describe("Also search the CJEU (InfoCuria) in the same parallel fan-out."),
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
            variant_totals: z.array(z.number().nullable()).optional(),
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
            date: z.string().optional(),
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
    async ({ query, queries, date_from, date_to, per_source_limit, sources, include_eu, include_regional, read_top }) => {
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

      const defaults: SourceId[] = include_eu ? [...CZ_SOURCES, "curia"] : CZ_SOURCES;
      const active = sources?.length ? SOURCES.filter((s) => sources.includes(s)) : defaults;

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
              ...(hit.court ? { court: hit.court } : {}),
              date: hit.date,
              detail_tool: "nss_get_decision",
              url: hit.url,
            })),
          };
        },
        ns: async (variant) => {
          const result = await searchNs({ query: variant, dateFrom: date_from, dateTo: date_to }, 0, per_source_limit);
          return {
            total: result.matched ?? result.total,
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
        nalus: async (variant) => {
          // A topical fan-out wants the most relevant nálezy, not the newest
          // usnesení: NALUS ranks by its own "význam" here.
          const result = await searchNalus(
            { query: variant, dateFrom: date_from, dateTo: date_to, sort: "relevance" },
            0,
            20,
          );
          return {
            total: result.total,
            // Hits without an sz cannot be fetched by nalus_get_decision —
            // never hand the model an id that the next tool will reject.
            hits: result.hits
              .filter((hit) => hit.sz)
              .map((hit) => ({
                source: "nalus" as const,
                id: hit.sz as string,
                caseNumber: hit.caseNumber,
                date: hit.date,
                detail_tool: "nalus_get_decision",
                url: hit.url,
              })),
          };
        },
        curia: async (variant) => {
          // searchCuria pages are 0-based — page 0 = the top-relevance rows.
          const result = await searchCuria({ query: variant, dateFrom: date_from, dateTo: date_to }, 0, per_source_limit);
          return {
            total: result.total,
            hits: result.hits.map((hit) => ({
              source: "curia" as const,
              // || not ??: InfoCuria can return EMPTY-STRING ids, which must
              // fall through like missing ones.
              id: hit.ecli || hit.logicDocId || "?",
              caseNumber: hit.caseNumber ?? hit.caseName ?? "?",
              date: hit.date,
              detail_tool: "curia_get_document",
              url: hit.url,
            })),
          };
        },
      };

      const settled = await Promise.all(
        active.map(async (source) => {
          try {
            const { values, failures } = await runVariants(
              variants,
              (variant) => runners[source](variant as string),
              source === "nss" ? NSS_VARIANT_DEADLINE_MS : PER_VARIANT_DEADLINE_MS,
            );
            const answered = values.filter((value): value is VariantResult => value !== null);
            // A curia hit with neither ECLI nor logicDocId carries the
            // placeholder id "?" — key it by what it does have, or every such
            // hit would collapse into one.
            const hits = interleave(
              answered.map((result) => result.hits),
              (hit) => (hit.id === "?" ? `${hit.caseNumber}|${hit.date}|${hit.url}` : hit.id),
            ).slice(0, per_source_limit);
            const note = failures.length
              ? failures.map((failure) => `variant "${failure.variant}" failed: ${failure.error}`).join("; ")
              : undefined;
            return {
              source,
              status: {
                source,
                ok: true,
                total: maxTotal(answered.map((result) => result.total)),
                ...(variants.length > 1 ? { variant_totals: values.map((value) => value?.total ?? null) } : {}),
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
      const previews = await buildPreviews(items.slice(0, read_top), fetchPreviewText, variants);

      statuses.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
      const statusLines = statuses.map((status) => {
        if (!status.ok) return `✗ ${status.source.toUpperCase()}: ${status.error}`;
        const perVariant = status.variant_totals
          ? ` (per variant: ${status.variant_totals.map((total) => total ?? "✗").join(" · ")})`
          : "";
        const scope = status.source === "nss" ? (include_regional ? " — NSS + krajské soudy" : " — NSS only") : "";
        return `✓ ${status.source.toUpperCase()}: ${status.total ?? "?"} matches${perVariant}${scope}${status.note ? ` ⚠ ${status.note}` : ""}`;
      });
      const hitLines = items.map((hit, i) => {
        const court = foreignCourt(hit);
        return `${i + 1}. [${hit.source.toUpperCase()}] ${hit.caseNumber}${hit.category ? ` [${hit.category}]` : ""}${hit.date ? ` (${hit.date})` : ""}${court ? ` — ${court}` : ""} → ${hit.detail_tool} id/sz: ${hit.id}${hit.url ? `\n   ${hit.url}` : ""}`;
      });
      const previewBlocks = (previews ?? []).map(
        (preview) =>
          `— PREVIEW [${preview.source.toUpperCase()}] ${preview.caseNumber} (${preview.matches ? `${preview.matches}× query terms` : "document head"}):\n${preview.excerpt}\n(excerpt only — full text via ${preview.detail_tool})`,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}`,
              ...statusLines,
              "",
              ...(hitLines.length ? hitLines : ["No hits in any court — broaden the query or add variants."]),
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
