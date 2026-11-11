import { auth } from "@clerk/nextjs/server";
import { filesJson } from "@/src/files/errors";
import { isEnvAdmin } from "@/src/admin/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/operator — `{ operator: true }` only for a signed-in account the
 * deployment names as admin (ADMIN_USER_IDS, FILES_OPERATOR_IDS),
 * `{ operator: false }` for everyone else, signed in or not. Admins by role
 * in Clerk are recognised in the browser from their public metadata. The
 * account menu shows the "Správa" link from it; the Správa page and its
 * actions check again on their own, so this answer only hides or shows a
 * link. No Clerk call here.
 */
export async function GET(): Promise<Response> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    userId = null;
  }
  return filesJson({ operator: isEnvAdmin(userId) });
}
