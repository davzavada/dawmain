import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { filesError, filesJson, logFilesError, MESSAGES } from "@/src/files/errors";
import { sameOrigin } from "@/src/files/guards";
import { ingestDocument } from "@/src/files/ingest";
import { handleDocumentUpload } from "@/src/files/upload";
import { envRefusal, errorResponse, listFor, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Ingest runs in after() on this same invocation: a long book needs the time.
export const maxDuration = 300;

/**
 * POST /api/files/documents — upload one converted document (multipart:
 * `meta` JSON + `dmd` gzip; see src/files/upload.ts, which does all the
 * checking). Web session only (Clerk `auth()` reads the session cookie; an
 * OAuth access token is not a session), same-origin only. On 201 the
 * ingest starts in after() — the response does not wait for it; the page
 * polls GET /api/files/status.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return filesError(403, MESSAGES.badOrigin);
  let userId: string | null;
  try {
    ({ userId } = await auth());
  } catch (error) {
    logFilesError("upload.auth", error);
    return filesError(503, MESSAGES.unavailable);
  }
  if (!userId) return filesError(401, MESSAGES.signIn);

  const outcome = await handleDocumentUpload(request, userId);
  if (outcome.status === 201) {
    const { id, libraryId } = outcome;
    after(async () => {
      await ingestDocument(id, libraryId);
    });
    return filesJson({ id, status: "queued" }, 201);
  }
  if (outcome.status === 409) {
    return filesJson({ error: "Tento dokument už v knihovně je.", duplicate: outcome.duplicate }, 409);
  }
  return filesError(outcome.status, outcome.error);
}

/**
 * GET /api/files/documents?lib=<library id> — the documents of one library
 * the caller owns or belongs to, Pro or not (src/files/web.ts listFor): a
 * user who lost Pro still lists and deletes what they stored. A library
 * the caller does not belong to answers 404, like an unknown one.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = envRefusal();
  if (refused) return refused;
  const user = await sessionUser("documents.list");
  if (user instanceof Response) return user;
  try {
    return filesJson(await listFor(user, new URL(request.url).searchParams.get("lib") ?? ""));
  } catch (error) {
    return errorResponse("documents.list", error);
  }
}
