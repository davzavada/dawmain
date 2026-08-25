import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

const inputSchema = z.object({
  text: z
    .string()
    .min(1, "text must not be empty")
    .max(10_000, "text must be at most 10000 characters")
    .describe("The text to send back. Example: 'ahoj'"),
  transform: z
    .enum(["none", "upper", "lower", "reverse"])
    .default("none")
    .describe("Optional transformation applied before echoing."),
});

const outputSchema = z.object({
  text: z.string().describe("The transformed text."),
  characters: z.number().int().describe("Character count of the result."),
  transform: z.string().describe("The transformation that was applied."),
});

/**
 * Placeholder tool. It exists so the deployment can be exercised end to end
 * (argument validation, structured output, annotations) before any real tool
 * is written — delete it once this server does something useful.
 */
export function registerEcho(server: McpServer): void {
  server.registerTool(
    "dawmain_echo",
    {
      title: "Echo",
      description:
        "Return the supplied text, optionally upper-cased, lower-cased or reversed. A placeholder used to verify that the server, its argument validation and its structured output all work.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text, transform }) => {
      const result =
        transform === "upper"
          ? text.toUpperCase()
          : transform === "lower"
            ? text.toLowerCase()
            : transform === "reverse"
              ? [...text].reverse().join("")
              : text;

      const output = {
        text: result,
        characters: [...result].length,
        transform,
      };

      return {
        content: [{ type: "text", text: result }],
        structuredContent: output,
      };
    },
  );
}
