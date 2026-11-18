import { describe, expect, it } from "vitest";
import { cleanTeamChange, cleanTeamName, membersLabel, teamMetadataPatch, toAdminTeam, validTeamQuota } from "@/src/admin/teams-model";

/** The Týmy tab's pure model (src/admin/teams-model.ts): validation and the mapping from Clerk. */

describe("cleanTeamName", () => {
  it("accepts plain names, collapses whitespace, refuses the rest", () => {
    expect(cleanTeamName("  Spory   a  arbitráže ")).toBe("Spory a arbitráže");
    expect(cleanTeamName("Tým 2 (Praha)")).toBe("Tým 2 (Praha)");
    for (const bad of ["", "A", "x".repeat(61), "<b>Tým</b>", "Tým\u0000", 42, null, "-Tým"]) expect(cleanTeamName(bad)).toBeNull();
  });
});

describe("cleanTeamChange", () => {
  it("rebuilds valid changes from their checked fields only", () => {
    expect(cleanTeamChange({ kind: "create", name: " Spory ", extra: 1 })).toEqual({ kind: "create", name: "Spory" });
    expect(cleanTeamChange({ kind: "active", on: false, pro: true })).toEqual({ kind: "active", on: false });
    expect(cleanTeamChange({ kind: "quota", pages: null })).toEqual({ kind: "quota", pages: null });
    expect(cleanTeamChange({ kind: "quota", pages: 500 })).toEqual({ kind: "quota", pages: 500 });
    expect(cleanTeamChange({ kind: "addMember", userId: "user_a1", role: "org:admin" })).toEqual({ kind: "addMember", userId: "user_a1", role: "org:admin" });
    expect(cleanTeamChange({ kind: "setRole", userId: "user_a1", role: "org:member" })).toEqual({ kind: "setRole", userId: "user_a1", role: "org:member" });
    expect(cleanTeamChange({ kind: "removeMember", userId: "user_a1" })).toEqual({ kind: "removeMember", userId: "user_a1" });
    expect(cleanTeamChange({ kind: "delete", force: true })).toEqual({ kind: "delete" });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "delete",
      { kind: "nuke" },
      { kind: "rename", name: "" },
      { kind: "active", on: "yes" },
      { kind: "quota", pages: 0 },
      { kind: "quota", pages: 1.5 },
      { kind: "quota", pages: 5_000_001 },
      { kind: "addMember", userId: "org_x", role: "org:member" },
      { kind: "addMember", userId: "user_a", role: "owner" },
      { kind: "setRole", userId: "user_a;--", role: "org:admin" },
      { kind: "removeMember" },
    ]) {
      expect(cleanTeamChange(bad)).toBeNull();
    }
    expect(validTeamQuota(1)).toBe(true);
    expect(validTeamQuota(NaN)).toBe(false);
  });
});

describe("toAdminTeam", () => {
  it("maps the organization, keeps valid members once, reads active and quota strictly", () => {
    const team = toAdminTeam(
      { id: "org_t", name: "Spory", slug: "spory", createdAt: 1, publicMetadata: { pro: true, filesQuota: { pages: 1234.9 } } },
      [
        { role: "org:admin", createdAt: 2, publicUserData: { userId: "user_a" } },
        { role: "org:member", publicUserData: { userId: "user_b" } },
        { role: "org:member", publicUserData: { userId: "user_b" } },
        { role: "org:weird", publicUserData: { userId: "user_c" } },
        { role: "org:member", publicUserData: null },
        { role: "org:member", publicUserData: { userId: "bad id" } },
      ],
      { documents: 3, pages: 40, purgeAfter: null },
    );
    expect(team).toEqual({
      id: "org_t",
      name: "Spory",
      slug: "spory",
      createdAt: 1,
      active: true,
      quotaPages: 1234,
      members: [
        { userId: "user_a", role: "org:admin", joinedAt: 2 },
        { userId: "user_b", role: "org:member", joinedAt: null },
        { userId: "user_c", role: "org:member", joinedAt: null },
      ],
      library: { documents: 3, pages: 40, purgeAfter: null },
    });
    for (const meta of [{ pro: "true" }, {}, null]) expect(toAdminTeam({ id: "org_t", publicMetadata: meta }, [], null).active).toBe(false);
    expect(toAdminTeam({ id: "org_t", name: " ", slug: "s" }, [], null).name).toBe("s");
  });

  it("metadata patches and labels", () => {
    expect(teamMetadataPatch({ kind: "active", on: true })).toEqual({ pro: true });
    expect(teamMetadataPatch({ kind: "quota", pages: null })).toEqual({ filesQuota: null });
    expect(teamMetadataPatch({ kind: "quota", pages: 9 })).toEqual({ filesQuota: { pages: 9 } });
    expect([1, 2, 4, 5, 0].map(membersLabel)).toEqual(["1 člen", "2 členové", "4 členové", "5 členů", "0 členů"]);
  });
});
