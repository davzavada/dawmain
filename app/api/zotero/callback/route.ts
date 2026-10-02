import { callbackResponse } from "@/src/zotero/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/zotero/callback?oauth_token=…&oauth_verifier=… — where zotero.org
 * sends the browser back: checks the state cookie against the session,
 * exchanges the token for a key and stores it sealed with its effective mode
 * (read, or read + save to the personal library); always 303
 * to /?zotero=1&stav=… (src/zotero/web.ts callbackResponse).
 */
export async function GET(request: Request): Promise<Response> {
  return callbackResponse(request);
}
