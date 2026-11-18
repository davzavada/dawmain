import { filesJson } from "@/src/files/errors";
import { finalizeOriginalFor, originalDownloadFor, putOriginalPartFor } from "@/src/files/originals";
import { envRefusal, errorResponse, fetchSiteRefusal, originRefusal, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The original file of one document (src/files/originals.ts):
 *   PUT   ?part=N  application/octet-stream — one part of exactly
 *                  ORIGINAL_PART_BYTES (the last one shorter); 204
 *   POST           finalize: all parts there, SHA-256 = the declared file
 *                  hash → { original: "ready" }; mismatch → 422
 *   GET   [?inline=1]  the file (inline only for PDF and plain text)
 * PUT/POST: the uploader, same-origin, mode "on". GET: anyone who belongs
 * to the library; a cross-site request (Sec-Fetch-Site) is refused. A
 * document the caller cannot see is 404, like one that does not exist.
 */
export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document.original");
  if (user instanceof Response) return user;
  try {
    await putOriginalPartFor(user, (await ctx.params).id, new URL(request.url).searchParams.get("part"), request);
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse("document.original.put", error);
  }
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document.original");
  if (user instanceof Response) return user;
  try {
    return filesJson(await finalizeOriginalFor(user, (await ctx.params).id));
  } catch (error) {
    return errorResponse("document.original.finalize", error);
  }
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const refused = fetchSiteRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("document.original");
  if (user instanceof Response) return user;
  try {
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    const { headers, body } = await originalDownloadFor(user, (await ctx.params).id, { inline });
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return errorResponse("document.original.get", error);
  }
}
