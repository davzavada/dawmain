import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { getAccess } from "@/src/files/access";
import { LIBRARY_ID_RE, UUID_RE } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { documentStatuses } from "@/src/files/db/documents";
import { filesError, filesJson, FilesUserError, logFilesError, MESSAGES } from "@/src/files/errors";
import { envOnlyMode } from "@/src/files/guards";
import { kickPendingIngests } from "@/src/files/ingest";
import { ownedScope } from "@/src/files/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The kick in after() may run a couple of ingests.
export const maxDuration = 300;

/** Documents one poll may ask about. */
const MAX_IDS = 100;
/** Waiting ingests a poll may start (the upload's own after() is the normal path). */
const KICK = 2;

/**
 * GET /api/files/status?lib=<library id>&ids=<uuid,…> — processing status
 * of the caller's uploads, for the page's polling. A library the caller
 * does not belong to answers exactly like one that does not exist (404);
 * unknown or foreign document ids are simply absent. When a polled
 * document is still waiting, waiting ingests are (re)started in after() —
 * the fallback for an upload whose own after() died.
 */
export async function GET(request: Request): Promise<Response> {
  const env = envOnlyMode();
  if (env === "off" || env === "unconfigured") return filesError(503, MESSAGES.off);
  let userId: string | null;
  try {
    ({ userId } = await auth());
  } catch (error) {
    logFilesError("status.auth", error);
    return filesError(503, MESSAGES.unavailable);
  }
  if (!userId) return filesError(401, MESSAGES.signIn);

  const params = new URL(request.url).searchParams;
  const lib = params.get("lib") ?? "";
  if (!LIBRARY_ID_RE.test(lib)) return filesError(404, "Knihovna nenalezena.");
  const ids = [
    ...new Set(
      (params.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => UUID_RE.test(s)),
    ),
  ].slice(0, MAX_IDS);

  try {
    const scope = ownedScope(await getAccess(userId), lib);
    if (ids.length === 0) return filesJson({ documents: [] });
    const documents = await withScope(scope.libraryIds, (db) => documentStatuses(db, [...scope.libraryIds], ids));
    if (documents.some((d) => d.status === "queued" || d.status === "processing")) {
      after(async () => {
        await kickPendingIngests(KICK);
      });
    }
    return filesJson({ documents });
  } catch (error) {
    if (error instanceof FilesUserError) return filesError(error.status, error.message);
    logFilesError("status", error);
    return filesError(503, MESSAGES.unavailable);
  }
}
