import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, searchNs } from "@/src/sources/ns";
import { getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { getNssDecision, searchNss } from "@/src/sources/nss";
import { getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError } from "@/src/sources/shared/errors";
import { dedupeBy, maxTotal, previewExcerpt, uniqueQueries } from "@/src/sources/shared/text";

/**
 * One call, many searches: up to 3 query variants across the three top Czech
 * courts (optionally plus the CJEU) in parallel, deduplicated per source —
 * and with `read_top` the response already carries excerpt previews of the
 * best hits, so a research round trip collapses into a single tool call.
 * Each source gets its own deadline and reports its own status — one failing
 * court must not sink the others. rozhodnuti.justice.cz is absent by design:
 * it has no server-side search (see justice_list_decisions).
 */

const SOURCES = ["nss", "ns", "nalus", "curia"] as const;
type SourceId = (typeof SOURCES)[number];
const CZ_SOURCES: SourceId[] = ["nss", "ns", "nalus"];
const PER_SOURCE_DEADLINE_MS = 20_000;
const PREVIEW_DEADLINE_MS = 15_000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD");

interface AggregatedHit {
  source: SourceId;
  id: string;
  caseNumber: string;
  date?: string;
  detail_tool: string;
  url: string | null;
}

interface SourceStatus {
  source: SourceId;
  ok: boolean;
  total: number | null;
  error?: string;
}

interface HitPreview {
  source: SourceId;
  id: string;
  caseNumber: string;
  matches: number;
  excerpt: string;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
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

export function registerCzCaselaw(server: McpServer): void {
  server.registerTool(
    "cz_caselaw_search",
    {
      title: "Case law: search all top courts at once",
      description:
        "FULL-TEXT search across NSS (administrative), NS (civil/criminal) and Ústavní soud (constitutional) in parallel — optionally also the CJEU (include_eu). Takes up to 3 query variants at once ('queries' — Czech inflects, so pass stems/synonyms: [\"bezpečný přístav\", \"bezpečného přístavu\", \"safe harbour\"]); results are merged and deduplicated per court. With read_top: N the response ALSO carries excerpt previews of the N best hits — search + first reading in one call. NS full-text is auto-limited to the last 12 months unless dates are given. For deeper digging use nss_search/ns_search/nalus_search/curia_search; fetch full texts with the *_get_* tool named in each hit.",
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
        read_top: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe(
            "Fetch the texts of the N best hits in parallel and return excerpt previews around the query terms — saves a whole round trip.",
          ),
      }),
      outputSchema: z.object({
        variants: z.array(z.string()),
        statuses: z.array(
          z.object({
            source: z.enum(SOURCES),
            ok: z.boolean(),
            total: z.number().nullable(),
            error: z.string().optional(),
          }),
        ),
        items: z.array(
          z.object({
            source: z.enum(SOURCES),
            id: z.string(),
            caseNumber: z.string(),
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, queries, date_from, date_to, per_source_limit, sources, include_eu, read_top }) => {
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
      const statuses: SourceStatus[] = [];
      const perSource = new Map<SourceId, AggregatedHit[]>();

      // Each runner searches ALL variants of its source in parallel, merges in
      // variant order and dedupes — one upstream request per variant.
      const runners: Record<SourceId, () => Promise<void>> = {
        nss: async () => {
          const results = await Promise.all(
            variants.map((v) => searchNss({ query: v, dateFrom: date_from, dateTo: date_to }, 1)),
          );
          statuses.push({ source: "nss", ok: true, total: maxTotal(results.map((r) => r.total)) });
          const hits = dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.id,
          ).slice(0, per_source_limit);
          perSource.set(
            "nss",
            hits.map((hit) => ({
              source: "nss",
              id: hit.id,
              caseNumber: hit.caseNumber ?? "?",
              date: hit.date,
              detail_tool: "nss_get_decision",
              url: hit.url,
            })),
          );
        },
        ns: async () => {
          const results = await Promise.all(
            variants.map((v) =>
              searchNs({ query: v, dateFrom: date_from, dateTo: date_to }, 0, per_source_limit),
            ),
          );
          statuses.push({
            source: "ns",
            ok: true,
            total: maxTotal(results.map((r) => r.matched ?? r.total)),
          });
          const hits = dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.unid,
          ).slice(0, per_source_limit);
          perSource.set(
            "ns",
            hits.map((hit) => ({
              source: "ns",
              id: hit.unid,
              caseNumber: hit.caseNumbers.join("; "),
              detail_tool: "ns_get_decision",
              url: hit.url,
            })),
          );
        },
        nalus: async () => {
          const results = await Promise.all(
            variants.map((v) => searchNalus({ query: v, dateFrom: date_from, dateTo: date_to }, 0, 20)),
          );
          statuses.push({ source: "nalus", ok: true, total: maxTotal(results.map((r) => r.total)) });
          const hits = dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.sz ?? hit.caseNumber,
          ).slice(0, per_source_limit);
          perSource.set(
            "nalus",
            hits.map((hit) => ({
              source: "nalus",
              id: hit.sz ?? hit.caseNumber,
              caseNumber: hit.caseNumber,
              date: hit.date,
              detail_tool: "nalus_get_decision",
              url: hit.url,
            })),
          );
        },
        curia: async () => {
          const results = await Promise.all(
            variants.map((v) =>
              searchCuria({ query: v, dateFrom: date_from, dateTo: date_to }, 1, per_source_limit),
            ),
          );
          statuses.push({ source: "curia", ok: true, total: maxTotal(results.map((r) => r.total)) });
          const hits = dedupeBy(
            results.flatMap((r) => r.hits),
            (hit) => hit.ecli ?? hit.logicDocId ?? `${hit.caseNumber}|${hit.date}`,
          ).slice(0, per_source_limit);
          perSource.set(
            "curia",
            hits.map((hit) => ({
              source: "curia",
              id: hit.ecli ?? hit.logicDocId ?? "?",
              caseNumber: hit.caseNumber ?? hit.caseName ?? "?",
              date: hit.date,
              detail_tool: "curia_get_document",
              url: hit.url,
            })),
          );
        },
      };

      await Promise.allSettled(
        active.map(async (source) => {
          try {
            await withDeadline(runners[source](), PER_SOURCE_DEADLINE_MS);
          } catch (error) {
            const message =
              error instanceof SourceError
                ? `${error.message} ${error.hint}`
                : error instanceof Error
                  ? error.message
                  : String(error);
            statuses.push({ source, ok: false, total: null, error: message });
          }
        }),
      );

      // Interleave: one hit per source in rotation, so no court dominates.
      const items: AggregatedHit[] = [];
      for (let rank = 0; rank < per_source_limit; rank++) {
        for (const source of active) {
          const hit = perSource.get(source)?.[rank];
          if (hit) items.push(hit);
        }
      }

      // read_top: pull the texts of the leading hits in parallel and preview
      // them around the query terms. Failures skip silently — a preview must
      // never sink the search itself; the full read stays one tool call away.
      let previews: HitPreview[] | undefined;
      if (read_top > 0 && items.length) {
        const settled = await Promise.all(
          items.slice(0, read_top).map(async (hit) => {
            try {
              const text = await withDeadline(fetchPreviewText(hit), PREVIEW_DEADLINE_MS);
              const preview = previewExcerpt(text, variants);
              return { source: hit.source, id: hit.id, caseNumber: hit.caseNumber, ...preview };
            } catch {
              return null;
            }
          }),
        );
        previews = settled.filter((p): p is HitPreview => p !== null);
        if (!previews.length) previews = undefined;
      }

      statuses.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
      const statusLines = statuses.map(
        (status) =>
          `${status.ok ? "✓" : "✗"} ${status.source.toUpperCase()}: ${status.ok ? `${status.total ?? "?"} matches${variants.length > 1 ? " (best variant)" : ""}` : status.error}`,
      );
      const hitLines = items.map(
        (hit, i) =>
          `${i + 1}. [${hit.source.toUpperCase()}] ${hit.caseNumber}${hit.date ? ` (${hit.date})` : ""} → ${hit.detail_tool} id/sz: ${hit.id}${hit.url ? `\n   ${hit.url}` : ""}`,
      );
      const previewBlocks = (previews ?? []).map(
        (preview) =>
          `— PREVIEW [${preview.source.toUpperCase()}] ${preview.caseNumber} (${preview.matches ? `${preview.matches}× query terms` : "document head"}):\n${preview.excerpt}\n(full text: the ${items.find((i) => i.id === preview.id)?.detail_tool} tool)`,
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
        structuredContent: { variants, statuses, items, previews },
      };
    },
  );
}
