import { withMcpAuth } from "mcp-handler";
import { authRequired, verifyRequestAuth } from "@/src/mcp/auth";
import { mcpHandler } from "@/src/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby plans cap function duration at 60s; raise it if a tool needs longer.
export const maxDuration = 60;

/**
 * Auth (see src/mcp/auth.ts): accepts the shared access code and
 * Clerk-issued OAuth tokens; fails closed on Vercel when neither is
 * configured. The 401 challenge carries a WWW-Authenticate header pointing at
 * /.well-known/oauth-protected-resource, which is what lets an MCP client
 * discover the OAuth login on its own.
 */
const handler = withMcpAuth(mcpHandler, verifyRequestAuth, { required: authRequired() });

export { handler as GET, handler as POST, handler as DELETE };
