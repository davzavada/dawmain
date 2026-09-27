import { filesJson } from "@/src/files/errors";
import { errorResponse, originRefusal, sessionUser } from "@/src/files/web";
import { removeFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/files/team/members/[userId]?org= — remove a member (team admin; never the last admin or oneself). */
export async function DELETE(request: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  const user = await sessionUser("team.remove");
  if (user instanceof Response) return user;
  try {
    await removeFor(user, new URL(request.url).searchParams.get("org") ?? "", (await ctx.params).userId);
    return filesJson({ removed: true });
  } catch (error) {
    return errorResponse("team.remove", error);
  }
}
