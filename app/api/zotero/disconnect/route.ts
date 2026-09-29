import { disconnectResponse } from "@/src/zotero/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/zotero/disconnect — "Odpojit": revoke the key on zotero.org (best effort) and forget it → { ok: true }. */
export async function POST(request: Request): Promise<Response> {
  return disconnectResponse(request);
}
