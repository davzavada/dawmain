import { withMcpAuth } from "mcp-handler";
import { authRequired, challengeOrigin, verifyRequestAuth } from "@/src/mcp/auth";
import { mcpHandler } from "@/src/mcp/server";
import { runWithCallClock } from "@/src/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Auth (see src/mcp/auth.ts): accepts the shared access code and
 * Clerk-issued OAuth tokens; fails closed on a production server even when
 * neither is configured. The 401 challenge carries a WWW-Authenticate header pointing at
 * /.well-known/oauth-protected-resource, which is what lets an MCP client
 * discover the OAuth login on its own.
 */
const authed = withMcpAuth(mcpHandler, verifyRequestAuth, {
  required: authRequired(),
  resourceUrl: challengeOrigin(),
});

/** Each request runs with its arrival time on record: every tool answers in
 * text within the 60 s call ceiling, counted from here (CALL_BUDGET_MS). */
const handler = (request: Request): Promise<Response> => runWithCallClock(() => authed(request));

export { handler as GET, handler as POST, handler as DELETE };
