import { USER_ID_RE } from "@/src/files/config";

/**
 * Who is calling an MCP tool — the identity the private tools (files_*)
 * are gated on. The endpoint accepts two credentials (src/mcp/auth.ts):
 *
 *   - the shared access code → `{ clientId: "shared-token", extra: { method } }`:
 *     a deployment-wide secret with NO user behind it — it may use the
 *     public sources, never a private library;
 *   - a Clerk OAuth access token → verifyClerkToken's
 *     `{ clientId, scopes, extra: { userId } }`.
 *
 * With MCP SDK v2 a tool handler receives that AuthInfo as
 * `ctx.http.authInfo`; this reads ONLY that path. The SDK v1 shape
 * (`extra.authInfo`, the handler's second argument in v1) is deliberately
 * ignored: a second, silently accepted location is how an identity ends up
 * read from somewhere a caller controls (tests/files-caller.test.ts pins it).
 *
 * Total: never throws, whatever `ctx` is. Pure.
 */

export type Caller =
  | { kind: "user"; userId: string; clientId: string }
  | { kind: "shared-token" }
  | { kind: "anonymous" };

const ANONYMOUS: Caller = Object.freeze({ kind: "anonymous" });
const SHARED: Caller = Object.freeze({ kind: "shared-token" });

/** Longest OAuth client id we pass on (it is logged next to files calls). */
const MAX_CLIENT_ID = 200;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function callerFromCtx(ctx: unknown): Caller {
  try {
    const http = record(record(ctx)?.http);
    const authInfo = record(http?.authInfo);
    if (!authInfo) return ANONYMOUS;
    const clientId = authInfo.clientId;
    // The shared code is checked first: it can only ever downgrade a caller.
    if (clientId === "shared-token") return SHARED;
    const userId = record(authInfo.extra)?.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) return ANONYMOUS;
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > MAX_CLIENT_ID) return ANONYMOUS;
    return Object.freeze({ kind: "user", userId, clientId });
  } catch {
    // A hostile getter on a proxy object — treat as no identity.
    return ANONYMOUS;
  }
}
