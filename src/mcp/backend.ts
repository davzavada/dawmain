import { operatorIds, USER_ID_RE } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { getSystemState, setSystemState } from "@/src/files/db/usage";

/**
 * Where the case-law tools read from, per operator: "live" = the courts' own
 * databases (src/sources/*), "mirror" = the home mirror (src/sources/mirror.ts).
 * Only operators (FILES_OPERATOR_IDS) can choose; everyone else is always live.
 * Stored in system_state under `caselaw_backend:<userId>` and switched on the
 * operator page (/vlastni-zdroje/provoz). Read once per tool call, cached
 * per instance for 30 s, so a switch takes effect within that.
 */

export type CaselawBackend = "live" | "mirror";

const KEY_PREFIX = "caselaw_backend:";
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; backend: CaselawBackend }>();

export function isOperatorId(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && USER_ID_RE.test(userId) && operatorIds().includes(userId);
}

function parse(value: unknown): CaselawBackend {
  return value && typeof value === "object" && (value as { backend?: unknown }).backend === "mirror" ? "mirror" : "live";
}

/** The operator's choice; "live" for anyone else and whenever the database cannot be read. */
export async function caselawBackend(userId: string | null | undefined): Promise<CaselawBackend> {
  if (!isOperatorId(userId)) return "live";
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.backend;
  let backend: CaselawBackend = "live";
  try {
    backend = parse(await withScope([], (db) => getSystemState<unknown>(db, KEY_PREFIX + userId)));
  } catch {
    backend = "live";
  }
  cache.set(userId, { at: Date.now(), backend });
  return backend;
}

export async function setCaselawBackend(userId: string, backend: CaselawBackend): Promise<void> {
  if (!isOperatorId(userId)) throw new Error("Not allowed.");
  await withScope([], (db) => setSystemState(db, KEY_PREFIX + userId, { backend, at: new Date().toISOString() }));
  cache.set(userId, { at: Date.now(), backend });
}

/** Tests only. */
export function clearCaselawBackendCache(): void {
  cache.clear();
}
