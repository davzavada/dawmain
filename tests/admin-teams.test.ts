import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Správa → Týmy: the Server Functions (admin only, input validated) and
 * the team tables behind them (src/admin/teams-server.ts,
 * src/files/db/teams.ts) — and what a team means for its members' access.
 * Clerk is mocked; the database is PGlite with the real migrations.
 */

const clerk = vi.hoisted(() => ({ userId: null as string | null, getUser: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId }),
  clerkClient: async () => ({ users: { getUser: clerk.getUser } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { changeTeamAction, createTeamAction, deleteTeamAction, renameTeamAction, setTeamMemberAction } from "@/app/sprava/tymy/actions";
import type { AdminTeam } from "@/src/admin/teams";
import { listAdminTeams } from "@/src/admin/teams-server";
import { __setAccessLoaderForTests, getAccess, libraryOwnerState } from "@/src/files/access";
import { setScopeRunner } from "@/src/files/db/client";
import { ensureLibrary } from "@/src/files/db/libraries";
import { forgetMemberships } from "@/src/files/db/teams";
import { createTestDb, type TestDb } from "./helpers/pglite";

const ADMIN = "user_admin1";
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setScopeRunner(null);
  await t.close();
});
beforeEach(() => {
  clerk.getUser.mockReset();
  clerk.getUser.mockImplementation(async (id: string) => ({ id, publicMetadata: {} }));
  clerk.userId = ADMIN;
  process.env.ADMIN_USER_IDS = ADMIN;
  process.env.FILES_DATABASE_URL = "postgres://test";
  setScopeRunner(t.runner);
  __setAccessLoaderForTests(null);
});
afterEach(async () => {
  delete process.env.FILES_DATABASE_URL;
  for (const table of ["team_members", "teams", "audit_log", "libraries"]) await t.owner.query(`DELETE FROM ${table}`);
});

async function made(name = "Kancelář", admin = "user_a"): Promise<AdminTeam> {
  const result = await createTeamAction(name, admin);
  if (!result.ok || !result.team) throw new Error("team not created");
  return result.team;
}

describe("Týmy: Server Functions", () => {
  it("anyone but an admin is refused before anything is written", async () => {
    clerk.userId = "user_nobody";
    for (const result of [
      await createTeamAction("Kancelář", "user_a"),
      await changeTeamAction("org_t", { kind: "pro", on: true }),
      await setTeamMemberAction("org_t", "user_a", "member"),
      await deleteTeamAction("org_t"),
    ]) {
      expect(result).toEqual({ ok: false, error: "Nemáš oprávnění správce." });
    }
    expect((await t.owner.query("SELECT 1 FROM teams")).rows).toHaveLength(0);
  });

  it("creates a team with its first admin — off, and the website's admin is not a member", async () => {
    expect((await createTeamAction(" ", "user_a")).ok).toBe(false);
    expect((await createTeamAction("Kancelář", "org_x")).ok).toBe(false);
    const team = await made("  Kancelář ");
    expect(team).toMatchObject({ name: "Kancelář", pro: false, quotaPages: null, members: [{ userId: "user_a", role: "admin" }] });
    expect(team.id).toMatch(/^org_[A-Za-z0-9]{24}$/);
    expect(await listAdminTeams()).toEqual({ state: "ok", teams: [team] });
  });

  it("switches, quota and name; a change is rebuilt from checked fields only", async () => {
    const { id } = await made();
    await changeTeamAction(id, { kind: "pro", on: true });
    await changeTeamAction(id, { kind: "feature", feature: "ukaz", on: true, extra: "x" } as never);
    await changeTeamAction(id, { kind: "feature", feature: "zotero", on: false });
    await changeTeamAction(id, { kind: "quota", pages: 50_000 });
    const renamed = await renameTeamAction(id, "AK Novák");
    expect(renamed).toMatchObject({ ok: true, team: { name: "AK Novák", pro: true, features: { files: true, zotero: false, ukaz: true }, quotaPages: 50_000 } });
    expect((await changeTeamAction(id, { kind: "quota", pages: null })).ok && true).toBe(true);
    expect((await changeTeamAction(id, { kind: "role", admin: true } as never)).ok).toBe(false);
    expect((await changeTeamAction("user_a", { kind: "pro", on: true })).ok).toBe(false);
    expect(await changeTeamAction("org_missing", { kind: "pro", on: true })).toEqual({ ok: false, error: "Tým už neexistuje." });
  });

  it("members: add, change the role, remove — but the last admin stays; there is no cap on their number", async () => {
    const { id } = await made();
    for (let i = 0; i < 30; i++) await setTeamMemberAction(id, `user_m${i}`, "member");
    const promoted = await setTeamMemberAction(id, "user_m0", "admin");
    expect(promoted.ok && promoted.team?.members).toHaveLength(31);
    expect(promoted.ok && promoted.team?.members.slice(0, 2).map((m) => m.role)).toEqual(["admin", "admin"]);
    const removed = await setTeamMemberAction(id, "user_m0", null);
    expect(removed.ok && removed.team?.members).toHaveLength(30);
    for (const role of ["member", null] as const) {
      expect(await setTeamMemberAction(id, "user_a", role)).toMatchObject({ ok: false, error: expect.stringContaining("aspoň jednoho správce") });
    }
  });

  it("what a team gives its members: the shared library and its features, with no Pro of their own", async () => {
    const { id } = await made();
    await setTeamMemberAction(id, "user_b", "member");
    expect((await getAccess("user_b")).all.map((l) => [l.id, l.pro])).toEqual([["user_b", false], [id, false]]);
    await changeTeamAction(id, { kind: "pro", on: true });
    await changeTeamAction(id, { kind: "quota", pages: 777 });
    __setAccessLoaderForTests(null); // drop the cached access
    const member = await getAccess("user_b");
    expect(member.libraries).toEqual([{ id, kind: "org", name: "Kancelář", slug: null, role: "member", pro: true, canUpload: true, canManageAll: false, quotaPages: 777 }]);
    expect(member).toMatchObject({ zotero: true, ukaz: false });
    expect((await getAccess("user_a")).libraries[0]).toMatchObject({ id, role: "admin", canManageAll: true });
    expect((await getAccess("user_stranger")).all.map((l) => l.id)).toEqual(["user_stranger"]);
    expect(await libraryOwnerState(id)).toBe("pro");
  });

  it("deleting a team removes it and its memberships and marks its library for purge", async () => {
    const { id } = await made();
    await t.runner([id], (db) => ensureLibrary(db, id, "Kancelář"));
    expect(await deleteTeamAction(id)).toEqual({ ok: true, team: null });
    expect((await t.owner.query("SELECT 1 FROM team_members")).rows).toHaveLength(0);
    const { rows } = await t.owner.query<{ due: boolean }>("SELECT purge_after > now() + interval '5 days' AS due FROM libraries WHERE id = $1", [id]);
    expect(rows[0].due).toBe(true);
    expect(await libraryOwnerState(id)).toBe("gone");
    expect(await deleteTeamAction(id)).toEqual({ ok: false, error: "Tým už neexistuje." });
  });

  it("a deleted account leaves every team", async () => {
    const a = await made("Tým A");
    const b = await made("Tým B", "user_x");
    await setTeamMemberAction(b.id, "user_a", "member");
    expect((await t.runner([], (db) => forgetMemberships(db, "user_a"))).sort()).toEqual([a.id, b.id].sort());
    expect((await t.owner.query("SELECT user_id FROM team_members")).rows).toEqual([{ user_id: "user_x" }]);
  });

  it("without the files database the page says so", async () => {
    delete process.env.FILES_DATABASE_URL;
    expect(await listAdminTeams()).toEqual({ state: "unconfigured" });
    expect((await createTeamAction("Kancelář", "user_a")).ok).toBe(false);
  });
});
