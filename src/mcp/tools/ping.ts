import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { authMode } from "../auth";
import { SERVER_NAME, SERVER_VERSION } from "../config";

const outputSchema = z.object({
  ok: z.literal(true),
  server: z.string(),
  version: z.string(),
  serverTime: z.string().describe("Current server time, ISO 8601 (UTC)."),
  environment: z
    .string()
    .describe("Vercel environment: production, preview, development, or local."),
  region: z.string().nullable().describe("Vercel region the function ran in."),
  commit: z.string().nullable().describe("Short git SHA of the deployment."),
  auth: z
    .enum(["oauth+token", "oauth", "token", "open"])
    .describe(
      "What this deployment accepts: OAuth login (via Clerk), a shared bearer token, both, or 'open' = anyone can call it.",
    ),
});

/**
 * Health check. Deliberately dependency-free so it answers even when every
 * other tool is misconfigured — the fastest way to tell "is my deployment
 * live and reachable" from "is my API key wrong".
 */
export function registerPing(server: McpServer): void {
  server.registerTool(
    "dawmain_ping",
    {
      title: "Ping",
      description:
        "Check that the MCP server is reachable and report which deployment answered: server name and version, current server time, Vercel environment, region and git commit. Takes no arguments.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const output = {
        ok: true as const,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        serverTime: new Date().toISOString(),
        environment: process.env.VERCEL_ENV ?? "local",
        region: process.env.VERCEL_REGION ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        // Surfaces a misconfigured token: without this, an accidentally
        // anonymous deployment looks identical to a protected one.
        auth: authMode(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );
}
