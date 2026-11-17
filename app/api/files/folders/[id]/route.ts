import { filesJson } from "@/src/files/errors";
import { deleteFolderFor, envRefusal, errorResponse, originRefusal, patchFolderFor, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One folder of a library the caller belongs to (src/files/web.ts):
 *   PATCH   { action: "rename", name } or { action: "move", parentId }
 *   DELETE  an empty folder only
 * A folder in a library the caller does not belong to is 404, like one
 * that does not exist.
 */
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("folder");
  if (user instanceof Response) return user;
  try {
    return filesJson(await patchFolderFor(user, (await ctx.params).id, await readJson(request)));
  } catch (error) {
    return errorResponse("folder.patch", error);
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("folder");
  if (user instanceof Response) return user;
  try {
    await deleteFolderFor(user, (await ctx.params).id);
    return filesJson({ deleted: true });
  } catch (error) {
    return errorResponse("folder.delete", error);
  }
}
