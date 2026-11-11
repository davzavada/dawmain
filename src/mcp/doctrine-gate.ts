import { getAccess } from "@/src/files/access";
import { SourceError, toToolError } from "@/src/sources/shared/errors";
import { callerFromCtx } from "./caller";

/**
 * UKAŽ (doctrine_*) is switched on per account by an admin
 * (publicMetadata.features.ukaz === true, set on the Správa page).
 *
 * Only a signed-in account is checked. The shared access code and a
 * deployment without any credential (local development) belong to no
 * account and keep the tools, as before; the gate exists to hold back
 * accounts that were not confirmed.
 *
 * Returns null when the call may go on, else the tool result to answer
 * with. A Clerk failure refuses too (fail closed) with its own text, so an
 * outage is not mistaken for "not confirmed".
 */

const SOURCE = "UKAŽ";
const NOT_ENABLED = "Doktrína (UKAŽ) není pro tento účet zapnutá. Zapíná ji správce Dawmainu po potvrzení.";
const UNVERIFIED = "Oprávnění k doktríně (UKAŽ) se teď nepodařilo ověřit.";

export async function doctrineRefusal(ctx: unknown): Promise<ReturnType<typeof toToolError> | null> {
  const caller = callerFromCtx(ctx);
  if (caller.kind !== "user") return null;
  try {
    const access = await getAccess(caller.userId);
    if (access.ukaz === true && !access.banned) return null;
  } catch {
    return toToolError(
      new SourceError(SOURCE, "UPSTREAM_UNREACHABLE", UNVERIFIED, "Try again in a minute; meanwhile continue with the other sources."),
    );
  }
  return toToolError(
    new SourceError(
      SOURCE,
      "NOT_ENTITLED",
      NOT_ENABLED,
      "Do not call doctrine_* again in this conversation; tell the user the literature search is not enabled for their account and continue with the official sources (legislation, case law).",
    ),
  );
}
