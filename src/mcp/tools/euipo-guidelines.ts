import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { fetchGuidelinesSection, fetchGuidelinesToc } from "@/src/sources/euipo-guidelines";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { charPage } from "@/src/sources/shared/text";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function fail(error: unknown) {
  return toToolError(error instanceof SourceError ? error : asSourceError("EUIPO Guidelines", error));
}

export function registerEuipoGuidelines(server: McpServer): void {
  server.registerTool(
    "euipo_guidelines_toc",
    {
      title: "EUIPO Guidelines: table of contents",
      description:
        "Table of contents of the current EUIPO Examination Guidelines edition (trade marks or designs). Call without parent_topic_id for the root; drill into items marked has_children via parent_topic_id. Returns topic ids for euipo_guidelines_get_section. No full-text search on this source — navigate by section titles.",
      inputSchema: z.object({
        register: z.enum(["trademark", "design"]).default("trademark"),
        parent_topic_id: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Drill into one TOC item's children (topics with has_children)."),
      }),
      outputSchema: z.object({
        publication_id: z.string(),
        publication_title: z.string().optional(),
        count: z.number(),
        topics: z.array(
          z.object({
            topicId: z.string(),
            title: z.string(),
            hasChildren: z.boolean(),
            url: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ register, parent_topic_id }) => {
      try {
        const toc = await fetchGuidelinesToc(register, parent_topic_id);
        const output = {
          publication_id: toc.publicationId,
          publication_title: toc.publicationTitle,
          count: toc.topics.length,
          topics: toc.topics,
        };
        const lines = toc.topics
          .slice(0, 100)
          .map((topic) => `• ${topic.title} — topic ${topic.topicId}${topic.hasChildren ? " (has children)" : ""}`);
        return {
          content: [
            {
              type: "text",
              text: [`Publication ${toc.publicationId} (${register}), ${toc.topics.length} sections:`, ...lines].join("\n"),
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "euipo_guidelines_get_section",
    {
      title: "EUIPO Guidelines: section text",
      description:
        "Text of one EUIPO Examination Guidelines section, by topic id from euipo_guidelines_toc (publication id defaults to the current edition). Long sections are paginated by characters.",
      inputSchema: z.object({
        topic_id: z.string().regex(/^\d+$/, "Numeric topic id from euipo_guidelines_toc"),
        publication_id: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Override the edition (default: current edition of 'register')."),
        register: z.enum(["trademark", "design"]).default("trademark"),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ topic_id, publication_id, register, page }) => {
      try {
        let publicationId = publication_id;
        if (!publicationId) {
          const toc = await fetchGuidelinesToc(register);
          publicationId = toc.publicationId;
        }
        const section = await fetchGuidelinesSection(publicationId, topic_id);
        const paged = charPage(section.text, page);
        const output = {
          url: section.url,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          text: paged.text,
        };
        return {
          content: [
            {
              type: "text",
              text: `${section.url}\n\n${paged.text}${paged.has_more ? `\n\n(page ${paged.page}/${paged.total_pages} — continue with page: ${paged.page + 1})` : ""}`,
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
