import { filesJson } from "@/src/files/errors";
import { errorResponse, sessionUser, summaryFor } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/files/summary — the signed-in user's libraries with document
 * counts, pages and team sizes, the effective mode and whether the content
 * rules were accepted (src/files/web.ts summaryFor). Signed out is a normal
 * answer here ({ state: "signed_out" }), not an error: the header, the nav
 * and the home page ask on every page. `?fresh=1` after joining a team.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await sessionUser("summary");
  if (user instanceof Response) return user.status === 401 ? filesJson({ state: "signed_out" }) : user;
  try {
    return filesJson(await summaryFor(user, { fresh: new URL(request.url).searchParams.get("fresh") === "1" }));
  } catch (error) {
    return errorResponse("summary", error);
  }
}
