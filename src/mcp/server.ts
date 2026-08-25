import { createMcpHandler } from "mcp-handler";
import { SERVER_NAME, SERVER_VERSION } from "./config";
import { registerAllTools } from "./tools";

/**
 * The MCP server as a web-standard `(Request) => Promise<Response>` handler.
 *
 * `mcp-handler` serves the 2026-07-28 spec natively and falls back to
 * stateless Streamable HTTP for 2025-era clients from the same handler, so a
 * single route covers both client generations. Everything is stateless —
 * no sessions, no Redis — which is what makes it safe to run on serverless
 * functions that scale to zero.
 */
export const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    verboseLogs: process.env.VERCEL_ENV !== "production",
  },
);
