import { currentHealth } from "@/src/mcp/health";

/**
 * GET /api/status/health → 200 `{ ok: true, … }` when the service can do its
 * work, 503 with the failing checks otherwise — for an uptime monitor. The
 * checks and what they mean: src/mcp/health.ts. Public, under /api/status
 * (outside proxy.ts's matcher), never cached by anything in front of it.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const health = await currentHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
