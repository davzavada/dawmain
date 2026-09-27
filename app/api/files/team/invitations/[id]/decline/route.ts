import { filesJson } from "@/src/files/errors";
import { errorResponse, originRefusal, sessionUser } from "@/src/files/web";
import { declineFor } from "@/src/files/web-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files/team/invitations/[id]/decline — the invitee declines.
 * Clerk's frontend API can only accept; the server verifies the invitation
 * is addressed to one of the caller's verified e-mail addresses and revokes it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  const user = await sessionUser("team.decline");
  if (user instanceof Response) return user;
  try {
    await declineFor(user, (await ctx.params).id);
    return filesJson({ declined: true });
  } catch (error) {
    return errorResponse("team.decline", error);
  }
}
