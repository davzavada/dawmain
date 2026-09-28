import { filesJson } from "@/src/files/errors";
import { errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";
import { resendFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/files/team/invitations/[id]/resend { org } — "Pozvat znovu": revoke + a fresh invitation. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  const user = await sessionUser("team.resend");
  if (user instanceof Response) return user;
  try {
    await resendFor(user, await readJson(request, 1_024), (await ctx.params).id, new URL(request.url).origin);
    return filesJson({ invited: true }, 201);
  } catch (error) {
    return errorResponse("team.resend", error);
  }
}
