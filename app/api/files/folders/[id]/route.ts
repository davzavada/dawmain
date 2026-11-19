import { filesJson } from "@/src/files/errors";
import { deleteFolderFor, patchFolderFor } from "@/src/files/folders";
import { envRefusal, errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One folder (src/files/folders.ts):
 *   PATCH   { name?, parentId? } — rename and/or move (parentId null = the root) → FolderItem
 *   DELETE  the folder, its subfolders and every document in them
 *           → { deleted: true, deletedDocuments, deletedFolders }
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
    return filesJson(await deleteFolderFor(user, (await ctx.params).id));
  } catch (error) {
    return errorResponse("folder.delete", error);
  }
}
