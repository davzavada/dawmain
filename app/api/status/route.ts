import { allDatabaseStatuses } from "@/src/mcp/status";

/**
 * GET /api/status → DatabaseStatus[] (src/mcp/databases.ts), every database
 * the home page lists, one canary each.
 *
 * Static: prerendered at build and regenerated in the background at most
 * once an hour (ISR), so the CDN answers every visitor at once and no function
 * runs for them; the first request after the hour is up still gets the old
 * answer and starts the next check. The time each badge shows says how old
 * its check is. Outside proxy.ts's matcher: the answer is public and the
 * same for everyone, and Clerk in front of it only cost each request a
 * function call before the cache.
 */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  return Response.json(await allDatabaseStatuses());
}
