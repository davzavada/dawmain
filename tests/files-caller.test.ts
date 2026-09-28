import { describe, expect, it } from "vitest";
import { callerFromCtx } from "@/src/mcp/caller";

/**
 * callerFromCtx (src/mcp/caller.ts): the identity the private files_* tools
 * are gated on. Only SDK v2's ctx.http.authInfo counts.
 */

const oauth = (extra: unknown, clientId: unknown = "client_abc") => ({ http: { authInfo: { token: "t", clientId, scopes: [], extra } } });

describe("callerFromCtx", () => {
  it("a Clerk OAuth token (verifyClerkToken shape) is a user", () => {
    expect(callerFromCtx(oauth({ userId: "user_2abcDEF123" }))).toEqual({
      kind: "user",
      userId: "user_2abcDEF123",
      clientId: "client_abc",
    });
  });

  it("the shared access code is shared-token, never a user — even with a userId riding along", () => {
    const ctx = { http: { authInfo: { token: "x", clientId: "shared-token", scopes: [], extra: { method: "shared-token" } } } };
    expect(callerFromCtx(ctx)).toEqual({ kind: "shared-token" });
    expect(callerFromCtx(oauth({ userId: "user_abc" }, "shared-token"))).toEqual({ kind: "shared-token" });
  });

  it("REGRESSION: the SDK v1 shape extra.authInfo is not accepted", () => {
    const v1 = { authInfo: { token: "t", clientId: "client_abc", scopes: [], extra: { userId: "user_abc" } } };
    expect(callerFromCtx(v1)).toEqual({ kind: "anonymous" });
    expect(callerFromCtx({ extra: v1 })).toEqual({ kind: "anonymous" });
    expect(callerFromCtx({ requestInfo: v1, _meta: v1 })).toEqual({ kind: "anonymous" });
  });

  it("no auth at all is anonymous", () => {
    for (const ctx of [undefined, null, 0, "user_abc", [], {}, { http: {} }, { http: { authInfo: null } }, { http: null }]) {
      expect(callerFromCtx(ctx)).toEqual({ kind: "anonymous" });
    }
  });

  it("validates the user id against ^user_[A-Za-z0-9]+$", () => {
    for (const userId of ["org_abc", "user_", "user_a b", "user_abc;drop", "USER_abc", " user_abc", "user_abc\n", "", 42, null, ["user_abc"], { id: "user_abc" }]) {
      expect(callerFromCtx(oauth({ userId }))).toEqual({ kind: "anonymous" });
    }
    expect(callerFromCtx(oauth(null))).toEqual({ kind: "anonymous" });
    expect(callerFromCtx(oauth({ sub: "user_abc" }))).toEqual({ kind: "anonymous" });
  });

  it("requires a client id for a user (every Clerk OAuth token carries one)", () => {
    for (const clientId of [null, "", 7, "x".repeat(201)]) {
      expect(callerFromCtx(oauth({ userId: "user_abc" }, clientId))).toEqual({ kind: "anonymous" });
    }
    expect(callerFromCtx({ http: { authInfo: { token: "t", scopes: [], extra: { userId: "user_abc" } } } })).toEqual({ kind: "anonymous" });
  });

  it("never throws, even on a hostile object", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(callerFromCtx(hostile)).toEqual({ kind: "anonymous" });
    expect(callerFromCtx({ http: hostile })).toEqual({ kind: "anonymous" });
  });

  it("returns frozen values", () => {
    const caller = callerFromCtx(oauth({ userId: "user_abc" }));
    expect(Object.isFrozen(caller)).toBe(true);
  });
});
