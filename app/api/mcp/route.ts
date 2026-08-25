import { getBearerToken, tokenMatches } from "@/src/mcp/config";
import { mcpHandler } from "@/src/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby plans cap function duration at 60s; raise it if a tool needs longer.
export const maxDuration = 60;

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "A valid bearer token is required." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="mcp"',
      },
    },
  );
}

/**
 * Header names the token is accepted from. `Authorization: Bearer <t>` is the
 * canonical form; the alternatives exist because some connector UIs (e.g. the
 * claude.ai custom-connector dialog) reserve the Authorization name for OAuth
 * and only offer preset header names.
 */
const TOKEN_HEADERS = ["authorization", "x-api-key", "cf-aig-authorization"];

function extractToken(request: Request): string | null {
  for (const name of TOKEN_HEADERS) {
    const raw = request.headers.get(name)?.trim();
    if (!raw) continue;
    // Accept the value with or without a "Bearer " prefix in every header.
    return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
  }
  return null;
}

async function handle(request: Request): Promise<Response> {
  const expected = getBearerToken();

  if (expected) {
    const provided = extractToken(request);
    if (!provided || !tokenMatches(expected, provided)) {
      return unauthorized();
    }
  }

  return mcpHandler(request);
}

export { handle as GET, handle as POST, handle as DELETE };
