import { NO_STORE_HEADERS } from "@/src/files/errors";
import { envRefusal, errorResponse, exportFor, fetchSiteRefusal, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The text streams in batches after the response starts; a long book needs a little time.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/files/documents/[id]/export?lib=<library id> — the stored text
 * of one document as a UTF-8 Markdown download (metadata front matter +
 * the DMD text; src/files/web.ts exportFor). Ownership only, Pro not
 * required: the uploader or the library's owner/admin, also in a library
 * that lost Pro. Web session only; a cross-site request (Sec-Fetch-Site)
 * is refused. A document the caller cannot see is 404, like one that does
 * not exist.
 */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const refused = fetchSiteRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document.export");
  if (user instanceof Response) return user;
  try {
    const lib = new URL(request.url).searchParams.get("lib") ?? "";
    const { disposition, body } = await exportFor(user, (await ctx.params).id, lib);
    return new Response(body, {
      status: 200,
      headers: { ...NO_STORE_HEADERS, "content-type": "text/markdown; charset=utf-8", "content-disposition": disposition },
    });
  } catch (error) {
    return errorResponse("document.export", error);
  }
}
