import { filesJson } from "@/src/files/errors";
import { errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";
import { inviteFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/files/team/invitations { org, email } — invite a member (team admin only). */
export async function POST(request: Request): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  const user = await sessionUser("team.invite");
  if (user instanceof Response) return user;
  try {
    await inviteFor(user, await readJson(request, 2_048), new URL(request.url).origin);
    return filesJson({ invited: true }, 201);
  } catch (error) {
    return errorResponse("team.invite", error);
  }
}
