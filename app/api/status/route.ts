import { allDatabaseStatuses } from "@/src/mcp/status";

/**
 * GET /api/status → DatabaseStatus[] (src/mcp/databases.ts), every database
 * the home page lists, one canary each.
 *
 * Static: prerendered at build and regenerated in the background at most
 * every 14 minutes (ISR), and by day a server timer asks every 15 minutes, so the cached answer serves every visitor at once and
 * no check runs for them; the first request after the hour is up still gets the old
 * answer and starts the next check. The time each badge shows says how old
 * its check is. Outside proxy.ts's matcher: the answer is public and the
 * same for everyone, and Clerk in front of it only cost each request a
 * function call before the cache.
 */
// 14 min: just under the server's 15-minute daytime ping (deploy/web/dawmain-status.timer),
// so every ping finds the answer stale and starts the next check.
export const revalidate = 840;

export async function GET(): Promise<Response> {
  return Response.json(await allDatabaseStatuses());
}
