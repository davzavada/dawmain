import { connectResponse } from "@/src/zotero/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/zotero/connect — the "Připojit Zotero" form (a navigation, not
 * fetch) with mode=read|write: 303 to zotero.org's authorize page with the
 * sealed state cookie, or back to /?zotero=1&stav=… (src/zotero/web.ts
 * connectResponse).
 */
export async function POST(request: Request): Promise<Response> {
  return connectResponse(request);
}
