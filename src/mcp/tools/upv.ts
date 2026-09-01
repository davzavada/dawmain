/**
 * UNREGISTERED (see ../tools/index.ts): the ÚPV portal drops connections
 * from datacenter IPs — verified live from the fra1 deployment on both
 * hosts. Kept so the tools can be re-registered should the source ever
 * start accepting connections from the deployment again.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  continuationHint,
  toolFailure,
} from "./shared";
import { browseUpv, getUpvDecision } from "@/src/sources/upv";
import { pageOrExcerpt } from "@/src/sources/shared/text";

const fail = toolFailure("ÚPV (ISDV)");

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
        `Full text of one ÚPV decision by its p_id token from upv_browse. Tokens are opaque and may expire — always take them fresh. ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        p_id: z.string().regex(/^[A-Za-z0-9]{4,16}$/, "Token from upv_browse"),
        find: z.string().optional().describe(FIND_DESCRIPTION),
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
              text: `${decision.url}\n\n${paged.text}${continuationHint(paged)}`,
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
