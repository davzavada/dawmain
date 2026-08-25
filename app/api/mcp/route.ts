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

async function handle(request: Request): Promise<Response> {
  const expected = getBearerToken();

  if (expected) {
    const header = request.headers.get("authorization") ?? "";
    const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!provided || !tokenMatches(expected, provided)) {
      return unauthorized();
    }
  }

  return mcpHandler(request);
}

export { handle as GET, handle as POST, handle as DELETE };
