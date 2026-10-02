import { databaseStatuses } from "@/src/mcp/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/status → DatabaseStatus[] (src/mcp/databases.ts): the badges
 * next to each database and the summary in the header. The pages do not
 * wait on it — the browser asks after the page is up (app/_source-status.tsx),
 * so a slow source can only delay its badge.
 *
 * Public and the same for everyone, so the CDN keeps it for a minute and
 * serves the previous answer while it asks again: most visitors never reach
 * the function at all, and the canaries behind it are cached on top
 * (src/mcp/status.ts).
 */
export async function GET(): Promise<Response> {
  return Response.json(await databaseStatuses(), {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
  });
}
