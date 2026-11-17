import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Správa → Týmy: the Server Functions (admin only, input validated) and the
 * Clerk calls behind them (src/admin/teams-server.ts). Clerk is mocked.
 */

const clerk = vi.hoisted(() => ({
  userId: null as string | null,
  getUser: vi.fn(),
  getOrganization: vi.fn(),
  getOrganizationList: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  updateOrganizationMetadata: vi.fn(),
  deleteOrganization: vi.fn(),
  createOrganizationMembership: vi.fn(),
  updateOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerk.userId }),
  clerkClient: async () => ({ users: { getUser: clerk.getUser }, organizations: clerk }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { changeTeamAction, createTeamAction, deleteTeamAction, setTeamMemberAction } from "@/app/sprava/tymy/actions";
import { listAdminTeams } from "@/src/admin/teams-server";

const ADMIN = "user_admin1";
const clerkError = (status: number) => Object.assign(new Error(`Clerk ${status}`), { code: "api_response_error", status });
const member = (userId: string, role: string) => ({ role, publicUserData: { userId, identifier: `${userId}@x.cz`, firstName: null, lastName: null } });

beforeEach(() => {
  for (const fn of Object.values(clerk)) if (typeof fn === "function") fn.mockReset();
  clerk.userId = ADMIN;
  process.env.ADMIN_USER_IDS = ADMIN;
  clerk.getOrganization.mockResolvedValue({ id: "org_t", name: "Kancelář", publicMetadata: { pro: true } });
  clerk.getOrganizationMembershipList.mockResolvedValue({ data: [member("user_a", "org:admin"), member("user_b", "org:member")] });
});

describe("Týmy: Server Functions", () => {
  it("anyone but an admin is refused before Clerk is asked for anything", async () => {
    clerk.userId = "user_nobody";
    clerk.getUser.mockResolvedValue({ id: "user_nobody", publicMetadata: {} });
    for (const result of [
      await createTeamAction("Kancelář", "user_a"),
      await changeTeamAction("org_t", { kind: "pro", on: true }),
      await setTeamMemberAction("org_t", "user_a", "member"),
      await deleteTeamAction("org_t"),
    ]) {
      expect(result).toEqual({ ok: false, error: "Nemáš oprávnění správce." });
    }
    expect(clerk.createOrganization).not.toHaveBeenCalled();
    expect(clerk.deleteOrganization).not.toHaveBeenCalled();
  });

  it("creates a team with its first admin; a bad name or admin never reaches Clerk", async () => {
    expect((await createTeamAction(" ", "user_a")).ok).toBe(false);
    expect((await createTeamAction("Kancelář", "org_x")).ok).toBe(false);
    expect(clerk.createOrganization).not.toHaveBeenCalled();
    clerk.createOrganization.mockResolvedValue({ id: "org_t" });
    const made = await createTeamAction("  Kancelář ", "user_a");
    expect(clerk.createOrganization).toHaveBeenCalledWith({ name: "Kancelář", createdBy: "user_a", maxAllowedMemberships: 20 });
    expect(made).toMatchObject({ ok: true, team: { id: "org_t", members: [{ userId: "user_a", role: "admin" }, { userId: "user_b", role: "member" }] } });
  });

  it("a switch becomes the organization's public metadata, rebuilt from checked fields only", async () => {
    await changeTeamAction("org_t", { kind: "feature", feature: "ukaz", on: true, extra: "x" } as never);
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledWith("org_t", { publicMetadata: { features: { ukaz: true } } });
    expect((await changeTeamAction("org_t", { kind: "role", admin: true } as never)).ok).toBe(false);
    expect((await changeTeamAction("user_a", { kind: "pro", on: true })).ok).toBe(false);
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledTimes(1);
  });

  it("members: add, change the role, remove — but the last admin stays", async () => {
    await setTeamMemberAction("org_t", "user_c", "member");
    expect(clerk.createOrganizationMembership).toHaveBeenCalledWith({ organizationId: "org_t", userId: "user_c", role: "org:member" });
    await setTeamMemberAction("org_t", "user_b", "admin");
    expect(clerk.updateOrganizationMembership).toHaveBeenCalledWith({ organizationId: "org_t", userId: "user_b", role: "org:admin" });
    await setTeamMemberAction("org_t", "user_b", null);
    expect(clerk.deleteOrganizationMembership).toHaveBeenCalledWith({ organizationId: "org_t", userId: "user_b" });
    for (const role of ["member", null] as const) {
      const refused = await setTeamMemberAction("org_t", "user_a", role);
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("aspoň jednoho správce") });
    }
    expect(clerk.deleteOrganizationMembership).toHaveBeenCalledTimes(1);
    expect(clerk.updateOrganizationMembership).toHaveBeenCalledTimes(1);
  });

  it("the list says when the Clerk instance has no organizations, and when Clerk is down", async () => {
    clerk.getOrganizationList.mockResolvedValueOnce({ data: [{ id: "org_t", name: "Kancelář" }] });
    expect(await listAdminTeams()).toMatchObject({ state: "ok", teams: [{ id: "org_t", members: [{ userId: "user_a" }, { userId: "user_b" }] }] });
    clerk.getOrganizationList.mockRejectedValueOnce(clerkError(403));
    expect(await listAdminTeams()).toEqual({ state: "disabled" });
    clerk.getOrganizationList.mockRejectedValueOnce(clerkError(500));
    expect(await listAdminTeams()).toEqual({ state: "failed" });
  });
});
