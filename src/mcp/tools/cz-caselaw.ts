import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { searchNs } from "@/src/sources/ns";
import { searchNalus } from "@/src/sources/nalus";
import { searchNss } from "@/src/sources/nss";
import { SourceError } from "@/src/sources/shared/errors";

/**
 * One query across the three top Czech courts in parallel. Each source gets
 * its own deadline and reports its own status — one failing court must not
 * sink the other two. rozhodnuti.justice.cz is absent by design: it has no
 * server-side search (see justice_list_decisions).
 */

const SOURCES = ["nss", "ns", "nalus"] as const;
type SourceId = (typeof SOURCES)[number];
const PER_SOURCE_DEADLINE_MS = 20_000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use ISO format YYYY-MM-DD");

interface AggregatedHit {
  source: SourceId;
  id: string;
  caseNumber: string;
  date?: string;
  detail_tool: string;
}

interface SourceStatus {
  source: SourceId;
  ok: boolean;
  total: number | null;
  error?: string;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

export function registerCzCaselaw(server: McpServer): void {
  server.registerTool(
    "cz_caselaw_search",
    {
      title: "Czech case law: search all top courts",
      description:
        "Search NSS (administrative), NS (civil/criminal) and Ústavní soud (constitutional) in parallel with one Czech full-text query. Returns interleaved top hits per source plus a per-source status. For deeper digging use the per-court tools (nss_search, ns_search, nalus_search); fetch texts with the matching *_get_decision tool named in each hit.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Czech full-text query."),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        per_source_limit: z.number().int().min(1).max(10).default(5),
        sources: z
          .array(z.enum(SOURCES))
          .optional()
          .describe("Restrict to these courts. Default: all three."),
      }),
      outputSchema: z.object({
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
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, date_from, date_to, per_source_limit, sources }) => {
      const active = SOURCES.filter((source) => !sources?.length || sources.includes(source));
      const statuses: SourceStatus[] = [];
      const perSource = new Map<SourceId, AggregatedHit[]>();

      const runners: Record<SourceId, () => Promise<void>> = {
        nss: async () => {
          const result = await searchNss({ query, dateFrom: date_from, dateTo: date_to }, 1);
          statuses.push({ source: "nss", ok: true, total: result.total });
          perSource.set(
            "nss",
            result.hits.slice(0, per_source_limit).map((hit) => ({
              source: "nss",
              id: hit.id,
              caseNumber: hit.caseNumber ?? "?",
              date: hit.date,
              detail_tool: "nss_get_decision",
            })),
          );
        },
        ns: async () => {
          const result = await searchNs(
            { query, dateFrom: date_from, dateTo: date_to },
            0,
            per_source_limit,
          );
          statuses.push({ source: "ns", ok: true, total: result.matched ?? result.total });
          perSource.set(
            "ns",
            result.hits.slice(0, per_source_limit).map((hit) => ({
              source: "ns",
              id: hit.unid,
              caseNumber: hit.caseNumbers.join("; "),
              detail_tool: "ns_get_decision",
            })),
          );
        },
        nalus: async () => {
          const result = await searchNalus(
            { query, dateFrom: date_from, dateTo: date_to },
            0,
            20,
          );
          statuses.push({ source: "nalus", ok: true, total: result.total });
          perSource.set(
            "nalus",
            result.hits.slice(0, per_source_limit).map((hit) => ({
              source: "nalus",
              id: hit.sz ?? hit.caseNumber,
              caseNumber: hit.caseNumber,
              date: hit.date,
              detail_tool: "nalus_get_decision",
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

      statuses.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
      const statusLines = statuses.map(
        (status) =>
          `${status.ok ? "✓" : "✗"} ${status.source.toUpperCase()}: ${status.ok ? `${status.total ?? "?"} matches` : status.error}`,
      );
      const hitLines = items.map(
        (hit, i) =>
          `${i + 1}. [${hit.source.toUpperCase()}] ${hit.caseNumber}${hit.date ? ` (${hit.date})` : ""} → ${hit.detail_tool} id/sz: ${hit.id}`,
      );
      return {
        content: [
          {
            type: "text",
            text: [...statusLines, "", ...(hitLines.length ? hitLines : ["No hits in any court — broaden the query."])].join("\n"),
          },
        ],
        structuredContent: { statuses, items },
      };
    },
  );
}
