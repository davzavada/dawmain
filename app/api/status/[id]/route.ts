import { databaseStatus } from "@/src/mcp/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/status/[id] → DatabaseStatus (src/mcp/databases.ts) of one
 * database, by its canary id; 404 for any other id. One request per badge
 * (app/_source-status.tsx), so a slow source delays only its own badge, and
 * the pages do not wait on any of them.
 *
 * Public and the same for everyone, so the CDN keeps it for a minute and
 * then, for up to an hour, serves the previous answer at once while it asks
 * again in the background: the badges fill in without waiting even after a
 * quiet spell, and the time each badge shows says how old its check is. The
 * canary behind it is cached on top (src/mcp/status.ts).
 */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const status = await databaseStatus((await ctx.params).id);
  if (!status) return Response.json({ error: "Neznámý zdroj." }, { status: 404 });
  return Response.json(status, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=3600" },
  });
}
