import { filesJson } from "@/src/files/errors";
import { errorResponse, sessionUser } from "@/src/files/web";
import { teamFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/files/team?org=<org id> — members and invitations, for the team's admin (src/files/web-team.ts). */
export async function GET(request: Request): Promise<Response> {
  const user = await sessionUser("team");
  if (user instanceof Response) return user;
  try {
    return filesJson(await teamFor(user, new URL(request.url).searchParams.get("org") ?? ""));
  } catch (error) {
    return errorResponse("team", error);
  }
}
