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

/** Every candidate token the request carries, "Bearer " prefix stripped. */
function extractTokens(request: Request): string[] {
  const candidates: string[] = [];
  for (const name of TOKEN_HEADERS) {
    const raw = request.headers.get(name)?.trim();
    if (!raw) continue;
    // Accept the value with or without a "Bearer " prefix in every header.
    candidates.push(raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw);
  }
  return candidates;
}

async function handle(request: Request): Promise<Response> {
  const expected = getBearerToken();

  if (!expected) {
    // Fail CLOSED on any deployment. A blank, misspelled or environment-scoped
    // MCP_BEARER_TOKEN would otherwise silently publish the whole tool surface
    // — on production and on every preview URL alike — with nothing to notice
    // it by. Anonymous access stays possible only when running locally.
    if (process.env.VERCEL) return unauthorized();
  } else {
    // Check EVERY header present, not just the first: a client that also sends
    // an unrelated Authorization header must not be locked out when the real
    // token rides in x-api-key (the reason those fallbacks exist).
    const candidates = extractTokens(request);
    if (!candidates.some((candidate) => tokenMatches(expected, candidate))) {
      return unauthorized();
    }
  }

  return mcpHandler(request);
}

export { handle as GET, handle as POST, handle as DELETE };
