import { filesJson } from "@/src/files/errors";
import { createFolderFor } from "@/src/files/folders";
import { envRefusal, errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files/folders { lib, parentId: string | null, name } — create a
 * folder in a library the caller may upload into (src/files/folders.ts).
 * 201 with the FolderItem; 409 when a sibling already has the name.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("folders");
  if (user instanceof Response) return user;
  try {
    return filesJson(await createFolderFor(user, await readJson(request)), 201);
  } catch (error) {
    return errorResponse("folders.create", error);
  }
}
