import { auth } from "@clerk/nextjs/server";
import { filesJson } from "@/src/files/errors";
import { isOperator } from "@/src/files/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/operator — `{ operator: true }` only for a signed-in operator
 * (FILES_OPERATOR_IDS), `{ operator: false }` for everyone else, signed in
 * or not. The account menu shows the "Provoz" link from it; the operator
 * page and its actions check again on their own, so this answer only hides
 * or shows a link.
 */
export async function GET(): Promise<Response> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    userId = null;
  }
  return filesJson({ operator: isOperator(userId) });
}
