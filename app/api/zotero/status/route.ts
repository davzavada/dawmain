import { statusResponse } from "@/src/zotero/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/zotero/status → ZoteroStatus (src/zotero/web-types.ts): signed
 * out, configured, Pro, and the connection without its key. Signed out is
 * a normal answer, not an error (src/zotero/web.ts statusResponse).
 */
export async function GET(): Promise<Response> {
  return statusResponse();
}
