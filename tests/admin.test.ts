import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin page's rules: the model (roles, switches, dates), who is an
 * admin, which changes are refused, and the UKAŽ gate. Clerk is mocked.
 */

const clerk = vi.hoisted(() => ({
  userId: null as string | null,
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  getUserList: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId }),
  clerkClient: async () => ({ users: { getUser: clerk.getUser, updateUserMetadata: clerk.updateUserMetadata, getUserList: clerk.getUserList } }),
}));

import { dayBefore, formatDay, metadataPatch, roleFrom, toAdminUser } from "@/src/admin/model";
import { applyChange, isEnvAdmin, listAdminUsers, requireAdmin } from "@/src/admin/server";
import { __setAccessLoaderForTests, buildAccess, emptyAccess, ukazOn } from "@/src/files/access";
import { doctrineRefusal } from "@/src/mcp/doctrine-gate";
import { changeUserAction } from "@/app/sprava/actions";

const ME = "user_admin1";
const OTHER = "user_other2";
const ctxOf = (userId: string) => ({ http: { authInfo: { clientId: "client", scopes: [], extra: { userId } } } });

beforeEach(() => {
  clerk.userId = null;
  clerk.getUser.mockReset();
  clerk.updateUserMetadata.mockReset();
  clerk.getUserList.mockReset();
  delete process.env.ADMIN_USER_IDS;
  delete process.env.FILES_OPERATOR_IDS;
});
afterEach(() => __setAccessLoaderForTests(null));

describe("model", () => {
  it("reads the role strictly", () => {
    expect(roleFrom({ role: "admin" })).toBe("admin");
    for (const v of [{ role: "Admin" }, { role: true }, { role: ["admin"] }, {}, null, undefined, "admin"]) expect(roleFrom(v)).toBe("user");
  });

  it("builds the account view: switches as the access code reads them", () => {
    const u = toAdminUser(
      {
        id: OTHER,
        firstName: "Petra",
        lastName: "Horáková",
        primaryEmailAddressId: "e2",
        emailAddresses: [
          { id: "e1", emailAddress: "old@x.cz" },
          { id: "e2", emailAddress: "petra@x.cz" },
        ],
        publicMetadata: { pro: true, features: { zotero: false, ukaz: true } },
        createdAt: 1,
      },
      false,
    );
    expect(u).toMatchObject({ name: "Petra Horáková", email: "petra@x.cz", role: "user", pro: true, banned: false });
    expect(u.features).toEqual({ files: true, zotero: false, ukaz: true, mirror: false });
    // Not Pro "true" strictly; UKAŽ only on a strict true.
    expect(toAdminUser({ id: OTHER, publicMetadata: { pro: "true", features: { ukaz: "yes" } } }, false)).toMatchObject({ pro: false, features: { ukaz: false } });
    expect(toAdminUser({ id: OTHER, locked: true }, false).banned).toBe(true);
    expect(toAdminUser({ id: OTHER }, true)).toMatchObject({ role: "admin", envAdmin: true });
    expect(toAdminUser({ id: OTHER }, false).name).toBe(OTHER);
  });

  it("turns a change into metadata and keeps the other feature switches", () => {
    expect(metadataPatch({}, { kind: "role", admin: true })).toEqual({ role: "admin" });
    expect(metadataPatch({}, { kind: "role", admin: false })).toEqual({ role: "user" });
    expect(metadataPatch({}, { kind: "pro", on: true })).toEqual({ pro: true });
    expect(metadataPatch({ features: { files: false } }, { kind: "feature", feature: "ukaz", on: true })).toEqual({ features: { files: false, ukaz: true } });
    expect(metadataPatch({ features: "junk" }, { kind: "feature", feature: "zotero", on: false })).toEqual({ features: { zotero: false } });
  });

  it("writes dates as 12. března 2026", () => {
    expect(formatDay("2026-03-12")).toBe("12. března 2026");
    expect(formatDay(Date.UTC(2026, 10, 11, 12))).toBe("11. listopadu 2026");
    expect(formatDay(null)).toBe("nikdy");
    expect(formatDay("garbage")).toBe("nikdy");
    expect(dayBefore("2026-03-01", 1)).toBe("2026-02-28");
  });
});

describe("who is an admin", () => {
  it("takes the ids in ADMIN_USER_IDS and FILES_OPERATOR_IDS", () => {
    process.env.ADMIN_USER_IDS = ` ${ME}, nonsense `;
    process.env.FILES_OPERATOR_IDS = OTHER;
    expect(isEnvAdmin(ME)).toBe(true);
    expect(isEnvAdmin(OTHER)).toBe(true);
    expect(isEnvAdmin("user_nobody")).toBe(false);
    expect(isEnvAdmin(null)).toBe(false);
  });

  it("admits an env id without a Clerk call, a Clerk admin by role, nobody else", async () => {
    process.env.ADMIN_USER_IDS = ME;
    clerk.userId = ME;
    expect(await requireAdmin()).toBe(ME);
    expect(clerk.getUser).not.toHaveBeenCalled();

    clerk.userId = OTHER;
    clerk.getUser.mockResolvedValue({ id: OTHER, publicMetadata: { role: "admin" } });
    expect(await requireAdmin()).toBe(OTHER);
    clerk.getUser.mockResolvedValue({ id: OTHER, publicMetadata: { role: "admin" }, banned: true });
    expect(await requireAdmin()).toBeNull();
    clerk.getUser.mockResolvedValue({ id: OTHER, publicMetadata: { pro: true } });
    expect(await requireAdmin()).toBeNull();
    clerk.getUser.mockRejectedValue(new Error("down"));
    expect(await requireAdmin()).toBeNull();
    clerk.userId = null;
    expect(await requireAdmin()).toBeNull();
  });

  it("lists every page of accounts", async () => {
    clerk.getUserList
      .mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, i) => ({ id: `user_a${i}` })), totalCount: 501 })
      .mockResolvedValueOnce({ data: [{ id: "user_last" }], totalCount: 501 });
    const users = await listAdminUsers();
    expect(users).toHaveLength(501);
    expect(clerk.getUserList).toHaveBeenCalledTimes(2);
  });
});

describe("changes", () => {
  it("refuses to take your own admin role, or an env admin's, and a malformed id", async () => {
    process.env.ADMIN_USER_IDS = OTHER;
    expect((await applyChange(ME, ME, { kind: "role", admin: false })).ok).toBe(false);
    expect((await applyChange(ME, OTHER, { kind: "role", admin: false })).ok).toBe(false);
    expect((await applyChange(ME, "nope", { kind: "pro", on: true })).ok).toBe(false);
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("sends the merged metadata to Clerk and returns the account as Clerk answered", async () => {
    clerk.getUser.mockResolvedValue({ id: OTHER, publicMetadata: { pro: true, features: { files: false } } });
    clerk.updateUserMetadata.mockResolvedValue({ id: OTHER, publicMetadata: { pro: true, features: { files: false, ukaz: true } } });
    const result = await applyChange(ME, OTHER, { kind: "feature", feature: "ukaz", on: true });
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith(OTHER, { publicMetadata: { features: { files: false, ukaz: true } } });
    expect(result.ok && result.user.features).toEqual({ files: false, zotero: true, ukaz: true, mirror: false });
  });

  it("answers a Clerk failure with a message, not a throw", async () => {
    clerk.getUser.mockRejectedValue(new Error("down"));
    const result = await applyChange(ME, OTHER, { kind: "pro", on: true });
    expect(result.ok).toBe(false);
  });

  it("the Server Function refuses non-admins and malformed changes before any Clerk write", async () => {
    clerk.userId = OTHER;
    clerk.getUser.mockResolvedValue({ id: OTHER, publicMetadata: {} });
    expect((await changeUserAction(OTHER, { kind: "pro", on: true })).ok).toBe(false);

    process.env.ADMIN_USER_IDS = ME;
    clerk.userId = ME;
    for (const bad of [null, { kind: "pro", on: "yes" }, { kind: "feature", feature: "__proto__", on: true }, { kind: "x" }]) {
      expect((await changeUserAction(OTHER, bad as never)).ok).toBe(false);
    }
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("UKAŽ switch and gate", () => {
  it("is off until strictly true, and off for banned accounts", () => {
    expect(ukazOn({ features: { ukaz: true } })).toBe(true);
    for (const v of [{}, null, { features: { ukaz: "true" } }, { features: { ukaz: 1 } }, { features: [] }]) expect(ukazOn(v)).toBe(false);
    expect(buildAccess({ id: OTHER, publicMetadata: { pro: true } }).ukaz).toBe(false);
    expect(buildAccess({ id: OTHER, publicMetadata: { features: { ukaz: true } } }).ukaz).toBe(true); // Pro or not
    expect(buildAccess({ id: OTHER, banned: true, publicMetadata: { features: { ukaz: true } } }).ukaz).toBe(false);
    expect(emptyAccess(OTHER).ukaz).toBe(false);
  });

  it("lets the shared code and a call without identity through, holds back an unconfirmed account", async () => {
    expect(await doctrineRefusal({ http: { authInfo: { clientId: "shared-token", scopes: [], extra: {} } } })).toBeNull();
    expect(await doctrineRefusal(undefined)).toBeNull();

    __setAccessLoaderForTests(async (id) => buildAccess({ id, publicMetadata: {} }));
    const refused = await doctrineRefusal(ctxOf(OTHER));
    expect(refused?.isError).toBe(true);
    expect(refused?.structuredContent.error.kind).toBe("NOT_ENTITLED");

    __setAccessLoaderForTests(async (id) => buildAccess({ id, publicMetadata: { features: { ukaz: true } } }));
    expect(await doctrineRefusal(ctxOf("user_confirmed3"))).toBeNull();
  });

  it("fails closed, with its own text, when Clerk cannot be asked", async () => {
    __setAccessLoaderForTests(async () => {
      throw new Error("clerk down");
    });
    const refused = await doctrineRefusal(ctxOf("user_unlucky4"));
    expect(refused?.isError).toBe(true);
    expect(refused?.structuredContent.error.kind).toBe("UPSTREAM_UNREACHABLE");
  });
});
