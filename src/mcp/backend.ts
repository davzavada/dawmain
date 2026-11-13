import { getAccess } from "@/src/files/access";

/**
 * Where an account's case-law tools read from: "live" = the courts' own
 * databases (src/sources/*), "mirror" = the home mirror
 * (src/sources/mirror.ts). An admin switches it per account on the Správa
 * page ("Judikatura ze zrcadla" = `publicMetadata.features.mirror === true`);
 * every account is live until then. Read through getAccess, so it shares
 * that cache (60 s per user and instance): a switch takes effect within a
 * minute. A banned account, or Clerk not answering, means live — the live
 * tools never depend on the mirror.
 */

export type CaselawBackend = "live" | "mirror";

export async function caselawBackend(userId: string | null | undefined): Promise<CaselawBackend> {
  if (!userId) return "live";
  try {
    const access = await getAccess(userId);
    return access.mirror === true && !access.banned ? "mirror" : "live";
  } catch {
    return "live";
  }
}
