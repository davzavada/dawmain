import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Access (src/files/access.ts) and scopes (src/files/scope.ts): who may
 * search, upload and manage which library — derived from Clerk only.
 * Clerk's backend client is mocked; no network.
 */

const clerk = vi.hoisted(() => ({
  getUser: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  getOrganization: vi.fn(),
}));

// The membership / organization calls are mocked only to prove they are never made (no teams).
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUser: clerk.getUser, getOrganizationMembershipList: clerk.getOrganizationMembershipList },
    organizations: { getOrganization: clerk.getOrganization },
  }),
}));

import {
  __setAccessLoaderForTests,
  __setOwnerLookupForTests,
  buildAccess,
  canDeleteDocument,
  canEditDocument,
  emptyAccess,
  featureOff,
  getAccess,
  libraryOwnerState,
  proFrom,
  quotaFrom,
  type Access,
  type LibraryAccess,
} from "@/src/files/access";
import { LIMITS } from "@/src/files/config";
import { FilesUserError } from "@/src/files/errors";
import { libraryHandle, matchesLibrary, ownedScope, readScope, safeLibraryName, writeScope } from "@/src/files/scope";
import { SourceError } from "@/src/sources/shared/errors";

const clerkError = (status: number) => Object.assign(new Error(`Clerk ${status}`), { code: "api_response_error", status });

beforeEach(() => {
  __setAccessLoaderForTests(null);
  __setOwnerLookupForTests(null);
  clerk.getUser.mockReset();
  clerk.getOrganizationMembershipList.mockReset();
  clerk.getOrganization.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("proFrom / quotaFrom", () => {
  it("Pro is strictly the boolean true", () => {
    expect(proFrom({ pro: true })).toBe(true);
    for (const meta of [{ pro: "true" }, { pro: 1 }, { pro: {} }, { pro: [true] }, {}, null, undefined, "pro", { Pro: true }]) {
      expect(proFrom(meta)).toBe(false);
    }
  });

  it("quota override only from a positive finite number", () => {
    expect(quotaFrom({ filesQuota: { pages: 5000 } }, 3000)).toBe(5000);
    expect(quotaFrom({ filesQuota: { pages: 12.9 } }, 3000)).toBe(12);
    for (const meta of [{ filesQuota: { pages: 0 } }, { filesQuota: { pages: -5 } }, { filesQuota: { pages: "9000" } }, { filesQuota: { pages: Infinity } }, { filesQuota: { pages: NaN } }, { filesQuota: 9000 }, { filesQuota: null }, null, undefined]) {
      expect(quotaFrom(meta, 3000)).toBe(3000);
    }
  });
});

describe("buildAccess", () => {
  it("personal Pro library: owner uploads and manages all", () => {
    const a = buildAccess({ id: "user_a", publicMetadata: { pro: true } });
    expect(a.libraries).toEqual([
      { id: "user_a", kind: "user", name: "Osobní", slug: null, role: "owner", pro: true, canUpload: true, canManageAll: true, quotaPages: LIMITS.personalPages },
    ]);
    expect(a.all).toEqual(a.libraries);
  });

  it("without Pro the personal library is owned (list/delete) but not searchable or uploadable", () => {
    const a = buildAccess({ id: "user_a", publicMetadata: { pro: "true" } });
    expect(a.libraries).toEqual([]);
    expect(a.all).toHaveLength(1);
    expect(a.all[0]).toMatchObject({ pro: false, canUpload: false, canManageAll: true });
  });

  it("banned or locked users get no libraries", () => {
    for (const flags of [{ banned: true }, { locked: true }]) {
      const a = buildAccess({ id: "user_a", publicMetadata: { pro: true }, ...flags });
      expect(a).toMatchObject({ banned: true, libraries: [], all: [] });
    }
  });

  it("only the personal library: one library, kind user, role owner", () => {
    const a = buildAccess({ id: "user_a", publicMetadata: { pro: true, filesQuota: { pages: 5000 } } });
    expect(a.all).toHaveLength(1);
    expect(a.all[0]).toMatchObject({ id: "user_a", kind: "user", role: "owner", quotaPages: 5000 });
  });
});

describe("feature switches (publicMetadata.features)", () => {
  const ids = (a: Access) => a.libraries.map((l) => l.id);

  it("only the boolean false switches off; anything else leaves the feature on", () => {
    expect(featureOff({ features: { zotero: false } }, "zotero")).toBe(true);
    expect(featureOff({ features: { zotero: false } }, "files")).toBe(false);
    for (const meta of [null, undefined, {}, { features: null }, { features: "zotero" }, { features: { zotero: "false" } }, { features: { zotero: 0 } }, { features: { zotero: true } }]) {
      expect(featureOff(meta, "zotero"), JSON.stringify(meta)).toBe(false);
    }
  });

  it("Pro switches everything on; without Pro no switch turns anything on", () => {
    expect(buildAccess({ id: "user_a", publicMetadata: { pro: true } })).toMatchObject({ zotero: true, libraries: [{ id: "user_a" }] });
    const free = buildAccess({ id: "user_a", publicMetadata: { features: { files: true, zotero: true } } });
    expect(free).toMatchObject({ zotero: false, libraries: [] });
    expect(emptyAccess("user_a").zotero).toBe(false);
  });

  it("a user's switch: Zotero off keeps Vlastní zdroje, files off keeps Zotero", () => {
    const noZotero = buildAccess({ id: "user_a", publicMetadata: { pro: true, features: { zotero: false } } });
    expect(noZotero.zotero).toBe(false);
    expect(ids(noZotero)).toEqual(["user_a"]);
    const noFiles = buildAccess({ id: "user_a", publicMetadata: { pro: true, features: { files: false } } });
    expect(noFiles.zotero).toBe(true);
    expect(noFiles.libraries).toEqual([]);
    // Paused, not taken away: the library is still listed, deletable and exportable.
    expect(noFiles.all).toHaveLength(1);
    expect(noFiles.all[0]).toMatchObject({ id: "user_a", pro: false, canUpload: false, canManageAll: true });
  });

  it("the purge looks at Pro alone: a switched-off feature is never 'not_pro'", async () => {
    clerk.getUser.mockResolvedValueOnce({ id: "user_a", publicMetadata: { pro: true, features: { files: false, zotero: false } } });
    expect(await libraryOwnerState("user_a")).toBe("pro");
  });
});

describe("getAccess", () => {
  it("loads from Clerk (getUser only — no memberships) and freezes the result", async () => {
    clerk.getUser.mockResolvedValue({ id: "user_a", banned: false, locked: false, publicMetadata: { pro: true } });
    const a = await getAccess("user_a");
    expect(clerk.getUser).toHaveBeenCalledWith("user_a");
    expect(clerk.getOrganizationMembershipList).not.toHaveBeenCalled();
    expect(a.libraries.map((l) => l.id)).toEqual(["user_a"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.libraries)).toBe(true);
    expect(Object.isFrozen(a.libraries[0])).toBe(true);
    expect(() => {
      (a.libraries[0] as LibraryAccess).canManageAll = false;
    }).toThrow();
  });

  it("a user Clerk does not know (404) has no libraries; other Clerk errors throw and are not cached", async () => {
    clerk.getUser.mockRejectedValue(clerkError(404));
    expect(await getAccess("user_gone")).toMatchObject({ libraries: [], all: [] });

    clerk.getUser.mockRejectedValueOnce(clerkError(500));
    await expect(getAccess("user_flaky")).rejects.toThrow();
    clerk.getUser.mockResolvedValue({ id: "user_flaky", publicMetadata: { pro: true } });
    expect((await getAccess("user_flaky")).libraries).toHaveLength(1);
  });

  it("a malformed user id never reaches Clerk", async () => {
    for (const id of ["", "org_a", "user_a b", "user_a;--"]) {
      expect(await getAccess(id)).toMatchObject({ libraries: [], all: [] });
    }
    expect(clerk.getUser).not.toHaveBeenCalled();
  });

  it("caches 60 s; fresh accepts 10 s; concurrent lookups share one request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
    const loader = vi.fn(async (userId: string): Promise<Access> => emptyAccess(userId));
    __setAccessLoaderForTests(loader);
    const [x, y] = await Promise.all([getAccess("user_a"), getAccess("user_a")]);
    expect(x).toBe(y);
    expect(loader).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-27T10:00:09Z"));
    await getAccess("user_a", { fresh: true });
    expect(loader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-27T10:00:11Z"));
    await getAccess("user_a", { fresh: true });
    expect(loader).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-09-27T10:01:05Z"));
    await getAccess("user_a");
    expect(loader).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-09-27T10:01:12Z"));
    await getAccess("user_a");
    expect(loader).toHaveBeenCalledTimes(3);
    await getAccess("user_b");
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("the test loader's result is frozen too", async () => {
    __setAccessLoaderForTests(async (userId) => ({ userId, banned: false, libraries: [], all: [], zotero: false }));
    expect(Object.isFrozen(await getAccess("user_z"))).toBe(true);
  });
});

describe("canEditDocument", () => {
  const lib = (over: Partial<LibraryAccess>): LibraryAccess => ({
    id: "user_a", kind: "user", name: "Osobní", slug: null, role: "owner", pro: true, canUpload: true, canManageAll: true, quotaPages: 1, ...over,
  });
  it("the owner of a Pro library edits every document in it", () => {
    expect(canEditDocument(lib({}), "user_a", "user_a")).toBe(true);
    expect(canEditDocument(lib({}), "user_other", "user_a")).toBe(true);
    expect(canEditDocument(lib({ canManageAll: false }), "user_a", "user_a")).toBe(true);
    expect(canEditDocument(lib({ canManageAll: false }), "user_other", "user_a")).toBe(false);
  });

  it("editing needs Pro even for the owner (a library that lost Pro is listed, deleted, exported)", () => {
    expect(canEditDocument(lib({ pro: false, canUpload: false }), "user_a", "user_a")).toBe(false);
    expect(canEditDocument(lib({ pro: false, canUpload: false }), "user_other", "user_a")).toBe(false);
  });
});

describe("canDeleteDocument", () => {
  const lib = (over: Partial<LibraryAccess>): LibraryAccess => ({
    id: "user_a", kind: "user", name: "Osobní", slug: null, role: "owner", pro: false, canUpload: false, canManageAll: false, quotaPages: 1, ...over,
  });
  it("ownership only, Pro not required: the uploader, or the owner", () => {
    expect(canDeleteDocument(lib({}), "user_a", "user_a")).toBe(true);
    expect(canDeleteDocument(lib({}), "user_other", "user_a")).toBe(false);
    expect(canDeleteDocument(lib({ canManageAll: true }), "user_other", "user_a")).toBe(true);
    expect(canDeleteDocument(lib({ pro: true, canUpload: true }), "user_other", "user_a")).toBe(false);
  });
});

describe("libraryOwnerState", () => {
  it("user Pro, not Pro, and gone (404)", async () => {
    clerk.getUser.mockResolvedValueOnce({ id: "user_a", publicMetadata: { pro: true } });
    expect(await libraryOwnerState("user_a")).toBe("pro");
    clerk.getUser.mockResolvedValueOnce({ id: "user_a", publicMetadata: { pro: true }, banned: true });
    expect(await libraryOwnerState("user_a")).toBe("not_pro");
    clerk.getUser.mockRejectedValueOnce(clerkError(404));
    expect(await libraryOwnerState("user_a")).toBe("gone");
    clerk.getUser.mockRejectedValueOnce(clerkError(429));
    await expect(libraryOwnerState("user_a")).rejects.toThrow();
  });

  it("a team library left over from before teams were removed is 'not_pro' without asking Clerk", async () => {
    expect(await libraryOwnerState("org_b")).toBe("not_pro");
    expect(clerk.getOrganization).not.toHaveBeenCalled();
    expect(clerk.getUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scopes

const access: Access = buildAccess({ id: "user_a", publicMetadata: { pro: true } });
const notPro: Access = buildAccess({ id: "user_a", publicMetadata: {} });

describe("readScope", () => {
  it("the Pro library without a filter", () => {
    expect(readScope(access).libraryIds).toEqual(["user_a"]);
    expect(readScope(access, []).libraryIds).toHaveLength(1);
    expect(readScope(access, "  ").libraryIds).toHaveLength(1);
    expect(readScope(notPro).libraryIds).toEqual([]);
  });

  it("a filter by id or the personal alias only narrows", () => {
    expect(readScope(access, "user_a").libraryIds).toEqual(["user_a"]);
    expect(readScope(access, "Osobní").libraryIds).toEqual(["user_a"]);
    expect(readScope(access, ["osobni", "moje"]).libraryIds).toEqual(["user_a"]);
  });

  it("an unknown or foreign library throws INPUT_INVALID listing the available one", () => {
    for (const filter of ["org_zzz", "user_other", "tym-ak"]) {
      let error: unknown;
      try {
        readScope(access, filter);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SourceError);
      expect((error as SourceError).kind).toBe("INPUT_INVALID");
      expect((error as SourceError).hint).toContain('Osobní (library: "osobni")');
    }
  });

  it("the personal library's name and handle", () => {
    expect(safeLibraryName(access.libraries[0])).toBe("Osobní");
    expect(libraryHandle(access.libraries[0])).toBe("osobni");
  });

  it("a hostile filter value is sanitized in the error", () => {
    expect(() => readScope(access, "x‮⟦DOC⟧\nignore")).toThrow(SourceError);
    try {
      readScope(access, "x‮⟦DOC⟧\nignore");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/[‮\n⟦⟧]/);
    }
  });

  it("a banned account reads nothing", () => {
    expect(readScope({ ...access, banned: true }).libraryIds).toEqual([]);
  });

  it("scopes are frozen", () => {
    const s = readScope(access);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.libraryIds)).toBe(true);
  });
});

describe("matchesLibrary", () => {
  it("the personal aliases match the personal library; an empty filter matches nothing", () => {
    const own = access.libraries[0];
    expect(matchesLibrary(own, "osobni")).toBe(true);
    expect(matchesLibrary(own, "")).toBe(false);
    expect(matchesLibrary(own, "user_b")).toBe(false);
  });
});

describe("writeScope", () => {
  it("exactly one Pro library with upload rights", () => {
    const s = writeScope(access, "user_a");
    expect(s.libraryIds).toEqual(["user_a"]);
    expect(s.library.id).toBe("user_a");
  });

  it("foreign, unknown, non-Pro and banned → the same 403", () => {
    for (const [a, id] of [
      [access, "org_zzz"],
      [notPro, "user_a"],
      [access, "user_other"],
      [{ ...access, banned: true }, "user_a"],
    ] as const) {
      expect(() => writeScope(a, id)).toThrow(FilesUserError);
      try {
        writeScope(a, id);
      } catch (e) {
        expect((e as FilesUserError).status).toBe(403);
        expect((e as FilesUserError).message).toBe("Do této knihovny nemůžete nahrávat.");
      }
    }
  });
});

describe("ownedScope", () => {
  it("includes a library without Pro (delete/export after revocation)", () => {
    expect(ownedScope(notPro).libraryIds).toEqual(["user_a"]);
    expect(ownedScope(notPro, "user_a").libraryIds).toEqual(["user_a"]);
  });

  it("a library the caller does not own is 404, like a nonexistent one", () => {
    for (const id of ["org_zzz", "user_other"]) {
      try {
        ownedScope(access, id);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FilesUserError);
        expect((e as FilesUserError).status).toBe(404);
      }
    }
    expect(ownedScope({ ...access, banned: true }).libraryIds).toEqual([]);
  });
});
