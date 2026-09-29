import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Zotero connection store (src/zotero/store.ts): one sealed API key per
 * Clerk user in privateMetadata.zotero. Clerk's backend client is mocked by
 * an in-memory user table that merges metadata the way updateUserMetadata
 * does — a JSON merge patch (RFC 7396): objects merged, arrays and scalars
 * replaced, and a null deletes its key at any depth (so a field written as
 * null reads back absent); no network.
 */

const clerk = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({ users: { getUser: clerk.getUser, updateUserMetadata: clerk.updateUserMetadata } }),
}));

import { sealSecret } from "@/src/secrets/seal";
import { CACHE_TTL_MS } from "@/src/zotero/config";
import {
  __resetZoteroStoreForTests,
  deleteConnection,
  keyFingerprint,
  loadConnection,
  markRevoked,
  saveConnection,
  type NewConnection,
} from "@/src/zotero/store";

const USER = "user_2abcDEF123";
const OTHER = "user_2zyxWVU987";
const KEY = "P9NiFoyLeZu2bZNvvuQPDWsd";
const NEW_KEY = "Q8MjGpzKfYa3cYOwwvRQEXte";
const SECRET = "a-test-secret-of-sufficient-length";
const FIELDS = ["connectedAt", "fp", "groups", "notes", "revokedAt", "sealed", "userID", "username", "v"];

const clerkError = (status: number) => Object.assign(new Error(`Clerk ${status}`), { code: "api_response_error", status });

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** Clerk's metadata deep merge (RFC 7396): objects merge, everything else replaces, null deletes. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete out[name];
    else out[name] = mergePatch(out[name], value);
  }
  return out;
}

/** The in-memory Clerk: privateMetadata per user id. */
let users: Map<string, Json>;

function connection(overrides: Partial<NewConnection> = {}): NewConnection {
  return { userID: 12345, username: "zuser", key: KEY, notes: true, groups: "all", ...overrides };
}

/** The raw stored record of a user. */
function stored(userId = USER): Json | undefined {
  return users.get(userId)?.zotero as Json | undefined;
}

/** The last patch sent to updateUserMetadata. */
function lastPatch(): { userId: string; zotero: unknown } {
  const [userId, params] = clerk.updateUserMetadata.mock.calls.at(-1)!;
  return { userId, zotero: (params as { privateMetadata: Json }).privateMetadata.zotero };
}

const savedSecret = process.env.CREDENTIALS_SECRET;

beforeEach(() => {
  process.env.CREDENTIALS_SECRET = SECRET;
  __resetZoteroStoreForTests();
  users = new Map([
    [USER, { unrelated: { keep: true } }],
    [OTHER, {}],
  ]);
  clerk.getUser.mockReset();
  clerk.updateUserMetadata.mockReset();
  clerk.getUser.mockImplementation(async (userId: string) => {
    const meta = users.get(userId);
    if (!meta) throw clerkError(404);
    return { id: userId, privateMetadata: structuredClone(meta) };
  });
  clerk.updateUserMetadata.mockImplementation(async (userId: string, params: { privateMetadata: Json }) => {
    const meta = users.get(userId);
    if (!meta) throw clerkError(404);
    users.set(userId, mergePatch(meta, params.privateMetadata) as Json);
    return { id: userId };
  });
});
afterEach(() => {
  vi.useRealTimers();
  if (savedSecret === undefined) delete process.env.CREDENTIALS_SECRET;
  else process.env.CREDENTIALS_SECRET = savedSecret;
});

describe("saveConnection / loadConnection", () => {
  it("round-trips a connection with the key sealed", async () => {
    await saveConnection(USER, connection({ groups: [30, 10, 30, 20] }));
    const state = await loadConnection(USER);
    expect(state).toEqual({
      state: "ok",
      conn: {
        creds: { userID: 12345, key: KEY },
        username: "zuser",
        notes: true,
        groups: [10, 20, 30],
        connectedAt: expect.any(String),
        fp: keyFingerprint(KEY),
      },
    });
    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{16}$/);
    // Other metadata survives the merge.
    expect(users.get(USER)?.unrelated).toEqual({ keep: true });
  });

  it("never stores the key, only the sealed blob", async () => {
    await saveConnection(USER, connection());
    const record = stored()!;
    expect(record.sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(record.sealed).not.toBe(KEY);
    expect(JSON.stringify(users.get(USER))).not.toContain(KEY);
    expect(JSON.stringify(clerk.updateUserMetadata.mock.calls)).not.toContain(KEY);
    expect(Object.values(record)).not.toContain(KEY);
  });

  it("writes every field, revokedAt explicitly null — a new key clears an old revocation", async () => {
    users.set(USER, {
      zotero: {
        v: 1,
        userID: 12345,
        username: "old",
        sealed: null,
        fp: null,
        notes: false,
        groups: [1, 2, 3],
        connectedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-02-01T00:00:00.000Z",
      },
    });
    expect((await loadConnection(USER)).state).toBe("revoked");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
    await saveConnection(USER, connection({ groups: [7], notes: true, username: "  zuser  " }));
    const patch = lastPatch();
    expect(patch.userId).toBe(USER);
    expect(Object.keys(patch.zotero as Json).sort()).toEqual(FIELDS);
    expect(patch.zotero).toMatchObject({ v: 1, userID: 12345, username: "zuser", notes: true, groups: [7], revokedAt: null, connectedAt: "2026-09-29T10:00:00.000Z" });
    expect((patch.zotero as Json).revokedAt).toBeNull();
    // The stale revocation is gone from the store (null deleted it), and the
    // array replaced the old one instead of merging into it.
    expect(stored()).not.toHaveProperty("revokedAt");
    expect(stored()!.groups).toEqual([7]);
    const state = await loadConnection(USER);
    expect(state.state).toBe("ok");
  });

  it("refuses malformed input without writing and without quoting the key", async () => {
    const bad: Array<Partial<NewConnection>> = [
      { key: "short" },
      { key: `${KEY} ` },
      { key: "identity!" },
      { userID: 0 },
      { userID: 1.5 },
      { userID: Number.NaN },
      { notes: "yes" as never },
      { groups: ["1"] as never },
      { groups: [0] },
      { groups: "some" as never },
      { username: 5 as never },
    ];
    for (const overrides of bad) {
      const error = await saveConnection(USER, connection(overrides)).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error, JSON.stringify(overrides)).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(KEY);
    }
    await expect(saveConnection("nobody", connection())).rejects.toThrow(/user id/);
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not store anything without CREDENTIALS_SECRET", async () => {
    delete process.env.CREDENTIALS_SECRET;
    await expect(saveConnection(USER, connection())).rejects.toThrow(/CREDENTIALS_SECRET/);
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("returns frozen states (they are shared across requests)", async () => {
    await saveConnection(USER, connection({ groups: [1] }));
    const state = await loadConnection(USER);
    if (state.state !== "ok") throw new Error("expected ok");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.conn)).toBe(true);
    expect(Object.isFrozen(state.conn.creds)).toBe(true);
    expect(Object.isFrozen(state.conn.groups)).toBe(true);
  });
});

describe("loadConnection — what a stored record means", () => {
  it("is none for no record, an unknown user or a malformed id", async () => {
    expect(await loadConnection(USER)).toEqual({ state: "none" });
    expect(await loadConnection("user_unknown404")).toEqual({ state: "none" });
    clerk.getUser.mockClear();
    expect(await loadConnection("nobody")).toEqual({ state: "none" });
    expect(await loadConnection("user_x/../y")).toEqual({ state: "none" });
    expect(clerk.getUser).not.toHaveBeenCalled();
  });

  it("is none for any shape that is not exactly v1", async () => {
    await saveConnection(USER, connection());
    const good = stored()!;
    const variants: unknown[] = [
      null,
      "x",
      [good],
      { ...good, v: 2 },
      { ...good, userID: "12345" },
      { ...good, userID: -1 },
      { ...good, username: 7 },
      { ...good, sealed: 5 },
      { ...good, fp: 5 },
      { ...good, notes: "true" },
      { ...good, groups: ["1"] },
      { ...good, groups: "some" },
      { ...good, connectedAt: "not a date" },
      { ...good, revokedAt: 0 },
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== "v")),
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== "notes")),
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== "connectedAt")),
      // No key and no revocation: nothing to use, nothing to report.
      { ...good, sealed: null, fp: null },
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== "sealed")),
    ];
    for (const variant of variants) {
      users.set(USER, { zotero: variant });
      __resetZoteroStoreForTests();
      expect(await loadConnection(USER), JSON.stringify(variant)).toEqual({ state: "none" });
    }
  });

  it("is unreadable after CREDENTIALS_SECRET rotated", async () => {
    await saveConnection(USER, connection());
    process.env.CREDENTIALS_SECRET = "a-rotated-secret-of-sufficient-length";
    __resetZoteroStoreForTests();
    expect(await loadConnection(USER)).toEqual({ state: "unreadable", username: "zuser" });
  });

  it("is unreadable when the blob is copied onto another account", async () => {
    await saveConnection(USER, connection());
    users.set(OTHER, { zotero: structuredClone(stored()) });
    expect(await loadConnection(OTHER)).toEqual({ state: "unreadable", username: "zuser" });
    // …while the original still opens.
    expect((await loadConnection(USER)).state).toBe("ok");
  });

  it("is unreadable when the fingerprint does not match the key", async () => {
    await saveConnection(USER, connection());
    users.set(USER, { zotero: { ...stored(), fp: keyFingerprint(NEW_KEY) } });
    expect(await loadConnection(USER)).toEqual({ state: "unreadable", username: "zuser" });
  });

  it("propagates Clerk failures without caching them", async () => {
    clerk.getUser.mockRejectedValueOnce(clerkError(503));
    await expect(loadConnection(USER)).rejects.toThrow(/Clerk 503/);
    expect(await loadConnection(USER)).toEqual({ state: "none" });
    expect(clerk.getUser).toHaveBeenCalledTimes(2);
  });
});

describe("markRevoked", () => {
  it("drops the key and records when, if the stored key is still the rejected one", async () => {
    await saveConnection(USER, connection());
    const state = await loadConnection(USER);
    if (state.state !== "ok") throw new Error("expected ok");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T08:00:00.000Z"));
    expect(await markRevoked(USER, state.conn.fp)).toBe(true);
    const patch = lastPatch().zotero as Json;
    expect(Object.keys(patch).sort()).toEqual(FIELDS);
    expect(patch).toMatchObject({ sealed: null, fp: null, revokedAt: "2026-09-30T08:00:00.000Z", username: "zuser", userID: 12345 });
    // Written as null, stored as absent.
    expect(stored()).not.toHaveProperty("sealed");
    expect(stored()).not.toHaveProperty("fp");
    expect(await loadConnection(USER)).toEqual({ state: "revoked", username: "zuser", revokedAt: "2026-09-30T08:00:00.000Z" });
  });

  it("is a no-op for a stale fingerprint (the user reconnected meanwhile)", async () => {
    await saveConnection(USER, connection());
    const old = await loadConnection(USER);
    if (old.state !== "ok") throw new Error("expected ok");
    // The callback on another instance stores a new key; this instance's
    // micro-cache still holds the old state, so markRevoked must re-read.
    users.set(USER, {
      zotero: {
        ...stored(),
        sealed: sealSecret(NEW_KEY, "zotero-api-key-v1", `zotero:${USER}`),
        fp: keyFingerprint(NEW_KEY),
      },
    });
    const writes = clerk.updateUserMetadata.mock.calls.length;
    expect(await markRevoked(USER, old.conn.fp)).toBe(false);
    expect(clerk.updateUserMetadata.mock.calls.length).toBe(writes);
    __resetZoteroStoreForTests();
    const now = await loadConnection(USER);
    expect(now.state === "ok" && now.conn.creds.key).toBe(NEW_KEY);
    // The same through this module's own save.
    await saveConnection(USER, connection({ key: KEY }));
    expect(await markRevoked(USER, keyFingerprint(NEW_KEY))).toBe(false);
    expect((await loadConnection(USER)).state).toBe("ok");
  });

  it("is a no-op without a connection or once already revoked", async () => {
    expect(await markRevoked(USER, keyFingerprint(KEY))).toBe(false);
    await saveConnection(USER, connection());
    expect(await markRevoked(USER, keyFingerprint(KEY))).toBe(true);
    const writes = clerk.updateUserMetadata.mock.calls.length;
    expect(await markRevoked(USER, keyFingerprint(KEY))).toBe(false);
    expect(clerk.updateUserMetadata.mock.calls.length).toBe(writes);
    await expect(markRevoked("nobody", "0123456789abcdef")).rejects.toThrow(/user id/);
  });
});

describe("deleteConnection", () => {
  it("writes zotero: null and leaves the rest of the metadata alone", async () => {
    await saveConnection(USER, connection());
    await deleteConnection(USER);
    expect(lastPatch()).toEqual({ userId: USER, zotero: null });
    expect(users.get(USER)).toEqual({ unrelated: { keep: true } });
    expect(await loadConnection(USER)).toEqual({ state: "none" });
    await expect(deleteConnection("org_notauser")).rejects.toThrow(/user id/);
  });
});

describe("micro-cache", () => {
  it("shares one Clerk read between parallel loads and reuses it briefly", async () => {
    vi.useFakeTimers();
    await saveConnection(USER, connection());
    clerk.getUser.mockClear();
    const [one, two] = await Promise.all([loadConnection(USER), loadConnection(USER)]);
    expect(clerk.getUser).toHaveBeenCalledTimes(1);
    expect(one).toBe(two);
    await loadConnection(USER);
    expect(clerk.getUser).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CACHE_TTL_MS.connection + 1);
    await loadConnection(USER);
    expect(clerk.getUser).toHaveBeenCalledTimes(2);
  });

  it("keeps users apart", async () => {
    await saveConnection(USER, connection());
    expect((await loadConnection(USER)).state).toBe("ok");
    expect((await loadConnection(OTHER)).state).toBe("none");
  });

  it("is cleared by every write", async () => {
    await saveConnection(USER, connection());
    expect((await loadConnection(USER)).state).toBe("ok");
    await deleteConnection(USER);
    expect((await loadConnection(USER)).state).toBe("none");
    await saveConnection(USER, connection());
    const state = await loadConnection(USER);
    expect(state.state).toBe("ok");
    if (state.state !== "ok") return;
    await markRevoked(USER, state.conn.fp);
    expect((await loadConnection(USER)).state).toBe("revoked");
  });

  it("does not cache or share a read that a write overtook", async () => {
    await saveConnection(USER, connection());
    // Hold the next Clerk read until the write has happened.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const snapshot = structuredClone(users.get(USER)!);
    clerk.getUser.mockImplementationOnce(async (userId: string) => {
      await gate;
      return { id: userId, privateMetadata: snapshot };
    });
    const early = loadConnection(USER);
    await deleteConnection(USER);
    // A load after the write does not join the stale read.
    const late = loadConnection(USER);
    release();
    expect((await early).state).toBe("ok");
    expect((await late).state).toBe("none");
    // …and the stale result did not land in the cache.
    expect((await loadConnection(USER)).state).toBe("none");
  });
});
