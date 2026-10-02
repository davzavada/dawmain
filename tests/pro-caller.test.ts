import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAccessLoaderForTests, buildAccess, emptyAccess, type Access, type LibraryAccess } from "@/src/files/access";
import { LIMITS } from "@/src/files/config";
import { __resetGuardsForTests, allowToolCall } from "@/src/files/guards";
import { personalProCaller, proRefusal } from "@/src/mcp/pro-caller";

/**
 * personalProCaller (src/mcp/pro-caller.ts): the entitlement files_* and
 * zotero_* share — a personal OAuth sign-in whose account holds a Pro
 * library, personal or team. Clerk is replaced by an access loader; the
 * files gate's wording on top of these reasons is pinned in
 * tests/files-tools.test.ts.
 */

const USER = "user_2abcDEF123";
const CLIENT = "client_abc";

const PERSONAL_PRO: LibraryAccess = {
  id: USER,
  kind: "user",
  name: "Osobní",
  slug: null,
  role: "owner",
  pro: true,
  canUpload: true,
  canManageAll: true,
  quotaPages: 3000,
};
const PERSONAL_FREE: LibraryAccess = { ...PERSONAL_PRO, pro: false, canUpload: false };

const PRO_ACCESS: Access = { userId: USER, banned: false, libraries: [PERSONAL_PRO], all: [PERSONAL_PRO], zotero: true };
const NON_PRO_ACCESS: Access = { userId: USER, banned: false, libraries: [], all: [PERSONAL_FREE], zotero: false };

const userCtx = (userId: unknown = USER, clientId: unknown = CLIENT) => ({
  http: { authInfo: { token: "t", clientId, scopes: [], extra: { userId } } },
});
const SHARED_CTX = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { method: "token" } } } };

const loader = vi.fn<(userId: string) => Promise<Access>>();

beforeEach(() => {
  loader.mockReset();
  loader.mockImplementation(async () => PRO_ACCESS);
  __setAccessLoaderForTests(loader);
});

afterEach(() => {
  __setAccessLoaderForTests(null);
});

describe("personalProCaller — refused before any lookup", () => {
  it("the shared access code, even with a userId riding along", async () => {
    expect(await personalProCaller(SHARED_CTX, "files")).toEqual({ ok: false, reason: "shared-token" });
    const riding = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { userId: USER } } } };
    expect(await personalProCaller(riding, "files")).toEqual({ ok: false, reason: "shared-token" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("no signed-in user: missing, malformed or the SDK v1 shape", async () => {
    const v1 = { authInfo: { token: "t", clientId: CLIENT, scopes: [], extra: { userId: USER } } };
    for (const ctx of [undefined, null, {}, 0, "user_abc", { http: {} }, { http: { authInfo: null } }, v1]) {
      expect(await personalProCaller(ctx, "files"), JSON.stringify(ctx)).toEqual({ ok: false, reason: "anonymous" });
    }
    for (const ctx of [userCtx("org_x"), userCtx("user_a b"), userCtx(42), userCtx(USER, ""), userCtx(USER, "c".repeat(201))]) {
      expect(await personalProCaller(ctx, "files"), JSON.stringify(ctx)).toEqual({ ok: false, reason: "anonymous" });
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("a hostile context (throwing getter) is anonymous, not an exception", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(await personalProCaller(hostile, "files")).toEqual({ ok: false, reason: "anonymous" });
    expect(await personalProCaller({ http: hostile }, "files")).toEqual({ ok: false, reason: "anonymous" });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("personalProCaller — the account", () => {
  it("a user with a personal Pro library", async () => {
    const r = await personalProCaller(userCtx(), "files");
    expect(r).toEqual({ ok: true, userId: USER, clientId: CLIENT, access: PRO_ACCESS });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(USER);
    // The shared, cached Access comes back frozen: no request may mutate what another is reading.
    if (r.ok) expect(Object.isFrozen(r.access)).toBe(true);
  });

  it("the same holds for an Access built from Clerk-shaped data; Clerk organizations play no part", async () => {
    loader.mockImplementation(async (id) => buildAccess({ id, publicMetadata: { pro: true } }));
    const r = await personalProCaller(userCtx(), "files");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.access.libraries.map((l) => l.id)).toEqual([USER]);
    loader.mockImplementation(async (id) => buildAccess({ id, publicMetadata: { pro: "true" } }));
    __setAccessLoaderForTests(loader);
    expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "no-pro" });
  });

  it("a user without any Pro library", async () => {
    loader.mockImplementation(async () => NON_PRO_ACCESS);
    expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "no-pro" });
  });

  it("a user Clerk does not know (empty access) is no-pro", async () => {
    loader.mockImplementation(async (id) => emptyAccess(id));
    expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "no-pro" });
  });

  it("a banned or locked account — also when the flag comes with libraries", async () => {
    for (const make of [
      (id: string) => buildAccess({ id, banned: true, publicMetadata: { pro: true } }),
      (id: string) => buildAccess({ id, locked: true, publicMetadata: { pro: true } }),
      () => ({ ...PRO_ACCESS, banned: true }),
    ]) {
      loader.mockImplementation(async (id) => make(id));
      __setAccessLoaderForTests(loader);
      expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "banned" });
    }
  });

  it("each feature is gated on its own: files on the Vlastní zdroje libraries, zotero on access.zotero", async () => {
    const noZotero: Access = { ...PRO_ACCESS, zotero: false };
    const zoteroOnly: Access = { ...NON_PRO_ACCESS, zotero: true };
    loader.mockImplementation(async () => noZotero);
    expect((await personalProCaller(userCtx(), "files")).ok).toBe(true);
    __setAccessLoaderForTests(loader);
    expect(await personalProCaller(userCtx(), "zotero")).toEqual({ ok: false, reason: "no-pro" });
    loader.mockImplementation(async () => zoteroOnly);
    __setAccessLoaderForTests(loader);
    expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "no-pro" });
    __setAccessLoaderForTests(loader);
    expect((await personalProCaller(userCtx(), "zotero")).ok).toBe(true);
    expect(proRefusal(noZotero, "files")).toBeNull();
    expect(proRefusal(noZotero, "zotero")).toBe("no-pro");
    expect(proRefusal({ ...zoteroOnly, banned: true }, "zotero")).toBe("banned");
  });

  it("the switches from Clerk's publicMetadata reach the gate", async () => {
    loader.mockImplementation(async (id) => buildAccess({ id, publicMetadata: { pro: true, features: { zotero: false } } }));
    expect((await personalProCaller(userCtx(), "files")).ok).toBe(true);
    __setAccessLoaderForTests(loader);
    expect(await personalProCaller(userCtx(), "zotero")).toEqual({ ok: false, reason: "no-pro" });
    loader.mockImplementation(async (id) => buildAccess({ id, publicMetadata: { pro: true, features: { files: false } } }));
    __setAccessLoaderForTests(loader);
    expect(await personalProCaller(userCtx(), "files")).toEqual({ ok: false, reason: "no-pro" });
    __setAccessLoaderForTests(loader);
    expect((await personalProCaller(userCtx(), "zotero")).ok).toBe(true);
  });

  it("a Clerk failure is rethrown as is — never mistaken for 'not Pro'", async () => {
    const failure = Object.assign(new Error("Clerk 500"), { code: "api_response_error", status: 500 });
    loader.mockImplementation(async () => {
      throw failure;
    });
    await expect(personalProCaller(userCtx(), "files")).rejects.toBe(failure);
    // Not cached: the next call asks Clerk again and succeeds.
    loader.mockImplementation(async () => PRO_ACCESS);
    expect((await personalProCaller(userCtx(), "files")).ok).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("allowToolCall — a second tool family's own bucket", () => {
  beforeEach(() => __resetGuardsForTests());

  it("a prefixed key with its own capacity neither drains nor shares the files_* bucket", () => {
    const now = 1_000_000;
    const zotero = `zotero:${USER}`;
    const capacity = 5;
    for (let i = 0; i < capacity; i++) expect(allowToolCall(zotero, now, capacity)).toBe(true);
    expect(allowToolCall(zotero, now, capacity)).toBe(false);
    // The files_* bucket of the same user is untouched and keeps its default size.
    for (let i = 0; i < LIMITS.toolCallsPerHour; i++) expect(allowToolCall(USER, now)).toBe(true);
    expect(allowToolCall(USER, now)).toBe(false);
    // The prefixed bucket refills at its own rate: capacity tokens per hour.
    const perToken = 3_600_000 / capacity;
    expect(allowToolCall(zotero, now + perToken * 0.5, capacity)).toBe(false);
    expect(allowToolCall(zotero, now + perToken * 1.1, capacity)).toBe(true);
    // Never more than its capacity, however long it rested.
    const later = now + 10 * 3_600_000;
    for (let i = 0; i < capacity; i++) expect(allowToolCall(zotero, later, capacity)).toBe(true);
    expect(allowToolCall(zotero, later, capacity)).toBe(false);
  });
});
