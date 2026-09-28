import { filesJson } from "@/src/files/errors";
import { acceptTermsFor, envRefusal, errorResponse, originRefusal, readJson, sessionUser } from "@/src/files/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files/terms { accept: true, version } — the signed-in user
 * accepts the current Vlastní zdroje content rules (TERMS_VERSION); the
 * upload route refuses until they have.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = originRefusal(request) ?? envRefusal();
  if (refused) return refused;
  const user = await sessionUser("terms");
  if (user instanceof Response) return user;
  try {
    await acceptTermsFor(user, await readJson(request, 1_024));
    return filesJson({ accepted: true });
  } catch (error) {
    return errorResponse("terms", error);
  }
}
