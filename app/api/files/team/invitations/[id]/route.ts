import { filesJson } from "@/src/files/errors";
import { errorResponse, originRefusal, sessionUser } from "@/src/files/web";
import { revokeFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/files/team/invitations/[id]?org= — revoke a pending invitation, or drop a declined one from the list. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  const user = await sessionUser("team.revoke");
  if (user instanceof Response) return user;
  try {
    await revokeFor(user, new URL(request.url).searchParams.get("org") ?? "", (await ctx.params).id);
    return filesJson({ revoked: true });
  } catch (error) {
    return errorResponse("team.revoke", error);
  }
}
