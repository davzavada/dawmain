import { filesJson } from "@/src/files/errors";
import { createFolderFor, envRefusal, errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files/folders — { lib, parentId, name }: a new folder in a
 * library the caller may upload into (src/files/web.ts createFolderFor).
 * The folders themselves come with GET /api/files/documents?lib=.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("folder");
  if (user instanceof Response) return user;
  try {
    return filesJson(await createFolderFor(user, await readJson(request)), 201);
  } catch (error) {
    return errorResponse("folder.create", error);
  }
}
