import type { MirrorCounts, MirrorSourceId } from "@/src/mcp/databases";
import { mirrorApiStatus, mirrorConfigured } from "@/src/sources/mirror";

/**
 * GET /api/status/mirror → MirrorCounts: how many decisions the case-law
 * mirror holds per court, for the "Interní databáze" panel on the home page.
 * `{}` where the deployment has no mirror or it does not answer.
 *
 * Static like /api/status: regenerated in the background at most once an
 * hour, so the cached answer serves every visitor and no check runs for them; also
 * outside proxy.ts's matcher (public, the same for everyone).
 */
export const revalidate = 3600;

const COURTS: readonly MirrorSourceId[] = ["ns", "nss", "us", "justice"];

export async function GET(): Promise<Response> {
  const counts: MirrorCounts = {};
  if (mirrorConfigured()) {
    try {
      const status = await mirrorApiStatus();
      for (const s of status?.sources ?? []) {
        if ((COURTS as readonly string[]).includes(s.source) && typeof s.decisions === "number") counts[s.source as MirrorSourceId] = s.decisions;
      }
    } catch {
      // No counts this hour: the panel shows the status lights instead.
    }
  }
  return Response.json(counts);
}
