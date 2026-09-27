import { filesJson } from "@/src/files/errors";
import { deleteFor, detailFor, envRefusal, errorResponse, originRefusal, patchFor, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A metadata change that alters the document type re-derives the index in after().
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * One document of a library the caller belongs to (src/files/web.ts):
 *   GET     detail + the first ~1,500 characters as plain text
 *   PATCH   { action: "confirm" | "save", version, meta } or { action: "enable", enabled }
 *   DELETE  delete (allowed in read-only mode)
 * A document in a library the caller does not belong to is 404, like one
 * that does not exist.
 */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const refused = envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document");
  if (user instanceof Response) return user;
  try {
    return filesJson(await detailFor(user, (await ctx.params).id));
  } catch (error) {
    return errorResponse("document.get", error);
  }
}

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document");
  if (user instanceof Response) return user;
  try {
    return filesJson(await patchFor(user, (await ctx.params).id, await readJson(request)));
  } catch (error) {
    return errorResponse("document.patch", error);
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document");
  if (user instanceof Response) return user;
  try {
    await deleteFor(user, (await ctx.params).id);
    return filesJson({ deleted: true });
  } catch (error) {
    return errorResponse("document.delete", error);
  }
}
