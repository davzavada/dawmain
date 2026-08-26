import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { browseUpv, getUpvDecision } from "@/src/sources/upv";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { pageOrExcerpt } from "@/src/sources/shared/text";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("ÚPV (ISDV)", error));
}

export function registerUpv(server: McpServer): void {
  server.registerTool(
    "upv_browse",
    {
      title: "ÚPV: browse IP decisions",
      description:
        "Browse the Czech Industrial Property Office database of administrative and court decisions on IP (patents, trade marks, designs — zrušení, zamítnutí, určení…). Start without arguments to get the category tree, then pass a category link to descend to decision lists. Decision links carry a p_id for upv_get_decision. This source has no verified full-text search — navigation is by category.",
      inputSchema: z.object({
        category_url: z
          .string()
          .url()
          .optional()
          .describe("A category link from a previous upv_browse call. Omit for the root tree."),
      }),
      outputSchema: z.object({
        url: z.string(),
        categories: z.array(z.object({ label: z.string(), href: z.string() })),
        decisions: z.array(z.object({ label: z.string(), href: z.string(), pId: z.string().optional() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ category_url }) => {
      try {
        const result = await browseUpv(category_url);
        const output = {
          url: result.url,
          categories: result.categories.map(({ label, href }) => ({ label, href })),
          decisions: result.decisions,
        };
        const categoryLines = result.categories.slice(0, 60).map((link) => `• ${link.label}`);
        const decisionLines = result.decisions
          .slice(0, 60)
          .map((link) => `• ${link.label} — p_id ${link.pId}`);
        const text = [
          result.categories.length ? `Categories (pass their href back as category_url):\n${categoryLines.join("\n")}` : null,
          result.decisions.length ? `Decisions:\n${decisionLines.join("\n")}` : null,
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: text || "The page had no categories or decisions." }],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "upv_get_decision",
    {
      title: "ÚPV: decision text",
      description:
        "Full text of one ÚPV decision by its p_id token from upv_browse. Tokens are opaque and may expire — always take them fresh. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        p_id: z.string().regex(/^[A-Za-z0-9]{4,16}$/, "Token from upv_browse"),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ p_id, find, page }) => {
      try {
        const decision = await getUpvDecision(p_id);
        const paged = pageOrExcerpt(decision.text, page, find);
        const output = {
          url: decision.url,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${decision.url}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)` : ""}`,
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
