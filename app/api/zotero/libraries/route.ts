import { librariesResponse, toggleLibraryResponse } from "@/src/zotero/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/zotero/libraries → the personal library and the readable groups,
 * each switched on or off for the assistant. POST { library, on } flips one
 * switch (same-origin; at least one stays on) and answers the new list
 * (src/zotero/web.ts librariesResponse, toggleLibraryResponse).
 */
export async function GET(): Promise<Response> {
  return librariesResponse();
}

export async function POST(request: Request): Promise<Response> {
  return toggleLibraryResponse(request);
}
